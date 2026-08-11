/// <reference path="../../types.d.ts" />
/**
 * custom_provider - 通用自定义 Provider 注册扩展
 *
 * 从 custom_provider.json 读取 provider 参数，逐个调用 pi.registerProvider() 注册。
 * 适合代理转发、自建端点、OpenAI 兼容服务等场景，无需写代码即可增删 provider / 模型。
 *
 * 模型来源有两种，可混用：
 *   1. 静态 models：JSON 里显式列出，作为拉取失败时的兜底。
 *   2. 自动拉取（fetchModels）：GET {baseUrl}/models（或自定义 URL）获取该 provider
 *      拥有的模型列表。启用方式（详见 README「自动拉取模型」）：
 *        - 显式设置 "fetchModels": true、 "fetchModels": "<url>" 或 "fetchModels": false；
 *        - 未设置时：若没有静态 models 且 provider id 不是 pi 内置 provider，自动启用。
 *      拉取结果在启动阶段（async 工厂）注册，并接入 pi 的 refreshModels 生命周期，
 *      启动 / 刷新模型列表时自动更新，无需重启。
 *
 * 配置文件查找顺序（取第一个存在者）：
 *   1. 环境变量 $PI_CUSTOM_PROVIDER_CONFIG 指向的路径
 *   2. $PI_CODING_AGENT_DIR/custom_provider.json
 *   3. 当前工作目录 custom_provider.json
 *   4. 本扩展目录 custom_provider.json
 *   5. 本扩展目录上级两级（agentDir 根目录）custom_provider.json
 *
 * 支持三种配置结构：
 *   A. 顶层数组:  [{ "id": "my-llm", "baseUrl": "...", ... }, ...]
 *   B. 显式数组:  { "providers": [ { "id": "...", ... }, ... ] }
 *   C. 对象映射:  { "my-llm": { "baseUrl": "...", ... }, ... }  （键名即 provider id）
 *
 * apiKey 与自定义 header 值沿用 pi 的配置取值语法：
 *   字面量、"$ENV_VAR" 或 "${ENV_VAR}" 环境变量插值、"!command" 命令输出。
 * 含函数的字段（oauth、streamSimple）无法用 JSON 表达，本扩展不处理。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const TAG = "[custom_provider]";
const CONFIG_FILE = "custom_provider.json";

/** 拉取模型列表的请求超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 15_000;
/** 工厂阶段刚拉取过模型时，refreshModels 在 N 毫秒内跳过联网拉取，避免启动时重复请求。 */
const FETCH_FRESH_MS = 60_000;

/** pi 内置的 API 类型（与文档 Custom Providers 一致）。未知值会告警但不阻止注册。 */
const KNOWN_APIS = new Set<string>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"mistral-conversations",
	"google-generative-ai",
	"google-vertex",
	"bedrock-converse-stream",
]);

/**
 * pi 内置 provider id（来自 pi-ai 的 KnownProvider 列表）。
 * 覆盖这些 provider（代理转发场景）时默认不自动拉取，保持「原有模型保留、流量改走新端点」的语义。
 */
const KNOWN_PROVIDER_IDS = new Set<string>([
	"amazon-bedrock", "ant-ling", "anthropic", "google", "google-vertex", "openai",
	"azure-openai-responses", "openai-codex", "radius", "nvidia", "deepseek",
	"github-copilot", "xai", "groq", "cerebras", "openrouter", "vercel-ai-gateway",
	"zai", "zai-coding-cn", "mistral", "minimax", "minimax-cn", "moonshotai",
	"moonshotai-cn", "huggingface", "fireworks", "together", "baseten", "opencode",
	"opencode-go", "kimi-coding", "cloudflare-workers-ai", "cloudflare-ai-gateway",
	"qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual",
	"xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
]);

/** pi api 值 → 远端模型条目 supported_endpoint_types 里的端点类型名（用于按 api 过滤远端模型）。 */
const API_ENDPOINT_TYPES: Record<string, string> = {
	"openai-completions": "openai",
	"openai-responses": "openai",
	"openai-codex-responses": "openai",
	"azure-openai-responses": "openai",
	"mistral-conversations": "openai",
	"anthropic-messages": "anthropic",
	"google-generative-ai": "google",
	"google-vertex": "vertex-ai",
	"bedrock-converse-stream": "bedrock",
};

/**
 * 拉取结果磁盘缓存。pi 在同一进程内会多次加载扩展（参数解析/信任检查阶段 + 启动阶段），
 * 且每次加载都是全新模块实例，进程内缓存无法共享；磁盘缓存让第二次加载直接复用第一次的拉取结果。
 */
const DISK_CACHE_PATH = path.join(os.tmpdir(), "pi-custom-provider-models.json");

interface DiskCacheEntry {
	/** 拉取完成时间戳（ms） */
	at: number;
	/** 拉取用的 URL（配置变化时缓存自然失效） */
	url: string;
	models: ProviderModelConfig[];
}

type DiskCache = Record<string, DiskCacheEntry>;

function loadDiskCache(): DiskCache {
	try {
		const parsed = JSON.parse(fs.readFileSync(DISK_CACHE_PATH, "utf-8")) as unknown;
		return isRecord(parsed) ? (parsed as unknown as DiskCache) : {};
	} catch {
		return {};
	}
}

function saveDiskCache(providerId: string, entry: DiskCacheEntry): void {
	try {
		const cache = loadDiskCache();
		cache[providerId] = entry;
		const tmp = `${DISK_CACHE_PATH}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(cache));
		fs.renameSync(tmp, DISK_CACHE_PATH);
	} catch {
		// 缓存写入失败不影响功能
	}
}

// ---------------------------------------------------------------------------
// 类型收窄工具
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown): boolean {
	return v === true;
}

function recordOf(v: unknown): Record<string, string> | undefined {
	if (!isRecord(v)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v)) {
		if (typeof val === "string") out[k] = val;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

/** 宽松的 JSON 模型定义（运行时校验，不做严格类型断言）。兼容驼峰与蛇形字段名。 */
interface RawModelConfig {
	id?: unknown;
	name?: unknown;
	api?: unknown;
	baseUrl?: unknown;
	reasoning?: unknown;
	thinkingLevelMap?: unknown;
	input?: unknown;
	input_modalities?: unknown;
	cost?: unknown;
	contextWindow?: unknown;
	context_window?: unknown;
	maxTokens?: unknown;
	max_tokens?: unknown;
	headers?: unknown;
	compat?: unknown;
	samplingParams?: unknown;
}

/** 宽松的 JSON provider 定义。 */
interface RawProviderConfig {
	id?: unknown;
	name?: unknown;
	baseUrl?: unknown;
	apiKey?: unknown;
	api?: unknown;
	authHeader?: unknown;
	headers?: unknown;
	models?: unknown;
	/** 模型自动拉取开关：true / false / 模型列表 URL。缺省时按「无静态 models 且非内置 provider」自动启用。 */
	fetchModels?: unknown;
}

function normalizeCost(raw: unknown): ProviderModelConfig["cost"] {
	const costRaw = isRecord(raw) ? raw : {};
	const cost: ProviderModelConfig["cost"] = {
		input: num(costRaw.input, 0),
		output: num(costRaw.output, 0),
		cacheRead: num(costRaw.cacheRead, 0),
		cacheWrite: num(costRaw.cacheWrite, 0),
	};
	if (Array.isArray(costRaw.tiers)) {
		const tiers = costRaw.tiers
			.filter(isRecord)
			.map((t) => ({
				inputTokensAbove: num(t.inputTokensAbove, 0),
				input: num(t.input, 0),
				output: num(t.output, 0),
				cacheRead: num(t.cacheRead, 0),
				cacheWrite: num(t.cacheWrite, 0),
			}));
		if (tiers.length > 0) cost.tiers = tiers;
	}
	return cost;
}

function normalizeModel(raw: unknown): ProviderModelConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const id = str(raw.id);
	if (!id) return undefined;

	const rawInput = Array.isArray(raw.input)
		? raw.input
		: Array.isArray(raw.input_modalities)
			? raw.input_modalities
			: [];
	const input = rawInput.filter((x) => x === "text" || x === "image") as ("text" | "image")[];

	return {
		id,
		name: str(raw.name) ?? id,
		reasoning: bool(raw.reasoning),
		input: input.length > 0 ? input : ["text"],
		cost: normalizeCost(raw.cost),
		contextWindow: num(raw.contextWindow, num(raw.context_window, 128000)),
		maxTokens: num(raw.maxTokens, num(raw.max_tokens, 4096)),
		...(str(raw.api) ? { api: raw.api as ProviderModelConfig["api"] } : {}),
		...(str(raw.baseUrl) ? { baseUrl: raw.baseUrl as string } : {}),
		...(isRecord(raw.thinkingLevelMap)
			? { thinkingLevelMap: raw.thinkingLevelMap as ProviderModelConfig["thinkingLevelMap"] }
			: {}),
		...(recordOf(raw.headers) ? { headers: recordOf(raw.headers)! } : {}),
		...(isRecord(raw.compat) ? { compat: raw.compat as ProviderModelConfig["compat"] } : {}),
		...(isRecord(raw.samplingParams)
			? { samplingParams: raw.samplingParams as Record<string, unknown> }
			: {}),
	};
}

interface FetchMode {
	enabled: boolean;
	/** 自定义模型列表 URL（fetchModels 为字符串时）。缺省用 {baseUrl}/models。 */
	url?: string;
}

/** 解析 fetchModels 字段。缺省时：无静态 models 且非 pi 内置 provider → 自动启用。 */
function resolveFetchMode(raw: RawProviderConfig | undefined, hasStaticModels: boolean, id: string): FetchMode {
	const v = raw?.fetchModels;
	if (v === true) return { enabled: true };
	if (typeof v === "string" && v.trim().length > 0) return { enabled: true, url: v.trim() };
	if (v !== undefined && v !== false) {
		console.warn(`${TAG} "${id}": fetchModels 值无法识别（仅支持 true / false / URL 字符串），按 false 处理。`);
	}
	if (v !== undefined) return { enabled: false };
	return { enabled: !hasStaticModels && !KNOWN_PROVIDER_IDS.has(id) };
}

interface NormalizedProvider {
	id: string;
	config: ProviderConfig;
	raw: RawProviderConfig;
	fetch: FetchMode;
}

function normalizeProvider(raw: unknown, fallbackId?: string): NormalizedProvider | undefined {
	if (!isRecord(raw)) return undefined;
	const id = str(raw.id) ?? fallbackId;
	if (!id) return undefined;

	const baseUrl = str(raw.baseUrl);
	const api = str(raw.api);
	const models = Array.isArray(raw.models)
		? raw.models
				.map((m) => normalizeModel(m))
				.filter((m): m is ProviderModelConfig => m !== undefined)
		: [];

	const fetch = resolveFetchMode(raw as RawProviderConfig, models.length > 0, id);

	if (!baseUrl) {
		if (models.length > 0 || fetch.enabled) {
			console.warn(`${TAG} 跳过 "${id}": 缺少 baseUrl（定义 models 或启用 fetchModels 时必填）。`);
		} else {
			console.warn(`${TAG} 跳过 "${id}": baseUrl、models、fetchModels 均为空，无法注册。`);
		}
		return undefined;
	}
	if (api && !KNOWN_APIS.has(api)) {
		console.warn(
			`${TAG} "${id}": api "${api}" 不在内置列表中，需要配合自定义 streamSimple 才能流式输出（JSON 配置无法表达函数）。`,
		);
	}

	const config: ProviderConfig = {
		...(str(raw.name) ? { name: raw.name as string } : {}),
		...(baseUrl ? { baseUrl } : {}),
		...(str(raw.apiKey) ? { apiKey: raw.apiKey as string } : {}),
		...(api ? { api: api as ProviderConfig["api"] } : {}),
		...(bool(raw.authHeader) ? { authHeader: true } : {}),
		...(recordOf(raw.headers) ? { headers: recordOf(raw.headers)! } : {}),
		...(models.length > 0 ? { models } : {}),
	};
	return { id, config, raw: raw as RawProviderConfig, fetch };
}

/** 从解析后的 JSON 提取 provider 列表，兼容数组 / {providers} / 映射三种结构。 */
function parseProviders(parsed: unknown): NormalizedProvider[] {
	if (Array.isArray(parsed)) {
		return parsed
			.map((p) => normalizeProvider(p))
			.filter((x): x is NormalizedProvider => x !== undefined);
	}
	if (!isRecord(parsed)) return [];

	// 显式 { "providers": [...] } 结构优先
	if (Array.isArray(parsed.providers)) {
		return parsed.providers
			.map((p) => normalizeProvider(p))
			.filter((x): x is NormalizedProvider => x !== undefined);
	}

	// 对象映射：{ "<provider-id>": { ... } }
	const out: NormalizedProvider[] = [];
	for (const [key, value] of Object.entries(parsed)) {
		if (key === "$schema" || key === "providers") continue;
		const norm = normalizeProvider(value, key);
		if (norm) out.push(norm);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 配置文件定位
// ---------------------------------------------------------------------------

function findConfigPath(): string | undefined {
	const candidates: string[] = [];

	const envPath = process.env.PI_CUSTOM_PROVIDER_CONFIG;
	if (envPath) candidates.push(envPath);

	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir) candidates.push(path.join(agentDir, CONFIG_FILE));

	// 当前工作目录（与用户放置 custom_provider.json 的约定一致）
	candidates.push(path.join(process.cwd(), CONFIG_FILE));

	// 本扩展目录（extensions/custom_provider/custom_provider.json）
	candidates.push(path.join(import.meta.dirname, CONFIG_FILE));

	// agentDir 根目录（extensions/custom_provider/ 的上级两级）
	candidates.push(path.join(import.meta.dirname, "..", "..", CONFIG_FILE));

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// 忽略无法访问的候选路径
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// 配置值解析（与 pi 的 apiKey/header 取值语法一致）
// ---------------------------------------------------------------------------

function resolveEnvValue(name: string, env: Record<string, string | undefined>): string | undefined {
	return env[name] ?? process.env[name];
}

/** 解析字面量 + $ENV_VAR / ${ENV_VAR} 插值。任一环境变量缺失时整体返回 undefined（该 header 不发送）。 */
function resolveTemplateValue(value: string, env: Record<string, string | undefined>): string | undefined {
	let out = "";
	let i = 0;
	while (i < value.length) {
		const d = value.indexOf("$", i);
		if (d < 0) {
			out += value.slice(i);
			break;
		}
		out += value.slice(i, d);
		const next = value[d + 1];
		if (next === "$" || next === "!") {
			out += next; // $$ / $! 转义为字面量
			i = d + 2;
			continue;
		}
		if (next === "{") {
			const end = value.indexOf("}", d + 2);
			if (end < 0) {
				out += "$";
				i = d + 1;
				continue;
			}
			const name = value.slice(d + 2, end);
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
				const v = resolveEnvValue(name, env);
				if (v === undefined) return undefined;
				out += v;
				i = end + 1;
			} else {
				out += value.slice(d, end + 1);
				i = end + 1;
			}
			continue;
		}
		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(d + 1));
		if (match) {
			const v = resolveEnvValue(match[0], env);
			if (v === undefined) return undefined;
			out += v;
			i = d + 1 + match[0].length;
		} else {
			out += "$";
			i = d + 1;
		}
	}
	return out;
}

/** 解析配置值：!command 取命令 stdout（去首尾空白）；否则按模板插值。解析失败返回 undefined。 */
function resolveConfigValue(value: string, env: Record<string, string | undefined>): string | undefined {
	if (value.startsWith("!")) {
		try {
			const out = execSync(value.slice(1), {
				encoding: "utf-8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			return (typeof out === "string" ? out : String(out)).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	return resolveTemplateValue(value, env);
}

// ---------------------------------------------------------------------------
// 模型自动拉取
// ---------------------------------------------------------------------------

/** 组装模型列表 URL：显式 URL 直接用；否则 {baseUrl}/models（baseUrl 已以 /models 结尾时不重复追加）。 */
function buildModelsUrl(baseUrl: string, explicitUrl?: string): string {
	if (explicitUrl) return explicitUrl;
	const base = baseUrl.replace(/\/+$/, "");
	return base.endsWith("/models") ? base : `${base}/models`;
}

/** 从远端响应提取模型条目数组，兼容 {data:[...]}（OpenAI 风格）/ {models:[...]} / 顶层数组。 */
function extractModelEntries(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isRecord(payload)) return [];
	if (Array.isArray(payload.data)) return payload.data;
	if (Array.isArray(payload.models)) return payload.models;
	if (Array.isArray(payload.result)) return payload.result;
	return [];
}

/** 明确标注为不可对话的条目类型（embedding、语音、图像生成、重排等），拉取时直接跳过。 */
const SKIPPED_MODEL_TYPES = new Set(["embedding", "moderation", "image", "tts", "stt", "rerank", "audio"]);

/** 跳过明确标注为不可对话的条目（embedding、语音、图像生成、重排等），它们无法用于流式对话。 */
function isSkippableRemoteModel(raw: Record<string, unknown>): boolean {
	const type = str(raw.type);
	const mode = str(raw.mode);
	return (type !== undefined && SKIPPED_MODEL_TYPES.has(type)) || (mode !== undefined && SKIPPED_MODEL_TYPES.has(mode));
}

/**
 * 部分网关（如中转服务）会在模型条目里带 supported_endpoint_types 字段。
 * 若字段词汇可识别（至少一个条目匹配当前 api 对应的端点类型），则只保留声明支持该端点类型的条目；
 * 未声明该字段的条目视为兼容，全部保留。若没有任何条目匹配（字段词汇不同/未知），不筛选。
 */
function filterByEndpointType(
	entries: Record<string, unknown>[],
	api: string | undefined,
): Record<string, unknown>[] {
	const endpointType = api ? API_ENDPOINT_TYPES[api] : undefined;
	if (!endpointType) return entries;
	const typed = entries.filter(
		(e) => Array.isArray(e.supported_endpoint_types) && (e.supported_endpoint_types as unknown[]).length > 0,
	);
	if (typed.length === 0) return entries;
	const matching = typed.filter((e) => (e.supported_endpoint_types as unknown[]).includes(endpointType));
	if (matching.length === 0) return entries;
	const untyped = entries.filter(
		(e) => !(Array.isArray(e.supported_endpoint_types) && (e.supported_endpoint_types as unknown[]).length > 0),
	);
	return [...matching, ...untyped];
}

/** 拉取并规范化远端模型列表。失败（网络错误 / 非 2xx / 解析不到模型）时抛错。 */
async function fetchRemoteModels(
	url: string,
	api: string | undefined,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<ProviderModelConfig[]> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetch(url, { headers, signal: AbortSignal.any([signal, timeout]) });
	if (!response.ok) {
		throw new Error(`GET ${url} 失败: HTTP ${response.status} ${response.statusText}`);
	}
	const payload = (await response.json()) as unknown;
	const entries = extractModelEntries(payload)
		.filter((e): e is Record<string, unknown> => isRecord(e))
		.filter((e) => !isSkippableRemoteModel(e));
	const filtered = filterByEndpointType(entries, api);
	const models = filtered
		.map((e) => normalizeModel(e))
		.filter((m): m is ProviderModelConfig => m !== undefined);
	if (models.length === 0) {
		throw new Error(`GET ${url} 未解析到任何可用模型（共 ${entries.length} 个条目被跳过）`);
	}
	return models;
}

/** 组装拉取模型列表用的请求头：自定义 headers（$ENV 插值，缺失跳过）+ Authorization: Bearer <apiKey>。 */
function buildFetchHeaders(
	raw: RawProviderConfig,
	key: string | undefined,
	extraEnv: Record<string, string | undefined>,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw.headers ?? {})) {
		const resolved = resolveConfigValue(value, extraEnv);
		if (resolved !== undefined) headers[name] = resolved;
	}
	if (key && !Object.keys(headers).some((n) => n.toLowerCase() === "authorization")) {
		headers["Authorization"] = `Bearer ${key}`;
	}
	return headers;
}

/** 将 pi 持久化/运行时使用的 Model 对象转回 ProviderModelConfig（refreshModels 返回类型）。 */
interface StoredModelLike {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: readonly unknown[];
	cost?: Record<string, unknown>;
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Record<string, unknown>;
	headers?: Record<string, unknown>;
	compat?: Record<string, unknown>;
	samplingParams?: Record<string, unknown>;
}

function modelToConfig(m: StoredModelLike): ProviderModelConfig {
	return {
		id: m.id,
		name: typeof m.name === "string" ? m.name : m.id,
		reasoning: m.reasoning === true,
		input: Array.isArray(m.input)
			? (m.input.filter((x) => x === "text" || x === "image") as ("text" | "image")[])
			: ["text"],
		cost: normalizeCost(m.cost),
		contextWindow: num(m.contextWindow, 128000),
		maxTokens: num(m.maxTokens, 4096),
		...(typeof m.api === "string" ? { api: m.api as ProviderModelConfig["api"] } : {}),
		...(typeof m.baseUrl === "string" ? { baseUrl: m.baseUrl } : {}),
		...(isRecord(m.thinkingLevelMap)
			? { thinkingLevelMap: m.thinkingLevelMap as ProviderModelConfig["thinkingLevelMap"] }
			: {}),
		...(isRecord(m.headers) ? { headers: m.headers as Record<string, string> } : {}),
		...(isRecord(m.compat) ? { compat: m.compat as ProviderModelConfig["compat"] } : {}),
		...(isRecord(m.samplingParams) ? { samplingParams: m.samplingParams as Record<string, unknown> } : {}),
	};
}

interface RefreshRuntime {
	id: string;
	baseUrl: string;
	fetchUrl?: string;
	api?: string;
	raw: RawProviderConfig;
}

/**
 * 构造 refreshModels 回调，接入 pi 的模型刷新生命周期：
 *   - 离线阶段（allowNetwork=false，启动/恢复时）：恢复上次持久化的模型列表；
 *   - 联网阶段（allowNetwork=true）：用 pi 已解析的凭证拉取最新列表；
 *   - 返回 undefined 表示「保持当前模型不变」（pi 用返回值替换扩展模型，空数组会清空模型）。
 */
function buildRefreshModels(rt: RefreshRuntime) {
	return async (
		context: Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0],
	): Promise<ProviderModelConfig[] | undefined> => {
		if (!context.allowNetwork) {
			const stored = context.stored;
			if (!stored || stored.models.length === 0) return undefined;
			return stored.models
				.filter((m) => m.provider === rt.id)
				.map((m) => modelToConfig(m as unknown as StoredModelLike));
		}

		if (context.signal.aborted) return undefined;

		// 启动时工厂阶段刚拉取过（同一进程内多次加载扩展），跳过重复请求（除非强制刷新）
		if (!context.force) {
			const url = buildModelsUrl(rt.baseUrl, rt.fetchUrl);
			const cached = loadDiskCache()[rt.id];
			if (cached !== undefined && cached.url === url && Date.now() - cached.at < FETCH_FRESH_MS) {
				return undefined;
			}
		}

		const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
		const env: Record<string, string | undefined> = {};
		if (context.credential?.type === "api_key" && context.credential.env) {
			for (const [k, v] of Object.entries(context.credential.env)) env[k] = v;
		}
		const headers = buildFetchHeaders(rt.raw, key, env);
		if (context.signal.aborted) return undefined;

		try {
			const url = buildModelsUrl(rt.baseUrl, rt.fetchUrl);
			const models = await fetchRemoteModels(url, rt.api, headers, context.signal);
			if (context.signal.aborted) return undefined;
			saveDiskCache(rt.id, { at: Date.now(), url, models });
			return models;
		} catch (err) {
			if (context.signal.aborted) return undefined;
			throw err instanceof Error ? err : new Error(String(err));
		}
	};
}

// ---------------------------------------------------------------------------
// 扩展入口（async：pi 会等待工厂完成，保证启动时模型已就绪）
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const configPath = findConfigPath();
	if (!configPath) {
		console.warn(
			`${TAG} 未找到 ${CONFIG_FILE}，未注册任何 provider。可通过 $PI_CUSTOM_PROVIDER_CONFIG 指定路径。`,
		);
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (err) {
		console.error(`${TAG} 解析 ${configPath} 失败:`, err);
		return;
	}

	const providers = parseProviders(parsed);
	if (providers.length === 0) {
		console.warn(`${TAG} ${configPath} 中没有可用的 provider 配置。`);
		return;
	}

	console.log(`${TAG} 从 ${configPath} 加载 ${providers.length} 个 provider`);
	for (const { id, config, raw, fetch } of providers) {
		try {
			let models = config.models ?? [];
			let fetched = false;

			if (fetch.enabled) {
				const url = buildModelsUrl(config.baseUrl ?? "", fetch.url);
				const cached = loadDiskCache()[id];
				if (cached && cached.url === url && Date.now() - cached.at < FETCH_FRESH_MS) {
					// pi 同一进程内多次加载扩展（参数解析/信任检查阶段 + 启动阶段），复用缓存避免重复请求
					models = cached.models;
					fetched = true;
				} else {
					const key = config.apiKey
						? resolveConfigValue(config.apiKey, {})
						: undefined;
					const headers = buildFetchHeaders(raw, key, {});
					try {
						models = await fetchRemoteModels(url, config.api, headers, AbortSignal.timeout(FETCH_TIMEOUT_MS));
						saveDiskCache(id, { at: Date.now(), url, models });
						fetched = true;
						console.log(`${TAG} "${id}": 已从 ${url} 拉取 ${models.length} 个模型`);
					} catch (err) {
						console.warn(
							`${TAG} "${id}": 自动拉取模型失败（使用静态 models 兜底，若有）: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}

			const finalConfig: ProviderConfig = {
				...config,
				...(models.length > 0 ? { models } : {}),
				...(fetch.enabled
					? {
							refreshModels: buildRefreshModels({
								id,
								baseUrl: config.baseUrl ?? "",
								fetchUrl: fetch.url,
								api: config.api,
								raw,
							}) as ProviderConfig["refreshModels"],
						}
					: {}),
			};

			pi.registerProvider(id, finalConfig);
			console.log(
				`${TAG} 已注册 provider "${id}"（${models.length} 个模型${fetched ? "，来自自动拉取" : ""}, baseUrl=${config.baseUrl ?? "-"}）`,
			);
		} catch (err) {
			console.error(`${TAG} 注册 provider "${id}" 失败:`, err);
		}
	}
}
