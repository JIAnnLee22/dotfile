import { failed, type TaskResult } from "./dispatch.ts";

/** 不让模型输出或任务标签在终端面板里注入控制序列。 */
export function compact(text: string, max = 84): string {
	const plain = text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

export function taskState(result: TaskResult): string {
	if (result.status === "queued") return "排队";
	if (result.status === "running") return "运行";
	return failed(result) ? "失败" : "完成";
}

export function taskDetailText(r: TaskResult): string {
	return [
		`任务：${r.task}`, `角色：${r.role} · 状态：${taskState(r)} · 模型：${r.model ?? "默认"}`,
		`轮数：${r.usage.turns} · 工具：${r.toolCalls} · 耗时：${(r.durationMs / 1000).toFixed(1)}s`,
		"", r.errorMessage || r.output || "(无输出)",
		r.diff !== undefined ? `\n变更文件：${(r.changedFiles ?? []).join(", ") || "(无)"}\n\n${r.diff}` : "",
	].join("\n");
}

/** 返回纯文本行；终端宽度与主题在注册 widget 的地方处理。 */
export function taskWidgetLines(results: readonly TaskResult[], now = Date.now(), maxLines = 8): string[] {
	if (results.length === 0 || maxLines < 2) return [];
	const running = results.filter((r) => r.status === "running");
	const queued = results.filter((r) => r.status === "queued");
	const finished = results.filter((r) => r.status === "finished");
	const succeeded = finished.filter((r) => !failed(r)).length;
	const frame = running.length ? ["⠋", "⠙", "⠹", "⠸"][Math.floor(now / 700) % 4] : "●";
	const header = `${frame} 子任务 ${finished.length}/${results.length} 已结束 · ${running.length} 运行 · ${queued.length} 排队${finished.length - succeeded ? ` · ${finished.length - succeeded} 失败` : ""}`;
	const lines = [header];
	const ordered = [...running, ...queued, ...finished];
	let displayed = 0;
	for (const r of ordered) {
		const icon = r.status === "running" ? "◉" : r.status === "queued" ? "◦" : failed(r) ? "✗" : "✓";
		const seconds = r.status === "running" && r.startedAt
			? Math.max(0, Math.floor((now - r.startedAt) / 1000))
			: Math.floor(r.durationMs / 1000);
		const tokens = r.usage.input + r.usage.output;
		const stats = r.status === "queued" ? "" : ` · ${r.usage.turns}轮 ${r.toolCalls}工具${tokens > 0 ? ` ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}token` : ""} ${seconds}s`;
		const entry = [`${icon} [${compact(r.label, 24)}] ${compact(r.role, 18)} · ${compact(r.task, 48)}${stats}`];
		if (r.status === "running") entry.push(`   ⎿ ${compact(r.currentAction || "思考中…", 92)}`);
		const needsOverflow = displayed + 1 < ordered.length ? 1 : 0;
		if (lines.length + entry.length + needsOverflow > maxLines) break;
		lines.push(...entry);
		displayed++;
	}
	const hidden = ordered.length - displayed;
	if (hidden > 0) lines.push(`└─ 还有 ${hidden} 个任务（/parallel-results 查看详情）`);
	return lines;
}
