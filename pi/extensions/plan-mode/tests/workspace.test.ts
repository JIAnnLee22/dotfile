import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { captureWorkspaceSnapshot, WorkspaceSnapshotError } from "../src/workspace.ts";
import { fixture } from "./helpers.ts";

test("legacy dependency snapshot is deterministic and ignores unrelated exact-path changes", async () => {
	const f = await fixture();
	try {
		const first = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"], {}, () => "2026-09-03T00:00:00.000Z");
		const second = await captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"], {}, () => "2026-09-03T00:01:00.000Z");
		assert.equal(first.digest, second.digest);
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

test("legacy directory and missing dependency snapshots detect additions", async () => {
	const f = await fixture();
	try {
		const directory = await captureWorkspaceSnapshot(f.cwd, ["src/"]);
		assert.deepEqual(directory.entries.map((entry) => entry.path), ["src", "src/existing.ts"]);
		await fs.writeFile(path.join(f.cwd, "src", "added.ts"), "export {};\n");
		const added = await captureWorkspaceSnapshot(f.cwd, ["src/"]);
		assert.notEqual(directory.digest, added.digest);
		const missing = await captureWorkspaceSnapshot(f.cwd, ["future.txt"]);
		assert.equal(missing.entries[0]?.kind, "missing");
	} finally {
		await f.cleanup();
	}
});

test("legacy dependency snapshots reject symlinks and hard budgets", async () => {
	const f = await fixture();
	try {
		await fs.symlink(path.join(f.cwd, "src", "existing.ts"), path.join(f.cwd, "linked.ts"));
		await assert.rejects(() => captureWorkspaceSnapshot(f.cwd, ["linked.ts"]), WorkspaceSnapshotError);
		await assert.rejects(() => captureWorkspaceSnapshot(f.cwd, ["src/existing.ts"], { maxFileBytes: 1 }), /exceeds 1 bytes/);
		await assert.rejects(() => captureWorkspaceSnapshot(f.cwd, ["src/"], { maxEntries: 1 }), /exceeded 1 entries/);
		if (process.platform !== "win32") {
			const fifo = path.join(f.cwd, "dependency.fifo");
			const created = spawnSync("mkfifo", [fifo]);
			if (created.status === 0) await assert.rejects(() => captureWorkspaceSnapshot(f.cwd, ["dependency.fifo"]), /special file/);
		}
	} finally {
		await f.cleanup();
	}
});

test("legacy snapshot entries use a locale-independent code-unit sort", async () => {
	const f = await fixture();
	try {
		await fs.writeFile(path.join(f.cwd, "src", "A.txt"), "a\n");
		await fs.writeFile(path.join(f.cwd, "src", "_x.txt"), "a\n");
		await fs.writeFile(path.join(f.cwd, "src", "a.txt"), "a\n");
		const snapshot = await captureWorkspaceSnapshot(f.cwd, ["src/"]);
		const paths = snapshot.entries.map((entry) => entry.path);
		assert.deepEqual(paths, [...paths].sort(), "entries must use code-unit order, not localeCompare");
	} finally {
		await f.cleanup();
	}
});
