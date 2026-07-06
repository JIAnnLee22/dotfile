/// <reference path="../types.d.ts" />
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { getKeybindings, Input, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const WORKFLOW_STATE_TYPE = "workflow-state";
const CUSTOM_TOOL_NAMES = ["repo_search", "web_search"] as const;
const NORMAL_BASH_ALLOWLIST = [
	/^cat\b/,
	/^head\b/,
	/^tail\b/,
	/^less\b/,
	/^more\b/,
	/^grep\b/,
	/^find\b/,
	/^rg\b/,
	/^fd\b/,
	/^ls\b/,
	/^pwd\b/,
	/^tree\b/,
	/^echo\b/,
	/^printf\b/,
	/^wc\b/,
	/^sort\b/,
	/^uniq\b/,
	/^cut\b/,
	/^git\s+(status|log|diff|branch)\b/,
	/^npm\s+(list|outdated)\b/,
	/^yarn\s+info\b/,
	/^uname\b/,
	/^whoami\b/,
	/^date\b/,
	/^uptime\b/,
];

const PROTECTED_PATH_PARTS = ["/.env", "/.git/", "/node_modules/", "/.npm/", "/.secrets/", "/secrets/"];
const DEFAULT_IGNORED_DIRS = new Set(["node_modules", ".git", ".pi", "dist", "build", "coverage", ".cache", "sessions", "tmp", "temp"]);
const MAX_FILE_BYTES = 1_500_000;
const MAX_RESULTS_DEFAULT = 20;

interface ModelRef {
	provider: string;
	id: string;
}

interface WorkflowState {
	mode: "normal" | "plan" | "execution";
	planSteps?: PlanStep[];
	toolsBeforePlan?: string[];
	originalModel?: ModelRef;
	planModel?: ModelRef;
	executionModel?: ModelRef;
}

interface PlanStep {
	step: number;
	text: string;
	completed: boolean;
}

interface WorkflowConfig {
	defaultProvider?: string;
	planModel?: string;
	executionModel?: string;
}

type WorkflowModelRole = "plan" | "execution";

interface PickerItem {
	value: string;
	label: string;
	description?: string;
}

interface RepoSearchParams {
	query: string;
	path?: string;
	maxResults?: number;
	contextLines?: number;
	includeContent?: boolean;
	includeFileNames?: boolean;
	extensions?: string[];
}

interface WebSearchParams {
	query: string;
	count?: number;
	language?: string;
	freshness?: "day" | "week" | "month" | "year";
	site?: string;
}

interface RepoHit {
	kind: "file-name" | "content";
	path: string;
	line?: number;
	preview: string;
	context?: string[];
}

interface WebHit {
	title: string;
	url: string;
	snippet: string;
	source: string;
}

function readJsonIfExists(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const text = readFileSync(path, "utf-8");
		return JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		console.error(`读取配置失败: ${path}`, error);
		return {};
	}
}

function loadWorkflowConfig(cwd: string): WorkflowConfig {
	const globalSettings = readJsonIfExists(join(getAgentDir(), "settings.json"));
	const projectSettings = readJsonIfExists(join(cwd, ".pi", "settings.json"));
	return {
		...globalSettings,
		...projectSettings,
	};
}

function readSettingsForWrite(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`配置文件不是有效 JSON，已取消写入: ${path}\n${error instanceof Error ? error.message : String(error)}`);
	}
}

function getWorkflowModelConfigKey(role: WorkflowModelRole): "planModel" | "executionModel" {
	return role === "plan" ? "planModel" : "executionModel";
}

function getWorkflowModelRoleLabel(role: WorkflowModelRole): string {
	return role === "plan" ? "计划模型" : "执行模型";
}

function saveWorkflowModelConfig(role: WorkflowModelRole, modelRef: ModelRef | undefined): WorkflowConfig {
	const settingsPath = join(getAgentDir(), "settings.json");
	const settings = readSettingsForWrite(settingsPath);
	const key = getWorkflowModelConfigKey(role);
	const formatted = formatModelRef(modelRef);
	if (formatted) {
		settings[key] = formatted;
	} else {
		delete settings[key];
	}
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	return settings as WorkflowConfig;
}

function parseModelRef(input: string | undefined, defaultProvider?: string): ModelRef | undefined {
	const value = input?.trim();
	if (!value) return undefined;
	const slashIndex = value.indexOf("/");
	if (slashIndex > 0 && slashIndex < value.length - 1) {
		return {
			provider: value.slice(0, slashIndex),
			id: value.slice(slashIndex + 1),
		};
	}
	const provider = defaultProvider?.trim();
	if (!provider) return undefined;
	return { provider, id: value };
}

function formatModelRef(modelRef: ModelRef | undefined): string | undefined {
	return modelRef ? `${modelRef.provider}/${modelRef.id}` : undefined;
}

function toModelRef(model: { provider?: string; id?: string } | undefined): ModelRef | undefined {
	if (!model?.provider || !model.id) return undefined;
	return { provider: model.provider, id: model.id };
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

class SearchablePicker implements Component, Focusable {
	private input = new Input();
	private filteredItems: PickerItem[] = [];
	private selectedIndex = 0;
	private focusedValue?: string;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private title: string,
		private items: PickerItem[],
		private currentValue: string | undefined,
		private theme: ExtensionContext["ui"]["theme"],
		private requestRender: () => void,
		private done: (value: string | null) => void,
	) {
		this.input.onSubmit = () => this.selectCurrent();
		this.input.onEscape = () => this.done(null);
		this.applyFilter("");
	}

	private applyFilter(filter: string): void {
		const terms = filter
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.filter(Boolean);
		this.filteredItems = this.items.filter((item) => {
			const haystack = `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase();
			return terms.every((term) => haystack.includes(term));
		});
		const focusedIndex = this.focusedValue
			? this.filteredItems.findIndex((item) => item.value === this.focusedValue)
			: -1;
		const currentIndex = this.currentValue
			? this.filteredItems.findIndex((item) => item.value === this.currentValue)
			: -1;
		this.selectedIndex = Math.max(0, focusedIndex >= 0 ? focusedIndex : currentIndex >= 0 ? currentIndex : 0);
		this.focusedValue = this.filteredItems[this.selectedIndex]?.value;
	}

	private move(delta: number): void {
		if (this.filteredItems.length === 0) return;
		const next = (this.selectedIndex + delta + this.filteredItems.length) % this.filteredItems.length;
		this.selectedIndex = next;
		this.focusedValue = this.filteredItems[this.selectedIndex]?.value;
	}

	private selectCurrent(): void {
		const selected = this.filteredItems[this.selectedIndex];
		this.done(selected?.value ?? null);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = this.theme.fg("accent", "─".repeat(Math.max(1, width)));
		lines.push(border);
		lines.push(this.theme.fg("accent", this.theme.bold(truncateToWidth(this.title, width, "…"))));
		lines.push(this.theme.fg("dim", truncateToWidth("输入关键词过滤，↑↓/PgUp/PgDn 选择，Enter 确认，Esc 取消", width, "…")));
		lines.push(...this.input.render(width));
		lines.push("");

		if (this.filteredItems.length === 0) {
			lines.push(this.theme.fg("warning", "未找到匹配项"));
			lines.push(border);
			return lines;
		}

		const maxVisible = 12;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredItems.length);

		for (let i = startIndex; i < endIndex; i += 1) {
			const item = this.filteredItems[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const isCurrent = item.value === this.currentValue;
			const prefix = isSelected ? this.theme.fg("accent", "› ") : "  ";
			const currentMark = isCurrent ? this.theme.fg("success", " ✓") : "";
			const label = `${item.label}${currentMark}`;
			let line = prefix + label;
			if (item.description && width > 48) {
				const leftWidth = visibleWidth(line);
				const descWidth = Math.max(12, width - leftWidth - 3);
				const desc = this.theme.fg("muted", truncateToWidth(item.description, descWidth, "…"));
				line += " ".repeat(Math.max(1, width - leftWidth - visibleWidth(desc))) + desc;
			}
			line = truncateToWidth(line, width, "…");
			if (isSelected) {
				line = this.theme.bg("selectedBg", padToWidth(line, width));
			}
			lines.push(line);
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			lines.push(this.theme.fg("dim", truncateToWidth(`(${this.selectedIndex + 1}/${this.filteredItems.length})`, width, "")));
		}
		lines.push(border);
		return lines;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (keybindings.matches(data, "tui.select.pageUp")) {
			this.move(-12);
		} else if (keybindings.matches(data, "tui.select.pageDown")) {
			this.move(12);
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			this.selectCurrent();
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.done(null);
		} else {
			this.input.handleInput(data);
			this.applyFilter(this.input.getValue());
		}
		this.requestRender();
	}
}

function normalizePathList(items: string[] | undefined): string[] {
	return items?.map((item) => item.trim()).filter(Boolean) ?? [];
}

function unique(items: string[]): string[] {
	return [...new Set(items)];
}

function ensureCustomTools(activeTools: string[]): string[] {
	return unique([...activeTools, ...CUSTOM_TOOL_NAMES]);
}

function removeWriteTools(activeTools: string[]): string[] {
	return activeTools.filter((tool) => tool !== "write" && tool !== "edit");
}

function addWriteTools(activeTools: string[]): string[] {
	return unique([...activeTools, "write", "edit"]);
}

function splitCommandSegments(command: string): string[] {
	return command
		.split(/\n|&&|\|\||;/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function isReadOnlySegment(segment: string): boolean {
	const normalized = segment.trim();
	if (!normalized) return true;
	return NORMAL_BASH_ALLOWLIST.some((pattern) => pattern.test(normalized));
}

function isPlanModeSafeCommand(command: string): boolean {
	const segments = splitCommandSegments(command);
	if (segments.length === 0) return true;
	return segments.every(isReadOnlySegment);
}

function isDangerousCommand(command: string): boolean {
	return /(^|\s)(rm\s+-rf|sudo|shutdown|reboot|mkfs|dd\s|:\(\)\{)/.test(command);
}

function hasProtectedPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return PROTECTED_PATH_PARTS.some((part) => normalized.includes(part));
}

function toRelativePath(cwd: string, filePath: string): string {
	const absolute = resolve(cwd, filePath);
	return absolute.startsWith(cwd) ? absolute.slice(cwd.length + 1) : filePath;
}

function decodeHtmlEntities(input: string): string {
	return input
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#x2F;/g, "/")
		.replace(/&nbsp;/g, " ");
}

function stripHtml(input: string): string {
	return decodeHtmlEntities(
		input
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl.startsWith("http") ? rawUrl : `https:${rawUrl}`);
		const uddg = url.searchParams.get("uddg");
		return uddg ? decodeURIComponent(uddg) : url.toString();
	} catch {
		return rawUrl;
	}
}

function isLikelyTextFile(filePath: string): boolean {
	const ext = filePath.toLowerCase().split(".").pop() ?? "";
	return [
		"ts",
		"tsx",
		"js",
		"jsx",
		"mjs",
		"cjs",
		"json",
		"jsonc",
		"md",
		"txt",
		"yaml",
		"yml",
		"toml",
		"ini",
		"env",
		"css",
		"scss",
		"html",
		"xml",
		"kt",
		"kts",
		"java",
		"go",
		"rs",
		"py",
		"rb",
		"php",
		"sh",
		"bash",
		"zsh",
		"fish",
		"sql",
		"graphql",
		"gql",
	].includes(ext);
}

async function* walkFiles(rootPath: string, signal?: AbortSignal, ignoredDirs = DEFAULT_IGNORED_DIRS): AsyncGenerator<string> {
	const entries = await readdir(rootPath, { withFileTypes: true });
	for (const entry of entries) {
		if (signal?.aborted) return;
		if (ignoredDirs.has(entry.name)) continue;
		const next = join(rootPath, entry.name);
		if (entry.isDirectory()) {
			yield* walkFiles(next, signal, ignoredDirs);
		} else if (entry.isFile()) {
			yield next;
		}
	}
}

function matchesExtensions(filePath: string, extensions: string[] | undefined): boolean {
	if (!extensions || extensions.length === 0) return true;
	const normalized = filePath.toLowerCase();
	return extensions.some((ext) => {
		const trimmed = ext.trim().toLowerCase();
		if (!trimmed) return false;
		return normalized.endsWith(trimmed.startsWith(".") ? trimmed : `.${trimmed}`);
	});
}

async function searchRepository(ctx: ExtensionContext, params: RepoSearchParams, signal?: AbortSignal): Promise<{ hits: RepoHit[]; scannedFiles: number; truncated: boolean }> {
	const query = params.query.trim();
	if (!query) {
		throw new Error("搜索关键词不能为空");
	}

	const maxResults = Math.max(1, Math.min(params.maxResults ?? MAX_RESULTS_DEFAULT, 100));
	const contextLines = Math.max(0, Math.min(params.contextLines ?? 2, 8));
	const startPath = resolve(ctx.cwd, params.path?.trim() || ".");
	const relativeToRoot = relative(ctx.cwd, startPath);
	if (relativeToRoot.startsWith("..")) {
		throw new Error("搜索路径必须位于当前工作区内");
	}
	const hits: RepoHit[] = [];
	let scannedFiles = 0;
	let truncated = false;
	const queryLower = query.toLowerCase();
	const searchInContent = params.includeContent !== false;
	const searchInNames = params.includeFileNames !== false;

	let rootStats: Awaited<ReturnType<typeof stat>>;
	try {
		rootStats = await stat(startPath);
	} catch {
		throw new Error(`搜索路径不存在: ${params.path ?? "."}`);
	}

	const files: string[] = [];
	if (rootStats.isFile()) {
		files.push(startPath);
	} else {
		for await (const filePath of walkFiles(startPath, signal)) {
			if (files.length >= 5000) {
				truncated = true;
				break;
			}
			files.push(filePath);
		}
	}

	for (const filePath of files) {
		if (signal?.aborted) break;
		if (!matchesExtensions(filePath, params.extensions)) continue;
		scannedFiles += 1;

		const relativePath = toRelativePath(ctx.cwd, filePath);
		if (searchInNames && relativePath.toLowerCase().includes(queryLower)) {
			hits.push({
				kind: "file-name",
				path: relativePath,
				preview: `文件名命中: ${relativePath}`,
			});
			if (hits.length >= maxResults) break;
		}

		if (!searchInContent) continue;
		if (!isLikelyTextFile(filePath)) continue;

		const fileStats = await stat(filePath);
		if (fileStats.size > MAX_FILE_BYTES) continue;

		let content: string;
		try {
			content = await readFile(filePath, "utf-8");
		} catch {
			continue;
		}

		if (content.includes("\u0000")) continue;
		const lines = content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i += 1) {
			if (signal?.aborted) break;
			const line = lines[i];
			if (!line.toLowerCase().includes(queryLower)) continue;

			const start = Math.max(0, i - contextLines);
			const end = Math.min(lines.length, i + contextLines + 1);
			hits.push({
				kind: "content",
				path: relativePath,
				line: i + 1,
				preview: line.trim(),
				context: lines.slice(start, end).map((text, idx) => `${start + idx + 1}: ${text}`),
			});

			if (hits.length >= maxResults) {
				truncated = true;
				break;
			}
		}

		if (hits.length >= maxResults) break;
	}

	return { hits, scannedFiles, truncated };
}

function buildRepoSearchText(query: string, results: { hits: RepoHit[]; scannedFiles: number; truncated: boolean }, cwd: string): string {
	if (results.hits.length === 0) {
		return `未找到匹配项。\n搜索关键词：${query}\n已扫描文件：${results.scannedFiles}`;
	}

	const lines = [
		`搜索关键词：${query}`,
		`已扫描文件：${results.scannedFiles}`,
		`命中结果：${results.hits.length}${results.truncated ? "（已截断）" : ""}`,
		"",
	];

	results.hits.forEach((hit, index) => {
		const location = hit.line ? `${hit.path}:${hit.line}` : hit.path;
		lines.push(`${index + 1}. [${hit.kind}] ${location}`);
		lines.push(`   ${hit.preview}`);
		if (hit.context && hit.context.length > 0) {
			lines.push(...hit.context.map((line) => `   ${line}`));
		}
		lines.push("");
	});

	if (results.truncated) {
		lines.push("结果已截断，建议缩小搜索范围或增加 maxResults。\n");
	}

	lines.push(`搜索根目录：${cwd}`);
	return lines.join("\n");
}

function parseFreshness(value: WebSearchParams["freshness"]): string | undefined {
	switch (value) {
		case "day":
			return "d";
		case "week":
			return "w";
		case "month":
			return "m";
		case "year":
			return "y";
		default:
			return undefined;
	}
}

function dedupeWebHits(items: WebHit[]): WebHit[] {
	const seen = new Set<string>();
	const output: WebHit[] = [];
	for (const item of items) {
		const key = `${item.url}|${item.title}`;
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(item);
	}
	return output;
}

async function searchWeb(params: WebSearchParams, signal?: AbortSignal): Promise<WebHit[]> {
	const query = params.query.trim();
	if (!query) {
		throw new Error("搜索关键词不能为空");
	}

	const q = params.site?.trim() ? `${query} site:${params.site.trim()}` : query;
	const count = Math.max(1, Math.min(params.count ?? 5, 10));
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", q);
	if (params.language?.trim()) {
		url.searchParams.set("kl", params.language.trim());
	}
	const freshness = parseFreshness(params.freshness);
	if (freshness) {
		url.searchParams.set("df", freshness);
	}

	const response = await fetch(url, {
		signal,
		headers: {
			"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
	});

	if (!response.ok) {
		throw new Error(`Web 搜索失败: HTTP ${response.status}`);
	}

	const html = await response.text();
	const results: WebHit[] = [];
	const blockRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,2500}?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	let match: RegExpExecArray | null;
	while ((match = blockRegex.exec(html)) && results.length < count) {
		results.push({
			title: stripHtml(match[2]),
			url: decodeDuckDuckGoUrl(match[1]),
			snippet: stripHtml(match[3]),
			source: "DuckDuckGo HTML",
		});
	}

	if (results.length === 0) {
		const fallback = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {
			signal,
			headers: { accept: "application/json" },
		});
		if (!fallback.ok) {
			throw new Error(`Web 搜索失败: HTTP ${fallback.status}`);
		}
		const data = (await fallback.json()) as {
			Heading?: string;
			AbstractText?: string;
			AbstractURL?: string;
			RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
		};
		if (data.AbstractText && data.AbstractURL) {
			results.push({
				title: data.Heading || query,
				url: data.AbstractURL,
				snippet: data.AbstractText,
				source: "DuckDuckGo Instant Answer",
			});
		}
		for (const topic of data.RelatedTopics ?? []) {
			if (results.length >= count) break;
			if (!topic.Text || !topic.FirstURL) continue;
			results.push({
				title: topic.Text.split(" - ")[0] || query,
				url: topic.FirstURL,
				snippet: topic.Text,
				source: "DuckDuckGo Instant Answer",
			});
		}
	}

	return dedupeWebHits(results).slice(0, count);
}

function buildWebSearchText(query: string, results: WebHit[]): string {
	if (results.length === 0) {
		return `未找到可用网页结果。\n搜索关键词：${query}`;
	}

	const lines = [`搜索关键词：${query}`, `命中结果：${results.length}`, ""];
	results.forEach((hit, index) => {
		lines.push(`${index + 1}. ${hit.title}`);
		lines.push(`   ${hit.url}`);
		lines.push(`   ${hit.snippet}`);
		lines.push(`   来源：${hit.source}`);
		lines.push("");
	});
	return lines.join("\n");
}

function extractPlanSteps(text: string): PlanStep[] {
	const lines = text.split(/\r?\n/);
	let inPlan = false;
	const steps: PlanStep[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!inPlan && /^plan:\s*$/i.test(line)) {
			inPlan = true;
			continue;
		}
		if (!inPlan) continue;

		const match = line.match(/^(\d+)[\.)]\s+(.*\S)\s*$/);
		if (match) {
			steps.push({
				step: Number(match[1]),
				text: match[2],
				completed: false,
			});
		}
	}

	return steps.sort((a, b) => a.step - b.step);
}

function markDoneSteps(text: string, steps: PlanStep[]): number {
	const matches = [...text.matchAll(/\[DONE:(\d+)\]/g)];
	let changed = 0;
	for (const match of matches) {
		const stepNo = Number(match[1]);
		const step = steps.find((item) => item.step === stepNo);
		if (step && !step.completed) {
			step.completed = true;
			changed += 1;
		}
	}
	return changed;
}

function isAssistantMessage(message: { role?: string; content?: unknown }): message is { role: "assistant"; content: Array<{ type: string; text?: string }> } {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getAssistantText(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function parseWorkflowModelRole(args: string): WorkflowModelRole | "status" | undefined {
	const value = args.trim().toLowerCase();
	if (!value) return undefined;
	if (["plan", "planning", "planner", "计划", "规划"].includes(value)) return "plan";
	if (["exec", "execute", "execution", "executor", "执行"].includes(value)) return "execution";
	if (["status", "状态", "show"].includes(value)) return "status";
	return undefined;
}

function buildRolePickerItems(): PickerItem[] {
	return [
		{ value: "plan", label: "计划模型", description: "进入 /plan 后用于分析、搜索和生成计划" },
		{ value: "execution", label: "执行模型", description: "使用 /plan-execute 后用于修改、实现和验证" },
	];
}

function buildModelPickerItems(ctx: ExtensionContext): PickerItem[] {
	ctx.modelRegistry.refresh();
	const models = ctx.modelRegistry
		.getAvailable()
		.slice()
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	return [
		{ value: "__default__", label: "不自动切换模型", description: "计划/执行模式沿用进入前的当前模型" },
		...models.map((model) => {
			const value = `${model.provider}/${model.id}`;
			const capabilities = [
				model.name && model.name !== model.id ? model.name : undefined,
				model.reasoning ? "thinking" : undefined,
				model.input?.includes("image") ? "image" : undefined,
				model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k ctx` : undefined,
			]
				.filter(Boolean)
				.join(" · ");
			return { value, label: value, description: capabilities };
		}),
	];
}

async function pickItem(ctx: ExtensionContext, title: string, items: PickerItem[], currentValue?: string): Promise<string | null> {
	if (ctx.mode === "tui") {
		return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
			return new SearchablePicker(title, items, currentValue, theme, () => tui.requestRender(), done);
		});
	}

	const labels = items.map((item) => `${item.label}${item.description ? ` — ${item.description}` : ""}`);
	const choice = await ctx.ui.select(title, labels);
	if (!choice) return null;
	const index = labels.indexOf(choice);
	return items[index]?.value ?? null;
}

export default function workflowExtension(pi: ExtensionAPI): void {
	let workflowConfig: WorkflowConfig = {};
	let state: WorkflowState = { mode: "normal" };

	pi.registerFlag("plan", {
		description: "启动计划模式（手动开启）",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "切换计划模式",
		handler: async (_args, ctx) => {
			if (state.mode === "plan") {
				await exitPlanMode(ctx);
				ctx.ui.notify("计划模式已关闭", "info");
				return;
			}

			if (state.mode === "execution") {
				await exitExecutionMode(ctx, true);
			}

			await enterPlanMode(ctx);
			ctx.ui.notify("计划模式已开启", "info");
		},
	});

	pi.registerCommand("plan-status", {
		description: "查看计划模式状态",
		handler: async (_args, ctx) => {
			const mode = state.mode;
			const total = state.planSteps?.length ?? 0;
			const done = state.planSteps?.filter((item) => item.completed).length ?? 0;
			const planModel = formatModelRef(state.planModel ?? parseModelRef(workflowConfig.planModel, workflowConfig.defaultProvider)) ?? "未设置";
			const executionModel =
				formatModelRef(state.executionModel ?? parseModelRef(workflowConfig.executionModel, workflowConfig.defaultProvider)) ??
				"未设置";
			ctx.ui.notify(
				`当前模式：${mode}\n计划步骤：${done}/${total}\n计划模型：${planModel}\n执行模型：${executionModel}`,
				"info",
			);
		},
	});

	pi.registerCommand("plan-model", {
		description: "选择计划模式的计划模型或执行模型",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("当前模式不支持交互式模型选择，请直接编辑 settings.json 的 planModel/executionModel。", "warning");
				return;
			}

			const parsedRole = parseWorkflowModelRole(args);
			if (parsedRole === "status") {
				const planModel = parseModelRef(workflowConfig.planModel, workflowConfig.defaultProvider);
				const executionModel = parseModelRef(workflowConfig.executionModel, workflowConfig.defaultProvider);
				ctx.ui.notify(
					`计划模型：${formatModelRef(planModel) ?? "未设置"}\n执行模型：${formatModelRef(executionModel) ?? "未设置"}`,
					"info",
				);
				return;
			}

			let role = parsedRole;
			if (!role) {
				const selectedRole = await pickItem(ctx, "选择要配置的计划模式模型", buildRolePickerItems());
				if (selectedRole !== "plan" && selectedRole !== "execution") return;
				role = selectedRole;
			}

			const key = getWorkflowModelConfigKey(role);
			const currentModel = parseModelRef(workflowConfig[key], workflowConfig.defaultProvider);
			const selectedModel = await pickItem(
				ctx,
				`选择${getWorkflowModelRoleLabel(role)}（类似 /model，可输入关键词过滤）`,
				buildModelPickerItems(ctx),
				formatModelRef(currentModel) ?? "__default__",
			);
			if (!selectedModel) return;

			const modelRef = selectedModel === "__default__" ? undefined : parseModelRef(selectedModel);
			try {
				workflowConfig = { ...workflowConfig, ...saveWorkflowModelConfig(role, modelRef), [key]: formatModelRef(modelRef) };
			} catch (error) {
				ctx.ui.notify(`保存模型配置失败：${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (role === "plan") {
				state.planModel = modelRef;
			} else {
				state.executionModel = modelRef;
			}

			if (modelRef && ((state.mode === "plan" && role === "plan") || (state.mode === "execution" && role === "execution"))) {
				await setModelByRef(ctx, modelRef);
			}
			if (state.mode !== "normal") {
				persistState();
			}
			ctx.ui.notify(
				`${getWorkflowModelRoleLabel(role)}已设置为：${formatModelRef(modelRef) ?? "不自动切换"}`,
				"info",
			);
		},
		getArgumentCompletions: (prefix: string) => {
			const items = ["plan", "execution", "status"];
			return items
				.filter((item) => item.startsWith(prefix.trim().toLowerCase()))
				.map((item) => ({ value: item, label: item }));
		},
	});

	pi.registerCommand("plan-execute", {
		description: "将当前计划切换到执行模式",
		handler: async (_args, ctx) => {
			if (state.mode !== "plan") {
				ctx.ui.notify("请先使用 /plan 进入计划模式", "warning");
				return;
			}

			await enterExecutionMode(ctx);
			ctx.ui.notify("已切换到执行模式", "info");
		},
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "切换计划模式",
		handler: async (ctx) => {
			if (state.mode === "plan") {
				await exitPlanMode(ctx);
				return;
			}
			if (state.mode === "execution") {
				await exitExecutionMode(ctx, true);
				return;
			}
			await enterPlanMode(ctx);
		},
	});

	pi.registerTool({
		name: "repo_search",
		label: "Repo Search",
		description: "在当前仓库中搜索文件名或内容，返回路径、行号和上下文。",
		promptSnippet: "Search the repository for file names or content before reading many files.",
		promptGuidelines: [
			"Use repo_search first when locating code, files, symbols, or configuration in the repository.",
			"Use repo_search instead of ad hoc bash grep/find when you need structured search results.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "要搜索的关键词" }),
			path: Type.Optional(Type.String({ description: "可选的搜索根目录，默认为当前仓库" })),
			maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
			includeContent: Type.Optional(Type.Boolean({ description: "是否搜索文件内容" })),
			includeFileNames: Type.Optional(Type.Boolean({ description: "是否搜索文件名" })),
			extensions: Type.Optional(Type.Array(Type.String(), { description: "仅搜索这些后缀" })),
		}),
		async execute(_toolCallId, params: RepoSearchParams, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "正在搜索仓库..." }], details: {} });
			const results = await searchRepository(ctx, params, signal);
			return {
				content: [{ type: "text", text: buildRepoSearchText(params.query, results, ctx.cwd) }],
				details: results,
			};
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "执行网页搜索，返回标题、摘要、链接和来源。",
		promptSnippet: "Search the web when you need external documentation, fresh information, or confirmation.",
		promptGuidelines: [
			"Use web_search when you need external documentation, recent information, or confirmation beyond the repository.",
			"Do not treat web_search results as authoritative until they are checked against the source pages.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "要搜索的关键词" }),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
			language: Type.Optional(Type.String({ description: "语言/地区，例如 us-en、zh-cn" })),
			freshness: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
			site: Type.Optional(Type.String({ description: "限定站点，例如 github.com" })),
		}),
		async execute(_toolCallId, params: WebSearchParams, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "正在搜索网页..." }], details: {} });
			const results = await searchWeb(params, signal);
			return {
				content: [{ type: "text", text: buildWebSearchText(params.query, results) }],
				details: { query: params.query, results },
			};
		},
	});

	function persistState(): void {
		pi.appendEntry(WORKFLOW_STATE_TYPE, state);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (state.mode === "plan") {
			ctx.ui.setStatus("workflow", ctx.ui.theme.fg("warning", "📝 plan"));
			const steps = state.planSteps ?? [];
			if (steps.length > 0) {
				const done = steps.filter((item) => item.completed).length;
				ctx.ui.setWidget(
					"workflow-plan",
					steps.map((item) => `${item.completed ? "☑" : "☐"} ${item.step}. ${item.text}`),
				);
				ctx.ui.setStatus("workflow-progress", ctx.ui.theme.fg("accent", `📋 ${done}/${steps.length}`));
			} else {
				ctx.ui.setWidget("workflow-plan", undefined);
				ctx.ui.setStatus("workflow-progress", undefined);
			}
			return;
		}

		if (state.mode === "execution") {
			const steps = state.planSteps ?? [];
			const done = steps.filter((item) => item.completed).length;
			ctx.ui.setStatus("workflow", ctx.ui.theme.fg("success", "▶ exec"));
			ctx.ui.setStatus("workflow-progress", ctx.ui.theme.fg("accent", `📋 ${done}/${steps.length}`));
			ctx.ui.setWidget(
				"workflow-plan",
				steps.map((item) => `${item.completed ? "☑" : "☐"} ${item.step}. ${item.text}`),
			);
			return;
		}

		ctx.ui.setStatus("workflow", undefined);
		ctx.ui.setStatus("workflow-progress", undefined);
		ctx.ui.setWidget("workflow-plan", undefined);
	}

	async function setModelByRef(ctx: ExtensionContext, modelRef: ModelRef | undefined): Promise<void> {
		if (!modelRef) return;
		const model = ctx.modelRegistry.find(modelRef.provider, modelRef.id);
		if (!model) {
			ctx.ui.notify(`未找到模型: ${modelRef.provider}/${modelRef.id}`, "warning");
			return;
		}
		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`模型不可用或缺少鉴权: ${modelRef.provider}/${modelRef.id}`, "warning");
		}
	}

	async function enterPlanMode(ctx: ExtensionContext): Promise<void> {
		if (state.mode === "plan") return;
		state = {
			mode: "plan",
			planSteps: [],
			toolsBeforePlan: pi.getActiveTools(),
			originalModel: toModelRef(ctx.model),
			planModel: parseModelRef(workflowConfig.planModel, workflowConfig.defaultProvider),
			executionModel: parseModelRef(workflowConfig.executionModel, workflowConfig.defaultProvider),
		};

		const nextTools = removeWriteTools(state.toolsBeforePlan ?? pi.getActiveTools());
		pi.setActiveTools(ensureCustomTools(nextTools));
		await setModelByRef(ctx, state.planModel);
		updateStatus(ctx);
		persistState();
	}

	async function enterExecutionMode(ctx: ExtensionContext): Promise<void> {
		if (state.mode !== "plan") return;
		state.mode = "execution";
		const nextTools = addWriteTools(state.toolsBeforePlan ?? pi.getActiveTools());
		pi.setActiveTools(ensureCustomTools(nextTools));
		await setModelByRef(ctx, state.executionModel);
		updateStatus(ctx);
		persistState();
	}

	async function exitPlanMode(ctx: ExtensionContext): Promise<void> {
		if (state.mode !== "plan") return;
		const originalTools = state.toolsBeforePlan ?? pi.getActiveTools();
		const originalModel = state.originalModel;
		pi.setActiveTools(ensureCustomTools(originalTools));
		state = { mode: "normal" };
		await setModelByRef(ctx, originalModel);
		updateStatus(ctx);
		persistState();
	}

	async function exitExecutionMode(ctx: ExtensionContext, restoreModel: boolean): Promise<void> {
		if (state.mode !== "execution") return;
		const originalTools = state.toolsBeforePlan ?? pi.getActiveTools();
		pi.setActiveTools(ensureCustomTools(originalTools));
		const originalModel = state.originalModel;
		state = { mode: "normal" };
		if (restoreModel) {
			await setModelByRef(ctx, originalModel);
		}
		updateStatus(ctx);
		persistState();
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const targetPath = String(event.input.path ?? "");
			if (!targetPath) return undefined;

			if (state.mode === "plan") {
				return {
					block: true,
					reason: `计划模式下禁止修改文件：${targetPath}`,
				};
			}

			if (hasProtectedPath(resolve(ctx.cwd, targetPath))) {
				return {
					block: true,
					reason: `受保护路径禁止写入：${targetPath}`,
				};
			}
		}

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			if (state.mode === "plan" && !isPlanModeSafeCommand(command)) {
				return {
					block: true,
					reason: `计划模式仅允许只读命令：${command}`,
				};
			}

			if (state.mode !== "plan" && isDangerousCommand(command)) {
				if (!ctx.hasUI) {
					return { block: true, reason: `高风险命令已阻止：${command}` };
				}
				const ok = await ctx.ui.confirm("高风险命令", `是否允许执行以下命令？\n\n${command}`);
				if (!ok) {
					return { block: true, reason: `用户拒绝执行高风险命令：${command}` };
				}
			}
		}

		return undefined;
	});

	pi.on("before_agent_start", async (event) => {
		const hasRepoSearch = event.systemPromptOptions.selectedTools?.includes("repo_search") ?? false;
		const hasWebSearch = event.systemPromptOptions.selectedTools?.includes("web_search") ?? false;
		const guidance: string[] = [];

		if (state.mode === "plan") {
			guidance.push(
				"你现在处于计划模式。",
				"只做分析和规划，不要编辑或写入文件。",
				"优先使用 repo_search 和 read 收集上下文；需要外部资料时可使用 web_search。",
				"输出一个结构化的 Plan: 段落，并使用 1、2、3 这样的编号步骤。",
				"计划完成后，等待用户使用 /plan-execute 切换到执行模式。",
			);
		} else if (state.mode === "execution") {
			guidance.push(
				"你现在处于执行模式。",
				"根据当前计划逐步实现，尽量保持改动最小且可验证。",
				"每完成一个计划步骤，在回复中标记 [DONE:n]。",
				"优先使用 repo_search 定位代码，使用 read 查看内容，使用 write/edit 进行修改。",
			);
		} else {
			guidance.push(
				"默认工作流已增强。",
				"定位代码或配置时优先使用 repo_search，再用 read 查看具体内容。",
				"需要外部资料、文档或最新信息时使用 web_search。",
				"修改文件前先确认上下文，尽量使用最小化编辑。",
				"如果用户要求计划，请先使用 /plan 进入计划模式。",
			);
		}

		if (hasRepoSearch) {
			guidance.push("repo_search 已可用，可用于文件名、内容、上下文搜索。");
		}
		if (hasWebSearch) {
			guidance.push("web_search 已可用，可用于外部资料检索。");
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n## 工作流增强\n${guidance.map((line) => `- ${line}`).join("\n")}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		workflowConfig = loadWorkflowConfig(ctx.cwd);
		const entries = ctx.sessionManager.getEntries();
		const lastState = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === WORKFLOW_STATE_TYPE) as
			| { data?: WorkflowState }
			| undefined;

		if (lastState?.data) {
			state = {
				mode: lastState.data.mode ?? "normal",
				planSteps: lastState.data.planSteps ?? [],
				toolsBeforePlan: normalizePathList(lastState.data.toolsBeforePlan),
				originalModel: lastState.data.originalModel,
				planModel: parseModelRef(workflowConfig.planModel, workflowConfig.defaultProvider),
				executionModel: parseModelRef(workflowConfig.executionModel, workflowConfig.defaultProvider),
			};
		} else {
			state = { mode: "normal" };
		}

		if (pi.getFlag("plan") === true && state.mode === "normal") {
			await enterPlanMode(ctx);
			return;
		}

		if (state.mode === "normal") {
			pi.setActiveTools(ensureCustomTools(pi.getActiveTools()));
		}

		if (state.mode === "plan") {
			pi.setActiveTools(ensureCustomTools(removeWriteTools(state.toolsBeforePlan ?? pi.getActiveTools())));
			await setModelByRef(ctx, state.planModel);
		}

		if (state.mode === "execution") {
			pi.setActiveTools(ensureCustomTools(addWriteTools(state.toolsBeforePlan ?? pi.getActiveTools())));
			await setModelByRef(ctx, state.executionModel);
		}

		updateStatus(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (state.mode !== "execution") return;
		if (!isAssistantMessage(event.message)) return;

		const text = getAssistantText(event.message);
		if (markDoneSteps(text, state.planSteps ?? []) > 0) {
			updateStatus(ctx);
			persistState();
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.mode === "plan") {
			const lastAssistant = [...event.messages].reverse().find((message) =>
				isAssistantMessage(message as { role?: string; content?: unknown }),
			) as { role: "assistant"; content: Array<{ type: string; text?: string }> } | undefined;
			if (lastAssistant) {
				const steps = extractPlanSteps(getAssistantText(lastAssistant));
				if (steps.length > 0) {
					state.planSteps = steps;
					updateStatus(ctx);
					persistState();
					ctx.ui.notify(`已解析计划步骤：${steps.length} 步，可使用 /plan-execute 进入执行模式。`, "info");
				}
			}
			return;
		}

		if (state.mode === "execution") {
			const steps = state.planSteps ?? [];
			if (steps.length > 0 && steps.every((item) => item.completed)) {
				ctx.ui.notify("计划步骤已完成，正在恢复正常模式。", "info");
				await exitExecutionMode(ctx, true);
			}
		}
	});
}
