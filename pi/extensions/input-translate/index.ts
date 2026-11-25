import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	formatModelRef,
	getConfigMtimeMs,
	loadTranslateConfig,
	parseModelRef,
	saveTranslateConfig,
	type LoadedTranslateConfig,
	type TranslateConfig,
	type TranslateModelRef,
} from "./config.ts";
import {
	TranslateModelSelectorComponent,
	type TranslateModelSelectorResult,
} from "./model-selector.ts";

const ENTRY_TYPE = "input-translation";

function cheapestCodexModel(ctx: ExtensionContext): Model<Api> | undefined {
	return ctx.modelRegistry
		.getAvailable()
		.filter(
			(model) =>
				model.provider === "openai-codex" &&
				model.api === "openai-codex-responses" &&
				Number.isFinite(model.cost.input) &&
				Number.isFinite(model.cost.output),
		)
		.sort(
			(a, b) =>
				a.cost.input + a.cost.output - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id),
		)[0];
}

/** Hide literal content from the translator and reject damaged/duplicated placeholders. */
function protectLiterals(text: string) {
	const prefix = `__PI_LITERAL_${randomUUID().replaceAll("-", "")}_`;
	const literals: string[] = [];
	const masked = text.replace(
		/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^\r\n]*?\2|https?:\/\/[^\s<>"`]+|(?:[A-Za-z]:\\|(?:~|\.{1,2})?\/|(?:[A-Za-z0-9_@.-]+[/\\])+)[^\s<>"`]+/g,
		(literal) => `${prefix}${literals.push(literal) - 1}__`,
	);
	return {
		masked,
		restore(translated: string) {
			for (let i = 0; i < literals.length; i++) {
				const placeholder = `${prefix}${i}__`;
				if (translated.split(placeholder).length !== 2) {
					throw new Error("代码或路径占位符被改动");
				}
			}
			// Restore in one pass: literal content must never be interpreted as another placeholder.
			return translated.replace(new RegExp(`${prefix}(\\d+)__`, "g"), (_match, index: string) => {
				const literal = literals[Number(index)];
				if (literal === undefined) throw new Error("翻译包含未知占位符");
				return literal;
			});
		},
	};
}

export default function (pi: ExtensionAPI) {
	let loaded: LoadedTranslateConfig = loadTranslateConfig();
	let config: TranslateConfig = loaded.config;
	let enabled = config.enabled;
	let enabledOverridden = false;
	let sessionModelOverride: TranslateModelRef | undefined;
	let startupErrorNotified = false;
	let lastResult = "尚未翻译";
	const cache = new Map<string, string>();
	const pending = new Set<AbortController>();
	const cacheSessionId = `input-translate-${randomUUID()}`;

	function trimCache() {
		while (cache.size > config.cacheSize) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}

	function syncConfigFromDisk(ctx?: ExtensionContext) {
		const diskMtime = getConfigMtimeMs(loaded.path);
		if (diskMtime === loaded.mtimeMs) return;

		const prevPrompt = config.translationPrompt;
		loaded = loadTranslateConfig(loaded.path);
		config = loaded.config;
		if (!enabledOverridden) {
			enabled = config.enabled;
		}
		if (config.translationPrompt !== prevPrompt) {
			cache.clear();
		} else {
			trimCache();
		}
		if (loaded.error && ctx?.hasUI) {
			ctx.ui.notify(`输入翻译：${loaded.error}`, "warning");
		}
	}

	function resolveTranslationModel(ctx: ExtensionContext): {
		model: Model<Api> | undefined;
		source: "session" | "config" | "auto";
		requestedRef?: TranslateModelRef;
	} {
		const requestedRef = sessionModelOverride ?? config.model;
		if (requestedRef) {
			const model = ctx.modelRegistry
				.getAvailable()
				.find((item) => item.provider === requestedRef.provider && item.id === requestedRef.id);
			return {
				model,
				source: sessionModelOverride ? "session" : "config",
				requestedRef,
			};
		}
		return {
			model: cheapestCodexModel(ctx),
			source: "auto",
		};
	}

	function describeModelStatus(ctx: ExtensionContext): string {
		const resolved = resolveTranslationModel(ctx);
		if (resolved.model) {
			const label = `${resolved.model.provider}/${resolved.model.id}`;
			if (resolved.source === "session") return `${label}（本次临时选择）`;
			if (resolved.source === "config") return `${label}（已保存于 translate.json）`;
			return `${label}（自动最便宜 Codex）`;
		}
		if (resolved.requestedRef) {
			return `${formatModelRef(resolved.requestedRef)}（不可用）`;
		}
		return "无可用 Codex 模型";
	}

	function notifyStatus(ctx: ExtensionContext) {
		const timeoutSec = (config.timeoutMs / 1000).toFixed(config.timeoutMs % 1000 === 0 ? 0 : 1);
		ctx.ui.notify(
			`输入英译${enabled ? "已开启" : "已关闭"}；模型：${describeModelStatus(ctx)}；` +
				`超时 ${timeoutSec} 秒，失败发送原文，主模型默认中文回复；` +
				`配置：${loaded.path}。最近：${lastResult}。`,
			"info",
		);
	}

	async function openModelSelector(ctx: ExtensionCommandContext, initialQuery?: string) {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				`交互式模型列表需要 TUI 模式；也可直接编辑 ${loaded.path} 设置 "model": { "provider": "...", "id": "..." }`,
				"warning",
			);
			return;
		}

		const resolved = resolveTranslationModel(ctx);
		const result = await ctx.ui.custom<TranslateModelSelectorResult | undefined>(
			(tui, theme, keybindings, done) =>
				new TranslateModelSelectorComponent({
					tui,
					theme,
					keybindings,
					modelRegistry: ctx.modelRegistry,
					currentModel: resolved.model,
					savedModel: config.model,
					initialQuery,
					onDone: done,
				}),
			{ blocked: { kind: "question", message: "Select translation model" } },
		);

		if (!result) return;

		if (result.action === "select") {
			sessionModelOverride = { provider: result.model.provider, id: result.model.id };
			ctx.ui.notify(
				`已切换翻译模型为 ${result.model.provider}/${result.model.id}（仅本次运行生效；按 Ctrl+S 或 /translate save 可保存到 translate.json）`,
				"info",
			);
			return;
		}

		if (result.action === "save") {
			const modelRef: TranslateModelRef = { provider: result.model.provider, id: result.model.id };
			try {
				loaded = saveTranslateConfig({ model: modelRef }, loaded.path);
				config = loaded.config;
				sessionModelOverride = undefined;
				ctx.ui.notify(`已保存翻译模型到 ${loaded.path}：${formatModelRef(modelRef)}`, "info");
			} catch (err) {
				ctx.ui.notify(
					`保存 translate.json 失败：${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
			return;
		}

		if (result.action === "clear") {
			try {
				loaded = saveTranslateConfig({ model: null }, loaded.path);
				config = loaded.config;
				sessionModelOverride = undefined;
				ctx.ui.notify(`已清除持久化翻译模型设置，恢复自动选择（${loaded.path}）`, "info");
			} catch (err) {
				ctx.ui.notify(
					`保存 translate.json 失败：${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		syncConfigFromDisk(ctx);
		if (!startupErrorNotified && loaded.error && ctx.hasUI) {
			startupErrorNotified = true;
			ctx.ui.notify(`输入翻译：${loaded.error}`, "warning");
		}
	});

	pi.on("input", async (event, ctx): Promise<InputEventResult> => {
		syncConfigFromDisk(ctx);
		const text = event.text;
		if (
			!enabled ||
			event.source === "extension" ||
			event.streamingBehavior === "steer" ||
			/^[\s]*[!/]/.test(text) ||
			!text.trim()
		) {
			return { action: "continue" };
		}
		if (text.length > config.maxInputChars) {
			lastResult = `输入超过 ${config.maxInputChars.toLocaleString()} 字符，已直接发送原文`;
			ctx.ui.notify(`输入翻译：${lastResult}。`, "warning");
			return { action: "continue" };
		}

		const protectedText = protectLiterals(text);
		// ASCII/English prose and non-ASCII punctuation or emoji need no extra network round trip.
		if (!/(?=\p{Letter})[^\x00-\x7F]/u.test(protectedText.masked)) {
			return { action: "continue" };
		}

		const resolved = resolveTranslationModel(ctx);
		const model = resolved.model;
		if (!model) {
			lastResult = resolved.requestedRef
				? `配置的翻译模型 ${formatModelRef(resolved.requestedRef)} 当前不可用，已直接发送原文`
				: "openai-codex 无可用模型，已直接发送原文（可运行 /translate model 选择模型或 /login openai-codex）";
			ctx.ui.notify(`输入翻译：${lastResult}。`, "warning");
			return { action: "continue" };
		}

		const modelRef = formatModelRef(model);
		const key = `${model.provider}\0${model.id}\0${text}`;
		if (config.cacheSize > 0) {
			const cached = cache.get(key);
			if (cached !== undefined) {
				lastResult = `${modelRef}，命中内存缓存`;
				pi.appendEntry(ENTRY_TYPE, { original: text, translation: cached, model: modelRef, cached: true });
				return { action: "transform", text: cached, images: event.images };
			}
		}

		const timeoutMs = config.timeoutMs;
		const controller = new AbortController();
		pending.add(controller);
		const abort = () => controller.abort(ctx.signal?.reason);
		ctx.signal?.addEventListener("abort", abort, { once: true });
		if (ctx.signal?.aborted) abort();
		const started = performance.now();
		ctx.ui.setStatus("input-translate", "译 → EN…");
		let timer: ReturnType<typeof setTimeout> | undefined;

		try {
			// A hard deadline also bounds credential refresh, before the HTTP request is started.
			const deadline = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error(`超过 ${(timeoutMs / 1000).toFixed(timeoutMs % 1000 === 0 ? 0 : 1)} 秒等待上限`));
				}, timeoutMs);
			});
			const result = await Promise.race([
				ctx.modelRegistry
					.streamSimple(
						model,
						{
							systemPrompt: config.translationPrompt,
							messages: [{ role: "user", content: protectedText.masked, timestamp: Date.now() }],
						},
						{
							// Omit reasoning: the Codex adapter uses the model's off/none mapping.
							// No main-model thinking or priority tier is inherited by this separate call.
							...(model.api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
							sessionId: cacheSessionId,
							signal: controller.signal,
							timeoutMs,
							maxRetries: 0,
						},
					)
					.result(),
				deadline,
			]);
			if (controller.signal.aborted) throw new Error("翻译已取消或超时");
			if (result.stopReason !== "stop") throw new Error("翻译未完整结束");
			const translated = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("")
				.trim();
			if (!translated) throw new Error("翻译为空");
			const restored = protectedText.restore(translated);
			if (config.cacheSize > 0) {
				cache.set(key, restored);
				trimCache();
			}
			const elapsedMs = Math.round(performance.now() - started);
			lastResult = `${modelRef}，${(elapsedMs / 1000).toFixed(2)} 秒`;
			// Keep the original for audit, outside model context; do not send it twice to the main model.
			pi.appendEntry(ENTRY_TYPE, {
				original: text,
				translation: restored,
				model: modelRef,
				elapsedMs,
				usage: result.usage,
			});
			return { action: "transform", text: restored, images: event.images };
		} catch (error) {
			controller.abort();
			if (ctx.signal?.aborted) return { action: "handled" };
			const reason = error instanceof Error ? error.message : "请求失败";
			lastResult = `${reason}，已直接发送原文`;
			ctx.ui.notify(`输入翻译：${lastResult}。`, "warning");
			return { action: "continue" };
		} finally {
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", abort);
			pending.delete(controller);
			if (pending.size === 0) ctx.ui.setStatus("input-translate", undefined);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		syncConfigFromDisk(ctx);
		if (enabled) event.systemPromptOptions.sections.input_translation = config.replyGuidance;
	});

	pi.on("session_shutdown", () => {
		for (const controller of pending) controller.abort();
		pending.clear();
		cache.clear();
	});

	pi.registerCommand("translate", {
		description: "输入英译与模型配置：/translate [model|on|off|save|status]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trimStart().toLowerCase();
			if (trimmed.includes(" ")) return null;
			const subcommands: AutocompleteItem[] = [
				{ value: "model", label: "model", description: "打开模型列表选择翻译模型（Ctrl+S 保存到 translate.json）" },
				{ value: "on", label: "on", description: "本次运行开启输入翻译" },
				{ value: "off", label: "off", description: "本次运行关闭输入翻译" },
				{ value: "save", label: "save", description: "将当前开关与模型配置保存到 translate.json" },
				{ value: "status", label: "status", description: "查看当前翻译状态与配置" },
			];
			const matched = subcommands.filter((item) => item.value.startsWith(trimmed));
			return matched.length > 0 ? matched : null;
		},
		handler: async (args, ctx) => {
			syncConfigFromDisk(ctx);
			const trimmed = args.trim();
			const [sub = "", ...rest] = trimmed.split(/\s+/);
			const action = sub.toLowerCase();
			const argRest = rest.join(" ").trim();

			if (action === "model" || action === "models") {
				if (argRest) {
					const parsed = parseModelRef(argRest);
					if (parsed) {
						const matched = ctx.modelRegistry
							.getAvailable()
							.find((m) => m.provider === parsed.provider && m.id === parsed.id);
						if (matched) {
							sessionModelOverride = parsed;
							ctx.ui.notify(
								`已切换翻译模型为 ${formatModelRef(parsed)}（仅本次运行生效；执行 /translate save 可保存到 translate.json）`,
								"info",
							);
							return;
						}
					}
				}
				await openModelSelector(ctx, argRest || undefined);
				return;
			}

			if (action === "on") {
				enabled = true;
				enabledOverridden = true;
			} else if (action === "off") {
				enabled = false;
				enabledOverridden = true;
				for (const controller of pending) controller.abort();
			} else if (action === "save") {
				const modelToSave = sessionModelOverride ?? config.model ?? null;
				try {
					loaded = saveTranslateConfig({ enabled, model: modelToSave }, loaded.path);
					config = loaded.config;
					enabledOverridden = false;
					sessionModelOverride = undefined;
					ctx.ui.notify(
						`已保存配置到 ${loaded.path}：enabled=${config.enabled}，model=${
							config.model ? formatModelRef(config.model) : "自动"
						}`,
						"info",
					);
				} catch (err) {
					ctx.ui.notify(
						`保存 translate.json 失败：${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
				return;
			} else if (action !== "" && action !== "status") {
				ctx.ui.notify("用法：/translate [model|on|off|save|status]", "warning");
				return;
			}

			notifyStatus(ctx);
		},
	});
}
