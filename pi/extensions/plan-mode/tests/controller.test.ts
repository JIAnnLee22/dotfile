import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import type { PlanDraft } from "../src/domain.ts";
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

const parallelDraft: PlanDraft = {
	goal: "Parallel plan",
	decisions: [],
	steps: [
		{ title: "A", actions: ["a"], files: [], validation: [], dependsOn: [] },
		{ title: "B", actions: ["b"], files: [], validation: [], dependsOn: [] },
		{ title: "C", actions: ["c"], files: [], validation: [], dependsOn: ["S1", "S2"] },
	],
	risks: [],
};

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

test("PM4-P1-002 parallel steps activate all ready steps and advance per dependency", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope, parallelDraft);
		const running = await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		assert.equal(running.ok, true);
		assert.deepEqual(running.state.activeStepIds, ["S1", "S2"]);
		assert.equal(running.state.steps.S1.status, "running");
		assert.equal(running.state.steps.S2.status, "running");
		assert.equal(running.state.steps.S3.status, "pending");

		const done1 = await f.controller.dispatch(
			request("complete_step", undefined, modelActor),
			environment(f.scope, { stepId: "S1", note: "A done" }),
		);
		assert.equal(done1.ok, true);
		assert.equal(done1.state.status, "implementing");
		assert.equal(done1.state.steps.S1.status, "completed");
		assert.deepEqual(done1.state.activeStepIds, ["S2"]);
		assert.equal(done1.state.steps.S3.status, "pending");

		const done2 = await f.controller.dispatch(
			request("complete_step", undefined, modelActor),
			environment(f.scope, { stepId: "S2", note: "B done" }),
		);
		assert.equal(done2.ok, true);
		assert.deepEqual(done2.state.activeStepIds, ["S3"]);
		assert.equal(done2.state.steps.S3.status, "running");

		const done3 = await f.controller.dispatch(
			request("complete_step", undefined, modelActor),
			environment(f.scope, { stepId: "S3", note: "C done" }),
		);
		assert.equal(done3.ok, true);
		assert.equal(done3.state.status, "completed");
		assert.deepEqual(done3.state.activeStepIds, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P1-002 completing a non-running step is rejected", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope, parallelDraft);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		const bad = await f.controller.dispatch(
			request("complete_step", undefined, modelActor),
			environment(f.scope, { stepId: "S3", note: "not ready" }),
		);
		assert.equal(bad.error?.code, "INVALID_ACTION");
	} finally {
		await f.cleanup();
	}
});
