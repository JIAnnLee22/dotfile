/**
 * 工具函数 - 命令安全检查与计划解析
 */

// 危险命令模式（按管道/逻辑段检测）
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

// 安全的只读命令（每个管道/逻辑段必须以其中之一开头）
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|rev-parse|describe|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*git\s+tag\s+-l/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*python3\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
  /^\s*true\b/,
  /^\s*false\b/,
  /^\s*test\b/,
  /^\s*\[/,
];

/**
 * 将 shell 命令按管道与逻辑运算符拆成段（不处理引号内的运算符）
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;

    if (!inSingle && !inDouble) {
      if (command.slice(i, i + 2) === "&&") {
        segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (command.slice(i, i + 2) === "||") {
        segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (c === "|" || c === ";") {
        segments.push(current.trim());
        current = "";
        continue;
      }
    }
    current += c;
  }

  const tail = current.trim();
  if (tail) segments.push(tail);
  return segments.length > 0 ? segments : [command.trim()];
}

/**
 * 检测会写入文件的输出重定向（允许 2>/dev/null、2>&1、&>/dev/null）
 */
export function hasUnsafeRedirect(segment: string): boolean {
  const withoutStderr = segment
    .replace(/2>\s*\/dev\/null/g, "")
    .replace(/2>\s*&1/g, "")
    .replace(/&>\s*\/dev\/null/g, "")
    .replace(/&>\s*&1/g, "");

  if (/>>\s*\S/.test(withoutStderr)) return true;
  return /(?:^|[^\d&])\s*>\s*(?![|&])\S/.test(withoutStderr);
}

function segmentIsSafe(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return true;
  if (DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed))) return false;
  if (hasUnsafeRedirect(trimmed)) return false;
  return SAFE_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * 检查命令是否安全（只读）- 支持管道与逻辑组合
 */
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return splitCommandSegments(trimmed).every(segmentIsSafe);
}

/**
 * 计划项类型
 */
export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
  skipped?: boolean;
}

/**
 * 清理步骤文本（去除格式化符号）
 */
export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 60) {
    cleaned = `${cleaned.slice(0, 57)}...`;
  }
  return cleaned;
}

/**
 * 从消息中提取计划步骤（保留 Plan 中的原始编号）
 */
export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  const headerMatch = message.match(/\*{0,2}(?:Plan|计划|TODO|步骤):\*{0,2}\s*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
  const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
  const usedSteps = new Set<number>();

  for (const match of planSection.matchAll(numberedPattern)) {
    const step = Number(match[1]);
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (
      Number.isFinite(step) &&
      step > 0 &&
      !usedSteps.has(step) &&
      text.length > 5 &&
      !text.startsWith("`") &&
      !text.startsWith("/") &&
      !text.startsWith("-")
    ) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
        usedSteps.add(step);
        items.push({ step, text: cleaned, completed: false });
      }
    }
  }

  return items.sort((a, b) => a.step - b.step);
}

/**
 * 按 step 排序后的下一待办项
 */
export function getNextPendingItem(items: TodoItem[]): TodoItem | undefined {
  return [...items].sort((a, b) => a.step - b.step).find((t) => !t.completed);
}

/**
 * 提取已完成的步骤编号
 */
export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/**
 * 提取跳过的步骤编号
 */
export function extractSkipSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[SKIP:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/**
 * 标记已完成的步骤
 */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
}

/**
 * 标记跳过的步骤
 */
export function markSkippedSteps(text: string, items: TodoItem[]): number {
  const skipSteps = extractSkipSteps(text);
  for (const step of skipSteps) {
    const item = items.find((t) => t.step === step);
    if (item) {
      item.skipped = true;
      item.completed = true;
    }
  }
  return skipSteps.length;
}

/**
 * 生成进度条
 */
export function generateProgressBar(completed: number, total: number, width: number = 20): string {
  if (total === 0) return "";
  const ratio = completed / total;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * 格式化计划列表（用于显示，编号与 [DONE:n] 一致）
 */
export function formatPlanList(items: TodoItem[], showNumbers: boolean = true): string {
  const sorted = [...items].sort((a, b) => a.step - b.step);
  return sorted
    .map((item) => {
      const prefix = showNumbers ? `${item.step}. ` : "";
      if (item.completed && item.skipped) {
        return `${prefix}⏭️ ${item.text} (已跳过)`;
      }
      if (item.completed) {
        return `${prefix}✅ ${item.text}`;
      }
      return `${prefix}⬜ ${item.text}`;
    })
    .join("\n");
}
