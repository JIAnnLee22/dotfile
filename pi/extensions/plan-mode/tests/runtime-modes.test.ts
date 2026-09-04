import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

async function runRpcBarePlan(goal: string) {
	const planHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-runtime-"));
	try {
		const child = spawn(pi, ["--no-session", "-e", extension, "--mode", "rpc"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_PLAN_MODE_HOME: planHome },
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let stdout = "";
		let stderr = "";
		let pending = "";
		let answeredInput = false;
		let inputRequestTitle: string | undefined;
		let planningResultSeen = false;
		let goalTurnSeen = false;
		const result = await new Promise<{ status: number | null; stdout: string; stderr: string; answeredInput: boolean; inputRequestTitle?: string }>(
			(resolve, reject) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`RPC bare /plan timed out\nstdout=${stdout}\nstderr=${stderr}`));
				}, 30_000);
				child.stderr.on("data", (chunk: string) => {
					stderr += chunk;
				});
				child.stdout.on("data", (chunk: string) => {
					stdout += chunk;
					pending += chunk;
					for (;;) {
						const newline = pending.indexOf("\n");
						if (newline < 0) break;
						const line = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						if (!line) continue;
						const event = JSON.parse(line) as { type?: string; id?: string; method?: string; title?: string };
						if (event.type === "extension_ui_request" && event.method === "input" && event.id) {
							answeredInput = true;
							inputRequestTitle = event.title;
							child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, value: goal })}\n`);
						}
						if (line.includes("PLAN_ACTION_OK state=planning")) planningResultSeen = true;
						if (line.includes(goal) || line.includes('"event":"send_user_message"')) goalTurnSeen = true;
						if (planningResultSeen && goalTurnSeen && !child.stdin.destroyed) {
							child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
							child.stdin.end();
						}
					}
				});
				child.on("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.on("close", (status) => {
					clearTimeout(timer);
					resolve({ status, stdout, stderr, answeredInput, inputRequestTitle });
				});
				child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/plan" })}\n`);
			},
		);
		return result;
	} finally {
		fs.rmSync(planHome, { recursive: true, force: true });
	}
}

test("PM4-P0-014 Print loads the extension and emits a stable text action result", () => {
	const result = run(["-p", "/plan status"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "", "Pi reserves Print stdout for assistant text");
	assert.match(result.stderr, /^PLAN_ACTION_OK state=inactive .*security=agent-tools-only/m);
});

test("PM4-P0-014 Print bare /plan fails clearly when no interactive goal input is available", () => {
	const result = run(["-p", "/plan"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /PLAN_ACTION_ERROR UI_REQUIRED/);
	assert.match(result.stderr, /use \/plan <goal>/);
});

test("PM4-P0-001 Print /plan <goal> enters planning without an interactive prompt", () => {
	const result = run(["-p", "/plan inspect the plan command UX"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /^PLAN_ACTION_OK state=planning /m);
});

test("PM4-P0-001/014 RPC bare /plan requests a goal, enters planning, and triggers the goal turn", async () => {
	const goal = "inspect the plan command UX";
	const result = await runRpcBarePlan(goal);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.answeredInput, true);
	assert.equal(result.inputRequestTitle, "Plan goal");
	const serialized = JSON.stringify(parseJsonLines(result.stdout));
	assert.match(serialized, /PLAN_ACTION_OK state=planning/);
	assert.match(
		serialized,
		new RegExp(`${goal}|send_user_message`),
		"the entered goal must be sent, or attempted when the test runtime has no model credentials",
	);
});

test("PM4-P0-014 Print startup action consumes its placeholder and writes one control result to stderr", () => {
	const result = run(["-p", "--plan-action", "status", "trigger-plan-action"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "");
	assert.equal((result.stderr.match(/PLAN_ACTION_OK/g) ?? []).length, 1);
});

test("PM4-P0-014 Print diff command without a plan returns a stable controller error", () => {
	const result = run(["-p", "/plan diff"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /PLAN_ACTION_ERROR INVALID_STATE/);
});

test("PM4-P0-014 JSON diff flags reject a non-integer version", () => {
	const result = run(["--mode", "json", "--plan-action", "diff", "--plan-from-version", "not-a-version", "trigger-plan-action"]);
	assert.equal(result.status, 0, result.stderr);
	const serialized = JSON.stringify(parseJsonLines(result.stdout));
	assert.match(serialized, /PLAN_ACTION_ERROR INVALID_ACTION/);
});

test("PM4-P0-014 JSON emits only JSON lines and includes the extension action result", () => {
	const result = run(["--mode", "json", "/plan status"]);
	assert.equal(result.status, 0, result.stderr);
	const events = parseJsonLines(result.stdout);
	assert.ok(events.length > 0);
	assert.match(JSON.stringify(events), /plan-mode\/action-result-v2/);
	assert.match(JSON.stringify(events), /PLAN_ACTION_OK/);
});

test("PM4-P0-014 JSON startup flags are emitted after mode subscribers attach", () => {
	const result = run(["--mode", "json", "--plan-action", "status", "trigger-plan-action"]);
	assert.equal(result.status, 0, result.stderr);
	const serialized = JSON.stringify(parseJsonLines(result.stdout));
	assert.ok((serialized.match(/PLAN_ACTION_OK/g) ?? []).length >= 2, serialized);
});

test("PM4-P0-016 RPC emits action result plus direct-bash boundary warning", () => {
	const result = run(["--mode", "rpc"], `${JSON.stringify({ type: "prompt", message: "/plan status" })}\n`);
	assert.equal(result.status, 0, result.stderr);
	const events = parseJsonLines(result.stdout);
	const serialized = JSON.stringify(events);
	assert.match(serialized, /plan-mode\/action-result-v2/);
	assert.match(serialized, /SAFETY_BOUNDARY_DEGRADED/);
	assert.match(serialized, /agent-tools-only/);
});
