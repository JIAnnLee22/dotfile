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
import { buildPlanProgressLines, buildPlanProgressSummary, formatWorkspaceBytes, truncateStepTitle } from "../src/ui.ts";

const steps: PlanStepSpec[] = [
	{
		id: "S1",
		title: "Create extension",
		purpose: "Implement",
		actions: ["write"],
		pathScopes: ["src/"],
		requiredCapabilities: ["fs.write"],
		acceptance: ["created"],
		rollback: ["remove"],
	},
	{
		id: "S2",
		title: "Update configuration",
		purpose: "Configure",
		actions: ["edit"],
		pathScopes: ["settings.json"],
		requiredCapabilities: ["fs.write"],
		acceptance: ["updated"],
		rollback: ["restore"],
	},
	{
		id: "S3",
		title: "Verify behavior",
		purpose: "Verify",
		actions: ["test"],
		pathScopes: [],
		requiredCapabilities: ["fs.read"],
		acceptance: ["verified"],
		rollback: ["none"],
	},
];

const spec: PlanSpec = {
	schema: PLAN_SCHEMA,
	planId: "plan-test",
	version: 1,
	parentVersion: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	createdBy: { channel: "tui", id: "tester" },
	goal: "Test compact UI",
	facts: [],
	assumptions: [],
	scope: { cwd: "/tmp/project", sessionId: "session", branchLeafId: "leaf", ephemeralSession: false },
	steps,
	risks: [],
	policyDigest: "policy",
	contextDigest: "context",
	workspaceSnapshot: {
		schema: "dev.pi.workspace-snapshot/v1",
		capturedAt: "2026-01-01T00:00:00.000Z",
		scopes: ["src/"],
		entries: [
			{ path: "src/a.ts", kind: "file", size: 1024, contentHash: "a" },
			{ path: "src/b.ts", kind: "file", size: 512, contentHash: "b" },
		],
		totalBytes: 1536,
		digest: "workspace",
	},
	contentHash: "content",
};

function state(overrides: Partial<ExecutionState> = {}): ExecutionState {
	return {
		schema: STATE_SCHEMA,
		status: "executing",
		epoch: 3,
		planId: spec.planId,
		currentStepId: "S2",
		steps: {
			S1: { status: "verified", evidenceIds: ["e1"] },
			S2: { status: "running", evidenceIds: ["e2", "e3"] },
			S3: { status: "pending", evidenceIds: [] },
		},
		securityLevel: SECURITY_LEVEL,
		ephemeralSession: false,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

test("clears the widget projection when no PlanSpec exists", () => {
	assert.equal(buildPlanProgressSummary(undefined, state()), undefined);
});

test("summarizes progress, current step, evidence and workspace on one row", () => {
	assert.equal(buildPlanProgressSummary(spec, state()), "1/3 · ▶ S2 Update configuration · ev 3 · ws 2/1.5 KiB");
});

test("renders the user-facing multi-line Todo tree with aggregate counts", () => {
	assert.deepEqual(buildPlanProgressLines(spec, state()), [
		"Todos — 1/3 completed · 1 in progress · 1 pending",
		"├─ ✓ #S1 Create extension",
		"├─ ▶ #S2 Update configuration",
		"└─ ○ #S3 Verify behavior",
	]);
});

test("shows completion when every step is verified", () => {
	const completed = state({
		status: "completed",
		currentStepId: undefined,
		steps: {
			S1: { status: "verified", evidenceIds: ["e1"] },
			S2: { status: "verified", evidenceIds: ["e2"] },
			S3: { status: "verified", evidenceIds: ["e3"] },
		},
	});
	assert.equal(buildPlanProgressSummary(spec, completed), "3/3 · ✓ complete · ev 3 · ws 2/1.5 KiB");
});

test("falls back to the first unverified step when there is no currentStepId", () => {
	const review = state({
		status: "review",
		currentStepId: undefined,
		steps: {
			S1: { status: "pending", evidenceIds: [] },
			S2: { status: "pending", evidenceIds: [] },
			S3: { status: "pending", evidenceIds: [] },
		},
	});
	assert.match(buildPlanProgressSummary(spec, review) ?? "", /^0\/3 · ○ S1 Create extension · ev 0 · ws 2\/1\.5 KiB$/);
});

test("keeps the active Todo visible when a long plan is windowed", () => {
	const longSteps = Array.from({ length: 20 }, (_, index) => ({
		...steps[0]!,
		id: `S${index + 1}`,
		title: `Step ${index + 1}`,
	}));
	const longSpec = { ...spec, steps: longSteps };
	const lines = buildPlanProgressLines(
		longSpec,
		state({
			currentStepId: "S18",
			steps: { S18: { status: "running", evidenceIds: [] } },
		}),
		5,
	);
	assert.ok(lines?.some((line) => line.includes("#S18 Step 18")));
	assert.ok(lines?.some((line) => line.includes("earlier steps")));
});

test("caps long step titles before terminal-width truncation", () => {
	const title = "非常长的步骤标题".repeat(12);
	const truncated = truncateStepTitle(title);
	assert.equal(Array.from(truncated).length, 56);
	assert.ok(truncated.endsWith("…"));
	const longSpec = { ...spec, steps: [{ ...steps[1]!, title }] };
	const summary = buildPlanProgressSummary(longSpec, state({ currentStepId: "S2", steps: { S2: { status: "running", evidenceIds: [] } } }));
	assert.ok(summary?.includes("… · ev 0"));
});

test("formats workspace byte counts compactly", () => {
	assert.equal(formatWorkspaceBytes(0), "0 B");
	assert.equal(formatWorkspaceBytes(1536), "1.5 KiB");
	assert.equal(formatWorkspaceBytes(1.5 * 1024 ** 2), "1.5 MiB");
});
