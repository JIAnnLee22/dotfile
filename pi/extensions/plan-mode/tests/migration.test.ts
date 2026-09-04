import assert from "node:assert/strict";
import test from "node:test";
import { legacyToDraft, validateLegacyPlanSpec, type LegacyPlanSpec } from "../src/legacy-v1.ts";
import type { PlanScope } from "../src/domain.ts";
import { actor } from "./helpers.ts";

const scope: PlanScope = {
	cwd: "/tmp/project",
	sessionId: "s",
	branchLeafId: "l",
	ephemeralSession: false,
};

function legacySpec(): LegacyPlanSpec {
	return {
		schema: "dev.pi.plan/v1",
		planId: "60000000-0000-4000-8000-000000000006",
		version: 1,
		parentVersion: null,
		createdAt: "2026-08-11T00:00:00.000Z",
		createdBy: actor,
		goal: "Legacy goal",
		facts: ["fact"],
		assumptions: ["assumption"],
		scope,
		steps: [
			{
				id: "S1",
				title: "Legacy step",
				purpose: "Do it",
				actions: ["Edit"],
				dependencyScopes: ["src/a.ts"],
				pathScopes: ["src/a.ts"],
				requiredCapabilities: ["fs.write"],
				acceptance: ["Done"],
				rollback: ["Revert"],
			},
		],
		risks: ["risk"],
		policyDigest: "policy",
		contextDigest: "context",
		contentHash: "0".repeat(64),
	};
}

test("PM4-P0-013 legacyToDraft maps facts, assumptions, paths and acceptance into v2", () => {
	const draft = legacyToDraft(legacySpec());
	assert.equal(draft.goal, "Legacy goal");
	assert.deepEqual(draft.decisions, ["Fact: fact", "Assumption: assumption"]);
	assert.deepEqual(draft.steps[0].files, ["src/a.ts"]);
	assert.deepEqual(draft.steps[0].validation, ["Done"]);
});

test("PM4-P0-013 legacy validation reports contentHash and path issues", () => {
	const bad = legacySpec();
	assert.ok(validateLegacyPlanSpec(bad).some((error) => error.includes("legacy contentHash mismatch")));
	const badPath = { ...legacySpec(), steps: [{ ...legacySpec().steps[0], pathScopes: ["../escape.ts"] }] };
	assert.ok(validateLegacyPlanSpec(badPath).some((error) => /escapes cwd/.test(error)));
});
