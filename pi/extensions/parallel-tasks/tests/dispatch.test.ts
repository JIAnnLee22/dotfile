/// <reference path="../../types.d.ts" />
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadRoles, readOnlyRoleNames, ROLES_DIR } from "../src/roles.ts";
import { captureWorktreeChanges, createWorktree, dispatchTasks, MAX_TASKS } from "../src/dispatch.ts";
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
