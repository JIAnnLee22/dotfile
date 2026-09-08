import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	BYTES_PER_TOKEN,
	estimateTokens,
	finalTokensPerSecond,
	formatTokens,
	formatTokensPerSecond,
	instantTokensPerSecond,
	liveTokensPerSecond,
	newStreamSample,
} from "../src/meter.ts";

test("estimateTokens 按 UTF-8 字节数 ÷ 系数估算", () => {
	assert.equal(estimateTokens(0), 0);
	assert.equal(estimateTokens(40), 10);
	assert.equal(estimateTokens(40, 2), 20);
});

test("newStreamSample 初始为全零", () => {
	const s = newStreamSample();
	assert.equal(s.startMs, 0);
	assert.equal(s.bytes, 0);
	assert.equal(s.authoritativeTokens, 0);
	assert.equal(s.endMs, 0);
});

test("liveTokensPerSecond 未开始时返回 0", () => {
	const s = newStreamSample();
	assert.equal(liveTokensPerSecond(s, Date.now()), 0);
});

test("liveTokensPerSecond 按字节估算实时速率", () => {
	const s = newStreamSample();
	s.startMs = 1000;
	s.bytes = 4 * BYTES_PER_TOKEN * 2; // 8 tokens 的字节数
	// 2 秒后 = 8 tokens / 2s = 4 t/s
	assert.equal(liveTokensPerSecond(s, 3000), 4);
});

test("liveTokensPerSecond 耗时非正时返回 0", () => {
	const s = newStreamSample();
	s.startMs = 1000;
	assert.equal(liveTokensPerSecond(s, 1000), 0);
	assert.equal(liveTokensPerSecond(s, 500), 0);
});

test("instantTokensPerSecond 按字节增量与时间增量计算瞬时速率", () => {
	// 1 秒内 8 tokens 的字节增量 → 8 t/s
	assert.equal(instantTokensPerSecond(8 * BYTES_PER_TOKEN, 1000), 8);
	// 0.5 秒内 8 tokens → 16 t/s
	assert.equal(instantTokensPerSecond(8 * BYTES_PER_TOKEN, 500), 16);
});

test("instantTokensPerSecond 非正耗时或负增量返回 0", () => {
	assert.equal(instantTokensPerSecond(100, 0), 0);
	assert.equal(instantTokensPerSecond(100, -10), 0);
	assert.equal(instantTokensPerSecond(-10, 1000), 0);
});

test("finalTokensPerSecond 优先用权威 token 数", () => {
	const s = newStreamSample();
	s.startMs = 1000;
	s.endMs = 3000; // 2 秒
	s.bytes = 1000; // 估算会得 62.5 tokens
	s.authoritativeTokens = 120; // 权威 120 tokens
	assert.equal(finalTokensPerSecond(s), 60);
});

test("finalTokensPerSecond 权威缺失时回退字节估算", () => {
	const s = newStreamSample();
	s.startMs = 1000;
	s.endMs = 3000; // 2 秒
	s.bytes = 8 * BYTES_PER_TOKEN; // 8 tokens
	assert.equal(finalTokensPerSecond(s), 4);
});

test("finalTokensPerSecond 未开始或耗时非正返回 0", () => {
	assert.equal(finalTokensPerSecond(newStreamSample()), 0);
	const s = newStreamSample();
	s.startMs = 1000;
	s.endMs = 1000;
	assert.equal(finalTokensPerSecond(s), 0);
});

test("formatTokensPerSecond 格式化", () => {
	assert.equal(formatTokensPerSecond(0), "—");
	assert.equal(formatTokensPerSecond(-1), "—");
	assert.equal(formatTokensPerSecond(NaN), "—");
	assert.equal(formatTokensPerSecond(12.34), "12.3 t/s");
	assert.equal(formatTokensPerSecond(142), "142 t/s");
	assert.equal(formatTokensPerSecond(1420), "1.4k t/s");
});

test("formatTokens 格式化 token 数量", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(-1), "—");
	assert.equal(formatTokens(NaN), "—");
	assert.equal(formatTokens(216), "216");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(12345), "12k");
	assert.equal(formatTokens(1234567), "1.2M");
});
