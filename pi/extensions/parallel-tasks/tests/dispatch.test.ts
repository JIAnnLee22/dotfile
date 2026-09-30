/// <reference path="../../types.d.ts" />
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadRoles, readOnlyRoleNames, ROLES_DIR } from "../src/roles.ts";
import { captureWorktreeChanges, createWorktree, dispatchTasks, mapWithLimit, MAX_TASKS, runVerificationCommands, verifyWorktreeChanges, type TaskResult } from "../src/dispatch.ts";
import { escapesWorktree, validateBash } from "../write-guard.ts";

function git(cwd: string, args: string[], opts?: { input?: string }): { ok: boolean; stdout: string; stderr: string } {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		input: opts?.input,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
	});
	return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("PT-ROLES read-only roles are non-writable; implementer is writable", () => {
	const roles = loadRoles(ROLES_DIR);
	assert.ok(roles.length >= 5, `expected at least 5 roles, got ${roles.length}`);
	const byName = new Map(roles.map((r) => [r.name, r]));
	for (const name of ["probe", "analyst", "verifier", "reviewer"]) {
		assert.ok(byName.has(name), `missing role ${name}`);
		assert.equal(byName.get(name)!.writable, false, `${name} must be read-only`);
	}
	assert.ok(byName.has("implementer"), "missing implementer role");
	assert.equal(byName.get("implementer")!.writable, true, "implementer must be writable");
	assert.equal(byName.get("implementer")!.tools.includes("bash"), false, "writable child must not mistake worktree isolation for a process sandbox");

	assert.deepEqual(readOnlyRoleNames(roles).sort(), ["analyst", "probe", "reviewer", "verifier"].sort());
});

test("PT-WORKTREE createWorktree applies basePatch on top of HEAD before subtask runs", async () => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ptask-test-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "t@example.com"]);
		git(root, ["config", "user.name", "tester"]);
		fs.writeFileSync(path.join(root, "base.txt"), "base\n");
		git(root, ["add", "base.txt"]);
		git(root, ["commit", "-q", "-m", "initial"]);

		// 累计补丁：新增一个文件。
		const basePatch = "diff --git a/patched.txt b/patched.txt\nnew file mode 100644\nindex 0000000..257cc56\n--- /dev/null\n+++ b/patched.txt\n@@ -0,0 +1 @@\n+patched\n";

		const wt = createWorktree(root, root, basePatch);
		assert.equal(wt.error, undefined);
		assert.ok(wt.dir, "expected a worktree path");
		assert.equal(fs.readFileSync(path.join(wt.dir!, "patched.txt"), "utf8"), "patched\n");
		assert.equal(fs.readFileSync(path.join(wt.dir!, "base.txt"), "utf8"), "base\n");
		wt.cleanup?.();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("PT-WORKTREE createWorktree without basePatch stays at HEAD", async () => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ptask-test-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "t@example.com"]);
		git(root, ["config", "user.name", "tester"]);
		fs.writeFileSync(path.join(root, "base.txt"), "base\n");
		git(root, ["add", "base.txt"]);
		git(root, ["commit", "-q", "-m", "initial"]);

		const wt = createWorktree(root, root);
		assert.ok(wt.dir);
		assert.ok(wt.baselineTree);
		assert.equal(fs.readFileSync(path.join(wt.dir!, "base.txt"), "utf8"), "base\n");
		assert.equal(wt.cleanup?.().ok, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("PT-WORKTREE capture returns only the step delta after basePatch", async () => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ptask-delta-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "t@example.com"]);
		git(root, ["config", "user.name", "tester"]);
		fs.writeFileSync(path.join(root, "base.txt"), "base\n");
		git(root, ["add", "base.txt"]);
		git(root, ["commit", "-q", "-m", "initial"]);
		const basePatch = "diff --git a/patched.txt b/patched.txt\nnew file mode 100644\nindex 0000000..257cc56\n--- /dev/null\n+++ b/patched.txt\n@@ -0,0 +1 @@\n+patched\n";
		const wt = createWorktree(root, root, basePatch);
		assert.ok(wt.dir && wt.baselineTree);
		fs.writeFileSync(path.join(wt.dir!, "base.txt"), "changed\n");
		const captured = captureWorktreeChanges(wt.dir!, wt.baselineTree!);
		assert.equal(captured.ok, true, captured.error);
		assert.match(captured.diff, /base\.txt/);
		assert.doesNotMatch(captured.diff, /patched\.txt/);
		assert.deepEqual(captured.changedFiles, ["base.txt"]);
		assert.equal(wt.cleanup?.().ok, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("PT-GUARD blocks git escapes, nested interpreters, traversal and symlinks", async () => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ptask-guard-"));
	const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ptask-outside-"));
	try {
		fs.symlinkSync(outside, path.join(root, "escape"), "dir");
		fs.symlinkSync(path.join(outside, "missing"), path.join(root, "dangling"), "file");
		assert.match(validateBash("git push origin main", root) ?? "", /git push/);
		assert.match(validateBash("git -C .. status", root) ?? "", /-C|worktree/);
		assert.match(validateBash("bash -c 'touch ../x'", root) ?? "", /bash|解释器/);
		assert.match(validateBash("command bash -c 'touch ../x'", root) ?? "", /command|解释器/);
		assert.match(validateBash("rm ../x", root) ?? "", /越出/);
		assert.match(validateBash("printf x>/tmp/pwn", root) ?? "", /越出/);
		assert.match(validateBash("printf x \"$(touch /tmp/pwn)\"", root) ?? "", /命令替换/);
		assert.match(validateBash("node --experimental-strip-types --test tests/a.test.ts", root) ?? "", /node|解释器/);
		assert.match(validateBash("git -C../ status", root) ?? "", /全局选项/);
		assert.equal(escapesWorktree("escape/file.txt", root), true);
		assert.equal(escapesWorktree("dangling", root), true);
		assert.equal(escapesWorktree("inside/file.txt", root), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("PT-DISPATCH core rejects task counts outside its own limit", async () => {
	await assert.rejects(() => dispatchTasks([], [], { cwd: process.cwd() }), /1\.\./);
	const tooMany = Array.from({ length: MAX_TASKS + 1 }, (_, i) => ({ role: "probe", task: String(i) }));
	await assert.rejects(() => dispatchTasks([], tooMany, { cwd: process.cwd() }), /1\.\./);
});

test("PT-DISPATCH optional concurrency is bounded without changing default dispatch", async () => {
	const task = [{ role: "unknown", task: "no spawn" }];
	for (const maxConcurrency of [0, -1, 1.5, 5, NaN]) {
		await assert.rejects(() => dispatchTasks([], task, { cwd: process.cwd(), maxConcurrency }), /maxConcurrency/);
	}
	const frames: TaskResult[][] = [];
	const results = await dispatchTasks([], task, {
		cwd: process.cwd(), maxConcurrency: 1,
		onProgress: (live) => frames.push([...live]),
	});
	assert.equal(results[0].status, "finished");
	assert.deepEqual(frames.map((frame) => frame.map((r) => r.status)), [["queued"], ["finished"]]);
	assert.notEqual(frames[0][0], results[0], "previous UI frame must not mutate after dispatch");
});

test("PT-DISPATCH concurrency scheduler respects its per-batch limit and preserves result order", async () => {
	let running = 0;
	let maxRunning = 0;
	const results = await mapWithLimit([0, 1, 2, 3, 4, 5], 2, async (item) => {
		running++;
		maxRunning = Math.max(maxRunning, running);
		await new Promise((resolve) => setTimeout(resolve, 5));
		running--;
		return item * 2;
	});
	assert.equal(maxRunning, 2);
	assert.deepEqual(results, [0, 2, 4, 6, 8, 10]);
});

test("PM4-P0-009 dispatch reports finished after a worktree initialization failure", async () => {
	const states: string[] = [];
	const roles = loadRoles(ROLES_DIR);
	const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-not-repo-"));
	try {
		const results = await dispatchTasks(roles, [{ role: "implementer", task: "do work" }], {
			cwd,
			onProgress: (live) => states.push(live[0].status),
		});
		assert.equal(results[0].status, "finished");
		assert.equal(results[0].exitCode, 1);
		assert.deepEqual(states, ["queued", "finished"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("PM4-P0-008 worktree acceptance runs every command and returns bounded evidence", async () => {
	const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
	try {
		const actions: Array<string | undefined> = [];
		const result = await runVerificationCommands(cwd, ["pwd", "printf verified"], undefined, (action) => actions.push(action));
		assert.deepEqual(result.map((check) => check.ok), [true, true]);
		assert.match(result[0].output, /pi-verify-/);
		assert.equal(result[1].output, "verified");
		assert.deepEqual(actions, ["验收 1/2: pwd", undefined, "验收 2/2: printf verified", undefined]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("PM4-P0-008 worktree validation only returns the original implementation diff", async () => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-verify-diff-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "t@example.com"]);
		git(root, ["config", "user.name", "tester"]);
		fs.writeFileSync(path.join(root, "a.txt"), "original\n");
		git(root, ["add", "a.txt"]);
		git(root, ["commit", "-q", "-m", "initial"]);
		const wt = createWorktree(root, root);
		assert.ok(wt.dir && wt.baselineTree);
		try {
			fs.writeFileSync(path.join(wt.dir!, "a.txt"), "implemented\n");
			const pass = await verifyWorktreeChanges(wt.dir!, wt.baselineTree!, ["grep implemented a.txt"]);
			assert.equal(pass.error, undefined);
			assert.match(pass.changes?.diff ?? "", /implemented/);
			const polluted = await verifyWorktreeChanges(wt.dir!, wt.baselineTree!, ["touch generated.txt"]);
			assert.match(polluted.error ?? "", /改变了 worktree/);
			assert.equal(polluted.changes, undefined);
		} finally {
			assert.equal(wt.cleanup?.().ok, true);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("PM4-P0-008 failed acceptance stops the remaining commands", async () => {
	const result = await runVerificationCommands(process.cwd(), ["false", "printf must-not-run"]);
	assert.equal(result.length, 1);
	assert.equal(result[0].ok, false);
	assert.equal(result[0].exitCode, 1);
});

test("PM4-P0-008 acceptance times out or cancels instead of claiming a pass", async () => {
	const timed = await runVerificationCommands(process.cwd(), ["sleep 2", "printf must-not-run"], undefined, undefined, 20);
	assert.equal(timed.length, 1);
	assert.equal(timed[0].ok, false);
	assert.match(timed[0].output, /超时/);
	const controller = new AbortController();
	controller.abort();
	const aborted = await runVerificationCommands(process.cwd(), ["printf must-not-run"], controller.signal);
	assert.equal(aborted[0].ok, false);
	assert.match(aborted[0].output, /取消/);
	const active = new AbortController();
	const pending = runVerificationCommands(process.cwd(), ["sleep 2", "printf must-not-run"], active.signal);
	setTimeout(() => active.abort(), 20);
	const interrupted = await pending;
	assert.equal(interrupted.length, 1);
	assert.equal(interrupted[0].ok, false);
	assert.match(interrupted[0].output, /取消/);
});
