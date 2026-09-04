import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlanHash, materializeSteps, normalizeDraft } from "../src/canonical.ts";
import { diffPlanSpecs, renderPlanDiffMarkdown, type PlanDiff } from "../src/diff.ts";
import { PLAN_SCHEMA, type PlanSpec } from "../src/domain.ts";
import { actor, draft, environment, fixture, modelActor, prepareReview, request } from "./helpers.ts";

function spec(overrides: Partial<PlanSpec>): PlanSpec {
	const normalized = normalizeDraft(draft);
	const withoutHash: Omit<PlanSpec, "contentHash"> = {
		schema: PLAN_SCHEMA,
		planId: "00000000-0000-4000-8000-000000000001",
		version: 1,
		parentVersion: null,
		createdAt: "2026-09-03T00:00:00.000Z",
		createdBy: actor,
		goal: normalized.goal,
		decisions: normalized.decisions ?? [],
		scope: { cwd: "/tmp/project", sessionId: "s", branchLeafId: "l", ephemeralSession: false },
		steps: materializeSteps(normalized),
		risks: normalized.risks ?? [],
		...overrides,
	};
	return { ...withoutHash, contentHash: calculatePlanHash(withoutHash) };
}

test("PM4-P0-004 structural diff reports plan and step changes", () => {
	const before = spec({});
	const after = spec({
		version: 2,
		parentVersion: 1,
		goal: "Changed goal",
		steps: [
			...materializeSteps(normalizeDraft(draft)).map((step, index) => (index === 0 ? { ...step, title: "Updated value" } : step)),
		],
	});
	const diff = diffPlanSpecs(before, after);
	assert.equal(diff.schema, "dev.pi.plan-diff/v2");
	assert.equal(diff.changed, true);
	assert.deepEqual(diff.planChanges.map((change) => change.field), ["goal"]);
	assert.equal(diff.stepChanges.find((change) => change.stepId === "S1")?.kind, "modified");
	const markdown = renderPlanDiffMarkdown(diff);
	assert.match(markdown, /Plan Version Diff/);
	assert.match(markdown, /S1.*modified/);
});

test("PM4-P0-004 controller diff requires a predecessor version", async () => {
	const f = await fixture();
	try {
		await prepareReview(f.controller, f.scope);
		const noPredecessor = await f.controller.dispatch(request("diff"), environment(f.scope));
		assert.equal(noPredecessor.ok, false);
		assert.equal(noPredecessor.error?.code, "INVALID_ACTION");
		assert.equal(noPredecessor.state.status, "review");
	} finally {
		await f.cleanup();
	}
});
