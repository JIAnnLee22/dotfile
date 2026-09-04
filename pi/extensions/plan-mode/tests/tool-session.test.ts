import assert from "node:assert/strict";
import test from "node:test";
import type { ToolInfoLike } from "../src/capability-registry.ts";
import { MANDATORY_IMPLEMENTATION_TOOLS, PLAN_MANAGED_TOOLS, ToolSession, type ToolRuntimePort } from "../src/tool-session.ts";
import { AGENT_DIR, TOOL_PATHS, builtin, packageTool, testRegistry } from "./helpers.ts";

class FakePort implements ToolRuntimePort {
	private active: string[];
	private tools: ToolInfoLike[];

	constructor(active: string[], tools: ToolInfoLike[]) {
		this.active = active;
		this.tools = tools;
	}
	getActiveTools(): string[] {
		return [...this.active];
	}
	getAllTools(): ToolInfoLike[] {
		return this.tools;
	}
	setActiveTools(names: string[]): void {
		const registered = new Set(this.tools.map((tool) => tool.name));
		this.active = [...new Set(names.filter((name) => registered.has(name)))];
	}
}

function tools(): ToolInfoLike[] {
	return [
		builtin("read"),
		builtin("grep"),
		builtin("find"),
		builtin("ls"),
		builtin("edit"),
		builtin("write"),
		builtin("bash"),
		builtin("powershell"),
		packageTool("ffgrep", "npm:@ff-labs/pi-fff", TOOL_PATHS.fff),
		packageTool("ctx_search", "npm:context-mode", TOOL_PATHS.context),
		...PLAN_MANAGED_TOOLS.map((name) => ({ name, sourceInfo: { source: "extension", path: "/agent/plan-mode/index.ts" } })),
	];
}

const baseline = {
	schema: "dev.pi.plan-tool-baseline/v2" as const,
	baselineId: "b1",
	planId: "p1",
	toolNames: ["read", "bash", "edit", "write", "ffgrep"],
	capturedAt: "2026-09-03T00:00:00.000Z",
	sessionId: "s",
	branchEntryId: "l",
};

test("PM4-P0-002 applyPlanning exposes only verified research and managed tools", () => {
	const port = new FakePort(["read", "bash", "edit", "write"], tools());
	const session = new ToolSession(port, testRegistry());
	const result = session.applyPlanning(PLAN_MANAGED_TOOLS);
	assert.equal(result.ok, true);
	assert.ok(result.active.includes("read"));
	assert.ok(result.active.includes("ffgrep"));
	assert.ok(result.active.includes("ctx_search"));
	assert.ok(result.active.includes("plan_submit"));
	assert.equal(result.active.includes("edit"), false);
	assert.equal(result.active.includes("write"), false);
	assert.equal(result.active.includes("bash"), false);
});

test("PM4-P0-006 prepareImplementation readback is mandatory and rolls back on failure", () => {
	const all = tools();
	const port = new FakePort(["read"], all);
	const session = new ToolSession(port, testRegistry());
	const result = session.prepareImplementation(baseline);
	assert.equal(result.ok, true);
	assert.deepEqual([...result.active].filter((name) => MANDATORY_IMPLEMENTATION_TOOLS.includes(name as (typeof MANDATORY_IMPLEMENTATION_TOOLS)[number])).sort(), ["bash", "edit", "write"]);

	// A port that silently ignores a mandatory tool must fail closed and roll back.
	const broken = new FakePort(["read"], all);
	broken.setActiveTools = (names: string[]) => {
		broken.active = [...new Set(names.filter((name) => name !== "bash"))];
	};
	const brokenSession = new ToolSession(broken, testRegistry());
	const failed = brokenSession.prepareImplementation(baseline);
	assert.equal(failed.ok, false);
	assert.ok(failed.missing.includes("bash"));
	assert.equal(broken.getActiveTools().includes("edit"), false, "rollback must restore planning-safe tools");
});

test("PM4-P0-006 mandatory tools must be builtin source, not overridden", () => {
	const overridden = tools().map((tool) => (tool.name === "edit" ? { name: "edit", sourceInfo: { source: "extension", path: "/agent/evil/edit.ts" } } : tool));
	const port = new FakePort(["read"], overridden);
	const session = new ToolSession(port, testRegistry());
	const result = session.prepareImplementation(baseline);
	assert.equal(result.ok, false);
	assert.ok(result.missing.includes("edit"));
	assert.match(result.reason ?? "", /overridden/);
});

test("PM4-P0-010 restoreBaseline intersects with the current registry", () => {
	const port = new FakePort(["edit", "write", "bash"], tools());
	const session = new ToolSession(port, testRegistry());
	const restored = session.restoreBaseline(baseline);
	assert.equal(restored.ok, true);
	assert.deepEqual(restored.active, ["read", "bash", "edit", "write", "ffgrep"]);
	const narrowed = session.restoreBaseline({ ...baseline, toolNames: ["read", "bash", "gone-tool"] });
	assert.equal(narrowed.ok, true, "registered subset activates");
	assert.ok(narrowed.missing.includes("gone-tool"), "unregistered tool reported");
	assert.equal(narrowed.active.includes("gone-tool"), false);
});
