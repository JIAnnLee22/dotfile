import assert from "node:assert/strict";
import test from "node:test";
import {
	PLAN_SCHEMA,
	SECURITY_LEVEL,
	STATE_SCHEMA,
	type ExecutionState,
	type PlanSpec,
	type PlanStepSpec,
} from "../src/domain.ts";
import { buildPlanProgressLines, buildPlanProgressSummary, truncateStepTitle } from "../src/ui.ts";

const steps: PlanStepSpec[] = [
	{ id: "S1", title: "Create extension", actions: ["write"], files: ["src/"], validation: ["created"] },
	{ id: "S2", title: "Update configuration", actions: ["edit"], files: ["settings.json"], validation: ["updated"] },
	{ id: "S3", title: "Verify behavior", actions: ["test"], files: [], validation: ["verified"] },
];

const spec: PlanSpec = {
	schema: PLAN_SCHEMA,
	planId: "plan-test",
	version: 1,
	parentVersion: null,
	createdAt: "2026-09-03T00:00:00.000Z",
	createdBy: { channel: "tui", id: "tester" },
	goal: "Test compact UI",
	decisions: [],
	scope: { cwd: "/tmp/project", sessionId: "session", branchLeafId: "leaf", ephemeralSession: false },
	steps,
	risks: [],
	contentHash: "content",
};

function state(overrides: Partial<ExecutionState> = {}): ExecutionState {
	return {
		schema: STATE_SCHEMA,
		status: "implementing",
		revision: 3,
		runRevision: 3,
		stepRevision: 1,
		planId: spec.planId,
		currentStepId: "S2",
		steps: {
			S1: { status: "completed", reportIds: ["r1"], evidenceIds: ["e1"] },
			S2: { status: "running", reportIds: [], evidenceIds: ["e2", "e3"] },
			S3: { status: "pending", reportIds: [], evidenceIds: [] },
		},
		securityLevel: SECURITY_LEVEL,
		ephemeralSession: false,
		updatedAt: "2026-09-03T00:00:00.000Z",
		...overrides,
	};
}

test("clears the widget projection when no PlanSpec exists", () => {
	assert.equal(buildPlanProgressSummary(undefined, state()), undefined);
});

test("summarizes progress, current step, reports and evidence on one row", () => {
	assert.equal(buildPlanProgressSummary(spec, state()), "1/3 · ▶ S2 Update configuration · reports 1 · evidence 3");
});

test("renders the multi-line Todo tree with aggregate counts", () => {
	assert.deepEqual(buildPlanProgressLines(spec, state()), [
		"Plan · implementing · 1/3 completed · 1 in progress · 1 pending",
		"├─ ✓ #S1 Create extension",
		"├─ ▶ #S2 Update configuration",
		"└─ ○ #S3 Verify behavior",
	]);
});

test("shows completion when every step is completed", () => {
	const completed = state({
		status: "completed",
		currentStepId: undefined,
		steps: {
			S1: { status: "completed", reportIds: ["r1"], evidenceIds: ["e1"] },
			S2: { status: "completed", reportIds: ["r2"], evidenceIds: ["e2"] },
			S3: { status: "completed", reportIds: ["r3"], evidenceIds: ["e3"] },
		},
	});
	assert.equal(buildPlanProgressSummary(spec, completed), "3/3 · ✓ complete · reports 1 · evidence 3");
});

test("keeps the active Todo visible when a long plan is windowed", () => {
	const longSteps = Array.from({ length: 20 }, (_, index) => ({ ...steps[0]!, id: `S${index + 1}`, title: `Step ${index + 1}` }));
	const longSpec = { ...spec, steps: longSteps };
	const lines = buildPlanProgressLines(
		longSpec,
		state({ currentStepId: "S18", steps: { S18: { status: "running", reportIds: [], evidenceIds: [] } } }),
		5,
	);
	assert.ok(lines?.some((line) => line.includes("#S18 Step 18")));
	assert.ok(lines?.some((line) => line.includes("earlier steps")));
});

test("caps long step titles before terminal-width truncation", () => {
	const title = "非常长的步骤标题".repeat(12);
	const truncated = truncateStepTitle(title);
	assert.equal(Array.from(truncated).length, 64);
	assert.ok(truncated.endsWith("…"));
});
