import * as path from "node:path";
import { canonicalJson, comparePaths, normalizePathScope, sha256 } from "./canonical.ts";
import type { Actor, ImportedPlanRef, PlanDraft, PlanRef, PlanScope } from "./domain.ts";

export const LEGACY_PLAN_SCHEMA = "dev.pi.plan/v1" as const;
export const LEGACY_STATE_SCHEMA = "dev.pi.plan-state/v1" as const;
export const LEGACY_AUDIT_SCHEMA = "dev.pi.plan-audit/v1" as const;

export type LegacyCapability = "fs.read" | "fs.write" | "process.exec";

export interface LegacyPlanStepSpec {
	readonly id: string;
	readonly title: string;
	readonly purpose: string;
	readonly actions: readonly string[];
	readonly dependencyScopes?: readonly string[];
	readonly pathScopes: readonly string[];
	readonly requiredCapabilities: readonly LegacyCapability[];
	readonly acceptance: readonly string[];
	readonly rollback: readonly string[];
}

export interface LegacyWorkspaceSnapshotEntry {
	readonly path: string;
	readonly kind: "missing" | "file" | "directory";
	readonly size?: number;
	readonly contentHash?: string;
}

export interface LegacyWorkspaceSnapshot {
	readonly schema: "dev.pi.workspace-snapshot/v1";
	readonly capturedAt: string;
	readonly scopes: readonly string[];
	readonly entries: readonly LegacyWorkspaceSnapshotEntry[];
	readonly totalBytes: number;
	readonly digest: string;
}

export interface LegacyPlanDraft {
	readonly goal: string;
	readonly facts?: readonly string[];
	readonly assumptions?: readonly string[];
	readonly steps: readonly LegacyPlanStepSpec[];
	readonly risks?: readonly string[];
}

export interface LegacyPlanSpec {
	readonly schema: typeof LEGACY_PLAN_SCHEMA;
	readonly planId: string;
	readonly version: number;
	readonly parentVersion: number | null;
	readonly createdAt: string;
	readonly createdBy: Actor;
	readonly goal: string;
	readonly facts: readonly string[];
	readonly assumptions: readonly string[];
	readonly scope: PlanScope;
	readonly steps: readonly LegacyPlanStepSpec[];
	readonly risks: readonly string[];
	readonly policyDigest: string;
	readonly contextDigest: string;
	readonly workspaceSnapshot?: LegacyWorkspaceSnapshot;
	readonly contentHash: string;
}

export interface LegacyStepExecutionState {
	readonly status: "pending" | "running" | "verified" | "failed";
	readonly evidenceIds: readonly string[];
	readonly reason?: string;
}

export interface LegacyExecutionState {
	readonly schema: typeof LEGACY_STATE_SCHEMA;
	readonly status: string;
	readonly epoch: number;
	readonly planId?: string;
	readonly planRef?: PlanRef;
	readonly approvalId?: string;
	readonly grantId?: string;
	readonly currentStepId?: string;
	readonly steps: Readonly<Record<string, LegacyStepExecutionState>>;
	readonly reason?: string;
	readonly ephemeralSession?: boolean;
	readonly updatedAt?: string;
}

export interface LegacyApprovalRecord {
	readonly schema: "dev.pi.plan-approval/v1";
	readonly approvalId: string;
	readonly planRef: PlanRef;
	readonly subject: Actor;
	readonly approvedAt: string;
	readonly sessionId: string;
	readonly branchEntryId: string | null;
}

export interface LegacyEvidenceRecord {
	readonly schema: "dev.pi.plan-evidence/v1";
	readonly evidenceId: string;
	readonly planRef: PlanRef;
	readonly stepId: string;
	readonly kind: string;
	readonly success: boolean;
	readonly summary: string;
	readonly toolName?: string;
}

export interface LegacyAuditEvent {
	readonly schema: typeof LEGACY_AUDIT_SCHEMA;
	readonly eventId: string;
	readonly sequence: number;
	readonly occurredAt: string;
	readonly sessionId: string;
	readonly branchLeafId: string | null;
	readonly planRef?: PlanRef;
	readonly epoch: number;
	readonly actor: Actor;
	readonly action: string;
	readonly decision: "allow" | "deny" | "none";
	readonly reason?: string;
	readonly digest?: string;
	readonly state?: LegacyExecutionState;
	readonly data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isLegacyPlanSpec(value: unknown): value is LegacyPlanSpec {
	return isRecord(value) && value.schema === LEGACY_PLAN_SCHEMA;
}

export function isLegacyAuditEvent(value: unknown): value is LegacyAuditEvent {
	return (
		isRecord(value) &&
		value.schema === LEGACY_AUDIT_SCHEMA &&
		typeof value.eventId === "string" &&
		Number.isInteger(value.sequence) &&
		typeof value.action === "string"
	);
}

export function isLegacyExecutionState(value: unknown): value is LegacyExecutionState {
	return isRecord(value) && value.schema === LEGACY_STATE_SCHEMA && typeof value.status === "string" && Number.isInteger(value.epoch);
}

export function calculateLegacyPlanHash(spec: Omit<LegacyPlanSpec, "contentHash"> | LegacyPlanSpec): string {
	const { contentHash: _ignored, ...hashable } = spec as LegacyPlanSpec;
	return sha256(canonicalJson(hashable));
}

export function legacyPlanRef(spec: LegacyPlanSpec): PlanRef {
	return { planId: spec.planId, version: spec.version, contentHash: spec.contentHash };
}

export function importedRef(spec: LegacyPlanSpec): ImportedPlanRef {
	return { schema: LEGACY_PLAN_SCHEMA, ...legacyPlanRef(spec) };
}

export function legacyToDraft(spec: LegacyPlanSpec): PlanDraft {
	return {
		goal: spec.goal,
		decisions: [
			...spec.facts.map((value) => `Fact: ${value}`),
			...spec.assumptions.map((value) => `Assumption: ${value}`),
		],
		steps: spec.steps.map((step) => ({
			title: step.title,
			actions: step.actions,
			files: step.pathScopes,
			validation: step.acceptance,
		})),
		risks: spec.risks,
	};
}

export function validateLegacyPlanSpec(spec: LegacyPlanSpec): string[] {
	const errors: string[] = [];
	if (spec.schema !== LEGACY_PLAN_SCHEMA) errors.push(`Unsupported legacy schema: ${String(spec.schema)}`);
	if (!/^[0-9a-f-]{16,}$/i.test(spec.planId)) errors.push("legacy planId must be an opaque UUID-like identifier");
	if (!Number.isInteger(spec.version) || spec.version < 1) errors.push("legacy version must be a positive integer");
	if (spec.parentVersion !== null && (!Number.isInteger(spec.parentVersion) || spec.parentVersion >= spec.version)) {
		errors.push("legacy parentVersion must be null or lower than version");
	}
	if (!spec.goal?.trim()) errors.push("legacy goal is required");
	if (!path.isAbsolute(spec.scope?.cwd ?? "")) errors.push("legacy scope.cwd must be absolute");
	if (!Array.isArray(spec.steps) || spec.steps.length === 0) errors.push("legacy plan requires at least one step");
	const ids = new Set<string>();
	for (const [index, step] of (spec.steps ?? []).entries()) {
		if (!step.id) errors.push(`legacy steps[${index}].id is required`);
		if (ids.has(step.id)) errors.push(`legacy duplicate step id: ${step.id}`);
		ids.add(step.id);
		if (!step.title?.trim()) errors.push(`legacy steps[${index}].title is required`);
		if (!Array.isArray(step.actions) || step.actions.length === 0) errors.push(`legacy steps[${index}].actions must not be empty`);
		if (!Array.isArray(step.acceptance) || step.acceptance.length === 0) errors.push(`legacy steps[${index}].acceptance must not be empty`);
		for (const scope of [...(step.dependencyScopes ?? []), ...(step.pathScopes ?? [])]) {
			try {
				if (normalizePathScope(scope) !== scope) errors.push(`legacy path scope is not canonical: ${scope}`);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	if (spec.workspaceSnapshot) {
		const snapshot = spec.workspaceSnapshot;
		const paths = snapshot.entries.map((entry) => entry.path);
		const firstIndex = new Map<string, number>();
		for (const [index, entry] of paths.entries()) {
			const previous = firstIndex.get(entry);
			if (previous !== undefined) {
				errors.push(`legacy workspace snapshot duplicate path '${entry}' at indices ${previous} and ${index}`);
			} else {
				firstIndex.set(entry, index);
			}
		}
		for (let index = 1; index < paths.length; index++) {
			if (comparePaths(paths[index - 1], paths[index]) > 0) {
				errors.push(
					`legacy workspace snapshot path '${paths[index]}' at index ${index} sorts before '${paths[index - 1]}' at index ${index - 1}`,
				);
			}
		}
		const expectedDigest = sha256(
			canonicalJson({
				schema: snapshot.schema,
				scopes: snapshot.scopes,
				entries: snapshot.entries,
				totalBytes: snapshot.totalBytes,
			}),
		);
		if (snapshot.digest !== expectedDigest) errors.push("legacy workspace snapshot digest mismatch");
	}
	try {
		if (spec.contentHash !== calculateLegacyPlanHash(spec)) errors.push("legacy contentHash mismatch");
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	return errors;
}
