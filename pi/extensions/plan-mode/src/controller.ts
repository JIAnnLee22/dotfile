import { randomUUID } from "node:crypto";
import { calculatePlanHash, normalizeDraft, sha256 } from "./canonical.ts";
import type { PlanArtifactStore } from "./artifact-store.ts";
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
	type Capability,
	type AuditEvent,
	type EvidenceRecord,
	type ExecutionGrant,
	type ExecutionState,
	type PlanActionRequest,
	type PlanActionResult,
	type PlanDraft,
	type PlanErrorCode,
	type PlanRef,
	type PlanScope,
	type PlanSpec,
	type StepExecutionState,
	type WorkspaceSnapshot,
} from "./domain.ts";
import { projectJournal, type SessionEntryLike } from "./journal.ts";
import { assertTransition, isTerminal } from "./state-machine.ts";
import { workspaceSnapshotMatches } from "./workspace.ts";

export interface AuditJournalWriter {
	append(event: AuditEvent): Promise<void> | void;
}

export interface PlanControllerOptions {
	readonly store: PlanArtifactStore;
	readonly journal: AuditJournalWriter;
	readonly now?: () => string;
	readonly id?: () => string;
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

function trustedApprovalActor(actor: Actor): boolean {
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
		.slice(0, 256);
}

function stepProjection(spec: PlanSpec): Record<string, StepExecutionState> {
	return Object.fromEntries(spec.steps.map((step) => [step.id, { status: "pending", evidenceIds: [] } satisfies StepExecutionState]));
}

function isDraft(value: unknown): value is PlanDraft {
	return value !== null && typeof value === "object" && "goal" in value && "steps" in value && Array.isArray((value as PlanDraft).steps);
}

const CAPABILITY_EVIDENCE_TOOLS: Readonly<Record<Capability, ReadonlySet<string>>> = {
	"fs.read": new Set(["read", "grep", "find", "ls"]),
	"fs.write": new Set(["edit", "write"]),
	"process.exec": new Set(["bash"]),
};

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

export class PlanController {
	private readonly store: PlanArtifactStore;
	private readonly journal: AuditJournalWriter;
	private readonly now: () => string;
	private readonly id: () => string;
	private readonly mutex = new AsyncMutex();
	private stateValue: ExecutionState;
	private sequence = 0;
	private specValue?: PlanSpec;
	private approvalValue?: ApprovalRecord;
	private grantValue?: ExecutionGrant;
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

	get approval(): ApprovalRecord | undefined {
		return this.approvalValue ? structuredClone(this.approvalValue) : undefined;
	}

	get grant(): ExecutionGrant | undefined {
		return this.grantValue ? structuredClone(this.grantValue) : undefined;
	}

	get events(): readonly AuditEvent[] {
		return structuredClone(this.eventsValue);
	}

	private async appendAudit(
		action: string,
		actor: Actor,
		scope: PlanScope,
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
			planRef: options.state?.planRef ?? this.stateValue.planRef,
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
			throw new PlanControllerError("STORAGE_ERROR", "Failed to append Plan Mode audit event", false, error);
		}
	}

	private async commitState(
		next: ExecutionState,
		actor: Actor,
		scope: PlanScope,
		reason: string,
		validateTransition = true,
	): Promise<void> {
		if (validateTransition) assertTransition(this.stateValue.status, next.status);
		const committed: ExecutionState = { ...next, schema: STATE_SCHEMA, securityLevel: SECURITY_LEVEL, updatedAt: this.now() };
		await this.appendAudit("state-committed", actor, scope, { reason, state: committed });
		this.stateValue = committed;
	}

	private requireExpected(expected: PlanRef | undefined): PlanRef {
		if (!expected || !this.stateValue.planRef || !samePlanRef(expected, this.stateValue.planRef)) {
			throw new PlanControllerError("PLAN_REF_MISMATCH", "Action requires the exact current planId, version and contentHash");
		}
		return expected;
	}

	private requireTrustedActor(actor: Actor): void {
		if (!trustedApprovalActor(actor)) {
			throw new PlanControllerError("APPROVAL_REQUIRED", "The model or system actor cannot approve, execute or provide manual verification for its own plan");
		}
	}

	private requireCurrentDigests(environment: ActionEnvironment): void {
		if (!this.specValue) throw new PlanControllerError("INVALID_STATE", "No PlanSpec is loaded");
		if (this.specValue.policyDigest !== environment.policyDigest || this.specValue.contextDigest !== environment.contextDigest) {
			throw new PlanControllerError("STALE", "Policy or context digest changed; create or approve a new plan version");
		}
		if (!workspaceSnapshotMatches(this.specValue.workspaceSnapshot, environment.workspaceSnapshot)) {
			throw new PlanControllerError("STALE", "Workspace dependencies changed since this PlanSpec version was created");
		}
	}

	private async start(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "inactive") throw new PlanControllerError("INVALID_STATE", "Plan Mode is already active");
		const goal = environment.goal?.trim();
		if (!goal) throw new PlanControllerError("INVALID_PLAN", "A non-empty planning goal is required", true);
		this.specValue = undefined;
		this.approvalValue = undefined;
		this.grantValue = undefined;
		this.evidence.clear();
		await this.commitState(
			{
				...createInitialState(this.now(), environment.scope.ephemeralSession),
				status: "researching",
				epoch: this.stateValue.epoch + 1,
				planId: this.id(),
				reason: "Planning research active",
			},
			request.actor,
			environment.scope,
			"Planning started; goal body retained outside audit state",
		);
	}

	private async requestInput(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "researching") {
			throw new PlanControllerError("INVALID_STATE", "Clarification can be requested only while researching");
		}
		if (request.actor.channel !== "model") {
			throw new PlanControllerError("INVALID_ACTION", "request_input is reserved for the planning model");
		}
		const question = environment.question?.trim();
		if (!question) throw new PlanControllerError("INVALID_ACTION", "A clarification question is required");
		const pendingInput = {
			kind: environment.choices?.length ? "select" : "text",
			prompt: question.slice(0, 2000),
			choices: environment.choices?.map((choice) => choice.trim()).filter(Boolean).slice(0, 20),
		};
		await this.commitState(
			{
				...this.stateValue,
				status: "awaiting_input",
				pendingInput,
				reason: "Waiting for explicit clarification",
			},
			request.actor,
			environment.scope,
			"Structured clarification requested",
		);
	}

	private async answerInput(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "awaiting_input") {
			throw new PlanControllerError("INVALID_STATE", "No clarification input is pending");
		}
		this.requireTrustedActor(request.actor);
		await this.appendAudit("clarification-answered", request.actor, environment.scope, {
			digest: environment.note ? sha256(environment.note) : undefined,
			reason: "Answer body redacted; digest recorded",
		});
		await this.commitState(
			{
				...this.stateValue,
				status: "researching",
				pendingInput: undefined,
				reason: "Clarification received; research resumed",
			},
			request.actor,
			environment.scope,
			"Clarification answered",
		);
	}

	private async submit(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		const allowedStates =
			request.action === "edit"
				? new Set(["researching", "review", "approved", "paused", "stale"])
				: new Set(["researching", "review", "stale"]);
		if (!allowedStates.has(this.stateValue.status)) {
			throw new PlanControllerError("INVALID_STATE", `Cannot ${request.action} a plan while state=${this.stateValue.status}`);
		}
		if (!environment.draft || !isDraft(environment.draft)) throw new PlanControllerError("INVALID_PLAN", "Structured PlanDraft is required");
		const draft = normalizeDraft(environment.draft);
		const planId = this.stateValue.planId ?? this.stateValue.planRef?.planId ?? this.id();
		const suggestedVersion = (this.stateValue.planRef?.version ?? 0) + 1;
		const version = await this.store.nextAvailableVersion(planId, suggestedVersion);
		const parentVersion = this.stateValue.planRef?.version ?? null;
		const withoutHash: Omit<PlanSpec, "contentHash"> = {
			schema: "dev.pi.plan/v1",
			planId,
			version,
			parentVersion,
			createdAt: this.now(),
			createdBy: request.actor,
			goal: draft.goal,
			facts: draft.facts ?? [],
			assumptions: draft.assumptions ?? [],
			scope: environment.scope,
			steps: draft.steps,
			risks: draft.risks ?? [],
			policyDigest: environment.policyDigest,
			contextDigest: environment.contextDigest,
			...(environment.workspaceSnapshot ? { workspaceSnapshot: environment.workspaceSnapshot } : {}),
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
			epoch: this.stateValue.epoch + 1,
			planId,
			planRef: toPlanRef(spec),
			approvalId: undefined,
			grantId: undefined,
			currentStepId: undefined,
			steps: stepProjection(spec),
			pendingInput: undefined,
			reason: "PlanSpec submitted for review",
			ephemeralSession: environment.scope.ephemeralSession,
		};
		this.approvalValue = undefined;
		this.grantValue = undefined;
		await this.commitState(next, request.actor, environment.scope, "Immutable PlanSpec version committed");
		this.specValue = spec;
	}

	private async approve(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "review") throw new PlanControllerError("INVALID_STATE", "Only a reviewed PlanSpec can be approved");
		this.requireTrustedActor(request.actor);
		const expected = this.requireExpected(request.expectedPlan);
		this.requireCurrentDigests(environment);
		if (!this.specValue || !samePlanRef(expected, this.specValue)) throw new PlanControllerError("PLAN_REF_MISMATCH", "Loaded artifact mismatch");
		const approval: ApprovalRecord = {
			schema: "dev.pi.plan-approval/v1",
			approvalId: this.id(),
			nonce: this.id(),
			planRef: expected,
			subject: request.actor,
			approvedAt: this.now(),
			sessionId: environment.scope.sessionId,
			branchEntryId: environment.scope.branchLeafId,
		};
		await this.appendAudit("approval-created", request.actor, environment.scope, { decision: "allow", data: approval });
		const next: ExecutionState = {
			...this.stateValue,
			status: "approved",
			approvalId: approval.approvalId,
			grantId: undefined,
			reason: "Exact PlanRef approved; no execution grant has been issued",
		};
		await this.commitState(next, request.actor, environment.scope, "ApprovalRecord committed");
		this.approvalValue = approval;
	}

	private buildGrant(request: PlanActionRequest, environment: ActionEnvironment, epoch: number): ExecutionGrant {
		this.requireTrustedActor(request.actor);
		const expected = this.requireExpected(request.expectedPlan);
		this.requireCurrentDigests(environment);
		if (!this.specValue || !this.approvalValue || !samePlanRef(expected, this.specValue)) {
			throw new PlanControllerError("APPROVAL_REQUIRED", "A matching PlanSpec and ApprovalRecord are required");
		}
		if (!samePlanRef(this.approvalValue.planRef, expected) || this.approvalValue.approvalId !== this.stateValue.approvalId) {
			throw new PlanControllerError("APPROVAL_REQUIRED", "ApprovalRecord is stale or does not match the current plan");
		}
		return {
			schema: "dev.pi.plan-grant/v1",
			grantId: this.id(),
			approvalId: this.approvalValue.approvalId,
			planRef: expected,
			issuedTo: request.actor,
			issuedAt: this.now(),
			policyDigest: this.specValue.policyDigest,
			contextDigest: this.specValue.contextDigest,
			...(this.specValue.workspaceSnapshot ? { workspaceDigest: this.specValue.workspaceSnapshot.digest } : {}),
			sessionId: environment.scope.sessionId,
			branchEntryId: environment.scope.branchLeafId,
			epoch,
			steps: this.specValue.steps.map((step) => ({
				stepId: step.id,
				capabilities: step.requiredCapabilities,
				pathScopes: step.pathScopes,
			})),
		};
	}

	private async issueGrant(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "approved" && this.stateValue.status !== "paused") {
			throw new PlanControllerError("INVALID_STATE", "Execution can start only from approved or paused state");
		}
		const epoch = this.stateValue.epoch + 1;
		const grant = this.buildGrant(request, environment, epoch);
		const currentStepId =
			this.stateValue.currentStepId ?? this.specValue?.steps.find((step) => this.stateValue.steps[step.id]?.status !== "verified")?.id;
		if (!currentStepId) throw new PlanControllerError("INVALID_PLAN", "Plan has no unverified step");
		await this.appendAudit("grant-issued", request.actor, environment.scope, {
			decision: "allow",
			digest: sha256(JSON.stringify(grant)),
			data: grant,
		});
		const steps = structuredClone(this.stateValue.steps) as Record<string, StepExecutionState>;
		steps[currentStepId] = { ...steps[currentStepId], status: "running" };
		const next: ExecutionState = {
			...this.stateValue,
			status: "executing",
			epoch,
			grantId: grant.grantId,
			currentStepId,
			steps,
			reason: `ExecutionGrant issued for step ${currentStepId}`,
		};
		await this.commitState(next, request.actor, environment.scope, "ExecutionGrant activated");
		this.grantValue = grant;
	}

	private async approveAndExecute(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status === "review") await this.approve(request, environment);
		if (this.stateValue.status !== "approved" && this.stateValue.status !== "paused") {
			throw new PlanControllerError("INVALID_STATE", `Plan cannot run while state=${this.stateValue.status}`);
		}
		await this.issueGrant(request, environment);
	}

	private async pause(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "executing") throw new PlanControllerError("INVALID_STATE", "Only executing plans can be paused");
		const next: ExecutionState = {
			...this.stateValue,
			status: "paused",
			epoch: this.stateValue.epoch + 1,
			grantId: undefined,
			reason: auditSummary(environment.reason, "Execution paused; previous grant revoked"),
		};
		await this.commitState(next, request.actor, environment.scope, next.reason ?? "Paused");
		this.grantValue = undefined;
	}

	private async reject(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "review") throw new PlanControllerError("INVALID_STATE", "Only reviewed plans can be rejected");
		this.requireTrustedActor(request.actor);
		const next: ExecutionState = {
			...this.stateValue,
			status: "rejected",
			epoch: this.stateValue.epoch + 1,
			approvalId: undefined,
			grantId: undefined,
			reason: auditSummary(environment.reason, "Plan rejected"),
		};
		await this.commitState(next, request.actor, environment.scope, next.reason ?? "Rejected");
		this.approvalValue = undefined;
		this.grantValue = undefined;
	}

	private async cancel(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status === "inactive" || isTerminal(this.stateValue.status)) {
			throw new PlanControllerError("INVALID_STATE", `Cannot cancel while state=${this.stateValue.status}`);
		}
		const next: ExecutionState = {
			...this.stateValue,
			status: "cancelled",
			epoch: this.stateValue.epoch + 1,
			grantId: undefined,
			reason: auditSummary(environment.reason, "Plan cancelled; minimum permissions retained until reset"),
		};
		await this.commitState(next, request.actor, environment.scope, next.reason ?? "Cancelled");
		this.grantValue = undefined;
	}

	private async reset(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (!isTerminal(this.stateValue.status)) {
			throw new PlanControllerError("INVALID_STATE", "Reset is allowed only from completed, rejected, cancelled or failed state");
		}
		const next = { ...createInitialState(this.now(), environment.scope.ephemeralSession), epoch: this.stateValue.epoch + 1 };
		await this.commitState(next, request.actor, environment.scope, "Reset returned Plan Mode to inactive");
		this.specValue = undefined;
		this.approvalValue = undefined;
		this.grantValue = undefined;
		this.evidence.clear();
	}

	private async commitStepCompletion(
		request: PlanActionRequest,
		environment: ActionEnvironment,
		stepId: string,
		kind: "verification" | "user-confirmation",
		summary: string,
	): Promise<void> {
		if (!this.stateValue.planRef || !this.specValue) throw new PlanControllerError("INVALID_STATE", "No executing PlanSpec is loaded");
		const evidence: EvidenceRecord = {
			schema: "dev.pi.plan-evidence/v1",
			evidenceId: this.id(),
			planRef: this.stateValue.planRef,
			stepId,
			kind,
			actor: request.actor,
			recordedAt: this.now(),
			success: true,
			summary,
		};
		await this.appendAudit("evidence-recorded", request.actor, environment.scope, { decision: "allow", data: evidence });
		this.evidence.set(evidence.evidenceId, evidence);
		const steps = structuredClone(this.stateValue.steps) as Record<string, StepExecutionState>;
		steps[stepId] = { status: "verified", evidenceIds: [...steps[stepId].evidenceIds, evidence.evidenceId] };
		const nextStep = this.specValue.steps.find((step) => steps[step.id]?.status !== "verified");
		if (nextStep) steps[nextStep.id] = { ...steps[nextStep.id], status: "running" };
		const completed = nextStep === undefined;
		const next: ExecutionState = {
			...this.stateValue,
			status: completed ? "completed" : "executing",
			epoch: completed ? this.stateValue.epoch + 1 : this.stateValue.epoch,
			grantId: completed ? undefined : this.stateValue.grantId,
			currentStepId: nextStep?.id,
			steps,
			reason: completed ? "All plan steps completed with evidence" : `Step ${stepId} completed with evidence`,
		};
		await this.commitState(next, request.actor, environment.scope, next.reason ?? "Step completed");
		if (completed) this.grantValue = undefined;
	}

	private async completeStep(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "executing" || !this.specValue || request.actor.channel !== "model") {
			throw new PlanControllerError("INVALID_STATE", "Only the executing model can complete the current step through the managed tool");
		}
		const stepId = environment.stepId ?? this.stateValue.currentStepId;
		const step = this.specValue.steps.find((candidate) => candidate.id === stepId);
		if (!stepId || stepId !== this.stateValue.currentStepId || !step || !this.stateValue.steps[stepId]) {
			throw new PlanControllerError("INVALID_ACTION", "Only the current step can be completed");
		}
		const note = environment.note?.trim();
		if (!note) throw new PlanControllerError("INVALID_ACTION", "A concise completion summary is required");
		const toolEvidence = this.stateValue.steps[stepId].evidenceIds
			.map((id) => this.evidence.get(id))
			.filter((evidence): evidence is EvidenceRecord => evidence?.kind === "tool-result" && evidence.success);
		if (toolEvidence.length === 0) {
			throw new PlanControllerError("INVALID_ACTION", `Step ${stepId} has no successful tool evidence`);
		}
		const missing = step.requiredCapabilities.filter(
			(capability) => !toolEvidence.some((evidence) => evidence.toolName && CAPABILITY_EVIDENCE_TOOLS[capability].has(evidence.toolName)),
		);
		if (missing.length > 0) {
			throw new PlanControllerError("INVALID_ACTION", `Step ${stepId} lacks successful evidence for: ${missing.join(", ")}`);
		}
		await this.commitStepCompletion(request, environment, stepId, "verification", auditSummary(note, "Structured agent completion"));
	}

	private async verify(request: PlanActionRequest, environment: ActionEnvironment): Promise<void> {
		if (this.stateValue.status !== "executing" || !this.stateValue.planRef || !this.specValue) {
			throw new PlanControllerError("INVALID_STATE", "Step verification requires an executing plan");
		}
		this.requireTrustedActor(request.actor);
		const stepId = environment.stepId ?? this.stateValue.currentStepId;
		if (!stepId || stepId !== this.stateValue.currentStepId || !this.stateValue.steps[stepId]) {
			throw new PlanControllerError("INVALID_ACTION", "Only the current step can be verified");
		}
		await this.commitStepCompletion(
			request,
			environment,
			stepId,
			"user-confirmation",
			auditSummary(environment.note, "Explicit user confirmation"),
		);
	}

	private async diffVersions(environment: ActionEnvironment): Promise<PlanDiff> {
		const current = this.stateValue.planRef;
		if (!current) throw new PlanControllerError("INVALID_STATE", "No PlanSpec lineage is available to diff");
		const toVersion = environment.toVersion ?? current.version;
		if (!Number.isSafeInteger(toVersion) || toVersion < 1) {
			throw new PlanControllerError("INVALID_ACTION", "diff versions must be positive integers", true);
		}
		const after = await this.store.loadVersion(current.planId, toVersion);
		if (toVersion === current.version && !samePlanRef(current, after)) {
			throw new PlanControllerError("PLAN_REF_MISMATCH", "Current diff target no longer matches the authoritative PlanRef");
		}
		const fromVersion = environment.fromVersion ?? after.parentVersion;
		if (typeof fromVersion !== "number" || !Number.isSafeInteger(fromVersion) || fromVersion < 1) {
			throw new PlanControllerError("INVALID_ACTION", "diff requires an explicit source version or a target with parentVersion", true);
		}
		const before = await this.store.loadVersion(current.planId, fromVersion);
		return diffPlanSpecs(before, after);
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
			case "edit":
				return this.submit(request, environment);
			case "approve":
				return this.approve(request, environment);
			case "run":
				return this.approveAndExecute(request, environment);
			case "execute":
			case "resume":
				return this.issueGrant(request, environment);
			case "complete_step":
				return this.completeStep(request, environment);
			case "pause":
				return this.pause(request, environment);
			case "reject":
				return this.reject(request, environment);
			case "cancel":
				return this.cancel(request, environment);
			case "reset":
				return this.reset(request, environment);
			case "verify":
				return this.verify(request, environment);
			case "diff":
				return this.diffVersions(environment);
			case "status":
			case "show":
			case "audit":
				return undefined;
			case "export":
				throw new PlanControllerError("UNSUPPORTED_MODE", "Workspace export is not implemented in the strict P0 package");
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
					grantRef: this.stateValue.grantId,
					pendingInput: this.stateValue.pendingInput,
					data,
				};
			} catch (error) {
				if (
					error instanceof PlanControllerError &&
					error.code === "STALE" &&
					new Set(["approved", "executing", "paused"]).has(this.stateValue.status)
				) {
					try {
						await this.commitState(
							{
								...this.stateValue,
								status: "stale",
								epoch: this.stateValue.epoch + 1,
								grantId: undefined,
								reason: error.message,
							},
							request.actor,
							environment.scope,
							error.message,
						);
						this.grantValue = undefined;
					} catch (commitError) {
						return errorResult(request, this.stateValue, commitError);
					}
				}
				return errorResult(request, this.stateValue, error);
			}
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
			if (this.stateValue.status !== "executing" || !this.stateValue.planRef || !this.stateValue.currentStepId) return;
			const evidence: EvidenceRecord = {
				schema: "dev.pi.plan-evidence/v1",
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
			await this.appendAudit("evidence-recorded", actor, scope, { decision: input.success ? "allow" : "deny", data: evidence });
			this.evidence.set(evidence.evidenceId, evidence);
			const steps = structuredClone(this.stateValue.steps) as Record<string, StepExecutionState>;
			const current = steps[this.stateValue.currentStepId];
			steps[this.stateValue.currentStepId] = { ...current, evidenceIds: [...current.evidenceIds, evidence.evidenceId] };
			await this.commitState({ ...this.stateValue, steps }, actor, scope, `Tool evidence recorded for ${input.toolName}`);
		});
	}

	async revalidateWorkspace(actor: Actor, scope: PlanScope, actual: WorkspaceSnapshot): Promise<boolean> {
		return this.mutex.run(async () => {
			if (!this.specValue?.workspaceSnapshot || !new Set(["approved", "paused"]).has(this.stateValue.status)) return true;
			if (workspaceSnapshotMatches(this.specValue.workspaceSnapshot, actual)) return true;
			const reason = "Workspace dependencies drifted from approved PlanSpec";
			await this.commitState(
				{
					...this.stateValue,
					status: "stale",
					epoch: this.stateValue.epoch + 1,
					grantId: undefined,
					reason,
				},
				actor,
				scope,
				reason,
			);
			this.grantValue = undefined;
			return false;
		});
	}

	async markStale(actor: Actor, scope: PlanScope, reason: string): Promise<void> {
		await this.mutex.run(async () => {
			if (!new Set(["approved", "executing", "paused"]).has(this.stateValue.status)) return;
			const next: ExecutionState = {
				...this.stateValue,
				status: "stale",
				epoch: this.stateValue.epoch + 1,
				grantId: undefined,
				reason,
			};
			await this.commitState(next, actor, scope, reason);
			this.grantValue = undefined;
		});
	}

	async recover(
		entries: readonly SessionEntryLike[],
		reason: "startup" | "reload" | "new" | "resume" | "fork" | "tree",
		scope: PlanScope,
		currentDigests?: { policyDigest: string; contextDigest: string },
	): Promise<void> {
		await this.mutex.run(async () => {
			const projection = projectJournal(entries);
			this.sequence = projection.maxSequence;
			this.eventsValue = [...projection.events];
			this.evidence.clear();
			for (const [id, value] of projection.evidence) this.evidence.set(id, value);
			this.stateValue = projection.state ?? createInitialState(this.now(), scope.ephemeralSession);
			this.approvalValue = this.stateValue.approvalId ? projection.approvals.get(this.stateValue.approvalId) : undefined;
			this.grantValue = undefined;
			this.specValue = undefined;

			if (projection.corruptReason) {
				this.stateValue = {
					...this.stateValue,
					status: "failed",
					epoch: this.stateValue.epoch + 1,
					approvalId: undefined,
					grantId: undefined,
					reason: `Audit recovery failed closed: ${projection.corruptReason}`,
					updatedAt: this.now(),
				};
				this.approvalValue = undefined;
				// Do not append behind a corrupt point: future scans would stop before it and create a loop.
				return;
			}

			if (!this.stateValue.planRef) {
				if (reason === "fork" && (this.stateValue.approvalId || this.stateValue.grantId)) {
					this.stateValue = {
						...this.stateValue,
						status: "failed",
						epoch: this.stateValue.epoch + 1,
						approvalId: undefined,
						grantId: undefined,
						reason: "Fork recovery found authority without a PlanRef and failed closed",
						updatedAt: this.now(),
					};
					this.approvalValue = undefined;
				}
				return;
			}
			try {
				this.specValue = await this.store.load(this.stateValue.planRef);
			} catch (error) {
				const failed: ExecutionState = {
					...this.stateValue,
					status: "failed",
					epoch: this.stateValue.epoch + 1,
					approvalId: reason === "fork" ? undefined : this.stateValue.approvalId,
					grantId: undefined,
					reason: `PlanSpec recovery failed: ${error instanceof Error ? error.message : String(error)}`,
				};
				if (reason === "fork") this.approvalValue = undefined;
				await this.commitState(failed, { channel: "system", id: "recovery" }, scope, failed.reason ?? "Recovery failed", false);
				return;
			}

			let safeStatus = this.stateValue.status;
			let safeReason: string | undefined;
			if (reason === "fork") {
				safeStatus = "review";
				safeReason = "Fork/clone inherited PlanSpec lineage but cleared approval and grant";
				this.approvalValue = undefined;
			} else if (this.stateValue.status === "executing") {
				safeStatus = "stale";
				safeReason = "An executing state never resumes automatically";
			} else if (this.stateValue.status === "approved" && !this.approvalValue) {
				safeStatus = "stale";
				safeReason = "ApprovalRecord is absent from the current branch";
			}
			if (
				reason !== "fork" &&
				currentDigests &&
				new Set(["approved", "executing", "paused"]).has(this.stateValue.status) &&
				(this.specValue.policyDigest !== currentDigests.policyDigest || this.specValue.contextDigest !== currentDigests.contextDigest)
			) {
				safeStatus = "stale";
				safeReason = "Policy or context digest drifted during recovery";
			}
			if (safeStatus !== this.stateValue.status || this.stateValue.grantId !== undefined) {
				const recovered: ExecutionState = {
					...this.stateValue,
					status: safeStatus,
					epoch: this.stateValue.epoch + 1,
					approvalId: reason === "fork" || safeStatus === "review" ? undefined : this.stateValue.approvalId,
					grantId: undefined,
					reason: safeReason ?? "Recovered without restoring an ExecutionGrant",
				};
				await this.commitState(recovered, { channel: "system", id: "recovery" }, scope, recovered.reason ?? "Recovered", false);
			}
		});
	}
}
