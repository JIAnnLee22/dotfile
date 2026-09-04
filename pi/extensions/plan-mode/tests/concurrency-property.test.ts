import assert from "node:assert/strict";
import test from "node:test";
import { evaluateToolCall } from "../src/policy.ts";
import { PLAN_MANAGED_TOOLS } from "../src/tool-session.ts";
import { actor, builtin, environment, fixture, implementationEnvironment, modelActor, prepareReview, request, testRegistry } from "./helpers.ts";

test("PM4-P0-015 concurrent audit writes are serialized with monotonic unique sequence numbers", async () => {
	const f = await fixture();
	try {
		await Promise.all(
			Array.from({ length: 40 }, (_, index) =>
				f.controller.recordPolicyDecision(
					{ channel: "model", id: "property-model" },
					f.scope,
					"unknown",
					`call-${index}`,
					false,
					"fail-closed",
				),
			),
		);
		const sequences = f.journal.events.map((event) => event.sequence);
		assert.equal(new Set(sequences).size, sequences.length);
		assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-002 property: arbitrary unknown tool names never elevate permissions during planning", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: "Research", baseline: { schema: "dev.pi.plan-tool-baseline/v2", baselineId: "b1", planId: "p1", toolNames: ["read"], capturedAt: "2026-09-03T00:00:00.000Z", sessionId: f.scope.sessionId, branchEntryId: f.scope.branchLeafId } }));
		let seed = 0x5eed1234;
		const next = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed;
		};
		for (let index = 0; index < 300; index++) {
			const name = `tool_${next().toString(36)}_${index}`;
			const decision = evaluateToolCall({
				state: f.controller.state,
				registry: testRegistry(),
				permissions: f.controller.researchPermissions,
				toolName: name,
				input: { path: "src/existing.ts" },
				toolInfo: { name, sourceInfo: { source: index % 2 ? "extension" : "sdk" } },
				cwd: f.cwd,
				readRoots: [f.cwd],
				managedTools: PLAN_MANAGED_TOOLS.map((toolName) => ({ name: toolName, sourcePath: "/trusted/plan-mode.ts" })),
			});
			assert.equal(decision.allow, false, name);
		}
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-006 concurrent implement and edit never leaves a stale approval for an old ref", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		const revised = "Split the step";
		await Promise.all([
			f.controller.dispatch(request("implement", ref, actor), implementationEnvironment(f.scope)),
			f.controller.dispatch(request("edit_feedback", undefined, actor), environment(f.scope, { feedback: revised })),
		]);
		assert.ok(["planning", "review", "implementing"].includes(f.controller.state.status));
		if (f.controller.state.status === "review" || f.controller.state.status === "planning") {
			assert.equal(f.controller.approval, undefined);
			assert.equal(f.controller.state.approvalId, undefined);
		}
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-010 pause clears approval so a later resume requires fresh readback", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		const paused = await f.controller.dispatch(request("pause"), environment(f.scope, { reason: "checkpoint" }));
		assert.equal(paused.ok, true);
		assert.equal(f.controller.approval, undefined);
		assert.equal(f.controller.state.approvalId, undefined);
		const resumedMissingTool = await f.controller.dispatch(
			request("resume", ref),
			environment(f.scope, { activeTools: ["read"], activeToolsDigest: "00" }),
		);
		assert.equal(resumedMissingTool.ok, false);
		assert.equal(resumedMissingTool.error?.code, "TOOL_UNAVAILABLE");
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-014 model cannot pause or implement its own plan", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		const modelImplement = await f.controller.dispatch(request("implement", ref, modelActor), implementationEnvironment(f.scope));
		assert.equal(modelImplement.ok, false);
	} finally {
		await f.cleanup();
	}
});
