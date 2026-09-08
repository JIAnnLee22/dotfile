import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens, formatTokens, formatTokensPerSecond, instantTokensPerSecond } from "./meter.ts";
import type { TpsPhase, TpsStreamEvent } from "./stream.ts";

export const TICK_MS = 1000;

type Stream = {
	phase: TpsPhase | "idle" | "done";
	bytes: number;
	tokens: number;
	legacyTps: number;
	updatedAt: number;
};
const freshStream = (): Stream => ({ phase: "idle", bytes: 0, tokens: 0, legacyTps: 0, updatedAt: 0 });
const active = (s: Stream) => s.phase === "thinking" || s.phase === "output";
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** 事件只累计数据；计量、显示快照及 requestRender 均仅在 tick 更新。 */
export function registerTpsWidget(
	pi: ExtensionAPI,
	truncate: (text: string, width: number, ellipsis?: string) => string,
) {
	let turn = 0;
	let main = freshStream();
	const children = new Map<string, Stream>();
	let pendingBytes = 0;
	let lastTick = 0;
	// render 使用冻结的文本，避免被 Pi 其他高频重绘间接刷新。
	let line = "— · 输出 —";
	let timer: ReturnType<typeof setInterval> | undefined;
	let requestRender: (() => void) | undefined;

	const stop = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		requestRender = undefined;
	};

	const tick = () => {
		const now = Date.now();
		const elapsed = now - lastTick;
		if (elapsed < TICK_MS) return;
		let tps = instantTokensPerSecond(pendingBytes, elapsed);
		pendingBytes = 0;
		lastTick = now;
		const streams = [...children.values()];
		const live = [...streams, main].filter(active);
		// 旧协议没有增量，最多保留一个采样周期，避免停止上报后残留速率。
		for (const s of streams) {
			if (active(s) && now - s.updatedAt <= TICK_MS) tps += s.legacyTps;
		}
		const prefix = `${turn > 0 ? `第 ${turn} 轮` : "—"}${children.size ? ` · 合计（${children.size} 子任务）` : ""}`;
		let next: string;
		if (live.length) {
			const thinking = live.some((s) => s.phase === "thinking");
			const output = live.some((s) => s.phase === "output");
			const phase = thinking && output ? "思考/输出中" : thinking ? "思考中" : "输出中";
			next = `${prefix} · ${phase} ~${tps > 0 ? formatTokensPerSecond(tps) : "0.0 t/s"}`;
		} else if (children.size || main.phase === "done") {
			const tokens = streams.reduce((sum, s) => sum + s.tokens, main.tokens);
			next = `${prefix} · 输出 ${formatTokens(tokens)} tok`;
		} else {
			next = `${prefix} · 输出 —`;
		}
		if (next !== line) {
			line = next;
			requestRender?.();
		}
	};

	pi.on("turn_start", (event) => {
		turn = event.turnIndex + 1;
		main = freshStream();
		for (const [id, s] of children) if (!active(s)) children.delete(id);
	});

	pi.on("message_start", (event) => {
		if (event.message?.role === "assistant") main = freshStream();
	});

	pi.on("message_update", (event) => {
		if (event.message?.role !== "assistant") return;
		const e = event.assistantMessageEvent;
		if (!e) return;
		let phase: TpsPhase;
		if (e.type === "thinking_start" || e.type === "thinking_delta") phase = "thinking";
		else if (e.type === "text_delta") phase = "output";
		else return;
		main.phase = phase;
		if ((e.type === "text_delta" || e.type === "thinking_delta") && typeof e.delta === "string") {
			const bytes = Buffer.byteLength(e.delta, "utf8");
			main.bytes += bytes;
			pendingBytes += bytes;
		}
	});

	pi.on("message_end", (event) => {
		const msg = event.message;
		if (msg?.role !== "assistant") return;
		const usage = msg.usage as { output?: number; reasoning?: number } | undefined;
		// Pi usage.output 为生成总量；reasoning 仅作为非标准 provider 的回退。
		const tokens = nonnegative(usage?.output) && usage.output > 0 ? usage.output : usage?.reasoning;
		main.tokens = nonnegative(tokens) && tokens > 0 ? tokens : Math.round(estimateTokens(main.bytes));
		main.phase = "done";
	});

	const unsubscribe = pi.events.on("tps:stream", (data: unknown) => {
		if (!data || typeof data !== "object") return;
		const e = data as TpsStreamEvent;
		const id = typeof e.id === "string" && e.id ? e.id : `legacy:${e.label || "子任务"}`;
		let s = children.get(id);
		if (!s) {
			s = freshStream();
			children.set(id, s);
		}
		if (nonnegative(e.bytesDelta)) pendingBytes += e.bytesDelta;
		if (nonnegative(e.tokens)) s.tokens = e.tokens;
		s.phase = e.ended ? "done" : e.phase === "thinking" ? "thinking" : "output";
		s.legacyTps = !e.ended && e.bytesDelta === undefined && nonnegative(e.tps) ? e.tps : 0;
		s.updatedAt = Date.now();
	});

	pi.on("session_start", (_event, ctx) => {
		stop();
		turn = 0;
		main = freshStream();
		children.clear();
		pendingBytes = 0;
		line = "— · 输出 —";
		// RPC 不执行组件 factory；仅 TUI 创建定时器。
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("tps", (tui, theme) => {
			stop();
			requestRender = () => tui.requestRender();
			lastTick = Date.now();
			timer = setInterval(tick, TICK_MS);
			timer.unref?.();
			return {
				render: (width: number) => [truncate(theme.fg("accent", line), width, theme.fg("dim", "…"))],
				invalidate() {},
				dispose: stop,
			};
		}, { placement: "aboveEditor" });
	});
	pi.on("session_shutdown", () => {
		stop();
		unsubscribe();
		children.clear();
	});
}
