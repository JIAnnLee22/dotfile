import * as path from "node:path";
import { canonicalJson, sha256 } from "./canonical.ts";
import type { ResearchCapability, ResearchPermissionRecord } from "./domain.ts";

export type PlanningDisposition = "always" | "confirm-per-plan" | "never";
export type PathAdapter = "required-path" | "optional-path" | "none";

export interface ToolSourceInfo {
	readonly source?: string;
	readonly path?: string;
	readonly scope?: string;
	readonly origin?: string;
	readonly baseDir?: string;
}

export interface ToolInfoLike {
	readonly name: string;
	readonly description?: string;
	readonly sourceInfo?: ToolSourceInfo;
}

export interface RegistryEntryInput {
	readonly name: string;
	readonly capabilities: readonly ResearchCapability[];
	readonly source: string;
	readonly path?: string;
	readonly planning: PlanningDisposition;
	readonly pathAdapter?: PathAdapter;
}

export interface RegistryEntry extends RegistryEntryInput {
	readonly pathAdapter: PathAdapter;
}

export interface RegistryDiagnostic {
	readonly code: "INVALID_ENTRY" | "CONFLICT";
	readonly toolName?: string;
	readonly message: string;
}

export interface RegistryMatch {
	readonly ok: boolean;
	readonly entry?: RegistryEntry;
	readonly sourceDigest?: string;
	readonly reason: string;
}

const CAPABILITIES = new Set<ResearchCapability>([
	"workspace.read",
	"metadata.read",
	"network.read",
	"managed.index.write",
	"fs.write",
	"process.exec",
	"external.mutate",
]);
const DISPOSITIONS = new Set<PlanningDisposition>(["always", "confirm-per-plan", "never"]);
const PATH_ADAPTERS = new Set<PathAdapter>(["required-path", "optional-path", "none"]);

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function normalizeEntry(input: RegistryEntryInput): RegistryEntry {
	const name = input.name.trim();
	const source = input.source.trim();
	if (!name || !/^[a-zA-Z0-9_.:-]+$/.test(name)) throw new TypeError(`Invalid tool name: ${input.name}`);
	if (!source) throw new TypeError(`Registry entry '${name}' requires source`);
	const capabilities = unique(input.capabilities);
	if (capabilities.length === 0 || capabilities.some((capability) => !CAPABILITIES.has(capability))) {
		throw new TypeError(`Registry entry '${name}' has invalid capabilities`);
	}
	if (!DISPOSITIONS.has(input.planning)) throw new TypeError(`Registry entry '${name}' has invalid planning disposition`);
	const pathAdapter = input.pathAdapter ?? "none";
	if (!PATH_ADAPTERS.has(pathAdapter)) throw new TypeError(`Registry entry '${name}' has invalid pathAdapter`);
	return {
		name,
		capabilities,
		source,
		...(input.path ? { path: input.path.startsWith("<builtin:") ? input.path : path.resolve(input.path) } : {}),
		planning: input.planning,
		pathAdapter,
	};
}

function sameEntry(left: RegistryEntry, right: RegistryEntry): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function sourceDigest(entry: RegistryEntry, info: ToolInfoLike): string {
	return sha256(
		canonicalJson({
			name: entry.name,
			capabilities: entry.capabilities,
			planning: entry.planning,
			expected: { source: entry.source, path: entry.path ?? null },
			actual: {
				source: info.sourceInfo?.source ?? null,
				path: info.sourceInfo?.path ? path.resolve(info.sourceInfo.path) : null,
				scope: info.sourceInfo?.scope ?? null,
				origin: info.sourceInfo?.origin ?? null,
			},
		}),
	);
}

function defaultPackagePath(agentDir: string, ...segments: string[]): string {
	return path.join(path.resolve(agentDir), "npm", "node_modules", ...segments);
}

export function defaultRegistryEntries(agentDir: string): RegistryEntryInput[] {
	const builtin = (name: string, capabilities: readonly ResearchCapability[], pathAdapter: PathAdapter): RegistryEntryInput => ({
		name,
		capabilities,
		source: "builtin",
		path: `<builtin:${name}>`,
		planning: "always",
		pathAdapter,
	});
	const denyBuiltin = (name: string, capabilities: readonly ResearchCapability[]): RegistryEntryInput => ({
		name,
		capabilities,
		source: "builtin",
		path: `<builtin:${name}>`,
		planning: "never",
		pathAdapter: "none",
	});
	const fffPath = defaultPackagePath(agentDir, "@ff-labs", "pi-fff", "src", "index.ts");
	const webPath = defaultPackagePath(agentDir, "pi-web-access", "index.ts");
	const contextPath = defaultPackagePath(agentDir, "context-mode", "build", "adapters", "pi", "extension.js");
	return [
		builtin("read", ["workspace.read"], "required-path"),
		builtin("grep", ["workspace.read"], "optional-path"),
		builtin("find", ["workspace.read"], "optional-path"),
		builtin("ls", ["workspace.read"], "optional-path"),
		denyBuiltin("edit", ["fs.write"]),
		denyBuiltin("write", ["fs.write"]),
		denyBuiltin("bash", ["process.exec"]),
		denyBuiltin("powershell", ["process.exec"]),
		{
			name: "ffgrep",
			capabilities: ["workspace.read"],
			source: "npm:@ff-labs/pi-fff",
			path: fffPath,
			planning: "always",
			pathAdapter: "optional-path",
		},
		{
			name: "fffind",
			capabilities: ["workspace.read"],
			source: "npm:@ff-labs/pi-fff",
			path: fffPath,
			planning: "always",
			pathAdapter: "optional-path",
		},
		...(["ctx_search", "ctx_stats", "ctx_doctor"] as const).map(
			(name): RegistryEntryInput => ({
				name,
				capabilities: name === "ctx_search" ? ["workspace.read", "metadata.read"] : ["metadata.read"],
				source: "npm:context-mode",
				path: contextPath,
				planning: "always",
				pathAdapter: "none",
			}),
		),
		...(["ctx_execute", "ctx_execute_file", "ctx_batch_execute"] as const).map(
			(name): RegistryEntryInput => ({
				name,
				capabilities: ["fs.write", "process.exec"],
				source: "npm:context-mode",
				path: contextPath,
				planning: "never",
				pathAdapter: name === "ctx_execute_file" ? "required-path" : "none",
			}),
		),
		{
			name: "ctx_index",
			capabilities: ["workspace.read", "managed.index.write"],
			source: "npm:context-mode",
			path: contextPath,
			planning: "confirm-per-plan",
			pathAdapter: "required-path",
		},
		{
			name: "ctx_fetch_and_index",
			capabilities: ["network.read", "managed.index.write"],
			source: "npm:context-mode",
			path: contextPath,
			planning: "confirm-per-plan",
			pathAdapter: "none",
		},
		...(["ctx_upgrade", "ctx_purge", "ctx_insight"] as const).map(
			(name): RegistryEntryInput => ({
				name,
				capabilities: ["external.mutate"],
				source: "npm:context-mode",
				path: contextPath,
				planning: "never",
				pathAdapter: "none",
			}),
		),
		...(["web_search", "source_check", "fetch_content", "get_search_content"] as const).map(
			(name): RegistryEntryInput => ({
				name,
				capabilities: ["network.read"],
				source: "npm:pi-web-access",
				path: webPath,
				planning: "confirm-per-plan",
				pathAdapter: "none",
			}),
		),
	];
}

export class CapabilityRegistry {
	private readonly entries = new Map<string, RegistryEntry>();
	private readonly conflicts = new Set<string>();
	readonly diagnostics: readonly RegistryDiagnostic[];

	constructor(inputs: readonly RegistryEntryInput[]) {
		const diagnostics: RegistryDiagnostic[] = [];
		for (const input of inputs) {
			let entry: RegistryEntry;
			try {
				entry = normalizeEntry(input);
			} catch (error) {
				diagnostics.push({
					code: "INVALID_ENTRY",
					toolName: typeof input?.name === "string" ? input.name : undefined,
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			const previous = this.entries.get(entry.name);
			if (previous && !sameEntry(previous, entry)) {
				this.entries.delete(entry.name);
				this.conflicts.add(entry.name);
				diagnostics.push({ code: "CONFLICT", toolName: entry.name, message: `Conflicting registry entries for '${entry.name}'` });
				continue;
			}
			if (!this.conflicts.has(entry.name)) this.entries.set(entry.name, entry);
		}
		this.diagnostics = diagnostics;
	}

	get(name: string): RegistryEntry | undefined {
		return this.entries.get(name);
	}

	resolve(name: string, info: ToolInfoLike | undefined): RegistryMatch {
		if (this.conflicts.has(name)) return { ok: false, reason: `Capability registry conflict for '${name}'` };
		const entry = this.entries.get(name);
		if (!entry) return { ok: false, reason: `Unknown tool '${name}' is fail-closed during planning` };
		if (!info || info.name !== name || !info.sourceInfo) {
			return { ok: false, entry, reason: `Tool '${name}' source metadata is unavailable` };
		}
		if (info.sourceInfo.source !== entry.source) {
			return {
				ok: false,
				entry,
				reason: `Tool '${name}' source mismatch: expected '${entry.source}', got '${info.sourceInfo.source ?? "missing"}'`,
			};
		}
		if (entry.path) {
			const actual = info.sourceInfo.path;
			const expectedPath = entry.path.startsWith("<builtin:") ? entry.path : path.resolve(entry.path);
			const actualPath = actual?.startsWith("<builtin:") ? actual : actual ? path.resolve(actual) : undefined;
			if (actualPath !== expectedPath) {
				return {
					ok: false,
					entry,
					reason: `Tool '${name}' path mismatch: expected '${expectedPath}', got '${actualPath ?? "missing"}'`,
				};
			}
		}
		return { ok: true, entry, sourceDigest: sourceDigest(entry, info), reason: `Verified registry adapter '${name}'` };
	}

	planningToolNames(tools: readonly ToolInfoLike[]): string[] {
		const names: string[] = [];
		for (const tool of tools) {
			const match = this.resolve(tool.name, tool);
			if (match.ok && match.entry?.planning !== "never") names.push(tool.name);
		}
		return names;
	}

	digest(): string {
		return sha256(
			canonicalJson({
				policy: "pi-plan-mode/planning-capability-registry-v2",
				entries: [...this.entries.values()].sort((left, right) => left.name.localeCompare(right.name)),
				conflicts: [...this.conflicts].sort(),
				diagnostics: this.diagnostics,
			}),
		);
	}
}

export function researchPermissionKey(
	planId: string,
	toolName: string,
	sourceDigestValue: string,
): string {
	return `${planId}\u0000${toolName}\u0000${sourceDigestValue}`;
}

export function findPermission(
	permissions: ReadonlyMap<string, ResearchPermissionRecord>,
	planId: string,
	toolName: string,
	sourceDigestValue: string,
): ResearchPermissionRecord | undefined {
	return permissions.get(researchPermissionKey(planId, toolName, sourceDigestValue));
}
