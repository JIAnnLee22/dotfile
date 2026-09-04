import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ResearchCapability } from "./domain.ts";
import type { PathAdapter, PlanningDisposition, RegistryEntryInput } from "./capability-registry.ts";

export interface PolicyConfigDiagnostic {
	readonly code: "NOT_FOUND" | "READ_ERROR" | "PARSE_ERROR" | "SCHEMA_ERROR";
	readonly message: string;
}

export interface LoadedPolicyConfig {
	readonly path: string;
	readonly entries: readonly RegistryEntryInput[];
	readonly diagnostics: readonly PolicyConfigDiagnostic[];
}

interface RawPolicyTool {
	readonly name?: unknown;
	readonly capabilities?: unknown;
	readonly source?: unknown;
	readonly path?: unknown;
	readonly planning?: unknown;
	readonly pathAdapter?: unknown;
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
const PLANNING = new Set<PlanningDisposition>(["always", "confirm-per-plan", "never"]);
const PATH_ADAPTERS = new Set<PathAdapter>(["required-path", "optional-path", "none"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTool(raw: RawPolicyTool, index: number, agentDir: string): RegistryEntryInput {
	if (typeof raw.name !== "string" || !raw.name.trim()) throw new TypeError(`tools[${index}].name is required`);
	if (!Array.isArray(raw.capabilities) || raw.capabilities.length === 0) {
		throw new TypeError(`tools[${index}].capabilities must not be empty`);
	}
	if (raw.capabilities.some((value) => typeof value !== "string" || !CAPABILITIES.has(value as ResearchCapability))) {
		throw new TypeError(`tools[${index}].capabilities contains an unsupported value`);
	}
	if (typeof raw.source !== "string" || !raw.source.trim()) throw new TypeError(`tools[${index}].source is required`);
	if (typeof raw.path !== "string" || !raw.path.trim()) {
		throw new TypeError(`tools[${index}].path is required; name/source-only trust is not allowed`);
	}
	if (typeof raw.planning !== "string" || !PLANNING.has(raw.planning as PlanningDisposition)) {
		throw new TypeError(`tools[${index}].planning must be always, confirm-per-plan or never`);
	}
	if (raw.pathAdapter !== undefined && (typeof raw.pathAdapter !== "string" || !PATH_ADAPTERS.has(raw.pathAdapter as PathAdapter))) {
		throw new TypeError(`tools[${index}].pathAdapter is invalid`);
	}
	const configuredPath = raw.path.trim();
	return {
		name: raw.name.trim(),
		capabilities: raw.capabilities as ResearchCapability[],
		source: raw.source.trim(),
		path: configuredPath.startsWith("<builtin:") ? configuredPath : path.resolve(agentDir, configuredPath),
		planning: raw.planning as PlanningDisposition,
		pathAdapter: (raw.pathAdapter as PathAdapter | undefined) ?? "none",
	};
}

export async function loadPolicyConfig(agentDir: string, explicitPath?: string): Promise<LoadedPolicyConfig> {
	const filePath = path.resolve(explicitPath ?? path.join(agentDir, "plan-mode-policy.json"));
	let source: string;
	try {
		source = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path: filePath, entries: [], diagnostics: [] };
		}
		return {
			path: filePath,
			entries: [],
			diagnostics: [{ code: "READ_ERROR", message: `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}` }],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		return {
			path: filePath,
			entries: [],
			diagnostics: [{ code: "PARSE_ERROR", message: `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}` }],
		};
	}
	if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.tools)) {
		return {
			path: filePath,
			entries: [],
			diagnostics: [{ code: "SCHEMA_ERROR", message: "Policy config must be { version: 1, tools: [...] }" }],
		};
	}
	const entries: RegistryEntryInput[] = [];
	const diagnostics: PolicyConfigDiagnostic[] = [];
	for (const [index, raw] of parsed.tools.entries()) {
		try {
			if (!isRecord(raw)) throw new TypeError(`tools[${index}] must be an object`);
			entries.push(parseTool(raw, index, agentDir));
		} catch (error) {
			diagnostics.push({ code: "SCHEMA_ERROR", message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { path: filePath, entries, diagnostics };
}
