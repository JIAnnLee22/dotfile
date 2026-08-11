import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PlanArtifactStore } from "../src/artifact-store.ts";
import { PlanController, type AuditJournalWriter } from "../src/controller.ts";
import { ACTION_PROTOCOL, type AuditEvent, type PlanAction, type PlanActionRequest, type PlanDraft, type PlanRef, type PlanScope } from "../src/domain.ts";

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
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-plan-mode-test-"));
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
		now: () => "2026-08-11T00:00:00.000Z",
		id: idFactory(),
	});
	return { root, cwd, journal, store, controller, scope, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

export const draft: PlanDraft = {
	goal: "Change the existing value safely",
	facts: ["src/existing.ts exists"],
	assumptions: [],
	steps: [
		{
			id: "S1",
			title: "Update value",
			purpose: "Implement the approved change",
			actions: ["Edit src/existing.ts"],
			dependencyScopes: ["src/existing.ts"],
			pathScopes: ["src/existing.ts"],
			requiredCapabilities: ["fs.read", "fs.write"],
			acceptance: ["The value is updated"],
			rollback: ["Restore the previous value"],
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
	return {
		scope,
		policyDigest: "policy-digest",
		contextDigest: "context-digest",
		...extra,
	};
}
