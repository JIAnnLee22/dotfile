import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	type KeybindingsManager,
	type ModelRegistry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getSelectPageIndex,
	Input,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "@earendil-works/pi-tui";
import type { TranslateModelRef } from "./config.ts";

const MAX_VISIBLE = 10;

export type TranslateModelSelectorResult =
	| { action: "select"; model: Model<Api> }
	| { action: "save"; model: Model<Api> }
	| { action: "clear" };

interface ModelItem {
	provider: string;
	id: string;
	model: Model<Api>;
}

function splitModelLabel(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function getDistinctModelName(id: string, name?: string): string | undefined {
	const trimmed = name?.trim();
	if (!trimmed) return undefined;
	const idWords = splitModelLabel(id);
	const idTokens = new Set(idWords);
	const compactId = idWords.join("");
	const isCovered = (word: string) => idTokens.has(word) || (word.length > 1 && compactId.includes(word));
	return splitModelLabel(trimmed).every(isCovered) ? undefined : trimmed;
}

function formatCostHint(model: Model<Api>): string {
	const input = model.cost?.input;
	const output = model.cost?.output;
	if (!Number.isFinite(input) || !Number.isFinite(output)) return "";
	if (input === 0 && output === 0) return "free";
	const fmt = (n: number) => (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(2) : n.toFixed(3));
	return `$${fmt(input)}/$${fmt(output)}`;
}

function formatKeyList(
	keybindings: KeybindingsManager,
	id: "tui.select.confirm" | "tui.select.cancel" | "app.models.save" | "app.models.clearAll",
	fallback: string,
): string {
	const keys = keybindings.getKeys(id);
	if (!keys || keys.length === 0) return fallback;
	return keys
		.map((key) =>
			key
				.split("+")
				.map((part) => {
					const mapped = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
					return mapped.charAt(0).toUpperCase() + mapped.slice(1);
				})
				.join("+"),
		)
		.join("/");
}

export class TranslateModelSelectorComponent extends Container implements Focusable {
	readonly capturesViewportInput = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly modelRegistry: ModelRegistry;
	private readonly currentModel?: Model<Api>;
	private readonly savedModel?: TranslateModelRef;
	private readonly onDone: (result: TranslateModelSelectorResult | undefined) => void;

	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private _focused = false;
	private allModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex = 0;
	private statusMessage = "正在刷新可用模型目录…";
	private statusKind: "muted" | "success" | "error" = "muted";
	private closed = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		modelRegistry: ModelRegistry;
		currentModel?: Model<Api>;
		savedModel?: TranslateModelRef;
		initialQuery?: string;
		onDone: (result: TranslateModelSelectorResult | undefined) => void;
	}) {
		super();
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.modelRegistry = options.modelRegistry;
		this.currentModel = options.currentModel;
		this.savedModel = options.savedModel;
		this.onDone = options.onDone;

		const th = this.theme;
		this.addChild(new DynamicBorder((str) => th.fg("border", str)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(th.fg("accent", th.bold("选择输入翻译模型")), 0, 0));
		this.addChild(
			new Text(
				th.fg(
					"muted",
					this.savedModel
						? `当前持久化配置（translate.json）：${this.savedModel.provider}/${this.savedModel.id}`
						: "当前未持久化模型，未指定时自动选用最便宜的可用 openai-codex 模型",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (options.initialQuery) {
			this.searchInput.setValue(options.initialQuery);
		}
		this.searchInput.onSubmit = () => {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.finish({ action: "select", model: selected.model });
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));

		const confirmKey = formatKeyList(this.keybindings, "tui.select.confirm", "Enter");
		const saveKey = formatKeyList(this.keybindings, "app.models.save", "Ctrl+S");
		const clearKey = formatKeyList(this.keybindings, "app.models.clearAll", "Ctrl+X");
		const cancelKey = formatKeyList(this.keybindings, "tui.select.cancel", "Esc");
		this.addChild(
			new TruncatedText(
				th.fg(
					"dim",
					`  ${confirmKey} 仅本次使用 · ${saveKey} 保存到 translate.json · ${clearKey} 恢复自动 · ${cancelKey} 取消`,
				),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder((str) => th.fg("border", str)));

		this.loadSnapshot();
		this.filterModels(this.searchInput.getValue(), this.currentModel);
		this.tui.requestRender();
		void this.refreshCatalogs();
	}

	private isSavedModel(model: Model<Api>): boolean {
		return this.savedModel?.provider === model.provider && this.savedModel.id === model.id;
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		return [...models].sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;

			const aIsSaved = this.isSavedModel(a.model);
			const bIsSaved = this.isSavedModel(b.model);
			if (aIsSaved !== bIsSaved) return aIsSaved ? -1 : 1;

			return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
		});
	}

	private loadSnapshot(): void {
		const items: ModelItem[] = this.modelRegistry.getAvailable().map((model) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = this.sortModels(items);
	}

	private async refreshCatalogs(): Promise<void> {
		try {
			await this.modelRegistry.refresh();
			if (this.closed) return;
			const err = this.modelRegistry.getError();
			if (err) {
				this.statusMessage = err;
				this.statusKind = "error";
			} else {
				this.statusMessage = "模型目录已刷新";
				this.statusKind = "success";
			}
			const highlighted = this.filteredModels[this.selectedIndex]?.model;
			this.loadSnapshot();
			this.filterModels(this.searchInput.getValue(), highlighted ?? this.currentModel);
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.statusMessage = `刷新模型目录失败：${error instanceof Error ? error.message : String(error)}`;
			this.statusKind = "error";
			this.updateList();
			this.tui.requestRender();
		}
	}

	private filterModels(query: string, preferredModel?: Model<Api>): void {
		const trimmed = query.trim();
		if (trimmed) {
			this.filteredModels = fuzzyFilter(this.allModels, trimmed, (item) => {
				const savedTag = this.isSavedModel(item.model) ? " saved" : "";
				const name = item.model.name ? ` ${item.model.name}` : "";
				return `${item.provider} ${item.provider}/${item.id} ${item.id}${name}${savedTag}`;
			});
		} else {
			this.filteredModels = this.allModels;
		}

		const preferredIndex = preferredModel
			? this.filteredModels.findIndex((item) => modelsAreEqual(preferredModel, item.model))
			: -1;
		if (preferredIndex >= 0) {
			this.selectedIndex = preferredIndex;
		} else {
			this.selectedIndex = trimmed
				? 0
				: Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		}
		this.updateList();
	}

	private updateList(): void {
		const th = this.theme;
		this.listContainer.clear();

		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(th.fg("muted", "  没有匹配的可用模型"), 0, 0));
		} else {
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filteredModels.length - MAX_VISIBLE),
			);
			const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filteredModels.length);

			for (let i = startIndex; i < endIndex; i++) {
				const item = this.filteredModels[i];
				if (!item) continue;
				const isSelected = i === this.selectedIndex;
				const isCurrent = modelsAreEqual(this.currentModel, item.model);
				const isSaved = this.isSavedModel(item.model);

				const cursor = isSelected ? th.fg("accent", "→ ") : "  ";
				const currentMark = isCurrent ? th.fg("accent", "✓ ") : "  ";
				const modelText = isSelected ? th.fg("accent", item.id) : item.id;
				const distinctName = getDistinctModelName(item.id, item.model.name);
				const nameText = distinctName ? th.fg("muted", ` (${distinctName})`) : "";
				const providerBadge = th.fg("muted", ` [${item.provider}]`);
				const savedBadge = isSaved ? th.fg("success", " · saved") : "";
				const cost = formatCostHint(item.model);
				const costText = cost ? th.fg("dim", ` · ${cost}`) : "";

				this.listContainer.addChild(
					new TruncatedText(
						`${cursor}${currentMark}${modelText}${nameText}${providerBadge}${savedBadge}${costText}`,
						0,
						0,
					),
				);
			}

			if (startIndex > 0 || endIndex < this.filteredModels.length) {
				this.listContainer.addChild(
					new Text(th.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`), 0, 0),
				);
			}

			const highlighted = this.filteredModels[this.selectedIndex];
			if (highlighted) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(
					new TruncatedText(
						th.fg("muted", `  ${highlighted.provider}/${highlighted.id} · ${highlighted.model.name}`),
						0,
						0,
					),
				);
			}
		}

		if (this.statusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new TruncatedText(th.fg(this.statusKind, `  ${this.statusMessage}`), 0, 0));
		}
	}

	private finish(result: TranslateModelSelectorResult | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.onDone(result);
	}

	dispose(): void {
		this.closed = true;
	}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
			this.tui.requestRender();
			return;
		}

		if (this.keybindings.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			this.tui.requestRender();
			return;
		}

		const pageIndex = getSelectPageIndex(
			this.keybindings,
			keyData,
			this.selectedIndex,
			this.filteredModels.length,
			MAX_VISIBLE,
		);
		if (pageIndex !== undefined) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = pageIndex;
			this.updateList();
			this.tui.requestRender();
			return;
		}

		if (this.keybindings.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.finish({ action: "select", model: selected.model });
			}
			return;
		}

		if (this.keybindings.matches(keyData, "app.models.save")) {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.finish({ action: "save", model: selected.model });
			}
			return;
		}

		if (this.keybindings.matches(keyData, "app.models.clearAll")) {
			this.finish({ action: "clear" });
			return;
		}

		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}

		this.searchInput.handleInput(keyData);
		this.filterModels(this.searchInput.getValue());
		this.tui.requestRender();
	}
}
