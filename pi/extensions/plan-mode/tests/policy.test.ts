import assert from "node:assert/strict";
import test from "node:test";
import { evaluateToolCall } from "../src/policy.ts";
import { ORCHESTRATOR_MANAGED_TOOLS, PLAN_MANAGED_TOOLS } from "../src/tool-session.ts";
import { CapabilityRegistry, defaultRegistryEntries } from "../src/capability-registry.ts";
import type { ResearchPermissionRecord } from "../src/domain.ts";
import {
	AGENT_DIR,
	TOOL_PATHS,
	builtin,
	environment,
	fixture,
	implementationEnvironment,
	modelActor,
	packageTool,
	prepareReview,
	request,
	start,
	testRegistry,
} from "./helpers.ts";

const MANAGED = [...PLAN_MANAGED_TOOLS, ...ORCHESTRATOR_MANAGED_TOOLS].map((name) => ({ name, sourcePath: "/trusted/plan-mode.ts" }));
const MANAGED_INFO = { sourceInfo: { source: "extension", path: "/trusted/plan-mode.ts" } };

function evaluate(controller: any, f: any, overrides: Record<string, unknown>) {
	return evaluateToolCall({
		state: controller.state,
		registry: testRegistry(),
		permissions: controller.researchPermissions,
		toolName: "read",
		input: {},
		toolInfo: builtin("read"),
		cwd: f.cwd,
		readRoots: [f.cwd],
		managedTools: MANAGED,
		...overrides,
	});
}

test("PM4-P0-002 planning allows verified builtin reads inside configured roots", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		const ok = evaluate(f.controller, f, {
			toolName: "read",
			input: { path: "src/existing.ts" },
			toolInfo: builtin("read"),
		});
		assert.equal(ok.allow, true);
		const escape = evaluate(f.controller, f, {
			toolName: "read",
			input: { path: "../outside" },
			toolInfo: builtin("read"),
		});
		assert.equal(escape.allow, false);
		const overridden = evaluate(f.controller, f, {
			toolName: "read",
			input: { path: "src/existing.ts" },
			toolInfo: { name: "read", sourceInfo: { source: "extension", path: "/tmp/override.ts" } },
		});
		assert.equal(overridden.allow, false);
		assert.match(overridden.reason, /source mismatch/);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-002 planning denies write/process builtins and unknown tools", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		for (const toolName of ["edit", "write", "bash", "powershell", "unknown_tool"]) {
			const result = evaluate(f.controller, f, { toolName, toolInfo: builtin(toolName) });
			assert.equal(result.allow, false, toolName);
		}
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-002 verified package tools are allowed only with matching source and path", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		const ffgrep = evaluate(f.controller, f, {
			toolName: "ffgrep",
			toolInfo: packageTool("ffgrep", "npm:@ff-labs/pi-fff", TOOL_PATHS.fff),
		});
		assert.equal(ffgrep.allow, true);
		const mismatched = evaluate(f.controller, f, {
			toolName: "ffgrep",
			toolInfo: { name: "ffgrep", sourceInfo: { source: "npm:@ff-labs/pi-fff", path: "/agent/npm/node_modules/evil/index.ts" } },
		});
		assert.equal(mismatched.allow, false);
		assert.match(mismatched.reason, /path mismatch/);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-002 context-mode execute series is denied during planning", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		for (const toolName of ["ctx_execute", "ctx_execute_file", "ctx_batch_execute", "ctx_upgrade", "ctx_purge", "ctx_insight"]) {
			const result = evaluate(f.controller, f, {
				toolName,
				toolInfo: packageTool(toolName, "npm:context-mode", TOOL_PATHS.context),
			});
			assert.equal(result.allow, false, toolName);
		}
		const search = evaluate(f.controller, f, {
			toolName: "ctx_search",
			toolInfo: packageTool("ctx_search", "npm:context-mode", TOOL_PATHS.context),
		});
		assert.equal(search.allow, true);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-003 network read requires one plan-scoped permission", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		const toolInfo = packageTool("web_search", "npm:pi-web-access", TOOL_PATHS.web);
		const unpermitted = evaluate(f.controller, f, { toolName: "web_search", toolInfo });
		assert.equal(unpermitted.allow, false);
		assert.equal(unpermitted.permissionRequired, true);
		assert.ok(unpermitted.sourceDigest);

		const record: ResearchPermissionRecord = {
			schema: "dev.pi.plan-research-permission/v2",
			permissionId: "perm-1",
			planId: f.controller.state.planId!,
			toolName: "web_search",
			capabilities: ["network.read"],
			sourceDigest: unpermitted.sourceDigest!,
			decision: "allow",
			subject: { channel: "tui", id: "tester" },
			decidedAt: "2026-09-03T00:00:00.000Z",
			sessionId: f.scope.sessionId,
			branchEntryId: f.scope.branchLeafId,
		};
		const key = `${record.planId}\u0000${record.toolName}\u0000${record.sourceDigest}`;
		const allowed = evaluateToolCall({
			state: f.controller.state,
			registry: testRegistry(),
			permissions: new Map([[key, record]]),
			toolName: "web_search",
			input: {},
			toolInfo,
			cwd: f.cwd,
			readRoots: [f.cwd],
			managedTools: MANAGED,
		});
		assert.equal(allowed.allow, true);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-007 implementing state uses normal Pi permissions", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		for (const toolName of ["edit", "write", "bash", "ffgrep", "ctx_execute"]) {
			const result = evaluate(f.controller, f, { toolName, toolInfo: builtin(toolName) });
			assert.equal(result.allow, true, toolName);
		}
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0 managed tools require exact source and correct state", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		const submit = evaluate(f.controller, f, {
			toolName: "plan_submit",
			toolInfo: { name: "plan_submit", ...MANAGED_INFO },
		});
		assert.equal(submit.allow, true);
		const forged = evaluate(f.controller, f, {
			toolName: "plan_submit",
			toolInfo: { name: "plan_submit", sourceInfo: { source: "extension", path: "/evil/plan-mode.ts" } },
		});
		assert.equal(forged.allow, false);
		const completeWhilePlanning = evaluate(f.controller, f, {
			toolName: "plan_step_complete",
			toolInfo: { name: "plan_step_complete", ...MANAGED_INFO },
		});
		assert.equal(completeWhilePlanning.allow, false);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-008 orchestrator managed tools are allowed only while implementing", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		const dispatchPlanning = evaluate(f.controller, f, {
			toolName: "plan_dispatch_step",
			toolInfo: { name: "plan_dispatch_step", ...MANAGED_INFO },
		});
		assert.equal(dispatchPlanning.allow, false);
		const applyPlanning = evaluate(f.controller, f, {
			toolName: "plan_apply_diff",
			toolInfo: { name: "plan_apply_diff", ...MANAGED_INFO },
		});
		assert.equal(applyPlanning.allow, false);

		const ref = await prepareReview(f.controller, f.scope);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		const dispatchImplementing = evaluate(f.controller, f, {
			toolName: "plan_dispatch_step",
			toolInfo: { name: "plan_dispatch_step", ...MANAGED_INFO },
		});
		assert.equal(dispatchImplementing.allow, true);
		const applyImplementing = evaluate(f.controller, f, {
			toolName: "plan_apply_diff",
			toolInfo: { name: "plan_apply_diff", ...MANAGED_INFO },
		});
		assert.equal(applyImplementing.allow, true);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-007 orchestrator implementing denies mutation tools and allows dispatch", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		await f.controller.dispatch(request("implement", ref), implementationEnvironment(f.scope));
		const registry = new CapabilityRegistry([
			...defaultRegistryEntries(AGENT_DIR),
			{
				name: "parallel_tasks",
				capabilities: ["workspace.read"],
				source: "local",
				path: "/agent/extensions/parallel-tasks/index.ts",
				planning: "always",
				pathAdapter: "none",
			},
		]);
		const orchestratorEvaluate = (overrides: Record<string, unknown>) =>
			evaluateToolCall({
				state: f.controller.state,
				registry,
				permissions: f.controller.researchPermissions,
				toolName: "read",
				input: {},
				toolInfo: builtin("read"),
				cwd: f.cwd,
				readRoots: [f.cwd],
				managedTools: MANAGED,
				orchestrator: true,
				...overrides,
			});

		for (const toolName of ["edit", "write", "bash", "powershell", "ctx_execute"]) {
			const result = orchestratorEvaluate({ toolName, toolInfo: builtin(toolName) });
			assert.equal(result.allow, false, toolName);
		}

		const dispatch = orchestratorEvaluate({
			toolName: "parallel_tasks",
			input: { tasks: [{ role: "implementer", task: "code" }] },
			toolInfo: { name: "parallel_tasks", sourceInfo: { source: "local", path: "/agent/extensions/parallel-tasks/index.ts" } },
		});
		assert.equal(dispatch.allow, true);

		const read = orchestratorEvaluate({ toolName: "read", input: { path: "src/existing.ts" }, toolInfo: builtin("read") });
		assert.equal(read.allow, true);

		const indexWrite = orchestratorEvaluate({
			toolName: "ctx_index",
			input: { path: "src/existing.ts" },
			toolInfo: packageTool("ctx_index", "npm:context-mode", TOOL_PATHS.context),
		});
		assert.equal(indexWrite.allow, false);
		assert.match(indexWrite.reason, /non-read orchestrator capabilities/);
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-006 model actor can submit but not implement", async () => {
	const f = await fixture();
	try {
		const ref = await prepareReview(f.controller, f.scope);
		const rejected = await f.controller.dispatch(request("implement", ref, modelActor), implementationEnvironment(f.scope));
		assert.equal(rejected.ok, false);
		assert.equal(rejected.error?.code, "APPROVAL_REQUIRED");
	} finally {
		await f.cleanup();
	}
});

test("PM4-P0-002 planning dispatch of parallel_tasks allows only read-only roles", async () => {
	const f = await fixture();
	try {
		await start(f.controller, f.scope);
		const registry = new CapabilityRegistry([
			...defaultRegistryEntries(AGENT_DIR),
			{
				name: "parallel_tasks",
				capabilities: ["workspace.read"],
				source: "local",
				path: "/agent/extensions/parallel-tasks/index.ts",
				planning: "always",
				pathAdapter: "none",
			},
		]);
		const info = { name: "parallel_tasks", sourceInfo: { source: "local", path: "/agent/extensions/parallel-tasks/index.ts" } };
		const evaluateDispatch = (tasks: unknown) =>
			evaluateToolCall({
				state: f.controller.state,
				registry,
				permissions: f.controller.researchPermissions,
				toolName: "parallel_tasks",
				input: { tasks },
				toolInfo: info,
				cwd: f.cwd,
				readRoots: [f.cwd],
				managedTools: MANAGED,
			});

		const readOnly = evaluateDispatch([{ role: "probe", task: "locate" }, { role: "analyst", task: "analyze" }]);
		assert.equal(readOnly.allow, true);

		const implementer = evaluateDispatch([{ role: "implementer", task: "code" }]);
		assert.equal(implementer.allow, false);
		assert.match(implementer.reason, /read-only roles/);

		const unknown = evaluateDispatch([{ role: "mystery", task: "unknown" }]);
		assert.equal(unknown.allow, false);

		const empty = evaluateDispatch([]);
		assert.equal(empty.allow, false);
	} finally {
		await f.cleanup();
	}
});
