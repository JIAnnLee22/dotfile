import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson, sha256 } from "./canonical.ts";
import {
	CapabilityRegistry,
	findPermission,
	type RegistryEntry,
	type ToolInfoLike,
} from "./capability-registry.ts";
import type { ExecutionState, ResearchCapability, ResearchPermissionRecord } from "./domain.ts";
import { usesPlanningPolicy } from "./state-machine.ts";

/**
 * 规划期 `parallel_tasks` 只读派发的角色白名单。
 * 与 extensions/parallel-tasks/roles 的只读角色保持一致（probe/analyst/verifier/reviewer）；
 * 可写角色（implementer 以及任何未来新增的可写角色）在规划期被拒绝，fail-closed。
 */
export const PLANNING_READONLY_DISPATCH_ROLES = new Set(["probe", "analyst", "verifier", "reviewer"]);

export interface PolicyDecision {
	readonly allow: boolean;
	readonly capabilities?: readonly ResearchCapability[];
	readonly reason: string;
	readonly normalizedPath?: string;
	readonly permissionRequired?: boolean;
	readonly sourceDigest?: string;
}

export interface ManagedToolSource {
	readonly name: string;
	readonly sourcePath: string;
}

export interface ToolPolicyContext {
	readonly state: ExecutionState;
	readonly registry: CapabilityRegistry;
	readonly permissions: ReadonlyMap<string, ResearchPermissionRecord>;
	readonly toolName: string;
	readonly input: unknown;
	readonly toolInfo?: ToolInfoLike;
	readonly cwd: string;
	readonly readRoots?: readonly string[];
	readonly managedTools?: readonly ManagedToolSource[];
	/** 为 true 时实施期使用 orchestrator 硬门禁：主会话变更工具被拒绝，只允许读工具与派发/协调工具。 */
	readonly orchestrator?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dispatchedRoles(input: unknown): string[] {
	if (!isRecord(input) || !Array.isArray(input.tasks)) return [];
	const roles: string[] = [];
	for (const task of input.tasks) {
		if (isRecord(task) && typeof task.role === "string" && task.role.trim()) roles.push(task.role.trim());
	}
	return roles;
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

function validManagedToolSource(info: ToolInfoLike | undefined, managed: ManagedToolSource): boolean {
	return (
		info?.name === managed.name &&
		info.sourceInfo?.source !== "builtin" &&
		typeof info.sourceInfo?.path === "string" &&
		path.resolve(info.sourceInfo.path) === path.resolve(managed.sourcePath)
	);
}

function managedToolAllowed(name: string, state: ExecutionState): boolean {
	switch (name) {
		case "plan_submit":
		case "plan_question":
			return state.status === "planning";
		case "plan_step_complete":
		case "plan_blocked":
			return state.status === "implementing" || state.status === "stale";
		case "plan_dispatch_step":
		case "plan_apply_diff":
			return state.status === "implementing";
		default:
			return false;
	}
}

function deny(reason: string, entry?: RegistryEntry): PolicyDecision {
	return { allow: false, reason, capabilities: entry?.capabilities };
}

function pathFromInput(entry: RegistryEntry, input: unknown): string | undefined | null {
	if (entry.pathAdapter === "none") return undefined;
	if (!isRecord(input)) return null;
	if (input.path === undefined) return entry.pathAdapter === "optional-path" ? undefined : null;
	return typeof input.path === "string" ? input.path : null;
}

function evaluateReadPath(
	entry: RegistryEntry,
	input: unknown,
	cwd: string,
	readRoots: readonly string[],
): PolicyDecision | undefined {
	if (!entry.capabilities.includes("workspace.read") || entry.pathAdapter === "none") return undefined;
	const inputPath = pathFromInput(entry, input);
	if (inputPath === null) return deny(`Tool '${entry.name}' requires a valid path parameter`, entry);
	let target: string;
	try {
		target = canonicalPolicyPath(inputPath ?? ".", cwd);
	} catch (error) {
		return deny(error instanceof Error ? error.message : String(error), entry);
	}
	for (const root of readRoots) {
		try {
			if (isWithinDirectory(target, canonicalPolicyPath(root, cwd))) {
				return {
					allow: true,
					capabilities: entry.capabilities,
					reason: `Verified '${entry.name}' path within configured read roots`,
					normalizedPath: target,
				};
			}
		} catch {
			// A root that cannot be canonicalized contributes no authority.
		}
	}
	return deny(`Read path escapes configured roots: ${target}`, entry);
}

/**
 * 只读/派发策略：规划期与 orchestrator 实施期共用同一套 registry 判定。
 * allowImplementerDispatch 为 true 时（orchestrator 实施期）允许 parallel_tasks 派发可写 implementer 角色；
 * 为 false 时（规划期）只允许只读角色。
 */
function evaluateReadOnlyLike(context: ToolPolicyContext, allowImplementerDispatch: boolean): PolicyDecision {
	const { state, toolName } = context;
	const match = context.registry.resolve(toolName, context.toolInfo);
	if (!match.ok || !match.entry || !match.sourceDigest) return deny(match.reason, match.entry);
	const entry = match.entry;
	if (allowImplementerDispatch) {
		const readCapabilities = new Set<ResearchCapability>(["workspace.read", "metadata.read", "network.read"]);
		const sideEffects = entry.capabilities.filter((capability) => !readCapabilities.has(capability));
		if (sideEffects.length > 0) {
			return deny(`Tool '${toolName}' has non-read orchestrator capabilities: ${sideEffects.join(", ")}`, entry);
		}
	}
	if (toolName === "parallel_tasks") {
		const roles = dispatchedRoles(context.input);
		if (allowImplementerDispatch) {
			if (roles.length === 0) {
				return deny(`Tool 'parallel_tasks' requires at least one role while state=${state.status}`, entry);
			}
		} else {
			const denied = roles.filter((role) => !PLANNING_READONLY_DISPATCH_ROLES.has(role));
			if (denied.length > 0) {
				return deny(`Tool 'parallel_tasks' may only dispatch read-only roles while state=${state.status}; denied role(s): ${denied.join(", ")}`, entry);
			}
			if (roles.length === 0) {
				return deny(`Tool 'parallel_tasks' requires at least one read-only role while state=${state.status}`, entry);
			}
		}
	}
	if (entry.planning === "never") {
		return deny(`Tool '${toolName}' is classified as ${entry.capabilities.join(", ")} and denied during ${state.status}`, entry);
	}
	if (entry.planning === "confirm-per-plan") {
		if (!state.planId) return deny(`Tool '${toolName}' needs a current plan before permission can be requested`, entry);
		const permission = findPermission(context.permissions, state.planId, toolName, match.sourceDigest);
		if (!permission) {
			return {
				allow: false,
				capabilities: entry.capabilities,
				reason: `Tool '${toolName}' requires one explicit permission for this plan`,
				permissionRequired: true,
				sourceDigest: match.sourceDigest,
			};
		}
		if (permission.decision !== "allow") return deny(`Tool '${toolName}' permission was denied for this plan`, entry);
	}

	const pathDecision = evaluateReadPath(entry, context.input, context.cwd, context.readRoots?.length ? context.readRoots : [context.cwd]);
	if (pathDecision && !pathDecision.allow) return pathDecision;
	return {
		allow: true,
		capabilities: entry.capabilities,
		reason: pathDecision?.reason ?? match.reason,
		normalizedPath: pathDecision?.normalizedPath,
		sourceDigest: match.sourceDigest,
	};
}

export function evaluateToolCall(context: ToolPolicyContext): PolicyDecision {
	const { state, toolName } = context;
	const managed = context.managedTools?.find((candidate) => candidate.name === toolName);
	if (managed) {
		if (!validManagedToolSource(context.toolInfo, managed)) {
			return deny(`Managed tool '${toolName}' source changed or cannot be verified`);
		}
		if (!managedToolAllowed(toolName, state)) {
			return deny(`Managed tool '${toolName}' is not allowed while state=${state.status}`);
		}
		return { allow: true, reason: `Trusted managed tool '${toolName}'` };
	}

	// Plan Mode deliberately disengages for ordinary tools during implementation
	// unless the orchestrator hard gate is enabled.
	if (state.status === "inactive") {
		return { allow: true, reason: "Plan Mode is inactive" };
	}
	if (state.status === "implementing" && !context.orchestrator) {
		return { allow: true, reason: "Implementation uses normal Pi permissions" };
	}
	if (state.status === "implementing" && context.orchestrator) {
		return evaluateReadOnlyLike(context, true);
	}
	if (!usesPlanningPolicy(state.status)) return deny(`Tool calls are disabled while state=${state.status}`);

	return evaluateReadOnlyLike(context, false);
}

export function calculatePolicyDigest(registry: CapabilityRegistry, managedSourcePath?: string): string {
	return sha256(
		canonicalJson({
			policy: "pi-plan-mode/planning-only-v2",
			registryDigest: registry.digest(),
			managedSourcePath: managedSourcePath ? path.resolve(managedSourcePath) : null,
			implementation: "normal-pi-permissions",
			unknown: "deny-during-planning",
		}),
	);
}
