import assert from "node:assert/strict";
import test from "node:test";
import { compact, taskDetailText, taskState, taskWidgetLines } from "../src/ui.ts";
import type { TaskResult } from "../src/dispatch.ts";

function result(status: TaskResult["status"], label: string): TaskResult {
	return {
		status, label, role: "probe", task: `检查 ${label}`, output: "", stderr: "",
		exitCode: 0, toolCalls: 2, usage: { input: 12, output: 3, cost: 0, turns: 1 }, durationMs: 3000,
	};
}

test("PT-UI live view orders running before queued and completed, includes activity and bounded elapsed", () => {
	const running = { ...result("running", "活动"), startedAt: 1000, currentAction: "read src/main.ts" };
	const lines = taskWidgetLines([result("finished", "完成"), result("queued", "等待"), running], 6000);
	assert.match(lines[0], /1\/3 已结束 · 1 运行 · 1 排队/);
	assert.match(lines[1], /活动.*1轮 2工具 15token 5s/);
	assert.match(lines[2], /read src\/main.ts/);
	assert.match(lines[3], /等待/);
	assert.match(lines[4], /完成/);
	assert.notEqual(taskWidgetLines([running], 0)[0][0], taskWidgetLines([running], 700)[0][0], "running spinner advances");
});

test("PT-UI bounded panel reserves overflow row and sanitizes untrusted labels and tool output", () => {
	const tasks = Array.from({ length: 8 }, (_, i) => result("finished", `${i}`));
	tasks[0] = { ...result("running", "\x1b[31mRED\x1b[0m"), currentAction: "\x1b]8;;https://evil.test\x07link\x1b]8;;\x07", startedAt: 100 };
	tasks[1] = result("queued", "二");
	const lines = taskWidgetLines(tasks, 2000, 5);
	assert.ok(lines.length <= 5);
	assert.match(lines.join(" "), /6 个任务/);
	assert.match(lines.join(" "), /RED/);
	assert.match(lines.join(" "), /link/);
	assert.doesNotMatch(lines.join(" "), /\x1b|evil\.test/);
	assert.equal(compact("a\nb\x1b[2J"), "a b");
	assert.deepEqual(taskWidgetLines([], 0), []);
});

test("PT-UI status uses finished failure rather than initial queued exit code", () => {
	assert.equal(taskState(result("queued", "")), "排队");
	assert.equal(taskState(result("running", "")), "运行");
	assert.equal(taskState(result("finished", "")), "完成");
	assert.equal(taskState({ ...result("finished", ""), errorMessage: "error" }), "失败");
});

test("PT-UI result viewer includes failures and intact implementer diff", () => {
	const failed = taskDetailText({ ...result("finished", "出错"), errorMessage: "failed" });
	assert.match(failed, /状态：失败/);
	assert.match(failed, /failed/);
	const diff = "diff --git a/a.txt b/a.txt\n+implemented\n";
	const body = taskDetailText({ ...result("finished", "编码"), diff, changedFiles: ["a.txt"] });
	assert.match(body, /变更文件：a\.txt/);
	assert.ok(body.endsWith(diff));
});
