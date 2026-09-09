import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { activeToolsDigest } from "../src/tool-session.ts";
import {
	actor,
	baseline,
	draft,
	environment,
	fixture,
	implementationEnvironment,
	modelActor,
	prepareReview,
	request,
	start,
	submit,
} from "./helpers.ts";

test("PM4-P0-001 baseline is audited before planning state", async () => {
	const f = await fixture();
	try {
		const result = await start(f.controller, f.scope);
		assert.equal(result.ok, true);
		assert.equal(result.state.status, "planning");
		assert.equal(result.state.baselineId, baseline(f.scope).baselineId);
		assert.deepEqual(f.journal.events.slice(0, 2).map((event) => event.action), ["tool-baseline-captured", "state-committed"]);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-004 submit writes immutable concise PlanSpec v2", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		const result = await submit(f.controller, f.scope);
		assert.equal(result.ok, true);
		assert.equal(result.state.status, "review");
		const spec = f.controller.spec!;
		assert.equal(spec.schema, "dev.pi.plan/v2");
		assert.deepEqual(spec.steps.map((step) => step.id), ["S1", "S2"]);
		assert.equal("pathScopes" in spec.steps[0], false);
		assert.equal("requiredCapabilities" in spec.steps[0], false);
		assert.equal("workspaceSnapshot" in spec, false);
		const onDisk = JSON.parse(await fs.readFile(f.store.paths(result.planRef!).spec, "utf8"));
		assert.equal(onDisk.contentHash, result.planRef?.contentHash);
		assert.match(await fs.readFile(f.store.paths(result.planRef!).review, "utf8"), /normal Pi permissions/);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-006 implementation requires exact ref and verified active tool readback", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		const missingRef = await f.controller.dispatch(request("implement"), implementationEnvironment(f.scope));
		assert.equal(missingRef.error?.code, "PLAN_REF_MISMATCH");
		const missingTool = await f.controller.dispatch(
			request("implement", ref),
			environment(f.scope, {
				activeTools: ["read", "edit", "write"],
				activeToolsDigest: activeToolsDigest(["read", "edit", "write"]),
			}),
		);
		assert.equal(missingTool.error?.code, "TOOL_UNAVAILABLE");
		assert.equal(f.controller.state.status, "review");
		assert.equal(f.controller.approval, undefined);
		const running = await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		assert.equal(running.ok, true);
		assert.equal(running.state.status, "implementing");
		assert.ok(running.approvalRef);
		const actions = f.journal.events.map((event) => event.action);
		assert.ok(actions.lastIndexOf("approval-created") < actions.lastIndexOf("state-committed"));
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-006 model cannot approve its own implementation", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		const result = await f.controller.dispatch(request("implement", ref, modelActor), implementationEnvironment(f.scope));
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "APPROVAL_REQUIRED");
		assert.equal(result.state.status, "review");
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-008 step reports advance without capability evidence", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		const first = await f.controller.dispatch(
			request("complete_step", undefined, modelActor),
			environment(f.scope, { note: "Updated the value" }),
		);
		assert.equal(first.ok, true);
		assert.equal(first.state.status, "implementing");
		assert.equal(first.state.steps.S1.status, "completed");
		assert.equal(first.state.currentStepId, "S2");
		assert.equal(first.state.stepRevision, 1);
		const second = await f.controller.dispatch(
			request("complete_step", undefined, modelActor),
			environment(f.scope, { note: "Checks passed" }),
		);
		assert.equal(second.ok, true);
		assert.equal(second.state.status, "completed");
		assert.equal(second.state.stepRevision, 2);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-008 empty report is rejected but tool results remain informational", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		await f.controller.recordToolResult({ channel: "system", id: "tool" }, f.scope, {
			toolName: "edit",
			toolCallId: "call-edit",
			success: true,
			summary: "edit succeeded",
		});
		assert.equal(f.controller.state.stepRevision, 0);
		assert.equal(f.controller.state.steps.S1.evidenceIds.length, 1);
		const empty = await f.controller.dispatch(
			request("complete_step", undefined, modelActor),
			environment(f.scope, { note: "  " }),
		);
		assert.equal(empty.error?.code, "INVALID_ACTION");
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-010 block pauses and clears approval", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		const blocked = await f.controller.dispatch(
			request("block", undefined, modelActor),
			environment(f.scope, { reason: "Need a user decision" }),
		);
		assert.equal(blocked.ok, true);
		assert.equal(blocked.state.status, "paused");
		assert.equal(blocked.state.approvalId, undefined);
		assert.equal(f.controller.approval, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-005 edit feedback returns review to planning without storing body", async () => {
	const f = await fixture();
	try {
		await prepareReview(f.controller, f.scope);
		const feedback = "Split the step; token=do-not-store";
		const result = await f.controller.dispatch(request("edit_feedback"), environment(f.scope, { feedback }));
		assert.equal(result.ok, true);
		assert.equal(result.state.status, "planning");
		assert.equal(JSON.stringify(f.journal.events).includes(feedback), false);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-015 audit persistence failure fails closed", async () => {
	const f = await fixture();
	try {
		f.journal.fail = true;
		const result = await start(f.controller, f.scope);
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "STORAGE_ERROR");
		assert.equal(f.controller.state.status, "inactive");
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-010 terminal archive returns to inactive", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		await f.controller.dispatch(request("cancel"), environment(f.scope, { reason: "cancel" }));
		await f.controller.archive(actor, f.scope);
		assert.equal(f.controller.state.status, "inactive");
		assert.equal(f.controller.spec, undefined);
		assert.equal(f.controller.baseline, undefined);
	} finally {
		await f.cleanup();
	}
});
