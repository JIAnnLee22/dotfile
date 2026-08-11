import { canonicalJson } from "./canonical.ts";
import { toPlanRef, type PlanRef, type PlanSpec, type PlanStepSpec } from "./domain.ts";

export interface PlanFieldChange {
	readonly field: string;
	readonly before: unknown;
	readonly after: unknown;
}

export interface PlanStepChange {
	readonly stepId: string;
	readonly kind: "added" | "removed" | "modified";
	readonly changes: readonly PlanFieldChange[];
}

export interface PlanDiff {
	readonly schema: "dev.pi.plan-diff/v1";
	readonly from: PlanRef;
	readonly to: PlanRef;
	readonly changed: boolean;
	readonly planChanges: readonly PlanFieldChange[];
	readonly stepChanges: readonly PlanStepChange[];
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function collectFields(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
	fields: readonly string[],
): PlanFieldChange[] {
	const changes: PlanFieldChange[] = [];
	for (const field of fields) {
		if (!equal(left[field], right[field])) changes.push({ field, before: left[field], after: right[field] });
	}
	return changes;
}

function stepChanges(before: PlanStepSpec, after: PlanStepSpec): PlanFieldChange[] {
	return collectFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, [
		"title",
		"purpose",
		"actions",
		"dependencyScopes",
		"pathScopes",
		"requiredCapabilities",
		"acceptance",
		"rollback",
	]);
}

export function diffPlanSpecs(before: PlanSpec, after: PlanSpec): PlanDiff {
	if (before.planId !== after.planId) throw new TypeError("Cannot diff PlanSpecs from different planId lineages");
	const planChanges = collectFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, [
		"goal",
		"facts",
		"assumptions",
		"risks",
		"policyDigest",
		"contextDigest",
	]);
	if (before.workspaceSnapshot?.digest !== after.workspaceSnapshot?.digest) {
		planChanges.push({
			field: "workspaceSnapshot.digest",
			before: before.workspaceSnapshot?.digest ?? null,
			after: after.workspaceSnapshot?.digest ?? null,
		});
	}
	const beforeSteps = new Map(before.steps.map((step) => [step.id, step]));
	const afterSteps = new Map(after.steps.map((step) => [step.id, step]));
	const order = [...before.steps.map((step) => step.id), ...after.steps.map((step) => step.id).filter((id) => !beforeSteps.has(id))];
	const changedSteps: PlanStepChange[] = [];
	for (const stepId of order) {
		const left = beforeSteps.get(stepId);
		const right = afterSteps.get(stepId);
		if (!left && right) {
			changedSteps.push({ stepId, kind: "added", changes: [{ field: "step", before: null, after: right }] });
			continue;
		}
		if (left && !right) {
			changedSteps.push({ stepId, kind: "removed", changes: [{ field: "step", before: left, after: null }] });
			continue;
		}
		if (left && right) {
			const changes = stepChanges(left, right);
			if (changes.length) changedSteps.push({ stepId, kind: "modified", changes });
		}
	}
	return {
		schema: "dev.pi.plan-diff/v1",
		from: toPlanRef(before),
		to: toPlanRef(after),
		changed: planChanges.length > 0 || changedSteps.length > 0,
		planChanges,
		stepChanges: changedSteps,
	};
}

function inline(value: unknown): string {
	const rendered = JSON.stringify(value);
	if (rendered === undefined) return "undefined";
	return rendered.length <= 240 ? rendered : `${rendered.slice(0, 237)}...`;
}

export function renderPlanDiffMarkdown(diff: PlanDiff): string {
	const lines = [
		"# Plan Version Diff",
		"",
		`- From: \`${diff.from.planId}@${diff.from.version}:${diff.from.contentHash}\``,
		`- To: \`${diff.to.planId}@${diff.to.version}:${diff.to.contentHash}\``,
		`- Changed: ${diff.changed ? "yes" : "no"}`,
		"",
		"## Plan fields",
	];
	if (!diff.planChanges.length) lines.push("- No plan-level changes");
	for (const change of diff.planChanges) {
		lines.push(`- **${change.field}**: ${inline(change.before)} → ${inline(change.after)}`);
	}
	lines.push("", "## Steps");
	if (!diff.stepChanges.length) lines.push("- No step changes");
	for (const step of diff.stepChanges) {
		lines.push(`- **${step.stepId}** (${step.kind})`);
		for (const change of step.changes) lines.push(`  - ${change.field}: ${inline(change.before)} → ${inline(change.after)}`);
	}
	return `${lines.join("\n")}\n`;
}
