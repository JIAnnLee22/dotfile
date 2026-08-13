/**
 * Operations Deck - 入口
 *
 * 事件聚合 + 自适应 widget + /deck 命令 + Ctrl+Alt+D 快捷键。
 * 布局与格式化全部委托给 layout.ts（纯函数），本文件只做状态维护。
 *
 * 数据源：
 * - MAIN：agent/turn/tool 生命周期事件 + 会话 usage 统计
 * - PLAN：S4 通过 scanPlanState 扫描 plan-mode/audit entries（本文件导出）
 * - AGENTS：S4 通过 scanParallelTasks 扫描 parallel_tasks toolResult（本文件导出）
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { adaptiveHeight, buildDeckLines } from "./layout.ts";
import type { AgentRow, DeckMode, DeckSnapshot, MainStatus, ModelInfo, PlanStatus, PlanStepView, PlanSummary } from "./types.ts";

const WIDGET_NAME = "operations-deck";
const PLAN_WIDGET_NAME = "plan-mode";
const AUDIT_ENTRY_TYPE = "plan-mode/audit";
const AUDIT_SCHEMA = "dev.pi.plan-audit/v1";
const STATE_SCHEMA = "dev.pi.plan-state/v1";
const PLAN_SCHEMA = "dev.pi.plan/v1";

interface PlanStateLike {
	readonly schema?: string;
	readonly status?: string;
	readonly epoch?: number;
	readonly planRef?: { planId?: string; version?: number; contentHash?: string };
	readonly currentStepId?: string;
	readonly steps?: Readonly<Record<string, { status?: string; evidenceIds?: readonly string[] }>>;
	readonly reason?: string;
	readonly securityLevel?: string;
}

interface AuditEventLike {
	readonly schema?: string;
	readonly action?: string;
	readonly state?: PlanStateLike;
}

interface TaskResultLike {
	readonly role?: string;
	readonly label?: string;
	readonly exitCode?: number;
	readonly toolCalls?: number;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly model?: string;
	readonly usage?: { turns?: number; cost?: number };
	readonly durationMs?: number;
}

interface TaskDetailsLike {
	readonly results?: readonly TaskResultLike[];
	readonly running?: number;
}

interface PlanSpecLike {
	readonly schema?: string;
	readonly goal?: string;
	readonly steps?: readonly { id?: string; title?: string }[];
	readonly safetyLevel?: string;
}

function isPlanState(value: unknown): value is PlanStateLike {
	if (!value || typeof value !== "object") return false;
	const v = value as PlanStateLike;
	return v.schema === STATE_SCHEMA && typeof v.status === "string" && Number.isInteger(v.epoch);
}

/** 从 branch custom entries 扫描最后一条 state-committed 的 ExecutionState。 */
export function scanPlanState(entries: readonly unknown[]): { state?: PlanStateLike; available: boolean } {
	let last: PlanStateLike | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string; customType?: string; data?: unknown };
		if (e.type !== "custom" || e.customType !== AUDIT_ENTRY_TYPE) continue;
		const data = e.data as AuditEventLike | undefined;
		if (!data || data.schema !== AUDIT_SCHEMA || data.action !== "state-committed") continue;
		if (isPlanState(data.state)) last = data.state;
	}
	return { state: last, available: last !== undefined };
}

const STEP_STATUS_MAP: Record<string, PlanStepView["status"]> = {
	pending: "pending",
	running: "running",
	verified: "verified",
	failed: "failed",
};

function stepViewFromState(state: PlanStateLike, id: string, title: string): PlanStepView {
	const s = state.steps?.[id];
	return { id, title: title || id, status: STEP_STATUS_MAP[s?.status ?? "pending"] ?? "pending" };
}

/** 由 ExecutionState（+可选 spec）构建 PlanSummary。 */
export function planSummaryFromState(
	state: PlanStateLike | undefined,
	spec?: PlanSpecLike | null,
): PlanSummary {
	if (!state) {
		return { available: false, stepCount: 0, verified: 0, running: 0, failed: 0, evidence: 0 };
	}
	const stepIds = Object.keys(state.steps ?? {});
	const specSteps = spec?.steps;
	const steps: PlanStepView[] =
		specSteps && specSteps.length > 0
			? specSteps.map((s) => stepViewFromState(state, s.id ?? "", s.title ?? ""))
			: stepIds.map((id) => stepViewFromState(state, id, id));
	const verified = steps.filter((s) => s.status === "verified").length;
	const running = steps.filter((s) => s.status === "running").length;
	const failed = steps.filter((s) => s.status === "failed").length;
	const evidence = stepIds.reduce((sum, id) => sum + (state.steps?.[id]?.evidenceIds?.length ?? 0), 0);
	const currentStep = state.currentStepId
		? steps.find((s) => s.id === state.currentStepId)
		: undefined;
	return {
		available: true,
		status: state.status as PlanStatus,
		stepCount: steps.length,
		verified,
		running,
		failed,
		evidence,
		currentStep,
		steps,
		safetyLevel: state.securityLevel ?? spec?.safetyLevel,
		reason: state.reason,
	};
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;

/** 按 artifact-store 目录约定读取 PlanSpec；失败返回 undefined（调用方降级）。 */
export async function loadPlanSpec(cwd: string, state: PlanStateLike | undefined): Promise<PlanSpecLike | undefined> {
	const ref = state?.planRef;
	if (!ref?.planId || !Number.isInteger(ref.version) || ref.version < 1 || !SAFE_ID.test(ref.planId)) {
		return undefined;
	}
	const projectId = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
	const dir = path.join(os.homedir(), ".pi", "agent", "plans", projectId, ref.planId, `v${String(ref.version).padStart(4, "0")}`);
	try {
		const raw = await readFile(path.join(dir, "spec.json"), "utf8");
		const spec = JSON.parse(raw) as PlanSpecLike;
		if (spec.schema !== PLAN_SCHEMA || !Array.isArray(spec.steps)) return undefined;
		return spec;
	} catch {
		return undefined;
	}
}

function taskStatus(r: TaskResultLike, runningCount: number): AgentRow["status"] {
	if (runningCount > 0 && (r.exitCode ?? 0) === -1) return "running";
	if (r.exitCode !== undefined && r.exitCode !== 0) {
		return r.stopReason === "aborted" ? "aborted" : "failed";
	}
	if (r.stopReason === "aborted") return "aborted";
	if (r.stopReason === "error") return "failed";
	return "succeeded";
}

function toAgentRow(r: TaskResultLike, runningCount: number): AgentRow {
	return {
		label: r.label ?? "?",
		role: r.role ?? "?",
		status: taskStatus(r, runningCount),
		model: r.model,
		turns: r.usage?.turns,
		toolCalls: r.toolCalls,
		elapsedMs: r.durationMs,
		cost: r.usage?.cost,
		error: r.errorMessage ? Array.from(r.errorMessage).slice(0, 80).join("") : undefined,
	};
}

/** 从 branch toolResult 消息扫描最后一次 parallel_tasks 的 details。 */
export function scanParallelTasks(entries: readonly unknown[]): AgentRow[] {
	let details: TaskDetailsLike | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type !== "message") continue;
		const m = e.message;
		if (m?.role !== "toolResult" || m.toolName !== "parallel_tasks") continue;
		const d = m.details as TaskDetailsLike | undefined;
		if (d?.results && d.results.length > 0) details = d;
	}
	if (!details?.results) return [];
	const running = details.running ?? 0;
	return details.results.map((r) => toAgentRow(r, running));
}

function toAgentRows(details: TaskDetailsLike | undefined): AgentRow[] {
	if (!details?.results) return [];
	return details.results.map((r) => toAgentRow(r, details.running ?? 0));
}

interface UsageLike {
	readonly input?: number;
	readonly output?: number;
	readonly cost?: { readonly total?: number };
}

function usageFromEntry(entry: unknown): UsageLike | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as {
		type?: string;
		message?: { role?: string; usage?: UsageLike };
		usage?: UsageLike;
	};
	if (record.type === "message") {
		const role = record.message?.role;
		return role === "assistant" || role === "toolResult" ? record.message?.usage : undefined;
	}
	return record.type === "compaction" || record.type === "branch_summary" ? record.usage : undefined;
}

/** 会话累计 usage：input/output/cost（与 dense-ui footer 同源逻辑）。 */
export function collectUsage(ctx: ExtensionContext): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		const usage = usageFromEntry(entry);
		input += usage?.input ?? 0;
		output += usage?.output ?? 0;
		cost += usage?.cost?.total ?? 0;
	}
	return { input, output, cost };
}

export function emptySnapshot(): DeckSnapshot {
	return {
		main: { busy: false, turn: 0, elapsedMs: 0 },
		plan: { available: false, stepCount: 0, verified: 0, running: 0, failed: 0, evidence: 0 },
		agents: [],
		model: {},
		updatedAt: Date.now(),
	};
}

/** 把 layout 纯文本行按行首状态符号着色；ANSI 安全截断由调用方负责。 */
export function styleLine(line: string, theme: { fg: (color: string, text: string) => string }): string {
	const first = Array.from(line)[0] ?? "";
	switch (first) {
		case "●":
			return theme.fg("accent", "●") + theme.fg("muted", line.slice(1));
		case "○":
			return theme.fg("dim", "○") + theme.fg("muted", line.slice(1));
		case "▶":
			return theme.fg("accent", "▶") + theme.fg("text", line.slice(1));
		case "✓":
			return theme.fg("success", "✓") + theme.fg("dim", line.slice(1));
		case "!":
			return theme.fg("error", "!") + theme.fg("warning", line.slice(1));
		case "×":
			return theme.fg("error", "×") + theme.fg("warning", line.slice(1));
		case "…":
			return theme.fg("dim", line);
		default:
			if (line.startsWith("PLAN ")) return theme.fg("warning", line);
			if (line.startsWith("AGENTS ")) return theme.fg("muted", line);
			if (line.startsWith("Goal ")) return theme.fg("dim", line);
			return theme.fg("text", line);
	}
}

export default function (pi: ExtensionAPI) {
	let mode: DeckMode = "full";
	let snapshot: DeckSnapshot = emptySnapshot();
	let lastGoal = "";
	let turnStartedAt = 0;
	let clearedPlanWidget = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let planListener: (() => void) | undefined;
	let tasksListener: (() => void) | undefined;

	function emitMode(): void {
		pi.events.emit("operations-deck:mode", { mode });
	}

	function updateMain(patch: Partial<MainStatus>): void {
		snapshot = { ...snapshot, main: { ...snapshot.main, ...patch }, updatedAt: Date.now() };
	}

	function updateModel(model: Partial<ModelInfo>): void {
		snapshot = { ...snapshot, model: { ...snapshot.model, ...model }, updatedAt: Date.now() };
	}

	function refreshModelFromCtx(ctx: ExtensionContext): void {
		const usage = collectUsage(ctx);
		const context = ctx.getContextUsage();
		updateModel({
			provider: ctx.model?.provider,
			id: ctx.model?.id,
			thinking: ctx.model?.reasoning ? ctx.thinkingLevel : undefined,
			contextPercent: context && context.percent !== null && context.percent !== undefined ? context.percent : null,
			inputTokens: usage.input,
			outputTokens: usage.output,
			cost: usage.cost,
		});
	}

	function refreshGoalFromEntries(ctx: ExtensionContext): void {
		if (snapshot.plan.available && snapshot.plan.status && snapshot.plan.status !== "inactive") {
			// PLAN goal 在 S4 由 spec 注入；此处不覆盖。
			return;
		}
		if (lastGoal) {
			updateMain({ goal: lastGoal });
			return;
		}
		// 兜底：最近一条用户消息首行。
		for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
			if (entry.type !== "message" || !("message" in entry)) continue;
			const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
			if (msg?.role !== "user") continue;
			const content = msg.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
								.join(" ")
						: "";
			const line = text.split("\n").find((l) => l.trim()) ?? "";
			if (line.trim()) {
				updateMain({ goal: Array.from(line.trim()).slice(0, 120).join("") });
				return;
			}
		}
	}

	function startElapsedTimer(ctx: ExtensionContext): void {
		stopElapsedTimer();
		timer = setInterval(() => {
			if (!snapshot.main.busy) return;
			updateMain({ elapsedMs: turnStartedAt > 0 ? Date.now() - turnStartedAt : 0 });
			applyWidget(ctx);
		}, 1000);
	}

	function stopElapsedTimer(): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	function applyWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		// full 模式接管：清掉 plan-mode 的独立 widget；其余模式通知其恢复（S4 接入监听）。
		if (mode === "full") {
			if (!clearedPlanWidget) {
				ctx.ui.setWidget(PLAN_WIDGET_NAME, undefined);
				clearedPlanWidget = true;
			}
		} else if (clearedPlanWidget) {
			emitMode();
			clearedPlanWidget = false;
		}

		if (mode === "hidden") {
			ctx.ui.setWidget(WIDGET_NAME, undefined);
			return;
		}

		ctx.ui.setWidget(WIDGET_NAME, (tui, theme) => ({
			render(width: number): string[] {
				const height = adaptiveHeight(tui.terminal.rows);
				const lines = buildDeckLines(snapshot, width, mode, height);
				return lines.map((line) => truncateToWidth(styleLine(line, theme), width, theme.fg("dim", "…")));
			},
			invalidate() {},
		}));
	}

	function updateUI(ctx: ExtensionContext): void {
		refreshModelFromCtx(ctx);
		refreshGoalFromEntries(ctx);
		applyWidget(ctx);
	}

	function cycleMode(): DeckMode {
		return mode === "full" ? "compact" : mode === "compact" ? "hidden" : "full";
	}

	pi.registerCommand("deck", {
		description: "Operations Deck 视图：/deck [next|full|compact|hidden]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const next: DeckMode =
				arg === "full" ? "full" : arg === "compact" ? "compact" : arg === "hidden" ? "hidden" : cycleMode();
			mode = next;
			emitMode();
			updateUI(ctx);
			ctx.ui.notify(`Operations Deck: ${mode}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "切换 Operations Deck 视图（full/compact/hidden）",
		handler: async (ctx) => {
			mode = cycleMode();
			emitMode();
			updateUI(ctx);
			ctx.ui.notify(`Operations Deck: ${mode}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		snapshot = emptySnapshot();
		mode = "full";
		clearedPlanWidget = false;
		lastGoal = "";
		updateUI(ctx);
	});

	pi.on("session_shutdown", () => {
		stopElapsedTimer();
	});

	pi.on("agent_start", (_event, ctx) => {
		turnStartedAt = Date.now();
		updateMain({ busy: true, elapsedMs: 0 });
		startElapsedTimer(ctx);
		applyWidget(ctx);
	});

	pi.on("agent_end", () => {
		stopElapsedTimer();
		if (turnStartedAt > 0) updateMain({ elapsedMs: Date.now() - turnStartedAt });
	});

	pi.on("agent_settled", (_event, ctx) => {
		updateMain({ busy: false });
		applyWidget(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		updateMain({ turn: snapshot.main.turn + 1 });
		applyWidget(ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		updateMain({ currentTool: event.toolName });
		applyWidget(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (snapshot.main.currentTool === event.toolName) updateMain({ currentTool: undefined });
		applyWidget(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		refreshModelFromCtx(ctx);
		applyWidget(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		refreshModelFromCtx(ctx);
		applyWidget(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		applyWidget(ctx);
	});

	pi.on("input", (event, ctx) => {
		const text = event.text?.trim();
		if (text && !text.startsWith("/")) {
			lastGoal = Array.from(text).slice(0, 120).join("");
			updateMain({ goal: lastGoal });
			applyWidget(ctx);
		}
	});
}

