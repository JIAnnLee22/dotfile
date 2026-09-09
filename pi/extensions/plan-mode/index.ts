import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PlanArtifactStore, renderLegacyPlanMarkdown, renderPlanMarkdown } from "./src/artifact-store.ts";
import { canonicalJson, sha256 } from "./src/canonical.ts";
import { CapabilityRegistry, defaultRegistryEntries } from "./src/capability-registry.ts";
import { loadPolicyConfig } from "./src/config.ts";
import { PlanController } from "./src/controller.ts";
import { renderPlanDiffMarkdown, type PlanDiff } from "./src/diff.ts";
import {
	ACTION_PROTOCOL,
	SECURITY_LEVEL,
	type ActionEnvironment,
	type Actor,
	type ActorChannel,
	type PlanAction,
	type PlanActionRequest,
	type PlanActionResult,
	type PlanDraft,
	type PlanRef,
	type PlanScope,
	type PlanStatus,
	type ToolBaselineRecord,
} from "./src/domain.ts";
import { ExecutionLoop, type LoopDecision } from "./src/execution-loop.ts";
import { AUDIT_ENTRY_TYPE } from "./src/journal.ts";
import { evaluateToolCall } from "./src/policy.ts";
import { chooseReviewDecision, confirmImplementation, renderUserPlan, requestEditFeedback } from "./src/review-ui.ts";
import { usesPlanningPolicy } from "./src/state-machine.ts";
import { MANDATORY_IMPLEMENTATION_TOOLS, PLAN_MANAGED_TOOLS, ToolSession } from "./src/tool-session.ts";
import { buildPlanProgressLines } from "./src/ui.ts";

const CONTEXT_TYPE = "plan-mode/context-v2";
const RESULT_TYPE = "plan-mode/action-result-v2";
const SUBMIT_TOOL = "plan_submit";
const QUESTION_TOOL = "plan_question";
const COMPLETE_TOOL = "plan_step_complete";
const BLOCK_TOOL = "plan_blocked";
const CONTROL_TOOLS = new Set([SUBMIT_TOOL, QUESTION_TOOL, COMPLETE_TOOL, BLOCK_TOOL]);
const EXTENSION_SOURCE = import.meta.filename;

function actorChannel(ctx: ExtensionContext): ActorChannel {
	return ctx.mode;
}

function actorFor(ctx: ExtensionContext): Actor {
	return { channel: actorChannel(ctx), id: ctx.mode === "rpc" ? "rpc-client-unverified" : `local-${ctx.mode}` };
}

function scopeFor(ctx: ExtensionContext): PlanScope {
	return {
		cwd: path.resolve(ctx.cwd),
		sessionId: ctx.sessionManager.getSessionId(),
		branchLeafId: ctx.sessionManager.getLeafId(),
		ephemeralSession: ctx.sessionManager.getSessionFile() === undefined,
	};
}

function tokenize(value: string): string[] {
	const tokens: string[] = [];
	for (const match of value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) tokens.push(match[1] ?? match[2] ?? match[3]);
	return tokens;
}

function formatResult(result: PlanActionResult): string {
	const ref = result.planRef ? `${result.planRef.planId}@${result.planRef.version}:${result.planRef.contentHash.slice(0, 12)}` : "none";
	if (!result.ok) {
		return `PLAN_ACTION_ERROR ${result.error?.code ?? "UNKNOWN"}: ${result.error?.message ?? "Unknown error"}\nstate=${result.state.status} plan=${ref} security=${SECURITY_LEVEL}`;
	}
	return `PLAN_ACTION_OK state=${result.state.status} plan=${ref} revision=${result.state.revision} security=${SECURITY_LEVEL}`;
}

function formatTuiResult(result: PlanActionResult): string {
	if (!result.ok) return `Plan Mode: ${result.error?.message ?? "Action failed"}`;
	switch (result.state.status) {
		case "inactive":
			return "Plan Mode is inactive.";
		case "planning":
			return "Plan Mode started — planning read-only.";
		case "awaiting_input":
			return `Plan Mode needs input: ${result.pendingInput?.prompt ?? "clarification required"}`;
		case "review":
			return "Plan ready for review.";
		case "implementing":
			return "Plan implementation is running with normal Pi permissions.";
		case "paused":
			return `Plan paused${result.state.reason ? `: ${result.state.reason}` : "."}`;
		case "completed":
			return "All plan steps were reported complete.";
		case "stale":
		case "failed":
		case "cancelled":
			return `Plan ${result.state.status}${result.state.reason ? `: ${result.state.reason}` : "."}`;
	}
}

function resultError(controller: PlanController, action: PlanAction, error: NonNullable<PlanActionResult["error"]>): PlanActionResult {
	return {
		requestId: `${action}-${randomUUID()}`,
		ok: false,
		state: controller.state,
		planRef: controller.state.planRef,
		error,
	};
}

function asStringFlag(pi: ExtensionAPI, name: string): string | undefined {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asVersionFlag(pi: ExtensionAPI, name: string): number | undefined {
	const value = pi.getFlag(name);
	if (value === undefined) return undefined;
	return typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN;
}

function expectedFromTokens(controller: PlanController, tokens: readonly string[]): PlanRef | undefined {
	if (tokens.length === 0) return undefined;
	if (tokens.length === 2 && controller.state.planRef) {
		const version = Number(tokens[0]);
		return Number.isInteger(version)
			? { planId: controller.state.planRef.planId, version, contentHash: tokens[1] }
			: undefined;
	}
	if (tokens.length >= 3) {
		const version = Number(tokens[1]);
		return Number.isInteger(version) ? { planId: tokens[0], version, contentHash: tokens[2] } : undefined;
	}
	return undefined;
}

function expectedFromFlags(pi: ExtensionAPI): PlanRef | undefined {
	const planId = asStringFlag(pi, "plan-id");
	const rawVersion = asStringFlag(pi, "plan-version");
	const contentHash = asStringFlag(pi, "plan-hash");
	const version = rawVersion === undefined ? Number.NaN : Number(rawVersion);
	return planId && contentHash && Number.isInteger(version) ? { planId, version, contentHash } : undefined;
}

export default async function planModeExtension(pi: ExtensionAPI): Promise<void> {
	const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || getAgentDir());
	const loadedConfig = await loadPolicyConfig(agentDir);
	const registry = new CapabilityRegistry([...defaultRegistryEntries(agentDir), ...loadedConfig.entries]);
	const toolSession = new ToolSession(pi, registry);
	const loop = new ExecutionLoop();
	let controller: PlanController | undefined;
	let startupFlagsHandled = false;
	let pendingStartupNotice: PlanActionResult | undefined;
	let pendingFlagAction:
		| { action: PlanAction; expectedPlan?: PlanRef; extra: Partial<ActionEnvironment>; actor: Actor }
		| undefined;
	let legacyBaselineCandidate: readonly string[] | undefined;
	let treeFallbackBaseline: ToolBaselineRecord | undefined;
	let cleanupRunning = false;
	let configNoticeShown = false;
	let deckControlsWidget = false;
	let deckModeListener: (() => void) | undefined;

	pi.registerFlag("plan", { description: "Start in Plan Mode v2", type: "boolean", default: false });
	pi.registerFlag("plan-action", { description: "Non-interactive Plan Mode v2 action", type: "string" });
	pi.registerFlag("plan-goal", { description: "Goal for --plan or --plan-action start", type: "string" });
	pi.registerFlag("plan-id", { description: "Expected immutable plan id", type: "string" });
	pi.registerFlag("plan-version", { description: "Expected immutable plan version", type: "string" });
	pi.registerFlag("plan-hash", { description: "Expected immutable plan content hash", type: "string" });
	pi.registerFlag("plan-from-version", { description: "Source version for --plan-action diff", type: "string" });
	pi.registerFlag("plan-to-version", { description: "Target version for --plan-action diff", type: "string" });

	function ensureController(ctx: ExtensionContext): PlanController {
		if (controller) return controller;
		const store = new PlanArtifactStore(process.env.PI_PLAN_MODE_HOME || PlanArtifactStore.defaultRoot(), ctx.cwd);
		controller = new PlanController({
			store,
			journal: { append: (event) => pi.appendEntry(AUDIT_ENTRY_TYPE, event) },
		});
		return controller;
	}

	function request(action: PlanAction, actor: Actor, expectedPlan?: PlanRef): PlanActionRequest {
		return { protocolVersion: ACTION_PROTOCOL, requestId: `${action}-${randomUUID()}`, action, actor, expectedPlan };
	}

	async function dispatch(
		ctx: ExtensionContext,
		action: PlanAction,
		extra: Partial<ActionEnvironment> = {},
		expectedPlan?: PlanRef,
		actor = actorFor(ctx),
	): Promise<PlanActionResult> {
		const current = ensureController(ctx);
		return current.dispatch(request(action, actor, expectedPlan), { scope: scopeFor(ctx), ...extra });
	}

	function managedToolsForStatus(status: PlanStatus): string[] {
		switch (status) {
			case "planning":
				return [QUESTION_TOOL, SUBMIT_TOOL];
			case "implementing":
				return [COMPLETE_TOOL, BLOCK_TOOL];
			case "stale":
				return [COMPLETE_TOOL, BLOCK_TOOL];
			default:
				return [];
		}
	}

	function applyStateTools(ctx: ExtensionContext): { ok: boolean; reason?: string } {
		const current = ensureController(ctx);
		const state = current.state;
		if (usesPlanningPolicy(state.status)) {
			const result = toolSession.applyPlanning(managedToolsForStatus(state.status));
			return { ok: result.ok, reason: result.reason };
		}
		if (state.status === "implementing") {
			const result = toolSession.verifyImplementation();
			return { ok: result.ok, reason: result.reason };
		}
		return { ok: true };
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const current = ensureController(ctx);
		const state = current.state;
		if (deckControlsWidget || state.status === "inactive") {
			ctx.ui.setStatus("plan-mode", undefined);
			ctx.ui.setWidget("plan-mode", undefined);
			return;
		}
		const color = state.status === "implementing" ? "accent" : state.status === "failed" || state.status === "stale" ? "error" : "warning";
		const label = state.status === "planning" || state.status === "awaiting_input" || state.status === "review"
			? "PLAN · READ ONLY"
			: state.status === "implementing"
				? "PLAN · IMPLEMENTING"
				: `PLAN · ${state.status.toUpperCase()}`;
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg(color, label));
		const lines = buildPlanProgressLines(current.spec, state);
		if (!lines) {
			ctx.ui.setWidget("plan-mode", undefined);
		} else {
			ctx.ui.setWidget("plan-mode", (_tui, theme) => ({
				render(width: number): string[] {
					return lines.map((line, index) => truncateToWidth(theme.fg(index === 0 ? "accent" : "dim", line), width, theme.fg("dim", "…")));
				},
				invalidate() {},
			}));
		}
		pi.events.emit("operations-deck:plan", { state, spec: current.spec });
	}

	function emitMessage(ctx: ExtensionContext, customType: string, content: string, details?: unknown): void {
		if (ctx.mode === "print") {
			process.stderr.write(`${content}\n`);
			return;
		}
		pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: false });
	}

	function emitResult(ctx: ExtensionContext, result: PlanActionResult): void {
		emitMessage(ctx, RESULT_TYPE, ctx.mode === "tui" ? formatTuiResult(result) : formatResult(result), result);
		if (result.ok && (result.data as PlanDiff | undefined)?.schema === "dev.pi.plan-diff/v2") {
			emitMessage(ctx, "plan-mode/diff-v2", renderPlanDiffMarkdown(result.data as PlanDiff), result.data);
		}
		if (ctx.mode === "rpc") {
			emitMessage(
				ctx,
				"plan-mode/safety-warning",
				"PLAN_SAFETY_WARNING SAFETY_BOUNDARY_DEGRADED: RPC direct bash is outside planning tool_call policy; implementation uses normal Pi permissions",
			);
		}
	}

	function queueDecision(ctx: ExtensionContext, decision: LoopDecision): void {
		if (decision.kind !== "queue-step" && decision.kind !== "queue-final") return;
		const current = ensureController(ctx);
		const state = current.state;
		const step = current.spec?.steps.find((candidate) => candidate.id === state.currentStepId);
		const content = decision.kind === "queue-final"
			? `${decision.reason}\nGive the user a concise final result: changed files, validation performed, deviations, and remaining risks. Do not call ${COMPLETE_TOOL} again.`
			: `${decision.reason}\nContinue the approved plan from the current step${step ? ` ${step.id}: ${step.title}` : ""}. Ordinary tools now use normal Pi permissions. Call ${COMPLETE_TOOL} with a concise summary when the step is done; call ${BLOCK_TOOL} for a real blocker.`;
		pi.sendMessage({ customType: "plan-mode/continue-v2", content, display: false }, { triggerTurn: true, deliverAs: "followUp" });
	}

	async function restoreAndArchive(ctx: ExtensionContext, reason: string): Promise<void> {
		if (cleanupRunning) return;
		cleanupRunning = true;
		try {
			const current = ensureController(ctx);
			const baseline = current.baseline;
			if (baseline) {
				const restored = toolSession.restoreBaseline(baseline);
				if (!restored.ok && ctx.hasUI) ctx.ui.notify(restored.reason ?? "Some baseline tools are unavailable", "warning");
			}
			await current.archive({ channel: "system", id: "plan-cleanup" }, scopeFor(ctx), reason);
			loop.reset();
			updateUI(ctx);
		} finally {
			cleanupRunning = false;
		}
	}

	function baselineFromTools(current: PlanController, ctx: ExtensionContext, planId: string, tools: readonly string[]): ToolBaselineRecord {
		return {
			schema: "dev.pi.plan-tool-baseline/v2",
			baselineId: current.newOpaqueId(),
			planId,
			toolNames: [...new Set(tools)],
			capturedAt: new Date().toISOString(),
			sessionId: scopeFor(ctx).sessionId,
			branchEntryId: scopeFor(ctx).branchLeafId,
		};
	}

	async function startWithGoal(ctx: ExtensionContext, goal: string): Promise<PlanActionResult> {
		const current = ensureController(ctx);
		const planId = current.newOpaqueId();
		const baseline = toolSession.captureBaseline(planId, scopeFor(ctx), current.newOpaqueId(), new Date().toISOString());
		const result = await dispatch(ctx, "start", { goal: goal.trim(), baseline });
		if (!result.ok) return result;
		const applied = toolSession.applyPlanning(managedToolsForStatus("planning"));
		if (!applied.ok) {
			const reason = applied.reason ?? "Planning tools failed to activate";
			await current.markFailed({ channel: "system", id: "planning-tool-setup" }, scopeFor(ctx), reason);
			toolSession.restoreBaseline(baseline);
			return resultError(current, "start", { code: "TOOL_UNAVAILABLE", message: reason, retryable: true });
		}
		updateUI(ctx);
		if (ctx.hasUI) {
			if (ctx.isIdle()) pi.sendUserMessage(goal.trim());
			else pi.sendUserMessage(goal.trim(), { deliverAs: "followUp" });
		}
		return result;
	}

	async function startFromPrompt(ctx: ExtensionContext): Promise<PlanActionResult> {
		const current = ensureController(ctx);
		if (!ctx.hasUI) {
			return resultError(current, "start", {
				code: "UI_REQUIRED",
				message: "Bare /plan requires TUI/RPC input; use /plan <goal>",
				retryable: true,
			});
		}
		const goal = await ctx.ui.input("Plan goal", "Describe what should be researched and planned");
		return goal?.trim()
			? startWithGoal(ctx, goal)
			: resultError(current, "start", { code: "INVALID_PLAN", message: "Plan goal is required", retryable: true });
	}

	async function migrateLegacyIfNeeded(ctx: ExtensionContext, actor: Actor, expected: PlanRef): Promise<PlanActionResult | undefined> {
		const current = ensureController(ctx);
		if (!current.legacySpec) return undefined;
		const planId = current.newOpaqueId();
		const baseline = baselineFromTools(current, ctx, planId, legacyBaselineCandidate ?? pi.getActiveTools());
		const migrated = await dispatch(ctx, "migrate_v1", { baseline }, expected, actor);
		if (!migrated.ok) return migrated;
		legacyBaselineCandidate = undefined;
		return migrated;
	}

	async function startImplementation(ctx: ExtensionContext, expected: PlanRef, actor = actorFor(ctx)): Promise<PlanActionResult> {
		const current = ensureController(ctx);
		const migrated = await migrateLegacyIfNeeded(ctx, actor, expected);
		if (migrated && !migrated.ok) return migrated;
		const effectiveExpected = current.state.planRef;
		if (!effectiveExpected) {
			return resultError(current, "implement", { code: "INVALID_STATE", message: "No PlanSpec is available", retryable: true });
		}
		const baseline = current.baseline;
		if (!baseline) {
			return resultError(current, "implement", { code: "TOOL_UNAVAILABLE", message: "Persisted tool baseline is unavailable", retryable: true });
		}
		const prepared = toolSession.prepareImplementation(baseline);
		if (!prepared.ok) {
			updateUI(ctx);
			return resultError(current, "implement", {
				code: "TOOL_UNAVAILABLE",
				message: prepared.reason ?? `Missing tools: ${prepared.missing.join(", ")}`,
				retryable: true,
				details: prepared,
			});
		}
		const action: PlanAction = current.state.status === "paused" ? "resume" : "implement";
		const result = await dispatch(
			ctx,
			action,
			{ activeTools: prepared.active, activeToolsDigest: prepared.activeDigest },
			effectiveExpected,
			actor,
		);
		if (!result.ok) toolSession.applyPlanning(managedToolsForStatus(current.state.status));
		else queueDecision(ctx, loop.onImplementationStarted(result.state));
		updateUI(ctx);
		return result;
	}

	async function editPlan(ctx: ExtensionContext): Promise<PlanActionResult> {
		const current = ensureController(ctx);
		if (!ctx.hasUI || !current.spec) {
			return resultError(current, "edit_feedback", {
				code: "UI_REQUIRED",
				message: "Plan edit feedback requires TUI/RPC and a v2 PlanSpec",
				retryable: true,
			});
		}
		const feedback = await requestEditFeedback(ctx, current.spec);
		if (!feedback) return resultError(current, "edit_feedback", { code: "INVALID_ACTION", message: "Plan edit cancelled", retryable: true });
		const result = await dispatch(ctx, "edit_feedback", { feedback });
		if (result.ok) {
			toolSession.applyPlanning(managedToolsForStatus("planning"));
			if (ctx.isIdle()) pi.sendUserMessage(`Revise the structured plan using this feedback:\n${feedback}`);
			else pi.sendUserMessage(`Revise the structured plan using this feedback:\n${feedback}`, { deliverAs: "followUp" });
		}
		updateUI(ctx);
		return result;
	}

	async function handleReview(ctx: ExtensionContext, submitted: PlanActionResult): Promise<PlanActionResult> {
		const current = ensureController(ctx);
		if (!submitted.ok || !current.spec) return submitted;
		emitMessage(ctx, "plan-mode/review-v2", renderUserPlan(current.spec), { planRef: current.state.planRef });
		if (!ctx.hasUI) return submitted;
		const decision = await chooseReviewDecision(ctx, current.spec);
		if (!decision) return submitted;
		switch (decision) {
			case "implement":
				return startImplementation(ctx, current.state.planRef!, actorFor(ctx));
			case "edit_feedback":
				return editPlan(ctx);
			case "continue_planning": {
				const result = await dispatch(ctx, "continue_planning");
				if (result.ok) {
					toolSession.applyPlanning(managedToolsForStatus("planning"));
					pi.sendMessage(
						{ customType: "plan-mode/continue-planning-v2", content: "Continue read-only research and submit a new plan version when ready.", display: false },
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				}
				updateUI(ctx);
				return result;
			}
			case "cancel": {
				const result = await dispatch(ctx, "cancel", { reason: "Cancelled from review panel" });
				if (result.ok) await restoreAndArchive(ctx, "Review cancellation archived");
				return result;
			}
		}
	}

	async function exactRefForInteractive(ctx: ExtensionContext, resume: boolean): Promise<PlanRef | undefined> {
		const current = ensureController(ctx);
		const ref = current.state.planRef;
		if (!ref || !ctx.hasUI) return undefined;
		if (current.spec) return (await confirmImplementation(ctx, current.spec, resume)) ? ref : undefined;
		if (current.legacySpec) {
			const confirmed = await ctx.ui.confirm(
				"Migrate and resume legacy plan?",
				`${current.legacySpec.goal}\n\nA new v2 lineage will be created. Old approval/grant will not be reused. Implementation enables ${MANDATORY_IMPLEMENTATION_TOOLS.join(", ")}.`,
			);
			return confirmed ? ref : undefined;
		}
		return undefined;
	}

	async function handleCommand(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		const current = ensureController(ctx);
		const tokens = tokenize(rawArgs.trim());
		if (tokens.length === 0) {
			emitResult(ctx, current.state.status === "inactive" ? await startFromPrompt(ctx) : await dispatch(ctx, "status"));
			return;
		}
		const rawAction = tokens.shift()!;
		const known = new Set(["start", "status", "show", "diff", "edit", "continue", "implement", "run", "pause", "resume", "cancel", "audit", "reset"]);
		if (!known.has(rawAction)) {
			emitResult(ctx, await startWithGoal(ctx, [rawAction, ...tokens].join(" ")));
			return;
		}
		let result: PlanActionResult;
		switch (rawAction) {
			case "start":
				result = await startWithGoal(ctx, tokens.join(" "));
				break;
			case "status":
				result = await dispatch(ctx, "status");
				break;
			case "show":
				result = await dispatch(ctx, "show");
				emitResult(ctx, result);
				if (result.ok && current.spec) emitMessage(ctx, "plan-mode/review-v2", renderPlanMarkdown(current.spec));
				else if (result.ok && current.legacySpec) emitMessage(ctx, "plan-mode/legacy-review", renderLegacyPlanMarkdown(current.legacySpec));
				return;
			case "diff": {
				const versions = tokens.map(Number);
				result = versions.length > 2 || versions.some((version) => !Number.isSafeInteger(version) || version < 1)
					? resultError(current, "diff", { code: "INVALID_ACTION", message: "Usage: /plan diff [fromVersion] [toVersion]", retryable: true })
					: await dispatch(ctx, "diff", { fromVersion: versions[0], toVersion: versions[1] });
				break;
			}
			case "edit":
				result = await editPlan(ctx);
				break;
			case "continue":
				result = await dispatch(ctx, "continue_planning");
				if (result.ok) toolSession.applyPlanning(managedToolsForStatus("planning"));
				break;
			case "implement":
			case "run":
			case "resume": {
				let expected = expectedFromTokens(current, tokens);
				if (!expected) expected = await exactRefForInteractive(ctx, rawAction === "resume");
				result = expected
					? await startImplementation(ctx, expected)
					: resultError(current, rawAction === "resume" ? "resume" : "implement", {
							code: ctx.hasUI ? "APPROVAL_REQUIRED" : "PLAN_REF_MISMATCH",
							message: "Implementation requires one explicit confirmation bound to the exact PlanRef",
							retryable: true,
						});
				break;
			}
			case "pause":
				if (!ctx.isIdle()) ctx.abort();
				result = await dispatch(ctx, "pause", { reason: tokens.join(" ") || "Paused by user" });
				if (result.ok) {
					toolSession.applyPlanning(managedToolsForStatus("paused"));
					loop.reset();
				}
				break;
			case "cancel":
				if (!ctx.isIdle()) ctx.abort();
				result = await dispatch(ctx, "cancel", { reason: tokens.join(" ") || "Cancelled by user" });
				if (result.ok) await restoreAndArchive(ctx, "Cancelled plan archived");
				break;
			case "audit":
				result = await dispatch(ctx, "audit");
				emitResult(ctx, result);
				emitMessage(
					ctx,
					"plan-mode/audit-view-v2",
					current.events.slice(-30).map((event) => `${event.sequence} ${event.occurredAt} ${event.action} ${event.decision} ${event.reason ?? ""}`).join("\n") || "No v2 audit events",
				);
				return;
			case "reset":
				if (current.state.status === "stale" || current.state.status === "completed" || current.state.status === "cancelled" || current.state.status === "failed") {
					await restoreAndArchive(ctx, "Manual reset archived plan tracking");
					result = await dispatch(ctx, "status");
				} else {
					result = resultError(current, "status", { code: "INVALID_STATE", message: "Reset is available only for terminal or stale state", retryable: true });
				}
				break;
			default:
				result = resultError(current, "status", { code: "INVALID_ACTION", message: `Unsupported action: ${rawAction}`, retryable: true });
		}
		updateUI(ctx);
		emitResult(ctx, result);
	}

	pi.registerCommand("plan", {
		description: "Plan read-only, review once, then implement continuously with normal Pi tools",
		handler: handleCommand,
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Start or inspect Plan Mode v2",
		handler: async (ctx) => {
			const current = ensureController(ctx);
			emitResult(ctx, current.state.status === "inactive" ? await startFromPrompt(ctx) : await dispatch(ctx, "status"));
		},
	});

	pi.registerTool({
		name: QUESTION_TOOL,
		label: "Request plan clarification",
		description: "Request explicit user input only for a material planning decision.",
		promptGuidelines: [
			"Use plan_question only for ambiguity that materially changes the plan.",
			"Ask one focused question and provide choices when practical.",
		],
		parameters: Type.Object({
			question: Type.String({ minLength: 1, maxLength: 2000 }),
			choices: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 20 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const modelActor = { channel: "model" as const, id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" };
			const pending = await dispatch(ctx, "request_input", { question: params.question, choices: params.choices }, undefined, modelActor);
			if (!pending.ok) throw new Error(formatResult(pending));
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: `${formatResult(pending)}\nAWAITING_INPUT: ${params.question}` }],
					details: pending,
					terminate: true,
				};
			}
			const answer = params.choices?.length
				? await ctx.ui.select(params.question, params.choices)
				: await ctx.ui.input(params.question, "User answer");
			if (!answer?.trim()) {
				return { content: [{ type: "text", text: "Clarification cancelled; waiting for explicit input." }], details: pending, terminate: true };
			}
			const answered = await dispatch(ctx, "answer", { note: answer.trim() });
			if (!answered.ok) throw new Error(formatResult(answered));
			return { content: [{ type: "text", text: `Explicit user answer: ${answer.trim()}` }], details: answered };
		},
	});

	pi.registerTool({
		name: SUBMIT_TOOL,
		label: "Submit plan for review",
		description: "Submit a concise PlanSpec v2 for one review decision. IDs, versions, hashes and permissions are generated internally.",
		promptGuidelines: [
			"Use plan_submit after research and material clarification are complete.",
			"Plan steps should state concrete actions, informational files, and validation; do not declare capabilities or path grants.",
		],
		parameters: Type.Object({
			goal: Type.String({ minLength: 1, maxLength: 16_384 }),
			decisions: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
			steps: Type.Array(
				Type.Object({
					title: Type.String({ minLength: 1, maxLength: 1024 }),
					actions: Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 256 }),
					files: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 }),
					validation: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
				}),
				{ minItems: 1, maxItems: 128 },
			),
			risks: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const modelActor = { channel: "model" as const, id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" };
			const submitted = await dispatch(ctx, "submit", { draft: params as PlanDraft }, undefined, modelActor);
			if (!submitted.ok) throw new Error(formatResult(submitted));
			const result = await handleReview(ctx, submitted);
			if (!result.ok) throw new Error(formatResult(result));
			const text = result.state.status === "implementing"
				? `${formatResult(result)}\nImplementation tools were read back successfully. A follow-up turn has been queued.`
				: result.state.status === "planning"
					? `${formatResult(result)}\nContinue planning and submit a new version when ready.`
					: `${formatResult(result)}\nPlan remains available for review.`;
			return { content: [{ type: "text", text }], details: result, terminate: true };
		},
	});

	pi.registerTool({
		name: COMPLETE_TOOL,
		label: "Report current plan step complete",
		description: "Report the current step complete with a concise summary. Tool evidence is recorded for audit but is not a completion gate.",
		promptGuidelines: [
			"Call plan_step_complete after finishing the current step and its validation.",
			"Use plan_blocked instead when implementation genuinely cannot continue.",
		],
		parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 4096 }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const modelActor = { channel: "model" as const, id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" };
			const result = await dispatch(ctx, "complete_step", { note: params.summary }, undefined, modelActor);
			if (!result.ok) throw new Error(formatResult(result));
			if (result.state.status === "stale") {
				return { content: [{ type: "text", text: `${formatResult(result)}\nReport recorded only; stale plan progress did not advance.` }], details: result, terminate: true };
			}
			queueDecision(ctx, loop.onStepReported(result.state));
			updateUI(ctx);
			return {
				content: [{ type: "text", text: result.state.status === "completed" ? "All steps reported complete; final summary queued." : `Step reported complete; continuing with ${result.state.currentStepId}.` }],
				details: result,
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: BLOCK_TOOL,
		label: "Pause blocked plan",
		description: "Pause continuous implementation for a real blocker, material plan change or high-risk decision.",
		parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 4096 }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const modelActor = { channel: "model" as const, id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" };
			const result = await dispatch(ctx, "block", { reason: params.reason }, undefined, modelActor);
			if (!result.ok) throw new Error(formatResult(result));
			if (result.state.status === "paused") toolSession.applyPlanning(managedToolsForStatus("paused"));
			loop.reset();
			updateUI(ctx);
			return {
				content: [{ type: "text", text: `${formatResult(result)}\nImplementation paused: ${params.reason}\nWait for explicit user input and /plan resume.` }],
				details: result,
				terminate: true,
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const current = ensureController(ctx);
		const evaluatedRevision = current.state.revision;
		const managedTools = PLAN_MANAGED_TOOLS.map((name) => ({ name, sourcePath: EXTENSION_SOURCE }));
		const evaluateLatest = () => evaluateToolCall({
			state: current.state,
			registry,
			permissions: current.researchPermissions,
			toolName: event.toolName,
			input: event.input,
			toolInfo: pi.getAllTools().find((tool) => tool.name === event.toolName),
			cwd: ctx.cwd,
			readRoots: [ctx.cwd],
			managedTools,
		});
		let decision = evaluateLatest();
		if (decision.permissionRequired && decision.sourceDigest && decision.capabilities) {
			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Allow research capability for this plan?",
					`Tool: ${event.toolName}\nCapabilities: ${decision.capabilities.join(", ")}\nThis permission is remembered only for the current plan and exact tool source.`,
				);
				try {
					await current.recordResearchPermission(actorFor(ctx), scopeFor(ctx), {
						toolName: event.toolName,
						capabilities: decision.capabilities,
						sourceDigest: decision.sourceDigest,
						decision: confirmed ? "allow" : "deny",
					});
				} catch (error) {
					return { block: true, reason: `Plan Mode failed closed while recording research permission: ${error instanceof Error ? error.message : String(error)}` };
				}
				decision = evaluateLatest();
			}
		}
		let inputDigest: string | undefined;
		try {
			inputDigest = sha256(canonicalJson(event.input));
		} catch {
			inputDigest = undefined;
		}
		const modelActor = { channel: "model" as const, id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" };
		try {
			await current.recordPolicyDecision(modelActor, scopeFor(ctx), event.toolName, event.toolCallId, decision.allow, decision.reason, inputDigest);
		} catch (error) {
			return { block: true, reason: `Plan Mode failed closed because audit persistence failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!decision.allow) return { block: true, reason: `Plan Mode (${SECURITY_LEVEL}): ${decision.reason}` };
		const finalDecision = evaluateLatest();
		if (current.state.revision !== evaluatedRevision || !finalDecision.allow) {
			const reason = current.state.revision !== evaluatedRevision
				? `Plan state revision changed during preflight (${evaluatedRevision} -> ${current.state.revision})`
				: `Final policy recheck failed: ${finalDecision.reason}`;
			return { block: true, reason: `Plan Mode (${SECURITY_LEVEL}): ${reason}` };
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status !== "implementing" || CONTROL_TOOLS.has(event.toolName)) return;
		let digest: string | undefined;
		try {
			digest = sha256(canonicalJson({ content: event.content, details: event.details, isError: event.isError }));
		} catch {
			digest = undefined;
		}
		await current.recordToolResult({ channel: "system", id: "tool-runtime" }, scopeFor(ctx), {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			success: !event.isError,
			summary: `${event.toolName} ${event.isError ? "failed" : "succeeded"}; result body redacted`,
			digest,
		});
		updateUI(ctx);
	});

	pi.on("input", async (event, ctx) => {
		const current = ensureController(ctx);
		if (pendingStartupNotice) {
			emitResult(ctx, pendingStartupNotice);
			pendingStartupNotice = undefined;
		}
		if (pendingFlagAction) {
			const pending = pendingFlagAction;
			pendingFlagAction = undefined;
			let result: PlanActionResult;
			if ((pending.action === "implement" || pending.action === "run" || pending.action === "resume") && pending.expectedPlan) {
				result = await startImplementation(ctx, pending.expectedPlan, pending.actor);
			} else if (pending.action === "diff") {
				const versions = [pending.extra.fromVersion, pending.extra.toVersion].filter((value): value is number => value !== undefined);
				result = versions.some((value) => !Number.isSafeInteger(value) || value < 1)
					? resultError(current, "diff", { code: "INVALID_ACTION", message: "Diff versions must be positive integers", retryable: true })
					: await dispatch(ctx, "diff", pending.extra, pending.expectedPlan, pending.actor);
			} else {
				result = await dispatch(ctx, pending.action, pending.extra, pending.expectedPlan, pending.actor);
			}
			emitResult(ctx, result);
			return { action: "handled" };
		}
		if (current.state.status !== "awaiting_input") return { action: "continue" };
		const result = await dispatch(ctx, "answer", { note: event.text });
		emitResult(ctx, result);
		return result.ok ? { action: "continue" } : { action: "handled" };
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => {
			const customType = (message as { customType?: string }).customType;
			return (
				customType !== CONTEXT_TYPE &&
				customType !== "plan-mode/review-v2" &&
				customType !== "plan-mode/continue-v2" &&
				customType !== "plan-mode/continue-planning-v2"
			);
		}),
	}));

	pi.on("before_agent_start", async (_event, ctx) => {
		const current = ensureController(ctx);
		const applied = applyStateTools(ctx);
		if (!applied.ok && current.state.status === "implementing") {
			await dispatch(ctx, "pause", { reason: applied.reason ?? "Implementation tools disappeared" }, undefined, { channel: "system", id: "tool-readback-guard" });
			toolSession.applyPlanning(managedToolsForStatus("paused"));
			loop.reset();
		}
		updateUI(ctx);
		const state = current.state;
		if (state.status === "inactive") return;
		const spec = current.spec;
		const step = spec?.steps.find((candidate) => candidate.id === state.currentStepId);
		const content = state.status === "planning"
			? "Plan read-only. Use only source-verified research tools. Ask material questions with plan_question. Submit goal, decisions, steps(title/actions/files/validation), and risks with plan_submit. Do not declare capability/path grants."
			: state.status === "awaiting_input"
				? `Wait for clarification: ${state.pendingInput?.prompt ?? "input required"}`
				: state.status === "review"
					? "The plan is awaiting an explicit review decision. Do not implement or self-approve."
					: state.status === "implementing" && step
						? `Implement ${step.id}: ${step.title}. Actions: ${step.actions.join("; ")}. Files: ${step.files.join(", ") || "not specified"}. Validation: ${step.validation.join("; ") || "verify appropriately"}. Ordinary tools use normal Pi permissions. Call ${COMPLETE_TOOL} with a concise summary when done, or ${BLOCK_TOOL} for a real blocker.`
						: state.status === "completed"
							? "All steps are complete. Give the final changed-files, validation, deviations, and risks summary now."
							: state.status === "paused"
								? "Plan implementation is paused. Do not mutate until the user confirms /plan resume."
								: state.status === "stale"
									? `Plan integrity is stale: ${state.reason ?? "unknown error"}. Report only; do not implement.`
									: "Plan tracking is terminal; do not perform plan work.";
		return {
			message: {
				customType: CONTEXT_TYPE,
				display: false,
				content: `[PLAN MODE v2]\nstate=${state.status}\nrevision=${state.revision}\nsecurity=${SECURITY_LEVEL}\n\n${content}`,
			},
		};
	});

	pi.on("agent_start", () => {
		loop.onAgentStart();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const current = ensureController(ctx);
		const decision = loop.onSettled(current.state);
		if (decision.kind === "queue-step" || decision.kind === "queue-final") {
			queueDecision(ctx, decision);
			return;
		}
		if (decision.kind === "pause") {
			const paused = await dispatch(ctx, "pause", { reason: decision.reason }, undefined, { channel: "system", id: "settled-loop-guard" });
			if (paused.ok) toolSession.applyPlanning(managedToolsForStatus("paused"));
			updateUI(ctx);
			emitResult(ctx, paused);
			if (ctx.hasUI) ctx.ui.notify(decision.reason, "warning");
			return;
		}
		if (decision.kind === "archive") await restoreAndArchive(ctx, decision.reason);
	});

	pi.on("model_select", async (_event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status !== "implementing") return;
		if (!ctx.isIdle()) ctx.abort();
		const paused = await dispatch(ctx, "pause", { reason: "Paused because the active model changed" }, undefined, { channel: "system", id: "model-change-guard" });
		if (paused.ok) toolSession.applyPlanning(managedToolsForStatus("paused"));
		loop.reset();
		updateUI(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		if (!deckModeListener) {
			deckModeListener = pi.events.on("operations-deck:mode", (data) => {
				const controlled = (data as { mode?: string } | undefined)?.mode === "full";
				if (controlled !== deckControlsWidget) {
					deckControlsWidget = controlled;
					updateUI(ctx);
				}
			});
		}
		const initialActiveTools = pi.getActiveTools();
		const current = ensureController(ctx);
		await current.recover(ctx.sessionManager.getBranch(), event.reason, scopeFor(ctx), { activeTools: initialActiveTools });
		if (current.legacySpec && !current.baseline) legacyBaselineCandidate = initialActiveTools;
		if (current.state.status === "completed" || current.state.status === "cancelled" || current.state.status === "failed") {
			await restoreAndArchive(ctx, "Recovered terminal plan archived");
		} else {
			applyStateTools(ctx);
		}
		if (!configNoticeShown && (loadedConfig.diagnostics.length || registry.diagnostics.length)) {
			configNoticeShown = true;
			const message = [...loadedConfig.diagnostics, ...registry.diagnostics].map((item) => item.message).join("; ");
			if (ctx.hasUI) ctx.ui.notify(`Plan policy diagnostics: ${message}`, "warning");
		}
		if (!startupFlagsHandled && event.reason === "startup") {
			startupFlagsHandled = true;
			if (pi.getFlag("plan") === true && current.state.status === "inactive") {
				pendingStartupNotice = await startWithGoal(ctx, asStringFlag(pi, "plan-goal") ?? "Plan the user's initial request");
			}
			const rawAction = asStringFlag(pi, "plan-action");
			if (rawAction) {
				const aliases: Record<string, PlanAction> = { execute: "implement", approve: "implement" };
				pendingFlagAction = {
					action: aliases[rawAction] ?? (rawAction as PlanAction),
					expectedPlan: expectedFromFlags(pi),
					extra: {
						goal: asStringFlag(pi, "plan-goal"),
						fromVersion: asVersionFlag(pi, "plan-from-version"),
						toVersion: asVersionFlag(pi, "plan-to-version"),
					},
					actor: { channel: ctx.mode, id: `cli-${ctx.mode}-unverified` },
				};
			}
		}
		updateUI(ctx);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status !== "implementing") return;
		if (!ctx.isIdle()) ctx.abort();
		await dispatch(ctx, "pause", { reason: "Paused before session replacement" }, undefined, { channel: "system", id: "session-switch-guard" });
		toolSession.applyPlanning(managedToolsForStatus("paused"));
		loop.reset();
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		const current = ensureController(ctx);
		treeFallbackBaseline = current.baseline;
		if (current.state.status === "implementing") {
			if (!ctx.isIdle()) ctx.abort();
			await dispatch(ctx, "pause", { reason: "Paused before tree navigation" }, undefined, { channel: "system", id: "tree-guard" });
			toolSession.applyPlanning(managedToolsForStatus("paused"));
			loop.reset();
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		const current = ensureController(ctx);
		await current.recover(ctx.sessionManager.getBranch(), "tree", scopeFor(ctx), { activeTools: pi.getActiveTools() });
		if (current.state.status === "inactive" && treeFallbackBaseline) toolSession.restoreBaseline(treeFallbackBaseline);
		else applyStateTools(ctx);
		treeFallbackBaseline = undefined;
		loop.reset();
		updateUI(ctx);
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status !== "implementing") return;
		if (!ctx.isIdle()) ctx.abort();
		await dispatch(ctx, "pause", { reason: "Paused before fork/clone" }, undefined, { channel: "system", id: "fork-guard" });
		toolSession.applyPlanning(managedToolsForStatus("paused"));
		loop.reset();
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		updateUI(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		applyStateTools(ctx);
		updateUI(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const current = controller;
		if (current?.state.status === "implementing") {
			await current.dispatch(
				request("pause", { channel: "system", id: "shutdown-guard" }),
				{ scope: scopeFor(ctx), reason: "Paused during session shutdown" },
			);
		}
		deckModeListener?.();
		deckModeListener = undefined;
		deckControlsWidget = false;
	});
}
