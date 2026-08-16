import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson, sha256 } from "../../plan-mode/src/canonical.ts";
import type { ExecutionState, MissionSpec } from "./domain.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const PROCESS_TOOLS = new Set(["bash"]);
/** Read-only extension tools that are safe to keep visible during autopilot (path-verified below). */
const READONLY_EXT_TOOLS = new Set(["ffgrep", "fffind"]);
/** Built-in tools visible during autopilot. */
const BUILTIN_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS, ...PROCESS_TOOLS]);

/** Dangerous bash patterns blocked during dryrun/running regardless of grant. */
export const DANGEROUS_BASH_PATTERNS: readonly RegExp[] = [
	// rm -rf on filesystem/OS roots or home
	/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/home|\/Users|\/root|\/etc|\/usr|\/var|\/bin|\/sbin|\/lib|\/|~)(\/|\s|$)/,
	// filesystem formatting
	/\bmkfs(\.|\s)/,
	// raw device writes
	/\bdd\s+if=.*of=\/dev\//,
	// fork bomb
	/:\(\s*\)\s*\{/,
	// force-push to remotes
	/\bgit\s+push\b[^|;&\n]*?(-f|--force)\b/,
	// system shutdown / reboot / init
	/\bshutdown\b|\breboot\b|\binit\s+0\b/,
	// recursive chmod on root
	/\bchmod\s+-R\s*777\s+\//,
];

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
	readonly spec?: MissionSpec;
	readonly toolName: string;
	readonly input: unknown;
	readonly toolInfo?: ToolInfoLike;
	readonly cwd: string;
	readonly readRoots?: readonly string[];
	readonly managedTools?: readonly {
		readonly name: string;
		readonly sourcePath?: string;
	}[];
	/** Set to false to disable the dangerous-bash filter (documented opt-out). */
	readonly dangerFilter?: boolean;
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
	if (toolName === "read" || toolName === "edit" || toolName === "write") {
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

function isVerifiedReadonlyExt(info: ToolInfoLike | undefined): boolean {
	const source = info?.sourceInfo;
	if (!source || source.source === "builtin") return false;
	// The extension-provided implementation must resolve to an existing file.
	if (typeof source.path !== "string" || source.path.length === 0) return false;
	try {
		return fs.existsSync(source.path);
	} catch {
		return false;
	}
}

function validManagedToolSource(
	info: ToolInfoLike | undefined,
	managed: NonNullable<ToolPolicyContext["managedTools"]>[number],
): boolean {
	if (!info || info.name !== managed.name || info.sourceInfo?.source === "builtin") return false;
	if (!managed.sourcePath) return true;
	return info.sourceInfo?.path !== undefined && path.resolve(info.sourceInfo.path) === path.resolve(managed.sourcePath);
}

function bashIsDangerous(command: string, dangerFilter: boolean): string | undefined {
	if (!dangerFilter) return undefined;
	for (const pattern of DANGEROUS_BASH_PATTERNS) {
		if (pattern.test(command)) {
			return `command matches dangerous pattern ${pattern}`;
		}
	}
	return undefined;
}

function deny(reason: string): PolicyDecision {
	return { allow: false, reason };
}

export function evaluateToolCall(context: ToolPolicyContext): PolicyDecision {
	const { state, toolName } = context;
	if (state.status === "inactive") return { allow: true, reason: "Autopilot is inactive" };
	if (state.status === "paused" || state.status === "completed" || state.status === "cancelled" || state.status === "failed") {
		return deny(`Autopilot tool use denied while state=${state.status}`);
	}

	const managedTool = context.managedTools?.find((candidate) => candidate.name === toolName);
	if (managedTool) {
		if (!validManagedToolSource(context.toolInfo, managedTool)) {
			return deny(`Managed tool '${toolName}' source changed or cannot be verified`);
		}
		const validState =
			toolName === "autopilot_submit"
				? state.status === "drafting" || state.status === "dryrun"
				: toolName === "autopilot_report"
					? state.status === "dryrun" || state.status === "running"
					: toolName === "autopilot_blocked"
						? state.status === "drafting" || state.status === "dryrun" || state.status === "running"
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

	if (READONLY_EXT_TOOLS.has(toolName)) {
		if (!isVerifiedReadonlyExt(context.toolInfo)) {
			return deny(`Read-only extension tool '${toolName}' cannot be verified`);
		}
		return { allow: true, capability: "fs.read", reason: "Verified read-only extension tool" };
	}

	if (WRITE_TOOLS.has(toolName)) {
		if (!isExpectedBuiltin(toolName, context.toolInfo)) {
			return deny(`Write tool '${toolName}' is unknown or overrides the built-in implementation`);
		}
		if (state.status !== "running") return deny(`Write tool denied while state=${state.status}`);
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
		const declared = context.spec?.pathScopes ?? [];
		if (declared.length > 0) {
			const allowed = declared.some((scope) => matchesStepScope(target, context.cwd, scope));
			if (!allowed) return deny(`Write path is outside the declared mission path scopes: ${target}`);
		}
		return { allow: true, capability: "fs.write", reason: "Autopilot running grant permits write inside cwd", normalizedPath: target };
	}

	if (PROCESS_TOOLS.has(toolName)) {
		if (!isExpectedBuiltin(toolName, context.toolInfo)) {
			return deny(`Process tool '${toolName}' is unknown or overrides the built-in implementation`);
		}
		if (state.status !== "running" && state.status !== "dryrun") {
			return deny(`Process execution denied while state=${state.status}`);
		}
		const command = isRecord(context.input) && typeof context.input.command === "string" ? context.input.command : "";
		const dangerous = bashIsDangerous(command, context.dangerFilter ?? true);
		if (dangerous) return deny(`Autopilot blocked ${dangerous}`);
		return {
			allow: true,
			capability: "process.exec",
			reason: state.status === "dryrun" ? "Dry-run verification commands only" : "Autopilot running grant permits process execution",
		};
	}

	return deny(`Unknown or unsupported tool '${toolName}' is fail-closed`);
}

export function calculatePolicyDigest(tools: readonly ToolInfoLike[], managedSubmitSourcePath?: string): string {
	const relevant = tools
		.filter((tool) => BUILTIN_TOOLS.has(tool.name) || READONLY_EXT_TOOLS.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			sourceInfo: tool.sourceInfo
				? Object.fromEntries(Object.entries(tool.sourceInfo).filter((entry) => entry[1] !== undefined))
				: null,
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
	return sha256(
		canonicalJson({
			policy: "pi-autopilot/global-grant-v1",
			bash: "deny-during-drafting; allow-during-dryrun-and-running-with-danger-filter",
			network: "deny",
			unknown: "deny",
			managedSubmitSourcePath: managedSubmitSourcePath ?? null,
			tools: relevant,
		}),
	);
}
