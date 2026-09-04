import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PlanArtifactStore } from "../src/artifact-store.ts";
import { CapabilityRegistry, defaultRegistryEntries, type ToolInfoLike } from "../src/capability-registry.ts";
import { PlanController, type AuditJournalWriter } from "../src/controller.ts";
import { activeToolsDigest } from "../src/tool-session.ts";
import {
	ACTION_PROTOCOL,
	type AuditEvent,
	type PlanAction,
	type PlanActionRequest,
	type PlanDraft,
	type PlanRef,
	type PlanScope,
	type ToolBaselineRecord,
} from "../src/domain.ts";

export class MemoryJournal implements AuditJournalWriter {
	readonly events: AuditEvent[] = [];
	fail = false;

	append(event: AuditEvent): void {
		if (this.fail) throw new Error("journal unavailable");
		this.events.push(structuredClone(event));
	}

	entries(): Array<{ type: "custom"; customType: "plan-mode/audit"; data: AuditEvent }> {
		return this.events.map((event) => ({ type: "custom", customType: "plan-mode/audit", data: structuredClone(event) }));
	}
}

export function idFactory(): () => string {
	let counter = 0;
	return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
}

export async function fixture(): Promise<{
	root: string;
	cwd: string;
	journal: MemoryJournal;
	store: PlanArtifactStore;
	controller: PlanController;
	scope: PlanScope;
	cleanup(): Promise<void>;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-plan-mode-v2-test-"));
	const cwd = path.join(root, "project");
	await fs.mkdir(path.join(cwd, "src"), { recursive: true });
	await fs.writeFile(path.join(cwd, "src", "existing.ts"), "export const value = 1;\n");
	const journal = new MemoryJournal();
	const store = new PlanArtifactStore(path.join(root, "plans"), cwd);
	const scope: PlanScope = {
		cwd,
		sessionId: "session-test",
		branchLeafId: "leaf-test",
		ephemeralSession: false,
	};
	const controller = new PlanController({
		store,
		journal,
		now: () => "2026-09-03T00:00:00.000Z",
		id: idFactory(),
	});
	return { root, cwd, journal, store, controller, scope, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

export const draft: PlanDraft = {
	goal: "Change the existing value safely",
	decisions: ["Keep the public API stable"],
	steps: [
		{
			title: "Update value",
			actions: ["Edit src/existing.ts"],
			files: ["src/existing.ts"],
			validation: ["Read the updated value"],
		},
		{
			title: "Run checks",
			actions: ["Run regression tests"],
			files: [],
			validation: ["Tests pass"],
		},
	],
	risks: ["Incorrect value"],
};

export const actor = { channel: "tui", id: "test-user" } as const;
export const modelActor = { channel: "model", id: "test-model" } as const;

export function request(action: PlanAction, expectedPlan?: PlanRef, requestActor = actor): PlanActionRequest {
	return {
		protocolVersion: ACTION_PROTOCOL,
		requestId: `${action}-request`,
		action,
		expectedPlan,
		actor: requestActor,
	};
}

export function environment(scope: PlanScope, extra: Record<string, unknown> = {}) {
	return { scope, ...extra };
}

export function baseline(
	scope: PlanScope,
	planId = "10000000-0000-4000-8000-000000000001",
	toolNames: readonly string[] = ["read", "bash", "edit", "write", "ffgrep"],
): ToolBaselineRecord {
	return {
		schema: "dev.pi.plan-tool-baseline/v2",
		baselineId: "20000000-0000-4000-8000-000000000001",
		planId,
		toolNames,
		capturedAt: "2026-09-03T00:00:00.000Z",
		sessionId: scope.sessionId,
		branchEntryId: scope.branchLeafId,
	};
}

export async function start(controller: PlanController, scope: PlanScope, goal = draft.goal) {
	return controller.dispatch(request("start"), environment(scope, { goal, baseline: baseline(scope) }));
}

export async function submit(controller: PlanController, scope: PlanScope, value: PlanDraft = draft) {
	return controller.dispatch(request("submit", undefined, modelActor), environment(scope, { draft: value }));
}

export async function prepareReview(controller: PlanController, scope: PlanScope, value: PlanDraft = draft) {
	await start(controller, scope, value.goal);
	await submit(controller, scope, value);
	return controller.state.planRef!;
}

export function implementationEnvironment(scope: PlanScope) {
	const activeTools = ["read", "edit", "write", "bash", "plan_step_complete", "plan_blocked"];
	return environment(scope, { activeTools, activeToolsDigest: activeToolsDigest(activeTools) });
}

export const AGENT_DIR = "/agent";

export function testRegistry(): CapabilityRegistry {
	return new CapabilityRegistry(defaultRegistryEntries(AGENT_DIR));
}

export function builtin(name: string): ToolInfoLike {
	return { name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } };
}

export function packageTool(name: string, source: string, relativePath: string): ToolInfoLike {
	return { name, sourceInfo: { source, path: `${AGENT_DIR}/npm/node_modules/${relativePath}` } };
}

export const TOOL_PATHS = {
	fff: "@ff-labs/pi-fff/src/index.ts",
	web: "pi-web-access/index.ts",
	context: "context-mode/build/adapters/pi/extension.js",
} as const;
