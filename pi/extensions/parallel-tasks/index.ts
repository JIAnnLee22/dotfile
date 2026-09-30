/// <reference path="../../types.d.ts" />
/**
 * parallel-tasks - 并行子任务 + 主会话整合
 *
 * 每个子任务跑在独立的 pi 进程里（独立上下文、独立 scratch 目录）；
 * 只读角色直接调研，可写角色（implementer）在隔离的 git worktree 中编码并产出 diff，
 * 全部结束后把结果汇总成一个整合块返回给当前会话。
 *
 * 派发核心在 `src/dispatch.ts`，本文件只负责工具注册与渲染。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, matchesKey, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildIntegration, dispatchTasks, failed, MAX_CONCURRENCY, MAX_TASKS, type TaskResult } from "./src/dispatch.ts";
import { loadRoles, ROLES_DIR } from "./src/roles.ts";
import { compact, taskDetailText, taskState, taskWidgetLines } from "./src/ui.ts";

interface Details {
	results: TaskResult[];
	running: number;
}

function oneLine(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export default function (pi: ExtensionAPI) {
	const roles = loadRoles(ROLES_DIR);
	const roleNames = roles.map((r) => r.name);
	const activeBatches = new Map<symbol, readonly TaskResult[]>();
	let lastResults: readonly TaskResult[] = [];
	let generation = 0;
	let requestWidgetRender: (() => void) | undefined;
	let widgetTimer: NodeJS.Timeout | undefined;

	function updateWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (activeBatches.size === 0) {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			ctx.ui.setWidget("parallel-tasks", undefined);
			ctx.ui.setStatus("parallel-tasks", undefined);
			requestWidgetRender = undefined;
			return;
		}
		const live = [...activeBatches.values()].flat();
		const running = live.filter((r) => r.status === "running").length;
		const queued = live.filter((r) => r.status === "queued").length;
		ctx.ui.setStatus("parallel-tasks", `${running} 运行 · ${queued} 排队`);
		if (!widgetTimer) {
			widgetTimer = setInterval(() => requestWidgetRender?.(), 1000);
			widgetTimer.unref();
		}
		if (requestWidgetRender) {
			requestWidgetRender();
			return;
		}
		ctx.ui.setWidget("parallel-tasks", (tui, theme) => {
			requestWidgetRender = () => tui.requestRender();
			return {
				render(width: number): string[] {
					return taskWidgetLines([...activeBatches.values()].flat()).map((line, i) => {
						const color = i === 0 || line.startsWith("◉") ? "accent" : line.startsWith("✓") ? "success" : line.startsWith("✗") ? "error" : "dim";
						return truncateToWidth(theme.fg(color, line), width, theme.fg("dim", "…"));
					});
				},
				invalidate() {},
			};
		}, { placement: "aboveEditor" });
	}

	function resetSession(ctx: ExtensionContext): void {
		generation++;
		activeBatches.clear();
		lastResults = [];
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		updateWidget(ctx);
	}
	pi.on("session_start", (_event, ctx) => resetSession(ctx));
	pi.on("session_shutdown", (_event, ctx) => resetSession(ctx));

	pi.registerCommand("parallel-results", {
		description: "在 TUI 中查看本次会话最近一批并行子任务的状态与完整结果",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			const results = lastResults;
			if (!results.length) {
				ctx.ui.notify("本次会话尚无已完成的并行子任务", "info");
				return;
			}
			const labels = results.map((r, i) => `${i + 1}. ${taskState(r)} [${compact(r.label, 24)}] ${compact(r.task, 54)}`);
			const picked = await ctx.ui.select("最近一次并行任务 · 选择查看详情", labels);
			const index = labels.indexOf(picked ?? "");
			if (index < 0) return;
			const r = results[index];
			const body = stripTerminalSequences(taskDetailText(r));
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const content = new Text(body, 0, 0);
				let scroll = 0;
				return {
					render(width: number): string[] {
						const visible = Math.max(3, tui.terminal.rows - 7);
						const lines = content.render(width);
						scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - visible)));
						return [
							truncateToWidth(theme.fg("accent", `[${compact(r.label, 40)}] ${taskState(r)} · ${scroll + 1}-${Math.min(scroll + visible, lines.length)}/${lines.length}`), width),
							...lines.slice(scroll, scroll + visible),
							truncateToWidth(theme.fg("dim", "↑/↓ 滚动 · PgUp/PgDn 翻页 · Esc 关闭"), width),
						];
					},
					invalidate: () => content.invalidate(),
					handleInput(data: string) {
						if (matchesKey(data, "escape") || data === "q") return done(undefined);
						if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
						else if (matchesKey(data, "down")) scroll++;
						else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - 15);
						else if (matchesKey(data, "pageDown")) scroll += 15;
						else return;
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.registerCommand("parallel-roles", {
		description: "列出 parallel_tasks 可用的子任务角色",
		handler: async (_args, ctx) => {
			const text =
				roles.length > 0
					? roles.map((r) => `${r.name} (${r.model ?? "default"}): ${r.description}`).join("\n")
					: `未找到角色定义，检查 ${ROLES_DIR}`;
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerTool({
		name: "parallel_tasks",
		label: "Parallel Tasks",
		description:
			"把多个互相独立的子任务并行派发到隔离的子进程中执行，全部完成后返回汇总结果供当前会话整合。" +
			"只读角色（probe / analyst / verifier / reviewer）用于调研、定位、核验、审查；implementer 角色在隔离的 git worktree 中编写代码并返回 diff，由主会话审查后合并。" +
			`可用角色：${roles.map((r) => `${r.name} — ${r.description}`).join("；") || "无"}`,
		promptSnippet: "并行执行多个互相独立的子任务（调研或隔离编码），返回汇总结果供整合",
		promptGuidelines: [
			"当用户要求同时处理多件互不依赖的事，或一个任务可拆成 2 个以上互不依赖的子问题时，优先用 parallel_tasks 并行分发。",
			"只读角色（probe / analyst / verifier / reviewer）用于调研、定位、核验、审查，子任务不能改文件；拿到汇总结果后由你自己整合落地。",
			"implementer 角色在隔离的 git worktree 中写代码并产出 diff，用它分发互不依赖、可独立完成的编码子任务；diff 由你审查后应用到当前工作区。",
			"子任务之间不共享上下文，每个 task 描述必须自包含，写清楚范围、目标文件和判断标准。",
			"任务之间存在先后依赖时不要用 parallel_tasks，直接顺序处理。",
		],
		parameters: Type.Object({
			maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY, description: `本批最大并发数，默认 ${MAX_CONCURRENCY}` })),
			tasks: Type.Array(
				Type.Object({
					role: roleNames.length > 0 ? StringEnum(roleNames as any) : Type.String(),
					task: Type.String({ description: "自包含的子任务描述，必须能脱离当前会话上下文独立理解" }),
					label: Type.Optional(Type.String({ description: "简短标识，用于结果展示" })),
				}),
				{ description: `互不依赖的并行子任务，最多 ${MAX_TASKS} 个` },
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (roles.length === 0) {
				return {
					content: [{ type: "text", text: `未找到任何角色定义，检查 ${ROLES_DIR}` }],
					details: { results: [], running: 0 } as Details,
					isError: true,
				};
			}
			if (params.tasks.length === 0) {
				return {
					content: [{ type: "text", text: "tasks 为空。" }],
					details: { results: [], running: 0 } as Details,
					isError: true,
				};
			}
			if (params.tasks.length > MAX_TASKS) {
				return {
					content: [{ type: "text", text: `子任务数量 ${params.tasks.length} 超过上限 ${MAX_TASKS}。` }],
					details: { results: [], running: 0 } as Details,
					isError: true,
				};
			}

			const unknown = params.tasks.map((t) => t.role).filter((r) => !roleNames.includes(r));
			if (unknown.length > 0) {
				return {
					content: [{ type: "text", text: `未知角色：${unknown.join(", ")}。可用：${roleNames.join(", ")}` }],
					details: { results: [], running: 0 } as Details,
					isError: true,
				};
			}

			const batch = Symbol("parallel-tasks");
			const batchGeneration = generation;
			const emit = (live: readonly TaskResult[]) => {
				if (batchGeneration !== generation) return;
				activeBatches.set(batch, live);
				updateWidget(ctx);
				const running = live.filter((r) => r.status !== "finished").length;
				const details = { results: [...live], running } as Details;
				const active = live.filter((r) => r.status === "running");
				const activeText = active.length
					? `\n正在执行：${oneLine(
						active
							.map((r) => `[${r.label}] ${r.task}${r.currentAction ? `（${r.currentAction}）` : ""}`)
							.join("；"),
						240,
					)}`
					: "";
				onUpdate?.({
					content: [{ type: "text", text: `并行执行中：${live.length - running}/${live.length} 完成${activeText}` }],
					details,
				});
				pi.events.emit("operations-deck:tasks", details);
			};

			let results: TaskResult[];
			try {
				results = await dispatchTasks(
					roles,
					params.tasks.map((t) => ({ role: t.role, task: t.task, label: t.label })),
					{
						cwd: ctx.cwd,
						fallbackProvider: ctx.model?.provider,
						signal,
						maxConcurrency: params.maxConcurrency,
						onProgress: emit,
					},
				);
			} finally {
				if (batchGeneration === generation) {
					activeBatches.delete(batch);
					updateWidget(ctx);
				}
			}
			if (batchGeneration === generation) lastResults = results;
			const anyOk = results.some((r) => !failed(r));
			return {
				content: [{ type: "text", text: buildIntegration(results) }],
				details: { results, running: 0 } as Details,
				isError: !anyOk,
			};
		},

		renderCall(args, theme) {
			const tasks = args.tasks ?? [];
			let text =
				theme.fg("toolTitle", theme.bold("parallel_tasks ")) + theme.fg("accent", `${tasks.length} 个并行子任务 · 并发 ${args.maxConcurrency ?? MAX_CONCURRENCY}`);
			for (const t of tasks.slice(0, 4)) {
				const preview = t.task.length > 50 ? `${t.task.slice(0, 50)}...` : t.task;
				text += `\n  ${theme.fg("accent", t.role)}${theme.fg("dim", ` ${preview}`)}`;
			}
			if (tasks.length > 4) text += `\n  ${theme.fg("muted", `... 另外 ${tasks.length - 4} 个`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as Details | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(无输出)", 0, 0);
			}

			const status =
				details.running > 0
					? `${details.results.filter((r) => r.status === "finished").length}/${details.results.length} 已结束，${details.results.filter((r) => r.status === "running").length} 运行，${details.results.filter((r) => r.status === "queued").length} 排队`
					: `${details.results.filter((r) => !failed(r)).length}/${details.results.length} 成功`;

			const active = details.results.filter((r) => r.status === "running");
			const container = new Container();
			container.addChild(
				new Text(theme.fg("toolTitle", theme.bold("parallel_tasks ")) + theme.fg("accent", status), 0, 0),
			);
			if (active.length > 0) {
				const current = active
					.map((r) => `[${r.label}] ${r.task}${r.currentAction ? `（${r.currentAction}）` : ""}`)
					.join("；");
				container.addChild(new Text(theme.fg("muted", `正在执行：${oneLine(current, 240)}`), 0, 0));
			}

			for (const r of details.results) {
				const icon = r.status === "queued" ? theme.fg("muted", "◦") : r.status === "running" ? theme.fg("accent", "◉") : failed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const stats = [
					r.usage.turns > 0 ? `${r.usage.turns}轮` : "",
					r.toolCalls > 0 ? `${r.toolCalls}次工具` : "",
					r.changedFiles && r.changedFiles.length > 0 ? `${r.changedFiles.length}文件` : "",
					r.usage.cost > 0 ? `$${r.usage.cost.toFixed(4)}` : "",
					r.durationMs > 0 ? `${(r.durationMs / 1000).toFixed(1)}s` : "",
				]
					.filter(Boolean)
					.join(" ");

				container.addChild(
					new Text(
						`${icon} ${theme.fg("accent", `[${compact(r.label, 24)}] ${compact(r.role, 18)}`)} ${theme.fg("muted", stats)}${r.status === "running" && r.currentAction ? `\n  ${theme.fg("dim", compact(r.currentAction, 88))}` : ""}`,
						0,
						0,
					),
				);

				if (expanded) {
					container.addChild(new Text(theme.fg("dim", `  ${r.task}`), 0, 0));
					const body = failed(r) ? r.errorMessage || r.stderr.trim() || r.output : r.output;
					if (body) container.addChild(new Markdown(body, 2, 0, getMarkdownTheme()));
				} else if (r.output && r.status === "finished") {
					const line = r.output.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
					if (line) container.addChild(new Text(theme.fg("toolOutput", `  ${compact(line, 100)}`), 0, 0));
				}
			}

			return container;
		},
	});
}
