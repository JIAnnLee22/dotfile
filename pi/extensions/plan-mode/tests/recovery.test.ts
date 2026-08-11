import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import test from "node:test";
import { calculatePlanHash } from "../src/canonical.ts";
import { PlanController } from "../src/controller.ts";
import type { PlanSpec } from "../src/domain.ts";
import { captureWorkspaceSnapshot } from "../src/workspace.ts";
import { actor, draft, environment, fixture, modelActor, request } from "./helpers.ts";

function recoveredController(f: Awaited<ReturnType<typeof fixture>>): PlanController {
	return new PlanController({
		store: f.store,
		journal: f.journal,
		now: () => "2026-08-11T00:01:00.000Z",
		id: randomUUID,
	});
}

async function prepareApproved(f: Awaited<ReturnType<typeof fixture>>) {
	await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
	await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
	const ref = f.controller.state.planRef!;
	await f.controller.dispatch(request("approve", ref), environment(f.scope));
	return ref;
}

test("PM-P0-013 approved resumes approved but never restores an ExecutionGrant", async () => {
	const f = await fixture();
	try {
		await prepareApproved(f);
		const recovered = recoveredController(f);
		await recovered.recover(f.journal.entries(), "resume", f.scope, {
			policyDigest: "policy-digest",
			contextDigest: "context-digest",
		});
		assert.equal(recovered.state.status, "approved");
		assert.ok(recovered.approval);
		assert.equal(recovered.grant, undefined);
		assert.equal(recovered.state.grantId, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-013 executing always resumes stale and revokes the grant", async () => {
	const f = await fixture();
	try {
		const ref = await prepareApproved(f);
		await f.controller.dispatch(request("execute", ref), environment(f.scope));
		const previousEpoch = f.controller.state.epoch;
		const recovered = recoveredController(f);
		await recovered.recover(f.journal.entries(), "resume", f.scope, {
			policyDigest: "policy-digest",
			contextDigest: "context-digest",
		});
		assert.equal(recovered.state.status, "stale");
		assert.equal(recovered.state.grantId, undefined);
		assert.equal(recovered.grant, undefined);
		assert.ok(recovered.state.epoch > previousEpoch);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-013 fork/clone retains PlanSpec lineage but clears approval", async () => {
	const f = await fixture();
	try {
		const ref = await prepareApproved(f);
		const recovered = recoveredController(f);
		await recovered.recover(f.journal.entries(), "fork", { ...f.scope, sessionId: "forked-session" }, {
			policyDigest: "policy-digest",
			contextDigest: "context-digest",
		});
		assert.equal(recovered.state.status, "review");
		assert.deepEqual(recovered.state.planRef, ref);
		assert.equal(recovered.state.approvalId, undefined);
		assert.equal(recovered.approval, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-010 recovery uses only supplied branch entries and ignores duplicate tail events", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const reviewEntries = f.journal.entries();
		const ref = f.controller.state.planRef!;
		const duplicate = structuredClone(reviewEntries.at(-1)!);
		await f.controller.dispatch(request("approve", ref), environment(f.scope));
		const recovered = recoveredController(f);
		await recovered.recover([...reviewEntries, duplicate, duplicate], "tree", f.scope, {
			policyDigest: "policy-digest",
			contextDigest: "context-digest",
		});
		assert.equal(recovered.state.status, "review", "approval from another branch must not leak into the supplied branch");
		assert.equal(recovered.approval, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-013 fork clears approval even when context digest also drifted", async () => {
	const f = await fixture();
	try {
		await prepareApproved(f);
		const recovered = recoveredController(f);
		await recovered.recover(f.journal.entries(), "fork", { ...f.scope, sessionId: "forked-session" }, {
			policyDigest: "changed-policy",
			contextDigest: "changed-context",
		});
		assert.equal(recovered.state.status, "review");
		assert.equal(recovered.state.approvalId, undefined);
		assert.equal(recovered.approval, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-010 non-monotonic audit sequence fails closed instead of reviving older authority", async () => {
	const f = await fixture();
	try {
		await prepareApproved(f);
		const entries = f.journal.entries();
		const last = structuredClone(entries.at(-1)!);
		const forged = { ...last, data: { ...last.data, eventId: randomUUID() } };
		const eventCount = f.journal.events.length;
		const recovered = recoveredController(f);
		await recovered.recover([...entries, forged], "resume", f.scope, {
			policyDigest: "policy-digest",
			contextDigest: "context-digest",
		});
		assert.equal(recovered.state.status, "failed");
		assert.equal(recovered.state.approvalId, undefined);
		assert.equal(f.journal.events.length, eventCount, "corrupt journal recovery must not append behind the corrupt point");
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-010 conflicting duplicate eventId fails closed", async () => {
	const f = await fixture();
	try {
		await prepareApproved(f);
		const entries = f.journal.entries();
		const last = structuredClone(entries.at(-1)!);
		const conflicting = { ...last, data: { ...last.data, reason: "tampered duplicate" } };
		const recovered = recoveredController(f);
		await recovered.recover([...entries, conflicting], "resume", f.scope, {
			policyDigest: "policy-digest",
			contextDigest: "context-digest",
		});
		assert.equal(recovered.state.status, "failed");
		assert.equal(recovered.state.approvalId, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-010 orphan artifact version is skipped on retry", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const current = f.controller.spec!;
		const orphanWithoutHash: Omit<PlanSpec, "contentHash"> = {
			...current,
			version: 2,
			parentVersion: 1,
			goal: "Orphaned crash artifact",
		};
		const orphan: PlanSpec = { ...orphanWithoutHash, contentHash: calculatePlanHash(orphanWithoutHash) };
		await f.store.save(orphan);
		const result = await f.controller.dispatch(request("edit", f.controller.state.planRef, actor), environment(f.scope, { draft: { ...draft, goal: "Retried edit" } }));
		assert.equal(result.ok, true);
		assert.equal(f.controller.state.planRef?.version, 3);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-005 concurrent artifact writers cannot overwrite one immutable version", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const current = f.controller.spec!;
		const build = (goal: string): PlanSpec => {
			const withoutHash: Omit<PlanSpec, "contentHash"> = { ...current, version: 2, parentVersion: 1, goal };
			return { ...withoutHash, contentHash: calculatePlanHash(withoutHash) };
		};
		const results = await Promise.allSettled([f.store.save(build("writer-a")), f.store.save(build("writer-b"))]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(results.filter((result) => result.status === "rejected").length, 1);
		const committed = JSON.parse(await fs.readFile(f.store.paths({ planId: current.planId, version: 2 }).spec, "utf8"));
		assert.ok(committed.goal === "writer-a" || committed.goal === "writer-b");
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-013 fork clears approval even when the artifact is corrupt", async () => {
	const f = await fixture();
	try {
		const ref = await prepareApproved(f);
		await fs.writeFile(f.store.paths(ref).spec, "{}\n");
		const recovered = recoveredController(f);
		await recovered.recover(f.journal.entries(), "fork", { ...f.scope, sessionId: "forked-session" }, {
			policyDigest: "changed-policy",
			contextDigest: "changed-context",
		});
		assert.equal(recovered.state.status, "failed");
		assert.equal(recovered.state.approvalId, undefined);
		assert.equal(recovered.approval, undefined);
	} finally {
		await f.cleanup();
	}
});

test("P1-02 approved recovery revalidates workspace dependencies before execution", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		const baseline = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft, workspaceSnapshot: baseline }));
		const ref = f.controller.state.planRef!;
		await f.controller.dispatch(request("approve", ref), environment(f.scope, { workspaceSnapshot: baseline }));
		const recovered = recoveredController(f);
		await recovered.recover(f.journal.entries(), "resume", f.scope, {
			policyDigest: "policy-digest",
			contextDigest: "context-digest",
		});
		assert.equal(recovered.state.status, "approved");
		await fs.writeFile(f.store.paths(ref).review, "non-authoritative change\n");
		await fs.writeFile(`${f.cwd}/src/existing.ts`, "workspace drift\n");
		const actual = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		const valid = await recovered.revalidateWorkspace({ channel: "system", id: "recovery-test" }, f.scope, actual);
		assert.equal(valid, false);
		assert.equal(recovered.state.status, "stale");
		assert.equal(recovered.state.grantId, undefined);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-010 artifact hash corruption fails safe", async () => {
	const f = await fixture();
	try {
		const ref = await prepareApproved(f);
		await fs.writeFile(f.store.paths(ref).spec, "{}\n");
		const recovered = recoveredController(f);
		await recovered.recover(f.journal.entries(), "resume", f.scope, {
			policyDigest: "policy-digest",
			contextDigest: "context-digest",
		});
		assert.equal(recovered.state.status, "failed");
		assert.equal(recovered.state.grantId, undefined);
	} finally {
		await f.cleanup();
	}
});
