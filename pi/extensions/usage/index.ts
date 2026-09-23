import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { GenericUsageOverlay, MultiUsageOverlay, type UsageProvider } from "./framework.ts";
import { opencodeGoProvider } from "./providers/opencode-go.ts";
import { chatgptProvider } from "./providers/chatgpt.ts";
import { antigravityProvider } from "./providers/antigravity.ts";

async function ensureConfigured(ctx: ExtensionCommandContext, provider: UsageProvider, loginHint: string): Promise<boolean> {
	if (provider.isConfigured) {
		const ok = await provider.isConfigured(ctx);
		if (!ok) {
			if (ctx.hasUI) {
				ctx.ui.notify(`未登录 ${provider.title}，请先执行 ${loginHint}`, "warning");
			} else {
				console.warn(`未登录 ${provider.title}，请先执行 ${loginHint}`);
			}
			return false;
		}
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	// 单独展示 OpenCode Go
	pi.registerCommand("usage-opencode-go", {
		description: "显示 OpenCode Go 用量 (5时/周/月)",
		handler: async (_args, ctx) => {
			if (!(await ensureConfigured(ctx, opencodeGoProvider, "/login opencode-go"))) return;
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new GenericUsageOverlay(tui, theme, ctx, done, opencodeGoProvider),
				{ overlay: true, overlayOptions: { anchor: "top-right", width: 52, maxHeight: 20 } },
			);
		},
	});

	// 单独展示 ChatGPT（OAuth，已验证的 openai-codex）
	pi.registerCommand("usage-chatgpt", {
		description: "显示 ChatGPT 用量 (OAuth wham/usage，复用 openai-codex 凭证)",
		handler: async (_args, ctx) => {
			if (!(await ensureConfigured(ctx, chatgptProvider, "/login openai-codex"))) return;
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new GenericUsageOverlay(tui, theme, ctx, done, chatgptProvider),
				{ overlay: true, overlayOptions: { anchor: "top-right", width: 52, maxHeight: 20 } },
			);
		},
	});
	// 别名
	pi.registerCommand("usage-codex", {
		description: "alias: usage-chatgpt",
		handler: async (_args, ctx) => {
			if (!(await ensureConfigured(ctx, chatgptProvider, "/login openai-codex"))) return;
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new GenericUsageOverlay(tui, theme, ctx, done, chatgptProvider),
				{ overlay: true, overlayOptions: { anchor: "top-right", width: 52, maxHeight: 20 } },
			);
		},
	});

	// 单独展示 Antigravity (Google Cloud Code Assist)
	pi.registerCommand("usage-antigravity", {
		description: "显示 Antigravity 用量 (Gemini + 3P 共享限额)",
		handler: async (_args, ctx) => {
			if (!(await ensureConfigured(ctx, antigravityProvider, "/login antigravity"))) return;
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new GenericUsageOverlay(tui, theme, ctx, done, antigravityProvider),
				{ overlay: true, overlayOptions: { anchor: "top-right", width: 56, maxHeight: 22 } },
			);
		},
	});

	// 合并面板：仅展示已登录的 Provider
	pi.registerCommand("usage", {
		description: "显示用量总览 (仅展示已登录服务)",
		handler: async (_args, ctx) => {
			const allProviders = [opencodeGoProvider, chatgptProvider, antigravityProvider];
			const activeProviders: UsageProvider[] = [];

			for (const p of allProviders) {
				if (!p.isConfigured || (await p.isConfigured(ctx))) {
					activeProviders.push(p);
				}
			}

			if (activeProviders.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify("未检测到已登录的 Provider，请先通过 /login 登录对应服务", "warning");
				} else {
					console.warn("未检测到已登录的 Provider，请先通过 /login 登录对应服务");
				}
				return;
			}

			const maxHeight = Math.min(36, 8 + activeProviders.length * 7);
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new MultiUsageOverlay(tui, theme, ctx, done, activeProviders),
				{ overlay: true, overlayOptions: { anchor: "top-right", width: 58, maxHeight } },
			);
		},
	});
}

// 将 provider 与框架重新导出，方便测试与外部复用
export * from "./framework.ts";
export { opencodeGoProvider } from "./providers/opencode-go.ts";
export { chatgptProvider } from "./providers/chatgpt.ts";
export { antigravityProvider } from "./providers/antigravity.ts";
