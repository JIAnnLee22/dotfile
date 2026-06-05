/**
 * Agent Plan — 融合计划模式
 *
 * 融合 Claude Code / Cursor / OpenCode 优点：
 * - 只读探索 → 结构化计划 → 用户审阅 → 批准构建（Claude Code）
 * - 澄清问题、迭代完善、Explore → Plan → Build（Cursor）
 * - 简洁阶段切换、计划落盘（OpenCode）
 *
 * 命令：/plan /build /todos /plans
 * 快捷键：Ctrl+Alt+L 切换计划模式
 */

import fs from "fs";
import path from "path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
  type PlanPhase,
  PHASE_LABELS,
  buildExplorePrompt,
  buildReviewPrompt,
  buildBuildPrompt,
  buildQuestionsFollowUp,
} from "./prompts.ts";
import {
  type TodoItem,
  type StructuredPlan,
  type AmbiguousStep,
  isSafeCommand,
  extractStructuredPlan,
  hasActionablePlan,
  markCompletedSteps,
  markSkippedSteps,
  getNextPendingItem,
  generateProgressBar,
  formatPlanList,
  formatStructuredSummary,
  generatePlanMarkdown,
  parseAmbiguousSteps,
  buildResolvedText,
} from "./utils.ts";

const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
const BUILD_TOOLS = [...READONLY_TOOLS, "edit", "write"];
const NORMAL_TOOLS = BUILD_TOOLS;

const PLAN_CONTEXT_MARKERS = [
  "[计划模式",
  "[PLAN MODE",
  "plan-mode-context",
  "agent-plan-context",
];

interface PersistedState {
  phase: PlanPhase;
  todos: TodoItem[];
  structured: StructuredPlan | null;
  planCreatedAt?: string;
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function emptyStructured(): StructuredPlan {
  return {
    overview: "",
    approach: "",
    keyFiles: "",
    risks: "",
    verification: "",
    steps: [],
    questions: [],
    rawMarkdown: "",
  };
}

export default function agentPlanExtension(pi: ExtensionAPI): void {
  let phase: PlanPhase = "off";
  let todoItems: TodoItem[] = [];
  let structuredPlan: StructuredPlan = emptyStructured();
  let currentSessionId = "";
  let planCreatedAt = "";

  pi.registerFlag("plan", {
    description: "以计划模式启动（只读探索）",
    type: "boolean",
    default: false,
  });

  function isReadonlyPhase(): boolean {
    return phase === "explore" || phase === "review";
  }

  function syncTools(): void {
    if (phase === "build") pi.setActiveTools(BUILD_TOOLS);
    else if (isReadonlyPhase()) pi.setActiveTools(READONLY_TOOLS);
    else pi.setActiveTools(NORMAL_TOOLS);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (phase === "build" && todoItems.length > 0) {
      const completed = todoItems.filter((t) => t.completed).length;
      const total = todoItems.length;
      const progress = generateProgressBar(completed, total, 10);
      ctx.ui.setStatus(
        "agent-plan",
        ctx.ui.theme.fg("accent", `[构建] ${progress} ${completed}/${total}`),
      );
    } else if (phase !== "off") {
      ctx.ui.setStatus(
        "agent-plan",
        ctx.ui.theme.fg("warning", `[计划·${PHASE_LABELS[phase]}]`),
      );
    } else {
      ctx.ui.setStatus("agent-plan", undefined);
    }
  }

  function persistState(): void {
    pi.appendEntry("agent-plan", {
      phase,
      todos: todoItems,
      structured: structuredPlan,
      planCreatedAt,
    } satisfies PersistedState);
  }

  function getPlansDir(cwd: string): string {
    const plansDir = path.join(cwd, ".plans");
    if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
    return plansDir;
  }

  function savePlanToMarkdown(ctx: ExtensionContext): void {
    if (todoItems.length === 0 && !structuredPlan.overview) return;

    const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const plansDir = getPlansDir(ctx.cwd);
    const sessionFile = `plan-${currentSessionId}.md`;
    const sessionPath = path.join(plansDir, sessionFile);
    const latestPath = path.join(plansDir, "PLAN.md");

    let createdAt = planCreatedAt || now;
    if (!planCreatedAt) planCreatedAt = createdAt;

    const meta = {
      sessionId: currentSessionId,
      phase: PHASE_LABELS[phase],
      cwd: ctx.cwd,
      createdAt,
      updatedAt: now,
    };

    const md = generatePlanMarkdown(todoItems, meta, structuredPlan);

    try {
      fs.writeFileSync(sessionPath, md, "utf-8");
      fs.writeFileSync(latestPath, md, "utf-8");
    } catch (err) {
      ctx.ui.notify(`计划保存失败: ${err}`, "error");
    }
  }

  function listSavedPlans(cwd: string): string[] {
    const plansDir = path.join(cwd, ".plans");
    if (!fs.existsSync(plansDir)) return [];
    return fs
      .readdirSync(plansDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  }

  function resetPlan(): void {
    phase = "off";
    todoItems = [];
    structuredPlan = emptyStructured();
    planCreatedAt = "";
    syncTools();
  }

  function enterExplore(ctx: ExtensionContext): void {
    phase = "explore";
    todoItems = [];
    structuredPlan = emptyStructured();
    planCreatedAt = "";
    syncTools();
    updateStatus(ctx);
    persistState();
    ctx.ui.notify(
      "[计划·探索] 已启用只读探索\n\n可用: read, bash(只读), grep, find, ls\n禁用: edit, write\n\n流程: 探索 → 审阅 → 构建\n命令: /plan 切换 | /build 批准构建 | /todos 进度 | /plans 文档",
      "info",
    );
  }

  function exitPlanMode(ctx: ExtensionContext, message?: string): void {
    resetPlan();
    updateStatus(ctx);
    persistState();
    if (message) ctx.ui.notify(message, "info");
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    if (phase === "off") {
      enterExplore(ctx);
      return;
    }
    exitPlanMode(ctx, "[计划] 已退出，完整工具访问已恢复。");
  }

  async function resolveAmbiguities(ambiguous: AmbiguousStep[], ctx: ExtensionContext): Promise<void> {
    for (const amb of ambiguous) {
      const options = [...amb.options, "✏️ 自定义输入", "⏭️ 跳过此步"];
      const choice = await ctx.ui.select(
        `步骤 ${amb.step}：${amb.description}\n\n请选择方案：`,
        options,
      );
      if (!choice) continue;

      if (choice === "⏭️ 跳过此步") {
        todoItems = todoItems.filter((t) => t.step !== amb.step);
        ctx.ui.notify(`步骤 ${amb.step} 已跳过。`, "info");
        continue;
      }

      if (choice === "✏️ 自定义输入") {
        const custom = await ctx.ui.input(`步骤 ${amb.step} 自定义方案：`, "");
        if (custom?.trim()) {
          const item = todoItems.find((t) => t.step === amb.step);
          if (item) item.text = buildResolvedText(amb.description, [custom.trim()]);
        }
        continue;
      }

      const multi = await ctx.ui.confirm(`已选择「${choice}」`, "是否组合其他方案？");
      if (multi) {
        const rest = amb.options.filter((o) => o !== choice);
        if (rest.length > 0) {
          const second = await ctx.ui.select("再选一个方案（将组合）", [...rest, "不再添加"]);
          const item = todoItems.find((t) => t.step === amb.step);
          if (item) {
            item.text =
              second && second !== "不再添加"
                ? buildResolvedText(amb.description, [choice, second])
                : buildResolvedText(amb.description, [choice]);
          }
        }
      } else {
        const item = todoItems.find((t) => t.step === amb.step);
        if (item) item.text = buildResolvedText(amb.description, [choice]);
      }
    }
    structuredPlan.steps = [...todoItems];
  }

  async function startBuild(ctx: ExtensionContext): Promise<boolean> {
    if (todoItems.length === 0) {
      ctx.ui.notify("未检测到执行步骤。请先完善计划（需包含 Plan: 编号列表）。", "warning");
      return false;
    }

    phase = "build";
    syncTools();
    updateStatus(ctx);
    persistState();
    savePlanToMarkdown(ctx);

    const next = getNextPendingItem(todoItems);
    const msg = next
      ? `计划已批准。请从第 ${next.step} 步开始：${next.text}`
      : "计划已批准，请开始执行。";

    pi.sendMessage({ customType: "agent-plan-build", content: msg, display: true }, { triggerTurn: true });
    return true;
  }

  async function handleReview(ctx: ExtensionContext): Promise<void> {
    phase = "review";
    updateStatus(ctx);
    persistState();
    savePlanToMarkdown(ctx);

    const summary = formatStructuredSummary(structuredPlan);
    const plansDir = getPlansDir(ctx.cwd);
    const fileHint = `\n\n📄 已保存: .plans/PLAN.md 及 .plans/plan-${currentSessionId}.md`;

    pi.sendMessage(
      {
        customType: "agent-plan-review",
        content: `**计划待审阅** (${todoItems.length} 步)\n\n${summary}${fileHint}\n\n使用 /build 批准构建，或选择下方操作。`,
        display: true,
      },
      { triggerTurn: false },
    );

    const choice = await ctx.ui.select("计划审阅 — 下一步？", [
      "✅ 批准并开始构建",
      "✏️ 继续完善计划",
      "💾 仅保存，暂不构建",
      "❌ 取消计划",
    ]);

    if (choice?.startsWith("✅")) {
      await startBuild(ctx);
    } else if (choice?.startsWith("✏️")) {
      phase = "explore";
      updateStatus(ctx);
      persistState();
      const refinement = await ctx.ui.editor("请说明需要调整的内容：", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(
          `请根据以下反馈修订计划（保持结构化格式，仍为只读探索）：\n\n${refinement.trim()}`,
        );
      }
    } else if (choice?.startsWith("💾")) {
      phase = "review";
      ctx.ui.notify("计划已保存。输入 /build 可随时开始构建，/plan 退出计划模式。", "info");
      persistState();
    } else {
      exitPlanMode(ctx, "计划已取消。");
    }
  }

  async function processAgentPlan(text: string, ctx: ExtensionContext): Promise<void> {
    structuredPlan = extractStructuredPlan(text);
    todoItems = structuredPlan.steps;

    if (structuredPlan.questions.length > 0 && !hasActionablePlan(structuredPlan)) {
      const followUp = buildQuestionsFollowUp(structuredPlan.questions);
      pi.sendMessage(
        { customType: "agent-plan-questions", content: followUp, display: true },
        { triggerTurn: false },
      );
      const answers = await ctx.ui.editor("请回答澄清问题（回答后 Agent 将继续制定计划）：", "");
      if (answers?.trim()) {
        pi.sendUserMessage(answers.trim());
      }
      return;
    }

    if (!hasActionablePlan(structuredPlan)) {
      ctx.ui.notify("未检测到执行步骤。可继续对话完善计划，或 /plan 退出。", "info");
      return;
    }

    const ambiguous = parseAmbiguousSteps(todoItems);
    if (ambiguous.length > 0) {
      ctx.ui.notify(`检测到 ${ambiguous.length} 个歧义步骤，请逐一选择。`, "info");
      await resolveAmbiguities(ambiguous, ctx);
      structuredPlan.steps = [...todoItems];
    }

    await handleReview(ctx);
  }

  // ==================== 命令 ====================

  pi.registerCommand("plan", {
    description: "切换计划模式（探索 → 审阅 → 构建）",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("build", {
    description: "批准计划并开始构建",
    handler: async (_args, ctx) => {
      if (phase === "off") {
        ctx.ui.notify("当前不在计划模式。先用 /plan 进入探索并生成计划。", "info");
        return;
      }
      if (phase === "build") {
        ctx.ui.notify("已在构建阶段。", "info");
        return;
      }
      if (todoItems.length === 0) {
        ctx.ui.notify("尚无执行步骤。请先完善计划。", "warning");
        return;
      }
      await startBuild(ctx);
    },
  });

  pi.registerCommand("todos", {
    description: "显示当前计划进度",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify(`当前阶段: ${PHASE_LABELS[phase]}。暂无步骤。`, "info");
        return;
      }
      const completed = todoItems.filter((t) => t.completed).length;
      const total = todoItems.length;
      const progress = generateProgressBar(completed, total, 20);
      const list = formatPlanList(todoItems);
      ctx.ui.notify(
        `[${PHASE_LABELS[phase]}] 进度 ${completed}/${total}\n${progress}\n\n${list}`,
        "info",
      );
    },
  });

  pi.registerCommand("plans", {
    description: "查看已保存的计划文档",
    handler: async (_args, ctx) => {
      const plans = listSavedPlans(ctx.cwd);
      if (plans.length === 0) {
        ctx.ui.notify("暂无已保存的计划。目录: .plans/", "info");
        return;
      }
      const plansDir = path.join(ctx.cwd, ".plans");
      const list = plans.map((f) => {
        try {
          const content = fs.readFileSync(path.join(plansDir, f), "utf-8");
          const status = content.match(/\| 状态 \| \*\*(\d+\/\d+)\*\*/)?.[1] ?? "?/?";
          const time = content.match(/\| 更新时间 \| (.+) \|/)?.[1] ?? "未知";
          const phaseLabel = content.match(/\| 阶段 \| \*\*(.+)\*\* \|/)?.[1];
          const tag = f === "PLAN.md" ? "📌" : "📄";
          return `  ${tag} ${f}  [${status}]${phaseLabel ? ` ${phaseLabel}` : ""}  ${time}`;
        } catch {
          return `  📄 ${f}  (读取失败)`;
        }
      });
      ctx.ui.notify(`已保存计划 (${plans.length})\n${"─".repeat(36)}\n${list.join("\n")}\n\n📁 ${plansDir}`, "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("l"), {
    description: "切换计划模式",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // ==================== 事件 ====================

  pi.on("tool_call", async (event) => {
    if (!isReadonlyPhase() || event.toolName !== "bash") return;
    const command = event.input.command as string;
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `[计划·${PHASE_LABELS[phase]}] 命令被阻止（只读模式）\n\n命令: ${command}\n\n使用 /build 批准构建后可执行修改操作。`,
      };
    }
  });

  pi.on("context", async (event) => {
    if (phase !== "off") return;
    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType?.startsWith("agent-plan") || msg.customType === "plan-mode-context") {
          return false;
        }
        if (msg.role !== "user") return true;
        const content = msg.content;
        if (typeof content === "string") {
          return !PLAN_CONTEXT_MARKERS.some((mk) => content.includes(mk));
        }
        if (Array.isArray(content)) {
          return !content.some(
            (c) => c.type === "text" && PLAN_CONTEXT_MARKERS.some((mk) => (c as TextContent).text?.includes(mk)),
          );
        }
        return true;
      }),
    };
  });

  pi.on("before_agent_start", async () => {
    if (phase === "explore") {
      return {
        message: {
          customType: "agent-plan-context",
          content: buildExplorePrompt(),
          display: false,
        },
      };
    }

    if (phase === "review") {
      const md = generatePlanMarkdown(todoItems, {
        sessionId: currentSessionId,
        phase: PHASE_LABELS.review,
      }, structuredPlan);
      return {
        message: {
          customType: "agent-plan-context",
          content: buildReviewPrompt(md),
          display: false,
        },
      };
    }

    if (phase === "build" && todoItems.length > 0) {
      const remaining = todoItems
        .filter((t) => !t.completed)
        .map((t) => `${t.step}. ${t.text}`)
        .join("\n");
      return {
        message: {
          customType: "agent-plan-context",
          content: buildBuildPrompt(remaining),
          display: false,
        },
      };
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (phase !== "build" || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    const changed =
      markCompletedSteps(text, todoItems) + markSkippedSteps(text, todoItems);

    if (changed > 0) {
      structuredPlan.steps = [...todoItems];
      updateStatus(ctx);
      persistState();
      savePlanToMarkdown(ctx);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (phase === "build" && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed || t.skipped)) {
        const completedCount = todoItems.filter((t) => t.completed && !t.skipped).length;
        const skippedCount = todoItems.filter((t) => t.skipped).length;
        const list = todoItems
          .map((t) => (t.skipped ? `[SKIP] ${t.text}` : `[DONE] ${t.text}`))
          .join("\n");

        pi.sendMessage(
          {
            customType: "agent-plan-complete",
            content: `**构建完成**\n\n完成: ${completedCount} | 跳过: ${skippedCount} | 总计: ${todoItems.length}\n\n${list}`,
            display: true,
          },
          { triggerTurn: false },
        );

        savePlanToMarkdown(ctx);
        exitPlanMode(ctx);
      }
      return;
    }

    if (phase !== "explore" || !ctx.hasUI) return;

    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (!lastAssistant) return;

    const text = getTextContent(lastAssistant);
    const plan = extractStructuredPlan(text);
    if (plan.questions.length > 0 || plan.steps.length > 0 || plan.overview) {
      await processAgentPlan(text, ctx);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();

    if (pi.getFlag("plan") === true) phase = "explore";

    const entries = ctx.sessionManager.getEntries();
    const saved = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "agent-plan")
      .pop() as { data?: PersistedState } | undefined;

    if (saved?.data) {
      phase = saved.data.phase ?? phase;
      todoItems = saved.data.todos ?? [];
      structuredPlan = saved.data.structured ?? emptyStructured();
      planCreatedAt = saved.data.planCreatedAt ?? "";
      if (todoItems.length > 0) structuredPlan.steps = todoItems;
    }

    // 兼容旧 plan-mode 会话恢复
    const legacy = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
      .pop() as { data?: { enabled?: boolean; todos?: TodoItem[]; executing?: boolean } } | undefined;

    if (legacy?.data && !saved?.data) {
      if (legacy.data.executing) {
        phase = "build";
        todoItems = legacy.data.todos ?? [];
      } else if (legacy.data.enabled) {
        phase = "explore";
        todoItems = legacy.data.todos ?? [];
      }
    }

    if (phase === "build" && todoItems.length > 0) {
      let buildIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { customType?: string };
        if (entry.customType === "agent-plan-build" || entry.customType === "plan-mode-execute") {
          buildIndex = i;
          break;
        }
      }
      const messages: AssistantMessage[] = [];
      for (let i = buildIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
          messages.push(entry.message as AssistantMessage);
        }
      }
      const allText = messages.map(getTextContent).join("\n");
      markCompletedSteps(allText, todoItems);
      markSkippedSteps(allText, todoItems);
      structuredPlan.steps = [...todoItems];
    }

    syncTools();
    updateStatus(ctx);
  });
}
