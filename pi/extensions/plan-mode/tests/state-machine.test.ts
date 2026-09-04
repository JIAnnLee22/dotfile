import assert from "node:assert/strict";
import test from "node:test";
import {
	canTransition,
	hasImplementationAuthority,
	isTerminal,
	usesPlanningPolicy,
} from "../src/state-machine.ts";
import { createInitialState, type ExecutionState, type PlanStatus } from "../src/domain.ts";

test("PM4-P0 v2 terminal and stale states never jump directly to implementing", () => {
	for (const status of ["completed", "cancelled", "failed", "stale"] satisfies PlanStatus[]) {
		assert.equal(canTransition(status, "implementing"), false, `${status} must not elevate directly`);
	}
	assert.equal(canTransition("review", "implementing"), true);
	assert.equal(canTransition("paused", "implementing"), true);
});

test("PM4-P0 planning policy applies to read-only and paused states", () => {
	for (const status of ["planning", "awaiting_input", "review", "paused", "stale"] satisfies PlanStatus[]) {
		assert.equal(usesPlanningPolicy(status), true, status);
	}
	for (const status of ["inactive", "implementing", "completed", "cancelled", "failed"] satisfies PlanStatus[]) {
		assert.equal(usesPlanningPolicy(status), false, status);
	}
});

test("PM4-P0 implementation authority requires implementing plus approval", () => {
	const base = createInitialState("2026-09-03T00:00:00.000Z");
	const state: ExecutionState = { ...base, status: "implementing" };
	assert.equal(hasImplementationAuthority(state), false);
	assert.equal(hasImplementationAuthority({ ...state, approvalId: "approval-1" }), true);
});

test("PM4-P0 terminal set excludes stale", () => {
	for (const terminal of ["completed", "cancelled", "failed"] satisfies PlanStatus[]) assert.equal(isTerminal(terminal), true);
	assert.equal(isTerminal("stale"), false);
	assert.equal(isTerminal("implementing"), false);
});
