import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── 格式化工具 ──

export function formatTime(time: string | number): string {
	const d = typeof time === "number"
		// wham/usage 返回秒级时间戳
		? new Date(time * 1000)
		: new Date(time);
	if (Number.isNaN(d.getTime())) return String(time);
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(d);
}

export function formatPercent(remaining: number, reset: string | number): string {
	const clamped = Math.max(0, Math.min(100, remaining));
	const filled = Math.round((clamped / 100) * 20);
	return `${"█".repeat(filled)}${"░".repeat(20 - filled)} ${clamped.toFixed(0)}% ${formatTime(reset)}更新`;
}

// ── 基础 Overlay ──

export abstract class BaseOverlay {
	protected theme: Theme;
	constructor(theme: Theme) { this.theme = theme; }

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

	invalidate(): void {}
	dispose(): void {}
}

// ── Usage 抽象 ──

export interface UsageSnapshot {
	label: string;
	/** 剩余可用百分比 0-100 */
	percent: number;
	resetsAt: string | number;
}

export interface UsageReport {
	title: string;
	snapshots: UsageSnapshot[];
	/** 额外信息，如 planType / credits */
	extra?: string;
	raw?: unknown;
}

export interface UsageProvider {
	id: string;
	title: string;
	fetch(ctx: ExtensionCommandContext): Promise<UsageReport>;
}

// ── 单 Provider 通用 Overlay ──

export class GenericUsageOverlay extends BaseOverlay {
	private tui: TUI;
	private ctx: ExtensionCommandContext;
	private provider: UsageProvider;
	private report: UsageReport | null = null;
	private error: string | null = null;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, ctx: ExtensionCommandContext, done: () => void, provider: UsageProvider) {
		super(theme);
		this.tui = tui;
		this.ctx = ctx;
		this.provider = provider;
		this.done = done;
		this.startAnimation();
		provider.fetch(ctx).then(
			(r) => { this.report = r; this.tui.requestRender(); },
			(err) => { this.error = err instanceof Error ? err.message : String(err); this.tui.requestRender(); },
		);
	}

	private startAnimation(): void {
		this.interval = setInterval(() => { this.frame++; this.tui.requestRender(); }, 1000 / 30);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) { this.dispose(); this.done(); }
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);
		const spinChars = ["◐", "◓", "◑", "◒"];
		const spin = spinChars[this.frame % spinChars.length];

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", this.provider.title)) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));

		if (this.error) {
			lines.push(border("│") + padLine(` 失败: ${th.fg("error", truncateToWidth(this.error, innerW - 6))}`) + border("│"));
			lines.push(border("│") + padLine("") + border("│"));
		} else if (this.report) {
			for (const s of this.report.snapshots) {
				lines.push(border("│") + padLine(` ${s.label}: ${th.fg("accent", formatPercent(s.percent, s.resetsAt))}`) + border("│"));
			}
			if (this.report.extra) {
				lines.push(border("│") + padLine(th.fg("dim", ` ${this.report.extra}`)) + border("│"));
			}
			if (this.report.snapshots.length === 0) {
				lines.push(border("│") + padLine(th.fg("warning", " 无可用窗口")) + border("│"));
			}
		} else {
			lines.push(border("│") + padLine(` 请求中: ${th.fg("warning", spin)} ${th.fg("dim", this.provider.id)}`) + border("│"));
			lines.push(border("│") + padLine("") + border("│"));
		}

		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Press Esc/q to close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	dispose(): void {
		if (this.interval) { clearInterval(this.interval); this.interval = null; }
	}
}

// ── 多 Provider 合并 Overlay ──

export class MultiUsageOverlay extends BaseOverlay {
	private tui: TUI;
	private ctx: ExtensionCommandContext;
	private providers: UsageProvider[];
	private results: Map<string, { report?: UsageReport; error?: string }> = new Map();
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, ctx: ExtensionCommandContext, done: () => void, providers: UsageProvider[]) {
		super(theme);
		this.tui = tui;
		this.ctx = ctx;
		this.providers = providers;
		this.done = done;
		this.startAnimation();
		for (const p of providers) {
			this.results.set(p.id, {});
			p.fetch(ctx).then(
				(r) => { this.results.set(p.id, { report: r }); this.tui.requestRender(); },
				(err) => { this.results.set(p.id, { error: err instanceof Error ? err.message : String(err) }); this.tui.requestRender(); },
			);
		}
	}

	private startAnimation(): void {
		this.interval = setInterval(() => { this.frame++; this.tui.requestRender(); }, 1000 / 30);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) { this.dispose(); this.done(); }
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);
		const spinChars = ["◐", "◓", "◑", "◒"];
		const spin = spinChars[this.frame % spinChars.length];

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", "Usage Dashboard")) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));

		for (const p of this.providers) {
			const res = this.results.get(p.id);
			lines.push(border("│") + padLine(th.fg("accent", `— ${p.title} —`)) + border("│"));
			if (!res || (!res.report && !res.error)) {
				lines.push(border("│") + padLine(`  请求中: ${th.fg("warning", spin)}`) + border("│"));
			} else if (res.error) {
				lines.push(border("│") + padLine(`  失败: ${th.fg("error", truncateToWidth(res.error, innerW - 6))}`) + border("│"));
			} else if (res.report) {
				for (const s of res.report.snapshots) {
					lines.push(border("│") + padLine(`  ${s.label}: ${th.fg("accent", formatPercent(s.percent, s.resetsAt))}`) + border("│"));
				}
				if (res.report.extra) {
					lines.push(border("│") + padLine(th.fg("dim", `  ${res.report.extra}`)) + border("│"));
				}
				if (res.report.snapshots.length === 0) {
					lines.push(border("│") + padLine(th.fg("dim", "  无数据")) + border("│"));
				}
			}
			lines.push(border("│") + padLine("") + border("│"));
		}

		lines.push(border("│") + padLine(th.fg("dim", " Press Esc/q to close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	dispose(): void {
		if (this.interval) { clearInterval(this.interval); this.interval = null; }
	}
}
