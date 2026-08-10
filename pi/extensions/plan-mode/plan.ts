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
