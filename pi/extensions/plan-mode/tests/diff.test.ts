import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { calculatePlanHash, canonicalJson } from "../src/canonical.ts";
import { renderPlanDiffMarkdown, type PlanDiff } from "../src/diff.ts";
import type { PlanSpec } from "../src/domain.ts";
import { actor, draft, environment, fixture, modelActor, request } from "./helpers.ts";

async function createTwoVersions(f: Awaited<ReturnType<typeof fixture>>) {
	await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
	await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
	const first = f.controller.state.planRef!;
	const revised = {
		...draft,
		goal: "Change the existing value with compatibility review",
		risks: ["Incorrect value", "Compatibility regression"],
		steps: [
			{
				...draft.steps[0],
				title: "Update and review value",
				acceptance: ["The value is updated", "Compatibility is reviewed"],
			},
			{
				id: "S2",
				title: "Document verification",
				purpose: "Preserve review evidence",
				actions: ["Update docs/verification.md"],
				pathScopes: ["docs/verification.md"],
				requiredCapabilities: ["fs.read", "fs.write"] as const,
				acceptance: ["Verification is documented"],
				rollback: ["Remove the added document"],
			},
		],
	};
	await f.controller.dispatch(request("edit", first, actor), environment(f.scope, { draft: revised }));
	return { first, second: f.controller.state.planRef! };
}

test("P1-01 structural plan diff reports plan, modified-step and added-step changes", async () => {
	const f = await fixture();
	try {
		const { first, second } = await createTwoVersions(f);
		const stateBefore = f.controller.state;
		const result = await f.controller.dispatch(
			request("diff"),
			environment(f.scope, { fromVersion: first.version, toVersion: second.version }),
		);
		assert.equal(result.ok, true);
		const diff = result.data as PlanDiff;
		assert.equal(diff.schema, "dev.pi.plan-diff/v1");
		assert.equal(diff.changed, true);
		assert.deepEqual(diff.planChanges.map((change) => change.field), ["goal", "risks"]);
		assert.equal(diff.stepChanges.find((change) => change.stepId === "S1")?.kind, "modified");
		assert.equal(diff.stepChanges.find((change) => change.stepId === "S2")?.kind, "added");
		assert.deepEqual(f.controller.state, stateBefore, "diff must not mutate authoritative execution state");
		const markdown = renderPlanDiffMarkdown(diff);
		assert.match(markdown, /Plan Version Diff/);
		assert.match(markdown, /S2.*added/);
	} finally {
		await f.cleanup();
	}
});

test("P1-01 omitted diff versions select predecessor and current versions", async () => {
	const f = await fixture();
	try {
		const { first, second } = await createTwoVersions(f);
		assert.deepEqual(await f.store.listVersions(first.planId), [first.version, second.version]);
		const result = await f.controller.dispatch(request("diff"), environment(f.scope));
		assert.equal(result.ok, true);
		const diff = result.data as PlanDiff;
		assert.equal(diff.from.version, first.version);
		assert.equal(diff.to.version, second.version);
	} finally {
		await f.cleanup();
	}
});

test("P1-01 default diff follows parentVersion instead of an orphan artifact directory", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const first = f.controller.spec!;
		const orphanWithoutHash: Omit<PlanSpec, "contentHash"> = {
			...first,
			version: 2,
			parentVersion: 1,
			goal: "orphan-version",
		};
		const orphan: PlanSpec = { ...orphanWithoutHash, contentHash: calculatePlanHash(orphanWithoutHash) };
		await f.store.save(orphan);
		await f.controller.dispatch(request("edit", f.controller.state.planRef, actor), environment(f.scope, { draft: { ...draft, goal: "committed-v3" } }));
		assert.equal(f.controller.spec?.version, 3);
		assert.equal(f.controller.spec?.parentVersion, 1);
		const result = await f.controller.dispatch(request("diff"), environment(f.scope));
		assert.equal(result.ok, true);
		assert.equal((result.data as PlanDiff).from.version, 1);
		assert.equal((result.data as PlanDiff).to.version, 3);
	} finally {
		await f.cleanup();
	}
});

test("P1-01 current diff target must match the authoritative PlanRef hash", async () => {
	const f = await fixture();
	try {
		const { second } = await createTwoVersions(f);
		const current = f.controller.spec!;
		const tamperedWithoutHash: Omit<PlanSpec, "contentHash"> = { ...current, goal: "self-consistent replacement" };
		const tampered: PlanSpec = { ...tamperedWithoutHash, contentHash: calculatePlanHash(tamperedWithoutHash) };
		await fs.writeFile(f.store.paths(second).spec, `${canonicalJson(tampered)}\n`);
		const result = await f.controller.dispatch(request("diff"), environment(f.scope));
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "PLAN_REF_MISMATCH");
	} finally {
		await f.cleanup();
	}
});

test("P1-01 diff without a predecessor returns a stable error", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const result = await f.controller.dispatch(request("diff"), environment(f.scope));
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "INVALID_ACTION");
		assert.equal(result.state.status, "review");
	} finally {
		await f.cleanup();
	}
});
