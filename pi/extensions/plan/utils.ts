/**
 * 计划模式工具函数
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
      if (!inSingle) escaped = true;
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

export function hasUnsafeRedirect(segment: string): boolean {
  const withoutAllowedStderrRedirects = segment
    .replace(/(^|[^\d])2>>?\s*\/dev\/null\b/g, "$1")
    .replace(/(^|[^\d])2>\s*&1\b/g, "$1")
    .replace(/(^|[^\d])&>>?\s*\/dev\/null\b/g, "$1")
    .replace(/(^|[^\d])&>\s*&1\b/g, "$1");

  if (/(?:^|[^\d])(?:\d+)?>>\s*\S/.test(withoutAllowedStderrRedirects)) return true;
  if (/(?:^|[^\d])(?:\d+)?>\|?\s*\S/.test(withoutAllowedStderrRedirects)) return true;
  return /(?:^|[^\d])(?:\d+)?<>\s*\S/.test(withoutAllowedStderrRedirects);
}

function segmentIsSafe(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return true;
  if (DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed))) return false;
  if (hasUnsafeRedirect(trimmed)) return false;
  return SAFE_PATTERNS.some((p) => p.test(trimmed));
}

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return splitCommandSegments(trimmed).every(segmentIsSafe);
}

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
  skipped?: boolean;
}

export interface StructuredPlan {
  overview: string;
  approach: string;
  keyFiles: string;
  risks: string;
  verification: string;
  steps: TodoItem[];
  questions: string[];
  rawMarkdown: string;
}

export function cleanStepText(text: string): string {
  return text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSection(message: string, titles: string[]): string {
  for (const title of titles) {
    const pattern = new RegExp(
      `(?:^|\\n)#{1,3}\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`,
      "i",
    );
    const match = message.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

export function extractClarifyingQuestions(message: string): string[] {
  const section = extractSection(message, [
    "澄清问题",
    "Clarifying Questions",
    "Questions",
    "待澄清",
  ]);
  if (!section) return [];

  const questions: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
    if (m?.[1]) {
      const q = cleanStepText(m[1]);
      if (q.length > 3) questions.push(q);
    }
  }
  return questions;
}

export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  const section = extractSection(message, ["执行步骤", "Steps", "Plan", "计划", "TODO", "步骤"]);
  const searchText = section || message;

  const headerMatch = searchText.match(/\*{0,2}(?:Plan|计划|TODO|步骤):\*{0,2}/i);
  const planSection = headerMatch
    ? searchText.slice((headerMatch.index ?? 0) + headerMatch[0].length)
    : searchText;

  const lines = planSection.split(/\r?\n/);
  const usedSteps = new Set<number>();
  const stepLinePattern = /^\s*(\d+)[.)]\s+(.+)$/;
  const blankLinePattern = /^\s*$/;
  let started = !!headerMatch;

  for (const line of lines) {
    const stepMatch = line.match(stepLinePattern);
    if (stepMatch) {
      started = true;
      const step = Number(stepMatch[1]);
      const text = stepMatch[2].trim().replace(/\*{1,2}$/, "").trim();

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
      if (blankLinePattern.test(line)) continue;
      continue;
    }

    if (blankLinePattern.test(line)) continue;
    break;
  }

  return items.sort((a, b) => a.step - b.step);
}

export function extractTodoItemsFromSavedMarkdown(message: string): TodoItem[] {
  const section = extractSection(message, ["步骤", "Steps"]);
  if (!section) return [];

  const items: TodoItem[] = [];
  const usedSteps = new Set<number>();
  const checklistPattern = /^\s*-\s*\[(x|X| )\]\s+\*\*(\d+)\.\*\*\s+(.+)$/;

  for (const line of section.split(/\r?\n/)) {
    const match = line.match(checklistPattern);
    if (!match) continue;

    const step = Number(match[2]);
    if (!Number.isFinite(step) || step <= 0 || usedSteps.has(step)) continue;

    const done = match[1].toLowerCase() === "x";
    const skipped = /⏭|\(已跳过\)/u.test(match[3]);
    const text = cleanStepText(
      match[3]
        .replace(/^✅\s*/u, "")
        .replace(/^⏭️?\s*/u, "")
        .replace(/\(已跳过\)/g, "")
        .replace(/~~/g, "")
        .trim(),
    );

    if (text.length <= 3) continue;

    usedSteps.add(step);
    items.push({
      step,
      text,
      completed: done || skipped,
      skipped: skipped || undefined,
    });
  }

  return items.sort((a, b) => a.step - b.step);
}

export function extractStructuredPlan(message: string): StructuredPlan {
  const overview = extractSection(message, ["概述", "Overview", "概览"]);
  const approach = extractSection(message, ["方案", "Approach", "实现方案"]);
  const keyFiles = extractSection(message, ["关键文件", "Key Files", "涉及文件"]);
  const risks = extractSection(message, ["风险", "Risks", "风险与权衡"]);
  const verification = extractSection(message, ["验证", "Verification", "测试计划"]);
  const steps = extractTodoItems(message);
  const questions = extractClarifyingQuestions(message);

  return {
    overview,
    approach,
    keyFiles,
    risks,
    verification,
    steps,
    questions,
    rawMarkdown: message.trim(),
  };
}

export function hasActionablePlan(plan: StructuredPlan): boolean {
  return plan.steps.length > 0;
}

export function getNextPendingItem(items: TodoItem[]): TodoItem | undefined {
  return [...items].sort((a, b) => a.step - b.step).find((t) => !t.completed);
}

export function extractDoneSteps(message: string): number[] {
  const steps = new Set<number>();
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.add(step);
  }
  return [...steps].sort((a, b) => a - b);
}

export function extractSkipSteps(message: string): number[] {
  const steps = new Set<number>();
  for (const match of message.matchAll(/\[SKIP:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.add(step);
  }
  return [...steps].sort((a, b) => a - b);
}

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

export function generateProgressBar(completed: number, total: number, width: number = 20): string {
  if (total === 0) return "";
  const ratio = completed / total;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function formatPlanList(items: TodoItem[], showNumbers: boolean = true): string {
  const sorted = [...items].sort((a, b) => a.step - b.step);
  return sorted
    .map((item) => {
      const prefix = showNumbers ? `${item.step}. ` : "";
      if (item.completed && item.skipped) return `${prefix}⏭️ ${item.text} (已跳过)`;
      if (item.completed) return `${prefix}✅ ${item.text}`;
      return `${prefix}⬜ ${item.text}`;
    })
    .join("\n");
}

export interface PlanSaveMeta {
  sessionId: string;
  phase?: string;
  createdAt?: string;
  updatedAt?: string;
  cwd?: string;
}

export function generatePlanMarkdown(
  items: TodoItem[],
  meta: PlanSaveMeta,
  structured?: Pick<StructuredPlan, "overview" | "approach" | "keyFiles" | "risks" | "verification">,
): string {
  const sorted = [...items].sort((a, b) => a.step - b.step);
  const completed = items.filter((t) => t.completed && !t.skipped).length;
  const skipped = items.filter((t) => t.skipped).length;
  const total = items.length;
  const pending = total - completed - skipped;

  const lines: string[] = [];
  lines.push(`# 执行计划`);
  lines.push("");
  lines.push(`| 属性 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Session | \`${meta.sessionId}\` |`);
  if (meta.phase) lines.push(`| 阶段 | **${meta.phase}** |`);
  if (meta.cwd) lines.push(`| 工作目录 | \`${meta.cwd}\` |`);
  if (meta.createdAt) lines.push(`| 创建时间 | ${meta.createdAt} |`);
  if (meta.updatedAt) lines.push(`| 更新时间 | ${meta.updatedAt} |`);
  lines.push(
    `| 状态 | **${completed}/${total}** 完成${skipped > 0 ? `，${skipped} 跳过` : ""}${pending > 0 ? `，${pending} 待执行` : ""} |`,
  );
  lines.push("");

  if (structured?.overview) {
    lines.push(`## 概述`);
    lines.push("");
    lines.push(structured.overview);
    lines.push("");
  }
  if (structured?.approach) {
    lines.push(`## 方案`);
    lines.push("");
    lines.push(structured.approach);
    lines.push("");
  }
  if (structured?.keyFiles) {
    lines.push(`## 关键文件`);
    lines.push("");
    lines.push(structured.keyFiles);
    lines.push("");
  }
  if (structured?.risks) {
    lines.push(`## 风险`);
    lines.push("");
    lines.push(structured.risks);
    lines.push("");
  }

  lines.push(`## 进度`);
  lines.push("");
  const progress = generateProgressBar(completed, total, 20);
  lines.push(`\`${progress}\` ${total > 0 ? Math.round((completed / total) * 100) : 0}%`);
  lines.push("");

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

  if (structured?.verification) {
    lines.push(`## 验证`);
    lines.push("");
    lines.push(structured.verification);
    lines.push("");
  }

  return lines.join("\n");
}

export function getPlanSummary(items: TodoItem[]): string {
  const completed = items.filter((t) => t.completed).length;
  return `${completed}/${items.length}`;
}

export interface AmbiguousStep {
  step: number;
  description: string;
  options: string[];
  originalText: string;
}

const AMBIGUOUS_PATTERN = /\[\?\]\s*(.+)$/;
const OPTION_SEPARATOR = /[|/｜]/;
const COMMA_SEPARATOR = /，|,(?![^(]*\))/;

export function isAmbiguousStep(text: string): boolean {
  return AMBIGUOUS_PATTERN.test(text);
}

export function parseAmbiguousSteps(items: TodoItem[]): AmbiguousStep[] {
  const ambiguous: AmbiguousStep[] = [];

  for (const item of items) {
    const match = item.text.match(AMBIGUOUS_PATTERN);
    if (match) {
      const description = item.text.replace(AMBIGUOUS_PATTERN, "").trim();
      const optionStr = match[1].trim();

      let options = optionStr
        .split(OPTION_SEPARATOR)
        .map((o) => o.trim())
        .filter((o) => o.length > 0);

      if (options.length < 2) {
        options = optionStr
          .split(COMMA_SEPARATOR)
          .map((o) => o.trim())
          .filter((o) => o.length > 0);
      }

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

export function buildResolvedText(description: string, selectedOptions: string[]): string {
  if (selectedOptions.length === 1) return `${description}：${selectedOptions[0]}`;
  return `${description}：${selectedOptions.join(" + ")}`;
}

export function formatStructuredSummary(plan: StructuredPlan): string {
  const parts: string[] = [];
  if (plan.overview) parts.push(`**概述**\n${plan.overview}`);
  if (plan.approach) parts.push(`**方案**\n${plan.approach}`);
  if (plan.keyFiles) parts.push(`**关键文件**\n${plan.keyFiles}`);
  if (plan.risks) parts.push(`**风险**\n${plan.risks}`);
  if (plan.steps.length > 0) parts.push(`**步骤**\n${formatPlanList(plan.steps)}`);
  if (plan.verification) parts.push(`**验证**\n${plan.verification}`);
  return parts.join("\n\n");
}
