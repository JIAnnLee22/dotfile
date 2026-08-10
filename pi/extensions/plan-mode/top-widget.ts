/**
 * 顶部 widget 布局提升 —— 把扩展 widget 容器从底部 dock 提升到
 * fullscreen 布局的顶部（transcript 上方），实现"屏幕顶部常驻进度"。
 *
 * pi 的 fullscreen 布局结构（dist/modes/interactive/interactive-mode.js）：
 *
 *   fullscreenLayoutRoot = VStack([
 *     transcriptScrollView,      // 滚动区（grow:1）
 *     dock = VStack([
 *       pendingMessages, status, widgetContainerAbove, editor,
 *       widgetContainerBelow, footer,
 *     ]),
 *   ])
 *
 * 本模块在 InteractiveMode 挂载 TUI 后（mountInteractiveTui 钩子）把
 * `widgetContainerAbove` 从 dock.entries 中移出，插入布局根顶部：
 *
 *   VStack([widgetContainerAbove, transcriptScrollView, dock])
 *
 * - 幂等：已提升则跳过（模式切换 / remount 不会重复移动）
 * - 守卫：上游结构变化时 warn 并跳过，不影响 plan-mode 其余功能
 *   （widget 落回编辑器上方，行为与未提升前一致）
 * - 显隐：setTopWidgetVisible(false) 时布局不占任何行（Stack 的
 *   entry.visible 回调），用于 phase=off 时完全隐藏
 *
 * 参考：dense-ui 扩展的运行时补丁模式（Symbol 标记防重复包装）。
 */

import type { InteractiveMode as InteractiveModeClass } from "@earendil-works/pi-coding-agent";

const MARK = Symbol("planModeTopWidgetPatched");

/** 当前顶部 widget 是否可见（由 plan-mode 阶段状态驱动） */
let topWidgetVisible = false;
let topEntry: { visible: (viewport: unknown) => boolean } | null = null;

/** 控制顶部 widget 占位显隐（false 时布局不分配任何行） */
export function setTopWidgetVisible(visible: boolean): void {
	topWidgetVisible = visible;
	// topEntry.visible 闭包读取同一变量，无需额外更新；
	// visible 变化会在下一次 render 循环时生效
}

/** 把 widgetContainerAbove 从 dock 提升到 fullscreen 布局根顶部（幂等） */
export function promoteWidgetToTop(im: unknown): void {
	if (!im) return;
	const self = im as {
		fullscreenLayoutRoot?: { entries?: Array<{ component?: unknown }> };
		widgetContainerAbove?: unknown;
	};
	const root = self.fullscreenLayoutRoot;
	const widget = self.widgetContainerAbove;
	if (!root || !Array.isArray(root.entries) || !widget) return;

	// 幂等：已经提升（entries[0] 即 widget 容器）
	if (root.entries[0]?.component === widget) return;

	// 找到包含 widget 容器的 dock（VStack）
	const dockEntry = root.entries.find(
		(e) =>
			e?.component &&
			Array.isArray((e.component as { entries?: unknown[] }).entries) &&
			(e.component as { entries: Array<{ component?: unknown }> }).entries.some((x) => x.component === widget),
	);
	if (!dockEntry) return;

	const dockEntries = (dockEntry.component as { entries: Array<{ component?: unknown }> }).entries;
	const idx = dockEntries.findIndex((x) => x.component === widget);
	if (idx === -1) return;

	// 从 dock 移除
	dockEntries.splice(idx, 1);

	// 插入布局根顶部：grow=0 保持固有高度，shrink=1 小屏时压缩，visible 控制显隐
	const entry = { component: widget, grow: 0, shrink: 1, minSize: 0, visible: () => topWidgetVisible };
	root.entries.unshift(entry);
	topEntry = entry;
}

/**
 * 幂等安装顶部布局提升补丁。
 * 在每次 TUI 挂载（init / switchTuiMode）后调整布局，保证任何模式切换后生效。
 */
export async function patchTopWidgetPlacement(): Promise<void> {
	let ctor: typeof InteractiveModeClass | undefined;
	try {
		const mod = (await import("@earendil-works/pi-coding-agent")) as { InteractiveMode?: typeof InteractiveModeClass };
		ctor = mod.InteractiveMode;
	} catch (err) {
		console.warn("[plan-mode] 无法加载 @earendil-works/pi-coding-agent，跳过顶部 widget 布局补丁", err);
		return;
	}
	if (!ctor) return;
	const proto = ctor.prototype as unknown as Record<PropertyKey, unknown>;
	if (!proto || proto[MARK as unknown as PropertyKey]) return;
	if (typeof proto.mountInteractiveTui !== "function") {
		console.warn("[plan-mode] 找不到 InteractiveMode#mountInteractiveTui，跳过顶部 widget 布局补丁（widget 将显示在编辑器上方）");
		return;
	}
	const orig = proto.mountInteractiveTui as (tui: unknown, components: unknown[]) => unknown;
	Object.defineProperty(proto, MARK, { value: true, configurable: true });
	proto.mountInteractiveTui = function (this: unknown, tui: unknown, components: unknown[]) {
		const result = orig.call(this, tui, components);
		promoteWidgetToTop(this);
		return result;
	};
}
