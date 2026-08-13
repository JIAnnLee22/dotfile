/**
 * Operations Deck - 共享类型
 *
 * 纯数据契约：index.ts 负责事件聚合，layout.ts 负责纯函数渲染，
 * types.ts 只描述两者之间的快照形状。
 */

export type DeckMode = "full" | "compact" | "hidden";

export interface MainStatus {
	/** 主代理是否正在运行（agent_start..agent_settled）。 */
	busy: boolean;
	/** 本次会话累计 turn 数。 */
	turn: number;
	/** 当前回合已运行时长（ms）。 */
	elapsedMs: number;
	/** 当前正在执行的工具名（如 read / bash / parallel_tasks）。 */
	currentTool?: string;
	/** 主目标文本（优先 plan goal，其次最近用户消息）。 */
	goal?: string;
	/** 主任务级错误/阻塞提示。 */
	error?: string;
}

export type PlanStatus =
	| "inactive"
	| "researching"
	| "awaiting_input"
	| "review"
	| "approved"
	| "executing"
	| "paused"
	| "completed"
	| "rejected"
	| "cancelled"
	| "stale"
	| "failed";

export type PlanStepViewStatus = "pending" | "running" | "verified" | "failed";

export interface PlanStepView {
	id: string;
	title: string;
	status: PlanStepViewStatus;
}

export interface PlanSummary {
	/** 是否有可用的 Plan 状态源（audit entries 缺失时为 false）。 */
	available: boolean;
	status?: PlanStatus;
	stepCount: number;
	verified: number;
	running: number;
	failed: number;
	evidence: number;
	currentStep?: PlanStepView;
	steps?: PlanStepView[];
	safetyLevel?: string;
	/** paused/stale/failed 等状态的原因。 */
	reason?: string;
}

export type AgentStatus = "queued" | "running" | "succeeded" | "failed" | "aborted";

export interface AgentRow {
	label: string;
	role: string;
	status: AgentStatus;
	/** 实际模型（parallel_tasks 的 TaskResult.model 可能缺失）。 */
	model?: string;
	turns?: number;
	toolCalls?: number;
	elapsedMs?: number;
	cost?: number;
	/** 失败/中止原因。 */
	error?: string;
}

export interface ModelInfo {
	provider?: string;
	id?: string;
	thinking?: string;
	/** 上下文占用百分比，未知为 null。 */
	contextPercent?: number | null;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

export interface DeckSnapshot {
	main: MainStatus;
	plan: PlanSummary;
	agents: AgentRow[];
	model: ModelInfo;
	updatedAt: number;
}
