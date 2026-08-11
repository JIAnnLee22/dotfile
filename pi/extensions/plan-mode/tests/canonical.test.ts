import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlanHash, canonicalJson, normalizePathScope, sha256, validatePlanSpec } from "../src/canonical.ts";
import { PLAN_SCHEMA, type PlanSpec } from "../src/domain.ts";
import { actor, draft } from "./helpers.ts";

test("PM-P0-005 canonical JSON sorts object keys but preserves array order", () => {
	assert.equal(canonicalJson({ z: 1, a: [2, 1] }), '{"a":[2,1],"z":1}');
	assert.notEqual(sha256(canonicalJson({ a: [1, 2] })), sha256(canonicalJson({ a: [2, 1] })));
	assert.throws(() => canonicalJson({ omitted: undefined }), /rejects undefined/);
	assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
});

test("PM-P0-007 path scopes reject traversal and retain directory semantics", () => {
	assert.equal(normalizePathScope("src/"), "src/");
	assert.equal(normalizePathScope("src/file.ts"), "src/file.ts");
	assert.throws(() => normalizePathScope("../outside"), /escapes cwd/);
	assert.throws(() => normalizePathScope("/etc/passwd"), /must be relative/);
	assert.throws(() => normalizePathScope("/"), /must be relative/);
	assert.throws(() => normalizePathScope("C:\\Windows\\system32"), /must be relative/);
	assert.throws(() => normalizePathScope("@../outside"), /expansion syntax/);
	assert.throws(() => normalizePathScope("~/outside"), /expansion syntax/);
});

test("PM-P0-005 PlanSpec hash excludes only contentHash", () => {
	const withoutHash: Omit<PlanSpec, "contentHash"> = {
		schema: PLAN_SCHEMA,
		planId: "00000000-0000-4000-8000-000000000001",
		version: 1,
		parentVersion: null,
		createdAt: "2026-08-11T00:00:00.000Z",
		createdBy: actor,
		goal: draft.goal,
		facts: draft.facts ?? [],
		assumptions: draft.assumptions ?? [],
		scope: { cwd: "/tmp/project", sessionId: "session", branchLeafId: "leaf", ephemeralSession: false },
		steps: draft.steps,
		risks: draft.risks ?? [],
		policyDigest: "policy",
		contextDigest: "context",
	};
	const spec: PlanSpec = { ...withoutHash, contentHash: calculatePlanHash(withoutHash) };
	assert.deepEqual(validatePlanSpec(spec), []);
	assert.notEqual(calculatePlanHash({ ...spec, goal: "Changed" }), spec.contentHash);
	assert.equal(calculatePlanHash({ ...spec, contentHash: "forged" }), spec.contentHash);
});
