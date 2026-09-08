/**
 * tps - 实时输出 token 速率计量（纯计算逻辑，可单测）。
 *
 * 流式阶段 `message_update` 只携带文本 delta（无权威 token 数），
 * 因此用 UTF-8 字节数 ÷ BYTES_PER_TOKEN 近似；响应结束（message_end）
 * 再用 `usage.output` 精确定格。
 */

/** 每 token 的 UTF-8 字节数经验值（英文约 4 字节/token，中文约 3 字节/字）。 */
export const BYTES_PER_TOKEN = 4;

export interface StreamSample {
	/** 首个输出 delta 的时间戳（ms epoch），0 表示尚未开始。 */
	startMs: number;
	/** 已累计输出文本的 UTF-8 字节数（不含 thinking delta）。 */
	bytes: number;
	/** 权威输出 token 数（message_end 后可用），0 表示未知。 */
	authoritativeTokens: number;
	/** 定格时刻（ms epoch），用于计算权威速率的耗时终点。 */
	endMs: number;
}

export function newStreamSample(): StreamSample {
	return { startMs: 0, bytes: 0, authoritativeTokens: 0, endMs: 0 };
}

/** 从 UTF-8 字节数估算 token 数。 */
export function estimateTokens(bytes: number, bytesPerToken = BYTES_PER_TOKEN): number {
	return bytes / bytesPerToken;
}

/** 实时速率（tokens/s）；未开始或耗时非正时返回 0。 */
export function liveTokensPerSecond(sample: StreamSample, nowMs: number): number {
	if (sample.startMs <= 0) return 0;
	const elapsedMs = nowMs - sample.startMs;
	if (elapsedMs <= 0) return 0;
	return estimateTokens(sample.bytes) / (elapsedMs / 1000);
}

/** 瞬时速率：按某个时间窗口内的字节增量计算（每秒采样用）。 */
export function instantTokensPerSecond(bytesDelta: number, msDelta: number): number {
	if (bytesDelta < 0 || msDelta <= 0) return 0;
	return estimateTokens(bytesDelta) / (msDelta / 1000);
}

/** 定格速率：优先权威 token 数，缺失时回退估算。 */
export function finalTokensPerSecond(sample: StreamSample): number {
	const endMs = sample.endMs > 0 ? sample.endMs : Date.now();
	const elapsedMs = endMs - sample.startMs;
	if (sample.startMs <= 0 || elapsedMs <= 0) return 0;
	const tokens =
		sample.authoritativeTokens > 0 ? sample.authoritativeTokens : estimateTokens(sample.bytes);
	return tokens / (elapsedMs / 1000);
}

/** 格式化速率文本：`—` / `12.3 t/s` / `142 t/s` / `1.4k t/s`。 */
export function formatTokensPerSecond(tps: number): string {
	if (!Number.isFinite(tps) || tps <= 0) return "—";
	if (tps >= 1000) return `${(tps / 1000).toFixed(1)}k t/s`;
	if (tps >= 100) return `${Math.round(tps)} t/s`;
	return `${tps.toFixed(1)} t/s`;
}

/** 格式化 token 数量文本：`216` / `1.2k` / `3.4M`。 */
export function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count < 0) return "—";
	if (count < 1000) return Math.round(count).toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
