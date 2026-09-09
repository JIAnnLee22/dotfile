export const PLAN_SCHEMA = "dev.pi.plan/v2" as const;
export const STATE_SCHEMA = "dev.pi.plan-state/v2" as const;
export const AUDIT_SCHEMA = "dev.pi.plan-audit/v2" as const;
export const ACTION_PROTOCOL = "dev.pi.plan-action/v2" as const;
export const SECURITY_LEVEL = "agent-tools-only" as const;

export type PlanStatus =
	| "inactive"
	| "planning"
	| "awaiting_input"
	| "review"
	| "implementing"
	| "paused"
	| "completed"
	| "cancelled"
	| "stale"
	| "failed";

export type ResearchCapability =
	| "workspace.read"
	| "metadata.read"
	| "network.read"
	| "managed.index.write"
	| "fs.write"
	| "process.exec"
	| "external.mutate";

export type ActorChannel = "model" | "tui" | "print" | "json" | "rpc" | "sdk" | "cli" | "system";

export interface Actor {
	readonly channel: ActorChannel;
	readonly id: string;
}

export interface PlanRef {
	readonly planId: string;
	readonly version: number;
	readonly contentHash: string;
}

export interface PlanScope {
	readonly cwd: string;
	readonly sessionId: string;
	readonly branchLeafId: string | null;
	readonly ephemeralSession: boolean;
}

export interface ImportedPlanRef extends PlanRef {
	readonly schema: "dev.pi.plan/v1";
}

export interface PlanStepDraft {
	readonly title: string;
	readonly actions: readonly string[];
	/** Informational implementation paths, not an authorization boundary. */
	readonly files?: readonly string[];
	/** Human-readable checks or commands, not automatically executed by the controller. */
	readonly validation?: readonly string[];
}

export interface PlanDraft {
	readonly goal: string;
	readonly decisions?: readonly string[];
	readonly steps: readonly PlanStepDraft[];
	readonly risks?: readonly string[];
}

export interface PlanStepSpec extends PlanStepDraft {
	readonly id: string;
	readonly files: readonly string[];
	readonly validation: readonly string[];
}

export interface PlanSpec {
	readonly schema: typeof PLAN_SCHEMA;
	readonly planId: string;
	readonly version: number;
	readonly parentVersion: number | null;
	readonly importedFrom?: ImportedPlanRef;
	readonly forkedFrom?: PlanRef;
	readonly createdAt: string;
	readonly createdBy: Actor;
	readonly goal: string;
	readonly decisions: readonly string[];
	readonly scope: PlanScope;
	readonly steps: readonly PlanStepSpec[];
	readonly risks: readonly string[];
	readonly contentHash: string;
}

export interface ApprovalRecord {
	readonly schema: "dev.pi.plan-approval/v2";
	readonly approvalId: string;
	readonly nonce: string;
	readonly planRef: PlanRef;
	readonly subject: Actor;
	readonly approvedAt: string;
	readonly sessionId: string;
	readonly branchEntryId: string | null;
	readonly activeToolsDigest: string;
}

export type ResearchPermissionDecision = "allow" | "deny";

export interface ResearchPermissionRecord {
	readonly schema: "dev.pi.plan-research-permission/v2";
	readonly permissionId: string;
	readonly planId: string;
	readonly toolName: string;
	readonly capabilities: readonly ResearchCapability[];
	readonly sourceDigest: string;
	readonly decision: ResearchPermissionDecision;
	readonly subject: Actor;
	readonly decidedAt: string;
	readonly sessionId: string;
	readonly branchEntryId: string | null;
}

export interface ToolBaselineRecord {
	readonly schema: "dev.pi.plan-tool-baseline/v2";
	readonly baselineId: string;
	readonly planId: string;
	readonly toolNames: readonly string[];
	readonly capturedAt: string;
	readonly sessionId: string;
	readonly branchEntryId: string | null;
}

export type StepStatus = "pending" | "running" | "completed" | "failed";

export interface StepExecutionState {
	readonly status: StepStatus;
	readonly reportIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly summary?: string;
	readonly reason?: string;
}

export interface ExecutionState {
	readonly schema: typeof STATE_SCHEMA;
	readonly status: PlanStatus;
	readonly revision: number;
	readonly runRevision: number;
	readonly stepRevision: number;
	readonly planId?: string;
	readonly planRef?: PlanRef;
	readonly approvalId?: string;
	readonly baselineId?: string;
	readonly currentStepId?: string;
	readonly steps: Readonly<Record<string, StepExecutionState>>;
	readonly pendingInput?: {
		readonly kind: "text" | "select";
		readonly prompt: string;
		readonly choices?: readonly string[];
	};
	readonly reason?: string;
	readonly securityLevel: typeof SECURITY_LEVEL;
	readonly ephemeralSession: boolean;
	readonly updatedAt: string;
}

export type EvidenceKind = "tool-result" | "step-report";

export interface EvidenceRecord {
	readonly schema: "dev.pi.plan-evidence/v2";
	readonly evidenceId: string;
	readonly planRef: PlanRef;
	readonly stepId: string;
	readonly kind: EvidenceKind;
	readonly actor: Actor;
	readonly recordedAt: string;
	readonly success: boolean;
	readonly summary: string;
	readonly digest?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
}

export type AuditDecision = "allow" | "deny" | "none";

export interface AuditEvent {
	readonly schema: typeof AUDIT_SCHEMA;
	readonly eventId: string;
	readonly sequence: number;
	readonly occurredAt: string;
	readonly sessionId: string;
	readonly branchLeafId: string | null;
	readonly planRef?: PlanRef;
	readonly revision: number;
	readonly actor: Actor;
	readonly action: string;
	readonly decision: AuditDecision;
	readonly reason?: string;
	readonly digest?: string;
	readonly state?: ExecutionState;
	readonly data?: unknown;
}

export type ReviewDecision = "implement" | "edit_feedback" | "continue_planning" | "cancel";

export type PlanAction =
	| "start"
	| "request_input"
	| "answer"
	| "submit"
	| "status"
	| "show"
	| "diff"
	| "continue_planning"
	| "edit_feedback"
	| "implement"
	| "run"
	| "complete_step"
	| "block"
	| "pause"
	| "resume"
	| "cancel"
	| "audit"
	| "migrate_v1";

export interface PlanActionRequest {
	readonly protocolVersion: typeof ACTION_PROTOCOL;
	readonly requestId: string;
	readonly action: PlanAction;
	readonly expectedPlan?: PlanRef;
	readonly actor: Actor;
	readonly payload?: unknown;
}

export type PlanErrorCode =
	| "INVALID_ACTION"
	| "INVALID_STATE"
	| "INVALID_PLAN"
	| "BUSY"
	| "PLAN_REF_MISMATCH"
	| "APPROVAL_REQUIRED"
	| "TOOL_UNAVAILABLE"
	| "PERMISSION_REQUIRED"
	| "SOURCE_MISMATCH"
	| "STALE"
	| "UI_REQUIRED"
	| "STORAGE_ERROR"
	| "UNSUPPORTED_MODE"
	| "SAFETY_BOUNDARY_DEGRADED";

export interface PlanError {
	readonly code: PlanErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: unknown;
}

export interface PlanActionResult {
	readonly requestId: string;
	readonly ok: boolean;
	readonly state: ExecutionState;
	readonly planRef?: PlanRef;
	readonly approvalRef?: string;
	readonly pendingInput?: ExecutionState["pendingInput"];
	readonly data?: unknown;
	readonly error?: PlanError;
}

export interface ActionEnvironment {
	readonly scope: PlanScope;
	readonly goal?: string;
	readonly draft?: PlanDraft;
	readonly reason?: string;
	readonly stepId?: string;
	readonly note?: string;
	readonly question?: string;
	readonly choices?: readonly string[];
	readonly feedback?: string;
	readonly fromVersion?: number;
	readonly toVersion?: number;
	readonly activeTools?: readonly string[];
	readonly activeToolsDigest?: string;
	readonly baseline?: ToolBaselineRecord;
	readonly importedFrom?: ImportedPlanRef;
}

export function createInitialState(now = new Date().toISOString(), ephemeralSession = false): ExecutionState {
	return {
		schema: STATE_SCHEMA,
		status: "inactive",
		revision: 0,
		runRevision: 0,
		stepRevision: 0,
		steps: {},
		securityLevel: SECURITY_LEVEL,
		ephemeralSession,
		updatedAt: now,
	};
}

export function toPlanRef(spec: PlanSpec): PlanRef {
	return { planId: spec.planId, version: spec.version, contentHash: spec.contentHash };
}

export function samePlanRef(left: PlanRef | undefined, right: PlanRef | undefined): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.planId === right.planId &&
		left.version === right.version &&
		left.contentHash === right.contentHash
	);
}
