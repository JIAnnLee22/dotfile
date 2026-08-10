/**
 * Plan Mode 扩展（带歧义处理）
 *
 * 计划模式把会话分成两个阶段：
 * - planning（创建计划）：只读工具集，agent 探索代码库并输出 "Plan:" 计划；
 * - executing（执行计划）：恢复完整工具，按步骤执行并用 [DONE:n] 追踪进度。
 *
 * 歧义处理（本扩展的核心）：
 * 创建计划过程中，agent 遇到需求不明确 / 多个方案 / 约束冲突等歧义时，
 * 不允许擅自替用户拍板，而是：
 *
 *   1. 主通道 —— agent 调用 `report_ambiguity` 工具：
 *      工具执行会【挂起】当前 agent 循环（工具等待用户输入），扩展用
 *      ctx.ui.select/input 把歧义抛给用户；用户决定后作为工具结果返回，
 *      agent 带着决定继续生成计划。
 *   2. fallback —— agent 未调用工具，而是在文本里输出 <ambiguity> 标记：
 *      message_end 检测到标记后 ctx.abort() 挂起 agent，agent_end 里把歧义
 *      抛给用户，再把用户决定以 followUp 消息注入，继续生成计划。
 *
 * 命令：
 * - /plan            切换计划模式
 * - /todos           查看计划进度
 * - Ctrl+Alt+P       切换计划模式（快捷键）
 * - --plan           以计划模式启动
 *
 * 参考：官方 examples/extensions/plan-mode（工具集管理、Plan: 提取、[DONE:n] 进度）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	AMBIGUITY_GUIDANCE,
	formatResolutionsForAgent,
	hasAmbiguityMarker,
	parseAmbiguityMark,
	type AmbiguityQuestion,
	type AmbiguityResolution,
} from "./ambiguity.ts";
import {
	extractTodoItems,
	markCompletedSteps,
	buildTodoView,
	type TodoItem,
	type TodoViewLine,
} from "./plan.ts";
import { patchTopWidgetPlacement, setTopWidgetVisible } from "./top-widget.ts";

// ---------- 常量 ----------

/** 计划阶段的可选工具（补齐基础读工具） */
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
/** 计划阶段禁用的内置写工具 */
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);

type PlanPhase = "off" | "planning" | "executing";

interface PlanModeState {
	phase: PlanPhase;
	todos?: TodoItem[];
	toolsBeforePlanMode?: string[];
}

const OTHER_OPTION = "✏️ 自定义输入…";

// ---------- 纯辅助 ----------

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

export default function planModeExtension(pi: ExtensionAPI): void {
	// ---------- 状态 ----------
	let phase: PlanPhase = "off";
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;
	/** fallback 处理中（防重入/重复询问） */
	let handlingAmbiguity = false;

	// 把扩展 widget 容器提升到 fullscreen 布局顶部（幂等，上游结构变化时自动跳过）
	void patchTopWidgetPlacement();

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration with ambiguity handling)",
		type: "boolean",
		default: false,
	});

	// ---------- 工具集管理 ----------

	function getPlanningTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function enterPlanningTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanningTools(toolsBeforePlanMode));
	}

	function exitPlanningTools(): void {
		pi.setActiveTools(
			toolsBeforePlanMode ?? [...pi.getActiveTools(), ...PLAN_MODE_TOOLS.filter((t) => !PLAN_MODE_DISABLED_TOOLS.has(t))],
		);
		toolsBeforePlanMode = undefined;
	}

	// ---------- 状态持久化 & UI ----------

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			phase,
			todos: todoItems,
			toolsBeforePlanMode,
		} satisfies PlanModeState);
	}

	/** 按 state 应用颜色（顶部 widget 行） */
	function styleTodoLines(theme: ExtensionContext["ui"]["theme"], lines: TodoViewLine[]): string[] {
		return lines.map((line) => {
			switch (line.state) {
				case "progress":
					return theme.fg("success", line.text);
				case "done":
					return theme.fg("success", "☑ ") + theme.fg("muted", theme.strikethrough(line.text));
				case "current":
					return theme.fg("accent", "▶ ") + theme.fg("accent", theme.bold(line.text));
				case "pending":
					return theme.fg("muted", "☐ ") + line.text;
				case "planning":
					return theme.fg("warning", line.text);
				default:
					return theme.fg("dim", line.text);
			}
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (phase === "executing" && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (phase === "planning") {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// 顶部 widget（布局已提升到 transcript 上方，见 top-widget.ts）
		const lines = buildTodoView(phase, todoItems);
		setTopWidgetVisible(lines.length > 0);
		if (lines.length === 0) {
			ctx.ui.setWidget("plan-todos-top", undefined);
		} else if (ctx.hasUI) {
			ctx.ui.setWidget("plan-todos-top", (_tui, theme) => ({
				render: () => styleTodoLines(theme, lines),
				invalidate: () => {},
			}));
		} else {
			ctx.ui.setWidget("plan-todos-top", lines.map((l) => l.text));
		}
		// 旧底部 widget 不再使用，显式清理
		ctx.ui.setWidget("plan-todos", undefined);
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (phase === "off") {
			phase = "planning";
			enterPlanningTools();
			ctx.ui.notify("Plan mode enabled (read-only). Ask me to analyze and create a plan.");
		} else {
			phase = "off";
			todoItems = [];
			exitPlanningTools();
			ctx.ui.notify("Plan mode disabled.");
		}
		updateStatus(ctx);
		persistState();
	}

	// ---------- 歧义询问核心（主通道与 fallback 共用） ----------

	/** 逐个把歧义问题抛给用户，返回用户决定。无 UI 时返回 null。 */
	async function askUserAboutAmbiguities(
		ctx: ExtensionContext,
		questions: AmbiguityQuestion[],
	): Promise<AmbiguityResolution[] | null> {
		if (!ctx.hasUI) return null;
		const resolutions: AmbiguityResolution[] = [];

		for (const q of questions) {
			const optionLabels = q.options.map((o) => o.label);
			if (q.options.length > 0) {
				const selectOptions = [...optionLabels];
				if (q.allowOther !== false) selectOptions.push(OTHER_OPTION);
				const choice = await ctx.ui.select(`❓ ${q.question}`, selectOptions);
				if (choice === undefined) {
					resolutions.push({ id: q.id, question: q.question, value: "", label: "", note: "用户未回答" });
					continue;
				}
				if (choice === OTHER_OPTION) {
					const custom = await ctx.ui.input(q.question, "输入你的决定…");
					if (custom !== undefined && custom.trim() !== "") {
						resolutions.push({ id: q.id, question: q.question, value: custom.trim(), label: custom.trim(), note: "自定义输入" });
						continue;
					}
					resolutions.push({ id: q.id, question: q.question, value: "", label: "", note: "用户未回答" });
					continue;
				}
				const matched = q.options.find((o) => o.label === choice);
				resolutions.push({
					id: q.id,
					question: q.question,
					value: matched?.value ?? choice,
					label: choice,
				});
			} else {
				// 无选项 → 自由输入
				const answer = await ctx.ui.input(q.question, "输入你的决定…");
				if (answer !== undefined && answer.trim() !== "") {
					resolutions.push({ id: q.id, question: q.question, value: answer.trim(), label: answer.trim(), note: "自定义输入" });
				} else {
					resolutions.push({ id: q.id, question: q.question, value: "", label: "", note: "用户未回答" });
				}
			}
		}
		return resolutions;
	}

	// ---------- 主通道：report_ambiguity 工具 ----------

	pi.registerTool({
		name: "report_ambiguity",
		label: "Report Ambiguity",
		description:
			"Report ambiguities during plan creation (unclear requirements, multiple approaches, conflicting constraints). " +
			"The extension will PAUSE plan creation, ask the user to decide for each ambiguity, and return the user's decisions " +
			"so you can continue building the plan. Use when you cannot determine the user's intent and guessing would be risky. " +
			"Only available during plan mode.",
		parameters: Type.Object({
			ambiguities: Type.Array(
				Type.Object({
					id: Type.String({ description: "Unique identifier for this ambiguity, e.g. 'q1'" }),
					question: Type.String({ description: "The ambiguity question, phrased in the user's language" }),
					options: Type.Array(
						Type.Object({
							value: Type.String({ description: "Machine-readable value returned to you when selected" }),
							label: Type.String({ description: "Label shown to the user" }),
							description: Type.Optional(Type.String({ description: "Optional hint shown under the label" })),
						}),
						{ description: "2-6 concrete, mutually exclusive options for the user to choose from" },
					),
					allowOther: Type.Optional(Type.Boolean({ description: "Allow free-form input (default: true)" })),
				}),
				{ description: "One or more ambiguities to ask the user about" },
			),
		}),
		promptGuidelines: [
			"During plan creation, call report_ambiguity to ask the user about any ambiguity instead of guessing.",
			"Pass several ambiguities in one call when they arise together (e.g. tech stack + scope).",
			"Continue building the plan based on the decisions returned by the tool.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 只在计划创建阶段开放
			if (phase !== "planning") {
				return {
					content: [
						{
							type: "text",
							text: "report_ambiguity 只在计划模式（planning）阶段可用。当前不处于计划模式，请基于合理假设自行决策。",
						},
					],
					details: {},
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "当前为非交互模式（无法向用户提问）。请自行选择最合理的选项并明确说明你的假设，供用户事后确认。",
						},
					],
					details: { interactive: false },
				};
			}

			const questions: AmbiguityQuestion[] = params.ambiguities.map((a: AmbiguityQuestion) => ({
				id: a.id,
				question: a.question,
				options: a.options ?? [],
				allowOther: a.allowOther !== false,
			}));

			ctx.ui.notify(`⏸ 计划创建已挂起，正在询问 ${questions.length} 个歧义点…`, "info");
			const resolutions = await askUserAboutAmbiguities(ctx, questions);
			if (resolutions === null) {
				return {
					content: [
						{
							type: "text",
							text: "无法向用户提问（UI 不可用）。请自行选择最合理的选项并明确说明你的假设。",
						},
					],
					details: { interactive: false },
				};
			}
			ctx.ui.notify("✅ 已收集用户决定，继续制定计划。", "info");
			return {
				content: [{ type: "text", text: formatResolutionsForAgent(resolutions) }],
				details: { resolutions },
			};
		},
	});

	// ---------- fallback：文本 <ambiguity> 标记 ----------

	/** message_end：发现标记 → 立即挂起当前 agent */
	pi.on("message_end", async (event, ctx) => {
		if (phase !== "planning" || handlingAmbiguity) return;
		if (event.message.role !== "assistant") return;
		const text = getTextContent(event.message as AssistantMessage);
		if (!hasAmbiguityMarker(text)) return;

		// 防止 agent_end 的 Plan: 提取/询问与歧义处理互相干扰
		handlingAmbiguity = true;
		ctx.ui.notify("⏸ 检测到歧义标记，挂起计划创建…", "warning");
		ctx.abort();
	});

	/** agent_end：agent 已停止，把歧义抛给用户并注入决定后继续 */
	pi.on("agent_end", async (event, ctx) => {
		if (phase !== "planning" || !handlingAmbiguity) return;
		handlingAmbiguity = false;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;
		const text = getTextContent(lastAssistant);
		if (!hasAmbiguityMarker(text)) return;

		const questions = parseAmbiguityMark(text);
		if (!questions || questions.length === 0) {
			// 有标记但解析失败：把原始歧义段抛给用户自由回答
			if (!ctx.hasUI) return;
			const raw = text.replace(/<ambiguity>[\s\S]*?<\/ambiguity>/i, "").trim() || text.slice(0, 2000);
			const answer = await ctx.ui.editor("无法解析歧义标记，请直接给出你的决定：", raw);
			if (answer !== undefined && answer.trim() !== "") {
				pi.sendMessage(
					{
						customType: "plan-ambiguity-resolution",
						content: `[plan-mode] 用户对歧义的决定：\n${answer.trim()}\n请据此继续制定计划。`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
			return;
		}

		const resolutions = await askUserAboutAmbiguities(ctx, questions);
		if (resolutions === null) return; // 无 UI，跳过（agent 文本标记在非交互模式下无解）

		ctx.ui.notify("✅ 已收集用户决定，继续制定计划。", "info");
		pi.sendMessage(
			{
				customType: "plan-ambiguity-resolution",
				content: formatResolutionsForAgent(resolutions),
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	// ---------- 计划创建完成：提取 Plan: 并询问下一步 ----------

	pi.on("agent_end", async (event, ctx) => {
		// 歧义处理中时跳过（避免重复询问）
		if (phase !== "planning" || handlingAmbiguity || !ctx.hasUI) return;

		// 提取计划步骤
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		if (todoItems.length === 0) return;
		persistState();

		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);
		if (!choice) return;

		if (choice.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			if (!firstTodoItem) return;

			phase = "executing";
			exitPlanningTools();
			updateStatus(ctx);
			persistState();

			const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
			const execMessage = `Execute the plan.\n\nRemaining steps:\n${remainingList}\n\nStart with: ${firstTodoItem.text}\nAfter completing a step, include a [DONE:n] tag in your response.`;
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// ---------- 执行阶段：进度追踪 ----------

	pi.on("agent_end", async (event, ctx) => {
		if (phase !== "executing" || todoItems.length === 0) return;
		const allText = event.messages.filter(isAssistantMessage).map(getTextContent).join("\n");
		const done = markCompletedSteps(allText, todoItems);
		if (done > 0) {
			updateStatus(ctx);
			persistState();
		}
	});

	// ---------- 计划阶段引导 ----------

	pi.on("before_agent_start", (event, _ctx) => {
		if (phase !== "planning") return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${AMBIGUITY_GUIDANCE}`,
		};
	});

	// ---------- 状态恢复 ----------

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			phase = "planning";
		}

		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			phase = planModeEntry.data.phase ?? phase;
			todoItems = planModeEntry.data.todos ?? todoItems;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		// 恢复执行阶段时，重扫执行消息重建 [DONE:n] 进度
		if (phase === "executing" && todoItems.length > 0) {
			const messages: AssistantMessage[] = [];
			for (const entry of entries) {
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
		}

		if (phase === "planning") {
			enterPlanningTools();
		}
		updateStatus(ctx);
	});

	// ---------- 命令 & 快捷键 ----------

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration with ambiguity handling)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems
				.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`)
				.join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});
}
