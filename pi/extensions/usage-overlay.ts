import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayAnchor, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Global handle for toggle demo (in real code, use a more elegant pattern)
let globalToggleHandle: OverlayHandle | null = null;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage-opencode-go", {
		description: "show usage for opencode go plan",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new OpenCodeGoUsageOverlay(tui, theme, ctx, done), {
				overlay: true,
				overlayOptions: { anchor: "top-right", width: 40, maxHeight: 20 },
			});
		}
	});
};

export function formatTime(time: string) {
	return new Date(time).toLocaleString("zh-CN", {
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})
	// return new Date(time).toLocaleString("sv-SE", {

	// 	year: "2-digit",
	// 	month: "2-digit",
	// 	day: "2-digit",
	// 	hour: "2-digit",
	// 	minute: "2-digit",
	// })
}

abstract class BaseOverlay {
	protected theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	protected box(lines: string[], width: number, title?: string): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const result: string[] = [];

		const titleStr = title ? truncateToWidth(` ${title} `, innerW) : "";
		const titleW = visibleWidth(titleStr);
		const topLine = "─".repeat(Math.floor((innerW - titleW) / 2));
		const topLine2 = "─".repeat(Math.max(0, innerW - titleW - topLine.length));
		result.push(th.fg("border", `╭${topLine}`) + th.fg("accent", titleStr) + th.fg("border", `${topLine2}╮`));

		for (const line of lines) {
			result.push(th.fg("border", "│") + truncateToWidth(line, innerW, "...", true) + th.fg("border", "│"));
		}

		result.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return result;
	}

	invalidate(): void { }
	dispose(): void { }
}

export interface UsageWindow {
	percent: number
	resetsAt: string
}
export interface OpenCodeGoUsage {
	usage: {
		rolling: UsageWindow
		weekly: UsageWindow
		monthly: UsageWindow
	}
	useBalance: boolean
}
export async function fetchGoUsage(
	apiKey: string,
): Promise<OpenCodeGoUsage> {
	const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
	})

	if (!res.ok) {
		throw new Error(`Failed to fetch OpenCode Go usage: ${res.status}`)
	}

	return res.json() as Promise<OpenCodeGoUsage>
}

export async function getApiKey(ctx: ExtensionCommandContext): Promise<string> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider("opencode-go")
	if (!apiKey) {
		throw new Error("Failed to get opencode go api key")
	}
	return apiKey
}

class OpenCodeGoUsageOverlay extends BaseOverlay {
	private tui: TUI;
	private ctx: ExtensionCommandContext;
	private usage: OpenCodeGoUsage | null = null;
	private error: string | null = null;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private lastFpsUpdate = Date.now();
	private framesSinceLastFps = 0;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, ctx: ExtensionCommandContext, done: () => void) {
		super(theme);
		this.tui = tui;
		this.ctx = ctx;
		this.done = done;
		this.startAnimation();
		getApiKey(ctx)
			.then((apiKey) => fetchGoUsage(apiKey))
			.then((usage) => {
				this.usage = usage;
				this.tui.requestRender();
			})
			.catch((err) => {
				this.error = err instanceof Error ? err.message : String(err);
				this.tui.requestRender();
			});
	}

	private startAnimation(): void {
		// Run at ~30 FPS (same as DOOM target)
		this.interval = setInterval(() => {
			this.frame++;
			this.framesSinceLastFps++;

			// Update FPS counter every second
			const now = Date.now();
			if (now - this.lastFpsUpdate >= 1000) {
				this.framesSinceLastFps = 0;
				this.lastFpsUpdate = now;
			}

			this.tui.requestRender();
		}, 1000 / 30);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.dispose();
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", "OpenCode Go Usage")) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));

		// Spinning character
		const spinChars = ["◐", "◓", "◑", "◒"];
		const singleProgress = "█";
		const spin = spinChars[this.frame % spinChars.length];
		if (this.error) {
			lines.push(border("│") + padLine(` Failed: ${th.fg("error", truncateToWidth(this.error, innerW - 4))}`) + border("│"));
		} else if (this.usage) {
			const u = this.usage.usage;
			const pct = (w: UsageWindow) => `${w.percent}% 重置于 ${formatTime(w.resetsAt)})`;
			lines.push(border("│") + padLine(` 5时: ${th.fg("accent", pct(u.rolling))}`) + border("│"));
			lines.push(border("│") + padLine(`  周: ${th.fg("accent", pct(u.weekly))}`) + border("│"));
			lines.push(border("│") + padLine(`  月: ${th.fg("accent", pct(u.monthly))}`) + border("│"));
		} else {
			lines.push(border("│") + padLine(` Requesting Usage: ${th.fg("warning", spin)}`) + border("│"));
		}
		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " request usage when show this overlay")) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Press Esc to close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}
