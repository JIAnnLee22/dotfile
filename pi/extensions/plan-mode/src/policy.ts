import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson, sha256 } from "./canonical.ts";
import type { ExecutionGrant, ExecutionState, PlanSpec } from "./domain.ts";
import { samePlanRef } from "./domain.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const PATCH_TOOL = "patch";
const PROCESS_TOOLS = new Set(["bash"]);
const PATCH_TOOL_SOURCE = path.resolve(import.meta.dirname, "../../patch/index.ts");

export interface ToolInfoLike {
	readonly name: string;
	readonly sourceInfo?: {
		readonly source?: string;
		readonly path?: string;
		readonly scope?: string;
		readonly origin?: string;
	};
}

export interface PolicyDecision {
	readonly allow: boolean;
	readonly capability?: "fs.read" | "fs.write" | "process.exec" | "managed-write";
	readonly reason: string;
	readonly normalizedPath?: string;
}

export interface ToolPolicyContext {
	readonly state: ExecutionState;
	readonly spec?: PlanSpec;
	readonly grant?: ExecutionGrant;
	readonly toolName: string;
	readonly input: unknown;
	readonly toolInfo?: ToolInfoLike;
	readonly cwd: string;
	readonly readRoots?: readonly string[];
	readonly managedTools?: readonly {
		readonly name: string;
		readonly sourcePath?: string;
	}[];
	readonly now?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nearestExistingPath(target: string): { existing: string; suffix: string[] } {
	let cursor = target;
	const suffix: string[] = [];
	while (!fs.existsSync(cursor)) {
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new Error(`No existing parent for path: ${target}`);
		suffix.unshift(path.basename(cursor));
		cursor = parent;
	}
	return { existing: cursor, suffix };
}

function expandBuiltinToolPath(target: string): string {
	let expanded = target.startsWith("@") ? target.slice(1) : target;
	if (expanded === "~") expanded = os.homedir();
	else if (expanded.startsWith(`~${path.sep}`) || expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(2));
	return expanded;
}

export function canonicalPolicyPath(target: string, cwd: string): string {
	const absolute = path.resolve(cwd, expandBuiltinToolPath(target));
	const { existing, suffix } = nearestExistingPath(absolute);
	const realExisting = fs.realpathSync(existing);
	return path.resolve(realExisting, ...suffix);
}

function isWithinDirectory(target: string, directory: string): boolean {
	const relative = path.relative(directory, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function matchesStepScope(target: string, cwd: string, rawScope: string): boolean {
	const directoryScope = rawScope.endsWith("/");
	const scopeValue = directoryScope ? rawScope.slice(0, -1) || "." : rawScope;
	const canonicalScope = canonicalPolicyPath(scopeValue, cwd);
	return directoryScope ? isWithinDirectory(target, canonicalScope) : target === canonicalScope;
}

function pathFromInput(toolName: string, input: unknown): string | undefined | null {
	if (!isRecord(input)) return null;
	if (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === PATCH_TOOL) {
		return typeof input.path === "string" ? input.path : null;
	}
	if (toolName === "grep" || toolName === "find" || toolName === "ls") {
		return input.path === undefined ? undefined : typeof input.path === "string" ? input.path : null;
	}
	return undefined;
}

function isExpectedBuiltin(toolName: string, info: ToolInfoLike | undefined): boolean {
	return info?.name === toolName && info.sourceInfo?.source === "builtin";
}

function isExpectedWriteTool(toolName: string, info: ToolInfoLike | undefined): boolean {
	if (WRITE_TOOLS.has(toolName)) return isExpectedBuiltin(toolName, info);
	return (
		toolName === PATCH_TOOL &&
		info?.name === PATCH_TOOL &&
		info.sourceInfo?.source !== "builtin" &&
		typeof info.sourceInfo?.path === "string" &&
		path.resolve(info.sourceInfo.path) === PATCH_TOOL_SOURCE
	);
}

function validManagedToolSource(
	info: ToolInfoLike | undefined,
	managed: NonNullable<ToolPolicyContext["managedTools"]>[number],
): boolean {
	if (!info || info.name !== managed.name || info.sourceInfo?.source === "builtin") return false;
	if (!managed.sourcePath) return true;
	return info.sourceInfo?.path !== undefined && path.resolve(info.sourceInfo.path) === path.resolve(managed.sourcePath);
}

function deny(reason: string): PolicyDecision {
	return { allow: false, reason };
}

export function evaluateToolCall(context: ToolPolicyContext): PolicyDecision {
	const { state, toolName } = context;
	if (state.status === "inactive") return { allow: true, reason: "Plan Mode is inactive" };

	const managedTool = context.managedTools?.find((candidate) => candidate.name === toolName);
	if (managedTool) {
		if (!validManagedToolSource(context.toolInfo, managedTool)) {
			return deny(`Managed tool '${toolName}' source changed or cannot be verified`);
		}
		const validState =
			toolName === "plan_submit"
				? new Set(["researching", "review", "stale"]).has(state.status)
				: toolName === "plan_question"
					? state.status === "researching"
					: toolName === "plan_step_complete" || toolName === "plan_blocked"
						? state.status === "executing"
						: false;
		if (!validState) return deny(`Managed tool '${toolName}' is not allowed while state=${state.status}`);
		return { allow: true, capability: "managed-write", reason: `Trusted managed tool '${toolName}'` };
	}

	if (READ_TOOLS.has(toolName)) {
		if (!isExpectedBuiltin(toolName, context.toolInfo)) {
			return deny(`Read tool '${toolName}' is unknown or overrides the built-in implementation`);
		}
		const inputPath = pathFromInput(toolName, context.input);
		if (inputPath === null) return deny(`Tool '${toolName}' has an invalid path parameter`);
		let target: string;
		try {
			target = canonicalPolicyPath(inputPath ?? ".", context.cwd);
		} catch (error) {
			return deny(error instanceof Error ? error.message : String(error));
		}
		const roots = context.readRoots?.length ? context.readRoots : [context.cwd];
		let allowed = false;
		for (const root of roots) {
			try {
				if (isWithinDirectory(target, canonicalPolicyPath(root, context.cwd))) {
					allowed = true;
					break;
				}
			} catch {
				// A root that cannot be canonicalized contributes no authority.
			}
		}
		return allowed
			? { allow: true, capability: "fs.read", reason: "Known built-in read adapter within configured root", normalizedPath: target }
			: deny(`Read path escapes configured roots: ${target}`);
	}

	if (WRITE_TOOLS.has(toolName) || toolName === PATCH_TOOL) {
		if (!isExpectedWriteTool(toolName, context.toolInfo)) {
			return deny(`Write tool '${toolName}' is unknown, overridden, or cannot be verified`);
		}
		if (state.status !== "executing") return deny(`Write tool denied while state=${state.status}`);
		if (!context.spec || !context.grant || !state.planRef) return deny("Executing state is missing PlanSpec or ExecutionGrant");
		if (!samePlanRef(state.planRef, context.spec) || !samePlanRef(state.planRef, context.grant.planRef)) {
			return deny("ExecutionGrant PlanRef does not match current immutable PlanSpec");
		}
		if (context.grant.epoch !== state.epoch || context.grant.grantId !== state.grantId) {
			return deny("ExecutionGrant epoch or identifier is stale");
		}
		if (context.grant.policyDigest !== context.spec.policyDigest || context.grant.contextDigest !== context.spec.contextDigest) {
			return deny("ExecutionGrant policy/context digest does not match PlanSpec");
		}
		if (context.spec.workspaceSnapshot && context.grant.workspaceDigest !== context.spec.workspaceSnapshot.digest) {
			return deny("ExecutionGrant workspace digest does not match PlanSpec dependency snapshot");
		}
		if (context.grant.expiresAt && Date.parse(context.grant.expiresAt) <= Date.parse(context.now ?? new Date().toISOString())) {
			return deny("ExecutionGrant has expired");
		}
		if (!state.currentStepId) return deny("No current plan step is selected");
		const step = context.spec.steps.find((candidate) => candidate.id === state.currentStepId);
		const grantStep = context.grant.steps.find((candidate) => candidate.stepId === state.currentStepId);
		if (!step || !grantStep) return deny("Current step is absent from PlanSpec or ExecutionGrant");
		if (!step.requiredCapabilities.includes("fs.write") || !grantStep.capabilities.includes("fs.write")) {
			return deny(`Current step '${state.currentStepId}' does not grant fs.write`);
		}
		const inputPath = pathFromInput(toolName, context.input);
		if (inputPath === null || inputPath === undefined) return deny(`Tool '${toolName}' requires a verifiable path`);
		let target: string;
		try {
			target = canonicalPolicyPath(inputPath, context.cwd);
			const canonicalCwd = canonicalPolicyPath(".", context.cwd);
			if (!isWithinDirectory(target, canonicalCwd)) return deny(`Write path escapes project cwd: ${target}`);
		} catch (error) {
			return deny(error instanceof Error ? error.message : String(error));
		}
		const allowed = grantStep.pathScopes.some((scope) => matchesStepScope(target, context.cwd, scope));
		return allowed
			? { allow: true, capability: "fs.write", reason: `ExecutionGrant permits step '${state.currentStepId}'`, normalizedPath: target }
			: deny(`Write path is outside the current step grant: ${target}`);
	}

	if (PROCESS_TOOLS.has(toolName)) {
		if (!isExpectedBuiltin(toolName, context.toolInfo)) {
			return deny(`Process tool '${toolName}' is unknown or overrides the built-in implementation`);
		}
		if (state.status !== "executing") return deny(`Process execution denied while state=${state.status}`);
		if (!context.spec || !context.grant || !state.planRef) return deny("Executing state is missing PlanSpec or ExecutionGrant");
		if (!samePlanRef(state.planRef, context.spec) || !samePlanRef(state.planRef, context.grant.planRef)) {
			return deny("ExecutionGrant PlanRef does not match current immutable PlanSpec");
		}
		if (context.grant.epoch !== state.epoch || context.grant.grantId !== state.grantId) {
			return deny("ExecutionGrant epoch or identifier is stale");
		}
		if (context.grant.policyDigest !== context.spec.policyDigest || context.grant.contextDigest !== context.spec.contextDigest) {
			return deny("ExecutionGrant policy/context digest does not match PlanSpec");
		}
		if (context.spec.workspaceSnapshot && context.grant.workspaceDigest !== context.spec.workspaceSnapshot.digest) {
			return deny("ExecutionGrant workspace digest does not match PlanSpec dependency snapshot");
		}
		if (context.grant.expiresAt && Date.parse(context.grant.expiresAt) <= Date.parse(context.now ?? new Date().toISOString())) {
			return deny("ExecutionGrant has expired");
		}
		if (!state.currentStepId) return deny("No current plan step is selected");
		const step = context.spec.steps.find((candidate) => candidate.id === state.currentStepId);
		const grantStep = context.grant.steps.find((candidate) => candidate.stepId === state.currentStepId);
		if (!step || !grantStep) return deny("Current step is absent from PlanSpec or ExecutionGrant");
		if (!step.requiredCapabilities.includes("process.exec") || !grantStep.capabilities.includes("process.exec")) {
			return deny(`Current step '${state.currentStepId}' does not grant process.exec`);
		}
		return {
			allow: true,
			capability: "process.exec",
			reason: `ExecutionGrant permits unrestricted built-in process execution for step '${state.currentStepId}'`,
		};
	}

	return deny(`Unknown or unsupported tool '${toolName}' is fail-closed`);
}

export function calculatePolicyDigest(tools: readonly ToolInfoLike[], managedSubmitSourcePath?: string): string {
	const relevant = tools
		.filter((tool) => READ_TOOLS.has(tool.name) || WRITE_TOOLS.has(tool.name) || tool.name === PATCH_TOOL || PROCESS_TOOLS.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			sourceInfo: tool.sourceInfo
				? Object.fromEntries(Object.entries(tool.sourceInfo).filter((entry) => entry[1] !== undefined))
				: null,
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
	return sha256(
		canonicalJson({
			policy: "pi-plan-mode/approved-step-v2",
			bash: "deny-during-planning; allow-only-with-process.exec-grant",
			network: "deny",
			unknown: "deny",
			managedSubmitSourcePath: managedSubmitSourcePath ?? null,
			tools: relevant,
		}),
	);
}
