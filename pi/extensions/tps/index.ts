/**
 * Local pi-tps — based on @monotykamary/pi-tps 1.3.16 (MIT).
 * Shows conventional output-token throughput in a one-second live footer.
 *
 * TPS excludes TTFT and tool execution, but includes streaming pauses.
 * Persists per-turn telemetry and retains upstream export commands.
 *
 * Originally from: https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/tps.ts
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

// ─── Event types (not exported from pi's public API) ────────────────────────
// These mirror the internal types in @earendil-works/pi-coding-agent's
// dist/core/extensions/types.d.ts. When pi starts exporting them, replace
// these local definitions with imports.

interface TurnStartEvent {
  type: 'turn_start';
  turnIndex: number;
  timestamp: number;
}

interface TurnEndEvent {
  type: 'turn_end';
  turnIndex: number;
  message: unknown;
  toolResults: unknown[];
}

interface MessageStartEvent {
  type: 'message_start';
  message: unknown;
}

interface MessageUpdateEvent {
  type: 'message_update';
  message: unknown;
  assistantMessageEvent: AssistantMessageEvent;
}

interface MessageEndEvent {
  type: 'message_end';
  message: unknown;
}

interface SessionTreeEvent {
  type: 'session_tree';
  newLeafId: string | null;
  oldLeafId: string | null;
}

interface ToolExecutionStartEvent {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: unknown;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum gap between token updates to count as a stall (ms) */
const STALL_THRESHOLD_MS = 500;
const FOOTER_INTERVAL_MS = 1000;
const SMOOTH_WINDOW_MS = 3000;

/** Event name emitted by pi-neuralwatt-provider per turn with energy-billed cost data. */
const NEURALWATT_ENERGY_EVENT = 'neuralwatt:turn-energy';

// ─── Data types ─────────────────────────────────────────────────────────────

interface RateSample {
  at: number;
  output: number;
}

interface ThroughputMetrics {
  version: 1 | 2; // v2: tps uses generation average; stalls are diagnostic only
  averageTps: number | null;
  endToEndTps: number | null;
  peakTps: number | null;
  peakEstimated: boolean;
  generationMs: number; // first content update → message_end, summed; excludes tool gaps and TTFT
  toolMs: number; // union of overlapping/nested tool execution intervals
  updateCount: number;
  cacheHitPercent: number | null;
  costUsd: number | null;
  costSource: 'billed' | 'catalog' | 'unavailable';
}

/** Structured telemetry persisted per turn in the session JSONL */
interface TurnTelemetry {
  model: { provider: string; modelId: string };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  timing: {
    ttftMs: number | null; // time to first token
    totalMs: number; // wall clock: turn_start → turn_end
    generationMs: number; // wall clock streaming time (message_start → message_end per message)
    streamMs: number | null; // inter-update span: first streaming update → last streaming update
    stallMs: number; // accumulated gaps > STALL_THRESHOLD_MS
    stallCount: number; // how many discrete stall events
    messageCount: number; // assistant messages in this turn
  };
  tps: number | null; // output / generationMs (metrics), including streaming pauses
  isPrimaryBranch: boolean; // legacy field; v2 means generation TPS is measurable
  metrics?: ThroughputMetrics; // optional for compatibility with existing session entries
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
  /**
   * Blended $/M-tokens rate shown in the notification banner: the per-turn
   * cost divided by (totalTokens / 1_000_000). Cost source is the Neuralwatt
   * billed cost when available (energy-based), otherwise the list-price
   * compute cost from `cost.total`. null when neither is usable or tokens
   * are zero. Purely derived — recomputed in composeDisplayString, not a
   * duplicate of the cost block.
   */
  rateUsdPerMTokens: number | null;
  timestamp: number;
}

/** In-memory state accumulated during one LLM turn */
interface TurnTiming {
  turnIndex: number;
  turnStartMs: number;
  lastUpdateMs: number;
  firstTokenMs: number | null;
  currentMessageStartMs: number | null;
  assistantMessages: AssistantMessage[];
  totalGenerationMs: number;
  generationOutputMs: number;
  rateSamples: RateSample[];
  instantTps: number | null;
  smoothedTps: number | null;
  peakTps: number | null;
  activeTools: Set<string>;
  toolsStartedMs: number | null;
  toolMs: number;
  // Only non-empty content deltas count as token-bearing stream updates.
  updateCount: number;
  firstStreamUpdateMs: number | null; // timestamp of first content delta
  lastStreamUpdateMs: number; // timestamp of most recent content delta
  stallMs: number;
  stallCount: number;
  inStall: boolean;
  messageCount: number;
  turnStartTimestamp: number; // wall-clock ms at turn_start, for correlating session energy entries
}

type FooterPhase =
  | 'waiting'
  | 'streaming'
  | 'paused'
  | 'tools'
  | 'done'
  | 'unavailable'
  | 'interrupted';

interface FooterReading {
  phase: FooterPhase;
  rate: number | null;
  estimated: boolean;
}

const FOOTER_PHASES: Record<FooterPhase, { symbol: string; label: string }> = {
  waiting: { symbol: '◌', label: '等待首个输出' },
  streaming: { symbol: '●', label: '生成中' },
  paused: { symbol: '◷', label: '等待流式更新' },
  tools: { symbol: '◇', label: '工具执行中' },
  done: { symbol: '✓', label: '生成完成' },
  unavailable: { symbol: '○', label: '速率不可计量' },
  interrupted: { symbol: '×', label: '生成中断或失败' },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function tokensPerSecond(tokens: number, ms: number): number | null {
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(ms) || ms < 200) return null;
  const rate = tokens / (ms / 1000);
  return rate <= 10_000 ? Math.round(rate * 10) / 10 : null;
}

function formatRate(value: number | null | undefined, estimated = false): string {
  return value != null && Number.isFinite(value)
    ? `${estimated ? '~' : ''}${value.toFixed(1)}`
    : '—';
}

function cacheHitPercent(input: number, read: number, write: number): number | null {
  const total = input + read + write;
  return total > 0 ? Math.round((read / total) * 1000) / 10 : null;
}

function formatMoney(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `$${value.toFixed(value < 0.01 ? 5 : 3)}` : '—';
}

/** Content estimates use a consistent basis; final usage must not cause a fake rate spike. */
function sampleThroughput(timing: TurnTiming, now: number, estimatedOutput: number) {
  const previous = timing.rateSamples[timing.rateSamples.length - 1];
  if (!previous || now - previous.at < FOOTER_INTERVAL_MS * 0.95) return;
  const output = Math.max(previous.output, estimatedOutput);
  const baseline =
    [...timing.rateSamples].reverse().find((s) => s.at <= now - SMOOTH_WINDOW_MS) ??
    timing.rateSamples[0];
  timing.instantTps = tokensPerSecond(output - previous.output, now - previous.at);
  timing.smoothedTps = tokensPerSecond(output - baseline.output, now - baseline.at);
  if (timing.firstTokenMs !== null && timing.instantTps !== null && now - previous.at <= 1500) {
    timing.peakTps = Math.max(timing.peakTps ?? 0, timing.instantTps);
  }
  timing.rateSamples.push({ at: now, output });
  while (timing.rateSamples.length > 2 && timing.rateSamples[1].at <= now - SMOOTH_WINDOW_MS) {
    timing.rateSamples.shift();
  }
}

/**
 * Compute the blended $/M-tokens rate: costUsd / (totalTokens / 1_000_000).
 * The single calculation backing the banner's $/M-tokens field. Returns null
 * when the inputs can't produce a meaningful rate (zero/negative tokens,
 * non-finite or negative cost).
 */
function computeRateUsdPerM(costUsd: number | null, totalTokens: number): number | null {
  if (costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) return null;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  const rate = costUsd / (totalTokens / 1_000_000);
  if (!Number.isFinite(rate) || rate < 0) return null;
  return Math.round(rate * 100) / 100;
}

/**
 * Fallback: find a Neuralwatt energy entry that was persisted in this session
 * during the current turn. This covers the case where pi-neuralwatt-provider
 * loads before pi-tps, so the energy entry exists before our turn_end runs,
 * but the live event cache missed (e.g. malformed payload, event ordering, or
 * a race).
 *
 * Scans backward from the most recent entry and requires the entry timestamp
 * to be >= turnStartTimestamp so a previous turn's energy data is not reused.
 */
function findEnergyCostFromSession(
  ctx: ExtensionContext,
  turnStartTimestamp: number
): number | null {
  if (!ctx.sessionManager?.getEntries) return null;

  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'custom' || e.customType !== 'neuralwatt-energy') continue;

    const entryTimestamp = typeof e.timestamp === 'number' ? e.timestamp : 0;
    if (entryTimestamp < turnStartTimestamp) return null;

    const data = e.data as Record<string, unknown> | null | undefined;
    if (!data) continue;

    const costUsd = typeof data.cost_usd === 'number' ? data.cost_usd : null;
    if (costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0) return costUsd;
  }

  return null;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  if (msg.role !== 'assistant') return false;
  // Guard: ensure usage exists with required numeric fields before downstream access.
  if (typeof msg.usage !== 'object' || msg.usage === null) return false;
  const usage = msg.usage as Record<string, unknown>;
  if (typeof usage.input !== 'number' || typeof usage.output !== 'number') return false;
  return true;
}

/**
 * Format a number with human-readable scaling (K, M, B).
 * - Values < 1000: raw integer (e.g. 567 → "567")
 * - Values ≥ 1000: scaled with one decimal, dropping ".0" (e.g. 1234 → "1.2K", 2000 → "2K")
 * - Handles up to billions (e.g. 1_234_567_890 → "1.2B")
 */
function formatNumber(num: number): string {
  if (num < 1_000) return String(num);

  let value: number;
  let suffix: string;

  if (num >= 1_000_000_000) {
    value = num / 1_000_000_000;
    suffix = 'B';
  } else if (num >= 1_000_000) {
    value = num / 1_000_000;
    suffix = 'M';
  } else {
    value = num / 1_000;
    suffix = 'K';
  }

  // Drop trailing ".0" for clean display
  const formatted = value.toFixed(1);
  return formatted.endsWith('.0') ? `${value.toFixed(0)}${suffix}` : `${formatted}${suffix}`;
}

/**
 * Format duration in seconds to human-readable string.
 * Sub-minute values show 1 decimal (e.g. "2.3s" for TTFT precision).
 * Rules: no decimals, up to 2 units, includes years.
 * @internal Exported for testing only.
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const seconds = Math.round(totalSeconds);
  const units = [
    { label: 'y', seconds: 365 * 24 * 60 * 60 }, // 365 days
    { label: 'mo', seconds: 30 * 24 * 60 * 60 }, // 30 days
    { label: 'w', seconds: 7 * 24 * 60 * 60 },
    { label: 'd', seconds: 24 * 60 * 60 },
    { label: 'h', seconds: 60 * 60 },
    { label: 'm', seconds: 60 },
    { label: 's', seconds: 1 },
  ];

  const parts: { value: number; label: string }[] = [];
  let remaining = seconds;

  // First pass: extract all units with non-zero values
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (remaining >= unit.seconds) {
      const value = Math.floor(remaining / unit.seconds);
      parts.push({ value, label: unit.label });
      remaining %= unit.seconds;
    }
  }

  // If we only found one unit, add the next smaller unit as zero
  // Skip 'w' (weeks) when the primary unit is 'mo' (months) for better readability
  if (parts.length === 1) {
    const firstUnitIndex = units.findIndex((u) => u.label === parts[0].label);
    if (firstUnitIndex < units.length - 1) {
      let nextIndex = firstUnitIndex + 1;
      // Skip weeks when showing months, skip months+weeks when showing years —
      // go directly to days for a cleaner display
      if (parts[0].label === 'mo' && units[nextIndex].label === 'w') {
        nextIndex++;
      } else if (parts[0].label === 'y' && units[nextIndex].label === 'mo') {
        nextIndex += 2; // skip mo and w, land on d
      }
      if (nextIndex < units.length) {
        parts.push({ value: 0, label: units[nextIndex].label });
      }
    }
  }

  // Return up to 2 most significant units
  const top2 = parts.slice(0, 2);
  return top2.map((p) => `${p.value}${p.label}`).join(' ');
}

/**
 * Compose the human-readable display string from structured telemetry.
 */
function composeDisplayString(t: TurnTelemetry, full = false): string {
  // v1's average already used the conventional denominator. Never relabel the
  // old stall-adjusted tps as a standard measurement when rehydrating history.
  const parts = [`TPS ${formatRate(t.metrics?.averageTps)} tok/s`];
  if (t.timing.ttftMs !== null) parts.push(`TTFT ${formatDuration(t.timing.ttftMs / 1000)}`);
  parts.push(`out ${formatNumber(t.tokens.output)}`);
  if (full) {
    parts.push(
      `e2e:${formatRate(t.metrics?.endToEndTps ?? tokensPerSecond(t.tokens.output, t.timing.totalMs))}`,
      `peak:${formatRate(t.metrics?.peakTps, t.metrics?.peakEstimated ?? true)}`,
      `time ${formatDuration(t.timing.totalMs / 1000)}`,
      `in ${formatNumber(t.tokens.input)} R:${formatNumber(t.tokens.cacheRead)} W:${formatNumber(t.tokens.cacheWrite)}`
    );
    const hit =
      t.metrics?.cacheHitPercent ??
      cacheHitPercent(t.tokens.input, t.tokens.cacheRead, t.tokens.cacheWrite);
    if (hit !== null) parts.push(`cache:${hit.toFixed(0)}%`);
    if (t.timing.stallMs > 0)
      parts.push(`stall ${formatDuration(t.timing.stallMs / 1000)}×${t.timing.stallCount}`);
    if (t.metrics?.toolMs) parts.push(`tool ${formatDuration(t.metrics.toolMs / 1000)}`);
    parts.push(`cost ${formatMoney(t.metrics?.costUsd ?? t.cost?.total)}`);
    if (t.rateUsdPerMTokens != null) parts.push(`$${t.rateUsdPerMTokens.toFixed(2)}/M`);
  }
  return parts.join(' · ');
}

function composeDetails(t: TurnTelemetry, outcome: 'done' | 'interrupted' = 'done'): string {
  const hit =
    t.metrics?.cacheHitPercent ??
    cacheHitPercent(t.tokens.input, t.tokens.cacheRead, t.tokens.cacheWrite);
  const source = t.metrics?.costSource === 'billed' ? '账单' : t.cost ? '目录估价' : '未知';
  return [
    `TPS · ${t.model.provider}/${t.model.modelId}`,
    `状态：${FOOTER_PHASES[outcome].label}`,
    `速率 tok/s：TPS ${formatRate(t.metrics?.averageTps)} · 端到端 ${formatRate(t.metrics?.endToEndTps ?? tokensPerSecond(t.tokens.output, t.timing.totalMs))} · 1s 峰值 ${formatRate(t.metrics?.peakTps, t.metrics?.peakEstimated ?? true)}`,
    `延迟：TTFT ${t.timing.ttftMs === null ? '—' : formatDuration(t.timing.ttftMs / 1000)} · 总耗时 ${formatDuration(t.timing.totalMs / 1000)} · 生成 ${t.metrics ? formatDuration(t.metrics.generationMs / 1000) : '—'} · 工具 ${t.metrics ? formatDuration(t.metrics.toolMs / 1000) : '—'}`,
    `用量 token：非缓存输入 ${formatNumber(t.tokens.input)} · 输出 ${formatNumber(t.tokens.output)} · 缓存读 ${formatNumber(t.tokens.cacheRead)} / 写 ${formatNumber(t.tokens.cacheWrite)} · 合计 ${formatNumber(t.tokens.total)}`,
    `缓存命中 ${hit === null ? '—' : `${hit.toFixed(1)}%`} · 停顿 ${formatDuration(t.timing.stallMs / 1000)}×${t.timing.stallCount} · 消息 ${t.timing.messageCount} · 流更新 ${t.metrics?.updateCount ?? '—'}`,
    `费用 ${formatMoney(t.metrics?.costUsd ?? t.cost?.total)}（${source}）${t.rateUsdPerMTokens == null ? '' : ` · $${t.rateUsdPerMTokens.toFixed(2)}/M`}`,
    '~ 为内容估算；TPS = 输出 token / 生成秒数，排除首字等待和工具时间，不扣生成中的停顿；端到端包括等待与工具时间。',
    ...(!t.metrics ? ['此历史记录未保存标准生成时长，TPS 无法重算；导出保留原始数据。'] : []),
  ].join('\n');
}

/**
 * Build structured TurnTelemetry from accumulated turn timing.
 * Returns null if the turn had no meaningful LLM output.
 */
function buildTelemetry(
  timing: TurnTiming,
  turnEndMs: number,
  billedCost: number | null = null
): TurnTelemetry | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;
  let hasCost = false;
  let model: { provider: string; modelId: string } | null = null;

  for (const message of timing.assistantMessages) {
    input += message.usage.input || 0;
    output += message.usage.output || 0;
    cacheRead += message.usage.cacheRead || 0;
    cacheWrite += message.usage.cacheWrite || 0;
    totalTokens += message.usage.totalTokens || 0;
    if (message.usage.cost) {
      costInput += message.usage.cost.input || 0;
      costOutput += message.usage.cost.output || 0;
      costCacheRead += message.usage.cost.cacheRead || 0;
      costCacheWrite += message.usage.cost.cacheWrite || 0;
      costTotal += message.usage.cost.total || 0;
      hasCost = true;
    }
    if (!model && message.provider && message.model) {
      model = { provider: message.provider, modelId: message.model };
    }
  }

  if (output <= 0) return null;
  if (timing.firstTokenMs === null) return null;
  if (!model) return null;

  const totalMs = turnEndMs - timing.turnStartMs;

  const streamMs =
    timing.firstStreamUpdateMs === null
      ? null
      : timing.lastStreamUpdateMs - timing.firstStreamUpdateMs;

  // Conventional per-request generation throughput, not a reconstructed
  // "active inference" speed: retain all pauses inside the generation span.
  // A single burst cannot establish a streaming rate. No model-history or
  // tool-call cap is applied; short/degenerate windows remain unavailable.
  const tps =
    timing.updateCount >= 2 && streamMs !== null && streamMs >= 200
      ? tokensPerSecond(output, timing.generationOutputMs)
      : null;

  // Single blended $/M-tokens rate for the banner. Cost source: Neuralwatt's
  // billed cost when present (energy-based, what the user actually pays),
  // otherwise the list-price compute cost from message.usage.cost. Never both
  // — billedCost wins outright when present, so there's no double-counting.
  // Pi represents models without pricing with an all-zero cost block. Treat
  // that as unavailable rather than displaying a misleading $0.00/M rate. An
  // explicit billed cost remains valid even when it is zero.
  const listPriceCost = hasCost && Number.isFinite(costTotal) && costTotal > 0 ? costTotal : null;
  const effectiveCost = billedCost ?? listPriceCost;
  const rateUsdPerMTokens = computeRateUsdPerM(effectiveCost, totalTokens);

  return {
    model,
    tokens: { input, output, cacheRead, cacheWrite, total: totalTokens },
    timing: {
      ttftMs: timing.firstTokenMs - timing.turnStartMs,
      totalMs,
      generationMs: timing.totalGenerationMs,
      streamMs,
      stallMs: timing.stallMs,
      stallCount: timing.stallCount,
      messageCount: timing.messageCount,
    },
    tps,
    isPrimaryBranch: tps !== null,
    metrics: {
      version: 2,
      averageTps: tps,
      endToEndTps: tokensPerSecond(output, totalMs),
      peakTps: timing.peakTps,
      peakEstimated: true,
      generationMs: timing.generationOutputMs,
      toolMs:
        timing.toolMs + (timing.toolsStartedMs === null ? 0 : turnEndMs - timing.toolsStartedMs),
      updateCount: timing.updateCount,
      cacheHitPercent: cacheHitPercent(input, cacheRead, cacheWrite),
      costUsd: effectiveCost,
      costSource:
        billedCost !== null ? 'billed' : listPriceCost !== null ? 'catalog' : 'unavailable',
    },
    cost:
      listPriceCost !== null
        ? {
            input: costInput,
            output: costOutput,
            cacheRead: costCacheRead,
            cacheWrite: costCacheWrite,
            total: costTotal,
          }
        : null,
    rateUsdPerMTokens,
    timestamp: Date.now(),
  };
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function tpsExtension(pi: ExtensionAPI) {
  // Current turn timing state
  let currentTiming: TurnTiming | null = null;
  let footerTimer: ReturnType<typeof setInterval> | undefined;
  let liveMessage: AssistantMessage | null = null;
  let liveMessageFirstTokenMs: number | null = null;
  let footerFull = false;
  let lastTelemetry: TurnTelemetry | null = null;
  let lastLegacyStatus: string | undefined;
  let liveDetails: string | undefined;
  let lastReading: FooterReading | null = null;
  let lastOutcome: 'done' | 'interrupted' = 'done';

  function showMinimalFooter(ctx: ExtensionContext, reading: FooterReading) {
    lastReading = reading;
    const value = formatRate(reading.rate, reading.estimated);
    // Attribute-only styling follows the terminal palette and stays valid
    // across idle theme changes: no baked-in foreground/background colors.
    const number = ctx.mode === 'tui' ? ctx.ui.theme.style(value, { bold: true }) : value;
    const unit = ctx.mode === 'tui' ? ctx.ui.theme.style('tok/s', { dim: true }) : 'tok/s';
    setFooterStatus(ctx, `${FOOTER_PHASES[reading.phase].symbol} ${number} ${unit}`);
  }

  function showTelemetry(ctx: ExtensionContext, telemetry: TurnTelemetry) {
    lastTelemetry = telemetry;
    liveDetails = undefined;
    const rate = telemetry.metrics?.averageTps ?? null;
    lastReading = {
      phase: lastOutcome === 'interrupted' ? 'interrupted' : rate === null ? 'unavailable' : 'done',
      rate,
      estimated: false,
    };
    if (footerFull) setFooterStatus(ctx, composeDisplayString(telemetry, true));
    else showMinimalFooter(ctx, lastReading);
  }

  function showLegacyStatus(ctx: ExtensionContext, message: string) {
    if (footerFull) setFooterStatus(ctx, message);
    else showMinimalFooter(ctx, { phase: 'unavailable', rate: null, estimated: false });
  }

  function showUnavailable(ctx: ExtensionContext, interrupted = false) {
    lastReading = { phase: interrupted ? 'interrupted' : 'unavailable', rate: null, estimated: false };
    liveDetails = interrupted
      ? 'TPS · 生成已中断或失败，未取得可保留的速率。'
      : 'TPS · 本轮没有可计量的流式输出。';
    if (footerFull) setFooterStatus(ctx, liveDetails);
    else showMinimalFooter(ctx, lastReading);
  }

  function setFooterStatus(ctx: ExtensionContext, text: string | undefined) {
    if (ctx.hasUI) ctx.ui.setStatus('tps', text);
  }

  function stopFooterUpdates() {
    if (footerTimer !== undefined) clearInterval(footerTimer);
    footerTimer = undefined;
    liveMessage = null;
    liveMessageFirstTokenMs = null;
  }

  function updateLiveFooter(ctx: ExtensionContext, sample = false) {
    if (!ctx.hasUI || !currentTiming) return;
    const now = performance.now();
    const elapsed = formatDuration((now - currentTiming.turnStartMs) / 1000);
    if (sample && liveMessageFirstTokenMs !== null) {
      const estimatedOutput =
        currentTiming.assistantMessages.reduce((sum, message) => sum + estimateTokens(message), 0) +
        (liveMessage ? estimateTokens(liveMessage) : 0);
      sampleThroughput(currentTiming, now, estimatedOutput);
    }
    if (currentTiming.firstTokenMs === null) {
      // A provider can deliver a complete tool call without content deltas.
      // Show execution rather than claiming we are still waiting for output.
      const phase = currentTiming.activeTools.size > 0 ? 'tools' : 'waiting';
      liveDetails = phase === 'tools'
        ? 'TPS · 工具执行中 · 尚无可计量的流式内容。'
        : `TPS · 等待首个输出 · TTFT ${elapsed}`;
      lastReading = { phase, rate: null, estimated: false };
      if (footerFull) setFooterStatus(ctx, liveDetails);
      else showMinimalFooter(ctx, lastReading);
      return;
    }

    let output = currentTiming.assistantMessages.reduce(
      (sum, message) => sum + message.usage.output,
      0
    );
    let estimated = false;
    if (liveMessage) {
      const reported = liveMessage.usage.output;
      if (Number.isFinite(reported) && reported > 0) {
        output += reported;
      } else {
        // Pi's own content estimator; never present it as measured token usage.
        output += estimateTokens(liveMessage);
        estimated = true;
      }
    }
    const generationMs =
      currentTiming.generationOutputMs +
      (liveMessageFirstTokenMs === null ? 0 : now - liveMessageFirstTokenMs);
    const streamMs =
      currentTiming.firstStreamUpdateMs === null
        ? 0
        : currentTiming.lastStreamUpdateMs - currentTiming.firstStreamUpdateMs;
    const average =
      currentTiming.updateCount >= 2 && streamMs >= 200
        ? tokensPerSecond(output, generationMs)
        : null;
    const endToEnd = tokensPerSecond(output, now - currentTiming.turnStartMs);
    const ttft = formatDuration((currentTiming.firstTokenMs - currentTiming.turnStartMs) / 1000);
    const messages = [...currentTiming.assistantMessages, ...(liveMessage ? [liveMessage] : [])];
    const input = messages.reduce((sum, m) => sum + m.usage.input, 0);
    const cacheRead = messages.reduce((sum, m) => sum + (m.usage.cacheRead || 0), 0);
    const cacheWrite = messages.reduce((sum, m) => sum + (m.usage.cacheWrite || 0), 0);
    const hit = cacheHitPercent(input, cacheRead, cacheWrite);
    const pendingGap = liveMessageFirstTokenMs === null ? 0 : now - currentTiming.lastUpdateMs;
    const openStall = pendingGap >= STALL_THRESHOLD_MS;
    const stallMs = currentTiming.stallMs + (openStall ? pendingGap : 0);
    const stallCount = currentTiming.stallCount + (openStall && !currentTiming.inStall ? 1 : 0);
    const toolMs =
      currentTiming.toolMs +
      (currentTiming.toolsStartedMs === null ? 0 : now - currentTiming.toolsStartedMs);
    const knownCost = messages.reduce((sum, m) => sum + (m.usage.cost?.total || 0), 0);
    const rates = `TPS ${formatRate(average, estimated)} tok/s`;
    const summary = [`TTFT ${ttft}`, `out ${estimated ? '~' : ''}${formatNumber(output)}`];
    const extra = [
      `1s:${formatRate(currentTiming.instantTps, true)}`,
      `3s:${formatRate(currentTiming.smoothedTps, true)}`,
      `e2e:${formatRate(endToEnd, estimated)}`,
      `peak:${formatRate(currentTiming.peakTps, true)}`,
      `time ${elapsed}`,
      `in ${input + cacheRead + cacheWrite > 0 ? formatNumber(input) : '—'} R:${formatNumber(cacheRead)} W:${formatNumber(cacheWrite)}`,
    ];
    if (hit !== null) extra.push(`cache:${hit.toFixed(0)}%`);
    if (stallMs > 0) extra.push(`stall ${formatDuration(stallMs / 1000)}×${stallCount}`);
    extra.push(
      `tool ${formatDuration(toolMs / 1000)}`,
      `cost ${formatMoney(knownCost > 0 ? knownCost : null)}`
    );
    const phase: FooterPhase =
      currentTiming.activeTools.size > 0
        ? 'tools'
        : liveMessage === null
          ? 'done'
          : liveMessageFirstTokenMs === null
            ? 'waiting'
            : openStall
              ? 'paused'
              : 'streaming';
    lastReading = { phase, rate: average, estimated };
    liveDetails = [
      `${rates} · ${FOOTER_PHASES[phase].label}`,
      summary.join(' · '),
      extra.join(' · '),
      `流更新 ${currentTiming.updateCount} · 消息 ${currentTiming.messageCount} · 速率单位 tok/s；~ 为估算，最终用量尚未定稿。`,
      'TPS = 输出 token / 生成秒数；排除首字等待和工具时间，不扣生成中的停顿。',
    ].join('\n');
    if (footerFull) setFooterStatus(ctx, [rates, ...summary, ...extra].join(' · '));
    else showMinimalFooter(ctx, lastReading);
  }

  // Cached session entries for argument completion (captured on session_start / session_tree)
  let cachedEntries: Array<{ type?: string; customType?: string; data?: unknown }> = [];

  // pi-neuralwatt-provider emits billed cost during its turn_end handler. Keep
  // an early event only for the active turn; a late event corrects only the
  // turn that was just committed. turnIndex resets to zero on every agent run,
  // so billed costs must never survive beyond either of those scopes.
  let pendingNeuralwattBilledCost: { turnIndex: number; costUsd: number } | null = null;

  let lastCommittedTurn: {
    turnIndex: number;
    telemetry: TurnTelemetry;
    billedApplied: boolean;
    ctx: ExtensionContext;
  } | null = null;

  pi.events?.on(NEURALWATT_ENERGY_EVENT, (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    const turnIndex = typeof p.turnIndex === 'number' ? p.turnIndex : null;
    const costUsd = typeof p.costUsd === 'number' ? p.costUsd : null;
    if (turnIndex === null || costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) {
      return;
    }

    // Provider loaded before pi-tps: turn_end has not reached us yet.
    if (currentTiming) {
      if (currentTiming.turnIndex === turnIndex) {
        pendingNeuralwattBilledCost = { turnIndex, costUsd };
      }
      return;
    }

    // Provider loaded after pi-tps: correct the turn we just committed. Do not
    // cache this event; the same turnIndex can belong to the next agent run.
    const committed = lastCommittedTurn;
    if (!committed || committed.billedApplied || committed.turnIndex !== turnIndex) return;

    committed.billedApplied = true;
    const correctedRate = computeRateUsdPerM(costUsd, committed.telemetry.tokens.total);
    if (correctedRate === null) return;

    const corrected: TurnTelemetry = {
      ...committed.telemetry,
      rateUsdPerMTokens: correctedRate,
      metrics: committed.telemetry.metrics
        ? { ...committed.telemetry.metrics, costUsd, costSource: 'billed' }
        : undefined,
    };
    committed.telemetry = corrected;
    pi.appendEntry('tps', corrected);
    pi.events?.emit('tps:telemetry', corrected);
    cachedEntries.push({ type: 'custom', customType: 'tps' });
    showTelemetry(committed.ctx, corrected);
  });

  // ── Rehydration ─────────────────────────────────────────────────────────

  /** Restore the current branch's last structured or legacy TPS status. */
  function restoreTPSStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    setFooterStatus(ctx, undefined);
    lastTelemetry = null;
    lastLegacyStatus = undefined;
    liveDetails = undefined;
    lastReading = null;
    lastOutcome = 'done';
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== 'custom' || entry.customType !== 'tps') continue;
      const data = entry.data as Record<string, unknown> | null;
      if (!data) continue;
      if (data.model) {
        showTelemetry(ctx, data as unknown as TurnTelemetry);
        return;
      }
      if (typeof data.message === 'string') {
        lastLegacyStatus = data.message;
        showLegacyStatus(ctx, data.message);
        return;
      }
    }
  }

  function resetTurnState() {
    stopFooterUpdates();
    currentTiming = null;
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
  }

  pi.on('session_start', (_event, ctx) => {
    resetTurnState();
    cachedEntries = ctx.sessionManager.getEntries();
    restoreTPSStatus(ctx);
  });

  pi.on('session_tree', (_event: SessionTreeEvent, ctx: ExtensionContext) => {
    resetTurnState();
    cachedEntries = ctx.sessionManager.getEntries();
    restoreTPSStatus(ctx);
  });

  pi.on('session_before_switch', () => resetTurnState());
  pi.on('session_shutdown', (_event, ctx) => {
    resetTurnState();
    setFooterStatus(ctx, undefined);
  });
  pi.on('agent_end', (_event, ctx) => {
    // Abort/failure may end a run without a telemetry-producing turn_end.
    if (currentTiming) showUnavailable(ctx, true);
    stopFooterUpdates();
    currentTiming = null;
  });

  // ── Turn timing ─────────────────────────────────────────────────────────

  // Track when a turn starts (request sent to LLM)
  pi.on('turn_start', (_event: TurnStartEvent, ctx: ExtensionContext) => {
    stopFooterUpdates();
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    lastTelemetry = null;
    lastLegacyStatus = undefined;
    liveDetails = undefined;
    lastReading = null;
    lastOutcome = 'done';
    currentTiming = {
      turnIndex: _event.turnIndex,
      turnStartMs: performance.now(),
      turnStartTimestamp: typeof _event.timestamp === 'number' ? _event.timestamp : Date.now(),
      lastUpdateMs: performance.now(),
      firstTokenMs: null,
      currentMessageStartMs: null,
      assistantMessages: [],
      totalGenerationMs: 0,
      generationOutputMs: 0,
      rateSamples: [],
      instantTps: null,
      smoothedTps: null,
      peakTps: null,
      activeTools: new Set(),
      toolsStartedMs: null,
      toolMs: 0,
      updateCount: 0,
      firstStreamUpdateMs: null,
      lastStreamUpdateMs: 0,
      stallMs: 0,
      stallCount: 0,
      inStall: false,
      messageCount: 0,
    };
    if (ctx.hasUI) {
      updateLiveFooter(ctx);
      footerTimer = setInterval(() => updateLiveFooter(ctx, true), FOOTER_INTERVAL_MS);
      footerTimer.unref();
    }
  });

  // message_start precedes content. TTFT starts at the first non-empty
  // text/thinking/tool-call delta, not an empty block-start event.
  pi.on('message_start', (event: MessageStartEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // Track when THIS message started streaming (for generation TPS)
    currentTiming.currentMessageStartMs = now;
    currentTiming.messageCount++;
    liveMessage = event.message;
    liveMessageFirstTokenMs = null;

    // Reset stall-tracking clock so tool-execution gaps between
    // messages don't get counted as inference stalls.
    currentTiming.lastUpdateMs = now;
    currentTiming.inStall = false;
  });

  // Empty block starts/ends are not tokens. Count text, thinking and tool JSON
  // deltas so TTFT and generation duration use the same output boundary.
  pi.on('message_update', (event: MessageUpdateEvent, ctx: ExtensionContext) => {
    if (!currentTiming || !isAssistantMessage(event.message)) return;
    liveMessage = event.message;
    const delta = event.assistantMessageEvent;
    if (
      (delta.type !== 'text_delta' &&
        delta.type !== 'thinking_delta' &&
        delta.type !== 'toolcall_delta') ||
      delta.delta.length === 0
    ) {
      return;
    }

    const now = performance.now();
    currentTiming.updateCount++;
    currentTiming.firstStreamUpdateMs ??= now;
    currentTiming.lastStreamUpdateMs = now;

    // Seed each message separately: neither TTFT nor message/tool gaps should
    // dilute the generation rate or count as a streaming pause.
    if (liveMessageFirstTokenMs === null) {
      liveMessageFirstTokenMs = now;
      currentTiming.firstTokenMs ??= now;
      currentTiming.lastUpdateMs = now;
      currentTiming.rateSamples = [
        {
          at: now,
          output:
            currentTiming.assistantMessages.reduce(
              (sum, message) => sum + estimateTokens(message),
              0
            ) + estimateTokens(event.message),
        },
      ];
      currentTiming.instantTps = null;
      currentTiming.smoothedTps = null;
      updateLiveFooter(ctx);
      return;
    }

    const gap = now - currentTiming.lastUpdateMs;

    // Detect stall: gap exceeds threshold. The full gap counts as stall
    // time — the threshold is a detection gate, not a duration discount.
    if (gap >= STALL_THRESHOLD_MS) {
      if (!currentTiming.inStall) {
        currentTiming.stallCount++;
      }
      currentTiming.inStall = true;
      currentTiming.stallMs += gap;
    } else {
      currentTiming.inStall = false;
    }

    currentTiming.lastUpdateMs = now;
  });

  // Tool execution is diagnostic only; it never caps generation throughput.
  pi.on('tool_execution_start', (_event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
    if (!currentTiming) return;
    if (currentTiming.activeTools.size === 0) currentTiming.toolsStartedMs = performance.now();
    currentTiming.activeTools.add(_event.toolCallId);
    updateLiveFooter(ctx);
  });

  pi.on('tool_execution_end', (event, ctx) => {
    if (!currentTiming || !currentTiming.activeTools.delete(event.toolCallId)) return;
    if (currentTiming.activeTools.size === 0 && currentTiming.toolsStartedMs !== null) {
      currentTiming.toolMs += performance.now() - currentTiming.toolsStartedMs;
      currentTiming.toolsStartedMs = null;
    }
    updateLiveFooter(ctx);
  });

  // Track when a message ends
  pi.on('message_end', (event: MessageEndEvent, ctx: ExtensionContext) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();
    if (liveMessageFirstTokenMs !== null)
      currentTiming.generationOutputMs += now - liveMessageFirstTokenMs;
    liveMessage = null;
    liveMessageFirstTokenMs = null;

    // Retain the legacy message_start → message_end timing for exports.
    if (currentTiming.currentMessageStartMs !== null) {
      const messageGenerationMs = now - currentTiming.currentMessageStartMs;
      currentTiming.totalGenerationMs += messageGenerationMs;
      currentTiming.currentMessageStartMs = null;
    }

    // Store this message to count its tokens later (only current turn's messages)
    currentTiming.assistantMessages.push(event.message);
    currentTiming.lastUpdateMs = now;
    updateLiveFooter(ctx);
  });

  // ── Persist telemetry ───────────────────────────────────────────────────

  // Calculate, display, and persist telemetry at the end of each LLM turn.
  // The Neuralwatt listener stores an early billed cost only while this exact
  // turn is active, so the handoff remains synchronous and adds no latency.
  pi.on('turn_end', (event: TurnEndEvent, ctx: ExtensionContext) => {
    stopFooterUpdates();
    if (!currentTiming) return;

    const timing = currentTiming;
    currentTiming = null;

    const turnEndMs = performance.now();

    // Pick the effective cost for the blended $/M-tokens rate: Neuralwatt's
    // billed cost when present, otherwise the list-price compute cost from
    // message.usage.cost. The live event is the primary source; if it missed,
    // we read the persisted neuralwatt-energy session entry. Only if neither
    // energy source is available do we fall back to the compute rate.
    // Prefer the live energy event, fall back to the persisted energy entry,
    // and finally to the list-price compute cost.
    let billedCost =
      pendingNeuralwattBilledCost?.turnIndex === event.turnIndex
        ? pendingNeuralwattBilledCost.costUsd
        : null;
    pendingNeuralwattBilledCost = null;

    if (billedCost === null && timing.turnStartTimestamp) {
      billedCost = findEnergyCostFromSession(ctx, timing.turnStartTimestamp);
    }

    lastOutcome =
      isAssistantMessage(event.message) &&
      (event.message.stopReason === 'aborted' || event.message.stopReason === 'error')
        ? 'interrupted'
        : 'done';
    const telemetry = buildTelemetry(timing, turnEndMs, billedCost);
    if (!telemetry) {
      showUnavailable(ctx, lastOutcome === 'interrupted');
      return;
    }

    // Record this turn so a late-arriving neuralwatt:turn-energy event
    // (provider loaded after us) can retroactively correct the rate. Billed
    // cost wins when present, so a turn already billed at commit time is
    // never re-corrected.
    lastCommittedTurn = {
      turnIndex: event.turnIndex,
      telemetry,
      billedApplied: billedCost !== null,
      ctx,
    };

    // Persist structured telemetry to session for export and rehydration
    pi.appendEntry('tps', telemetry);

    // Emit event so other extensions can react to new telemetry
    pi.events.emit('tps:telemetry', telemetry);

    // Keep the final measurement in the footer; do not duplicate it as a popup.
    showTelemetry(ctx, telemetry);

    // Keep argument completion cache in sync with new entries
    cachedEntries.push({ type: 'custom', customType: 'tps' });
  });

  pi.registerCommand('tps', {
    description: '查看 TPS 详情；compact 极简单值 / full 诊断页脚',
    getArgumentCompletions: (prefix) =>
      ['compact', 'full']
        .filter((s) => s.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode && mode !== 'compact' && mode !== 'full') {
        ctx.ui.notify('用法：/tps 查看详情；/tps compact|full 切换页脚。', 'warning');
        return;
      }
      if (mode) footerFull = mode === 'full';
      if (currentTiming) updateLiveFooter(ctx);
      else if (lastTelemetry) showTelemetry(ctx, lastTelemetry);
      else if (lastLegacyStatus) showLegacyStatus(ctx, lastLegacyStatus);
      else if (lastReading) {
        if (footerFull) setFooterStatus(ctx, liveDetails);
        else showMinimalFooter(ctx, lastReading);
      }
      if (!mode)
        ctx.ui.notify(
          currentTiming
            ? (liveDetails ?? '等待输出。')
            : lastTelemetry
              ? composeDetails(lastTelemetry, lastOutcome)
              : (lastLegacyStatus ?? liveDetails ?? '当前分支暂无 TPS 记录。'),
          'info'
        );
    },
  });

  // ── Export commands ─────────────────────────────────────────────────────

  pi.registerCommand('tps-export', {
    description:
      'Export telemetry + session structure (model changes, branch points) as JSONL (--full for all branches, filter by customType)',
    getArgumentCompletions: (argumentPrefix: string) => {
      // Offer --full flag
      if ('--full'.startsWith(argumentPrefix)) {
        return [{ value: '--full', label: '--full (all branches, not just current)' }];
      }
      // Collect all unique customType values from cached session entries
      const customTypes = new Set<string>();
      for (const entry of cachedEntries) {
        if (entry.type === 'custom' && entry.customType) {
          customTypes.add(entry.customType);
        }
      }
      return Array.from(customTypes)
        .filter((ct) => ct.startsWith(argumentPrefix))
        .map((ct) => ({ value: ct, label: ct }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // Default: current branch. --full: entire session.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const full = tokens.includes('--full');
      const filterType = tokens.filter((t) => t !== '--full').join(' ') || null;

      // Collect entries: custom entries (+ optional customType filter) + structural entries
      // Structural entries (model_change, branch_summary) are always included so the
      // exported parentId tree is fully resolvable and the web inspector can show
      // model switches and branch points.
      const entries = full ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
      const isStructural = (e: { type: string }) =>
        e.type === 'model_change' || e.type === 'branch_summary';

      const exportedEntries = entries.filter(
        (e) =>
          isStructural(e) || (e.type === 'custom' && (!filterType || e.customType === filterType))
      );

      if (exportedEntries.length === 0) {
        const scope = full ? 'all-entries' : 'current-branch';
        ctx.ui.notify(`No matching entries found in ${scope}`, 'warning');
        return;
      }

      // Re-chain parentIds so the exported entries form a valid tree.
      // Original parentIds often point to message entries (not in the export).
      // We walk up the full session tree until we find the nearest ancestor
      // that IS in the export, giving us a self-contained tree structure.
      const byId = new Map<string, (typeof entries)[number]>(entries.map((e) => [e.id, e]));
      const exportedIds = new Set(exportedEntries.map((e) => e.id));

      const rechainParentId = (entry: (typeof exportedEntries)[number]): string | null => {
        let current: string | null = entry.parentId;
        while (current) {
          if (exportedIds.has(current)) return current;
          const parent = byId.get(current);
          current = parent?.parentId ?? null;
        }
        return null;
      };

      const rechained = exportedEntries.map((e) => ({
        ...e,
        parentId: rechainParentId(e),
      }));

      // Write to tmp directory
      const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
      const dir = join(cacheBase, 'pi-telemetry');
      mkdirSync(dir, { recursive: true });

      const sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const scopeParts = [full ? 'full' : 'branch', filterType].filter(Boolean);
      const scope = scopeParts.join('-');
      const filename = `pi-telemetry-${scope}-${sessionId.slice(0, 8)}-${timestamp}.jsonl`;
      const filepath = join(dir, filename);

      const content = rechained.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filepath, content);

      const structuralCount = exportedEntries.filter((e) => isStructural(e)).length;
      const customCount = exportedEntries.length - structuralCount;
      const parts: string[] = [];
      if (customCount > 0) parts.push(`${customCount} telemetry`);
      if (structuralCount > 0) parts.push(`${structuralCount} structural`);
      const summary = parts.length > 0 ? parts.join(' + ') : `${exportedEntries.length} entries`;
      try {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${opener} ${JSON.stringify(dir)}`, { stdio: 'ignore' });
      } catch {
        // opener not available — ignore silently
      }

      ctx.ui.notify(`Exported ${summary} → ${filepath}`, 'info');
    },
  });

  // ── Session export command ─────────────────────────────────────────────────

  pi.registerCommand('session-export', {
    description:
      'Export full session JSONL (all entry types, current branch only; --full for all branches)',
    getArgumentCompletions: (argumentPrefix: string) => {
      if ('--full'.startsWith(argumentPrefix)) {
        return [{ value: '--full', label: '--full (all branches, not just current)' }];
      }
      return [];
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const full = args.trim().split(/\s+/).includes('--full');

      const entries = full ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();

      if (entries.length === 0) {
        const scope = full ? 'all-entries' : 'current-branch';
        ctx.ui.notify(`No entries found in ${scope}`, 'warning');
        return;
      }

      // Write to tmp directory
      const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
      const dir = join(cacheBase, 'pi-sessions');
      mkdirSync(dir, { recursive: true });

      const sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const scope = full ? 'full' : 'branch';
      const filename = `pi-session-${scope}-${sessionId.slice(0, 8)}-${timestamp}.jsonl`;
      const filepath = join(dir, filename);

      const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filepath, content);

      try {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${opener} ${JSON.stringify(dir)}`, { stdio: 'ignore' });
      } catch {
        // opener not available — ignore silently
      }

      ctx.ui.notify(`Exported ${entries.length} entries → ${filepath}`, 'info');
    },
  });
}
