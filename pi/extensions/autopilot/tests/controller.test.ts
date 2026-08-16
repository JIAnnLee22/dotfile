import * as assert from "node:assert/strict";
import { test } from "node:test";
import { AutopilotControllerError } from "../src/controller.ts";
import { AutopilotController } from "../src/controller.ts";
import { actor, clockFactory, entry, environment, fixture, idFactory, MemoryJournal, modelActor, request, startAndSubmit, systemActor } from "./helpers.ts";

test("start moves inactive to drafting and requires a goal", async () => {
	const fx = await fixture();
	try {
		assert.equal(fx.controller.state.status, "inactive");
		const empty = await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: "  " }));
		assert.equal(empty.ok, false);
		assert.equal(empty.error?.code, "INVALID_MISSION");
		const started = await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: "Fix the build" }));
		assert.equal(started.ok, true);
		assert.equal(started.state.status, "drafting");
		assert.equal(started.state.missionId, "00000000-0000-4000-8000-000000000001");
		const again = await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: "Again" }));
		assert.equal(again.ok, false);
		assert.equal(again.error?.code, "INVALID_STATE");
	} finally {
		await fx.cleanup();
	}
});

test("submit commits an immutable versioned MissionSpec and enters dryrun", async () => {
	const fx = await fixture();
	try {
		await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: fx.draft.goal }));
		const submitted = await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: fx.draft }));
		assert.equal(submitted.ok, true);
		assert.equal(submitted.state.status, "dryrun");
		assert.equal(submitted.missionRef?.version, 1);
		assert.equal(submitted.state.acResults["AC1"]?.status, "pending");
		const spec = fx.controller.spec;
		assert.ok(spec);
		assert.equal(spec.acceptance.length, 2);
		// Re-submitting the same draft produces a new immutable version.
		const resubmitted = await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: fx.draft }));
		assert.equal(resubmitted.ok, true);
		assert.equal(resubmitted.missionRef?.version, 2);
		const loaded = await fx.store.loadVersion(resubmitted.missionRef!.missionId, 1);
		assert.equal(loaded.contentHash, submitted.missionRef!.contentHash);
	} finally {
		await fx.cleanup();
	}
});

test("submit rejects malformed drafts (duplicate ids, empty verify)", async () => {
	const fx = await fixture();
	try {
		await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: fx.draft.goal }));
		const bad = {
			...fx.draft,
			acceptance: [
				{ id: "AC1", title: "same", verify: "echo ok" },
				{ id: "AC1", title: "duplicate", verify: "echo ok" },
			],
		};
		const result = await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: bad }));
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "INVALID_MISSION");
		const noVerify = { ...fx.draft, acceptance: [{ id: "AC1", title: "no check", verify: "  " }] };
		const result2 = await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: noVerify }));
		assert.equal(result2.ok, false);
	} finally {
		await fx.cleanup();
	}
});

test("dryrun report claims need successful bash evidence in the current window", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		// No evidence yet: ready claim must fail closed.
		const premature = await fx.controller.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "not_ready")] }),
		);
		assert.equal(premature.ok, false);
		assert.equal(premature.error?.code, "EVIDENCE_REQUIRED");
		// A failed bash result does not count as evidence.
		await fx.controller.recordToolResult(modelActor, fx.scope, {
			toolName: "bash",
			toolCallId: "t1",
			success: false,
			summary: "bash failed; result body redacted",
		});
		const stillPremature = await fx.controller.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "not_ready")] }),
		);
		assert.equal(stillPremature.ok, false);
		assert.equal(stillPremature.error?.code, "EVIDENCE_REQUIRED");
		// Now a successful bash run satisfies the window.
		await fx.controller.recordToolResult(modelActor, fx.scope, {
			toolName: "bash",
			toolCallId: "t2",
			success: true,
			summary: "bash succeeded; result body redacted",
		});
		const partial = await fx.controller.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "not_ready")] }),
		);
		assert.equal(partial.ok, true);
		assert.equal(partial.state.status, "dryrun");
		assert.equal(partial.state.acResults["AC1"]?.status, "ready");
		assert.equal(partial.state.acResults["AC2"]?.status, "not_ready");
	} finally {
		await fx.cleanup();
	}
});

test("old evidence does not count for a new report window", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		// First report passes the window (evidence since stage start).
		const first = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "not_ready")] }));
		assert.equal(first.ok, true);
		// Without new evidence the next ready claim must fail.
		const second = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "not_ready")] }));
		assert.equal(second.ok, false);
		assert.equal(second.error?.code, "EVIDENCE_REQUIRED");
	} finally {
		await fx.cleanup();
	}
});

test("all criteria ready transitions dryrun to running", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		const report = await fx.controller.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "ready")] }),
		);
		assert.equal(report.ok, true);
		assert.equal(report.state.status, "running");
		assert.equal(fx.controller.state.acResults["AC1"]?.status, "ready");
	} finally {
		await fx.cleanup();
	}
});

test("running report loop: partial pass keeps running, full pass completes", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "ready")] }));
		// Running: pass claims need fresh evidence.
		const stale = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "pass")] }));
		assert.equal(stale.ok, false);
		assert.equal(stale.error?.code, "EVIDENCE_REQUIRED");
		// New evidence, then a partial report (AC2 fail) stays in running.
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t2", success: true, summary: "tests run" });
		const partial = await fx.controller.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "fail", "AC2 still red")] }),
		);
		assert.equal(partial.ok, true);
		assert.equal(partial.state.status, "running");
		assert.equal(partial.state.acResults["AC1"]?.status, "pass");
		assert.equal(partial.state.acResults["AC2"]?.status, "fail");
		// Another verification round then full pass completes.
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t3", success: true, summary: "tests green" });
		const done = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "pass")] }));
		assert.equal(done.ok, true);
		assert.equal(done.state.status, "completed");
		assert.equal(fx.controller.spec !== undefined, true);
	} finally {
		await fx.cleanup();
	}
});

test("optional (required=false) criteria do not block completion", async () => {
	const fx = await fixture();
	try {
		const withOptional = {
			...fx.draft,
			acceptance: [
				{ id: "AC1", title: "required one", verify: "echo ok" },
				{ id: "AC2", title: "optional one", verify: "echo ok", required: false },
			],
		};
		await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: fx.draft.goal }));
		await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: withOptional }));
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "not_ready")] }));
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t2", success: true, summary: "ok" });
		const done = await fx.controller.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "fail", "optional, skipped")] }),
		);
		assert.equal(done.ok, true);
		assert.equal(done.state.status, "completed");
	} finally {
		await fx.cleanup();
	}
});

test("report rejects unknown criteria ids and wrong statuses", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		const unknown = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC99", "ready")] }));
		assert.equal(unknown.ok, false);
		assert.equal(unknown.error?.code, "INVALID_MISSION");
		// 'pass' is not valid during dryrun.
		const wrongStatus = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "pass")] }));
		assert.equal(wrongStatus.ok, false);
		assert.equal(wrongStatus.error?.code, "INVALID_ACTION");
	} finally {
		await fx.cleanup();
	}
});

test("pause/resume/cancel/reset transitions", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "ready")] }));
		const paused = await fx.controller.dispatch(request("pause"), environment(fx.scope, { reason: "user asked" }));
		assert.equal(paused.ok, true);
		assert.equal(paused.state.status, "paused");
		assert.equal(paused.state.pausedFromStage, "running");
		// Drafting cannot pause.
		const resumed = await fx.controller.dispatch(request("resume"), environment(fx.scope));
		assert.equal(resumed.ok, true);
		assert.equal(resumed.state.status, "running");
		// Pausing in dryrun records dryrun stage.
		await fx.controller.dispatch(request("cancel"), environment(fx.scope, { reason: "goal changed" }));
		assert.equal(fx.controller.state.status, "cancelled");
		// Terminal states cannot cancel again.
		const cancelledAgain = await fx.controller.dispatch(request("cancel"), environment(fx.scope));
		assert.equal(cancelledAgain.ok, false);
		const reset = await fx.controller.dispatch(request("reset"), environment(fx.scope));
		assert.equal(reset.ok, true);
		assert.equal(reset.state.status, "inactive");
		// Audit trail records the whole journey.
		const actions = fx.journal.events.map((event) => event.action);
		assert.ok(actions.includes("state-committed"));
		assert.ok(actions.some((action) => action === "report-submitted"));
		assert.equal(fx.controller.events.length, fx.journal.events.length);
	} finally {
		await fx.cleanup();
	}
});

test("journal failure fails closed with STORAGE_ERROR", async () => {
	const fx = await fixture();
	try {
		fx.journal.fail = true;
		const result = await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: "x" }));
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "STORAGE_ERROR");
	} finally {
		await fx.cleanup();
	}
});

test("recover rebuilds state and evidence projection", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "ready")] }));
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t2", success: true, summary: "test run" });
		await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "fail", "red")] }));

		// Recover into a fresh controller that shares the same artifact store (same project cwd).
		const recoveredJournal = new MemoryJournal();
		const recovered = new AutopilotController({
			store: fx.store,
			journal: recoveredJournal,
			now: clockFactory(),
			id: idFactory(),
		});
		await recovered.recover(fx.journal.entries(), "resume", fx.scope, {
			policyDigest: "policy-digest",
			contextDigest: "context-digest",
		});
		assert.equal(recovered.state.status, "paused");
		assert.equal(recovered.state.pausedFromStage, "running");
		assert.equal(recovered.state.acResults["AC1"]?.status, "pass");
		assert.equal(recovered.state.acResults["AC2"]?.status, "fail");
		assert.equal(recovered.state.missionRef?.version, 1);
		// Spec reloaded from the artifact store.
		assert.equal(recovered.spec?.acceptance.length, 2);
		// The resumed controller must re-earn evidence before reporting again: resume first, then report
		// with no fresh evidence fails closed.
		const resumed = await recovered.dispatch(request("resume"), environment(fx.scope));
		assert.equal(resumed.ok, true);
		assert.equal(resumed.state.status, "running");
		const report = await recovered.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "pass")] }),
		);
		assert.equal(report.ok, false);
		assert.equal(report.error?.code, "EVIDENCE_REQUIRED");
	} finally {
		await fx.cleanup();
	}
});

test("corrupt audit journal fails closed to failed", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		const entries = fx.journal.entries();
		// Tamper: duplicate the last event with different content.
		const last = entries.at(-1)!.data;
		entries.push({ type: "custom", customType: "autopilot/audit", data: { ...last, reason: "tampered" } });
		const fresh = await fixture();
		try {
			await fresh.controller.recover(entries, "resume", fresh.scope);
			assert.equal(fresh.controller.state.status, "failed");
			assert.match(fresh.controller.state.reason ?? "", /failed closed/);
		} finally {
			await fresh.cleanup();
		}
	} finally {
		await fx.cleanup();
	}
});

test("missing spec artifact fails closed to failed", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		const entries = fx.journal.entries();
		const fresh = await fixture();
		try {
			// Store root differs: the spec file will not be found.
			await fresh.controller.recover(entries, "resume", fresh.scope);
			assert.equal(fresh.controller.state.status, "failed");
			assert.match(fresh.controller.state.reason ?? "", /MissionSpec recovery failed/);
		} finally {
			await fresh.cleanup();
		}
	} finally {
		await fx.cleanup();
	}
});

test("concurrent dispatches serialize through the mutex", async () => {
	const fx = await fixture();
	try {
		await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: fx.draft.goal }));
		await Promise.all([
			fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: fx.draft })),
			fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: { ...fx.draft, goal: "other" } })),
		]);
		// Both submits executed serially; the second is the current version.
		const current = fx.controller.state;
		assert.equal(current.status, "dryrun");
		assert.equal(current.missionRef?.version, 2);
	} finally {
		await fx.cleanup();
	}
});

test("errors carry stable codes", async () => {
	const fx = await fixture();
	try {
		const bogus = await fx.controller.dispatch(
			{ ...request("submit"), action: "nope" as never },
			environment(fx.scope, { draft: fx.draft }),
		);
		assert.equal(bogus.ok, false);
		assert.equal(bogus.error?.code, "INVALID_ACTION");
	} finally {
		await fx.cleanup();
	}
});
