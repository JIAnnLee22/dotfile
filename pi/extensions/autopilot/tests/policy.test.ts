import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { evaluateToolCall, type ToolInfoLike } from "../src/policy.ts";
import type { ExecutionState, MissionSpec } from "../src/domain.ts";
import { entry, environment, fixture, modelActor, request } from "./helpers.ts";

const EXTENSION_SOURCE = path.resolve(import.meta.dirname, "../index.ts");

function builtin(name: string): ToolInfoLike {
	return { name, sourceInfo: { source: "builtin", path: `builtin:${name}` } };
}

function managed(name: string): ToolInfoLike {
	return { name, sourceInfo: { source: "extension", path: EXTENSION_SOURCE } };
}

function readonlyExt(name: string, existingPath: string): ToolInfoLike {
	return { name, sourceInfo: { source: "extension", path: existingPath } };
}

function unknown(name: string): ToolInfoLike {
	return { name, sourceInfo: { source: "extension", path: "/somewhere/else.ts" } };
}

interface Ctx {
	state: ExecutionState;
	spec?: MissionSpec;
	cwd: string;
}

async function runFixture(phase: "drafting" | "dryrun" | "running"): Promise<{ ctx: Ctx; cleanup(): Promise<void> }> {
	const fx = await fixture();
	try {
		await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: fx.draft.goal }));
		if (phase === "drafting") return { ctx: { state: fx.controller.state, spec: fx.controller.spec, cwd: fx.scope.cwd }, cleanup: fx.cleanup };
		await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: fx.draft }));
		if (phase === "dryrun") return { ctx: { state: fx.controller.state, spec: fx.controller.spec, cwd: fx.scope.cwd }, cleanup: fx.cleanup };
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "ready")] }));
		return { ctx: { state: fx.controller.state, spec: fx.controller.spec, cwd: fx.scope.cwd }, cleanup: fx.cleanup };
	} catch (error) {
		await fx.cleanup();
		throw error;
	}
}

const MANAGED = [
	{ name: "autopilot_submit", sourcePath: EXTENSION_SOURCE },
	{ name: "autopilot_report", sourcePath: EXTENSION_SOURCE },
	{ name: "autopilot_blocked", sourcePath: EXTENSION_SOURCE },
];

test("drafting is read-only: no bash, no writes, managed submit only", async () => {
	const { ctx, cleanup } = await runFixture("drafting");
	try {
		const evaluate = (toolName: string, toolInfo: ToolInfoLike, input: unknown) =>
			evaluateToolCall({ ...ctx, toolName, toolInfo, input, readRoots: [ctx.cwd], managedTools: MANAGED });
		assert.equal(evaluate("read", builtin("read"), { path: "src/existing.ts" }).allow, true);
		assert.equal(evaluate("bash", builtin("bash"), { command: "ls" }).allow, false);
		assert.equal(evaluate("edit", builtin("edit"), { path: "src/existing.ts" }).allow, false);
		assert.equal(evaluate("write", builtin("write"), { path: "src/new.ts" }).allow, false);
		assert.equal(evaluate("autopilot_submit", managed("autopilot_submit"), {}).allow, true);
		assert.equal(evaluate("autopilot_report", managed("autopilot_report"), {}).allow, false);
		assert.equal(evaluate("web_search", unknown("web_search"), {}).allow, false);
	} finally {
		await cleanup();
	}
});

test("dryrun allows verification bash but never writes; dangerous commands blocked", async () => {
	const { ctx, cleanup } = await runFixture("dryrun");
	try {
		const evaluate = (toolName: string, toolInfo: ToolInfoLike, input: unknown) =>
			evaluateToolCall({ ...ctx, toolName, toolInfo, input, readRoots: [ctx.cwd], managedTools: MANAGED });
		assert.equal(evaluate("bash", builtin("bash"), { command: "npm test" }).allow, true);
		assert.equal(evaluate("edit", builtin("edit"), { path: "src/existing.ts" }).allow, false);
		assert.equal(evaluate("bash", builtin("bash"), { command: "rm -rf /" }).allow, false);
		assert.equal(evaluate("bash", builtin("bash"), { command: "git push origin main --force" }).allow, false);
		assert.equal(evaluate("bash", builtin("bash"), { command: "dd if=/dev/zero of=/dev/sda" }).allow, false);
		// Safe-looking rm stays allowed.
		assert.equal(evaluate("bash", builtin("bash"), { command: "rm -rf ./dist" }).allow, true);
		assert.equal(evaluate("bash", builtin("bash"), { command: "rm -rf src" }).allow, true);
	} finally {
		await cleanup();
	}
});

test("running grants writes inside cwd only; danger filter can be disabled", async () => {
	const { ctx, cleanup } = await runFixture("running");
	try {
		const evaluate = (toolName: string, toolInfo: ToolInfoLike, input: unknown, dangerFilter = true) =>
			evaluateToolCall({ ...ctx, toolName, toolInfo, input, readRoots: [ctx.cwd], managedTools: MANAGED, dangerFilter });
		assert.equal(evaluate("bash", builtin("bash"), { command: "npm run build" }).allow, true);
		assert.equal(evaluate("edit", builtin("edit"), { path: "src/existing.ts" }).allow, true);
		assert.equal(evaluate("write", builtin("write"), { path: "src/new.ts" }).allow, true);
		assert.equal(
			evaluate(
				"patch",
				{ name: "patch", sourceInfo: { source: "extension", path: path.resolve(import.meta.dirname, "../../patch/index.ts") } },
				{ path: "src/existing.ts", patch: "@@ -1 +1 @@\n-old\n+new\n" },
			).allow,
			true,
		);
		assert.equal(evaluate("patch", unknown("patch"), { path: "src/existing.ts", patch: "..." }).allow, false);
		// Escapes cwd.
		assert.equal(evaluate("write", builtin("write"), { path: "../outside.txt" }).allow, false);
		assert.equal(evaluate("write", builtin("write"), { path: "~/escaped.txt" }).allow, false);
		// Builtin requirement.
		assert.equal(evaluate("edit", managed("autopilot_submit"), { path: "src/existing.ts" }).allow, false);
		// Danger filter opt-out.
		assert.equal(evaluate("bash", builtin("bash"), { command: "rm -rf /" }, false).allow, true);
	} finally {
		await cleanup();
	}
});

test("declared pathScopes restrict writes in running", async () => {
	const fx = await fixture();
	try {
		await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: fx.draft.goal }));
		await fx.controller.dispatch(
			request("submit"),
			environment(fx.scope, {
				draft: { ...fx.draft, pathScopes: ["src/existing.ts"] },
			}),
		);
		await fx.controller.recordToolResult(modelActor, fx.scope, { toolName: "bash", toolCallId: "t1", success: true, summary: "ok" });
		await fx.controller.dispatch(request("report"), environment(fx.scope, { results: [entry("AC1", "ready"), entry("AC2", "ready")] }));
		const ctx = { state: fx.controller.state, spec: fx.controller.spec, cwd: fx.scope.cwd };
		const evaluate = (toolName: string, toolInfo: ToolInfoLike, input: unknown) =>
			evaluateToolCall({ ...ctx, toolName, toolInfo, input, readRoots: [ctx.cwd], managedTools: MANAGED });
		assert.equal(evaluate("edit", builtin("edit"), { path: "src/existing.ts" }).allow, true);
		assert.equal(evaluate("write", builtin("write"), { path: "src/other.ts" }).allow, false);
	} finally {
		await fx.cleanup();
	}
});

test("read-only extension tools (ffgrep/fffind) are allowed when their source path exists", async () => {
	const { ctx, cleanup } = await runFixture("running");
	try {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-autopilot-ext-"));
		try {
			const real = path.join(tmp, "real-tool.ts");
			await fs.writeFile(real, "export {};\n");
			const evaluate = (toolName: string, toolInfo: ToolInfoLike, input: unknown) =>
				evaluateToolCall({ ...ctx, toolName, toolInfo, input, readRoots: [ctx.cwd], managedTools: MANAGED });
			assert.equal(evaluate("ffgrep", readonlyExt("ffgrep", real), { pattern: "x" }).allow, true);
			assert.equal(evaluate("fffind", readonlyExt("fffind", real), { pattern: "x" }).allow, true);
			// Missing source file fails closed.
			assert.equal(evaluate("ffgrep", readonlyExt("ffgrep", path.join(tmp, "missing.ts")), { pattern: "x" }).allow, false);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	} finally {
		await cleanup();
	}
});

test("inactive state allows everything; paused/completed deny all tools", async () => {
	const fx = await fixture();
	try {
		const inactiveCtx = { state: fx.controller.state, spec: undefined, cwd: fx.scope.cwd };
		const evaluateInactive = (toolName: string, toolInfo: ToolInfoLike, input: unknown) =>
			evaluateToolCall({ ...inactiveCtx, toolName, toolInfo, input, readRoots: [fx.scope.cwd], managedTools: MANAGED });
		assert.equal(evaluateInactive("bash", builtin("bash"), { command: "rm -rf /" }).allow, true);
		assert.equal(evaluateInactive("anything", unknown("anything"), {}).allow, true);

		await fx.controller.dispatch(request("start"), environment(fx.scope, { goal: fx.draft.goal }));
		await fx.controller.dispatch(request("submit"), environment(fx.scope, { draft: fx.draft }));
		await fx.controller.dispatch(request("pause"), environment(fx.scope, { reason: "stop" }));
		const pausedCtx = { state: fx.controller.state, spec: fx.controller.spec, cwd: fx.scope.cwd };
		const evaluatePaused = (toolName: string, toolInfo: ToolInfoLike, input: unknown) =>
			evaluateToolCall({ ...pausedCtx, toolName, toolInfo, input, readRoots: [fx.scope.cwd], managedTools: MANAGED });
		assert.equal(evaluatePaused("read", builtin("read"), { path: "src/existing.ts" }).allow, false);
		assert.equal(evaluatePaused("bash", builtin("bash"), { command: "ls" }).allow, false);
		assert.equal(evaluatePaused("edit", builtin("edit"), { path: "src/existing.ts" }).allow, false);
	} finally {
		await fx.cleanup();
	}
});

test("managed tools require the exact extension source path", async () => {
	const { ctx, cleanup } = await runFixture("drafting");
	try {
		const spoofed = { name: "autopilot_submit", sourceInfo: { source: "extension", path: "/evil/elsewhere.ts" } };
		const decision = evaluateToolCall({ ...ctx, toolName: "autopilot_submit", toolInfo: spoofed, input: {}, readRoots: [ctx.cwd], managedTools: MANAGED });
		assert.equal(decision.allow, false);
		assert.match(decision.reason, /source changed/);
	} finally {
		await cleanup();
	}
});
