import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { UsageProvider, UsageReport, UsageSnapshot } from "../framework.ts";

// 借鉴 @narumitw/pi-codex-usage 的鉴权与解析逻辑，但不依赖该插件
// 仅通过 Pi 的 openai-codex OAuth 直接请求 wham/usage

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TIMEOUT_MS = 15_000;

// ── helpers ──

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}
function clamp(n: number): number { return Math.max(0, Math.min(100, n)); }
function asNumber(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim()) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
	return undefined;
}
function asString(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), ms);
	try { return await fetch(url, { ...init, signal: ac.signal }); }
	catch (e) {
		if (ac.signal.aborted) throw new Error(`请求超时 ${Math.round(ms / 1000)}s`);
		throw e;
	} finally { clearTimeout(t); }
}

async function resolveChatGPTAuth(ctx: ExtensionCommandContext): Promise<Record<string, string> | undefined> {
	// 遍历所有 openai-codex 模型，取第一个能拿到 Authorization 的
	const seen = new Set<string>();
	const candidates: Array<{ provider: string; id: string } & Record<string, unknown>> = [];
	const add = (m: unknown) => {
		const mm = m as { provider?: string; id?: string };
		if (mm?.provider !== "openai-codex" || !mm.id) return;
		const key = `${mm.provider}/${mm.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(mm as never);
	};
	add((ctx as unknown as { model?: unknown }).model);
	for (const m of ctx.modelRegistry.getAvailable()) add(m);
	for (const m of ctx.modelRegistry.getAll()) add(m);

	for (const model of candidates) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
		if (!auth.ok) continue;
		const headers: Record<string, string> = { ...(auth.headers ?? {}) };
		if (!hasHeader(headers, "Authorization") && auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
		if (!hasHeader(headers, "User-Agent")) headers["User-Agent"] = "pi-usage-overlay";
		if (hasHeader(headers, "Authorization")) return headers;
	}
	return undefined;
}

// ── payload 归一化（兼容 wham/usage 的 rate_limit 结构） ──

type RateLimitPayload = {
	plan_type?: unknown;
	rate_limit?: unknown;
	additional_rate_limits?: unknown;
	credits?: unknown;
};

function windowLabel(win: Record<string, unknown> | undefined, fallback: string): string {
	const secs = asNumber(win?.limit_window_seconds);
	if (secs !== undefined) {
		if (secs <= 6 * 3600) return "5时"; // 3-6h 都视为 5h 窗口
		if (secs >= 6 * 24 * 3600) return "周 ";
		if (secs >= 23 * 3600) return "日 ";
		return `${Math.round(secs / 3600)}小时`;
	}
	return fallback;
}

function normalizePayload(payload: RateLimitPayload): UsageReport {
	const snapshots: UsageSnapshot[] = [];
	let extra: string | undefined;

	const planType = asString(payload.plan_type);
	if (planType) extra = `plan: ${planType}`;

	const rl = payload.rate_limit as Record<string, unknown> | undefined;
	if (rl) {
		const primary = rl.primary_window as Record<string, unknown> | undefined;
		const secondary = rl.secondary_window as Record<string, unknown> | undefined;
		if (primary) {
			const used = asNumber(primary.used_percent);
			const resetAt = asNumber(primary.reset_at) ?? asString(primary.reset_at) as unknown;
			if (used !== undefined && resetAt !== undefined) {
				snapshots.push({ label: windowLabel(primary, "5小时"), percent: 100 - clamp(used), resetsAt: resetAt as string | number });
			}
		}
		if (secondary) {
			const used = asNumber(secondary.used_percent);
			const resetAt = asNumber(secondary.reset_at) ?? asString(secondary.reset_at) as unknown;
			if (used !== undefined && resetAt !== undefined) {
				snapshots.push({ label: windowLabel(secondary, "周  "), percent: 100 - clamp(used), resetsAt: resetAt as string | number });
			}
		}
	}

	// additional limits: 某些账号会在此返回 per-model 限额
	const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
	for (const item of additional) {
		const obj = item as Record<string, unknown>;
		const limitId = asString(obj.limit_name) ?? asString(obj.metered_feature);
		const inner = obj.rate_limit as Record<string, unknown> | undefined;
		if (!limitId || !inner) continue;
		const pw = inner.primary_window as Record<string, unknown> | undefined;
		if (!pw) continue;
		const used = asNumber(pw.used_percent);
		const resetAt = asNumber(pw.reset_at) ?? asString(pw.reset_at) as unknown;
		if (used === undefined || resetAt === undefined) continue;
		// 避免与主窗口重复
		if (snapshots.some((s) => s.label === limitId)) continue;
		snapshots.push({ label: limitId, percent: 100 - clamp(used), resetsAt: resetAt as string | number });
	}

	// credits 信息（仅当没有任何窗口时展示）
	if (snapshots.length === 0) {
		const credits = payload.credits as Record<string, unknown> | undefined;
		if (credits) {
			const hasCredits = credits.has_credits as boolean | undefined;
			const unlimited = credits.unlimited as boolean | undefined;
			const balance = asString(credits.balance);
			if (hasCredits !== undefined) {
				if (unlimited) extra = [extra, "credits: unlimited"].filter(Boolean).join(" | ");
				else if (balance) extra = [extra, `credits: ${balance}`].filter(Boolean).join(" | ");
			}
		}
	}

	if (snapshots.length === 0 && !extra) {
		throw new Error("ChatGPT usage 未返回可展示的限额窗口");
	}

	return { title: "ChatGPT Usage", snapshots, extra, raw: payload };
}

export const chatgptProvider: UsageProvider = {
	id: "chatgpt",
	title: "ChatGPT Usage",
	async fetch(ctx): Promise<UsageReport> {
		const headers = await resolveChatGPTAuth(ctx);
		if (!headers) throw new Error("未找到 ChatGPT OAuth 凭证：请先 /login 登录 openai-codex (ChatGPT Plus/Pro)，或检查 auth.json 中 openai-codex 为 oauth 类型");

		const res = await fetchWithTimeout(CODEX_USAGE_URL, { headers }, TIMEOUT_MS);
		const text = await res.text();
		if (!res.ok) {
			const body = text.slice(0, 600).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>");
			throw new Error(`ChatGPT usage 请求失败 ${res.status} ${res.statusText}: ${body}`);
		}
		let payload: RateLimitPayload;
		try { payload = JSON.parse(text) as RateLimitPayload; } catch { throw new Error("ChatGPT usage 返回非 JSON"); }
		return normalizePayload(payload);
	},
};
