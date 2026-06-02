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
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("p"))) {
        onClose();
        return;
      }

      if (matchesKey(data, Key.up) || matchesKey(data, Key.k)) {
        if (scrollOffset > 0) {
          scrollOffset--;
          cachedWidth = undefined;
          cachedLines = undefined;
        }
      } else if (matchesKey(data, Key.down) || matchesKey(data, Key.j)) {
        const maxScroll = Math.max(0, items.length - 1);
        if (scrollOffset < maxScroll) {
          scrollOffset++;
          cachedWidth = undefined;
          cachedLines = undefined;
        }
      } else if (matchesKey(data, Key.pageUp)) {
        scrollOffset = Math.max(0, scrollOffset - 5);
        cachedWidth = undefined;
        cachedLines = undefined;
      } else if (matchesKey(data, Key.pageDown)) {
        const maxScroll = Math.max(0, items.length - 1);
        scrollOffset = Math.min(maxScroll, scrollOffset + 5);
        cachedWidth = undefined;
        cachedLines = undefined;
      } else if (matchesKey(data, Key.home)) {
        scrollOffset = 0;
        cachedWidth = undefined;
        cachedLines = undefined;
      } else if (matchesKey(data, Key.end)) {
        scrollOffset = Math.max(0, items.length - 1);
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
      const startIdx = Math.min(scrollOffset, Math.max(0, items.length - maxVisible));
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
      lines.push(truncateToWidth(theme.fg("dim", "jk: scroll  PgUp/Dn: page  Esc: close"), width));

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
