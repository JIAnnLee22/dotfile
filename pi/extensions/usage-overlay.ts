// @deprecated — 已迁移至 extensions/usage/
// 保留此文件仅为兼容历史引用，请使用 extensions/usage/ 框架
// 原模板逻辑已抽象到 extensions/usage/framework.ts 与 providers/*
// 此 shim 不再注册命令，避免与新框架重复

export { formatTime, formatPercent, BaseOverlay } from "./usage/framework.ts";
export type { UsageWindow, UsageReport, UsageProvider } from "./usage/framework.ts";
export { fetchGoUsage, getOpencodeGoApiKey, opencodeGoProvider } from "./usage/providers/opencode-go.ts";
export { chatgptProvider } from "./usage/providers/chatgpt.ts";

// 为了让 `pi -e ./extensions/usage-overlay.ts` 仍能工作，提供空的 extension 工厂
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (_pi: ExtensionAPI) {
	// 不再在此注册命令，统一由 extensions/usage/index.ts 注册：
	//  - usage-opencode-go
	//  - usage-chatgpt / usage-codex
	//  - usage (合并面板)
}
