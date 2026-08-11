import assert from "node:assert/strict";
import test from "node:test";
import type { ActorChannel } from "../src/domain.ts";
import { draft, environment, fixture, modelActor, request } from "./helpers.ts";

for (const channel of ["tui", "print", "json", "rpc"] satisfies ActorChannel[]) {
	test(`PM-P0-011 ${channel} uses the same one-action exact PlanRef run protocol`, async () => {
		const f = await fixture();
		try {
			const actor = { channel, id: `${channel}-client` } as const;
			await f.controller.dispatch(request("start", undefined, actor), environment(f.scope, { goal: draft.goal }));
			await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
			const missing = await f.controller.dispatch(request("run", undefined, actor), environment(f.scope));
			assert.equal(missing.ok, false);
			assert.equal(missing.error?.code, "PLAN_REF_MISMATCH");
			const ref = f.controller.state.planRef!;
			const running = await f.controller.dispatch(request("run", ref, actor), environment(f.scope));
			assert.equal(running.ok, true);
			assert.equal(running.state.status, "executing");
			assert.ok(running.approvalRef);
			assert.ok(running.grantRef);
		} finally {
			await f.cleanup();
		}
	});
}

test("PM-P0-011 stale version/hash returns a stable machine-readable error", async () => {
	const f = await fixture();
	try {
		await f.controller.dispatch(request("start"), environment(f.scope, { goal: draft.goal }));
		await f.controller.dispatch(request("submit", undefined, modelActor), environment(f.scope, { draft }));
		const ref = f.controller.state.planRef!;
		const stale = await f.controller.dispatch(
			request("approve", { ...ref, contentHash: "0".repeat(64) }, { channel: "json", id: "json-client" }),
			environment(f.scope),
		);
		assert.deepEqual(
			{ ok: stale.ok, code: stale.error?.code, retryable: stale.error?.retryable, state: stale.state.status },
			{ ok: false, code: "PLAN_REF_MISMATCH", retryable: false, state: "review" },
		);
	} finally {
		await f.cleanup();
	}
});
