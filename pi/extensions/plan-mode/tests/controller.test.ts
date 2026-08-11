import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { actor, draft, environment, fixture, modelActor, request } from "./helpers.ts";

test("PM-P0-005 PM-P0-006 PM-P0-007 PM-P0-008 full flow keeps spec, approval, grant and execution state separate", async () => {
	const f = await fixture();
	try {
		assert.equal((await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }))).ok, true);
		assert.equal((await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }))).ok, true);
		assert.equal(f.controller.state.status, "review");
		const ref = f.controller.state.planRef!;
		const spec = f.controller.spec!;
		assert.equal("approval" in spec, false);
		assert.equal("status" in spec, false);
		assert.equal("evidence" in spec.steps[0], false);

		const paths = f.store.paths(ref);
		const onDisk = JSON.parse(await fs.readFile(paths.spec, "utf8"));
		assert.equal(onDisk.contentHash, ref.contentHash);
		assert.match(await fs.readFile(paths.review, "utf8"), /spec\.json.*authoritative/);

		assert.equal((await f.controller.dispatch(request("approve", ref), environment(f.scope))).ok, true);
		assert.equal(f.controller.state.status, "approved");
		assert.ok(f.controller.approval);
		assert.equal(f.controller.grant, undefined);

		assert.equal((await f.controller.dispatch(request("execute", ref), environment(f.scope))).ok, true);
		assert.equal(f.controller.state.status, "executing");
		assert.ok(f.controller.grant);
		assert.equal(f.controller.grant?.planRef.contentHash, ref.contentHash);

		await f.controller.recordToolResult({ channel: "system", id: "tool" }, f.scope, {
			toolName: "edit",
			toolCallId: "call-1",
			success: true,
			summary: "edit succeeded; body redacted",
		});
		assert.equal(f.controller.state.steps.S1.status, "running", "tool success alone must not verify a step");
		assert.equal(f.controller.state.steps.S1.evidenceIds.length, 1);

		assert.equal(
			(await f.controller.dispatch(request("verify", ref), environment(f.scope, { stepId: "S1", note: "Reviewed diff manually" }))).ok,
			true,
		);
		assert.equal(f.controller.state.status, "completed");
		assert.equal(f.controller.grant, undefined);
		assert.equal((await f.controller.dispatch(request("reset"), environment(f.scope))).ok, true);
		assert.equal(f.controller.state.status, "inactive");
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-004 clarification becomes structured awaiting_input and never stores the answer body", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		const pending = await f.controller.dispatch(
			request("request_input", undefined, modelActor),
			environment(f.scope, { question: "Choose the compatibility target", choices: ["Node 22", "Node 24"] }),
		);
		assert.equal(pending.ok, true);
		assert.equal(pending.state.status, "awaiting_input");
		assert.equal(pending.pendingInput?.kind, "select");
		assert.deepEqual(pending.pendingInput?.choices, ["Node 22", "Node 24"]);
		const premature = await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		assert.equal(premature.ok, false);
		assert.equal(premature.state.status, "awaiting_input");
		const answerText = "Node 24 token=do-not-store";
		const answered = await f.controller.dispatch(request("answer"), environment(f.scope, { note: answerText }));
		assert.equal(answered.ok, true);
		assert.equal(answered.state.status, "researching");
		assert.equal(answered.pendingInput, undefined);
		assert.equal(JSON.stringify(f.journal.events).includes(answerText), false);
		assert.equal(f.journal.events.some((event) => event.action === "clarification-answered" && event.digest), true);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-006 editing creates a new version and invalidates old approval/hash", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const oldRef = f.controller.state.planRef!;
		await f.controller.dispatch(request("approve", oldRef), environment(f.scope));
		const revised = { ...draft, goal: "Change the value with an additional review" };
		const editResult = await f.controller.dispatch(request("edit", oldRef, actor), environment(f.scope, { draft: revised }));
		assert.equal(editResult.ok, true);
		assert.equal(f.controller.state.status, "review");
		assert.equal(f.controller.state.planRef?.version, oldRef.version + 1);
		assert.notEqual(f.controller.state.planRef?.contentHash, oldRef.contentHash);
		assert.equal(f.controller.state.approvalId, undefined);
		const replay = await f.controller.dispatch(request("execute", oldRef), environment(f.scope));
		assert.equal(replay.ok, false);
		assert.equal(replay.error?.code, "INVALID_STATE");
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-006 model cannot approve or verify its own plan", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const ref = f.controller.state.planRef!;
		const approval = await f.controller.dispatch(request("approve", ref, modelActor), environment(f.scope));
		assert.equal(approval.ok, false);
		assert.equal(approval.error?.code, "APPROVAL_REQUIRED");
		assert.equal(f.controller.state.status, "review");
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-012 audit persistence failure fails closed without committing state", async () => {
	const f = await fixture();
	try {
		f.journal.fail = true;
		const result = await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "STORAGE_ERROR");
		assert.equal(f.controller.state.status, "inactive");
		assert.equal(f.journal.events.length, 0);
	} finally {
		await f.cleanup();
	}
});
