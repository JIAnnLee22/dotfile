/**
 * 歧义处理 —— 纯数据模型与解析工具（无副作用，便于单元测试）。
 *
 * plan-mode 扩展使用两种方式捕获"创建计划时遇到的歧义"：
 *
 * 1. 主通道（推荐）：agent 调用 `report_ambiguity` 工具，工具参数本身就是
 *    结构化数据（见 AmbiguityQuestion），不需要文本解析。
 * 2. 文本 fallback：agent 未调用工具，而是在回复里输出 `<ambiguity>` 标记。
 *    parseAmbiguityMark 负责把标记解析为与工具参数相同的结构，
 *    之后走完全相同的询问流程。
 *
 * 约定的文本标记格式（宽松解析，也接受 AMBIGUITY: 前缀）：
 *
 *   <ambiguity>
 *   1. 使用哪个数据库？
 *   - PostgreSQL [postgres]: 社区生态好，团队熟悉
 *   - SQLite [sqlite]: 零运维，单文件
 *   2. 是否需要迁移现有数据？
 *   - 是 / 否
 *   </ambiguity>
 */

export interface AmbiguityOption {
	/** 机器可读的值，返回给 agent 使用 */
	value: string;
	/** 展示给用户的标签 */
	label: string;
	/** 可选的补充说明，展示在标签下方 */
	description?: string;
}

export interface AmbiguityQuestion {
	/** 唯一标识（agent 生成，如 "q1"） */
	id: string;
	/** 完整的歧义问题文本 */
	question: string;
	/** 用户可选择的选项；为空时用自由输入代替 */
	options: AmbiguityOption[];
	/** 是否允许用户自定义输入（默认 true） */
	allowOther?: boolean;
}

export interface AmbiguityResolution {
	id: string;
	question: string;
	/** 用户选择/输入的答案 */
	value: string;
	/** 展示文本（选中项的 label 或自定义输入内容） */
	label: string;
	/** 补充说明，如 "用户未回答" */
	note?: string;
}

/** 文本标记的开闭标签（大小写不敏感） */
export const AMBIGUITY_TAG = "ambiguity";

export const AMBIGUITY_TAG_RE = /<ambiguity>[\s\S]*?<\/ambiguity>/i;
export const AMBIGUITY_PREFIX_RE = /^AMBIGUITY:\s*/i;

/** 消息文本里是否出现歧义标记 */
export function hasAmbiguityMarker(text: string): boolean {
	if (!text) return false;
	if (AMBIGUITY_TAG_RE.test(text)) return true;
	// 允许 "AMBIGUITY:" 开头的独立段落（整段作为歧义）
	return text.split("\n").some((line) => AMBIGUITY_PREFIX_RE.test(line.trim()));
}

/** 剥离标记区块（用于清理展示，不影响上下文） */
export function stripAmbiguityMarker(text: string): string {
	return text
		.replace(/(?:\r?\n)?<ambiguity>[\s\S]*?<\/ambiguity>(?:\r?\n)?/i, "\n")
		.trim();
}

/** 从一行中提取 [value] 标注与冒号描述，例如 "- PostgreSQL [postgres]: 生态好" */
function splitOptionLine(line: string): { label: string; value?: string; description?: string } {
	const m = line.match(/^(.*?)\s*\[([^\]]+)\](?:\s*[:：]\s*(.*))?$/);
	if (m) {
		return { label: m[1].trim(), value: m[2].trim(), description: m[3]?.trim() };
	}
	return { label: line.trim() };
}

/** 是否把 "A / B" 样式的行拆成多个短选项（无 [value]、无冒号描述时） */
function splitSlashOptions(body: string): string[] {
	if (body.includes("[") || body.includes(":")) return [body];
	const parts = body
		.split("/")
		.map((p) => p.trim())
		.filter((p) => p.length > 0 && p.length <= 20);
	return parts.length >= 2 ? parts : [body];
}

/** 判定一行是否像"问题行"（编号/问题前缀/问号结尾） */
function isQuestionLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		/^\d+[.)]\s*/.test(trimmed) ||
		/^q\d*[:：]/i.test(trimmed) ||
		/^问题[:：]/i.test(trimmed) ||
		(trimmed.endsWith("?") && trimmed.length > 4)
	);
}

/**
 * 解析文本里的歧义标记。解析失败（或没有标记）返回 null。
 * 解析出至少一个问题才视为有效。
 */
export function parseAmbiguityMark(text: string): AmbiguityQuestion[] | null {
	if (!hasAmbiguityMarker(text)) return null;

	// 优先取 <ambiguity> 区块；否则取 "AMBIGUITY:" 开头的段落（到下一个空行/Plan: 为止）
	let section: string | undefined;
	const tagMatch = text.match(AMBIGUITY_TAG_RE);
	if (tagMatch) {
		section = tagMatch[0].replace(/<\/?ambiguity>/gi, "");
	} else {
		const lines = text.split("\n");
		const start = lines.findIndex((l) => AMBIGUITY_PREFIX_RE.test(l.trim()));
		if (start === -1) return null;
		const body: string[] = [lines[start].replace(AMBIGUITY_PREFIX_RE, "")];
		for (let i = start + 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line === "" || /^Plan:/i.test(line)) break;
			body.push(lines[i]);
		}
		section = body.join("\n");
	}
	if (!section) return null;

	const questions: AmbiguityQuestion[] = [];
	let current: AmbiguityQuestion | undefined;

	for (const rawLine of section.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;

		const isBullet = line.startsWith("-") || line.startsWith("*");

		if (isBullet) {
			if (!current) continue;
			const body = line.replace(/^[-*]\s*/, "").trim();
			if (!body) continue;
			const { label, value, description } = splitOptionLine(body);
			for (const part of splitSlashOptions(body)) {
				const opt = splitOptionLine(part);
				const optLabel = value ? label : opt.label;
				const optValue = value ? value : (opt.value ?? opt.label);
				if (optLabel) {
					current.options.push({
						label: optLabel,
						value: optValue,
						description: description ?? opt.description,
					});
				}
			}
			continue;
		}

		if (isQuestionLine(line)) {
			// 新问题
			const cleaned = line
				.replace(/^\d+[.)]\s*/, "")
				.replace(/^q\d*[:：]\s*/i, "")
				.replace(/^问题[:：]\s*/, "")
				.trim();
			if (cleaned.length < 2) continue;
			current = {
				id: `q${questions.length + 1}`,
				question: cleaned,
				options: [],
				allowOther: true,
			};
			questions.push(current);
			continue;
		}

		if (!current) {
			// 首个非选项行（如 AMBIGUITY: 前缀段落的第一行）作为问题兜底
			if (line.length < 2) continue;
			current = {
				id: `q${questions.length + 1}`,
				question: line,
				options: [],
				allowOther: true,
			};
			questions.push(current);
			continue;
		}

		// 非问题行：如果有当前问题且尚未有选项，视为问题的一部分；否则忽略
		if (current.options.length === 0 && line.length > 2) {
			current.question = `${current.question} ${line}`.trim();
		}
	}

	// 至少有"问题+选项"或"问题"才有效
	const valid = questions.filter((q) => q.question && (q.options.length > 0 || q.allowOther !== false));
	return valid.length > 0 ? valid : null;
}

/** 把用户决定格式化为注入给 agent 的结构化文本 */
export function formatResolutionsForAgent(resolutions: AmbiguityResolution[]): string {
	if (resolutions.length === 0) {
		return "[plan-mode] 用户没有回答任何歧义问题，请基于合理假设继续制定计划。";
	}
	const lines = resolutions.map((r) => {
		const answer = r.value ? `"${r.value}"` : "(未回答)";
		return `- ${r.question} → ${answer}${r.note ? `（${r.note}）` : ""}`;
	});
	return `[plan-mode] 用户对歧义的决定：\n${lines.join("\n")}\n请根据这些决定继续制定计划；若仍有歧义请再次调用 report_ambiguity 工具。`;
}

/** 注入 before_agent_start 的引导提示（计划创建阶段） */
export const AMBIGUITY_GUIDANCE = `[plan-mode 歧义处理约定]
在制定计划的过程中，如果遇到以下情况，说明存在歧义：
- 需求表述不明确、缺少关键信息；
- 存在多个可行方案/技术选型，需要用户拍板；
- 不同约束（性能/成本/兼容性等）相互冲突；
- 你无法确定用户意图，只能靠猜。

遇到歧义时：
1. 优先调用 report_ambiguity 工具：把每个歧义点组织成 question（语言与用户一致），
   给出 2-6 个具体、互斥的 options。工具会把歧义抛给用户，用户的决定会作为
   工具结果返回给你，然后据此继续制定计划。
2. 一个工具调用可以同时提交多个歧义点（比如技术选型 + 范围界定）。
3. 不要替用户做重大方向性决定；也不要因为歧义而中断计划。
4. 仅当工具不可用（非交互模式）时，才用文本标记说明歧义（<ambiguity> 区块）。`;
