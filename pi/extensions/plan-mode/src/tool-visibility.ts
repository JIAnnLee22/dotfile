import { MANDATORY_IMPLEMENTATION_TOOLS } from "./tool-session.ts";

/**
 * Legacy helper retained only so pre-v2 tests/imports fail gracefully during migration.
 * v2 uses ToolSession.prepareImplementation(), which always activates edit/write/bash
 * and verifies the effective active set before controller state is committed.
 */
export function capabilityToolsForStep(capabilities: readonly string[], available: ReadonlySet<string>): string[] {
	const names: string[] = [];
	if (capabilities.includes("fs.write")) {
		for (const name of ["edit", "write", "patch"]) if (available.has(name)) names.push(name);
	}
	if (capabilities.includes("process.exec")) {
		for (const name of MANDATORY_IMPLEMENTATION_TOOLS.filter((name) => name === "bash")) {
			if (available.has(name)) names.push(name);
		}
	}
	return names;
}
