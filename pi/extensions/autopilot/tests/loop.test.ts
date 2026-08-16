import * as assert from "node:assert/strict";
import { test } from "node:test";
import { entry, environment, fixture, modelActor, request, startAndSubmit } from "./helpers.ts";

/**
 * Acceptance-loop semantics: the full journey from trigger to completion,
 * including the dry-run gate, the verify-fix-reverify loop, the evidence
 * window between reports, and the failure/stagnation paths.
 */

test("full journey: trigger -> draft -> dryrun -> running -> completed", async () => {
	const fx = await fixture();
	try {
		// Drafting
		const started = await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: "Make value 42" }));
		assert.equal(started.state.status, "drafting");

		// Submit enters dryrun (no confirmation anywhere in the flow)
		const submitted = await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: fx.draft }));
		assert.equal(submitted.state.status, "dryrun");

		// Dry-run: verify AC1 command runs; AC2 check is not executable yet.
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		const dryrunPartial = await fx.controller.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "not_ready", "verify command needs a runtime")] }),
		);
		assert.equal(dryrunPartial.state.status, "dryrun");
		assert.equal(dryrunPartial.state.acResults["AC2"]?.status, "not_ready");

		// Fix the criterion (re-submit creates version 2) and re-verify everything.
		const fixed = {
			...fx.draft,
			acceptance: [
				{ id: "AC1", title: "exports value", verify: "grep -q 'export const value' src/existing.ts" },
				{ id: "AC2", title: "value is 42", verify: "node -e \"const m = require('./src/existing.ts'); if (m.value !== 42) process.exit(1)\"" },
			],
		};
		const resubmitted = await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: fixed }));
		assert.equal(resubmitted.state.missionRef?.version, 2);
		assert.equal(resubmitted.state.status, "dryrun");
		// Old evidence belongs to the previous version's dry-run window.
		const stale = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "ready")] }));
		assert.equal(stale.ok, false);
		assert.equal(stale.error?.code, "EVIDENCE_REQUIRED");
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t2", success: true, summary: "both checks run" });
		const dryrunAll = await fx.controller.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "ready")] }),
		);
		assert.equal(dryrunAll.state.status, "running");

		// Running: develop, verify, report partial failure, fix, verify, complete.
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t3", success: true, summary: "test run" });
		const partial = await fx.controller.dispatch(
			request("report"),
			environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "fail", "value is still 1")] }),
		);
		assert.equal(partial.state.status, "running");
		assert.equal(partial.state.acResults["AC2"]?.status, "fail");

		// A report without fresh tool evidence is rejected even after a failure.
		const fakePass = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "pass")] }));
		assert.equal(fakePass.ok, false);
		assert.equal(fakePass.error?.code, "EVIDENCE_REQUIRED");

		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "edit", toolCallId: "t4", success: true, summary: "edit applied" });
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t5", success: true, summary: "tests green" });
		const done = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "pass")] }));
		assert.equal(done.ok, true);
		assert.equal(done.state.status, "completed");
		assert.equal(done.state.acResults["AC1"]?.evidenceCount, 2); // evidence in the last window

		// Completed is terminal: no further reports or mutations.
		const after = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "pass")] }));
		assert.equal(after.ok, false);
		assert.equal(after.error?.code, "INVALID_STATE");

		// Reset returns to inactive.
		const reset = await fx.controller.dispatch(request("reset"), environment(fx.scope));
		assert.equal(reset.state.status, "inactive");
	} finally {
		await fx.cleanup();
	}
});

test("not_ready criteria keep the mission in dryrun forever until fixed", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		for (let round = 0; round < 3; round++) {
			const report = await fx.controller.dispatch(
				request("report"),
				environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "not_ready", "unresolvable")] }),
			);
			assert.equal(report.state.status, "dryrun");
			// Next round needs fresh evidence.
			if (round < 2) {
				await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: `t${round + 2}`, success: true, summary: "recheck" });
			}
		}
		// The last report above had no fresh evidence -> rejected, still dryrun.
		assert.equal(fx.controller.state.status, "dryrun");
	} finally {
		await fx.cleanup();
	}
});

test("pause during running blocks writes at the policy level through state", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "ready")] }));
		const paused = await fx.controller.dispatch(request("pause"), environment(fx.scope, { reason: "user intervention" }));
		assert.equal(paused.state.status, "paused");
		// Resume returns to running with a reset evidence window.
		const resumed = await fx.controller.dispatch(request("resume"), environment(fx.scope));
		assert.equal(resumed.state.status, "running");
		const noEvidence = await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "pass"), entry("AC2", "pass")] }));
		assert.equal(noEvidence.ok, false);
		assert.equal(noEvidence.error?.code, "EVIDENCE_REQUIRED");
	} finally {
		await fx.cleanup();
	}
});

test("audit trail records policy decisions, evidence and reports", async () => {
	const fx = await fixture();
	try {
		await startAndSubmit(fx);
		await fx.controller.recordPolicyDecision(modelActor, fx.scope, "bash", "c1", true, "allowed");
		await fx.controller.recordPolicyDecision(modelActor, fx.scope, "edit", "c2", false, "denied while dryrun");
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "c1", success: true, summary: "ok" });
		const events = fx.journal.events;
		const policyEvents = events.filter((event) => event.action === "tool-policy-decision");
		assert.equal(policyEvents.length, 2);
		assert.equal(policyEvents[0].decision, "allow");
		assert.equal(policyEvents[1].decision, "deny");
		assert.ok(events.some((event) => event.action === "evidence-recorded" && event.decision === "allow"));
		// Every event carries the schema and a monotonic sequence.
		for (let index = 0; index < events.length; index++) {
			assert.equal(events[index].schema, "dev.pi.autopilot-audit/v1");
			assert.equal(events[index].sequence, index + 1);
		}
	} finally {
		await fx.cleanup();
	}
});
