import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ProviderNotLoggedInError, type UsageProvider, type UsageReport } from "../framework.ts";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export interface UsageWindow {
	percent: number;
	resetsAt: string;
}
export interface OpenCodeGoUsage {
	usage: {
		rolling: UsageWindow;
		weekly: UsageWindow;
		monthly: UsageWindow;
	};
	useBalance: boolean;
}

export async function fetchGoUsage(apiKey: string): Promise<OpenCodeGoUsage> {
	const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) throw new Error(`Failed to fetch OpenCode Go usage: ${res.status} ${res.statusText}`);
	return res.json() as Promise<OpenCodeGoUsage>;
}

export async function getOpencodeGoApiKey(ctx: ExtensionCommandContext): Promise<string> {
	try {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider("opencode-go");
		if (apiKey) return apiKey;
	} catch {}

	const authPath = join(agentDir(), "auth.json");
	if (existsSync(authPath)) {
		try {
			const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
			const val = auth["opencode-go"];
			if (typeof val === "string" && val) return val;
			if (val && typeof val === "object" && "key" in val && typeof (val as { key: unknown }).key === "string") {
				return (val as { key: string }).key;
			}
			if (val && typeof val === "object" && "access" in val && typeof (val as { access: unknown }).access === "string") {
				return (val as { access: string }).access;
			}
		} catch {}
	}
	throw new ProviderNotLoggedInError("OpenCode Go", "/login opencode-go 或配置 auth.json");
}

export async function isOpencodeGoConfigured(ctx: ExtensionCommandContext): Promise<boolean> {
	try {
		const apiKey = await getOpencodeGoApiKey(ctx);
		return !!apiKey;
	} catch {
		return false;
	}
}

export const opencodeGoProvider: UsageProvider = {
	id: "opencode-go",
	title: "OpenCode Go Usage",
	isConfigured: isOpencodeGoConfigured,
	async fetch(ctx): Promise<UsageReport> {
		const apiKey = await getOpencodeGoApiKey(ctx);
		const data = await fetchGoUsage(apiKey);
		const u = data.usage;
		return {
			title: "OpenCode Go Usage",
			snapshots: [
				{ label: "5时", percent: 100 - u.rolling.percent, resetsAt: u.rolling.resetsAt },
				{ label: "周 ", percent: 100 - u.weekly.percent, resetsAt: u.weekly.resetsAt },
				{ label: "月 ", percent: 100 - u.monthly.percent, resetsAt: u.monthly.resetsAt },
			],
			extra: data.useBalance ? "余额模式" : undefined,
			raw: data,
		};
	},
};
