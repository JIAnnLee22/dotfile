import assert from "node:assert/strict";
import test from "node:test";
import { canTransition, isTerminal, usesPlanningSafePolicy } from "../src/state-machine.ts";
import type { PlanStatus } from "../src/domain.ts";

test("PM-P0-009 terminal and stale states never jump directly to executing", () => {
	for (const status of ["completed", "rejected", "cancelled", "failed", "stale"] satisfies PlanStatus[]) {
		assert.equal(canTransition(status, "executing"), false, `${status} must not elevate directly`);
	}
	assert.equal(canTransition("approved", "executing"), true);
	assert.equal(canTransition("paused", "executing"), true);
});

test("PM-P0-013 every non-inactive state retains planning-safe policy", () => {
	const statuses: PlanStatus[] = [
		"inactive",
		"researching",
		"awaiting_input",
		"review",
		"approved",
		"executing",
		"paused",
		"completed",
		"rejected",
		"cancelled",
		"stale",
		"failed",
	];
	for (const status of statuses) assert.equal(usesPlanningSafePolicy(status), status !== "inactive");
	for (const terminal of ["completed", "rejected", "cancelled", "failed"] satisfies PlanStatus[]) assert.equal(isTerminal(terminal), true);
});
