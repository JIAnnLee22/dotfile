/// <reference path="../../types.d.ts" />
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { accumulatedPatch, applyDiff, buildStepTask, currentStepInfo, revertAppliedDiff } from "../src/orchestrator.ts";
import type { ExecutionState, PlanSpec } from "../src/domain.ts";

function git(cwd: string, args: string[], opts?: { input?: string }): { ok: boolean; stdout: string; stderr: string } {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		input: opts?.input,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
	});
	return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function initRepo(): Promise<string> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orch-test-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "t@example.com"]);
	git(root, ["config", "user.name", "tester"]);
	fs.writeFileSync(path.join(root, "a.txt"), "one\n");
	git(root, ["add", "a.txt"]);
	git(root, ["commit", "-q", "-m", "initial"]);
	return root;
}

test("PM4-P0-008 applyDiff lands modifications and new files via git apply --index", async () => {
	const root = await initRepo();
	try {
		fs.writeFileSync(path.join(root, "a.txt"), "two\n");
		const diff = git(root, ["diff", "--cached", "--binary"]); // unstaged? no — writeFile after commit is unstaged
		// 使用 staged diff 形式：先 add 再取 diff
		git(root, ["add", "-A", "."]);
		const stagedDiff = git(root, ["diff", "--cached", "--binary"]);

		// 重置到 HEAD，验证 applyDiff 能恢复改动
		git(root, ["reset", "-q", "--hard", "HEAD"]);
		assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "one\n");

		const outcome = applyDiff(root, stagedDiff.stdout);
		assert.equal(outcome.ok, true, outcome.error);
		assert.ok(outcome.changedFiles.includes("a.txt"), `changedFiles=${outcome.changedFiles.join(",")}`);
		assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "two\n");
		const reverted = revertAppliedDiff(root, stagedDiff.stdout);
		assert.equal(reverted.ok, true, reverted.error);
		assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "one\n");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("PM4-P0-010 applyDiff rejects conflicting diffs without partial application", async () => {
	const root = await initRepo();
	try {
		// 制造一个与当前工作区冲突的 diff：上下文不匹配。
		const conflictingDiff =
			"diff --git a/a.txt b/a.txt\nindex 0000000..1111111 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-does not match\n+other\n";
		const outcome = applyDiff(root, conflictingDiff);
		assert.equal(outcome.ok, false);
		assert.ok(outcome.error);
		assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "one\n");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("PM4-P0-008 accumulatedPatch returns staged changes for sequential-step baseline", async () => {
	const root = await initRepo();
	try {
		const before = accumulatedPatch(root);
		assert.equal(before.ok, true);
		assert.equal(before.patch, "");

		fs.writeFileSync(path.join(root, "new.txt"), "added\n");
		git(root, ["add", "new.txt"]);
		const after = accumulatedPatch(root);
		assert.equal(after.ok, true);
		assert.ok((after.patch ?? "").includes("new.txt"), "expected accumulated patch to include new.txt");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("PM4-P0-004 currentStepInfo and buildStepTask project the current step", () => {
	const spec = {
		schema: "dev.pi.plan/v2",
		planId: "p1",
		version: 1,
		parentVersion: null,
		createdAt: "2026-09-03T00:00:00.000Z",
		createdBy: { channel: "tui", id: "u" },
		goal: "g",
		decisions: [],
		scope: { cwd: "/x", sessionId: "s", branchLeafId: null, ephemeralSession: false },
		steps: [
			{ id: "step-1", title: "Do A", actions: ["edit a"], files: ["a.ts"], validation: ["tsc"] },
			{ id: "step-2", title: "Do B", actions: ["edit b"], files: [], validation: [] },
		],
		risks: [],
		contentHash: "h",
	} as unknown as PlanSpec;
	const state = { status: "implementing", currentStepId: "step-2" } as unknown as ExecutionState;

	const info = currentStepInfo(spec, state);
	assert.ok(!("error" in info));
	if ("error" in info) return;
	assert.equal(info.index, 1);
	const task = buildStepTask(info.step, info.index);
	assert.match(task, /S2/);
	assert.match(task, /Do B/);
	assert.match(task, /edit b/);
});
