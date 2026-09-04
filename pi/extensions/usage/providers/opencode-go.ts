import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { UsageProvider, UsageReport } from "../framework.ts";

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
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider("opencode-go");
	if (!apiKey) throw new Error("未找到 opencode-go 的 apiKey，请先 /login 或配置 auth.json");
	return apiKey;
}

export const opencodeGoProvider: UsageProvider = {
	id: "opencode-go",
	title: "OpenCode Go Usage",
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
