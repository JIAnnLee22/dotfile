import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MissionArtifactStore } from "../src/artifact-store.ts";
import { AutopilotController, type AuditJournalWriter } from "../src/controller.ts";
import {
	ACTION_PROTOCOL,
	type AcReportEntry,
	type AuditEvent,
	type AutopilotAction,
	type AutopilotActionRequest,
	type MissionDraft,
	type MissionScope,
} from "../src/domain.ts";

export class MemoryJournal implements AuditJournalWriter {
	readonly events: AuditEvent[] = [];
	fail = false;

	append(event: AuditEvent): void {
		if (this.fail) throw new Error("journal unavailable");
		this.events.push(structuredClone(event));
	}

	entries(): Array<{ type: "custom"; customType: "autopilot/audit"; data: AuditEvent }> {
		return this.events.map((event) => ({ type: "custom", customType: "autopilot/audit", data: structuredClone(event) }));
	}
}

export function idFactory(): () => string {
	let counter = 0;
	return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
}

export function clockFactory(): () => string {
	let tick = 0;
	return () => new Date(Date.UTC(2026, 7, 11, 0, 0, tick++)).toISOString();
}

export async function fixture(): Promise<{
	root: string;
	cwd: string;
	journal: MemoryJournal;
	store: MissionArtifactStore;
	controller: AutopilotController;
	scope: MissionScope;
	draft: MissionDraft;
	cleanup(): Promise<void>;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-autopilot-test-"));
	const cwd = path.join(root, "project");
	await fs.mkdir(path.join(cwd, "src"), { recursive: true });
	await fs.writeFile(path.join(cwd, "src", "existing.ts"), "export const value = 1;\n");
	const journal = new MemoryJournal();
	const store = new MissionArtifactStore(path.join(root, "missions"), cwd);
	const scope: MissionScope = {
		cwd,
		sessionId: "session-test",
		branchLeafId: "leaf-test",
		ephemeralSession: false,
	};
	const controller = new AutopilotController({
		store,
		journal,
		now: clockFactory(),
		id: idFactory(),
	});
	return { root, cwd, journal, store, controller, scope, draft, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

export const draft: MissionDraft = {
	goal: "Make the existing value pass all acceptance criteria",
	facts: ["src/existing.ts exists"],
	assumptions: ["The project has no test runner yet"],
	acceptance: [
		{ id: "AC1", title: "src/existing.ts exports a constant named value", verify: "grep -q 'export const value' src/existing.ts" },
		{ id: "AC2", title: "value equals 42", verify: "node -e \"const m = await import('./src/existing.ts'); if (m.value !== 42) process.exit(1)\"" },
	],
	pathScopes: [],
	dependencyScopes: ["src/existing.ts"],
	risks: ["Wrong value semantics"],
};

export const actor = { channel: "tui", id: "test-user" } as const;
export const modelActor = { channel: "model", id: "test-model" } as const;
export const systemActor = { channel: "system", id: "test-system" } as const;

export function request(action: AutopilotAction, requestActor = actor): AutopilotActionRequest {
	return {
		protocolVersion: ACTION_PROTOCOL,
		requestId: `${action}-request`,
		action,
		actor: requestActor,
	};
}

export function environment(scope: MissionScope, extra: Record<string, unknown> = {}) {
	return {
		scope,
		policyDigest: "policy-digest",
		contextDigest: "context-digest",
		...extra,
	};
}

export function entry(acId: string, status: AcReportEntry["status"], evidence = `evidence for ${acId}`): AcReportEntry {
	return { acId, status, evidence };
}

export async function startAndSubmit(fx: Awaited<ReturnType<typeof fixture>>): Promise<void> {
	const started = await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: fx.draft.goal }));
	if (!started.ok) throw new Error(`start failed: ${started.error?.message}`);
	const submitted = await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: fx.draft }));
	if (!submitted.ok) throw new Error(`submit failed: ${submitted.error?.message}`);
}
