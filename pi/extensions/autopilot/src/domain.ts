export const MISSION_SCHEMA = "dev.pi.autopilot-mission/v1" as const;
export const STATE_SCHEMA = "dev.pi.autopilot-state/v1" as const;
export const AUDIT_SCHEMA = "dev.pi.autopilot-audit/v1" as const;
export const ACTION_PROTOCOL = "dev.pi.autopilot-action/v1" as const;
export const SECURITY_LEVEL = "agent-tools-only" as const;

export type AutopilotStatus =
	| "inactive"
	| "drafting"
	| "dryrun"
	| "running"
	| "paused"
	| "completed"
	| "cancelled"
	| "failed";

export type Capability = "fs.read" | "fs.write" | "process.exec";

export type ActorChannel = "model" | "tui" | "print" | "json" | "rpc" | "sdk" | "cli" | "system";

export interface Actor {
	readonly channel: ActorChannel;
	readonly id: string;
}

export interface MissionRef {
	readonly missionId: string;
	readonly version: number;
	readonly contentHash: string;
}

export interface MissionScope {
	readonly cwd: string;
	readonly sessionId: string;
	readonly branchLeafId: string | null;
	readonly ephemeralSession: boolean;
}

export interface AcceptanceCriterion {
	/** Unique id, e.g. "AC1". */
	readonly id: string;
	/** Verifiable acceptance statement. */
	readonly title: string;
	/** How to verify: concrete command/check. Executed dry before the run loop starts. */
	readonly verify: string;
	/** All criteria are required by default; optional criteria may fail without blocking completion. */
	readonly required?: boolean;
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

export interface MissionSpec {
	readonly schema: typeof MISSION_SCHEMA;
	readonly missionId: string;
	readonly version: number;
	readonly parentVersion: number | null;
	readonly createdAt: string;
	readonly createdBy: Actor;
	readonly goal: string;
	readonly facts: readonly string[];
	readonly assumptions: readonly string[];
	readonly scope: MissionScope;
	/** Global acceptance criteria. All required=true criteria must pass before the run stops. */
	readonly acceptance: readonly AcceptanceCriterion[];
	/** Additional write roots outside cwd (project-relative paths are always allowed). */
	readonly pathScopes: readonly string[];
	/** Read-only dependency scopes whose drift is recorded (informational, not blocking). */
	readonly dependencyScopes: readonly string[];
	readonly risks: readonly string[];
	readonly policyDigest: string;
	readonly contextDigest: string;
	readonly workspaceSnapshot?: WorkspaceSnapshot;
	readonly contentHash: string;
}

export interface MissionDraft {
	readonly goal: string;
	readonly facts?: readonly string[];
	readonly assumptions?: readonly string[];
	readonly acceptance: readonly AcceptanceCriterion[];
	readonly pathScopes?: readonly string[];
	readonly dependencyScopes?: readonly string[];
	readonly risks?: readonly string[];
}

export type AcReportStatus = "ready" | "not_ready" | "pass" | "fail";

export interface AcReportEntry {
	readonly acId: string;
	readonly status: AcReportStatus;
	/** Evidence summary naming the actual command/output that backs this claim. */
	readonly evidence: string;
}

export interface AcExecutionState {
	readonly status: "pending" | "ready" | "not_ready" | "pass" | "fail";
	readonly evidence?: string;
	readonly evidenceCount: number;
	readonly updatedAt?: string;
}

export interface ExecutionState {
	readonly schema: typeof STATE_SCHEMA;
	readonly status: AutopilotStatus;
	readonly epoch: number;
	readonly missionId?: string;
	readonly missionRef?: MissionRef;
	/** Stage the paused state came from; undefined elsewhere. */
	readonly pausedFromStage?: "dryrun" | "running";
	readonly acResults: Readonly<Record<string, AcExecutionState>>;
	readonly reason?: string;
	readonly securityLevel: typeof SECURITY_LEVEL;
	readonly ephemeralSession: boolean;
	readonly updatedAt: string;
}

export interface EvidenceRecord {
	readonly schema: "dev.pi.autopilot-evidence/v1";
	readonly evidenceId: string;
	readonly stage: "dryrun" | "running";
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
	readonly missionRef?: MissionRef;
	readonly epoch: number;
	readonly actor: Actor;
	readonly action: string;
	readonly decision: AuditDecision;
	readonly reason?: string;
	readonly digest?: string;
	readonly state?: ExecutionState;
	readonly data?: unknown;
}

export type AutopilotAction =
	| "start"
	| "submit"
	| "report"
	| "pause"
	| "resume"
	| "cancel"
	| "reset"
	| "status"
	| "show"
	| "audit";

export interface AutopilotActionRequest {
	readonly protocolVersion: typeof ACTION_PROTOCOL;
	readonly requestId: string;
	readonly action: AutopilotAction;
	readonly expectedMission?: MissionRef;
	readonly actor: Actor;
	readonly payload?: unknown;
}

export type AutopilotErrorCode =
	| "INVALID_ACTION"
	| "INVALID_STATE"
	| "INVALID_MISSION"
	| "BUSY"
	| "MISSION_REF_MISMATCH"
	| "STALE"
	| "EVIDENCE_REQUIRED"
	| "UI_REQUIRED"
	| "STORAGE_ERROR"
	| "SAFETY_BOUNDARY_DEGRADED";

export interface AutopilotError {
	readonly code: AutopilotErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: unknown;
}

export interface AutopilotActionResult {
	readonly requestId: string;
	readonly ok: boolean;
	readonly state: ExecutionState;
	readonly missionRef?: MissionRef;
	readonly pending?: { readonly acId: string; readonly status: AcReportStatus; readonly evidence: string };
	readonly data?: unknown;
	readonly error?: AutopilotError;
}

export interface ActionEnvironment {
	readonly scope: MissionScope;
	readonly policyDigest: string;
	readonly contextDigest: string;
	readonly goal?: string;
	readonly draft?: MissionDraft;
	readonly reason?: string;
	readonly results?: readonly AcReportEntry[];
	readonly workspaceSnapshot?: WorkspaceSnapshot;
}

export function createInitialState(now = new Date().toISOString(), ephemeralSession = false): ExecutionState {
	return {
		schema: STATE_SCHEMA,
		status: "inactive",
		epoch: 0,
		acResults: {},
		securityLevel: SECURITY_LEVEL,
		ephemeralSession,
		updatedAt: now,
	};
}

export function toMissionRef(spec: MissionSpec): MissionRef {
	return { missionId: spec.missionId, version: spec.version, contentHash: spec.contentHash };
}

export function sameMissionRef(left: MissionRef | undefined, right: MissionRef | undefined): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.missionId === right.missionId &&
		left.version === right.version &&
		left.contentHash === right.contentHash
	);
}
