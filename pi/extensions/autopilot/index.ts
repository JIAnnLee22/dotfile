import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MissionArtifactStore, renderMissionMarkdown } from "./src/artifact-store.ts";
import { canonicalJson, sha256 } from "./src/canonical.ts";
import { AutopilotController } from "./src/controller.ts";
import {
	ACTION_PROTOCOL,
	SECURITY_LEVEL,
	type AcReportEntry,
	type ActionEnvironment,
	type Actor,
	type ActorChannel,
	type AutopilotAction,
	type AutopilotActionRequest,
	type AutopilotActionResult,
	type AutopilotErrorCode,
	type MissionDraft,
	type MissionRef,
	type MissionScope,
} from "./src/domain.ts";
import { AUDIT_ENTRY_TYPE } from "./src/journal.ts";
import { calculatePolicyDigest, evaluateToolCall } from "./src/policy.ts";
import { buildAcWidgetLines, buildAutopilotStatusSummary } from "./src/ui.ts";
import { captureWorkspaceSnapshot, dependencyScopes, WorkspaceSnapshotError } from "./src/workspace.ts";

const CONTEXT_TYPE = "autopilot/context";
const RESULT_TYPE = "autopilot/action-result";
const SUBMIT_TOOL = "autopilot_submit";
const REPORT_TOOL = "autopilot_report";
const BLOCK_TOOL = "autopilot_blocked";
const CONTROL_TOOLS = new Set([SUBMIT_TOOL, REPORT_TOOL, BLOCK_TOOL]);
const EXTENSION_SOURCE = import.meta.filename;
const READ_TOOLS = ["read", "grep", "find", "ls"];
const READONLY_EXT_TOOLS = ["ffgrep", "fffind"];
const WRITE_TOOLS = ["edit", "write"];
const PROCESS_TOOLS = ["bash"];

/** Natural-language triggers that arm autopilot from a plain user message (Chinese first, EN aliases). */
const TRIGGER_PATTERNS: readonly RegExp[] = [
	/一直自检|自检直到|自检到|直到.*(?:达到|达成|通过).*才?(?:停|停止|结束)/,
	/自主开发|全自主|自动开发.*(?:完成|验收)/,
	/(?:不用|不需要|无需).{0,6}(?:问|确认|干预|打扰)/,
	/验收通过|达到目标才|自己决定/,
	/autopilot|auto-pilot/i,
];

const MAX_STAGNANT_TURNS = 2;
const MAX_AUTONOMOUS_CONTINUATIONS = 128;

function actorChannel(ctx: ExtensionContext): ActorChannel {
	return ctx.mode;
}

function actorFor(ctx: ExtensionContext): Actor {
	return { channel: actorChannel(ctx), id: ctx.mode === "rpc" ? "rpc-client-unverified" : `local-${ctx.mode}` };
}

function scopeFor(ctx: ExtensionContext): MissionScope {
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
			contract: "pi-autopilot/context-v1",
		}),
	);
}

function policyDigest(pi: ExtensionAPI): string {
	return calculatePolicyDigest(pi.getAllTools(), EXTENSION_SOURCE);
}

async function environmentFor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	controller: AutopilotController,
	action: AutopilotAction,
	extra: Partial<ActionEnvironment> = {},
): Promise<ActionEnvironment> {
	let workspaceSnapshot = extra.workspaceSnapshot;
	if (!workspaceSnapshot && (action === "submit") && extra.draft) {
		workspaceSnapshot = await captureWorkspaceSnapshot(ctx.cwd, dependencyScopes(extra.draft));
	}
	return {
		scope: scopeFor(ctx),
		policyDigest: policyDigest(pi),
		contextDigest: contextDigest(ctx),
		...extra,
		...(workspaceSnapshot ? { workspaceSnapshot } : {}),
	};
}

function formatResult(result: AutopilotActionResult): string {
	const ref = result.missionRef ? `${result.missionRef.missionId}@${result.missionRef.version}:${result.missionRef.contentHash.slice(0, 12)}` : "none";
	if (!result.ok) {
		return `AUTOPILOT_ACTION_ERROR ${result.error?.code ?? "UNKNOWN"}: ${result.error?.message ?? "Unknown error"}\nstate=${result.state.status} mission=${ref} security=${SECURITY_LEVEL}`;
	}
	return `AUTOPILOT_ACTION_OK state=${result.state.status} mission=${ref} epoch=${result.state.epoch} security=${SECURITY_LEVEL}`;
}

function formatTuiResult(result: AutopilotActionResult): string {
	if (!result.ok) return `Autopilot: ${result.error?.message ?? "Action failed"}`;
	switch (result.state.status) {
		case "inactive":
			return "Autopilot is inactive.";
		case "drafting":
			return "Autopilot drafting — the agent will research and define acceptance criteria autonomously.";
		case "dryrun":
			return "Acceptance dry-run in progress — verifying that every criterion is executable before touching files.";
		case "running":
			return "Autopilot running — developing and self-checking until acceptance passes.";
		case "paused":
			return `Autopilot paused${result.state.reason ? `: ${result.state.reason}` : "."}`;
		case "completed":
			return "Autopilot completed — all acceptance criteria passed.";
		case "cancelled":
		case "failed":
			return `Autopilot ${result.state.status}${result.state.reason ? `: ${result.state.reason}` : "."}`;
	}
}

function resultError(controller: AutopilotController, action: AutopilotAction, code: AutopilotErrorCode, message: string): AutopilotActionResult {
	return {
		requestId: `${action}-${randomUUID()}`,
		ok: false,
		state: controller.state,
		missionRef: controller.state.missionRef,
		error: { code, message, retryable: true },
	};
}

function tokenize(value: string): string[] {
	const tokens: string[] = [];
	for (const match of value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) tokens.push(match[1] ?? match[2] ?? match[3]);
	return tokens;
}

export default function autopilotExtension(pi: ExtensionAPI): void {
	let controller: AutopilotController | undefined;
	let baselineTools: string[] | undefined;
	let startupFlagsHandled = false;
	let pendingStartupNotice: AutopilotActionResult | undefined;
	let pendingStartupGoal: string | undefined;
	let lastExecutionSignature: string | undefined;
	let stagnantExecutionTurns = 0;
	let autonomousContinuationTurns = 0;

	pi.registerFlag("autopilot", { description: "Start in Autopilot mode (autonomous development to acceptance)", type: "boolean", default: false });
	pi.registerFlag("autopilot-goal", { description: "Goal for --autopilot", type: "string" });

	function ensureController(ctx: ExtensionContext): AutopilotController {
		if (controller) return controller;
		const cwd = path.resolve(ctx.cwd);
		const root = process.env.PI_AUTOPILOT_HOME || MissionArtifactStore.defaultRoot();
		const store = new MissionArtifactStore(root, cwd);
		controller = new AutopilotController({
			store,
			journal: { append: (event) => pi.appendEntry(AUDIT_ENTRY_TYPE, event) },
		});
		baselineTools = undefined;
		return controller;
	}

	async function enforceLiveDrift(ctx: ExtensionContext): Promise<void> {
		const current = ensureController(ctx);
		if (!new Set(["dryrun", "running", "paused"]).has(current.state.status) || !current.spec) return;
		if (current.spec.policyDigest !== policyDigest(pi) || current.spec.contextDigest !== contextDigest(ctx)) {
			await current.recordPolicyDecision(
				{ channel: "system", id: "live-drift-guard" },
				scopeFor(ctx),
				"drift-guard",
				"live",
				false,
				"Live cwd/model/tool policy drifted from approved MissionSpec; pausing",
			);
			const paused = await current.dispatch(
				{
					protocolVersion: ACTION_PROTOCOL,
					requestId: `drift-${randomUUID()}`,
					action: "pause",
					actor: { channel: "system", id: "live-drift-guard" },
				},
				{
					scope: scopeFor(ctx),
					policyDigest: policyDigest(pi),
					contextDigest: contextDigest(ctx),
					reason: "Live cwd/model/tool policy drifted from approved MissionSpec",
				},
			);
			if (!paused.ok) throw new Error(paused.error?.message ?? "drift pause failed");
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
		for (const name of READONLY_EXT_TOOLS) {
			if (allNames.has(name) && baselineTools.includes(name)) visible.push(name);
		}
		if (state.status === "drafting") {
			if (allNames.has(SUBMIT_TOOL)) visible.push(SUBMIT_TOOL);
		} else if (state.status === "dryrun") {
			if (allNames.has(PROCESS_TOOLS[0]) && baselineTools.includes(PROCESS_TOOLS[0])) visible.push(PROCESS_TOOLS[0]);
			if (allNames.has(REPORT_TOOL)) visible.push(REPORT_TOOL);
			if (allNames.has(BLOCK_TOOL)) visible.push(BLOCK_TOOL);
		} else if (state.status === "running") {
			for (const name of PROCESS_TOOLS) {
				if (allNames.has(name) && baselineTools.includes(name)) visible.push(name);
			}
			for (const name of WRITE_TOOLS) {
				if (allNames.has(name) && baselineTools.includes(name)) visible.push(name);
			}
			if (allNames.has(REPORT_TOOL)) visible.push(REPORT_TOOL);
			if (allNames.has(BLOCK_TOOL)) visible.push(BLOCK_TOOL);
		}
		pi.setActiveTools([...new Set(visible)]);
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const current = ensureController(ctx);
		const state = current.state;
		if (state.status === "inactive") {
			ctx.ui.setStatus("autopilot", undefined);
			ctx.ui.setWidget("autopilot", undefined);
			return;
		}
		const color = state.status === "running" ? "accent" : state.status === "failed" ? "error" : "warning";
		const summary = buildAutopilotStatusSummary(current.spec, state);
		ctx.ui.setStatus("autopilot", ctx.ui.theme.fg(color, `AUTO · ${state.status.toUpperCase()}${summary ? ` · ${summary}` : ""}`));
		const lines = buildAcWidgetLines(current.spec, state);
		if (!lines) {
			ctx.ui.setWidget("autopilot", undefined);
			return;
		}
		ctx.ui.setWidget("autopilot", (_tui, theme) => ({
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
			process.stderr.write(`${content}\n`);
			return;
		}
		pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: false });
	}

	function emitResult(ctx: ExtensionContext, result: AutopilotActionResult): void {
		emitMessage(ctx, RESULT_TYPE, ctx.mode === "tui" ? formatTuiResult(result) : formatResult(result), result);
	}

	async function dispatch(
		ctx: ExtensionContext,
		action: AutopilotAction,
		extra: Partial<ActionEnvironment> = {},
		actor = actorFor(ctx),
	): Promise<AutopilotActionResult> {
		const current = ensureController(ctx);
		const request: AutopilotActionRequest = {
			protocolVersion: ACTION_PROTOCOL,
			requestId: `${action}-${randomUUID()}`,
			action,
			actor,
			payload: extra,
		};
		let environment: ActionEnvironment;
		try {
			environment = await environmentFor(pi, ctx, current, action, extra);
		} catch (error) {
			const message = `${error instanceof WorkspaceSnapshotError ? "Workspace snapshot rejected" : "Workspace snapshot failed"}: ${error instanceof Error ? error.message : String(error)}`;
			const result = resultError(current, action, "INVALID_MISSION", message);
			applyVisibleTools(ctx);
			updateUI(ctx);
			return result;
		}
		const result = await current.dispatch(request, environment);
		applyVisibleTools(ctx);
		updateUI(ctx);
		return result;
	}

	function queueExecutionTurn(ctx: ExtensionContext, reason: string): void {
		pi.sendMessage(
			{
				customType: "autopilot/continue",
				content: `${reason}\nContinue the autopilot mission from the current state. Do not stop between turns. In dryrun, verify every acceptance criterion by running its check, then call ${REPORT_TOOL}. In running, develop, verify against the acceptance criteria, and call ${REPORT_TOOL} with pass/fail per criterion. If genuinely blocked, call ${BLOCK_TOOL} with the exact reason instead of merely stopping.`,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function renderMissionForUser(current: AutopilotController): string {
		const spec = current.spec;
		if (!spec) return "Mission details are unavailable.";
		const acceptance = spec.acceptance
			.map((criterion) => `- ${criterion.id}${criterion.required === false ? "（可选）" : ""}: ${criterion.title}\n  - 验证: ${criterion.verify}`)
			.join("\n");
		const risks = spec.risks.length > 0 ? spec.risks.map((risk) => `- ${risk}`).join("\n") : "- None identified";
		return `# Autopilot Mission: ${spec.goal}\n\n## 验收标准（自动生成，可被执行前修正）\n\n${acceptance}\n\n## 风险\n${risks}`;
	}

	async function startWithGoal(ctx: ExtensionContext, goal: string): Promise<AutopilotActionResult> {
		const result = await dispatch(ctx, "start", { goal: goal.trim() });
		if (result.ok && ctx.hasUI && ctx.isIdle()) {
			pi.sendUserMessage(goal.trim());
		} else if (result.ok && ctx.hasUI) {
			pi.sendUserMessage(goal.trim(), { deliverAs: "followUp" });
		}
		return result;
	}

	async function startFromInteractivePrompt(ctx: ExtensionContext): Promise<AutopilotActionResult> {
		const current = ensureController(ctx);
		if (!ctx.hasUI) {
			return resultError(current, "start", "UI_REQUIRED", "Bare /autopilot requires TUI/RPC input; use /autopilot <goal> or --autopilot");
		}
		const goal = await ctx.ui.input("Autopilot goal", "Describe the goal to reach through autonomous development and self-checking");
		return goal?.trim() ? startWithGoal(ctx, goal) : resultError(current, "start", "INVALID_MISSION", "Mission goal is required");
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
		const action = tokens.shift() as AutopilotAction;
		const known = new Set<AutopilotAction>(["start", "status", "show", "pause", "resume", "cancel", "reset", "audit"]);
		let result: AutopilotActionResult;
		if (!known.has(action)) {
			result = await startWithGoal(ctx, [action, ...tokens].join(" "));
		} else if (action === "start") {
			result = await startWithGoal(ctx, tokens.join(" "));
		} else if (action === "pause" || action === "cancel") {
			if (!ctx.isIdle()) ctx.abort();
			result = await dispatch(ctx, action, { reason: tokens.join(" ") || undefined });
		} else if (action === "resume") {
			result = await dispatch(ctx, action);
		} else if (action === "show") {
			result = await dispatch(ctx, "show");
			emitResult(ctx, result);
			if (result.ok && current.spec) emitMessage(ctx, "autopilot/mission", renderMissionForUser(current));
			return;
		} else if (action === "audit") {
			result = await dispatch(ctx, "audit");
			emitResult(ctx, result);
			const audit = current.events.slice(-20).map((event) => `${event.sequence} ${event.occurredAt} ${event.action} ${event.decision} ${event.reason ?? ""}`);
			emitMessage(ctx, "autopilot/audit-view", audit.join("\n") || "No Autopilot audit events");
			return;
		} else {
			result = await dispatch(ctx, action);
		}
		emitResult(ctx, result);
		if (result.ok && result.state.status === "running") {
			lastExecutionSignature = undefined;
			stagnantExecutionTurns = 0;
			autonomousContinuationTurns = 0;
			queueExecutionTurn(ctx, "Autopilot execution started.");
		} else if (result.ok && result.state.status === "dryrun") {
			lastExecutionSignature = undefined;
			stagnantExecutionTurns = 0;
			autonomousContinuationTurns = 0;
			queueExecutionTurn(ctx, "Mission accepted. Start the acceptance dry-run.");
		}
	}

	pi.registerCommand("autopilot", {
		description: "Autonomous development: agent defines acceptance criteria, dry-runs them, then develops and self-checks until acceptance passes",
		handler: handleCommand,
	});

	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Start or inspect Autopilot mode",
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
		name: SUBMIT_TOOL,
		label: "Submit autopilot mission",
		description:
			"Commit the autonomous mission: goal restatement, acceptance criteria with concrete verify commands, write path scopes and risks. No user confirmation is needed; the mission enters the acceptance dry-run phase immediately.",
		promptGuidelines: [
			"Use autopilot_submit only after researching the workspace and defining acceptance criteria with concrete, executable verify commands.",
			"Every acceptance criterion must have a verifiable check (test command, build, or file inspection) named in verify.",
			"Write path scopes are project-relative; cwd is always writable during execution.",
			"Do not ask the user anything; decide autonomously.",
		],
		parameters: Type.Object({
			goal: Type.String({ minLength: 1, maxLength: 16_384 }),
			facts: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
			assumptions: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
			acceptance: Type.Array(
				Type.Object({
					id: Type.String({ minLength: 1, maxLength: 64 }),
					title: Type.String({ minLength: 1, maxLength: 4096 }),
					verify: Type.String({ minLength: 1, maxLength: 4096 }),
					required: Type.Optional(Type.Boolean()),
				}),
				{ minItems: 1, maxItems: 64 },
			),
			pathScopes: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 }),
			dependencyScopes: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 }),
			risks: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const submitted = await dispatch(
				ctx,
				"submit",
				{ draft: params as MissionDraft },
				{ channel: "model", id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" },
			);
			if (!submitted.ok) throw new Error(formatResult(submitted));
			return {
				content: [
					{
						type: "text",
						text: `${formatResult(submitted)}\nThe mission is accepted without confirmation and entered the acceptance dry-run phase. Now verify every acceptance criterion by actually running its check command; no source files may be modified during dry-run. Then call ${REPORT_TOOL} with phase=dryrun and one entry per criterion (ready or not_ready).`,
					},
				],
				details: submitted,
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: REPORT_TOOL,
		label: "Report acceptance results",
		description:
			"Report acceptance status per criterion for the current phase. In dryrun: ready/not_ready. In running: pass/fail. Claims of ready/pass require successful tool evidence in the current report window.",
		promptGuidelines: [
			"Call autopilot_report after running the verification commands for the criteria you report.",
			"Every ready/pass claim needs real tool evidence (successful bash/read result) since your last report.",
			"Be honest: report fail when the criterion is not satisfied; the loop continues automatically until acceptance passes.",
			`If genuinely blocked, call ${BLOCK_TOOL} instead of reporting a fake pass.`,
		],
		parameters: Type.Object({
			phase: StringEnum(["dryrun", "run"] as const),
			results: Type.Array(
				Type.Object({
					acId: Type.String({ minLength: 1, maxLength: 64 }),
					status: StringEnum(["ready", "not_ready", "pass", "fail"] as const),
					evidence: Type.String({ minLength: 1, maxLength: 4096 }),
				}),
				{ minItems: 1, maxItems: 64 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const phase = params.phase === "dryrun" ? "dryrun" : "running";
			const current = ensureController(ctx);
			if (current.state.status !== phase) {
				throw new Error(`AUTOPILOT_ACTION_ERROR INVALID_STATE: report phase '${params.phase}' does not match state=${current.state.status}`);
			}
			const results = params.results as AcReportEntry[];
			const reported = await dispatch(
				ctx,
				"report",
				{ results },
				{ channel: "model", id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" },
			);
			if (!reported.ok) throw new Error(formatResult(reported));
			const next = ensureController(ctx);
			const summary = (next.spec?.acceptance ?? [])
				.map((criterion) => {
					const ac = next.state.acResults[criterion.id];
					return `${criterion.id}=${ac?.status ?? "pending"}`;
				})
				.join(" ");
			if (next.state.status === "completed") {
				return {
					content: [
						{
							type: "text",
							text: `${formatResult(reported)}\nAll required acceptance criteria passed (${summary}). Give the user the final report: what changed, the verification evidence, and the acceptance result per criterion.`,
						},
					],
					details: reported,
				};
			}
			const instruction =
				next.state.status === "running"
					? "Continue the loop: develop further, re-run the failing checks, then report again. Never report pass without running the verification."
					: "Dry-run is not complete: fix or clarify the not_ready criteria (re-submit an updated mission if the criteria themselves are wrong), re-run their checks, then report again.";
			return {
				content: [
					{
						type: "text",
						text: `${formatResult(reported)}\n${instruction}\nCurrent: ${summary}`,
					},
				],
				details: reported,
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: BLOCK_TOOL,
		label: "Pause blocked autopilot",
		description: "Pause autonomous execution immediately when the mission cannot safely continue without user input or a revised goal.",
		promptGuidelines: [
			"Call autopilot_blocked only for a real blocker, material scope change, or newly discovered high-risk decision.",
			"State the exact blocker and what user decision is needed.",
		],
		parameters: Type.Object({
			reason: Type.String({ minLength: 1, maxLength: 4096 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await dispatch(
				ctx,
				"pause",
				{ reason: params.reason },
				{ channel: "model", id: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model" },
			);
			if (!result.ok) throw new Error(formatResult(result));
			return {
				content: [
					{
						type: "text",
						text: `${formatResult(result)}\nAutopilot paused for this blocker: ${params.reason}\nStop and wait for explicit user input; the user can /autopilot resume.`,
					},
				],
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
			return { block: true, reason: `Autopilot failed closed while checking live drift: ${error instanceof Error ? error.message : String(error)}` };
		}
		const evaluatedState = current.state;
		if (evaluatedState.status === "inactive") return;
		const managedTools = [
			{ name: SUBMIT_TOOL, sourcePath: EXTENSION_SOURCE },
			{ name: REPORT_TOOL, sourcePath: EXTENSION_SOURCE },
			{ name: BLOCK_TOOL, sourcePath: EXTENSION_SOURCE },
		];
		const decision = evaluateToolCall({
			state: current.state,
			spec: current.spec,
			toolName: event.toolName,
			input: event.input,
			toolInfo: pi.getAllTools().find((tool) => tool.name === event.toolName),
			cwd: ctx.cwd,
			readRoots: [ctx.cwd],
			managedTools,
			dangerFilter: process.env.AUTOPILOT_DISABLE_DANGER_FILTER !== "1",
		});
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
			return { block: true, reason: `Autopilot failed closed because audit persistence failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!decision.allow) return { block: true, reason: `Autopilot (${SECURITY_LEVEL}): ${decision.reason}` };
		const finalDecision = evaluateToolCall({
			state: current.state,
			spec: current.spec,
			toolName: event.toolName,
			input: event.input,
			toolInfo: pi.getAllTools().find((tool) => tool.name === event.toolName),
			cwd: ctx.cwd,
			readRoots: [ctx.cwd],
			managedTools,
			dangerFilter: process.env.AUTOPILOT_DISABLE_DANGER_FILTER !== "1",
		});
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
			return { block: true, reason: `Autopilot (${SECURITY_LEVEL}): ${reason}` };
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status !== "dryrun" && current.state.status !== "running") return;
		if (CONTROL_TOOLS.has(event.toolName)) return;
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

	function detectTrigger(text: string): boolean {
		return TRIGGER_PATTERNS.some((pattern) => pattern.test(text));
	}

	pi.on("input", async (event, ctx) => {
		const current = ensureController(ctx);
		if (pendingStartupNotice) {
			emitResult(ctx, pendingStartupNotice);
			pendingStartupNotice = undefined;
		}
		if (pendingStartupGoal !== undefined) {
			const flagGoal = pendingStartupGoal;
			pendingStartupGoal = undefined;
			const result = await dispatch(ctx, "start", { goal: flagGoal || event.text });
			emitResult(ctx, result);
			if (!result.ok) return { action: "handled" };
			return { action: "continue" };
		}
		if (current.state.status !== "inactive" || event.source === "extension") return { action: "continue" };
		if (!detectTrigger(event.text)) return { action: "continue" };
		const result = await dispatch(ctx, "start", { goal: event.text });
		emitResult(ctx, result);
		return result.ok ? { action: "continue" } : { action: "handled" };
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => {
			const customType = (message as { customType?: string }).customType;
			return customType !== CONTEXT_TYPE && customType !== "autopilot/mission";
		}),
	}));

	pi.on("before_agent_start", async (_event, ctx) => {
		const current = ensureController(ctx);
		try {
			await enforceLiveDrift(ctx);
		} catch {
			// Drift enforcement already paused the mission; the injection below reflects the paused state.
		}
		applyVisibleTools(ctx);
		updateUI(ctx);
		const state = current.state;
		if (state.status === "inactive") return;
		const ref = state.missionRef ? `${state.missionRef.missionId}@${state.missionRef.version}:${state.missionRef.contentHash}` : "not-yet-submitted";
		let instructions: string;
		switch (state.status) {
			case "drafting":
				instructions = `You are in AUTOPILOT drafting. Research the workspace read-only (no bash, no edits), restate the user's goal precisely, define acceptance criteria (each with a concrete, executable verify command), and call ${SUBMIT_TOOL}. Decide everything yourself — never ask the user anything. If the goal is ambiguous, pick the most reasonable interpretation and record it in assumptions.`;
				break;
			case "dryrun":
				instructions = `Acceptance dry-run (read-only for files; bash allowed only to run verification commands). For EVERY acceptance criterion, actually run its verify command and confirm it is executable and produces a decision. Then call ${REPORT_TOOL} with phase=dryrun and one entry per criterion (ready or not_ready). Every ready claim needs successful bash evidence since your last report. Do not modify any project files during dry-run.`;
				break;
			case "running":
				instructions = `Autopilot execution. You may use all tools: read/bash/edit/write within the project, plus searches. Develop until every required acceptance criterion passes. Self-check loop: run the verify commands, call ${REPORT_TOOL} with phase=run (pass/fail per criterion), then continue developing failing criteria and re-verify. Every pass claim needs successful tool evidence since your last report. Never fake a pass. Only call ${BLOCK_TOOL} for a real blocker.`;
				break;
			case "paused":
				instructions = `Autopilot is paused. Do not modify files or run tools beyond reading status. Wait for the user to /autopilot resume.`;
				break;
			default:
				instructions = `Autopilot is ${state.status}. Do not continue autonomous work.`;
		}
		return {
			message: {
				customType: CONTEXT_TYPE,
				display: false,
				content: `[AUTOPILOT]\nstate=${state.status}\nepoch=${state.epoch}\nsecurity=${SECURITY_LEVEL}\nmissionRef=${ref}\n${state.reason ? `reason=${state.reason}\n` : ""}\n\n${instructions}`,
			},
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		const current = ensureController(ctx);
		const state = current.state;
		if (state.status === "completed") {
			if (ctx.hasUI) ctx.ui.notify("Autopilot completed — all acceptance criteria passed", "info");
			const spec = current.spec;
			const lines = spec
				? spec.acceptance
						.map((criterion) => {
							const ac = state.acResults[criterion.id];
							const mark = ac?.status === "pass" ? "✓" : "○";
							return `${mark} ${criterion.id}: ${criterion.title}${ac?.evidence ? ` — ${ac.evidence}` : ""}`;
						})
						.join("\n")
				: "";
			emitMessage(ctx, "autopilot/acceptance-report", `**Autopilot 验收通过** — ${spec?.goal ?? "mission"}\n\n${lines}`, state);
			const reset = await dispatch(ctx, "reset", {}, { channel: "system", id: "automatic-completion-cleanup" });
			if (!reset.ok) emitResult(ctx, reset);
			lastExecutionSignature = undefined;
			stagnantExecutionTurns = 0;
			autonomousContinuationTurns = 0;
			return;
		}
		if (state.status !== "dryrun" && state.status !== "running") {
			lastExecutionSignature = undefined;
			stagnantExecutionTurns = 0;
			autonomousContinuationTurns = 0;
			return;
		}
		const signature = `${current.stageEvidenceCount}`;
		stagnantExecutionTurns = signature === lastExecutionSignature ? stagnantExecutionTurns + 1 : 0;
		lastExecutionSignature = signature;
		if (stagnantExecutionTurns >= MAX_STAGNANT_TURNS || autonomousContinuationTurns >= MAX_AUTONOMOUS_CONTINUATIONS) {
			const reason =
				stagnantExecutionTurns >= MAX_STAGNANT_TURNS
					? "Autopilot paused after two automatic continuation turns made no tool-evidence progress"
					: "Autopilot paused after reaching the autonomous continuation safety limit";
			const paused = await dispatch(ctx, "pause", { reason }, { channel: "system", id: "autonomous-continuation-guard" });
			emitResult(ctx, paused);
			if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			return;
		}
		autonomousContinuationTurns += 1;
		queueExecutionTurn(ctx, `Autopilot ${state.status} is still active.`);
	});

	pi.on("session_start", async (event, ctx) => {
		const current = ensureController(ctx);
		const digests = { policyDigest: policyDigest(pi), contextDigest: contextDigest(ctx) };
		await current.recover(ctx.sessionManager.getBranch(), event.reason, scopeFor(ctx), digests);
		if (!startupFlagsHandled && event.reason === "startup") {
			startupFlagsHandled = true;
			if (pi.getFlag("autopilot") === true && current.state.status === "inactive") {
				const flagGoal = pi.getFlag("autopilot-goal");
				// undefined = the first user message itself is the goal; "" = invalid, fall back to first message.
				pendingStartupGoal = typeof flagGoal === "string" && flagGoal.trim() ? flagGoal.trim() : "";
			}
		}
		applyVisibleTools(ctx);
		updateUI(ctx);
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status === "dryrun" || current.state.status === "running") {
			if (!ctx.isIdle()) ctx.abort();
			await dispatch(ctx, "pause", { reason: "Paused before session tree navigation" }, { channel: "system", id: "tree-guard" });
		}
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		const current = ensureController(ctx);
		if (current.state.status === "dryrun" || current.state.status === "running") {
			if (!ctx.isIdle()) ctx.abort();
			await dispatch(ctx, "pause", { reason: "Paused before fork/clone" }, { channel: "system", id: "fork-guard" });
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		applyVisibleTools(ctx);
		updateUI(ctx);
	});
}
