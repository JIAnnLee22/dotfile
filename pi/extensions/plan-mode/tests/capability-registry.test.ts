import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityRegistry } from "../src/capability-registry.ts";
import { AGENT_DIR, TOOL_PATHS, builtin, packageTool, testRegistry } from "./helpers.ts";

test("PM4-P0-002 registry verifies source and path, not just name", () => {
	const registry = testRegistry();
	const ok = registry.resolve("ffgrep", packageTool("ffgrep", "npm:@ff-labs/pi-fff", TOOL_PATHS.fff));
	assert.equal(ok.ok, true);
	assert.ok(ok.sourceDigest);

	const wrongSource = registry.resolve("ffgrep", { name: "ffgrep", sourceInfo: { source: "npm:evil", path: `${AGENT_DIR}/npm/node_modules/${TOOL_PATHS.fff}` } });
	assert.equal(wrongSource.ok, false);
	assert.match(wrongSource.reason, /source mismatch/);

	const wrongPath = registry.resolve("ffgrep", packageTool("ffgrep", "npm:@ff-labs/pi-fff", "evil/index.ts"));
	assert.equal(wrongPath.ok, false);
	assert.match(wrongPath.reason, /path mismatch/);

	const missingMetadata = registry.resolve("ffgrep", { name: "ffgrep" });
	assert.equal(missingMetadata.ok, false);
});

test("PM4-P0-002 conflicting entries fail closed", () => {
	const registry = new CapabilityRegistry([
		{ name: "tool", capabilities: ["workspace.read"], source: "npm:a", path: "/agent/a.ts", planning: "always", pathAdapter: "none" },
		{ name: "tool", capabilities: ["process.exec"], source: "npm:b", path: "/agent/b.ts", planning: "never", pathAdapter: "none" },
	]);
	assert.equal(registry.get("tool"), undefined);
	const match = registry.resolve("tool", { name: "tool", sourceInfo: { source: "npm:a", path: "/agent/a.ts" } });
	assert.equal(match.ok, false);
	assert.match(match.reason, /conflict/);
});

test("PM4-P0-002 invalid capability or planning values are rejected with diagnostics", () => {
	const registry = new CapabilityRegistry([
		{ name: "bad", capabilities: ["not-a-capability" as never], source: "npm:x", path: "/agent/x.ts", planning: "always", pathAdapter: "none" },
	]);
	assert.equal(registry.get("bad"), undefined);
	assert.ok(registry.diagnostics.some((diagnostic) => diagnostic.code === "INVALID_ENTRY"));
});

test("PM4-P0-002 planningToolNames excludes never and unknown tools", () => {
	const registry = testRegistry();
	const names = registry.planningToolNames([
		builtin("read"),
		builtin("edit"),
		builtin("bash"),
		packageTool("ffgrep", "npm:@ff-labs/pi-fff", TOOL_PATHS.fff),
		packageTool("ctx_execute", "npm:context-mode", TOOL_PATHS.context),
		{ name: "unknown" },
	]);
	assert.ok(names.includes("read"));
	assert.ok(names.includes("ffgrep"));
	assert.equal(names.includes("edit"), false);
	assert.equal(names.includes("bash"), false);
	assert.equal(names.includes("ctx_execute"), false);
	assert.equal(names.includes("unknown"), false);
});

test("PM4-P0-002 npm source matching tolerates resolved version suffix but keeps path lock", () => {
	const registry = testRegistry();
	const versionedFff = registry.resolve("ffgrep", packageTool("ffgrep", "npm:@ff-labs/pi-fff@0.10.3", TOOL_PATHS.fff));
	assert.equal(versionedFff.ok, true);

	const versionedContext = registry.resolve("ctx_search", packageTool("ctx_search", "npm:context-mode@1.0.169", TOOL_PATHS.context));
	assert.equal(versionedContext.ok, true);

	const wrongPackage = registry.resolve("ffgrep", packageTool("ffgrep", "npm:evil@9.9.9", TOOL_PATHS.fff));
	assert.equal(wrongPackage.ok, false);
	assert.match(wrongPackage.reason, /source mismatch/);

	// 来源放宽容忍版本后缀，但 path 仍必须精确匹配。
	const wrongPath = registry.resolve("ffgrep", packageTool("ffgrep", "npm:@ff-labs/pi-fff@0.10.3", "evil/index.ts"));
	assert.equal(wrongPath.ok, false);
	assert.match(wrongPath.reason, /path mismatch/);
});
