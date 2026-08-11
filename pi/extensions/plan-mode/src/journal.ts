import { canonicalJson } from "./canonical.ts";
import { AUDIT_SCHEMA, STATE_SCHEMA, type ApprovalRecord, type AuditEvent, type EvidenceRecord, type ExecutionState } from "./domain.ts";

export const AUDIT_ENTRY_TYPE = "plan-mode/audit";

export interface SessionEntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

export interface JournalProjection {
	readonly state?: ExecutionState;
	readonly approvals: ReadonlyMap<string, ApprovalRecord>;
	readonly evidence: ReadonlyMap<string, EvidenceRecord>;
	readonly events: readonly AuditEvent[];
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
	return isRecord(value) && value.schema === STATE_SCHEMA && typeof value.status === "string" && Number.isInteger(value.epoch);
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
	return isRecord(value) && value.schema === "dev.pi.plan-approval/v1" && typeof value.approvalId === "string";
}

function isEvidenceRecord(value: unknown): value is EvidenceRecord {
	return isRecord(value) && value.schema === "dev.pi.plan-evidence/v1" && typeof value.evidenceId === "string";
}

function scanAuditEvents(entries: readonly SessionEntryLike[]): { events: AuditEvent[]; corruptReason?: string } {
	const events: AuditEvent[] = [];
	const seen = new Map<string, string>();
	let maxSequence = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== AUDIT_ENTRY_TYPE || !isAuditEvent(entry.data)) continue;
		const event = entry.data;
		let eventDigest: string;
		try {
			eventDigest = canonicalJson(JSON.parse(JSON.stringify(event)));
		} catch (error) {
			return { events, corruptReason: `Audit event cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}` };
		}
		const previousDigest = seen.get(event.eventId);
		if (previousDigest !== undefined) {
			if (previousDigest !== eventDigest) return { events, corruptReason: `Conflicting duplicate audit eventId ${event.eventId}` };
			continue;
		}
		if (event.sequence <= maxSequence) {
			return { events, corruptReason: `Non-monotonic audit sequence ${event.sequence} after ${maxSequence}` };
		}
		seen.set(event.eventId, eventDigest);
		maxSequence = event.sequence;
		events.push(event);
	}
	return { events };
}

export function extractAuditEvents(entries: readonly SessionEntryLike[]): AuditEvent[] {
	return scanAuditEvents(entries).events;
}

export function projectJournal(entries: readonly SessionEntryLike[]): JournalProjection {
	const scanned = scanAuditEvents(entries);
	const events = scanned.events;
	const approvals = new Map<string, ApprovalRecord>();
	const evidence = new Map<string, EvidenceRecord>();
	let state: ExecutionState | undefined;
	for (const event of events) {
		if (event.action === "approval-created" && isApprovalRecord(event.data)) approvals.set(event.data.approvalId, event.data);
		if (event.action === "evidence-recorded" && isEvidenceRecord(event.data)) evidence.set(event.data.evidenceId, event.data);
		if (event.action === "state-committed" && isExecutionState(event.state)) state = structuredClone(event.state);
	}
	return {
		state,
		approvals,
		evidence,
		events,
		maxSequence: events.at(-1)?.sequence ?? 0,
		corruptReason: scanned.corruptReason,
	};
}
