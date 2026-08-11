import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const pi = process.env.PI_BIN || "pi";
const extension = path.resolve(import.meta.dirname, "../index.ts");

function run(args: string[], input?: string) {
	const planHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-runtime-"));
	try {
		return spawnSync(pi, ["--no-session", "-e", extension, ...args], {
			encoding: "utf8",
			input,
			timeout: 30_000,
			env: { ...process.env, PI_PLAN_MODE_HOME: planHome },
		});
	} finally {
		fs.rmSync(planHome, { recursive: true, force: true });
	}
}

function parseJsonLines(stdout: string): unknown[] {
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("PM-P0-001/011 Print loads the extension and emits a stable text action result", () => {
	const result = run(["-p", "/plan status"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "", "Pi reserves Print stdout for assistant text");
	assert.match(result.stderr, /^PLAN_ACTION_OK state=inactive .*security=agent-tools-only/m);
});

test("PM-P0-011 Print startup action consumes its placeholder and writes one control result to stderr", () => {
	const result = run(["-p", "--plan-action", "status", "trigger-plan-action"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "");
	assert.equal((result.stderr.match(/PLAN_ACTION_OK/g) ?? []).length, 1);
});

test("P1-01 Print diff command without a plan returns a stable controller error", () => {
	const result = run(["-p", "/plan diff"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /PLAN_ACTION_ERROR INVALID_STATE/);
});

test("P1-01 JSON diff flags reject a non-integer version", () => {
	const result = run(["--mode", "json", "--plan-action", "diff", "--plan-from-version", "not-a-version", "trigger-plan-action"]);
	assert.equal(result.status, 0, result.stderr);
	const serialized = JSON.stringify(parseJsonLines(result.stdout));
	assert.match(serialized, /PLAN_ACTION_ERROR INVALID_ACTION/);
});

test("PM-P0-011 JSON emits only JSON lines and includes the extension action result", () => {
	const result = run(["--mode", "json", "/plan status"]);
	assert.equal(result.status, 0, result.stderr);
	const events = parseJsonLines(result.stdout);
	assert.ok(events.length > 0);
	assert.match(JSON.stringify(events), /plan-mode\/action-result/);
	assert.match(JSON.stringify(events), /PLAN_ACTION_OK/);
});

test("PM-P0-011 JSON startup flags are emitted after mode subscribers attach", () => {
	const result = run(["--mode", "json", "--plan-action", "status", "trigger-plan-action"]);
	assert.equal(result.status, 0, result.stderr);
	const serialized = JSON.stringify(parseJsonLines(result.stdout));
	assert.ok((serialized.match(/PLAN_ACTION_OK/g) ?? []).length >= 2, serialized);
});

test("PM-P0-011 PM-P0-015 RPC emits action result plus direct-bash boundary warning", () => {
	const result = run(["--mode", "rpc"], `${JSON.stringify({ type: "prompt", message: "/plan status" })}\n`);
	assert.equal(result.status, 0, result.stderr);
	const events = parseJsonLines(result.stdout);
	const serialized = JSON.stringify(events);
	assert.match(serialized, /plan-mode\/action-result/);
	assert.match(serialized, /SAFETY_BOUNDARY_DEGRADED/);
	assert.match(serialized, /agent-tools-only/);
});
