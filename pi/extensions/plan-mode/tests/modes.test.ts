import assert from "node:assert/strict";
import test from "node:test";
import type { ActorChannel } from "../src/domain.ts";
import { baseline, draft, environment, fixture, implementationEnvironment, modelActor, request } from "./helpers.ts";

for (const channel of ["tui", "print", "json", "rpc"] satisfies ActorChannel[]) {
	test(`PM4-P0-014 ${channel} uses the same exact PlanRef implement protocol`, async () => {
		const f = await fixture();
		try {
			const actor = { channel, id: `${channel}-client` } as const;
			const started = await f.controller.dispatch(request("start", undefined, actor), environment(f.scope, { goal: draft.goal, baseline: baseline(f.scope) }));
			assert.equal(started.ok, true);
			await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
			const missing = await f.controller.dispatch(request("implement", undefined, actor), implementationEnvironment(f.scope));
			assert.equal(missing.ok, false);
			assert.equal(missing.error?.code, "PLAN_REF_MISMATCH");
			const ref = f.controller.state.planRef!;
			const running = await f.controller.dispatch(request("implement", ref, actor), implementationEnvironment(f.scope));
			assert.equal(running.ok, true);
			assert.equal(running.state.status, "implementing");
			assert.ok(running.approvalRef);
		} finally {
			await f.cleanup();
		}
	});
}

test("PM4-P0-014 stale version/hash returns a stable machine-readable error", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal, baseline: baseline(f.scope) }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const ref = f.controller.state.planRef!;
		const stale = await f.controller.dispatch(
			request("implement", { ...ref, contentHash: "0".repeat(64) }, { channel: "json", id: "json-client" }),
			implementationEnvironment(f.scope),
		);
		assert.deepEqual(
			{ ok: stale.ok, code: stale.error?.code, retryable: stale.error?.retryable, state: stale.state.status },
			{ ok: false, code: "PLAN_REF_MISMATCH", retryable: false, state: "review" },
		);
	} finally {
		await f.cleanup();
	}
});
