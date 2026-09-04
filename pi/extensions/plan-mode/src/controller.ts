import { randomUUID } from "node:crypto";
import type { PlanArtifactStore } from "./artifact-store.ts";
import { calculatePlanHash, canonicalJson, materializeSteps, normalizeDraft, sha256 } from "./canonical.ts";
import { diffPlanSpecs, type PlanDiff } from "./diff.ts";
import {
	ACTION_PROTOCOL,
	AUDIT_SCHEMA,
	SECURITY_LEVEL,
	STATE_SCHEMA,
	createInitialState,
	samePlanRef,
	toPlanRef,
	type ActionEnvironment,
	type Actor,
	type ApprovalRecord,
	type AuditDecision,
	type AuditEvent,
	type EvidenceRecord,
	type ExecutionState,
	type PlanActionRequest,
	type PlanActionResult,
	type PlanDraft,
	type PlanErrorCode,
	type PlanRef,
	type PlanScope,
	type PlanSpec,
	type ResearchCapability,
	type ResearchPermissionDecision,
	type ResearchPermissionRecord,
	type StepExecutionState,
	type ToolBaselineRecord,
} from "./domain.ts";
import {
	importedRef,
	isLegacyPlanSpec,
	legacyPlanRef,
	legacyToDraft,
	type LegacyExecutionState,
	type LegacyPlanSpec,
} from "./legacy-v1.ts";
import { projectJournal, researchPermissionKey, type SessionEntryLike } from "./journal.ts";
import { assertTransition, isTerminal } from "./state-machine.ts";
import { activeToolsDigest, MANDATORY_IMPLEMENTATION_TOOLS } from "./tool-session.ts";

export interface AuditJournalWriter {
	append(event: AuditEvent): Promise<void> | void;
}

export interface PlanControllerOptions {
	readonly store: PlanArtifactStore;
	readonly journal: AuditJournalWriter;
	readonly now?: () => string;
	readonly id?: () => string;
}

export interface RecoveryEnvironment {
	readonly activeTools?: readonly string[];
}

export class PlanControllerError extends Error {
	readonly code: PlanErrorCode;
	readonly retryable: boolean;
	readonly details?: unknown;

	constructor(code: PlanErrorCode, message: string, retryable = false, details?: unknown) {
		super(message);
		this.name = "PlanControllerError";
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

function trustedUserActor(actor: Actor): boolean {
	return actor.channel !== "model" && actor.channel !== "system";
}

function cloneState(state: ExecutionState): ExecutionState {
	return structuredClone(state);
}

function auditSummary(value: string | undefined, fallback: string): string {
	if (!value?.trim()) return fallback;
	return value
		.trim()
		.replace(/((?:password|passwd|token|secret|api[-_]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
		.slice(0, 512);
}

function stepProjection(spec: PlanSpec): Record<string, StepExecutionState> {
	return Object.fromEntries(
		spec.steps.map((step) => [
			step.id,
			{ status: "pending", reportIds: [], evidenceIds: [] } satisfies StepExecutionState,
		]),
	);
}

function isDraft(value: unknown): value is PlanDraft {
	return value !== null && typeof value === "object" && "goal" in value && "steps" in value && Array.isArray((value as PlanDraft).steps);
}

function errorResult(request: PlanActionRequest, state: ExecutionState, error: unknown): PlanActionResult {
	const normalized =
		error instanceof PlanControllerError
			? error
			: new PlanControllerError("STORAGE_ERROR", error instanceof Error ? error.message : String(error), false);
	return {
		requestId: request.requestId,
		ok: false,
		state: cloneState(state),
		planRef: state.planRef,
		pendingInput: state.pendingInput,
		error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable, details: normalized.details },
	};
}

function legacySteps(spec: LegacyPlanSpec, state: LegacyExecutionState | undefined): Record<string, StepExecutionState> {
	return Object.fromEntries(
		spec.steps.map((step) => {
			const old = state?.steps?.[step.id];
			const status = old?.status === "verified" ? "completed" : old?.status === "failed" ? "failed" : old?.status === "running" ? "running" : "pending";
			return [step.id, { status, reportIds: [], evidenceIds: [...(old?.evidenceIds ?? [])], reason: old?.reason } satisfies StepExecutionState];
		}),
	);
}

export class PlanController {
	private readonly store: PlanArtifactStore;
	private readonly journal: AuditJournalWriter;
	private readonly now: () => string;
	private readonly id: () => string;
	private readonly mutex = new AsyncMutex();
	private stateValue: ExecutionState;
	private sequence = 0;
	private specValue?: PlanSpec;
	private legacySpecValue?: LegacyPlanSpec;
	private approvalValue?: ApprovalRecord;
	private baselineValue?: ToolBaselineRecord;
	private readonly permissions = new Map<string, ResearchPermissionRecord>();
	private readonly evidence = new Map<string, EvidenceRecord>();
	private eventsValue: AuditEvent[] = [];

	constructor(options: PlanControllerOptions) {
		this.store = options.store;
		this.journal = options.journal;
		this.now = options.now ?? (() => new Date().toISOString());
		this.id = options.id ?? randomUUID;
		this.stateValue = createInitialState(this.now());
	}

	get state(): ExecutionState {
		return cloneState(this.stateValue);
	}

	get spec(): PlanSpec | undefined {
		return this.specValue ? structuredClone(this.specValue) : undefined;
	}

	get legacySpec(): LegacyPlanSpec | undefined {
		return this.legacySpecValue ? structuredClone(this.legacySpecValue) : undefined;
	}

	get approval(): ApprovalRecord | undefined {
		return this.approvalValue ? structuredClone(this.approvalValue) : undefined;
	}

	get baseline(): ToolBaselineRecord | undefined {
		return this.baselineValue ? structuredClone(this.baselineValue) : undefined;
	}

	get researchPermissions(): ReadonlyMap<string, ResearchPermissionRecord> {
		return new Map([...this.permissions].map(([key, value]) => [key, structuredClone(value)]));
	}

	get events(): readonly AuditEvent[] {
		return structuredClone(this.eventsValue);
	}

	newOpaqueId(): string {
		return this.id();
	}

	private async appendAudit(
		action: string,
		actor: Actor,
		scope: PlanScope,
		options: { decision?: AuditDecision; reason?: string; digest?: string; state?: ExecutionState; data?: unknown } = {},
	): Promise<AuditEvent> {
		const event: AuditEvent = {
			schema: AUDIT_SCHEMA,
			eventId: this.id(),
			sequence: ++this.sequence,
			occurredAt: this.now(),
			sessionId: scope.sessionId,
			branchLeafId: scope.branchLeafId,
			planRef: options.state?.planRef ?? this.stateValue.planRef,
			revision: options.state?.revision ?? this.stateValue.revision,
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
			throw new PlanControllerError("STORAGE_ERROR", "Failed to append Plan Mode audit event", false, error);
		}
	}

	private async commitState(next: ExecutionState, actor: Actor, scope: PlanScope, reason: string, validate = true): Promise<void> {
		if (validate) assertTransition(this.stateValue.status, next.status);
		const committed: ExecutionState = {
			...next,
			schema: STATE_SCHEMA,
			securityLevel: SECURITY_LEVEL,
			updatedAt: this.now(),
		};
		await this.appendAudit("state-committed", actor, scope, { reason, state: committed });
		this.stateValue = committed;
	}

	private requireTrustedActor(actor: Actor): void {
		if (!trustedUserActor(actor)) throw new PlanControllerError("APPROVAL_REQUIRED", "The model or system actor cannot approve implementation");
	}

	private requireExpected(expected: PlanRef | undefined): PlanRef {
		if (!expected || !samePlanRef(expected, this.stateValue.planRef)) {
			throw new PlanControllerError("PLAN_REF_MISMATCH", "Action requires the exact current planId, version and contentHash");
		}
		return expected;
	}

	private requireV2Spec(expected?: PlanRef): PlanSpec {
		if (!this.specValue || (expected && !samePlanRef(expected, this.specValue))) {
			throw new PlanControllerError(
				this.legacySpecValue ? "INVALID_STATE" : "PLAN_REF_MISMATCH",
				this.legacySpecValue ? "Legacy v1 plan must be migrated before implementation" : "Loaded PlanSpec does not match the current reference",
			);
		}
		return this.specValue;
	}

	private async start(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "inactive") throw new PlanControllerError("INVALID_STATE", "Plan Mode is already active");
		const goal = environment.goal?.trim();
		if (!goal) throw new PlanControllerError("INVALID_PLAN", "A non-empty planning goal is required", true);
		const baseline = environment.baseline;
		if (!baseline || baseline.planId === "" || baseline.toolNames.length === 0) {
			throw new PlanControllerError("TOOL_UNAVAILABLE", "A persisted pre-plan tool baseline is required");
		}
		await this.appendAudit("tool-baseline-captured", request.actor, environment.scope, {
			digest: activeToolsDigest(baseline.toolNames),
			data: baseline,
		});
		this.baselineValue = structuredClone(baseline);
		this.specValue = undefined;
		this.legacySpecValue = undefined;
		this.approvalValue = undefined;
		this.permissions.clear();
		this.evidence.clear();
		await this.commitState(
			{
				...createInitialState(this.now(), environment.scope.ephemeralSession),
				status: "planning",
				revision: this.stateValue.revision + 1,
				planId: baseline.planId,
				baselineId: baseline.baselineId,
				reason: "Planning is read-only",
			},
			request.actor,
			environment.scope,
			"Tool baseline persisted before entering planning",
		);
	}

	private async requestInput(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "planning" || request.actor.channel !== "model") {
			throw new PlanControllerError("INVALID_STATE", "Only the planning model can request clarification");
		}
		const question = environment.question?.trim();
		if (!question) throw new PlanControllerError("INVALID_ACTION", "A clarification question is required");
		await this.commitState(
			{
				...this.stateValue,
				status: "awaiting_input",
				revision: this.stateValue.revision + 1,
				pendingInput: {
					kind: environment.choices?.length ? "select" : "text",
					prompt: question.slice(0, 2000),
					choices: environment.choices?.map((value) => value.trim()).filter(Boolean).slice(0, 20),
				},
				reason: "Waiting for material clarification",
			},
			request.actor,
			environment.scope,
			"Structured clarification requested",
		);
	}

	private async answerInput(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "awaiting_input") throw new PlanControllerError("INVALID_STATE", "No clarification is pending");
		this.requireTrustedActor(request.actor);
		await this.appendAudit("clarification-answered", request.actor, environment.scope, {
			digest: environment.note ? sha256(environment.note) : undefined,
			reason: "Answer body redacted; digest recorded",
		});
		await this.commitState(
			{
				...this.stateValue,
				status: "planning",
				revision: this.stateValue.revision + 1,
				pendingInput: undefined,
				reason: "Clarification received",
			},
			request.actor,
			environment.scope,
			"Planning resumed after clarification",
		);
	}

	private async submit(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "planning" && this.stateValue.status !== "review") {
			throw new PlanControllerError("INVALID_STATE", `Cannot submit a plan while state=${this.stateValue.status}`);
		}
		if (request.actor.channel !== "model") throw new PlanControllerError("INVALID_ACTION", "plan_submit is reserved for the planning model");
		if (!environment.draft || !isDraft(environment.draft)) throw new PlanControllerError("INVALID_PLAN", "Structured PlanDraft v2 is required");
		const draft = normalizeDraft(environment.draft);
		const planId = this.stateValue.planId ?? this.id();
		const parentVersion = this.specValue?.planId === planId ? this.specValue.version : null;
		const version = await this.store.nextAvailableVersion(planId, (parentVersion ?? 0) + 1);
		const withoutHash: Omit<PlanSpec, "contentHash"> = {
			schema: "dev.pi.plan/v2",
			planId,
			version,
			parentVersion,
			...(this.specValue?.importedFrom ? { importedFrom: this.specValue.importedFrom } : {}),
			...(this.specValue?.forkedFrom ? { forkedFrom: this.specValue.forkedFrom } : {}),
			createdAt: this.now(),
			createdBy: request.actor,
			goal: draft.goal,
			decisions: draft.decisions ?? [],
			scope: environment.scope,
			steps: materializeSteps(draft),
			risks: draft.risks ?? [],
		};
		const spec: PlanSpec = { ...withoutHash, contentHash: calculatePlanHash(withoutHash) };
		let paths;
		try {
			paths = await this.store.save(spec);
		} catch (error) {
			throw new PlanControllerError("STORAGE_ERROR", error instanceof Error ? error.message : String(error), false);
		}
		await this.appendAudit("artifact-written", request.actor, environment.scope, {
			digest: spec.contentHash,
			data: { planRef: toPlanRef(spec), specPath: paths.spec, reviewPath: paths.review },
		});
		const next: ExecutionState = {
			...this.stateValue,
			status: "review",
			revision: this.stateValue.revision + 1,
			planId,
			planRef: toPlanRef(spec),
			approvalId: undefined,
			currentStepId: spec.steps[0]?.id,
			steps: stepProjection(spec),
			pendingInput: undefined,
			reason: "PlanSpec v2 ready for review",
		};
		await this.commitState(next, request.actor, environment.scope, "Immutable PlanSpec v2 committed");
		this.specValue = spec;
		this.legacySpecValue = undefined;
		this.approvalValue = undefined;
		this.evidence.clear();
	}

	private async continuePlanning(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "review" && this.stateValue.status !== "paused") {
			throw new PlanControllerError("INVALID_STATE", "Only review or paused plans can return to planning");
		}
		this.requireTrustedActor(request.actor);
		if (request.action === "edit_feedback") {
			const feedback = environment.feedback?.trim();
			if (!feedback) throw new PlanControllerError("INVALID_ACTION", "Plan edit feedback is required", true);
			await this.appendAudit("plan-edit-feedback", request.actor, environment.scope, {
				digest: sha256(feedback),
				reason: "Feedback body redacted; digest recorded",
			});
		}
		await this.commitState(
			{
				...this.stateValue,
				status: "planning",
				revision: this.stateValue.revision + 1,
				runRevision: this.stateValue.runRevision + 1,
				approvalId: undefined,
				reason: request.action === "edit_feedback" ? "Plan revision requested" : "Planning continued by user",
			},
			request.actor,
			environment.scope,
			request.action === "edit_feedback" ? "Returned to planning with edit feedback" : "Returned to planning",
		);
		this.approvalValue = undefined;
	}

	private async implement(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "review" && this.stateValue.status !== "paused") {
			throw new PlanControllerError("INVALID_STATE", "Implementation can start only from review or paused state");
		}
		this.requireTrustedActor(request.actor);
		const expected = this.requireExpected(request.expectedPlan);
		const spec = this.requireV2Spec(expected);
		const activeTools = [...new Set(environment.activeTools ?? [])];
		const missing = MANDATORY_IMPLEMENTATION_TOOLS.filter((name) => !activeTools.includes(name));
		if (missing.length > 0) {
			throw new PlanControllerError("TOOL_UNAVAILABLE", `Implementation tool readback is missing: ${missing.join(", ")}`, true);
		}
		const digest = activeToolsDigest(activeTools);
		if (!environment.activeToolsDigest || environment.activeToolsDigest !== digest) {
			throw new PlanControllerError("TOOL_UNAVAILABLE", "Implementation active-tool digest is absent or inconsistent", true);
		}
		if (!this.baselineValue && environment.baseline) {
			await this.appendAudit("tool-baseline-captured", request.actor, environment.scope, {
				digest: activeToolsDigest(environment.baseline.toolNames),
				data: environment.baseline,
			});
			this.baselineValue = structuredClone(environment.baseline);
		}
		if (!this.baselineValue) throw new PlanControllerError("TOOL_UNAVAILABLE", "Cannot implement without a persisted tool baseline", true);
		const approval: ApprovalRecord = {
			schema: "dev.pi.plan-approval/v2",
			approvalId: this.id(),
			nonce: this.id(),
			planRef: expected,
			subject: request.actor,
			approvedAt: this.now(),
			sessionId: environment.scope.sessionId,
			branchEntryId: environment.scope.branchLeafId,
			activeToolsDigest: digest,
		};
		await this.appendAudit("approval-created", request.actor, environment.scope, {
			decision: "allow",
			digest,
			data: approval,
		});
		const steps = structuredClone(this.stateValue.steps) as Record<string, StepExecutionState>;
		const currentStepId =
			this.stateValue.currentStepId ?? spec.steps.find((step) => steps[step.id]?.status !== "completed")?.id;
		if (!currentStepId) throw new PlanControllerError("INVALID_PLAN", "Plan has no incomplete step");
		steps[currentStepId] = { ...steps[currentStepId], status: "running" };
		await this.commitState(
			{
				...this.stateValue,
				status: "implementing",
				revision: this.stateValue.revision + 1,
				runRevision: this.stateValue.runRevision + 1,
				approvalId: approval.approvalId,
				baselineId: this.baselineValue.baselineId,
				currentStepId,
				steps,
				reason: `Implementation started at ${currentStepId} with verified active tools`,
			},
			request.actor,
			environment.scope,
			"Approval committed after implementation tools were read back",
		);
		this.approvalValue = approval;
	}

	private async pause(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status === "stale") {
			await this.appendAudit("blocker-reported", request.actor, environment.scope, {
				reason: auditSummary(environment.reason, "Blocker reported against stale plan"),
			});
			return;
		}
		if (this.stateValue.status !== "implementing") {
			throw new PlanControllerError("INVALID_STATE", "Only implementing plans can be paused");
		}
		await this.commitState(
			{
				...this.stateValue,
				status: "paused",
				revision: this.stateValue.revision + 1,
				runRevision: this.stateValue.runRevision + 1,
				approvalId: undefined,
				reason: auditSummary(environment.reason, "Implementation paused"),
			},
			request.actor,
			environment.scope,
			auditSummary(environment.reason, "Implementation paused"),
		);
		this.approvalValue = undefined;
	}

	private async completeStep(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (request.actor.channel !== "model") throw new PlanControllerError("INVALID_ACTION", "Step reports are reserved for the implementing model");
		if (this.stateValue.status === "stale") {
			await this.appendAudit("step-report-received", request.actor, environment.scope, {
				reason: auditSummary(environment.note, "Step report received while stale; no progress applied"),
			});
			return;
		}
		if (this.stateValue.status !== "implementing") {
			throw new PlanControllerError("INVALID_STATE", "Step completion requires an implementing plan");
		}
		const spec = this.requireV2Spec();
		const stepId = environment.stepId ?? this.stateValue.currentStepId;
		const step = spec.steps.find((candidate) => candidate.id === stepId);
		if (!stepId || stepId !== this.stateValue.currentStepId || !step || !this.stateValue.steps[stepId]) {
			throw new PlanControllerError("INVALID_ACTION", "Only the current step can be completed");
		}
		const note = environment.note?.trim();
		if (!note) throw new PlanControllerError("INVALID_ACTION", "A non-empty step summary is required", true);
		const report: EvidenceRecord = {
			schema: "dev.pi.plan-evidence/v2",
			evidenceId: this.id(),
			planRef: this.stateValue.planRef!,
			stepId,
			kind: "step-report",
			actor: request.actor,
			recordedAt: this.now(),
			success: true,
			summary: auditSummary(note, "Step completed"),
		};
		await this.appendAudit("evidence-recorded", request.actor, environment.scope, { decision: "allow", data: report });
		this.evidence.set(report.evidenceId, report);
		const steps = structuredClone(this.stateValue.steps) as Record<string, StepExecutionState>;
		steps[stepId] = {
			...steps[stepId],
			status: "completed",
			reportIds: [...steps[stepId].reportIds, report.evidenceId],
			summary: report.summary,
		};
		const nextStep = spec.steps.find((candidate) => steps[candidate.id]?.status !== "completed");
		if (nextStep) steps[nextStep.id] = { ...steps[nextStep.id], status: "running" };
		const completed = nextStep === undefined;
		await this.commitState(
			{
				...this.stateValue,
				status: completed ? "completed" : "implementing",
				revision: this.stateValue.revision + 1,
				stepRevision: this.stateValue.stepRevision + 1,
				approvalId: completed ? undefined : this.stateValue.approvalId,
				currentStepId: nextStep?.id,
				steps,
				reason: completed ? "All plan steps reported complete" : `Step ${stepId} reported complete`,
			},
			request.actor,
			environment.scope,
			completed ? "Plan implementation complete" : `Advanced from ${stepId} to ${nextStep?.id}`,
		);
		if (completed) this.approvalValue = undefined;
	}

	private async cancel(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status === "inactive" || isTerminal(this.stateValue.status)) {
			throw new PlanControllerError("INVALID_STATE", `Cannot cancel while state=${this.stateValue.status}`);
		}
		await this.commitState(
			{
				...this.stateValue,
				status: "cancelled",
				revision: this.stateValue.revision + 1,
				runRevision: this.stateValue.runRevision + 1,
				approvalId: undefined,
				reason: auditSummary(environment.reason, "Plan cancelled"),
			},
			request.actor,
			environment.scope,
			auditSummary(environment.reason, "Plan cancelled"),
		);
		this.approvalValue = undefined;
	}

	private async migrateLegacy(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "paused" || !this.legacySpecValue) {
			throw new PlanControllerError("INVALID_STATE", "No paused legacy v1 plan is available to migrate");
		}
		this.requireTrustedActor(request.actor);
		const expected = this.requireExpected(request.expectedPlan);
		if (!samePlanRef(expected, legacyPlanRef(this.legacySpecValue))) throw new PlanControllerError("PLAN_REF_MISMATCH", "Legacy PlanRef mismatch");
		const baseline = environment.baseline;
		if (!baseline) throw new PlanControllerError("TOOL_UNAVAILABLE", "Migration requires a fresh persisted tool baseline", true);
		const draft = normalizeDraft(legacyToDraft(this.legacySpecValue));
		const withoutHash: Omit<PlanSpec, "contentHash"> = {
			schema: "dev.pi.plan/v2",
			planId: baseline.planId,
			version: 1,
			parentVersion: null,
			importedFrom: importedRef(this.legacySpecValue),
			createdAt: this.now(),
			createdBy: request.actor,
			goal: draft.goal,
			decisions: draft.decisions ?? [],
			scope: environment.scope,
			steps: materializeSteps(draft),
			risks: draft.risks ?? [],
		};
		const spec: PlanSpec = { ...withoutHash, contentHash: calculatePlanHash(withoutHash) };
		const paths = await this.store.save(spec);
		await this.appendAudit("tool-baseline-captured", request.actor, environment.scope, {
			digest: activeToolsDigest(baseline.toolNames),
			data: baseline,
		});
		await this.appendAudit("artifact-written", request.actor, environment.scope, {
			digest: spec.contentHash,
			data: { planRef: toPlanRef(spec), specPath: paths.spec, reviewPath: paths.review, importedFrom: spec.importedFrom },
		});
		const sourceSteps = this.stateValue.steps;
		const steps = Object.fromEntries(
			spec.steps.map((step, index) => {
				const old = sourceSteps[this.legacySpecValue!.steps[index]?.id ?? ""];
				return [step.id, old ? { ...old, reportIds: [] } : { status: "pending", reportIds: [], evidenceIds: [] }];
			}),
		) as Record<string, StepExecutionState>;
		const currentStepId = spec.steps.find((step) => steps[step.id]?.status !== "completed")?.id;
		await this.commitState(
			{
				...createInitialState(this.now(), environment.scope.ephemeralSession),
				status: "paused",
				revision: this.stateValue.revision + 1,
				runRevision: this.stateValue.runRevision + 1,
				stepRevision: this.stateValue.stepRevision,
				planId: spec.planId,
				planRef: toPlanRef(spec),
				baselineId: baseline.baselineId,
				currentStepId,
				steps,
				reason: "Legacy v1 plan migrated to v2; implementation requires confirmation",
			},
			request.actor,
			environment.scope,
			"Legacy v1 plan copied to a new v2 lineage",
			false,
		);
		this.specValue = spec;
		this.legacySpecValue = undefined;
		this.baselineValue = structuredClone(baseline);
		this.approvalValue = undefined;
	}

	private async diffVersions(environment: ActionEnvironment): Promise<PlanDiff> {
		const current = this.stateValue.planRef;
		if (!current || !this.specValue) throw new PlanControllerError("INVALID_STATE", "No v2 PlanSpec lineage is available to diff");
		const toVersion = environment.toVersion ?? current.version;
		if (!Number.isSafeInteger(toVersion) || toVersion < 1) throw new PlanControllerError("INVALID_ACTION", "diff versions must be positive integers", true);
		const after = await this.store.loadVersion(current.planId, toVersion);
		if (toVersion === current.version && !samePlanRef(current, after)) {
			throw new PlanControllerError("PLAN_REF_MISMATCH", "Current diff target no longer matches the authoritative PlanRef");
		}
		const fromVersion = environment.fromVersion ?? after.parentVersion;
		if (typeof fromVersion !== "number" || !Number.isSafeInteger(fromVersion) || fromVersion < 1) {
			throw new PlanControllerError("INVALID_ACTION", "diff requires an explicit source version or a target with parentVersion", true);
		}
		return diffPlanSpecs(await this.store.loadVersion(current.planId, fromVersion), after);
	}

	private async runAction(request: PlanActionRequest, environment: ActionEnvironment): Promise<unknown> {
		if (request.protocolVersion !== ACTION_PROTOCOL) throw new PlanControllerError("INVALID_ACTION", "Unsupported action protocol version");
		switch (request.action) {
			case "start":
				return this.start(request, environment);
			case "request_input":
				return this.requestInput(request, environment);
			case "answer":
				return this.answerInput(request, environment);
			case "submit":
				return this.submit(request, environment);
			case "continue_planning":
			case "edit_feedback":
				return this.continuePlanning(request, environment);
			case "implement":
			case "run":
			case "resume":
				return this.implement(request, environment);
			case "complete_step":
				return this.completeStep(request, environment);
			case "block":
			case "pause":
				return this.pause(request, environment);
			case "cancel":
				return this.cancel(request, environment);
			case "migrate_v1":
				return this.migrateLegacy(request, environment);
			case "diff":
				return this.diffVersions(environment);
			case "show":
				return this.specValue ?? this.legacySpecValue;
			case "status":
			case "audit":
				return undefined;
			default:
				throw new PlanControllerError("INVALID_ACTION", `Unknown action: ${String(request.action)}`);
		}
	}

	async dispatch(request: PlanActionRequest, environment: ActionEnvironment): Promise<PlanActionResult> {
		return this.mutex.run(async () => {
			try {
				const data = await this.runAction(request, environment);
				return {
					requestId: request.requestId,
					ok: true,
					state: cloneState(this.stateValue),
					planRef: this.stateValue.planRef,
					approvalRef: this.stateValue.approvalId,
					pendingInput: this.stateValue.pendingInput,
					data,
				};
			} catch (error) {
				return errorResult(request, this.stateValue, error);
			}
		});
	}

	async recordResearchPermission(
		actor: Actor,
		scope: PlanScope,
		input: {
			toolName: string;
			capabilities: readonly ResearchCapability[];
			sourceDigest: string;
			decision: ResearchPermissionDecision;
		},
	): Promise<ResearchPermissionRecord> {
		return this.mutex.run(async () => {
			this.requireTrustedActor(actor);
			if (!this.stateValue.planId || !new Set(["planning", "review", "paused"]).has(this.stateValue.status)) {
				throw new PlanControllerError("INVALID_STATE", "Research permissions require an active non-implementing plan");
			}
			const record: ResearchPermissionRecord = {
				schema: "dev.pi.plan-research-permission/v2",
				permissionId: this.id(),
				planId: this.stateValue.planId,
				toolName: input.toolName,
				capabilities: [...input.capabilities],
				sourceDigest: input.sourceDigest,
				decision: input.decision,
				subject: actor,
				decidedAt: this.now(),
				sessionId: scope.sessionId,
				branchEntryId: scope.branchLeafId,
			};
			await this.appendAudit("research-permission-decided", actor, scope, {
				decision: input.decision,
				digest: input.sourceDigest,
				data: record,
			});
			this.permissions.set(researchPermissionKey(record), record);
			return structuredClone(record);
		});
	}

	async recordPolicyDecision(
		actor: Actor,
		scope: PlanScope,
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
		scope: PlanScope,
		input: { toolName: string; toolCallId: string; success: boolean; summary: string; digest?: string },
	): Promise<void> {
		await this.mutex.run(async () => {
			if (this.stateValue.status !== "implementing" || !this.stateValue.planRef || !this.stateValue.currentStepId) return;
			const record: EvidenceRecord = {
				schema: "dev.pi.plan-evidence/v2",
				evidenceId: this.id(),
				planRef: this.stateValue.planRef,
				stepId: this.stateValue.currentStepId,
				kind: "tool-result",
				actor,
				recordedAt: this.now(),
				success: input.success,
				summary: input.summary,
				digest: input.digest,
				toolCallId: input.toolCallId,
				toolName: input.toolName,
			};
			await this.appendAudit("evidence-recorded", actor, scope, { decision: input.success ? "allow" : "deny", data: record });
			this.evidence.set(record.evidenceId, record);
			const steps = structuredClone(this.stateValue.steps) as Record<string, StepExecutionState>;
			const current = steps[this.stateValue.currentStepId];
			steps[this.stateValue.currentStepId] = { ...current, evidenceIds: [...current.evidenceIds, record.evidenceId] };
			await this.commitState(
				{ ...this.stateValue, revision: this.stateValue.revision + 1, steps },
				actor,
				scope,
				`Information-only tool evidence recorded for ${input.toolName}`,
			);
		});
	}

	async archive(actor: Actor, scope: PlanScope, reason = "Plan tracking archived"): Promise<void> {
		await this.mutex.run(async () => {
			if (!isTerminal(this.stateValue.status) && this.stateValue.status !== "stale") {
				throw new PlanControllerError("INVALID_STATE", "Only terminal or stale plans can be archived");
			}
			await this.commitState(
				{
					...createInitialState(this.now(), scope.ephemeralSession),
					revision: this.stateValue.revision + 1,
					runRevision: this.stateValue.runRevision + 1,
					stepRevision: this.stateValue.stepRevision,
				},
				actor,
				scope,
				reason,
			);
			this.specValue = undefined;
			this.legacySpecValue = undefined;
			this.approvalValue = undefined;
			this.baselineValue = undefined;
			this.permissions.clear();
			this.evidence.clear();
		});
	}

	async markStale(actor: Actor, scope: PlanScope, reason: string): Promise<void> {
		await this.mutex.run(async () => {
			if (this.stateValue.status === "inactive" || this.stateValue.status === "stale") return;
			await this.commitState(
				{
					...this.stateValue,
					status: "stale",
					revision: this.stateValue.revision + 1,
					runRevision: this.stateValue.runRevision + 1,
					approvalId: undefined,
					reason,
				},
				actor,
				scope,
				reason,
			);
			this.approvalValue = undefined;
		});
	}

	async markFailed(actor: Actor, scope: PlanScope, reason: string): Promise<void> {
		await this.mutex.run(async () => {
			if (this.stateValue.status === "inactive" || isTerminal(this.stateValue.status)) return;
			await this.commitState(
				{
					...this.stateValue,
					status: "failed",
					revision: this.stateValue.revision + 1,
					runRevision: this.stateValue.runRevision + 1,
					approvalId: undefined,
					reason,
				},
				actor,
				scope,
				reason,
			);
			this.approvalValue = undefined;
		});
	}

	private async forkCurrent(scope: PlanScope, actor: Actor, activeTools: readonly string[]): Promise<void> {
		const source = this.specValue ?? (this.legacySpecValue ? undefined : undefined);
		const draft = source ? normalizeDraft({ goal: source.goal, decisions: source.decisions, steps: source.steps, risks: source.risks }) : this.legacySpecValue ? normalizeDraft(legacyToDraft(this.legacySpecValue)) : undefined;
		if (!draft || !this.stateValue.planRef) return;
		const oldRef = this.stateValue.planRef;
		const planId = this.id();
		const baseline: ToolBaselineRecord = {
			schema: "dev.pi.plan-tool-baseline/v2",
			baselineId: this.id(),
			planId,
			toolNames: [...new Set(this.baselineValue?.toolNames.length ? this.baselineValue.toolNames : activeTools)],
			capturedAt: this.now(),
			sessionId: scope.sessionId,
			branchEntryId: scope.branchLeafId,
		};
		const withoutHash: Omit<PlanSpec, "contentHash"> = {
			schema: "dev.pi.plan/v2",
			planId,
			version: 1,
			parentVersion: null,
			...(this.legacySpecValue ? { importedFrom: importedRef(this.legacySpecValue) } : { forkedFrom: oldRef }),
			createdAt: this.now(),
			createdBy: actor,
			goal: draft.goal,
			decisions: draft.decisions ?? [],
			scope,
			steps: materializeSteps(draft),
			risks: draft.risks ?? [],
		};
		const spec: PlanSpec = { ...withoutHash, contentHash: calculatePlanHash(withoutHash) };
		const paths = await this.store.save(spec);
		await this.appendAudit("tool-baseline-captured", actor, scope, { digest: activeToolsDigest(baseline.toolNames), data: baseline });
		await this.appendAudit("artifact-written", actor, scope, {
			digest: spec.contentHash,
			data: { planRef: toPlanRef(spec), specPath: paths.spec, reviewPath: paths.review, forkedFrom: oldRef },
		});
		const sourceSteps = this.stateValue.steps;
		const steps = Object.fromEntries(
			spec.steps.map((step, index) => {
				const oldId = source?.steps[index]?.id ?? this.legacySpecValue?.steps[index]?.id;
				const old = oldId ? sourceSteps[oldId] : undefined;
				return [step.id, old ? { ...old, reportIds: [...old.reportIds] } : { status: "pending", reportIds: [], evidenceIds: [] }];
			}),
		) as Record<string, StepExecutionState>;
		const currentStepId = spec.steps.find((step) => steps[step.id]?.status !== "completed")?.id;
		await this.commitState(
			{
				...createInitialState(this.now(), scope.ephemeralSession),
				status: "paused",
				revision: this.stateValue.revision + 1,
				runRevision: this.stateValue.runRevision + 1,
				stepRevision: this.stateValue.stepRevision,
				planId,
				planRef: toPlanRef(spec),
				baselineId: baseline.baselineId,
				currentStepId,
				steps,
				reason: "Fork/clone copied plan progress into a new v2 lineage; resume requires confirmation",
			},
			actor,
			scope,
			"Fork/clone created a paused v2 lineage",
			false,
		);
		this.specValue = spec;
		this.legacySpecValue = undefined;
		this.baselineValue = baseline;
		this.approvalValue = undefined;
	}

	async recover(
		entries: readonly SessionEntryLike[],
		reason: "startup" | "reload" | "new" | "resume" | "fork" | "tree",
		scope: PlanScope,
		environment: RecoveryEnvironment = {},
	): Promise<void> {
		await this.mutex.run(async () => {
			const projection = projectJournal(entries);
			this.sequence = projection.maxSequence;
			this.eventsValue = [...projection.events];
			this.permissions.clear();
			for (const [key, value] of projection.permissions) this.permissions.set(key, value);
			this.evidence.clear();
			for (const [key, value] of projection.evidence) this.evidence.set(key, value);
			this.stateValue = projection.state ?? createInitialState(this.now(), scope.ephemeralSession);
			this.baselineValue = this.stateValue.baselineId ? projection.baselines.get(this.stateValue.baselineId) : undefined;
			this.approvalValue = undefined;
			this.specValue = undefined;
			this.legacySpecValue = undefined;

			if (projection.corruptReason) {
				this.stateValue = {
					...this.stateValue,
					status: "stale",
					revision: this.stateValue.revision + 1,
					runRevision: this.stateValue.runRevision + 1,
					approvalId: undefined,
					reason: `Audit recovery failed closed: ${projection.corruptReason}`,
					updatedAt: this.now(),
				};
				return;
			}

			if (!projection.state && projection.legacy?.state?.planRef) {
				try {
					const stored = await this.store.loadAny(projection.legacy.state.planRef);
					if (!isLegacyPlanSpec(stored)) throw new Error("Legacy journal points to a non-v1 artifact");
					this.legacySpecValue = stored;
					const steps = legacySteps(stored, projection.legacy.state);
					const currentStepId =
						projection.legacy.state.currentStepId ?? stored.steps.find((step) => steps[step.id]?.status !== "completed")?.id;
					const legacyPaused: ExecutionState = {
						...createInitialState(this.now(), scope.ephemeralSession),
						status: "paused",
						revision: 1,
						runRevision: 1,
						planId: stored.planId,
						planRef: legacyPlanRef(stored),
						currentStepId,
						steps,
						reason: "Legacy v1 active plan recovered paused; migrate before resume",
					};
					await this.commitState(legacyPaused, { channel: "system", id: "legacy-recovery" }, scope, legacyPaused.reason!, false);
				} catch (error) {
					this.stateValue = {
						...createInitialState(this.now(), scope.ephemeralSession),
						status: "stale",
						revision: 1,
						runRevision: 1,
						reason: `Legacy artifact recovery failed: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				return;
			}

			if (!this.stateValue.planRef) return;
			try {
				const stored = await this.store.loadAny(this.stateValue.planRef);
				if (isLegacyPlanSpec(stored)) this.legacySpecValue = stored;
				else this.specValue = stored;
			} catch (error) {
				const stale: ExecutionState = {
					...this.stateValue,
					status: "stale",
					revision: this.stateValue.revision + 1,
					runRevision: this.stateValue.runRevision + 1,
					approvalId: undefined,
					reason: `Plan artifact recovery failed: ${error instanceof Error ? error.message : String(error)}`,
				};
				await this.commitState(stale, { channel: "system", id: "recovery" }, scope, stale.reason!, false);
				return;
			}

			if (reason === "fork") {
				await this.forkCurrent(scope, { channel: "system", id: "fork-recovery" }, environment.activeTools ?? []);
				return;
			}
			if (this.stateValue.status === "implementing" || this.stateValue.approvalId) {
				const paused: ExecutionState = {
					...this.stateValue,
					status: "paused",
					revision: this.stateValue.revision + 1,
					runRevision: this.stateValue.runRevision + 1,
					approvalId: undefined,
					reason: `${reason} recovery never resumes implementation automatically`,
				};
				await this.commitState(paused, { channel: "system", id: "recovery" }, scope, paused.reason!, false);
			}
		});
	}
}
