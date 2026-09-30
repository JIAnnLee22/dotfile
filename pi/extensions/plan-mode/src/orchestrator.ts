/// <reference path="../../types.d.ts" />
/**
 * orchestrator - 实施期的协调工具核心：步骤派发与 diff 应用。
 *
 * 与 plan-mode 的「主会话只统筹分发」目标一致：
 * - dispatchStep：把当前计划步骤打包成 implementer 子任务，在隔离 worktree 中实现并产出 diff；
 * - applyDiff：把审查通过的 diff 用 `git apply --index` 落地到主工作区（含新文件），失败不半应用；
 * - accumulatedPatch：读取已落地的累计改动（HEAD → index），作为下一个顺序步骤 worktree 的基线。
 *
 * 复用 extensions/parallel-tasks 的派发核心（跨目录 import，同 autopilot 复用 canonical 的约定）。
 */

import { spawnSync } from "node:child_process";
import { sha256 } from "./canonical.ts";
import type { ExecutionState, PlanSpec, PlanStepSpec } from "./domain.ts";
import { dispatchTasks, failed, type TaskResult } from "../../parallel-tasks/src/dispatch.ts";
import { loadRoles, ROLES_DIR } from "../../parallel-tasks/src/roles.ts";

export interface GitRun {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export function runGit(cwd: string, args: string[], opts?: { input?: string }): GitRun {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		input: opts?.input,
		maxBuffer: 64 * 1024 * 1024,
		timeout: 60_000,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
	});
	return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export interface AccumulatedPatch {
	ok: boolean;
	patch?: string;
	error?: string;
}

/**
 * 读取已落地到主工作区的累计改动（HEAD → index）。plan_apply_diff 使用 `git apply --index`
 * 把每个已应用步骤的改动暂存，因此这里能看到全部已落地改动（含新文件）。
 */
export function accumulatedPatch(cwd: string): AccumulatedPatch {
	const res = runGit(cwd, ["diff", "--cached", "--binary"]);
	if (!res.ok) {
		return { ok: false, error: `git diff --cached 失败：${(res.stderr || res.stdout).trim()}` };
	}
	return { ok: true, patch: res.stdout };
}

export interface ApplyDiffOutcome {
	ok: boolean;
	changedFiles: string[];
	digest: string;
	error?: string;
}

/** 把审查通过的 diff 应用到主工作区：先 --check 预检，失败不半应用；成功则用 --index 同时暂存。 */
export function revertAppliedDiff(cwd: string, diff: string): { ok: boolean; error?: string } {
	const reverted = runGit(cwd, ["apply", "--reverse", "--index", "--binary"], { input: diff });
	return reverted.ok
		? { ok: true }
		: { ok: false, error: `已应用 diff 回滚失败：${(reverted.stderr || reverted.stdout).trim()}` };
}

export function applyDiff(cwd: string, diff: string): ApplyDiffOutcome {
	const digest = sha256(diff);
	if (!diff.trim()) {
		return { ok: false, changedFiles: [], digest, error: "diff 为空" };
	}
	const check = runGit(cwd, ["apply", "--check", "--binary"], { input: diff });
	if (!check.ok) {
		return { ok: false, changedFiles: [], digest, error: `diff 冲突或无法应用：${(check.stderr || check.stdout).trim()}` };
	}
	const applied = runGit(cwd, ["apply", "--index", "--binary"], { input: diff });
	if (!applied.ok) {
		return { ok: false, changedFiles: [], digest, error: `git apply 失败：${(applied.stderr || applied.stdout).trim()}` };
	}
	const stat = runGit(cwd, ["apply", "--numstat", "--binary"], { input: diff });
	const changedFiles = stat.stdout
		.split("\n")
		.map((line) => line.split("\t")[2])
		.filter((name) => typeof name === "string" && name.trim() !== "");
	return { ok: true, changedFiles, digest };
}

export interface CurrentStepInfo {
	step: PlanStepSpec;
	index: number;
}

export function currentStepInfo(spec: PlanSpec, state: ExecutionState): CurrentStepInfo | { error: string } {
	const stepId = state.currentStepId;
	if (!stepId) return { error: "当前计划没有进行中的步骤" };
	const index = spec.steps.findIndex((step) => step.id === stepId);
	if (index < 0) return { error: `步骤 ${stepId} 不在计划中` };
	return { step: spec.steps[index], index };
}

export function buildStepTask(step: PlanStepSpec, index: number): string {
	const files = step.files.join(", ") || "（未指定，请自行判断应改动的文件）";
	return [
		`实现计划步骤 S${index + 1}「${step.title}」。`,
		`操作：${step.actions.join("；")}`,
		`涉及文件：${files}`,
		"验收标准（派发器会在你的 worktree 内依次执行，全部通过才向主会话提交 diff）：",
		...step.validation.map((command, i) => `${i + 1}. ${command}`),
		"",
		"在隔离 worktree 中完成代码改动；只改动本步骤涉及的文件，不越界。无需自己运行命令，派发器会执行以上验收项；未通过时须告知主会话，不能声称完成。",
	].join("\n");
}

/** 状态投影不包含子任务输出或补丁，避免每次进度更新重复发送大块上下文。 */
export function formatDispatchProgress(live: readonly TaskResult[], elapsedSeconds: number): string {
	const done = live.filter((result) => result.status === "finished").length;
	const active = live.find((result) => result.status === "running");
	const phase = active?.currentAction ? ` · ${active.currentAction.replace(/\s+/g, " ").slice(0, 100)}` : active ? " · 子会话处理中" : "";
	return `步骤派发：${done}/${live.length} 完成${phase} · ${elapsedSeconds}s`;
}

export interface DispatchStepInput {
	cwd: string;
	provider?: string;
	signal?: AbortSignal;
	onProgress?: (live: readonly TaskResult[]) => void;
	task: string;
	basePatch?: string;
	/** 用户已批准计划中当前步骤的逐项可执行验收命令。 */
	validation: readonly string[];
}

export interface DispatchStepOutcome {
	results: TaskResult[];
	integration: string;
	error?: string;
}

/** 把单个 implementer 子任务派发到隔离 worktree，返回 diff 汇总供主会话审查。 */
export async function dispatchStepToSubtask(input: DispatchStepInput): Promise<DispatchStepOutcome> {
	if (input.validation.length === 0 || input.validation.some((command) => !command.trim() || command.length > 2048)) {
		return { results: [], integration: "", error: "当前步骤缺少有效的可执行验收命令；请先更新计划再派发，不能无验收提交 diff" };
	}
	const roles = loadRoles(ROLES_DIR);
	const implementer = roles.find((role) => role.name === "implementer");
	if (!implementer || !implementer.writable) {
		return { results: [], integration: "", error: "parallel-tasks 缺少来源可信且可写的 implementer 角色" };
	}
	const results = await dispatchTasks(roles, [{ role: "implementer", task: input.task, label: "step" }], {
		cwd: input.cwd,
		fallbackProvider: input.provider,
		signal: input.signal,
		onProgress: input.onProgress,
		basePatch: input.basePatch,
		verificationCommands: input.validation,
	});
	const anyOk = results.some((result) => !failed(result));
	return {
		results,
		integration: "", // 不把子会话详细输出复制进主会话上下文。
		...(anyOk ? {} : { error: "implementer 子任务执行失败" }),
	};
}
