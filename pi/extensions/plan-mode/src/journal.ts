import { canonicalJson } from "./canonical.ts";
import {
	AUDIT_SCHEMA,
	STATE_SCHEMA,
	type ApprovalRecord,
	type AuditEvent,
	type EvidenceRecord,
	type ExecutionState,
	type ResearchPermissionRecord,
	type ToolBaselineRecord,
} from "./domain.ts";
import {
	isLegacyAuditEvent,
	isLegacyExecutionState,
	type LegacyAuditEvent,
	type LegacyExecutionState,
} from "./legacy-v1.ts";

export const AUDIT_ENTRY_TYPE = "plan-mode/audit";

export interface SessionEntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

export interface LegacyJournalProjection {
	readonly state?: LegacyExecutionState;
	readonly events: readonly LegacyAuditEvent[];
}

export interface JournalProjection {
	readonly state?: ExecutionState;
	readonly approvals: ReadonlyMap<string, ApprovalRecord>;
	readonly permissions: ReadonlyMap<string, ResearchPermissionRecord>;
	readonly baselines: ReadonlyMap<string, ToolBaselineRecord>;
	readonly evidence: ReadonlyMap<string, EvidenceRecord>;
	readonly events: readonly AuditEvent[];
	readonly legacy?: LegacyJournalProjection;
	readonly maxSequence: number;
	readonly corruptReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAuditEvent(value: unknown): value is AuditEvent {
	return (
		isRecord(value) &&
		value.schema === AUDIT_SCHEMA &&
		typeof value.eventId === "string" &&
		Number.isInteger(value.sequence) &&
		typeof value.action === "string"
	);
}

function isExecutionState(value: unknown): value is ExecutionState {
	return isRecord(value) && value.schema === STATE_SCHEMA && typeof value.status === "string" && Number.isInteger(value.revision);
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
	return isRecord(value) && value.schema === "dev.pi.plan-approval/v2" && typeof value.approvalId === "string";
}

function isResearchPermission(value: unknown): value is ResearchPermissionRecord {
	return (
		isRecord(value) &&
		value.schema === "dev.pi.plan-research-permission/v2" &&
		typeof value.permissionId === "string" &&
		typeof value.planId === "string"
	);
}

function isToolBaseline(value: unknown): value is ToolBaselineRecord {
	return (
		isRecord(value) &&
		value.schema === "dev.pi.plan-tool-baseline/v2" &&
		typeof value.baselineId === "string" &&
		Array.isArray(value.toolNames)
	);
}

function isEvidenceRecord(value: unknown): value is EvidenceRecord {
	return isRecord(value) && value.schema === "dev.pi.plan-evidence/v2" && typeof value.evidenceId === "string";
}

function permissionKey(record: Pick<ResearchPermissionRecord, "planId" | "toolName" | "sourceDigest">): string {
	return `${record.planId}\u0000${record.toolName}\u0000${record.sourceDigest}`;
}

function scanAuditEvents(entries: readonly SessionEntryLike[]): {
	v2: AuditEvent[];
	legacy: LegacyAuditEvent[];
	maxSequence: number;
	corruptReason?: string;
} {
	const v2: AuditEvent[] = [];
	const legacy: LegacyAuditEvent[] = [];
	const seen = new Map<string, string>();
	let maxSequence = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== AUDIT_ENTRY_TYPE) continue;
		const event = entry.data;
		if (!isAuditEvent(event) && !isLegacyAuditEvent(event)) {
			return { v2, legacy, maxSequence, corruptReason: "Unsupported or malformed Plan Mode audit event" };
		}
		let eventDigest: string;
		try {
			eventDigest = canonicalJson(JSON.parse(JSON.stringify(event)));
		} catch (error) {
			return {
				v2,
				legacy,
				maxSequence,
				corruptReason: `Audit event cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const previousDigest = seen.get(event.eventId);
		if (previousDigest !== undefined) {
			if (previousDigest !== eventDigest) {
				return { v2, legacy, maxSequence, corruptReason: `Conflicting duplicate audit eventId ${event.eventId}` };
			}
			continue;
		}
		if (event.sequence <= maxSequence) {
			return { v2, legacy, maxSequence, corruptReason: `Non-monotonic audit sequence ${event.sequence} after ${maxSequence}` };
		}
		seen.set(event.eventId, eventDigest);
		maxSequence = event.sequence;
		if (isAuditEvent(event)) v2.push(event);
		else legacy.push(event);
	}
	return { v2, legacy, maxSequence };
}

export function extractAuditEvents(entries: readonly SessionEntryLike[]): AuditEvent[] {
	return scanAuditEvents(entries).v2;
}

export function projectJournal(entries: readonly SessionEntryLike[]): JournalProjection {
	const scanned = scanAuditEvents(entries);
	const approvals = new Map<string, ApprovalRecord>();
	const permissions = new Map<string, ResearchPermissionRecord>();
	const baselines = new Map<string, ToolBaselineRecord>();
	const evidence = new Map<string, EvidenceRecord>();
	let state: ExecutionState | undefined;
	for (const event of scanned.v2) {
		if (event.action === "approval-created" && isApprovalRecord(event.data)) approvals.set(event.data.approvalId, event.data);
		if (event.action === "research-permission-decided" && isResearchPermission(event.data)) {
			permissions.set(permissionKey(event.data), event.data);
		}
		if (event.action === "tool-baseline-captured" && isToolBaseline(event.data)) baselines.set(event.data.baselineId, event.data);
		if (event.action === "evidence-recorded" && isEvidenceRecord(event.data)) evidence.set(event.data.evidenceId, event.data);
		if (event.action === "state-committed" && isExecutionState(event.state)) state = structuredClone(event.state);
	}
	let legacyState: LegacyExecutionState | undefined;
	for (const event of scanned.legacy) {
		if (event.action === "state-committed" && isLegacyExecutionState(event.state)) legacyState = structuredClone(event.state);
	}
	return {
		state,
		approvals,
		permissions,
		baselines,
		evidence,
		events: scanned.v2,
		legacy: scanned.legacy.length > 0 ? { state: legacyState, events: scanned.legacy } : undefined,
		maxSequence: scanned.maxSequence,
		corruptReason: scanned.corruptReason,
	};
}

export function researchPermissionKey(record: Pick<ResearchPermissionRecord, "planId" | "toolName" | "sourceDigest">): string {
	return permissionKey(record);
}
