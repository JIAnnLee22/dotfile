import { canonicalJson, sha256 } from "./canonical.ts";
import { CapabilityRegistry, type ToolInfoLike } from "./capability-registry.ts";
import type { PlanScope, ToolBaselineRecord } from "./domain.ts";

export const MANDATORY_IMPLEMENTATION_TOOLS = ["edit", "write", "bash"] as const;
export const PLAN_MANAGED_TOOLS = ["plan_question", "plan_submit", "plan_step_complete", "plan_blocked"] as const;

export interface ToolRuntimePort {
	getActiveTools(): string[];
	getAllTools(): ToolInfoLike[];
	setActiveTools(names: string[]): void;
}

export interface ToolTransitionResult {
	readonly ok: boolean;
	readonly requested: readonly string[];
	readonly active: readonly string[];
	readonly activeDigest: string;
	readonly missing: readonly string[];
	readonly reason?: string;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

export function activeToolsDigest(toolNames: readonly string[]): string {
	return sha256(canonicalJson(unique(toolNames)));
}

function isExpectedBuiltin(tool: ToolInfoLike | undefined, name: string): boolean {
	return tool?.name === name && tool.sourceInfo?.source === "builtin" && tool.sourceInfo.path === `<builtin:${name}>`;
}

export class ToolSession {
	private readonly port: ToolRuntimePort;
	private readonly registry: CapabilityRegistry;

	constructor(port: ToolRuntimePort, registry: CapabilityRegistry) {
		this.port = port;
		this.registry = registry;
	}

	captureBaseline(
		planId: string,
		scope: PlanScope,
		baselineId: string,
		capturedAt: string,
	): ToolBaselineRecord {
		return {
			schema: "dev.pi.plan-tool-baseline/v2",
			baselineId,
			planId,
			toolNames: unique(this.port.getActiveTools()),
			capturedAt,
			sessionId: scope.sessionId,
			branchEntryId: scope.branchLeafId,
		};
	}

	planningToolNames(managed: readonly string[] = PLAN_MANAGED_TOOLS): string[] {
		const all = this.port.getAllTools();
		return unique([...this.registry.planningToolNames(all), ...managed.filter((name) => all.some((tool) => tool.name === name))]);
	}

	applyPlanning(managed: readonly string[] = PLAN_MANAGED_TOOLS): ToolTransitionResult {
		const requested = this.planningToolNames(managed);
		this.port.setActiveTools(requested);
		const active = unique(this.port.getActiveTools());
		const missing = requested.filter((name) => !active.includes(name));
		return {
			ok: missing.length === 0,
			requested,
			active,
			activeDigest: activeToolsDigest(active),
			missing,
			...(missing.length ? { reason: `Planning tools failed to activate: ${missing.join(", ")}` } : {}),
		};
	}

	prepareImplementation(baseline: ToolBaselineRecord): ToolTransitionResult {
		const all = this.port.getAllTools();
		const sourceFailures = MANDATORY_IMPLEMENTATION_TOOLS.filter(
			(name) => !isExpectedBuiltin(all.find((tool) => tool.name === name), name),
		);
		if (sourceFailures.length > 0) {
			const active = unique(this.port.getActiveTools());
			return {
				ok: false,
				requested: [],
				active,
				activeDigest: activeToolsDigest(active),
				missing: sourceFailures,
				reason: `Mandatory implementation tools are missing or overridden: ${sourceFailures.join(", ")}`,
			};
		}
		const registered = new Set(all.map((tool) => tool.name));
		const requested = unique([
			...baseline.toolNames.filter((name) => registered.has(name)),
			...MANDATORY_IMPLEMENTATION_TOOLS,
			...PLAN_MANAGED_TOOLS.filter((name) => registered.has(name)),
		]);
		this.port.setActiveTools(requested);
		const active = unique(this.port.getActiveTools());
		const missing = MANDATORY_IMPLEMENTATION_TOOLS.filter((name) => !active.includes(name));
		if (missing.length > 0) {
			const rollback = this.applyPlanning();
			return {
				ok: false,
				requested,
				active: rollback.active,
				activeDigest: rollback.activeDigest,
				missing,
				reason: `setActiveTools readback is missing mandatory tools: ${missing.join(", ")}`,
			};
		}
		return {
			ok: true,
			requested,
			active,
			activeDigest: activeToolsDigest(active),
			missing: [],
		};
	}

	verifyImplementation(): ToolTransitionResult {
		const active = unique(this.port.getActiveTools());
		const missing = MANDATORY_IMPLEMENTATION_TOOLS.filter((name) => !active.includes(name));
		return {
			ok: missing.length === 0,
			requested: active,
			active,
			activeDigest: activeToolsDigest(active),
			missing,
			...(missing.length ? { reason: `Implementation tools are no longer active: ${missing.join(", ")}` } : {}),
		};
	}

	restoreBaseline(baseline: ToolBaselineRecord): ToolTransitionResult {
		const registered = new Set(this.port.getAllTools().map((tool) => tool.name));
		const requested = baseline.toolNames.filter((name) => registered.has(name));
		const removed = baseline.toolNames.filter((name) => !registered.has(name));
		this.port.setActiveTools(requested);
		const active = unique(this.port.getActiveTools());
		const missing = requested.filter((name) => !active.includes(name));
		return {
			ok: missing.length === 0,
			requested,
			active,
			activeDigest: activeToolsDigest(active),
			missing: [...removed, ...missing],
			...((removed.length || missing.length) && {
				reason: `Baseline restore omitted unavailable tools: ${[...removed, ...missing].join(", ")}`,
			}),
		};
	}
}
