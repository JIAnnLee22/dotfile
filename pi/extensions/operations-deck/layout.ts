/**
 * Operations Deck - 纯函数布局
 *
 * 所有函数无副作用、不依赖 TUI 运行时，可独立单测。
 * 颜色与主题由 index.ts 在渲染时叠加；本模块只输出纯文本行。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRow, DeckMode, DeckSnapshot, PlanStepView, PlanSummary } from "./types.ts";

export const MIN_DECK_HEIGHT = 6;
export const MAX_DECK_HEIGHT = 12;

/** 按终端高度分段：<30 → 6，30-39 → 8，40-49 → 10，>=50 → 12。 */
export function adaptiveHeight(rows: number): number {
	if (!Number.isFinite(rows) || rows <= 0) return MIN_DECK_HEIGHT;
	if (rows < 30) return 6;
	if (rows < 40) return 8;
	if (rows < 50) return 10;
	return 12;
}

export function clampHeight(height: number): number {
	if (!Number.isFinite(height)) return MIN_DECK_HEIGHT;
	return Math.min(MAX_DECK_HEIGHT, Math.max(MIN_DECK_HEIGHT, Math.floor(height)));
}

export function formatElapsed(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "0:00";
	const total = Math.floor(ms / 1000);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatTokens(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatCost(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

function truncate(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "…");
}

/** 把左段与右段压到一行：优先保留左段，右段可裁减。 */
export function fitLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (width === 1) return truncate(left, 1);
	let safeLeft = left || " ";
	let safeRight = right || "";
	while (visibleWidth(safeLeft) + 1 + visibleWidth(safeRight) > width && safeRight) {
		safeRight = truncate(safeRight, Math.max(0, visibleWidth(safeRight) - 1));
	}
	while (visibleWidth(safeLeft) + 1 + visibleWidth(safeRight) > width && visibleWidth(safeLeft) > 4) {
		safeLeft = truncate(safeLeft, Math.max(0, visibleWidth(safeLeft) - 1));
	}
	const gap = Math.max(1, width - visibleWidth(safeLeft) - visibleWidth(safeRight));
	return safeLeft + " ".repeat(gap) + safeRight;
}

export function modelText(model: DeckSnapshot["model"], wide: boolean): string {
	const id = model.id ? `${model.provider ? `${model.provider}/` : ""}${model.id}` : "no-model";
	const parts: string[] = [id];
	if (model.thinking && model.thinking !== "off") parts.push(model.thinking);
	if (model.contextPercent !== null && model.contextPercent !== undefined) {
		parts.push(`ctx ${Math.round(model.contextPercent)}%`);
	}
	if (wide) {
		const tokens = [
			formatTokens(model.inputTokens) && `↑${formatTokens(model.inputTokens)}`,
			formatTokens(model.outputTokens) && `↓${formatTokens(model.outputTokens)}`,
			formatCost(model.cost),
		].filter(Boolean);
		if (tokens.length > 0) parts.push(tokens.join(" "));
	}
	return parts.join(" · ");
}

function mainLine(snapshot: DeckSnapshot, width: number, wide: boolean): string {
	const main = snapshot.main;
	const dot = main.busy ? "●" : "○";
	const parts = [`${dot} ${main.busy ? "RUNNING" : "IDLE"}`];
	if (main.turn > 0) parts.push(`turn ${main.turn}`);
	if (main.elapsedMs > 0) parts.push(formatElapsed(main.elapsedMs));
	if (main.currentTool) parts.push(main.currentTool);
	if (main.error) parts.push(`! ${main.error}`);
	return fitLine(parts.join(" · "), modelText(snapshot.model, wide), width);
}

function goalLine(snapshot: DeckSnapshot, width: number): string {
	const goal = snapshot.main.goal?.trim();
	if (!goal) return "";
	return truncate(`Goal ${goal}`, width);
}

const PLAN_STATUS_LABEL: Record<string, string> = {
	researching: "RESEARCH",
	awaiting_input: "AWAIT INPUT",
	review: "REVIEW",
	approved: "APPROVED",
	executing: "EXECUTING",
	paused: "PAUSED",
	completed: "COMPLETED",
	stale: "STALE",
	failed: "FAILED",
	rejected: "REJECTED",
	cancelled: "CANCELLED",
	inactive: "INACTIVE",
};

export function planHeaderText(plan: PlanSummary, width: number): string {
	if (!plan.available) return truncate("PLAN unavailable", width);
	const status = plan.status ? (PLAN_STATUS_LABEL[plan.status] ?? plan.status.toUpperCase()) : "?";
	const parts = [`PLAN ${status}`, `${plan.verified}/${plan.stepCount} steps`];
	if (plan.evidence > 0) parts.push(`ev ${plan.evidence}`);
	if (plan.safetyLevel) parts.push(plan.safetyLevel);
	if (plan.reason) parts.push(`! ${plan.reason}`);
	return truncate(parts.join(" · "), width);
}

function stepMarker(step: PlanStepView): string {
	switch (step.status) {
		case "verified":
			return "✓";
		case "running":
			return "▶";
		case "failed":
			return "!";
		default:
			return "○";
	}
}

/** 渲染 Plan 步骤行；预算不足时保留 running/failed，再保留最早 pending。 */
export function planStepLines(plan: PlanSummary, width: number, budget: number): string[] {
	if (!plan.available || !plan.steps || plan.steps.length === 0) return [];
	const ordered = [...plan.steps].sort((a, b) => {
		const rank = (s: PlanStepView): number =>
			s.status === "running" ? 0 : s.status === "failed" ? 1 : s.status === "pending" ? 2 : 3;
		return rank(a) - rank(b);
	});
	const shown = ordered.slice(0, Math.max(0, budget));
	const lines = shown.map((step) =>
		truncate(`${stepMarker(step)} ${step.id} ${step.title}`, width),
	);
	const hidden = plan.steps.length - shown.length;
	if (hidden > 0) lines.push(truncate(`… ${hidden} more steps`, width));
	return lines;
}

function agentStatusIcon(status: AgentRow["status"]): string {
	switch (status) {
		case "running":
			return "●";
		case "succeeded":
			return "✓";
		case "failed":
			return "!";
		case "aborted":
			return "×";
		default:
			return "○";
	}
}

function agentRowText(row: AgentRow, width: number, wide: boolean): string {
	const parts = [`${agentStatusIcon(row.status)} ${row.label}`, row.role];
	if (row.model) parts.push(row.model);
	else parts.push("?");
	const stats: string[] = [];
	if (row.turns !== undefined && row.turns > 0) stats.push(`${row.turns}t`);
	if (row.toolCalls !== undefined && row.toolCalls > 0) stats.push(`${row.toolCalls}tc`);
	if (row.elapsedMs !== undefined && row.elapsedMs > 0) stats.push(formatElapsed(row.elapsedMs));
	if (row.cost !== undefined && row.cost > 0) stats.push(formatCost(row.cost));
	if (stats.length > 0 && wide) parts.push(stats.join(" "));
	if (row.error && (row.status === "failed" || row.status === "aborted")) parts.push(`! ${row.error}`);
	return truncate(parts.join(" "), width);
}

/** agents 排序：running > failed > aborted > queued > succeeded（同组保持原顺序）。 */
export function sortAgents(rows: AgentRow[]): AgentRow[] {
	const rank = (s: AgentRow["status"]): number =>
		s === "running" ? 0 : s === "failed" ? 1 : s === "aborted" ? 2 : s === "queued" ? 3 : 4;
	return [...rows].sort((a, b) => rank(a.status) - rank(b.status));
}

export function agentsHeaderText(rows: AgentRow[]): string {
	if (rows.length === 0) return "AGENTS none";
	const count = (s: AgentRow["status"]) => rows.filter((r) => r.status === s).length;
	const parts: string[] = [];
	if (count("running") > 0) parts.push(`${count("running")}●`);
	if (count("succeeded") > 0) parts.push(`${count("succeeded")}✓`);
	if (count("failed") > 0) parts.push(`${count("failed")}!`);
	if (count("aborted") > 0) parts.push(`${count("aborted")}×`);
	if (count("queued") > 0) parts.push(`${count("queued")}○`);
	return `AGENTS ${parts.join(" ") || "0"}`;
}

export function agentLines(rows: AgentRow[], width: number, budget: number): string[] {
	if (rows.length === 0 || budget <= 0) return [];
	const sorted = sortAgents(rows);
	const wide = width >= 100;
	const lines = sorted.slice(0, budget).map((row) => agentRowText(row, width, wide));
	const hidden = rows.length - Math.min(rows.length, budget);
	if (hidden > 0) lines.push(truncate(`… ${hidden} more`, width));
	return lines;
}

/** compact 模式：固定 3 行。 */
export function compactLines(snapshot: DeckSnapshot, width: number): string[] {
	const plan = snapshot.plan;
	const planLine = plan.available
		? `PLAN ${plan.status ? (PLAN_STATUS_LABEL[plan.status] ?? plan.status.toUpperCase()) : "?"} ${plan.verified}/${plan.stepCount}${plan.currentStep ? ` · ${plan.currentStep.id} ${plan.currentStep.title}` : ""}`
		: "PLAN unavailable";
	const agents = snapshot.agents;
	const running = agents.filter((a) => a.status === "running");
	const agentsLine =
		agents.length === 0
			? "AGENTS none"
			: running.length > 0
				? `AGENTS ${agentsHeaderText(agents)} · ${running.map((a) => a.label).join(", ")}`
				: `AGENTS ${agentsHeaderText(agents)}`;
	return [
		mainLine(snapshot, width, false),
		truncate(planLine, width),
		truncate(agentsLine, width),
	];
}

/** full 模式：按高度预算组装 MAIN/PLAN/AGENTS 分区。 */
export function fullLines(snapshot: DeckSnapshot, width: number, height: number): string[] {
	const h = clampHeight(height);
	const wide = width >= 100;
	const lines: string[] = [mainLine(snapshot, width, wide)];
	let budget = h - 1;
	if (snapshot.main.goal?.trim() && budget > 3) {
		lines.push(goalLine(snapshot, width));
		budget--;
	}
	lines.push(planHeaderText(snapshot.plan, width));
	budget--;
	const planBudget = Math.max(1, Math.floor(budget / 2));
	lines.push(...planStepLines(snapshot.plan, width, planBudget));
	budget -= planBudget;
	if (budget >= 1) {
		lines.push(agentsHeaderText(snapshot.agents));
		budget--;
		if (budget >= 1) lines.push(...agentLines(snapshot.agents, width, budget));
	}
	return lines.slice(0, h);
}

/** 总入口：按模式生成行数组；hidden 返回空。 */
export function buildDeckLines(snapshot: DeckSnapshot, width: number, mode: DeckMode, height: number): string[] {
	if (mode === "hidden") return [];
	const h = clampHeight(height);
	if (mode === "compact") return compactLines(snapshot, width).slice(0, h);
	return fullLines(snapshot, width, h);
}
