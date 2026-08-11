import type { ExecutionState, PlanSpec, PlanStepSpec, StepExecutionState } from "./domain.ts";

const MAX_STEP_TITLE_CODEPOINTS = 56;

export function truncateStepTitle(title: string, limit = MAX_STEP_TITLE_CODEPOINTS): string {
	if (limit <= 0) return "";
	const codepoints = Array.from(title.trim());
	if (codepoints.length <= limit) return codepoints.join("");
	if (limit === 1) return "…";
	return `${codepoints.slice(0, limit - 1).join("")}…`;
}

export function formatWorkspaceBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 ** 2) return `${formatUnit(bytes / 1024)} KiB`;
	if (bytes < 1024 ** 3) return `${formatUnit(bytes / 1024 ** 2)} MiB`;
	return `${formatUnit(bytes / 1024 ** 3)} GiB`;
}

function formatUnit(value: number): string {
	return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value).toString();
}

function stepMarker(stepState: StepExecutionState | undefined): string {
	if (stepState?.status === "verified") return "✓";
	if (stepState?.status === "failed") return "!";
	if (stepState?.status === "running") return "▶";
	return "○";
}

function displayStep(spec: PlanSpec, state: ExecutionState): PlanStepSpec | undefined {
	if (state.currentStepId) {
		const current = spec.steps.find((step) => step.id === state.currentStepId);
		if (current) return current;
	}
	return spec.steps.find((step) => state.steps[step.id]?.status !== "verified");
}

/** Build the single authoritative Plan Mode widget row; terminal fitting happens in index.ts. */
export function buildPlanProgressSummary(spec: PlanSpec | undefined, state: ExecutionState): string | undefined {
	if (!spec) return undefined;
	const total = spec.steps.length;
	const verified = spec.steps.filter((step) => state.steps[step.id]?.status === "verified").length;
	const evidence = spec.steps.reduce((sum, step) => sum + (state.steps[step.id]?.evidenceIds.length ?? 0), 0);
	const current = displayStep(spec, state);
	const progress = `${verified}/${total}`;
	const step = current
		? `${stepMarker(state.steps[current.id])} ${current.id} ${truncateStepTitle(current.title)}`
		: total === 0
			? "no steps"
			: "✓ complete";
	const workspace = spec.workspaceSnapshot
		? `ws ${spec.workspaceSnapshot.entries.length}/${formatWorkspaceBytes(spec.workspaceSnapshot.totalBytes)}`
		: undefined;
	return [progress, step, `ev ${evidence}`, workspace].filter(Boolean).join(" · ");
}

/** Build a compact multi-line Todo tree while keeping the current step visible for long plans. */
export function buildPlanProgressLines(
	spec: PlanSpec | undefined,
	state: ExecutionState,
	maxVisibleSteps = 12,
): string[] | undefined {
	if (!spec) return undefined;
	const total = spec.steps.length;
	const completed = spec.steps.filter((step) => state.steps[step.id]?.status === "verified").length;
	const inProgress = spec.steps.filter((step) => state.steps[step.id]?.status === "running").length;
	const failed = spec.steps.filter((step) => state.steps[step.id]?.status === "failed").length;
	const pending = Math.max(0, total - completed - inProgress - failed);
	const counts = [`${completed}/${total} completed`, `${inProgress} in progress`, `${pending} pending`];
	if (failed > 0) counts.push(`${failed} failed`);
	const header = `Todos — ${counts.join(" · ")}`;
	if (total === 0) return [header];

	const limit = Math.max(1, Math.floor(maxVisibleSteps));
	const currentIndex = Math.max(0, spec.steps.findIndex((step) => step.id === state.currentStepId));
	const start = total <= limit ? 0 : Math.min(Math.max(0, currentIndex - 2), total - limit);
	const end = Math.min(total, start + limit);
	const entries: string[] = [];
	if (start > 0) entries.push(`… ${start} earlier step${start === 1 ? "" : "s"}`);
	for (const step of spec.steps.slice(start, end)) {
		entries.push(`${stepMarker(state.steps[step.id])} #${step.id} ${truncateStepTitle(step.title)}`);
	}
	if (end < total) entries.push(`… ${total - end} later step${total - end === 1 ? "" : "s"}`);
	return [header, ...entries.map((entry, index) => `${index === entries.length - 1 ? "└─" : "├─"} ${entry}`)];
}
