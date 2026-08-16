import { randomUUID } from "node:crypto";
import { calculateMissionHash, normalizeDraft, requiredAcceptance } from "./canonical.ts";
import type { MissionArtifactStore } from "./artifact-store.ts";
import {
	ACTION_PROTOCOL,
	AUDIT_SCHEMA,
	SECURITY_LEVEL,
	STATE_SCHEMA,
	createInitialState,
	sameMissionRef,
	toMissionRef,
	type AcReportEntry,
	type ActionEnvironment,
	type Actor,
	type AuditDecision,
	type AuditEvent,
	type AutopilotAction,
	type AutopilotActionRequest,
	type AutopilotActionResult,
	type AutopilotErrorCode,
	type EvidenceRecord,
	type ExecutionState,
	type MissionDraft,
	type MissionRef,
	type MissionScope,
	type MissionSpec,
} from "./domain.ts";
import { projectJournal, type SessionEntryLike } from "./journal.ts";
import { assertTransition, isTerminal } from "./state-machine.ts";
import type { WorkspaceSnapshot } from "./domain.ts";

export interface AuditJournalWriter {
	append(event: AuditEvent): Promise<void> | void;
}

export interface AutopilotControllerOptions {
	readonly store: MissionArtifactStore;
	readonly journal: AuditJournalWriter;
	readonly now?: () => string;
	readonly id?: () => string;
}

export class AutopilotControllerError extends Error {
	readonly code: AutopilotErrorCode;
	readonly retryable: boolean;
	readonly details?: unknown;

	constructor(code: AutopilotErrorCode, message: string, retryable = false, details?: unknown) {
		super(message);
		this.name = "AutopilotControllerError";
		this.code = code;
		this.retryable = retryable;
		this.details = details;
	}
}

class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

function cloneState(state: ExecutionState): ExecutionState {
	return structuredClone(state);
}

function auditSummary(value: string | undefined, fallback: string): string {
	if (!value?.trim()) return fallback;
	return value
		.trim()
		.replace(/((?:password|passwd|token|secret|api[-_]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
		.slice(0, 256);
}

function isDraft(value: unknown): value is MissionDraft {
	return value !== null && typeof value === "object" && "goal" in value && "acceptance" in value && Array.isArray((value as MissionDraft).acceptance);
}

function errorResult(request: AutopilotActionRequest, state: ExecutionState, error: unknown): AutopilotActionResult {
	const normalized =
		error instanceof AutopilotControllerError
			? error
			: new AutopilotControllerError("STORAGE_ERROR", error instanceof Error ? error.message : String(error), false);
	return {
		requestId: request.requestId,
		ok: false,
		state: cloneState(state),
		missionRef: state.missionRef,
		error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable, details: normalized.details },
	};
}

function acState(spec: MissionSpec): ExecutionState["acResults"] {
	return Object.fromEntries(spec.acceptance.map((criterion) => [criterion.id, { status: "pending" as const, evidenceCount: 0 }]));
}

export class AutopilotController {
	private readonly store: MissionArtifactStore;
	private readonly journal: AuditJournalWriter;
	private readonly now: () => string;
	private readonly id: () => string;
	private readonly mutex = new AsyncMutex();
	private stateValue: ExecutionState;
	private sequence = 0;
	private specValue?: MissionSpec;
	private readonly eventsValue: AuditEvent[] = [];
	/** Tool evidence accumulated in the current stage (success and failure). */
	private stageEvidence: EvidenceRecord[] = [];
	/** stageEvidence.length at the last report (or stage start); new evidence = slice from here. */
	private lastReportEvidenceCount = 0;

	constructor(options: AutopilotControllerOptions) {
		this.store = options.store;
		this.journal = options.journal;
		this.now = options.now ?? (() => new Date().toISOString());
		this.id = options.id ?? randomUUID;
		this.stateValue = createInitialState(this.now());
	}

	get state(): ExecutionState {
		return cloneState(this.stateValue);
	}

	get spec(): MissionSpec | undefined {
		return this.specValue ? structuredClone(this.specValue) : undefined;
	}

	get events(): readonly AuditEvent[] {
		return structuredClone(this.eventsValue);
	}

	get stageEvidenceCount(): number {
		return this.stageEvidence.length;
	}

	private async appendAudit(
		action: string,
		actor: Actor,
		scope: MissionScope,
		options: {
			decision?: AuditDecision;
			reason?: string;
			digest?: string;
			state?: ExecutionState;
			data?: unknown;
		} = {},
	): Promise<AuditEvent> {
		const event: AuditEvent = {
			schema: AUDIT_SCHEMA,
			eventId: this.id(),
			sequence: ++this.sequence,
			occurredAt: this.now(),
			sessionId: scope.sessionId,
			branchLeafId: scope.branchLeafId,
			missionRef: options.state?.missionRef ?? this.stateValue.missionRef,
			epoch: options.state?.epoch ?? this.stateValue.epoch,
			actor,
			action,
			decision: options.decision ?? "none",
			reason: options.reason,
			digest: options.digest,
			state: options.state ? cloneState(options.state) : undefined,
			data: options.data,
		};
		try {
			await this.journal.append(event);
			this.eventsValue.push(event);
			return event;
		} catch (error) {
			// Never reuse a sequence number: a writer may have persisted before surfacing an error.
			throw new AutopilotControllerError("STORAGE_ERROR", "Failed to append Autopilot audit event", false, error);
		}
	}

	private async commitState(next: ExecutionState, actor: Actor, scope: MissionScope, reason: string): Promise<void> {
		assertTransition(this.stateValue.status, next.status);
		const committed: ExecutionState = {
			...next,
			schema: STATE_SCHEMA,
			securityLevel: SECURITY_LEVEL,
			updatedAt: this.now(),
		};
		await this.appendAudit("state-committed", actor, scope, { reason, state: committed });
		this.stateValue = committed;
	}

	private async start(request: AutopilotActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "inactive") throw new AutopilotControllerError("INVALID_STATE", "Autopilot is already active");
		const goal = environment.goal?.trim();
		if (!goal) throw new AutopilotControllerError("INVALID_MISSION", "A non-empty mission goal is required", true);
		this.specValue = undefined;
		this.stageEvidence = [];
		await this.commitState(
			{
				...createInitialState(this.now(), environment.scope.ephemeralSession),
				status: "drafting",
				epoch: this.stateValue.epoch + 1,
				missionId: this.id(),
				reason: "Mission drafting active",
			},
			request.actor,
			environment.scope,
			"Autopilot started; goal body retained outside audit state",
		);
	}

	private async submit(request: AutopilotActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "drafting" && this.stateValue.status !== "dryrun") {
			throw new AutopilotControllerError("INVALID_STATE", `Cannot submit a mission while state=${this.stateValue.status}`);
		}
		if (!environment.draft || !isDraft(environment.draft)) throw new AutopilotControllerError("INVALID_MISSION", "Structured MissionDraft is required");
		let draft: MissionDraft;
		try {
			draft = normalizeDraft(environment.draft);
		} catch (error) {
			throw new AutopilotControllerError("INVALID_MISSION", error instanceof Error ? error.message : String(error), true);
		}
		const missionId = this.stateValue.missionId ?? this.stateValue.missionRef?.missionId ?? this.id();
		const suggestedVersion = (this.stateValue.missionRef?.version ?? 0) + 1;
		const version = await this.store.nextAvailableVersion(missionId, suggestedVersion);
		const parentVersion = this.stateValue.missionRef?.version ?? null;
		const withoutHash: Omit<MissionSpec, "contentHash"> = {
			schema: "dev.pi.autopilot-mission/v1",
			missionId,
			version,
			parentVersion,
			createdAt: this.now(),
			createdBy: request.actor,
			goal: draft.goal,
			facts: draft.facts ?? [],
			assumptions: draft.assumptions ?? [],
			scope: environment.scope,
			acceptance: draft.acceptance,
			pathScopes: draft.pathScopes ?? [],
			dependencyScopes: draft.dependencyScopes ?? [],
			risks: draft.risks ?? [],
			policyDigest: environment.policyDigest,
			contextDigest: environment.contextDigest,
			...(environment.workspaceSnapshot ? { workspaceSnapshot: environment.workspaceSnapshot } : {}),
		};
		const spec: MissionSpec = { ...withoutHash, contentHash: calculateMissionHash(withoutHash) };
		let paths;
		try {
			paths = await this.store.save(spec);
		} catch (error) {
			throw new AutopilotControllerError("STORAGE_ERROR", error instanceof Error ? error.message : String(error), false);
		}
		await this.appendAudit("artifact-written", request.actor, environment.scope, {
			digest: spec.contentHash,
			data: { missionRef: toMissionRef(spec), specPath: paths.spec, reviewPath: paths.review },
		});
		this.stageEvidence = [];
		await this.commitState(
			{
				...this.stateValue,
				status: "dryrun",
				epoch: this.stateValue.epoch + 1,
				missionId,
				missionRef: toMissionRef(spec),
				acResults: acState(spec),
				reason: "MissionSpec committed; acceptance dry-run required before execution",
			},
			request.actor,
			environment.scope,
			"Immutable MissionSpec version committed",
		);
		this.lastReportEvidenceCount = 0;
		this.specValue = spec;
	}

	private requireLoadedSpec(state: ExecutionState): MissionSpec {
		if (!this.specValue || !state.missionRef || !sameMissionRef(state.missionRef, this.specValue)) {
			throw new AutopilotControllerError("INVALID_STATE", "No MissionSpec matching the current state is loaded");
		}
		return this.specValue;
	}

	private newStageSuccessEvidence(): EvidenceRecord[] {
		return this.stageEvidence.slice(this.lastReportEvidenceCount).filter((evidence) => evidence.success);
	}

	private assertReportEvidence(spec: MissionSpec, results: readonly AcReportEntry[]): void {
		const claims = results.filter((entry) => entry.status === "ready" || entry.status === "pass");
		if (claims.length === 0) return;
		const successful = this.newStageSuccessEvidence();
		if (successful.length === 0) {
			throw new AutopilotControllerError(
				"EVIDENCE_REQUIRED",
				"pass/ready claims require at least one successful tool result in the current stage; run the verification commands first",
			);
		}
		for (const entry of claims) {
			if (!entry.evidence.trim()) {
				throw new AutopilotControllerError("EVIDENCE_REQUIRED", `Criterion ${entry.acId} needs an evidence summary naming the actual command/output`);
			}
			const criterion = spec.acceptance.find((candidate) => candidate.id === entry.acId);
			if (criterion && entry.evidence.trim().length > 4096) {
				throw new AutopilotControllerError("INVALID_MISSION", `Criterion ${entry.acId} evidence exceeds 4096 characters`, true);
			}
		}
	}

	private async report(request: AutopilotActionRequest, environment: ActionEnvironment): Promise<void> {
		const stage = this.stateValue.status;
		if (stage !== "dryrun" && stage !== "running") {
			throw new AutopilotControllerError("INVALID_STATE", `Reports are accepted only while dryrun or running (state=${stage})`);
		}
		const spec = this.requireLoadedSpec(this.stateValue);
		const rawResults = environment.results;
		if (!rawResults || rawResults.length === 0) throw new AutopilotControllerError("INVALID_ACTION", "At least one acceptance report entry is required", true);
		const normalized = rawResults
			.map((entry) => ({ acId: entry.acId.trim(), status: entry.status, evidence: entry.evidence.trim() }))
			.filter((entry) => entry.acId.length > 0);
		if (normalized.length === 0) throw new AutopilotControllerError("INVALID_ACTION", "Acceptance report entries are malformed", true);
		const byId = new Map(spec.acceptance.map((criterion) => [criterion.id, criterion]));
		for (const entry of normalized) {
			if (!byId.has(entry.acId)) {
				throw new AutopilotControllerError("INVALID_MISSION", `Report references unknown acceptance criterion: ${entry.acId}`);
			}
			const validStatus = stage === "dryrun" ? entry.status === "ready" || entry.status === "not_ready" : entry.status === "pass" || entry.status === "fail";
			if (!validStatus) {
				throw new AutopilotControllerError(
					"INVALID_ACTION",
					`Criterion ${entry.acId} status '${entry.status}' is invalid while state=${stage}`,
					true,
				);
			}
		}
		this.assertReportEvidence(spec, normalized);
		await this.appendAudit("report-submitted", request.actor, environment.scope, {
			digest: undefined,
			data: { stage, results: normalized },
		});

		const acResults = { ...this.stateValue.acResults };
		for (const entry of normalized) {
			acResults[entry.acId] = {
				status: entry.status,
				evidence: entry.evidence || undefined,
				evidenceCount: this.newStageSuccessEvidence().length,
				updatedAt: this.now(),
			};
		}
		const required = requiredAcceptance(spec);
		const allReady = required.every((criterion) => acResults[criterion.id]?.status === "ready");
		const allPass = required.every((criterion) => acResults[criterion.id]?.status === "pass");
		const nextStatus = stage === "dryrun" ? (allReady ? "running" : "dryrun") : allPass ? "completed" : "running";
		const reason =
			stage === "dryrun"
				? allReady
					? "All acceptance criteria dry-run verified; execution started"
					: "Acceptance dry-run incomplete; fix or re-verify before reporting ready"
				: allPass
					? "All required acceptance criteria passed"
					: "Acceptance not fully satisfied; continue developing and re-verify";
		await this.commitState(
			{
				...this.stateValue,
				status: nextStatus,
				epoch: this.stateValue.epoch + 1,
				acResults,
				reason,
			},
			request.actor,
			environment.scope,
			reason,
		);
		// Evidence older than this report no longer counts for the next one; the stage buffer itself stays
		// cumulative so the agent_end stagnation signature keeps growing only with real tool activity.
		this.lastReportEvidenceCount = this.stageEvidence.length;
	}

	private async pause(request: AutopilotActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "dryrun" && this.stateValue.status !== "running") {
			throw new AutopilotControllerError("INVALID_STATE", `Only dryrun or running autopilot can be paused (state=${this.stateValue.status})`);
		}
		const pausedFromStage = this.stateValue.status;
		await this.commitState(
			{
				...this.stateValue,
				status: "paused",
				epoch: this.stateValue.epoch + 1,
				pausedFromStage,
				reason: auditSummary(environment.reason, "Autopilot paused"),
			},
			request.actor,
			environment.scope,
			this.stateValue.reason ?? "Paused",
		);
	}

	private async resume(request: AutopilotActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "paused") throw new AutopilotControllerError("INVALID_STATE", "Only paused autopilot can resume");
		const target = this.stateValue.pausedFromStage ?? "running";
		this.stageEvidence = [];
		this.lastReportEvidenceCount = 0;
		await this.commitState(
			{
				...this.stateValue,
				status: target,
				epoch: this.stateValue.epoch + 1,
				pausedFromStage: undefined,
				reason: "Autopilot resumed; stage evidence reset, re-run verification before reporting",
			},
			request.actor,
			environment.scope,
			"Resumed",
		);
	}

	private async cancel(request: AutopilotActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status === "inactive" || isTerminal(this.stateValue.status)) {
			throw new AutopilotControllerError("INVALID_STATE", `Cannot cancel while state=${this.stateValue.status}`);
		}
		await this.commitState(
			{
				...this.stateValue,
				status: "cancelled",
				epoch: this.stateValue.epoch + 1,
				reason: auditSummary(environment.reason, "Autopilot cancelled"),
			},
			request.actor,
			environment.scope,
			this.stateValue.reason ?? "Cancelled",
		);
	}

	private async reset(request: AutopilotActionRequest, environment: ActionEnvironment): Promise<void> {
		if (!isTerminal(this.stateValue.status)) {
			throw new AutopilotControllerError("INVALID_STATE", "Reset is allowed only from completed, cancelled or failed state");
		}
		const next = { ...createInitialState(this.now(), environment.scope.ephemeralSession), epoch: this.stateValue.epoch + 1 };
		await this.commitState(next, request.actor, environment.scope, "Reset returned Autopilot to inactive");
		this.specValue = undefined;
		this.stageEvidence = [];
	}

	private async runAction(request: AutopilotActionRequest, environment: ActionEnvironment): Promise<unknown> {
		if (request.protocolVersion !== ACTION_PROTOCOL) throw new AutopilotControllerError("INVALID_ACTION", "Unsupported action protocol version");
		switch (request.action) {
			case "start":
				return this.start(request, environment);
			case "submit":
				return this.submit(request, environment);
			case "report":
				return this.report(request, environment);
			case "pause":
				return this.pause(request, environment);
			case "resume":
				return this.resume(request, environment);
			case "cancel":
				return this.cancel(request, environment);
			case "reset":
				return this.reset(request, environment);
			case "status":
			case "show":
			case "audit":
				return undefined;
			default:
				throw new AutopilotControllerError("INVALID_ACTION", `Unknown action: ${String(request.action)}`);
		}
	}

	async dispatch(request: AutopilotActionRequest, environment: ActionEnvironment): Promise<AutopilotActionResult> {
		return this.mutex.run(async () => {
			try {
				const data = await this.runAction(request, environment);
				return {
					requestId: request.requestId,
					ok: true,
					state: cloneState(this.stateValue),
					missionRef: this.stateValue.missionRef,
					data,
				};
			} catch (error) {
				return errorResult(request, this.stateValue, error);
			}
		});
	}

	async recordPolicyDecision(
		actor: Actor,
		scope: MissionScope,
		toolName: string,
		toolCallId: string,
		allow: boolean,
		reason: string,
		digest?: string,
	): Promise<void> {
		await this.mutex.run(async () => {
			await this.appendAudit("tool-policy-decision", actor, scope, {
				decision: allow ? "allow" : "deny",
				reason,
				digest,
				data: { toolName, toolCallId },
			});
		});
	}

	async recordToolResult(
		actor: Actor,
		scope: MissionScope,
		input: { toolName: string; toolCallId: string; success: boolean; summary: string; digest?: string },
	): Promise<void> {
		await this.mutex.run(async () => {
			if (!isActiveStage(this.stateValue.status)) return;
			const evidence: EvidenceRecord = {
				schema: "dev.pi.autopilot-evidence/v1",
				evidenceId: this.id(),
				stage: this.stateValue.status,
				actor,
				recordedAt: this.now(),
				success: input.success,
				summary: input.summary,
				digest: input.digest,
				toolCallId: input.toolCallId,
				toolName: input.toolName,
			};
			await this.appendAudit("evidence-recorded", actor, scope, {
				decision: input.success ? "allow" : "deny",
				data: evidence,
			});
			this.stageEvidence.push(evidence);
		});
	}

	async recover(
		entries: readonly SessionEntryLike[],
		reason: "startup" | "reload" | "new" | "resume" | "fork" | "tree",
		scope: MissionScope,
		currentDigests?: { policyDigest: string; contextDigest: string },
	): Promise<void> {
		await this.mutex.run(async () => {
			const projection = projectJournal(entries);
			this.sequence = projection.maxSequence;
			this.eventsValue.length = 0;
			this.eventsValue.push(...projection.events);
			this.stageEvidence = [];
			this.lastReportEvidenceCount = 0;
			this.stateValue = projection.state ?? createInitialState(this.now(), scope.ephemeralSession);
			this.specValue = undefined;

			if (projection.corruptReason) {
				this.stateValue = {
					...this.stateValue,
					status: "failed",
					epoch: this.stateValue.epoch + 1,
					reason: `Audit recovery failed closed: ${projection.corruptReason}`,
					updatedAt: this.now(),
				};
				// Do not append behind a corrupt point: future scans would stop before it and create a loop.
				return;
			}

			if (!this.stateValue.missionRef) return;
			try {
				this.specValue = await this.store.load(this.stateValue.missionRef);
			} catch (error) {
				await this.commitState(
					{
						...this.stateValue,
						status: "failed",
						epoch: this.stateValue.epoch + 1,
						reason: `MissionSpec recovery failed: ${error instanceof Error ? error.message : String(error)}`,
					},
					{ channel: "system", id: "recovery" },
					scope,
					"Recovery failed",
				);
				return;
			}

			let safeStatus = this.stateValue.status;
			let safeReason: string | undefined;
			let safePausedFromStage = this.stateValue.pausedFromStage;
			if (this.stateValue.status === "dryrun" || this.stateValue.status === "running") {
				// An active stage never resumes automatically; evidence is reset and must be re-earned.
				safeStatus = "paused";
				safeReason = `Autopilot ${this.stateValue.status} recovered as paused; stage evidence was reset`;
				safePausedFromStage = this.stateValue.status;
			} else if (this.stateValue.status === "paused" && this.stateValue.pausedFromStage === undefined) {
				safeReason = "Autopilot recovered as paused; stage target was lost";
				safePausedFromStage = "running";
			}
			if (
				reason !== "fork" &&
				currentDigests &&
				new Set(["dryrun", "running", "paused"]).has(this.stateValue.status) &&
				this.specValue &&
				(this.specValue.policyDigest !== currentDigests.policyDigest || this.specValue.contextDigest !== currentDigests.contextDigest)
			) {
				safeStatus = "paused";
				safeReason = "Policy or context digest drifted during recovery; re-verify before continuing";
			}
			if (safeStatus !== this.stateValue.status || safeReason !== undefined) {
				await this.commitState(
					{
						...this.stateValue,
						status: safeStatus,
						epoch: this.stateValue.epoch + 1,
						pausedFromStage: safePausedFromStage,
						reason: safeReason,
					},
					{ channel: "system", id: "recovery" },
					scope,
					safeReason ?? "Recovered",
				);
			}
		});
	}
}

function isActiveStage(status: ExecutionState["status"]): status is "dryrun" | "running" {
	return status === "dryrun" || status === "running";
}
