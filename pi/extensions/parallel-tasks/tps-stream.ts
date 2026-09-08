import { randomUUID } from "node:crypto";
import type { TpsPhase, TpsStreamEvent } from "../tps/src/stream.ts";

/** 每个子进程一个 reporter；热路径只累计字节，不按 delta 计算速率。 */
export function createTpsReporter(label: string, emit?: (event: TpsStreamEvent) => void) {
	const id = randomUUID();
	let phase: TpsPhase = "output";
	let bytes = 0;
	let tokens = 0;
	let active = false;
	let closed = false;
	const finish = (output?: number) => {
		if (!active) return;
		tokens += typeof output === "number" && Number.isFinite(output) && output > 0
			? output : Math.round(bytes / 4);
		active = false;
		bytes = 0;
		emit?.({ id, label, phase, tokens, ended: true });
	};
	return {
		/** message_start 使无正文的纯工具调用响应也能计入权威总量。 */
		start() {
			if (closed) return;
			active = true;
			bytes = 0;
			phase = "output";
		},
		update(delta: { type?: string; delta?: unknown }) {
			if (closed) return;
			if (delta.type === "thinking_start" || delta.type === "thinking_delta") phase = "thinking";
			else if (delta.type === "text_delta") phase = "output";
			else return;
			active = true;
			const bytesDelta = delta.type !== "thinking_start" && typeof delta.delta === "string"
				? Buffer.byteLength(delta.delta, "utf8") : 0;
			bytes += bytesDelta;
			emit?.({ id, label, phase, bytesDelta, ended: false });
		},
		end(output?: number) {
			if (!closed) finish(output);
		},
		close() {
			if (closed) return;
			closed = true;
			finish();
		},
	};
}
