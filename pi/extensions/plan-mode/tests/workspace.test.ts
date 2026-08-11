import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { captureWorkspaceSnapshot, WorkspaceSnapshotError } from "../src/workspace.ts";
import { actor, draft, environment, fixture, modelActor, request } from "./helpers.ts";

test("P1-02 dependency snapshot is deterministic and ignores unrelated exact-path changes", async () => {
	const f = await fixture();
	try {
		const first = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"], {}, () => "2026-08-11T00:00:00.000Z");
		const second = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"], {}, () => "2026-08-11T00:01:00.000Z");
		assert.equal(first.digest, second.digest);
		assert.notEqual(first.capturedAt, second.capturedAt);
		await fs.writeFile(path.join(f.cwd, "unrelated.txt"), "unrelated\n");
		const unrelated = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		assert.equal(first.digest, unrelated.digest);
		await fs.writeFile(path.join(f.cwd, "src", "existing.ts"), "export const value = 2;\n");
		const changed = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		assert.notEqual(first.digest, changed.digest);
	} finally {
		await f.cleanup();
	}
});

test("P1-02 directory and missing dependency snapshots detect additions", async () => {
	const f = await fixture();
	try {
		const directory = await captureWorkspaceSnapshot(f.cwd, ["src/"]);
		assert.deepEqual(directory.entries.map((entry) => entry.path), ["src", "src/existing.ts"]);
		await fs.writeFile(path.join(f.cwd, "src", "added.ts"), "export {};\n");
		const added = await captureWorkspaceSnapshot(f.cwd, ["src/"]);
		assert.notEqual(directory.digest, added.digest);

		const missing = await captureWorkspaceSnapshot(f.cwd, ["future.txt"]);
		assert.equal(missing.entries[0]?.kind, "missing");
		await fs.writeFile(path.join(f.cwd, "future.txt"), "created\n");
		const created = await captureWorkspaceSnapshot(f.cwd, ["future.txt"]);
		assert.notEqual(missing.digest, created.digest);
	} finally {
		await f.cleanup();
	}
});

test("P1-02 dependency snapshots reject symlinks and hard budgets", async () => {
	const f = await fixture();
	try {
		await fs.symlink(path.join(f.cwd, "src", "existing.ts"), path.join(f.cwd, "linked.ts"));
		await assert.rejects(() => captureWorkspaceSnapshot(f.cwd, ["linked.ts"]), WorkspaceSnapshotError);
		await assert.rejects(
			() => captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"], { maxFileBytes: 1 }),
			/exceeds 1 bytes/,
		);
		await assert.rejects(
			() => captureWorkspaceSnapshot(f.cwd, ["src/"], { maxEntries: 1 }),
			/exceeded 1 entries/,
		);
		await assert.rejects(
			() => captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"], { maxTotalBytes: 1 }),
			/exceeds 1 total bytes/,
		);
		await assert.rejects(
			() => captureWorkspaceSnapshot(f.cwd, ["src/"], { maxDepth: 0 }),
			/exceeded depth 0/,
		);
		await assert.rejects(
			() => captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"], { timeoutMs: -1 }),
			/exceeded -1ms/,
		);
		if (process.platform !== "win32") {
			const fifo = path.join(f.cwd, "dependency.fifo");
			const created = spawnSync("mkfifo", [fifo]);
			if (created.status === 0) await assert.rejects(() => captureWorkspaceSnapshot(f.cwd, ["dependency.fifo"]), /special file/);
		}
	} finally {
		await f.cleanup();
	}
});

test("P1-02 workspace drift between approval and execute marks authority stale", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		const baseline = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft, workspaceSnapshot: baseline }));
		const ref = f.controller.state.planRef!;
		assert.equal(f.controller.spec?.workspaceSnapshot?.digest, baseline.digest);
		await f.controller.dispatch(request("approve", ref, actor), environment(f.scope, { workspaceSnapshot: baseline }));
		assert.equal(f.controller.state.status, "approved");
		await fs.writeFile(path.join(f.cwd, "src", "existing.ts"), "export const value = 3;\n");
		const drifted = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		const execute = await f.controller.dispatch(request("execute", ref, actor), environment(f.scope, { workspaceSnapshot: drifted }));
		assert.equal(execute.ok, false);
		assert.equal(execute.error?.code, "STALE");
		assert.equal(execute.state.status, "stale");
		assert.equal(execute.state.grantId, undefined);
		assert.equal(f.controller.grant, undefined);
	} finally {
		await f.cleanup();
	}
});

test("P1-02 matching dependency snapshot is bound into the ExecutionGrant", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		const baseline = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft, workspaceSnapshot: baseline }));
		const ref = f.controller.state.planRef!;
		await f.controller.dispatch(request("approve", ref, actor), environment(f.scope, { workspaceSnapshot: baseline }));
		const execution = await f.controller.dispatch(request("execute", ref, actor), environment(f.scope, { workspaceSnapshot: baseline }));
		assert.equal(execution.ok, true);
		assert.equal(f.controller.grant?.workspaceDigest, baseline.digest);
		assert.equal(f.controller.state.status, "executing");
	} finally {
		await f.cleanup();
	}
});

test("P1-02 paused execution requires dependency revalidation before resume", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		const baseline = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft, workspaceSnapshot: baseline }));
		const ref = f.controller.state.planRef!;
		await f.controller.dispatch(request("approve", ref, actor), environment(f.scope, { workspaceSnapshot: baseline }));
		await f.controller.dispatch(request("execute", ref, actor), environment(f.scope, { workspaceSnapshot: baseline }));
		await f.controller.dispatch(request("pause", ref, actor), environment(f.scope, { reason: "checkpoint" }));
		await fs.writeFile(path.join(f.cwd, "src", "existing.ts"), "changed while paused\n");
		const drifted = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		const resumed = await f.controller.dispatch(request("resume", ref, actor), environment(f.scope, { workspaceSnapshot: drifted }));
		assert.equal(resumed.ok, false);
		assert.equal(resumed.error?.code, "STALE");
		assert.equal(resumed.state.status, "stale");
	} finally {
		await f.cleanup();
	}
});

test("P1-02 workspace drift before approval remains review and requires a new version", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		const baseline = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft, workspaceSnapshot: baseline }));
		const ref = f.controller.state.planRef!;
		await fs.writeFile(path.join(f.cwd, "src", "existing.ts"), "drift\n");
		const drifted = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"]);
		const approval = await f.controller.dispatch(request("approve", ref, actor), environment(f.scope, { workspaceSnapshot: drifted }));
		assert.equal(approval.ok, false);
		assert.equal(approval.error?.code, "STALE");
		assert.equal(approval.state.status, "review");
		assert.equal(approval.state.approvalId, undefined);
	} finally {
		await f.cleanup();
	}
});
