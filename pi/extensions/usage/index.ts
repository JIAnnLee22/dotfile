import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GenericUsageOverlay, MultiUsageOverlay } from "./framework.ts";
import { opencodeGoProvider } from "./providers/opencode-go.ts";
import { chatgptProvider } from "./providers/chatgpt.ts";

export default function (pi: ExtensionAPI) {
	// 单独展示 OpenCode Go
	pi.registerCommand("usage-opencode-go", {
		description: "显示 OpenCode Go 用量 (5时/周/月)",
		handler: async (_args, ctx) => {
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
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new GenericUsageOverlay(tui, theme, ctx, done, chatgptProvider),
				{ overlay: true, overlayOptions: { anchor: "top-right", width: 52, maxHeight: 20 } },
			);
		},
	});
	// 别名
	pi.registerCommand("usage-codex", {
		description: "alias: usage-chatgpt",
		handler: async (args, ctx) => {
			// 复用 chatgpt provider，避免重复注册 overlay 逻辑
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new GenericUsageOverlay(tui, theme, ctx, done, chatgptProvider),
				{ overlay: true, overlayOptions: { anchor: "top-right", width: 52, maxHeight: 20 } },
			);
		},
	});

	// 合并面板：同时展示两者
	pi.registerCommand("usage", {
		description: "显示用量总览 (OpenCode Go + ChatGPT)",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new MultiUsageOverlay(tui, theme, ctx, done, [opencodeGoProvider, chatgptProvider]),
				{ overlay: true, overlayOptions: { anchor: "top-right", width: 56, maxHeight: 28 } },
			);
		},
	});
}

// 将 provider 与框架重新导出，方便测试与外部复用
export * from "./framework.ts";
export { opencodeGoProvider } from "./providers/opencode-go.ts";
export { chatgptProvider } from "./providers/chatgpt.ts";
