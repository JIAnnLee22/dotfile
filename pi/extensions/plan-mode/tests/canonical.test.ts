import assert from "node:assert/strict";
import test from "node:test";
import {
	calculatePlanHash,
	canonicalJson,
	comparePaths,
	materializeSteps,
	normalizeDraft,
	normalizePathScope,
	sha256,
	validatePlanSpec,
} from "../src/canonical.ts";
import { PLAN_SCHEMA, type PlanSpec } from "../src/domain.ts";
import { actor, draft } from "./helpers.ts";

function buildSpec(overrides: Partial<PlanSpec> = {}): PlanSpec {
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
		scope: { cwd: "/tmp/project", sessionId: "session", branchLeafId: "leaf", ephemeralSession: false },
		steps: materializeSteps(normalized),
		risks: normalized.risks ?? [],
		...overrides,
	};
	return { ...withoutHash, contentHash: calculatePlanHash(withoutHash) };
}

test("PM4-P0 canonical JSON sorts object keys but preserves array order", () => {
	assert.equal(canonicalJson({ z: 1, a: [2, 1] }), '{"a":[2,1],"z":1}');
	assert.notEqual(sha256(canonicalJson({ a: [1, 2] })), sha256(canonicalJson({ a: [2, 1] })));
	assert.throws(() => canonicalJson({ omitted: undefined }), /rejects undefined/);
	assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
});

test("PM4-P0 path scope and comparePaths stay stable for shared consumers", () => {
	assert.equal(normalizePathScope("src/"), "src/");
	assert.equal(normalizePathScope("src/file.ts"), "src/file.ts");
	assert.throws(() => normalizePathScope("../outside"), /escapes cwd/);
	assert.throws(() => normalizePathScope("/etc/passwd"), /must be relative/);
	assert.ok(comparePaths("a", "b") < 0);
	assert.ok(comparePaths("b", "a") > 0);
	assert.equal(comparePaths("a", "a"), 0);
});

test("PM4-P0 v2 draft normalizes and materializes stable step ids", () => {
	const normalized = normalizeDraft(draft);
	assert.equal(normalized.goal, draft.goal);
	assert.deepEqual(normalized.decisions, ["Keep the public API stable"]);
	const steps = materializeSteps(normalized);
	assert.deepEqual(steps.map((step) => step.id), ["S1", "S2"]);
	assert.deepEqual(steps[0].files, ["src/existing.ts"]);
	assert.deepEqual(steps[0].validation, ["Read the updated value"]);
});

test("PM4-P0 v2 PlanSpec hash excludes only contentHash", () => {
	const spec = buildSpec();
	assert.deepEqual(validatePlanSpec(spec), []);
	assert.notEqual(calculatePlanHash({ ...spec, goal: "Changed" }), spec.contentHash);
	assert.equal(calculatePlanHash({ ...spec, contentHash: "forged" }), spec.contentHash);
});

test("PM4-P0 v2 validation reports duplicate ids, bad files and imported/forked conflicts", () => {
	const steps = [...buildSpec().steps];
	steps[1] = { ...steps[1], id: "S1" };
	const errors = validatePlanSpec(buildSpec({ steps }));
	assert.ok(errors.some((error) => error.includes("duplicate step id: S1")), errors.join("\n"));

	const badFile = [...buildSpec().steps];
	badFile[0] = { ...badFile[0], files: ["../escape.ts"] };
	assert.ok(validatePlanSpec(buildSpec({ steps: badFile })).some((error) => /escapes cwd/.test(error)));

	const both = validatePlanSpec(
		buildSpec({
			importedFrom: { schema: "dev.pi.plan/v1", planId: "x".repeat(16), version: 1, contentHash: "0".repeat(64) },
			forkedFrom: { planId: "y".repeat(16), version: 1, contentHash: "0".repeat(64) },
		}),
	);
	assert.ok(both.some((error) => error.includes("cannot contain both importedFrom and forkedFrom")));
});
