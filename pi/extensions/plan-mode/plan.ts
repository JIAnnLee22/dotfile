/**
 * 计划提取与进度追踪 —— 纯函数（基于官方 examples/extensions/plan-mode/utils.ts，
 * 保持兼容并补全类型）。
 *
 * 约定：agent 在回复中以 "Plan:" 标题输出编号计划：
 *
 *   Plan:
 *   1. 第一步……
 *   2. 第二步……
 *
 * 执行阶段用 [DONE:n] 标记完成步骤。
 */

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

/** 清理步骤文本：去 markdown、去动词开头、截断 */
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

/** 从消息文本中提取 Plan: 区块的编号步骤 */
export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	// 整行提取（官方示例用 [^*\n]+ 会在 markdown 粗体处截断，且丢弃以 ` 开头的步骤）
	const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const raw = match[2].trim();
		if (raw.length <= 5 || raw.startsWith("/") || raw.startsWith("-")) continue;
		const cleaned = cleanStepText(raw);
		if (cleaned.length > 3) {
			items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

/** 提取消息中的 [DONE:n] 标记 */
export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

/** 根据 [DONE:n] 标记更新进度，返回本次完成的步骤数 */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

// ---------- 顶部 widget 视图（纯函数，颜色由调用方按 state 应用） ----------

export type TodoViewState = "progress" | "done" | "current" | "pending" | "info" | "planning";

export interface TodoViewLine {
	state: TodoViewState;
	text: string;
}

/**
 * 生成顶部 widget 的行：
 * - executing：进度条 + 步骤列表（当前步骤标 current，已完成标 done）
 * - planning：模式提示，或已有计划的预览列表
 * - off：空数组（不显示）
 *
 * @param maxLines 总行数上限（含进度条与提示行；超出截断并提示）
 */
export function buildTodoView(
	phase: "off" | "planning" | "executing",
	todos: TodoItem[],
	maxLines = 8,
): TodoViewLine[] {
	if (phase === "off") return [];

	if (todos.length === 0) {
		return [
			{
				state: phase === "planning" ? "planning" : "info",
				text: phase === "planning"
					? "⏸ Plan Mode：只读探索中，输出 Plan: 计划后确认执行"
					: "📋 计划为空",
			},
		];
	}

	const completed = todos.filter((t) => t.completed).length;
	const total = todos.length;
	const pct = Math.round((completed / total) * 100);
	const barWidth = 20;
	const filled = Math.round((completed / total) * barWidth);

	const lines: TodoViewLine[] = [
		{
			state: "progress",
			text: `📋 ${completed}/${total}  [${"█".repeat(filled)}${"░".repeat(barWidth - filled)}] ${pct}%`,
		},
	];

	const currentIdx = todos.findIndex((t) => !t.completed);
	const allDone = currentIdx === -1;
	if (allDone) {
		lines.push({ state: "info", text: "✅ 计划完成" });
	}

	const budget = Math.max(0, maxLines - lines.length);
	const shown = todos.slice(0, budget);
	shown.forEach((t, i) => {
		const isCurrent = i === currentIdx;
		lines.push({
			state: t.completed ? "done" : isCurrent ? "current" : "pending",
			text: `${t.step}. ${t.text}`,
		});
	});
	if (total > budget) {
		lines.push({ state: "info", text: `⋯ 还有 ${total - budget} 步` });
	}
	return lines;
}
