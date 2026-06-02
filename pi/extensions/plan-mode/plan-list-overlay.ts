/**
 * 可滚动的计划列表悬浮组件
 */

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { TodoItem } from "./utils.ts";

// 使用 any 类型来兼容不同的 Theme 实现
type ThemeFg = (color: string, text: string) => string;
type ThemeBold = (text: string) => string;

interface ThemeLike {
  fg: ThemeFg;
  bold: ThemeBold;
}

export interface PlanListComponent extends Component {
  setItems(items: TodoItem[]): void;
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  handleInput?(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}

function safeMatchesKey(data: string, key: unknown): boolean {
  if (key === undefined || key === null) {
    return false;
  }
  try {
    return matchesKey(data, key as any);
  } catch {
    return false;
  }
}

function matchesLiteralKey(data: string, key: string): boolean {
  return data === key;
}

function createPlanListComponent(
  theme: ThemeLike,
  onClose: () => void,
): PlanListComponent {
  let items: TodoItem[] = [];
  let scrollOffset = 0;
  let visible = true;
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;

  const component: PlanListComponent = {
    setItems(newItems: TodoItem[]) {
      items = newItems;
      const maxVisible = Math.max(1, Math.min(items.length, 10));
      const maxScroll = Math.max(0, items.length - maxVisible);
      scrollOffset = Math.min(scrollOffset, maxScroll);
      cachedWidth = undefined;
      cachedLines = undefined;
    },

    setVisible(v: boolean) {
      visible = v;
    },

    isVisible() {
      return visible;
    },

    handleInput(data: string): void {
      // Do not bind Esc here: Esc is handled globally and may interrupt agent execution.
      if (safeMatchesKey(data, Key.ctrlAlt("p")) || safeMatchesKey(data, Key.ctrl("p")) || matchesLiteralKey(data, "q")) {
        onClose();
        return;
      }

      if (
        safeMatchesKey(data, Key.up) ||
        safeMatchesKey(data, (Key as any).k) ||
        matchesLiteralKey(data, "k")
      ) {
        if (scrollOffset > 0) {
          scrollOffset--;
          cachedWidth = undefined;
          cachedLines = undefined;
        }
      } else if (
        safeMatchesKey(data, Key.down) ||
        safeMatchesKey(data, (Key as any).j) ||
        matchesLiteralKey(data, "j")
      ) {
        const maxVisible = Math.max(1, Math.min(items.length, 10));
        const maxScroll = Math.max(0, items.length - maxVisible);
        if (scrollOffset < maxScroll) {
          scrollOffset++;
          cachedWidth = undefined;
          cachedLines = undefined;
        }
      } else if (safeMatchesKey(data, Key.pageUp)) {
        scrollOffset = Math.max(0, scrollOffset - 5);
        cachedWidth = undefined;
        cachedLines = undefined;
      } else if (safeMatchesKey(data, Key.pageDown)) {
        const maxVisible = Math.max(1, Math.min(items.length, 10));
        const maxScroll = Math.max(0, items.length - maxVisible);
        scrollOffset = Math.min(maxScroll, scrollOffset + 5);
        cachedWidth = undefined;
        cachedLines = undefined;
      } else if (safeMatchesKey(data, Key.home)) {
        scrollOffset = 0;
        cachedWidth = undefined;
        cachedLines = undefined;
      } else if (safeMatchesKey(data, Key.end)) {
        const maxVisible = Math.max(1, Math.min(items.length, 10));
        scrollOffset = Math.max(0, items.length - maxVisible);
        cachedWidth = undefined;
        cachedLines = undefined;
      }
    },

    render(width: number): string[] {
      if (!visible) return [];

      if (cachedLines && cachedWidth === width) {
        return cachedLines;
      }

      const lines: string[] = [];
      const completed = items.filter((t) => t.completed).length;
      const total = items.length;

      // 标题
      const title = `Plan (${completed}/${total})`;
      lines.push(truncateToWidth(theme.fg("accent", theme.bold(title)), width));
      lines.push(truncateToWidth(theme.fg("muted", "-".repeat(Math.min(width - 2, 30))), width));

      // 计算可见区域
      const maxVisible = Math.max(1, Math.min(items.length, 10));
      const maxScroll = Math.max(0, items.length - maxVisible);
      scrollOffset = Math.min(scrollOffset, maxScroll);
      const startIdx = scrollOffset;
      const endIdx = Math.min(startIdx + maxVisible, items.length);

      // 显示滚动指示器
      if (startIdx > 0) {
        lines.push(truncateToWidth(theme.fg("muted", "  ^ ..."), width));
      }

      // 步骤列表
      for (let i = startIdx; i < endIdx; i++) {
        const item = items[i];
        const label = `${item.step}. ${item.text}`;
        let line: string;

        if (item.completed && item.skipped) {
          line = theme.fg("muted", `  [S] ${label}`);
        } else if (item.completed) {
          line = theme.fg("success", `  [x] ${label}`);
        } else {
          line = `  [ ] ${label}`;
        }

        lines.push(truncateToWidth(line, width));
      }

      // 显示滚动指示器
      if (endIdx < items.length) {
        lines.push(truncateToWidth(theme.fg("muted", "  v ..."), width));
      }

      // 底部帮助
      lines.push(truncateToWidth(theme.fg("dim", "-".repeat(Math.min(width - 2, 30))), width));
      lines.push(truncateToWidth(theme.fg("dim", "jk: scroll  PgUp/Dn: page  Ctrl+Alt+P/q: close"), width));

      cachedWidth = width;
      cachedLines = lines;
      return lines;
    },

    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };

  return component;
}

export { createPlanListComponent as createPlanListOverlay };
