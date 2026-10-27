import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ProviderNotLoggedInError, type UsageProvider, type UsageReport, type UsageSnapshot } from "../framework.ts";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

const DEFAULT_BASE_URL = "https://dn-api-ai.vigame.cn";
const TIMEOUT_MS = 10_000;

export interface VimediaUsage {
	totalQuotaUsd: number;
	usedQuotaUsd: number;
	remainingQuotaUsd: number;
	remainingPercent: number;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), ms);
	try {
		return await fetch(url, { ...init, signal: ac.signal });
	} catch (e) {
		if (ac.signal.aborted) throw new Error(`请求超时 ${Math.round(ms / 1000)}s`);
		throw e;
	} finally {
		clearTimeout(t);
	}
}

export function resolveVimediaBaseUrl(): string {
	// 尝试从 models.json 中提取 baseUrl，若无则使用默认网关
	const modelsPath = join(agentDir(), "models.json");
	if (existsSync(modelsPath)) {
		try {
			const modelsData = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown>;
			const providers = modelsData.providers as Record<string, unknown> | undefined;
			const vimedia = (providers?.vimedia || modelsData.vimedia) as Record<string, unknown> | undefined;
			if (typeof vimedia?.baseUrl === "string" && vimedia.baseUrl.trim()) {
				// 去除尾部 /v1 或斜杠
				return vimedia.baseUrl.trim().replace(/\/v1\/?$/, "").replace(/\/+$/, "");
			}
		} catch {}
	}
	return DEFAULT_BASE_URL;
}

export async function getVimediaApiKey(ctx?: ExtensionCommandContext): Promise<string> {
	if (ctx?.modelRegistry) {
		try {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("vimedia");
			if (apiKey) return apiKey;
		} catch {}
	}

	const authPath = join(agentDir(), "auth.json");
	if (existsSync(authPath)) {
		try {
			const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
			const val = auth.vimedia;
			if (typeof val === "string" && val) return val;
			if (val && typeof val === "object") {
				const obj = val as Record<string, unknown>;
				if (typeof obj.key === "string" && obj.key) return obj.key;
				if (typeof obj.access === "string" && obj.access) return obj.access;
			}
		} catch {}
	}

	throw new ProviderNotLoggedInError("Vimedia", "/login vimedia 或配置 auth.json");
}

export async function isVimediaConfigured(ctx: ExtensionCommandContext): Promise<boolean> {
	try {
		const key = await getVimediaApiKey(ctx);
		return !!key;
	} catch {
		return false;
	}
}

export async function fetchVimediaUsage(apiKey: string, baseUrl = resolveVimediaBaseUrl()): Promise<VimediaUsage> {
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/json",
	};

	const [subRes, usageRes] = await Promise.all([
		fetchWithTimeout(`${baseUrl}/v1/dashboard/billing/subscription`, { headers }, TIMEOUT_MS),
		fetchWithTimeout(`${baseUrl}/v1/dashboard/billing/usage`, { headers }, TIMEOUT_MS),
	]);

	if (!subRes.ok) {
		const text = await subRes.text().catch(() => "");
		throw new Error(`获取 Vimedia 配额失败: ${subRes.status} ${subRes.statusText} ${text}`.trim());
	}
	if (!usageRes.ok) {
		const text = await usageRes.text().catch(() => "");
		throw new Error(`获取 Vimedia 用量失败: ${usageRes.status} ${usageRes.statusText} ${text}`.trim());
	}

	const sub = (await subRes.json()) as { hard_limit_usd?: number };
	const usage = (await usageRes.json()) as { total_usage?: number };

	const totalQuotaUsd = typeof sub.hard_limit_usd === "number" ? sub.hard_limit_usd : 0;
	// NewAPI 的 total_usage 单位为分 (cents)，转换为美元
	const usedQuotaUsd = typeof usage.total_usage === "number" ? usage.total_usage / 100 : 0;
	const remainingQuotaUsd = Math.max(0, totalQuotaUsd - usedQuotaUsd);
	const remainingPercent = totalQuotaUsd > 0
		? Math.max(0, Math.min(100, (remainingQuotaUsd / totalQuotaUsd) * 100))
		: 100;

	return {
		totalQuotaUsd,
		usedQuotaUsd,
		remainingQuotaUsd,
		remainingPercent,
	};
}

export const vimediaProvider: UsageProvider = {
	id: "vimedia",
	title: "Vimedia AI Usage",
	isConfigured: isVimediaConfigured,
	async fetch(ctx): Promise<UsageReport> {
		const apiKey = await getVimediaApiKey(ctx);
		const data = await fetchVimediaUsage(apiKey);

		const snapshots: UsageSnapshot[] = [
			{
				label: "额度",
				percent: Math.round(data.remainingPercent * 10) / 10,
				resetsAt: "",
			},
		];

		const extra = data.totalQuotaUsd > 0
			? `剩余 $${data.remainingQuotaUsd.toFixed(2)} / 总额 $${data.totalQuotaUsd.toFixed(2)} (已用 $${data.usedQuotaUsd.toFixed(2)})`
			: `已用 $${data.usedQuotaUsd.toFixed(2)}`;

		return {
			title: "Vimedia AI Usage",
			snapshots,
			extra,
			raw: data,
		};
	},
};
