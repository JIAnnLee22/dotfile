import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, SECURITY_LEVEL, type ExecutionState } from "../src/domain.ts";
import { ExecutionLoop } from "../src/execution-loop.ts";

function state(overrides: Partial<ExecutionState> = {}): ExecutionState {
	return {
		...createInitialState("2026-09-03T00:00:00.000Z"),
		status: "implementing",
		revision: 2,
		runRevision: 2,
		stepRevision: 0,
		planId: "p1",
		currentStepId: "S1",
		securityLevel: SECURITY_LEVEL,
		...overrides,
	};
}

test("PM4-P0-009 implementation start queues the first step", () => {
	const loop = new ExecutionLoop();
	const decision = loop.onImplementationStarted(state());
	assert.equal(decision.kind, "queue-step");
});

test("PM4-P0-009 step reports queue the next step and final step queues the summary", () => {
	const loop = new ExecutionLoop();
	loop.onImplementationStarted(state());
	const next = loop.onStepReported(state({ stepRevision: 1, currentStepId: "S2" }));
	assert.equal(next.kind, "queue-step");
	const done = loop.onStepReported(state({ stepRevision: 2, status: "completed", currentStepId: undefined }));
	assert.equal(done.kind, "queue-final");
});

test("PM4-P0-009 two stagnant settled runs pause implementation", () => {
	const loop = new ExecutionLoop();
	loop.onImplementationStarted(state());
	assert.equal(loop.onSettled(state()).kind, "none", "already queued");
	loop.onAgentStart();
	assert.equal(loop.onSettled(state()).kind, "queue-step");
	loop.onAgentStart();
	assert.equal(loop.onSettled(state()).kind, "pause");
});

test("PM4-P0-009 step revision changes reset stagnation", () => {
	const loop = new ExecutionLoop();
	loop.onImplementationStarted(state());
	loop.onAgentStart();
	assert.equal(loop.onSettled(state({ stepRevision: 1 })).kind, "queue-step");
	loop.onAgentStart();
	assert.equal(loop.onSettled(state({ stepRevision: 1 })).kind, "queue-step");
	loop.onAgentStart();
	assert.equal(loop.onSettled(state({ stepRevision: 1 })).kind, "pause");
});

test("PM4-P0-009 completed plan archives after the final summary settles", () => {
	const loop = new ExecutionLoop();
	loop.onImplementationStarted(state());
	loop.onStepReported(state({ stepRevision: 1, status: "completed", currentStepId: undefined }));
	loop.onAgentStart();
	const decision = loop.onSettled(state({ status: "completed", stepRevision: 1, currentStepId: undefined }));
	assert.equal(decision.kind, "archive");
});
