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
  let inBacktick = false;
  let escaped = false;
  let commandSubDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1] ?? "";

    if (escaped) {
      current += c;
      escaped = false;
      continue;
    }

    if (c === "\\") {
      current += c;
      // In shell, backslash inside single quotes is literal.
      if (!inSingle) {
        escaped = true;
      }
      continue;
    }

    if (!inDouble && !inBacktick && c === "'" && commandSubDepth === 0) {
      inSingle = !inSingle;
      current += c;
      continue;
    }

    if (!inSingle && !inBacktick && c === '"') {
      inDouble = !inDouble;
      current += c;
      continue;
    }

    if (!inSingle && !inDouble && c === "`") {
      inBacktick = !inBacktick;
      current += c;
      continue;
    }

    if (!inSingle && !inBacktick && c === "$" && next === "(") {
      commandSubDepth++;
      current += c;
      continue;
    }

    if (!inSingle && !inBacktick && c === ")" && commandSubDepth > 0) {
      commandSubDepth--;
      current += c;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick && commandSubDepth === 0) {
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
  const withoutAllowedStderrRedirects = segment
    // Keep stderr suppression/merging available in plan mode.
    .replace(/(^|[^\d])2>>?\s*\/dev\/null\b/g, "$1")
    .replace(/(^|[^\d])2>\s*&1\b/g, "$1")
    .replace(/(^|[^\d])&>>?\s*\/dev\/null\b/g, "$1")
    .replace(/(^|[^\d])&>\s*&1\b/g, "$1");

  // Block stdout/combined redirects (e.g. >, >>, 1>, 1>>, >|, 1>|).
  if (/(?:^|[^\d])(?:\d+)?>>\s*\S/.test(withoutAllowedStderrRedirects)) return true;
  if (/(?:^|[^\d])(?:\d+)?>\|?\s*\S/.test(withoutAllowedStderrRedirects)) return true;

  // Block read/write file opening (e.g. <>, 0<>).
  return /(?:^|[^\d])(?:\d+)?<>\s*\S/.test(withoutAllowedStderrRedirects);
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
  return text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从消息中提取计划步骤（保留 Plan 中的原始编号）
 */
export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  const headerMatch = message.match(/\*{0,2}(?:Plan|计划|TODO|步骤):\*{0,2}/i);
  if (!headerMatch || headerMatch.index === undefined) return items;

  // 仅解析 Plan 标题后的连续步骤块，避免误抓后续普通编号列表。
  const planSection = message.slice(headerMatch.index + headerMatch[0].length);
  const lines = planSection.split(/\r?\n/);
  const usedSteps = new Set<number>();
  const stepLinePattern = /^\s*(\d+)[.)]\s+(.+)$/;
  const blankLinePattern = /^\s*$/;
  let started = false;

  for (const line of lines) {
    const stepMatch = line.match(stepLinePattern);
    if (stepMatch) {
      started = true;
      const step = Number(stepMatch[1]);
      const text = stepMatch[2]
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
      continue;
    }

    if (!started) {
      // 支持 "Plan:" 之后先出现空行或说明。
      if (blankLinePattern.test(line)) continue;
      continue;
    }

    // 步骤块开始后，允许空行（常见于 markdown 列表排版）；遇到其它内容即停止解析。
    if (blankLinePattern.test(line)) continue;
    break;
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
  const steps = new Set<number>();
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.add(step);
  }
  return [...steps].sort((a, b) => a - b);
}

/**
 * 提取跳过的步骤编号
 */
export function extractSkipSteps(message: string): number[] {
  const steps = new Set<number>();
  for (const match of message.matchAll(/\[SKIP:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.add(step);
  }
  return [...steps].sort((a, b) => a - b);
}

/**
 * 标记已完成的步骤
 */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  let changed = 0;
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item && !item.completed) {
      item.completed = true;
      changed++;
    }
  }
  return changed;
}

/**
 * 标记跳过的步骤
 */
export function markSkippedSteps(text: string, items: TodoItem[]): number {
  const skipSteps = extractSkipSteps(text);
  let changed = 0;
  for (const step of skipSteps) {
    const item = items.find((t) => t.step === step);
    if (item && (!item.skipped || !item.completed)) {
      item.skipped = true;
      item.completed = true;
      changed++;
    }
  }
  return changed;
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

/**
 * 计划保存元数据
 */
export interface PlanSaveMeta {
  sessionId: string;
  createdAt?: string;
  updatedAt?: string;
  cwd?: string;
}

/**
 * 生成计划的 Markdown 文档内容
 */
export function generatePlanMarkdown(items: TodoItem[], meta: PlanSaveMeta): string {
  const sorted = [...items].sort((a, b) => a.step - b.step);
  const completed = items.filter((t) => t.completed && !t.skipped).length;
  const skipped = items.filter((t) => t.skipped).length;
  const total = items.length;
  const pending = total - completed - skipped;

  const lines: string[] = [];

  // 标题
  lines.push(`# 执行计划`);
  lines.push("");

  // 元信息
  lines.push(`| 属性 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Session | \`${meta.sessionId}\` |`);
  if (meta.cwd) lines.push(`| 工作目录 | \`${meta.cwd}\` |`);
  if (meta.createdAt) lines.push(`| 创建时间 | ${meta.createdAt} |`);
  if (meta.updatedAt) lines.push(`| 更新时间 | ${meta.updatedAt} |`);
  lines.push(`| 状态 | **${completed}/${total}** 完成${skipped > 0 ? `，${skipped} 跳过` : ""}${pending > 0 ? `，${pending} 待执行` : ""} |`);
  lines.push("");

  // 进度概览
  lines.push(`## 进度`);
  lines.push("");
  const progress = generateProgressBar(completed, total, 20);
  lines.push(`\`${progress}\` ${Math.round((completed / total) * 100)}%`);
  lines.push("");

  // 步骤列表
  lines.push(`## 步骤`);
  lines.push("");
  for (const item of sorted) {
    let checkbox: string;
    let suffix = "";
    if (item.completed && item.skipped) {
      checkbox = "- [x]";
      suffix = ` ⏭️ ~~${item.text}~~ (已跳过)`;
    } else if (item.completed) {
      checkbox = "- [x]";
      suffix = ` ✅ ${item.text}`;
    } else {
      checkbox = "- [ ]";
      suffix = ` ${item.text}`;
    }
    lines.push(`${checkbox} **${item.step}.**${suffix}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * 从 TodoItem[] 生成简易计划摘要（用于文件名或通知）
 */
export function getPlanSummary(items: TodoItem[]): string {
  const completed = items.filter((t) => t.completed).length;
  const total = items.length;
  return `${completed}/${total}`;
}

// ============================================================
// 歧义步骤解析
// ============================================================

/**
 * 歧义步骤类型
 */
export interface AmbiguousStep {
  /** 步骤编号 */
  step: number;
  /** 步骤描述（去除歧义标记后的部分） */
  description: string;
  /** 可选方案列表 */
  options: string[];
  /** 原始完整文本 */
  originalText: string;
}

/**
 * 歧义标记正则 - 匹配 [?] 后面的所有选项文本
 * 支持格式：
 *   Description [?] Option1 | Option2 | Option3
 *   Description [?] Option1 / Option2 / Option3
 *   Description [?] Option1，Option2，Option3
 */
const AMBIGUOUS_PATTERN = /\[\?\]\s*(.+)$/;

/**
 * 选项分隔符：竖线 / 斜杠 / 全角竖线
 */
const OPTION_SEPARATOR = /[|/｜]/;

/**
 * 中文逗号分隔符（排除英文逗号在函数参数中的情况）
 */
const COMMA_SEPARATOR = /，|,(?![^(]*\))/;

/**
 * 检测步骤文本中是否包含歧义标记 [?]
 */
export function isAmbiguousStep(text: string): boolean {
  return AMBIGUOUS_PATTERN.test(text);
}

/**
 * 解析计划中的歧义步骤，返回需要用户选择的步骤列表
 */
export function parseAmbiguousSteps(items: TodoItem[]): AmbiguousStep[] {
  const ambiguous: AmbiguousStep[] = [];

  for (const item of items) {
    const match = item.text.match(AMBIGUOUS_PATTERN);
    if (match) {
      const description = item.text.replace(AMBIGUOUS_PATTERN, "").trim();
      const optionStr = match[1].trim();

      // 优先用 | 或 / 分割
      let options = optionStr
        .split(OPTION_SEPARATOR)
        .map((o) => o.trim())
        .filter((o) => o.length > 0);

      // 如果只分割出少于 2 个选项，尝试用中文逗号分割
      if (options.length < 2) {
        options = optionStr
          .split(COMMA_SEPARATOR)
          .map((o) => o.trim())
          .filter((o) => o.length > 0);
      }

      // 至少需要 2 个选项才算歧义
      if (options.length >= 2) {
        ambiguous.push({
          step: item.step,
          description: description || item.text,
          options,
          originalText: item.text,
        });
      }
    }
  }

  return ambiguous;
}

/**
 * 将用户选择的选项组合成最终步骤文本
 */
export function buildResolvedText(description: string, selectedOptions: string[]): string {
  if (selectedOptions.length === 1) {
    return `${description}：${selectedOptions[0]}`;
  }
  return `${description}：${selectedOptions.join(" + ")}`;
}
