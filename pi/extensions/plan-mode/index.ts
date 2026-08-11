import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PlanArtifactStore, renderPlanMarkdown } from "./src/artifact-store.ts";
import { canonicalJson, sha256 } from "./src/canonical.ts";
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
} from "./src/domain.ts";
import { AUDIT_ENTRY_TYPE } from "./src/journal.ts";
import { calculatePolicyDigest, evaluateToolCall } from "./src/policy.ts";
import { buildPlanProgressLines } from "./src/ui.ts";
import { captureWorkspaceSnapshot, dependencyScopes, WorkspaceSnapshotError } from "./src/workspace.ts";

const CONTEXT_TYPE = "plan-mode/context";
const RESULT_TYPE = "plan-mode/action-result";
const SUBMIT_TOOL = "plan_submit";
const QUESTION_TOOL = "plan_question";
const COMPLETE_TOOL = "plan_step_complete";
const BLOCK_TOOL = "plan_blocked";
const READ_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["edit", "write"];
const PROCESS_TOOLS = ["bash"];
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

function contextDigest(ctx: ExtensionContext): string {
	return sha256(
		canonicalJson({
			cwd: path.resolve(ctx.cwd),
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
			contract: "pi-plan-mode/context-v1",
		}),
	);
}

function policyDigest(pi: ExtensionAPI): string {
	return calculatePolicyDigest(pi.getAllTools(), EXTENSION_SOURCE);
}

async function environmentFor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	controller: PlanController,
	action: PlanAction,
	extra: Partial<ActionEnvironment> = {},
): Promise<ActionEnvironment> {
	let workspaceSnapshot = extra.workspaceSnapshot;
	if (!workspaceSnapshot && (action === "submit" || action === "edit") && extra.draft) {
		workspaceSnapshot = await captureWorkspaceSnapshot(ctx.cwd, dependencyScopes(extra.draft));
	} else if (
		!workspaceSnapshot &&
		new Set<PlanAction>(["approve", "run", "execute", "resume"]).has(action) &&
		controller.spec?.workspaceSnapshot
	) {
		workspaceSnapshot = await captureWorkspaceSnapshot(ctx.cwd, dependencyScopes(controller.spec));
	}
	return {
		scope: scopeFor(ctx),
		policyDigest: policyDigest(pi),
		contextDigest: contextDigest(ctx),
		...extra,
		...(workspaceSnapshot ? { workspaceSnapshot } : {}),
	};
}

function formatResult(result: PlanActionResult): string {
	const ref = result.planRef ? `${result.planRef.planId}@${result.planRef.version}:${result.planRef.contentHash.slice(0, 12)}` : "none";
	if (!result.ok) {
		return `PLAN_ACTION_ERROR ${result.error?.code ?? "UNKNOWN"}: ${result.error?.message ?? "Unknown error"}\nstate=${result.state.status} plan=${ref} security=${SECURITY_LEVEL}`;
	}
	return `PLAN_ACTION_OK state=${result.state.status} plan=${ref} epoch=${result.state.epoch} security=${SECURITY_LEVEL}`;
}

function formatTuiResult(result: PlanActionResult): string {
	if (!result.ok) return `Plan Mode: ${result.error?.message ?? "Action failed"}`;
	switch (result.state.status) {
		case "inactive":
			return "Plan Mode is inactive.";
		case "researching":
			return "Plan Mode started — researching read-only.";
		case "awaiting_input":
			return `Plan Mode needs input: ${result.pendingInput?.prompt ?? "clarification required"}`;
		case "review":
			return "Plan ready — confirm once to execute all Todos.";
		case "approved":
			return "Plan approved — ready to run.";
		case "executing":
			return "Plan execution is running.";
		case "paused":
			return `Plan paused${result.state.reason ? `: ${result.state.reason}` : "."}`;
		case "completed":
			return "All plan Todos completed.";
		case "stale":
		case "failed":
		case "rejected":
		case "cancelled":
			return `Plan ${result.state.status}${result.state.reason ? `: ${result.state.reason}` : "."}`;
	}
}

function resultError(controller: PlanController, action: PlanAction, code: PlanActionResult["error"]): PlanActionResult {
	return {
		requestId: `${action}-${randomUUID()}`,
		ok: false,
		state: controller.state,
		planRef: controller.state.planRef,
		error: code,
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

function editableDraft(spec: NonNullable<PlanController["spec"]>): PlanDraft {
	return {
		goal: spec.goal,
		facts: spec.facts,
		assumptions: spec.assumptions,
		steps: spec.steps,
		risks: spec.risks,
	};
}

function tokenize(value: string): string[] {
	const tokens: string[] = [];
	for (const match of value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) tokens.push(match[1] ?? match[2] ?? match[3]);
	return tokens;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let controller: PlanController | undefined;
	let baselineTools: string[] | undefined;
	let startupFlagsHandled = false;
	let pendingStartupNotice: PlanActionResult | undefined;
	let pendingFlagAction:
		| { action: PlanAction; expectedPlan?: PlanRef; extra: Partial<ActionEnvironment>; actor: Actor }
		| undefined;
	let lastExecutionSignature: string | undefined;
	let stagnantExecutionTurns = 0;
	let autonomousContinuationTurns = 0;
	const MAX_STAGNANT_TURNS = 2;
	const MAX_AUTONOMOUS_CONTINUATIONS = 256;

	pi.registerFlag("plan", { description: "Start in strict Plan Mode", type: "boolean", default: false });
	pi.registerFlag("plan-action", { description: "Non-interactive Plan Mode action", type: "string" });
	pi.registerFlag("plan-goal", { description: "Goal for --plan or --plan-action start", type: "string" });
	pi.registerFlag("plan-id", { description: "Expected immutable plan id", type: "string" });
	pi.registerFlag("plan-version", { description: "Expected immutable plan version", type: "string" });
	pi.registerFlag("plan-hash", { description: "Expected immutable plan content hash", type: "string" });
	pi.registerFlag("plan-from-version", { description: "Source version for --plan-action diff", type: "string" });
	pi.registerFlag("plan-to-version", { description: "Target version for --plan-action diff", type: "string" });

	function ensureController(ctx: ExtensionContext): PlanController {
		if (controller) return controller;
		const cwd = path.resolve(ctx.cwd);
		const root = process.env.PI_PLAN_MODE_HOME || PlanArtifactStore.defaultRoot();
		const store = new PlanArtifactStore(root, cwd);
		controller = new PlanController({
			store,
			journal: { append: (event) => pi.appendEntry(AUDIT_ENTRY_TYPE, event) },
		});
		baselineTools = undefined;
		return controller;
	}

	async function enforceLiveDrift(ctx: ExtensionContext): Promise<void> {
		const current = ensureController(ctx);
		if (!new Set(["approved", "executing", "paused"]).has(current.state.status) || !current.spec) return;
		if (current.spec.policyDigest !== policyDigest(pi) || current.spec.contextDigest !== contextDigest(ctx)) {
			await current.markStale({ channel: "system", id: "live-drift-guard" }, scopeFor(ctx), "Live cwd/model/tool policy drifted from approved PlanSpec");
			return;
		}
		if (current.state.status !== "executing" && current.spec.workspaceSnapshot) {
			try {
				const actual = await captureWorkspaceSnapshot(ctx.cwd, dependencyScopes(current.spec));
				await current.revalidateWorkspace({ channel: "system", id: "workspace-drift-guard" }, scopeFor(ctx), actual);
			} catch (error) {
				await current.markStale(
					{ channel: "system", id: "workspace-drift-guard" },
					scopeFor(ctx),
					`Workspace dependency snapshot failed closed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	function applyVisibleTools(ctx: ExtensionContext): void {
		const current = ensureController(ctx);
		const state = current.state;
		const allNames = new Set(pi.getAllTools().map((tool) => tool.name));
		if (state.status === "inactive") {
			if (baselineTools) pi.setActiveTools(baselineTools.filter((name) => allNames.has(name)));
			baselineTools = undefined;
			return;
		}
		if (!baselineTools) baselineTools = pi.getActiveTools();
		const visible = READ_TOOLS.filter((name) => allNames.has(name));
		if (new Set(["researching", "review", "stale"]).has(state.status) && allNames.has(SUBMIT_TOOL)) {
			visible.push(SUBMIT_TOOL);
		}
		if (state.status === "researching" && allNames.has(QUESTION_TOOL)) visible.push(QUESTION_TOOL);
		if (state.status === "executing") {
			const step = current.spec?.steps.find((candidate) => candidate.id === state.currentStepId);
			if (allNames.has(COMPLETE_TOOL)) visible.push(COMPLETE_TOOL);
			if (allNames.has(BLOCK_TOOL)) visible.push(BLOCK_TOOL);
			if (step?.requiredCapabilities.includes("fs.write")) {
				for (const name of WRITE_TOOLS) {
					if (allNames.has(name) && baselineTools.includes(name)) visible.push(name);
				}
			}
			if (step?.requiredCapabilities.includes("process.exec")) {
				for (const name of PROCESS_TOOLS) {
					if (allNames.has(name) && baselineTools.includes(name)) visible.push(name);
				}
			}
		}
		pi.setActiveTools([...new Set(visible)]);
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const current = ensureController(ctx);
		const state = current.state;
		if (state.status === "inactive") {
			ctx.ui.setStatus("plan-mode", undefined);
			ctx.ui.setWidget("plan-mode", undefined);
			return;
		}
		const color = state.status === "executing" ? "accent" : state.status === "failed" || state.status === "stale" ? "error" : "warning";
		const spec = current.spec;
		const label =
			state.status === "researching" || state.status === "awaiting_input" || state.status === "review"
				? "PLAN · READ ONLY"
				: state.status === "executing"
					? "PLAN · EXECUTING"
					: `PLAN · ${state.status.toUpperCase()}`;
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg(color, label));
		const lines = buildPlanProgressLines(spec, state);
		if (!lines) {
			ctx.ui.setWidget("plan-mode", undefined);
			return;
		}
		ctx.ui.setWidget("plan-mode", (_tui, theme) => ({
			render(width: number): string[] {
				return lines.map((line, index) => {
					const styled = theme.fg(index === 0 ? "accent" : "dim", line);
					return truncateToWidth(styled, width, theme.fg("dim", "…"));
				});
			},
			invalidate() {},
		}));
	}

	function emitMessage(ctx: ExtensionContext, customType: string, content: string, details?: unknown): void {
		if (ctx.mode === "print") {
			// Pi's guarded Print mode reserves raw stdout for the final assistant message;
			// the public Extension API has no raw-output method, so control results use stderr.
			process.stderr.write(`${content}\n`);
			return;
		}
		pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: false });
	}

	function emitResult(ctx: ExtensionContext, result: PlanActionResult): void {
		emitMessage(ctx, RESULT_TYPE, ctx.mode === "tui" ? formatTuiResult(result) : formatResult(result), result);
		if (result.ok && (result.data as PlanDiff | undefined)?.schema === "dev.pi.plan-diff/v1") {
			emitMessage(ctx, "plan-mode/diff", renderPlanDiffMarkdown(result.data as PlanDiff), result.data);
		}
		if (ctx.mode === "rpc") {
			emitMessage(
				ctx,
				"plan-mode/safety-warning",
				"PLAN_SAFETY_WARNING SAFETY_BOUNDARY_DEGRADED: RPC direct bash is outside Plan Mode; security=agent-tools-only",
			);
		}
	}

	async function dispatch(
		ctx: ExtensionContext,
		action: PlanAction,
		extra: Partial<ActionEnvironment> = {},
		expectedPlan?: PlanRef,
		actor = actorFor(ctx),
	): Promise<PlanActionResult> {
		const current = ensureController(ctx);
		const request: PlanActionRequest = {
			protocolVersion: ACTION_PROTOCOL,
			requestId: `${action}-${randomUUID()}`,
			action,
			expectedPlan,
			actor,
			payload: extra,
		};
		let environment: ActionEnvironment;
		try {
			environment = await environmentFor(pi, ctx, current, action, extra);
		} catch (error) {
			const code = action === "submit" || action === "edit" ? "INVALID_PLAN" : "STALE";
			const message = `${error instanceof WorkspaceSnapshotError ? "Workspace snapshot rejected" : "Workspace snapshot failed"}: ${error instanceof Error ? error.message : String(error)}`;
			if (code === "STALE" && new Set(["approved", "executing", "paused"]).has(current.state.status)) {
				try {
					await current.markStale({ channel: "system", id: "workspace-snapshot-guard" }, scopeFor(ctx), message);
				} catch (staleError) {
					const result = resultError(current, action, {
						code: "STORAGE_ERROR",
						message: `Failed to persist workspace-stale transition: ${staleError instanceof Error ? staleError.message : String(staleError)}`,
						retryable: false,
					});
					applyVisibleTools(ctx);
					updateUI(ctx);
					return result;
				}
			}
			const result = resultError(current, action, { code, message, retryable: true });
			applyVisibleTools(ctx);
			updateUI(ctx);
			return result;
		}
		const result = await current.dispatch(request, environment);
		applyVisibleTools(ctx);
		updateUI(ctx);
		return result;
	}

	function renderUserPlan(current: PlanController): string {
		const spec = current.spec;
		if (!spec) return "Plan details are unavailable.";
		const steps = spec.steps
			.map(
				(step, index) =>
					`### ${index + 1}. ${step.title}\n${step.actions.map((action) => `- ${action}`).join("\n")}\n- Acceptance: ${step.acceptance.join("; ")}\n- Changes: ${step.pathScopes.join(", ") || "none"}`,
			)
			.join("\n\n");
		const risks = spec.risks.length > 0 ? spec.risks.map((risk) => `- ${risk}`).join("\n") : "- None identified";
		return `# Plan: ${spec.goal}\n\n## Todos\n\n${steps}\n\n## Risks\n${risks}`;
	}

	function planConfirmationText(current: PlanController): string {
		const spec = current.spec;
		if (!spec) return "Plan details are unavailable.";
		const visibleSteps = spec.steps.slice(0, 12).map((step, index) => `${index + 1}. ${step.title}`).join("\n");
		const hiddenSteps = spec.steps.length > 12 ? `\n… ${spec.steps.length - 12} more steps` : "";
		const processWarning = spec.steps.some((step) => step.requiredCapabilities.includes("process.exec"))
			? "\n\n⚠ Includes approved bash/process execution. Commands run with your user permissions, are not path-sandboxed, and may have filesystem or network side effects."
			: "";
		const risks = spec.risks.length > 0 ? `\n\nRisks:\n${spec.risks.slice(0, 5).map((risk) => `• ${risk}`).join("\n")}` : "";
		return `${spec.goal}\n\nTodos (${spec.steps.length}):\n${visibleSteps}${hiddenSteps}${risks}${processWarning}`;
	}

	async function requireInteractivePlanRef(
		ctx: ExtensionContext,
		action: "approve" | "run" | "execute" | "resume",
	): Promise<PlanRef | undefined> {
		const current = ensureController(ctx);
		const ref = current.state.planRef;
		if (!ctx.hasUI || !ref) return undefined;
		const confirmed = await ctx.ui.confirm(
			action === "approve" ? "Approve this plan without starting it?" : "Execute this plan?",
			planConfirmationText(current),
		);
		return confirmed ? ref : undefined;
	}

	function queueExecutionTurn(ctx: ExtensionContext, reason: string): void {
		pi.sendMessage(
			{
				customType: "plan-mode/continue",
				content: `${reason}\nContinue the approved plan from the current Todo. Do not stop between steps; use ${COMPLETE_TOOL} after each step has the required successful tool evidence. If execution is genuinely blocked or needs a wider plan, call ${BLOCK_TOOL}.`,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	async function startWithGoal(ctx: ExtensionContext, goal: string): Promise<PlanActionResult> {
		const normalizedGoal = goal.trim();
		const result = await dispatch(ctx, "start", { goal: normalizedGoal });
		if (result.ok && ctx.hasUI) {
			if (ctx.isIdle()) pi.sendUserMessage(normalizedGoal);
			else pi.sendUserMessage(normalizedGoal, { deliverAs: "followUp" });
		}
		return result;
	}

	async function startFromInteractivePrompt(ctx: ExtensionContext): Promise<PlanActionResult> {
		const current = ensureController(ctx);
		if (!ctx.hasUI) {
			return resultError(current, "start", {
				code: "UI_REQUIRED",
				message: "Bare /plan requires TUI/RPC input; use /plan <goal> or /plan start <goal>",
				retryable: true,
			});
		}
		const goal = await ctx.ui.input("Plan goal", "Describe what should be researched and planned");
		return goal?.trim()
			? startWithGoal(ctx, goal)
			: resultError(current, "start", { code: "INVALID_PLAN", message: "Plan goal is required", retryable: true });
	}

	async function handleCommand(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		const current = ensureController(ctx);
		const tokens = tokenize(rawArgs.trim());
		if (tokens.length === 0) {
			const result =
				current.state.status === "inactive"
					? await startFromInteractivePrompt(ctx)
					: await dispatch(ctx, "status");
			emitResult(ctx, result);
			return;
		}
		let action = tokens.shift() as PlanAction;
		const known = new Set<PlanAction>([
			"start",
			"status",
			"show",
			"diff",
			"edit",
			"approve",
			"run",
			"execute",
			"reject",
			"pause",
			"resume",
			"verify",
			"cancel",
			"reset",
			"audit",
			"export",
		]);
		if (!known.has(action)) {
			tokens.unshift(action);
			action = "start";
		}

		let result: PlanActionResult;
		if (action === "start") {
			result = await startWithGoal(ctx, tokens.join(" "));
		} else if (action === "approve" || action === "run" || action === "execute" || action === "resume") {
			const effectiveAction: "approve" | "run" | "execute" | "resume" =
				action === "execute" && current.state.status === "review" ? "run" : action;
			let expected = expectedFromTokens(current, tokens);
			if (!expected) expected = await requireInteractivePlanRef(ctx, effectiveAction);
			if (!expected) {
				result = resultError(current, effectiveAction, {
					code: ctx.hasUI ? "APPROVAL_REQUIRED" : "PLAN_REF_MISMATCH",
					message: "The current plan must be explicitly confirmed; cancelled or missing exact PlanRef",
					retryable: true,
				});
			} else {
				result = await dispatch(ctx, effectiveAction, {}, expected);
			}
		} else if (action === "edit") {
			if (!ctx.hasUI || !current.spec) {
				result = resultError(current, action, {
					code: "UI_REQUIRED",
					message: "Interactive JSON editor requires TUI/RPC and an existing PlanSpec",
					retryable: true,
				});
			} else {
				const edited = await ctx.ui.editor("Edit canonical plan draft (creates a new immutable version)", JSON.stringify(editableDraft(current.spec), null, 2));
				try {
					const draft = edited ? (JSON.parse(edited) as PlanDraft) : undefined;
					result = draft
						? await dispatch(ctx, action, { draft })
						: resultError(current, action, { code: "INVALID_ACTION", message: "Edit cancelled", retryable: true });
				} catch (error) {
					result = resultError(current, action, {
						code: "INVALID_PLAN",
						message: `Edited JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
						retryable: true,
					});
				}
			}
		} else if (action === "reject" || action === "cancel") {
			if (!ctx.isIdle()) ctx.abort();
			result = await dispatch(ctx, action, { reason: tokens.join(" ") || undefined });
		} else if (action === "pause") {
			if (!ctx.isIdle()) ctx.abort();
			result = await dispatch(ctx, action, { reason: tokens.join(" ") || "Pause requested; abort issued if agent was active" });
		} else if (action === "verify") {
			result = await dispatch(ctx, action, { stepId: tokens.shift(), note: tokens.join(" ") });
		} else if (action === "show") {
			result = await dispatch(ctx, action);
			emitResult(ctx, result);
			if (result.ok && current.spec) emitMessage(ctx, "plan-mode/review", renderPlanMarkdown(current.spec));
			return;
		} else if (action === "diff") {
			const versions = tokens.map(Number);
			if (versions.length > 2 || versions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
				result = resultError(current, action, {
					code: "INVALID_ACTION",
					message: "Usage: /plan diff [fromVersion] [toVersion]",
					retryable: true,
				});
			} else {
				result = await dispatch(ctx, action, {
					fromVersion: versions[0],
					toVersion: versions[1],
				});
			}
			emitResult(ctx, result);
			return;
		} else if (action === "audit") {
			result = await dispatch(ctx, action);
			emitResult(ctx, result);
			const audit = current.events.slice(-20).map((event) => `${event.sequence} ${event.occurredAt} ${event.action} ${event.decision} ${event.reason ?? ""}`);
			emitMessage(ctx, "plan-mode/audit-view", audit.join("\n") || "No Plan Mode audit events");
			return;
		} else {
			result = await dispatch(ctx, action);
		}
		emitResult(ctx, result);
		if (result.ok && result.state.status === "executing" && new Set(["run", "execute", "resume"]).has(action)) {
			lastExecutionSignature = undefined;
			stagnantExecutionTurns = 0;
			autonomousContinuationTurns = 0;
			queueExecutionTurn(ctx, "Execution was confirmed.");
		}
	}

	pi.registerCommand("plan", {
		description: "Plan a task, confirm once, and execute it to completion",
		handler: handleCommand,
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Start or inspect strict Plan Mode",
		handler: async (ctx) => {
			const current = ensureController(ctx);
			emitResult(
				ctx,
				current.state.status === "inactive"
					? await startFromInteractivePrompt(ctx)
					: await dispatch(ctx, "status"),
			);
		},
	});

	pi.registerTool({
		name: QUESTION_TOOL,
		label: "Request plan clarification",
		description: "Request explicit user input for a decision that materially affects the plan. Non-interactive modes enter awaiting_input instead of guessing.",
		promptGuidelines: [
			"Use plan_question instead of silently choosing a high-impact assumption.",
			"Ask one focused question and provide choices when the decision is enumerable.",
		],
		parameters: Type.Object({
			question: Type.String({ minLength: 1 }),
			choices: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const pending = await dispatch(
				ctx,
				"request_input",
				{ question: params.question, choices: params.choices },
				undefined,
				{ channel: "model", id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" },
			);
			if (!pending.ok) throw new Error(formatResult(pending));
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: `${formatResult(pending)}\nAWAITING_INPUT: ${params.question}\nStop; a later explicit user input is required.` }],
					details: pending,
				};
			}
			const answer = params.choices?.length
				? await ctx.ui.select(params.question, params.choices)
				: await ctx.ui.input(params.question, "User answer");
			if (!answer?.trim()) {
				return {
					content: [{ type: "text", text: `${formatResult(pending)}\nClarification cancelled; remain awaiting_input.` }],
					details: pending,
				};
			}
			const answered = await dispatch(ctx, "answer", { note: answer.trim() });
			if (!answered.ok) throw new Error(formatResult(answered));
			return {
				content: [{ type: "text", text: `Explicit user answer: ${answer.trim()}` }],
				details: answered,
			};
		},
	});

	pi.registerTool({
		name: SUBMIT_TOOL,
		label: "Create plan",
		description:
			"Create the structured plan shown to the user for one confirmation. This is the only managed write allowed while researching; it writes only to the extension-owned user plan store.",
		promptGuidelines: [
			"Use plan_submit only after research and clarification are complete.",
			"Declare dependencyScopes separately from mutation pathScopes; dependency drift invalidates approval.",
			"Every fs.write step must list exact project-relative files or directory roots ending in '/'.",
			"Declare process.exec only on steps that genuinely need built-in bash for tests, builds, or commands.",
		],
		parameters: Type.Object({
			goal: Type.String({ minLength: 1, maxLength: 16_384 }),
			facts: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
			assumptions: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
			steps: Type.Array(
				Type.Object({
					id: Type.String({ minLength: 1, maxLength: 128 }),
					title: Type.String({ minLength: 1, maxLength: 1024 }),
					purpose: Type.String({ minLength: 1, maxLength: 4096 }),
					actions: Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 256 }),
					dependencyScopes: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 }),
					pathScopes: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 }),
					requiredCapabilities: Type.Array(StringEnum(["fs.read", "fs.write", "process.exec"] as const), { maxItems: 3 }),
					acceptance: Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 256 }),
					rollback: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
				}),
				{ minItems: 1, maxItems: 128 },
			),
			risks: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const submitted = await dispatch(
				ctx,
				"submit",
				{ draft: params as PlanDraft },
				undefined,
				{ channel: "model", id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" },
			);
			if (!submitted.ok) throw new Error(formatResult(submitted));
			const current = ensureController(ctx);
			if (ctx.hasUI && current.spec) emitMessage(ctx, "plan-mode/review", renderUserPlan(current));
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: `${formatResult(submitted)}\nPlan created. Non-interactive execution requires one explicit 'run' action bound to the exact PlanRef.` }],
					details: submitted,
					terminate: true,
				};
			}
			const expected = await requireInteractivePlanRef(ctx, "run");
			if (!expected) {
				return {
					content: [{ type: "text", text: `${formatResult(submitted)}\nPlan created but not confirmed. Stop and wait for the user to revise or run it.` }],
					details: submitted,
					terminate: true,
				};
			}
			const running = await dispatch(ctx, "run", {}, expected);
			if (!running.ok) throw new Error(formatResult(running));
			lastExecutionSignature = undefined;
			stagnantExecutionTurns = 0;
			autonomousContinuationTurns = 0;
			return {
				content: [
					{
						type: "text",
						text: `${formatResult(running)}\nThe user confirmed once and execution is active. Plan Mode will start the execution turn automatically with the approved tools. Continue through every Todo without asking for per-step approval; after each step has successful evidence for its declared capabilities, call ${COMPLETE_TOOL}.`,
					},
				],
				details: running,
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: COMPLETE_TOOL,
		label: "Complete current plan step",
		description:
			"Mark the current Todo complete only after its declared capabilities have successful tool evidence, then advance automatically to the next Todo.",
		promptGuidelines: [
			"Call plan_step_complete after finishing the current step and checking its acceptance criteria.",
			"Provide a concise evidence-based summary; do not ask the user to verify ordinary steps.",
			`If blocked, do not call this tool—call ${BLOCK_TOOL} with the exact blocker instead.`,
		],
		parameters: Type.Object({
			summary: Type.String({ minLength: 1, maxLength: 4096 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await dispatch(
				ctx,
				"complete_step",
				{ note: params.summary },
				undefined,
				{ channel: "model", id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" },
			);
			if (!result.ok) throw new Error(formatResult(result));
			const current = ensureController(ctx);
			const next = current.spec?.steps.find((step) => step.id === result.state.currentStepId);
			return {
				content: [
					{
						type: "text",
						text:
							result.state.status === "completed"
								? `${formatResult(result)}\nAll Todos are complete. Give the user the final result, changed files, and validation summary.`
								: `${formatResult(result)}\nContinue immediately with ${next?.id ?? "the next Todo"}${next ? `: ${next.title}` : ""}; do not stop for user confirmation.`,
					},
				],
				details: result,
				// Each Todo gets a fresh LLM turn so capability/tool changes are guaranteed to apply.
				terminate: result.state.status !== "completed",
			};
		},
	});

	pi.registerTool({
		name: BLOCK_TOOL,
		label: "Pause blocked plan",
		description: "Pause autonomous execution immediately when the current plan cannot safely continue without user input or a revised scope.",
		promptGuidelines: [
			"Call plan_blocked only for a real blocker, material scope change, or newly discovered high-risk decision.",
			"State the exact blocker and what user decision or plan revision is needed.",
		],
		parameters: Type.Object({
			reason: Type.String({ minLength: 1, maxLength: 4096 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await dispatch(
				ctx,
				"pause",
				{ reason: params.reason },
				undefined,
				{ channel: "model", id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" },
			);
			if (!result.ok) throw new Error(formatResult(result));
			return {
				content: [{ type: "text", text: `${formatResult(result)}\nExecution paused for this blocker: ${params.reason}\nStop and wait for explicit user input or a revised plan.` }],
				details: result,
				terminate: true,
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const current = ensureController(ctx);
		try {
			await enforceLiveDrift(ctx);
		} catch (error) {
			return { block: true, reason: `Plan Mode failed closed while checking live policy drift: ${error instanceof Error ? error.message : String(error)}` };
		}
		const evaluatedState = current.state;
		if (evaluatedState.status === "inactive") return;
		const managedTools = [
			{ name: SUBMIT_TOOL, sourcePath: EXTENSION_SOURCE },
			{ name: QUESTION_TOOL, sourcePath: EXTENSION_SOURCE },
			{ name: COMPLETE_TOOL, sourcePath: EXTENSION_SOURCE },
			{ name: BLOCK_TOOL, sourcePath: EXTENSION_SOURCE },
		];
		const evaluateLatest = () =>
			evaluateToolCall({
				state: current.state,
				spec: current.spec,
				grant: current.grant,
				toolName: event.toolName,
				input: event.input,
				toolInfo: pi.getAllTools().find((tool) => tool.name === event.toolName),
				cwd: ctx.cwd,
				readRoots: [ctx.cwd],
				managedTools,
			});
		const decision = evaluateLatest();
		let digest: string | undefined;
		try {
			digest = sha256(canonicalJson(event.input));
		} catch {
			digest = undefined;
		}
		const modelActor = { channel: "model" as const, id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" };
		try {
			await current.recordPolicyDecision(
				modelActor,
				scopeFor(ctx),
				event.toolName,
				event.toolCallId,
				decision.allow,
				decision.reason,
				digest,
			);
		} catch (error) {
			return { block: true, reason: `Plan Mode failed closed because audit persistence failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!decision.allow) return { block: true, reason: `Plan Mode (${SECURITY_LEVEL}): ${decision.reason}` };
		const finalDecision = evaluateLatest();
		if (current.state.epoch !== evaluatedState.epoch || !finalDecision.allow) {
			const reason =
				current.state.epoch !== evaluatedState.epoch
					? `Policy epoch changed during preflight (${evaluatedState.epoch} -> ${current.state.epoch})`
					: `Final pre-execution recheck failed: ${finalDecision.reason}`;
			try {
				await current.recordPolicyDecision(modelActor, scopeFor(ctx), event.toolName, event.toolCallId, false, reason, digest);
			} catch {
				// The call is blocked regardless; the earlier durable preflight event remains.
			}
			return { block: true, reason: `Plan Mode (${SECURITY_LEVEL}): ${reason}` };
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status !== "executing" || CONTROL_TOOLS.has(event.toolName)) return;
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
			const diffVersions = [pending.extra.fromVersion, pending.extra.toVersion].filter((value): value is number => value !== undefined);
			const result =
				pending.action === "diff" && diffVersions.some((value) => !Number.isSafeInteger(value) || value < 1)
					? resultError(current, pending.action, {
							code: "INVALID_ACTION",
							message: "Diff version flags must be positive integers",
							retryable: true,
						})
					: await dispatch(ctx, pending.action, pending.extra, pending.expectedPlan, pending.actor);
			emitResult(ctx, result);
			if (result.ok && result.state.status === "executing") queueExecutionTurn(ctx, "Non-interactive execution was authorized.");
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
			return customType !== CONTEXT_TYPE && customType !== "plan-mode/review";
		}),
	}));

	pi.on("before_agent_start", async (_event, ctx) => {
		const current = ensureController(ctx);
		await enforceLiveDrift(ctx);
		applyVisibleTools(ctx);
		updateUI(ctx);
		const state = current.state;
		if (state.status === "inactive") return;
		const ref = state.planRef ? `${state.planRef.planId}@${state.planRef.version}:${state.planRef.contentHash}` : "not-yet-submitted";
		const step = current.spec?.steps.find((candidate) => candidate.id === state.currentStepId);
		return {
			message: {
				customType: CONTEXT_TYPE,
				display: false,
				content: `[PLAN MODE]\nstate=${state.status}\nepoch=${state.epoch}\nsecurity=${SECURITY_LEVEL}\nplanRef=${ref}\n\n` +
					(state.status === "researching"
						? "Research with built-in read/grep/find/ls only. Use plan_question only for material uncertainty. When ready, call plan_submit; it will show the plan and request one execution confirmation. Do not modify project files."
						: state.status === "awaiting_input"
							? `Stop and wait for the requested clarification: ${state.pendingInput?.prompt ?? "input required"}`
							: state.status === "review"
								? "The plan is ready but was not confirmed. Wait for the user to revise it or run it; never self-approve."
								: state.status === "approved"
									? "A legacy approval exists without an active grant. Wait for the user's run action."
									: state.status === "executing" && step
										? `Execute current Todo ${step.id}: ${step.title}. Allowed write paths: ${step.pathScopes.join(", ") || "none"}. Capabilities: ${step.requiredCapabilities.join(", ") || "fs.read"}. Acceptance: ${step.acceptance.join("; ")}. Continue without per-step user approval. Once successful tool evidence covers every declared capability, call ${COMPLETE_TOOL} with a concise summary and proceed to the next Todo. If genuinely blocked, a material scope change is required, or a new high-risk decision appears, call ${BLOCK_TOOL} with the exact reason instead of merely stopping.`
										: "Plan Mode is paused, stale, completed, or failed. Do not perform plan mutations until a valid user action or automatic completion cleanup."),
			},
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		const current = ensureController(ctx);
		const state = current.state;
		if (state.status === "completed") {
			if (ctx.hasUI) ctx.ui.notify("Plan completed", "info");
			const reset = await dispatch(ctx, "reset", {}, undefined, { channel: "system", id: "automatic-completion-cleanup" });
			if (!reset.ok) emitResult(ctx, reset);
			lastExecutionSignature = undefined;
			stagnantExecutionTurns = 0;
			autonomousContinuationTurns = 0;
			return;
		}
		if (state.status !== "executing") {
			lastExecutionSignature = undefined;
			stagnantExecutionTurns = 0;
			autonomousContinuationTurns = 0;
			return;
		}

		const stepState = state.currentStepId ? state.steps[state.currentStepId] : undefined;
		const signature = `${state.currentStepId ?? "none"}:${stepState?.evidenceIds.length ?? 0}`;
		stagnantExecutionTurns = signature === lastExecutionSignature ? stagnantExecutionTurns + 1 : 0;
		lastExecutionSignature = signature;
		if (stagnantExecutionTurns >= MAX_STAGNANT_TURNS || autonomousContinuationTurns >= MAX_AUTONOMOUS_CONTINUATIONS) {
			const reason =
				stagnantExecutionTurns >= MAX_STAGNANT_TURNS
					? "Execution paused after two automatic continuation turns made no tool-evidence progress"
					: "Execution paused after reaching the autonomous continuation safety limit";
			const paused = await dispatch(
				ctx,
				"pause",
				{ reason },
				undefined,
				{ channel: "system", id: "autonomous-continuation-guard" },
			);
			emitResult(ctx, paused);
			if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			return;
		}
		autonomousContinuationTurns += 1;
		queueExecutionTurn(ctx, `Todo ${state.currentStepId ?? "unknown"} is still active.`);
	});

	pi.on("session_start", async (event, ctx) => {
		const current = ensureController(ctx);
		const digests = { policyDigest: policyDigest(pi), contextDigest: contextDigest(ctx) };
		await current.recover(ctx.sessionManager.getBranch(), event.reason, scopeFor(ctx), digests);
		await enforceLiveDrift(ctx);
		if (!startupFlagsHandled && event.reason === "startup") {
			startupFlagsHandled = true;
			if (pi.getFlag("plan") === true && current.state.status === "inactive") {
				pendingStartupNotice = await dispatch(ctx, "start", {
					goal: asStringFlag(pi, "plan-goal") ?? "Plan the user's initial request without making project changes",
				});
			}
			const rawAction = asStringFlag(pi, "plan-action");
			if (rawAction) {
				const fromVersion = asVersionFlag(pi, "plan-from-version");
				const toVersion = asVersionFlag(pi, "plan-to-version");
				pendingFlagAction = {
					action: rawAction as PlanAction,
					expectedPlan: expectedFromFlags(pi),
					extra: {
						goal: asStringFlag(pi, "plan-goal"),
						fromVersion,
						toVersion,
					},
					actor: { channel: ctx.mode, id: `cli-${ctx.mode}-unverified` },
				};
			}
		}
		applyVisibleTools(ctx);
		updateUI(ctx);
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status === "executing") {
			if (!ctx.isIdle()) ctx.abort();
			await dispatch(ctx, "pause", { reason: "Paused before session tree navigation" }, undefined, { channel: "system", id: "tree-guard" });
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		const current = ensureController(ctx);
		await current.recover(ctx.sessionManager.getBranch(), "tree", scopeFor(ctx), {
			policyDigest: policyDigest(pi),
			contextDigest: contextDigest(ctx),
		});
		await enforceLiveDrift(ctx);
		applyVisibleTools(ctx);
		updateUI(ctx);
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status === "executing") {
			if (!ctx.isIdle()) ctx.abort();
			await dispatch(ctx, "pause", { reason: "Paused before fork/clone" }, undefined, { channel: "system", id: "fork-guard" });
		}
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		// Public API 0.84.1 cannot append instructions without replacing compaction.
		// The authoritative custom journal remains outside the lossy summary.
		updateUI(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Re-apply visibility immediately; before_agent_start re-injects the authoritative pointer next turn.
		applyVisibleTools(ctx);
		updateUI(ctx);
	});
}
