import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import test from "node:test";
import { canonicalJson } from "../src/canonical.ts";
import { PlanController } from "../src/controller.ts";
import type { PlanScope } from "../src/domain.ts";
import {
	calculateLegacyPlanHash,
	legacyPlanRef,
	type LegacyAuditEvent,
	type LegacyExecutionState,
	type LegacyPlanSpec,
} from "../src/legacy-v1.ts";
import {
	actor,
	draft,
	environment,
	fixture,
	implementationEnvironment,
	prepareReview,
	request,
	start,
	submit,
} from "./helpers.ts";

function recovered(f: Awaited<ReturnType<typeof fixture>>): PlanController {
	return new PlanController({
		store: f.store,
		journal: f.journal,
		now: () => "2026-09-03T00:01:00.000Z",
		id: randomUUID,
	});
}

test("PM4-P0-011 implementing resumes paused without authority", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		const controller = recovered(f);
		await controller.recover(f.journal.entries(), "resume", f.scope);
		assert.equal(controller.state.status, "paused");
		assert.equal(controller.state.approvalId, undefined);
		assert.equal(controller.approval, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-011 review and planning recover read-only without grant", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		await submit(f.controller, f.scope, draft);
		const controller = recovered(f);
		await controller.recover(f.journal.entries(), "reload", f.scope);
		assert.equal(controller.state.status, "review");
		assert.equal(controller.approval, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-015 non-monotonic audit fails closed to stale", async () => {
	const f = await fixture();
	try {
		await prepareReview(f.controller, f.scope);
		const entries = f.journal.entries();
		const last = structuredClone(entries.at(-1)!);
		const forged = { ...last, data: { ...last.data, eventId: randomUUID() } };
		const controller = recovered(f);
		await controller.recover([...entries, forged], "resume", f.scope);
		assert.equal(controller.state.status, "stale");
		assert.equal(controller.state.approvalId, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-012 fork creates a paused v2 lineage without approval", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		const controller = recovered(f);
		await controller.recover(f.journal.entries(), "fork", { ...f.scope, sessionId: "forked" }, {
			activeTools: ["read", "bash", "edit", "write"],
		});
		assert.equal(controller.state.status, "paused");
		assert.notEqual(controller.state.planId, ref.planId);
		assert.ok(controller.spec?.forkedFrom);
		assert.equal(controller.approval, undefined);
	} finally {
		await f.cleanup();
	}
});

function legacySpec(scope: PlanScope): LegacyPlanSpec {
	const withoutHash: Omit<LegacyPlanSpec, "contentHash"> = {
		schema: "dev.pi.plan/v1",
		planId: "30000000-0000-4000-8000-000000000003",
		version: 1,
		parentVersion: null,
		createdAt: "2026-08-11T00:00:00.000Z",
		createdBy: actor,
		goal: draft.goal,
		facts: draft.decisions ?? [],
		assumptions: [],
		scope,
		steps: [
			{
				id: "S1",
				title: "Update value",
				purpose: "Implement",
				actions: ["Edit"],
				dependencyScopes: [],
				pathScopes: ["src/existing.ts"],
				requiredCapabilities: ["fs.write"],
				acceptance: ["Updated"],
				rollback: ["Revert"],
			},
		],
		risks: [],
		policyDigest: "policy",
		contextDigest: "context",
	};
	return { ...withoutHash, contentHash: calculateLegacyPlanHash(withoutHash) };
}

function legacyState(spec: LegacyPlanSpec): LegacyExecutionState {
	return {
		schema: "dev.pi.plan-state/v1",
		status: "executing",
		epoch: 3,
		planId: spec.planId,
		planRef: legacyPlanRef(spec),
		currentStepId: "S1",
		steps: { S1: { status: "running", evidenceIds: [] } },
	};
}

function legacyEvent(sequence: number, state: LegacyExecutionState): LegacyAuditEvent {
	return {
		schema: "dev.pi.plan-audit/v1",
		eventId: `legacy-${sequence}`,
		sequence,
		occurredAt: "2026-08-11T00:00:00.000Z",
		sessionId: "session-test",
		branchLeafId: "leaf-test",
		planRef: state.planRef,
		epoch: state.epoch,
		actor,
		action: "state-committed",
		decision: "none",
		state,
	};
}

test("PM4-P0-013 legacy active journal recovers paused and migrates to a new v2 lineage", async () => {
	const f = await fixture();
	try {
		const spec = legacySpec(f.scope);
		const paths = f.store.paths(spec);
		await fs.mkdir(paths.directory, { recursive: true });
		await fs.writeFile(paths.spec, `${canonicalJson(spec)}\n`);
		const entries = [
			{ type: "custom", customType: "plan-mode/audit", data: legacyEvent(1, legacyState(spec)) },
		];
		const controller = recovered(f);
		await controller.recover(entries, "resume", f.scope);
		assert.equal(controller.state.status, "paused");
		assert.ok(controller.legacySpec);
		assert.equal(controller.approval, undefined);

		const migrated = await controller.dispatch(
			request("migrate_v1", controller.state.planRef),
			environment(f.scope, {
				baseline: {
					schema: "dev.pi.plan-tool-baseline/v2",
					baselineId: "40000000-0000-4000-8000-000000000004",
					planId: "50000000-0000-4000-8000-000000000005",
					toolNames: ["read", "bash", "edit", "write"],
					capturedAt: "2026-09-03T00:01:00.000Z",
					sessionId: f.scope.sessionId,
					branchEntryId: f.scope.branchLeafId,
				},
			}),
		);
		assert.equal(migrated.ok, true);
		assert.equal(controller.state.status, "paused");
		assert.ok(controller.spec?.importedFrom);
		assert.equal(controller.spec?.planId, "50000000-0000-4000-8000-000000000005");
	} finally {
		await f.cleanup();
	}
});
