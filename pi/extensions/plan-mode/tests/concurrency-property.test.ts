import assert from "node:assert/strict";
import test from "node:test";
import { evaluateToolCall } from "../src/policy.ts";
import { actor, draft, environment, fixture, modelActor, request } from "./helpers.ts";

test("PM-P0-014 concurrent audit writes are serialized with monotonic unique sequence numbers", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
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

test("PM-P0-006 concurrent approve/edit cannot make an old hash executable", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const oldRef = f.controller.state.planRef!;
		const revised = { ...draft, goal: "Revised concurrently" };
		await Promise.all([
			f.controller.dispatch(request("approve", oldRef, actor), environment(f.scope)),
			f.controller.dispatch(request("edit", oldRef, actor), environment(f.scope, { draft: revised })),
		]);
		assert.equal(f.controller.state.status, "review");
		assert.equal(f.controller.state.planRef?.version, oldRef.version + 1);
		assert.equal(f.controller.state.approvalId, undefined);
		const executeOld = await f.controller.dispatch(request("execute", oldRef, actor), environment(f.scope));
		assert.equal(executeOld.ok, false);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-002 property: arbitrary unknown tool names never elevate permissions", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		let seed = 0x5eed1234;
		const next = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed;
		};
		for (let index = 0; index < 500; index++) {
			const name = `tool_${next().toString(36)}_${index}`;
			const decision = evaluateToolCall({
				state: f.controller.state,
				toolName: name,
				input: { path: "src/existing.ts", malformed: next() },
				toolInfo: { name, sourceInfo: { source: index % 2 ? "extension" : "sdk" } },
				cwd: f.cwd,
			});
			assert.equal(decision.allow, false, name);
		}
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-009 pause increments epoch and invalidates a previously captured grant", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const ref = f.controller.state.planRef!;
		await f.controller.dispatch(request("approve", ref), environment(f.scope));
		await f.controller.dispatch(request("execute", ref), environment(f.scope));
		const oldGrant = f.controller.grant!;
		const oldEpoch = f.controller.state.epoch;
		await f.controller.dispatch(request("pause", ref), environment(f.scope, { reason: "test pause" }));
		assert.ok(f.controller.state.epoch > oldEpoch);
		assert.equal(f.controller.state.grantId, undefined);
		const decision = evaluateToolCall({
			state: f.controller.state,
			spec: f.controller.spec,
			grant: oldGrant,
			toolName: "edit",
			input: { path: "src/existing.ts" },
			toolInfo: { name: "edit", sourceInfo: { source: "builtin" } },
			cwd: f.cwd,
		});
		assert.equal(decision.allow, false);
	} finally {
		await f.cleanup();
	}
});
