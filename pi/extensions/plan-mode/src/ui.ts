import type { ExecutionState, PlanSpec, PlanStepSpec, StepExecutionState } from "./domain.ts";

const MAX_STEP_TITLE_CODEPOINTS = 64;

export function truncateStepTitle(title: string, limit = MAX_STEP_TITLE_CODEPOINTS): string {
	if (limit <= 0) return "";
	const codepoints = Array.from(title.trim());
	if (codepoints.length <= limit) return codepoints.join("");
	if (limit === 1) return "…";
	return `${codepoints.slice(0, limit - 1).join("")}…`;
}

function stepMarker(stepState: StepExecutionState | undefined): string {
	if (stepState?.status === "completed") return "✓";
	if (stepState?.status === "failed") return "!";
	if (stepState?.status === "running") return "▶";
	return "○";
}

function displayStep(spec: PlanSpec, state: ExecutionState): PlanStepSpec | undefined {
	if (state.currentStepId) {
		const current = spec.steps.find((step) => step.id === state.currentStepId);
		if (current) return current;
	}
	return spec.steps.find((step) => state.steps[step.id]?.status !== "completed");
}

export function buildPlanProgressSummary(spec: PlanSpec | undefined, state: ExecutionState): string | undefined {
	if (!spec) return undefined;
	const total = spec.steps.length;
	const completed = spec.steps.filter((step) => state.steps[step.id]?.status === "completed").length;
	const evidence = spec.steps.reduce((sum, step) => sum + (state.steps[step.id]?.evidenceIds.length ?? 0), 0);
	const current = displayStep(spec, state);
	const step = current ? `${stepMarker(state.steps[current.id])} ${current.id} ${truncateStepTitle(current.title)}` : "✓ complete";
	return `${completed}/${total} · ${step} · reports ${state.stepRevision} · evidence ${evidence}`;
}

export function buildPlanProgressLines(spec: PlanSpec | undefined, state: ExecutionState, maxVisibleSteps = 12): string[] | undefined {
	if (!spec) return undefined;
	const total = spec.steps.length;
	const completed = spec.steps.filter((step) => state.steps[step.id]?.status === "completed").length;
	const inProgress = spec.steps.filter((step) => state.steps[step.id]?.status === "running").length;
	const failed = spec.steps.filter((step) => state.steps[step.id]?.status === "failed").length;
	const pending = Math.max(0, total - completed - inProgress - failed);
	const counts = [`${completed}/${total} completed`, `${inProgress} in progress`, `${pending} pending`];
	if (failed > 0) counts.push(`${failed} failed`);
	const header = `Plan · ${state.status} · ${counts.join(" · ")}`;
	if (total === 0) return [header];

	const limit = Math.max(1, Math.floor(maxVisibleSteps));
	const foundIndex = spec.steps.findIndex((step) => step.id === state.currentStepId);
	const currentIndex = foundIndex >= 0 ? foundIndex : Math.max(0, spec.steps.findIndex((step) => state.steps[step.id]?.status !== "completed"));
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
