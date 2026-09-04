import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanSpec, ReviewDecision } from "./domain.ts";
import { MANDATORY_IMPLEMENTATION_TOOLS } from "./tool-session.ts";

const REVIEW_OPTIONS: ReadonlyArray<{ label: string; decision: ReviewDecision }> = [
	{ label: "实施计划", decision: "implement" },
	{ label: "编辑计划（填写修改意见）", decision: "edit_feedback" },
	{ label: "继续规划", decision: "continue_planning" },
	{ label: "取消计划", decision: "cancel" },
];

function list(values: readonly string[], empty: string): string {
	return values.length ? values.map((value) => `- ${value}`).join("\n") : `- ${empty}`;
}

export function renderUserPlan(spec: PlanSpec): string {
	const steps = spec.steps
		.map(
			(step, index) => `### ${index + 1}. ${step.title}
${list(step.actions, "No actions")}
- Files: ${step.files.join(", ") || "not specified"}
- Validation: ${step.validation.join("; ") || "verify as appropriate"}`,
		)
		.join("\n\n");
	return `# Plan: ${spec.goal}

## Key decisions
${list(spec.decisions, "None recorded")}

## Steps

${steps}

## Risks
${list(spec.risks, "None identified")}

## Implementation permission
Selecting **实施计划** restores the pre-plan tool baseline and temporarily ensures the built-in tools ${MANDATORY_IMPLEMENTATION_TOOLS.join(", ")} are active. Plan Mode no longer restricts ordinary tools during implementation.`;
}

export function reviewSummary(spec: PlanSpec): string {
	const visible = spec.steps.slice(0, 10).map((step, index) => `${index + 1}. ${step.title}`).join("\n");
	const hidden = spec.steps.length > 10 ? `\n… ${spec.steps.length - 10} more steps` : "";
	const risks = spec.risks.length ? `\n\nRisks:\n${spec.risks.slice(0, 5).map((value) => `• ${value}`).join("\n")}` : "";
	return `${spec.goal}\n\nSteps (${spec.steps.length}):\n${visible}${hidden}${risks}\n\nImplementation enables: ${MANDATORY_IMPLEMENTATION_TOOLS.join(", ")}\nAfter confirmation, ordinary tools use normal Pi permissions.`;
}

export async function chooseReviewDecision(ctx: ExtensionContext, spec: PlanSpec): Promise<ReviewDecision | undefined> {
	if (!ctx.hasUI) return undefined;
	const selected = await ctx.ui.select(
		"Plan ready — choose next action",
		REVIEW_OPTIONS.map((option) => option.label),
	);
	return REVIEW_OPTIONS.find((option) => option.label === selected)?.decision;
}

export async function requestEditFeedback(ctx: ExtensionContext, spec: PlanSpec): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const feedback = await ctx.ui.editor(
		"How should the plan change? The model will create a new structured version.",
		`Plan goal: ${spec.goal}\n\nRequested changes:\n`,
	);
	return feedback?.trim() || undefined;
}

export async function confirmImplementation(ctx: ExtensionContext, spec: PlanSpec, resume = false): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(resume ? "Resume plan implementation?" : "Implement this plan?", reviewSummary(spec));
}
