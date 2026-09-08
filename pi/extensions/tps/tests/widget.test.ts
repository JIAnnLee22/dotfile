import * as assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { registerTpsWidget } from "../src/widget.ts";
import { createTpsReporter } from "../../parallel-tasks/tps-stream.ts";

function setup(t: TestContext, mode = "tui") {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
	const handlers = new Map<string, Function>();
	const listeners = new Map<string, Function>();
	let renders = 0;
	let widget: any;
	const ctx = {
		mode, hasUI: mode === "tui" || mode === "rpc",
		ui: { setWidget(_key: string, factory: Function) {
			widget = factory({ requestRender: () => renders++ }, { fg: (_color: string, text: string) => text });
		} },
	};
	const pi: any = {
		on: (name: string, handler: Function) => handlers.set(name, handler),
		events: { on: (name: string, handler: Function) => {
			listeners.set(name, handler);
			return () => listeners.delete(name);
		} },
	};
	registerTpsWidget(pi, (s) => s);
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	emit("session_start");
	t.after(() => emit("session_shutdown"));
	return {
		emit,
		stream: (e: unknown) => listeners.get("tps:stream")?.(e),
		delta: (type: string, delta = "") => emit("message_update", {
			message: { role: "assistant" }, assistantMessageEvent: { type, delta },
		}),
		end: (output: number) => emit("message_end", { message: { role: "assistant", usage: { output } } }),
		advance: (ms = 1000) => t.mock.timers.tick(ms),
		line: () => widget?.render(200)[0],
		dispose: () => widget?.dispose(),
		renders: () => renders,
	};
}

test("TPS 每秒才计算并发布快照，delta 与外部 render 不绕过节流", (t) => {
	const h = setup(t);
	h.emit("turn_start", { turnIndex: 0 });
	for (let i = 0; i < 100; i++) h.delta("text_delta", "abcd");
	assert.equal(h.renders(), 0);
	assert.equal(h.line(), "— · 输出 —");
	h.advance(999);
	assert.equal(h.line(), "— · 输出 —");
	h.advance(1);
	assert.equal(h.line(), "第 1 轮 · 输出中 ~100 t/s");
	assert.equal(h.renders(), 1);
	h.delta("text_delta", "abcd");
	assert.equal(h.line(), "第 1 轮 · 输出中 ~100 t/s");
	h.advance();
	assert.match(h.line(), /~1\.0 t\/s$/);
	h.advance();
	assert.match(h.line(), /~0\.0 t\/s$/);
});

test("两个同名子任务合计一个 TPS，交错事件不切换来源", (t) => {
	const h = setup(t);
	const a = createTpsReporter("重复标签", h.stream);
	const b = createTpsReporter("重复标签", h.stream);
	a.update({ type: "thinking_delta", delta: "a".repeat(80) });
	b.update({ type: "text_delta", delta: "b".repeat(120) });
	assert.equal(h.renders(), 0);
	h.advance();
	assert.equal(h.line(), "— · 合计（2 子任务） · 思考/输出中 ~50.0 t/s");
	a.update({ type: "text_delta", delta: "abcd" });
	assert.equal(h.line(), "— · 合计（2 子任务） · 思考/输出中 ~50.0 t/s");
	a.end(30);
	b.update({ type: "text_delta", delta: "b".repeat(36) });
	h.advance();
	assert.match(h.line(), /合计（2 子任务） · 输出中 ~10\.0 t\/s$/);
	b.end(40);
	h.advance();
	assert.match(h.line(), /合计（2 子任务） · 输出 70 tok$/);
	const renders = h.renders();
	h.advance(5000);
	assert.equal(h.renders(), renders, "静止后不重复 requestRender");
});

test("主会话与子任务共用窗口，思考转正文不丢本秒增量", (t) => {
	const h = setup(t);
	h.delta("thinking_delta", "abcd");
	h.delta("text_delta", "abcd");
	h.stream({ id: "child", bytesDelta: 32, phase: "output" });
	h.advance();
	assert.match(h.line(), /~10\.0 t\/s$/);
	h.end(15);
	h.stream({ id: "child", bytesDelta: 20 });
	h.advance();
	assert.match(h.line(), /输出中 ~5\.0 t\/s$/);
	h.stream({ id: "child", ended: true, tokens: 20 });
	h.advance();
	assert.match(h.line(), /输出 35 tok$/);
});

test("子任务停流下一秒归零，异常退出不残留活动速率", (t) => {
	const h = setup(t);
	const reporter = createTpsReporter("crash", h.stream);
	reporter.update({ type: "text_delta", delta: "abcd" });
	h.advance();
	assert.match(h.line(), /~1\.0 t\/s$/);
	h.advance();
	assert.match(h.line(), /~0\.0 t\/s$/);
	reporter.close();
	h.advance();
	assert.match(h.line(), /输出 1 tok$/);
	reporter.update({ type: "text_delta", delta: "ignored" });
	h.advance();
	assert.match(h.line(), /输出 1 tok$/);
});

test("结束状态也在下一 tick 发布，下一轮移除已完成子任务", (t) => {
	const h = setup(t);
	h.stream({ id: "old", ended: true, tokens: 20 });
	h.advance();
	assert.match(h.line(), /输出 20 tok$/);
	h.emit("turn_start", { turnIndex: 1 });
	h.delta("text_delta", "abcd");
	h.advance();
	assert.equal(h.line(), "第 2 轮 · 输出中 ~1.0 t/s");
	h.end(123);
	assert.match(h.line(), /t\/s$/);
	h.advance();
	assert.equal(h.line(), "第 2 轮 · 输出 123 tok");
});

test("无效数值不污染合计；旧速率协议可聚合并过期", (t) => {
	const h = setup(t);
	h.stream(null);
	h.stream({ id: "bad", bytesDelta: NaN, tps: Infinity, tokens: -1 });
	h.stream({ label: "A", tps: 10 });
	h.stream({ label: "B", tps: 20 });
	h.advance();
	assert.match(h.line(), /~30\.0 t\/s$/);
	h.advance();
	assert.match(h.line(), /~0\.0 t\/s$/);
});

test("dispose/shutdown 清理定时器与订阅，session_start 重置显示", (t) => {
	const h = setup(t);
	h.delta("text_delta", "abcd");
	h.advance();
	h.dispose();
	const renders = h.renders();
	h.advance(3000);
	assert.equal(h.renders(), renders);
	h.emit("session_start");
	assert.equal(h.line(), "— · 输出 —");
	h.delta("text_delta", "abcd");
	h.advance();
	assert.match(h.line(), /~1\.0 t\/s$/);
	h.emit("session_shutdown");
	h.stream({ id: "late", bytesDelta: 400 });
	const stopped = h.renders();
	h.advance(3000);
	assert.equal(h.renders(), stopped);
});

for (const mode of ["rpc", "json", "print"]) {
	test(`${mode} 不创建 TUI widget 或刷新定时器`, (t) => {
		const h = setup(t, mode);
		h.delta("text_delta", "abcd");
		h.advance(5000);
		assert.equal(h.line(), undefined);
		assert.equal(h.renders(), 0);
	});
}

test("快速续轮仅发布最新状态；旧轮已收到的字节仍计入本秒速率", (t) => {
	const h = setup(t);
	h.delta("text_delta", "abcd");
	h.end(10);
	h.emit("turn_start", { turnIndex: 1 });
	h.delta("text_delta", "abcd");
	h.advance();
	assert.equal(h.line(), "第 2 轮 · 输出中 ~2.0 t/s");
});

test("无 usage 时主会话累计思考及正文；新响应重置估算", (t) => {
	const h = setup(t);
	h.delta("thinking_delta", "abcd");
	h.delta("text_delta", "abcd");
	h.emit("message_end", { message: { role: "assistant" } });
	h.advance();
	assert.match(h.line(), /输出 2 tok$/);
	h.emit("message_start", { message: { role: "assistant" } });
	h.delta("text_delta", "abcd");
	h.emit("message_end", { message: { role: "assistant" } });
	h.advance();
	assert.match(h.line(), /输出 1 tok$/);
});

test("reporter 纯工具调用响应也累计权威 tokens", () => {
	const events: any[] = [];
	const reporter = createTpsReporter("tools", (e) => events.push(e));
	reporter.start();
	reporter.update({ type: "toolcall_delta", delta: "{}" });
	reporter.end(20);
	reporter.end(20);
	reporter.start();
	reporter.end(30);
	reporter.close();
	assert.deepEqual(events.map((e) => e.tokens), [20, 50]);
	assert.ok(events.every((e) => e.ended));
});

test("reporter 唯一身份、UTF-8 增量、多轮累计与幂等终止", () => {
	const events: any[] = [];
	const reporter = createTpsReporter("same", (e) => events.push(e));
	reporter.update({ type: "thinking_start" });
	reporter.update({ type: "thinking_delta", delta: "中文" });
	reporter.update({ type: "text_delta", delta: "abcd" });
	assert.deepEqual(events.map((e) => e.bytesDelta), [0, 6, 4]);
	assert.ok(events.every((e) => e.tps === undefined));
	reporter.end(100);
	reporter.end(100);
	assert.equal(events.length, 4);
	reporter.update({ type: "text_delta", delta: "abcd" });
	reporter.close();
	reporter.close();
	assert.equal(events.at(-1).tokens, 101);
	assert.equal(events.at(-1).ended, true);
	assert.equal(new Set(events.map((e) => e.id)).size, 1);
	const other = createTpsReporter("same", (e) => assert.notEqual(e.id, events[0].id));
	other.update({ type: "text_delta", delta: "abcd" });
});
