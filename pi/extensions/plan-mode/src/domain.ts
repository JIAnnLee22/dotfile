export const PLAN_SCHEMA = "dev.pi.plan/v1" as const;
export const STATE_SCHEMA = "dev.pi.plan-state/v1" as const;
export const AUDIT_SCHEMA = "dev.pi.plan-audit/v1" as const;
export const ACTION_PROTOCOL = "dev.pi.plan-action/v1" as const;
export const SECURITY_LEVEL = "agent-tools-only" as const;

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

export type Capability = "fs.read" | "fs.write" | "process.exec";

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

export interface PlanStepSpec {
	readonly id: string;
	readonly title: string;
	readonly purpose: string;
	readonly actions: readonly string[];
	/** Read dependencies whose drift can invalidate approval; exact paths or directory roots ending in '/'. */
	readonly dependencyScopes?: readonly string[];
	/** Mutation authorization only; project-relative exact paths or directory roots ending in '/'. */
	readonly pathScopes: readonly string[];
	readonly requiredCapabilities: readonly Capability[];
	readonly acceptance: readonly string[];
	readonly rollback: readonly string[];
}

export interface WorkspaceSnapshotEntry {
	readonly path: string;
	readonly kind: "missing" | "file" | "directory";
	readonly size?: number;
	readonly contentHash?: string;
}

export interface WorkspaceSnapshot {
	readonly schema: "dev.pi.workspace-snapshot/v1";
	readonly capturedAt: string;
	readonly scopes: readonly string[];
	readonly entries: readonly WorkspaceSnapshotEntry[];
	readonly totalBytes: number;
	readonly digest: string;
}

export interface PlanSpec {
	readonly schema: typeof PLAN_SCHEMA;
	readonly planId: string;
	readonly version: number;
	readonly parentVersion: number | null;
	readonly createdAt: string;
	readonly createdBy: Actor;
	readonly goal: string;
	readonly facts: readonly string[];
	readonly assumptions: readonly string[];
	readonly scope: PlanScope;
	readonly steps: readonly PlanStepSpec[];
	readonly risks: readonly string[];
	readonly policyDigest: string;
	readonly contextDigest: string;
	readonly workspaceSnapshot?: WorkspaceSnapshot;
	readonly contentHash: string;
}

export interface PlanDraft {
	readonly goal: string;
	readonly facts?: readonly string[];
	readonly assumptions?: readonly string[];
	readonly steps: readonly PlanStepSpec[];
	readonly risks?: readonly string[];
}

export interface ApprovalRecord {
	readonly schema: "dev.pi.plan-approval/v1";
	readonly approvalId: string;
	readonly nonce: string;
	readonly planRef: PlanRef;
	readonly subject: Actor;
	readonly approvedAt: string;
	readonly sessionId: string;
	readonly branchEntryId: string | null;
}

export interface GrantStepScope {
	readonly stepId: string;
	readonly capabilities: readonly Capability[];
	readonly pathScopes: readonly string[];
}

export interface ExecutionGrant {
	readonly schema: "dev.pi.plan-grant/v1";
	readonly grantId: string;
	readonly approvalId: string;
	readonly planRef: PlanRef;
	readonly issuedTo: Actor;
	readonly issuedAt: string;
	readonly expiresAt?: string;
	readonly policyDigest: string;
	readonly contextDigest: string;
	readonly workspaceDigest?: string;
	readonly sessionId: string;
	readonly branchEntryId: string | null;
	readonly epoch: number;
	readonly steps: readonly GrantStepScope[];
}

export type StepStatus = "pending" | "running" | "verified" | "failed";

export interface StepExecutionState {
	readonly status: StepStatus;
	readonly evidenceIds: readonly string[];
	readonly reason?: string;
}

export interface ExecutionState {
	readonly schema: typeof STATE_SCHEMA;
	readonly status: PlanStatus;
	readonly epoch: number;
	readonly planId?: string;
	readonly planRef?: PlanRef;
	readonly approvalId?: string;
	readonly grantId?: string;
	readonly currentStepId?: string;
	readonly steps: Readonly<Record<string, StepExecutionState>>;
	readonly pendingInput?: {
		readonly kind: string;
		readonly prompt: string;
		readonly choices?: readonly string[];
	};
	readonly reason?: string;
	readonly securityLevel: typeof SECURITY_LEVEL;
	readonly ephemeralSession: boolean;
	readonly updatedAt: string;
}

export type EvidenceKind = "tool-result" | "verification" | "user-confirmation";

export interface EvidenceRecord {
	readonly schema: "dev.pi.plan-evidence/v1";
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
	readonly epoch: number;
	readonly actor: Actor;
	readonly action: string;
	readonly decision: AuditDecision;
	readonly reason?: string;
	readonly digest?: string;
	readonly state?: ExecutionState;
	readonly data?: unknown;
}

export type PlanAction =
	| "start"
	| "request_input"
	| "answer"
	| "submit"
	| "status"
	| "show"
	| "diff"
	| "edit"
	| "approve"
	| "run"
	| "execute"
	| "complete_step"
	| "reject"
	| "pause"
	| "resume"
	| "verify"
	| "cancel"
	| "reset"
	| "audit"
	| "export";

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
	| "GRANT_SCOPE_DENIED"
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
	readonly grantRef?: string;
	readonly pendingInput?: {
		readonly kind: string;
		readonly prompt: string;
		readonly choices?: readonly string[];
	};
	readonly data?: unknown;
	readonly error?: PlanError;
}

export interface ActionEnvironment {
	readonly scope: PlanScope;
	readonly policyDigest: string;
	readonly contextDigest: string;
	readonly goal?: string;
	readonly draft?: PlanDraft;
	readonly reason?: string;
	readonly stepId?: string;
	readonly note?: string;
	readonly question?: string;
	readonly choices?: readonly string[];
	readonly workspaceSnapshot?: WorkspaceSnapshot;
	readonly fromVersion?: number;
	readonly toVersion?: number;
}

export function createInitialState(now = new Date().toISOString(), ephemeralSession = false): ExecutionState {
	return {
		schema: STATE_SCHEMA,
		status: "inactive",
		epoch: 0,
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
