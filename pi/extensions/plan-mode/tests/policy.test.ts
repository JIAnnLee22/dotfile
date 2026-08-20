import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { PlanDraft } from "../src/domain.ts";
import { evaluateToolCall } from "../src/policy.ts";
import { actor, draft, environment, fixture, modelActor, request } from "./helpers.ts";

const builtin = (name: string) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } });

test("PM-P0-002 planning allows only known built-in reads inside configured roots", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: "Research" }));
		const state = f.controller.state;
		assert.equal(
			evaluateToolCall({
				state,
				toolName: "read",
				input: { path: "src/existing.ts" },
				toolInfo: builtin("read"),
				cwd: f.cwd,
				readRoots: [f.cwd],
			}).allow,
			true,
		);
		assert.equal(
			evaluateToolCall({
				state,
				toolName: "read",
				input: { path: "../outside" },
				toolInfo: builtin("read"),
				cwd: f.cwd,
				readRoots: [f.cwd],
			}).allow,
			false,
		);
		for (const expandedPath of ["@../outside", "~/outside"]) {
			assert.equal(
				evaluateToolCall({
					state,
					toolName: "read",
					input: { path: expandedPath },
					toolInfo: builtin("read"),
					cwd: f.cwd,
					readRoots: [f.cwd],
				}).allow,
				false,
				expandedPath,
			);
		}
		assert.match(
			evaluateToolCall({
				state,
				toolName: "read",
				input: { path: "src/existing.ts" },
				toolInfo: { name: "read", sourceInfo: { source: "extension", path: "/tmp/override.ts" } },
				cwd: f.cwd,
			}).reason,
			/overrides/,
		);
		for (const toolName of ["bash", "deploy", "questionnaire"]) {
			assert.equal(
				evaluateToolCall({ state, toolName, input: {}, toolInfo: { name: toolName }, cwd: f.cwd }).allow,
				false,
				`${toolName} must fail closed`,
			);
		}
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-004 managed clarification and submission tools require the exact extension source", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: "Research" }));
		for (const toolName of ["plan_question", "plan_submit"]) {
			const allowed = evaluateToolCall({
				state: f.controller.state,
				toolName,
				input: {},
				toolInfo: { name: toolName, sourceInfo: { source: "extension", path: "/trusted/plan-mode.ts" } },
				managedTools: [
					{ name: "plan_question", sourcePath: "/trusted/plan-mode.ts" },
					{ name: "plan_submit", sourcePath: "/trusted/plan-mode.ts" },
				],
				cwd: f.cwd,
			});
			assert.equal(allowed.allow, true);
			const replaced = evaluateToolCall({
				state: f.controller.state,
				toolName,
				input: {},
				toolInfo: { name: toolName, sourceInfo: { source: "extension", path: "/other/override.ts" } },
				managedTools: [{ name: toolName, sourcePath: "/trusted/plan-mode.ts" }],
				cwd: f.cwd,
			});
			assert.equal(replaced.allow, false);
		}
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-008 managed completion and blocker tools require executing state and exact source", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const ref = f.controller.state.planRef!;
		await f.controller.dispatch(request("run", ref), environment(f.scope));
		for (const toolName of ["plan_step_complete", "plan_blocked"]) {
			const allowed = evaluateToolCall({
				state: f.controller.state,
				toolName,
				input: {},
				toolInfo: { name: toolName, sourceInfo: { source: "extension", path: "/trusted/plan-mode.ts" } },
				managedTools: [{ name: toolName, sourcePath: "/trusted/plan-mode.ts" }],
				cwd: f.cwd,
			});
			assert.equal(allowed.allow, true, toolName);
			const replaced = evaluateToolCall({
				state: f.controller.state,
				toolName,
				input: {},
				toolInfo: { name: toolName, sourceInfo: { source: "extension", path: "/untrusted/override.ts" } },
				managedTools: [{ name: toolName, sourcePath: "/trusted/plan-mode.ts" }],
				cwd: f.cwd,
			});
			assert.equal(replaced.allow, false, toolName);
		}
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-007 symlink escapes are resolved and denied", async () => {
	const f = await fixture();
	try {
		const outside = path.join(f.root, "outside.txt");
		await fs.writeFile(outside, "secret\n");
		await fs.symlink(outside, path.join(f.cwd, "src", "escape.txt"));
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: "Research" }));
		const decision = evaluateToolCall({
			state: f.controller.state,
			toolName: "read",
			input: { path: "src/escape.txt" },
			toolInfo: builtin("read"),
			cwd: f.cwd,
			readRoots: [f.cwd],
		});
		assert.equal(decision.allow, false);
		assert.match(decision.reason, /escapes configured roots/);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-007 ExecutionGrant restricts built-in writes to current step paths and epoch", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const ref = f.controller.state.planRef;
		assert.ok(ref);
		await f.controller.dispatch(request("approve", ref), environment(f.scope));
		await f.controller.dispatch(request("execute", ref), environment(f.scope));
		const base = {
			state: f.controller.state,
			spec: f.controller.spec,
			grant: f.controller.grant,
			toolName: "edit",
			toolInfo: builtin("edit"),
			cwd: f.cwd,
		};
		assert.equal(evaluateToolCall({ ...base, input: { path: "src/existing.ts" } }).allow, true);
		assert.equal(
			evaluateToolCall({
				...base,
				toolName: "patch",
				toolInfo: {
					name: "patch",
					sourceInfo: { source: "extension", path: path.resolve(import.meta.dirname, "../../patch/index.ts") },
				},
				input: { path: "src/existing.ts", patch: "@@ -1 +1 @@\n-old\n+new\n" },
			}).allow,
			true,
		);
		assert.equal(evaluateToolCall({ ...base, input: { path: "src/other.ts" } }).allow, false);
		assert.equal(evaluateToolCall({ ...base, input: { path: "../escape.ts" } }).allow, false);
		assert.equal(
			evaluateToolCall({ ...base, grant: { ...f.controller.grant!, epoch: f.controller.state.epoch - 1 }, input: { path: "src/existing.ts" } }).allow,
			false,
		);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-007 approved write scope cannot escape cwd through a symlink", async () => {
	const f = await fixture();
	try {
		const outsideDirectory = path.join(f.root, "outside-dir");
		await fs.mkdir(outsideDirectory);
		await fs.symlink(outsideDirectory, path.join(f.cwd, "link"));
		const symlinkDraft = {
			...draft,
			steps: [{ ...draft.steps[0], pathScopes: ["link/"] }],
		};
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: symlinkDraft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft: symlinkDraft }));
		const ref = f.controller.state.planRef!;
		await f.controller.dispatch(request("approve", ref), environment(f.scope));
		await f.controller.dispatch(request("execute", ref), environment(f.scope));
		const decision = evaluateToolCall({
			state: f.controller.state,
			spec: f.controller.spec,
			grant: f.controller.grant,
			toolName: "write",
			input: { path: "link/escaped.ts" },
			toolInfo: builtin("write"),
			cwd: f.cwd,
		});
		assert.equal(decision.allow, false);
		assert.match(decision.reason, /escapes project cwd/);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-003 bash remains denied unless the current approved step declares process.exec", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const ref = f.controller.state.planRef!;
		await f.controller.dispatch(request("run", ref), environment(f.scope));
		const decision = evaluateToolCall({
			state: f.controller.state,
			spec: f.controller.spec,
			grant: f.controller.grant,
			toolName: "bash",
			input: { command: "git status" },
			toolInfo: builtin("bash"),
			cwd: f.cwd,
		});
		assert.equal(decision.allow, false);
		assert.match(decision.reason, /does not grant process\.exec/);
	} finally {
		await f.cleanup();
	}
});

test("PM-P0-007 one approval allows built-in bash only for a process.exec Todo", async () => {
	const f = await fixture();
	try {
		const processDraft: PlanDraft = {
			...draft,
			steps: [
				{
					...draft.steps[0],
					title: "Run regression tests",
					actions: ["Run the approved regression command"],
					pathScopes: [],
					requiredCapabilities: ["fs.read", "process.exec"],
					acceptance: ["Regression command succeeds"],
				},
			],
		};
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: processDraft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft: processDraft }));
		const ref = f.controller.state.planRef!;
		await f.controller.dispatch(request("run", ref), environment(f.scope));
		const decision = evaluateToolCall({
			state: f.controller.state,
			spec: f.controller.spec,
			grant: f.controller.grant,
			toolName: "bash",
			input: { command: "node --test" },
			toolInfo: builtin("bash"),
			cwd: f.cwd,
		});
		assert.equal(decision.allow, true);
		assert.equal(decision.capability, "process.exec");
		assert.match(decision.reason, /not path-sandboxed|unrestricted built-in process execution/);
	} finally {
		await f.cleanup();
	}
});
