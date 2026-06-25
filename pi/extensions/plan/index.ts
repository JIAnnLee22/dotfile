/**
 * Agent Plan — 融合计划模式
 *
 * 融合 Claude Code / Cursor / OpenCode 优点：
 * - 只读探索 → 结构化计划 → 用户审阅 → 批准构建（Claude Code）
 * - 澄清问题、迭代完善、Explore → Plan → Build（Cursor）
 * - 简洁阶段切换、计划落盘（OpenCode）
 *
 * 命令：/plan /plan resume /plan model ... /build /todos /plans
 * 快捷键：Ctrl+Alt+L 切换计划模式
 */

import fs from "fs";
import os from "os";
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
  extractTodoItemsFromSavedMarkdown,
} from "./utils.ts";

const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
const BUILD_TOOLS = [...READONLY_TOOLS, "edit", "write"] as const;
const MANAGED_TOOL_SET = new Set<string>([...BUILD_TOOLS]);
const READONLY_DISABLED_TOOL_SET = new Set<string>(["edit", "write"]);
const MAX_WIDGET_ITEMS = 8;

const PLAN_CONTEXT_MARKERS = [
  "[计划模式",
  "[PLAN MODE",
  "plan-mode-context",
  "agent-plan-context",
];

interface PlanModelConfig {
  planModel?: string;
  executionModel?: string;
}

interface PersistedState {
  phase: PlanPhase;
  todos: TodoItem[];
  structured: StructuredPlan | null;
  planCreatedAt?: string;
  toolsBeforePlanMode?: string[];
  modelBeforePlanMode?: string;
  modelSnapshotCaptured?: boolean;
}

interface ParsedModelRef {
  provider: string;
  modelId: string;
  ref: string;
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

  let toolsBeforePlanMode: string[] | undefined;
  let modelBeforePlanMode: string | undefined;
  let modelSnapshotCaptured = false;
  let modelConfig: PlanModelConfig = {};

  function isReadonlyPhase(): boolean {
    return phase === "explore" || phase === "review";
  }

  function uniqueToolNames(toolNames: string[]): string[] {
    return [...new Set(toolNames)];
  }

  function getReadonlyTools(baseTools: string[]): string[] {
    return uniqueToolNames([
      ...baseTools.filter((name) => !READONLY_DISABLED_TOOL_SET.has(name)),
      ...READONLY_TOOLS,
    ]);
  }

  function getBuildTools(baseTools: string[]): string[] {
    return uniqueToolNames([
      ...baseTools.filter((name) => !MANAGED_TOOL_SET.has(name)),
      ...BUILD_TOOLS,
    ]);
  }

  function ensureToolsSnapshot(): string[] {
    if (!toolsBeforePlanMode) {
      toolsBeforePlanMode = pi.getActiveTools();
    }
    return toolsBeforePlanMode;
  }

  function applyToolsForPhase(): void {
    if (phase === "off") return;
    const baseTools = ensureToolsSnapshot();
    if (phase === "build") {
      pi.setActiveTools(getBuildTools(baseTools));
      return;
    }
    pi.setActiveTools(getReadonlyTools(baseTools));
  }

  function restoreToolsIfNeeded(): void {
    if (!toolsBeforePlanMode) return;
    pi.setActiveTools(toolsBeforePlanMode);
    toolsBeforePlanMode = undefined;
  }

  function buildTodoWidgetLines(ctx: ExtensionContext): string[] {
    const sorted = [...todoItems].sort((a, b) => a.step - b.step);
    const visible = sorted.slice(0, MAX_WIDGET_ITEMS).map((item) => {
      if (item.completed && item.skipped) {
        return `${ctx.ui.theme.fg("warning", "⏭")} ${ctx.ui.theme.fg("muted", `${item.step}. ${item.text}`)}`;
      }
      if (item.completed) {
        return `${ctx.ui.theme.fg("success", "✓")} ${ctx.ui.theme.fg("muted", `${item.step}. ${item.text}`)}`;
      }
      return `${ctx.ui.theme.fg("dim", "○")} ${item.step}. ${item.text}`;
    });

    if (sorted.length > visible.length) {
      visible.push(ctx.ui.theme.fg("dim", `… 其余 ${sorted.length - visible.length} 步见 /todos`));
    }

    return [ctx.ui.theme.fg("accent", "计划执行进度"), ...visible];
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
      ctx.ui.setWidget("agent-plan-todos", buildTodoWidgetLines(ctx));
      return;
    }

    ctx.ui.setWidget("agent-plan-todos", undefined);

    if (phase !== "off") {
      ctx.ui.setStatus(
        "agent-plan",
        ctx.ui.theme.fg("warning", `[计划·${PHASE_LABELS[phase]}]`),
      );
      return;
    }

    ctx.ui.setStatus("agent-plan", undefined);
  }

  function persistState(): void {
    pi.appendEntry("agent-plan", {
      phase,
      todos: todoItems,
      structured: structuredPlan,
      planCreatedAt,
      toolsBeforePlanMode,
      modelBeforePlanMode,
      modelSnapshotCaptured,
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

  function getGlobalSettingsPath(): string {
    return path.join(process.env.HOME || os.homedir(), ".config/pi/settings.json");
  }

  function loadPlanModelConfig(): PlanModelConfig {
    const configPath = getGlobalSettingsPath();
    if (!fs.existsSync(configPath)) return {};

    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      return {
        planModel: typeof parsed.planModel === "string" ? parsed.planModel.trim() : undefined,
        executionModel: typeof parsed.executionModel === "string" ? parsed.executionModel.trim() : undefined,
      };
    } catch {
      return {};
    }
  }

  function savePlanModelConfig(config: PlanModelConfig): boolean {
    const configPath = getGlobalSettingsPath();

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      } catch {
        // 如果读取失败，使用空对象
      }
    }

    if (config.planModel?.trim()) {
      settings.planModel = config.planModel.trim();
    } else {
      delete settings.planModel;
    }

    if (config.executionModel?.trim()) {
      settings.executionModel = config.executionModel.trim();
    } else {
      delete settings.executionModel;
    }

    try {
      fs.writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  function parseModelRef(rawRef: string): ParsedModelRef | undefined {
    const normalized = rawRef.trim().replace(/^@/, "");
    if (!normalized) return undefined;

    const slashIndex = normalized.indexOf("/");
    if (slashIndex <= 0 || slashIndex >= normalized.length - 1) return undefined;

    const provider = normalized.slice(0, slashIndex).trim();
    const modelId = normalized.slice(slashIndex + 1).trim();
    if (!provider || !modelId) return undefined;

    return { provider, modelId, ref: `${provider}/${modelId}` };
  }

  function getCurrentModelRef(ctx: ExtensionContext): string | undefined {
    if (!ctx.model) return undefined;
    return `${ctx.model.provider}/${ctx.model.id}`;
  }

  function ensureModelSnapshot(ctx: ExtensionContext): void {
    if (modelSnapshotCaptured) return;
    modelBeforePlanMode = getCurrentModelRef(ctx);
    modelSnapshotCaptured = true;
  }

  function getPhaseTargetModelRef(nextPhase: PlanPhase): string | undefined {
    if (nextPhase === "build") return modelConfig.executionModel;
    if (nextPhase === "explore" || nextPhase === "review") return modelConfig.planModel;
    return undefined;
  }

  async function applyModelForPhase(
    ctx: ExtensionContext,
    nextPhase: PlanPhase,
    options?: { notifyOnSuccess?: boolean },
  ): Promise<void> {
    const targetRef = getPhaseTargetModelRef(nextPhase);
    if (!targetRef) return;

    const parsed = parseModelRef(targetRef);
    if (!parsed) {
      ctx.ui.notify(`[计划] 模型配置格式错误: ${targetRef}（应为 provider/model）`, "warning");
      return;
    }

    if (getCurrentModelRef(ctx) === parsed.ref) return;

    const targetModel = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!targetModel) {
      ctx.ui.notify(`[计划] 未找到模型: ${parsed.ref}，请重新配置 /plan model`, "warning");
      return;
    }

    const switched = await pi.setModel(targetModel);
    if (!switched) {
      ctx.ui.notify(`[计划] 无法切换到模型 ${parsed.ref}（可能缺少 API Key）`, "warning");
      return;
    }

    if (options?.notifyOnSuccess) {
      const phaseLabel = nextPhase === "build" ? "执行" : "规划";
      ctx.ui.notify(`[计划] 已切换${phaseLabel}模型: ${parsed.ref}`, "info");
    }
  }

  async function restoreModelIfNeeded(ctx: ExtensionContext): Promise<void> {
    if (!modelSnapshotCaptured) return;

    const previousRef = modelBeforePlanMode;
    modelBeforePlanMode = undefined;
    modelSnapshotCaptured = false;

    if (!previousRef) return;
    if (getCurrentModelRef(ctx) === previousRef) return;

    const parsed = parseModelRef(previousRef);
    if (!parsed) return;

    const previousModel = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!previousModel) {
      ctx.ui.notify(`[计划] 无法恢复之前的模型 ${previousRef}（模型已不存在）`, "warning");
      return;
    }

    const switched = await pi.setModel(previousModel);
    if (!switched) {
      ctx.ui.notify(`[计划] 无法恢复之前的模型 ${previousRef}（可能缺少 API Key）`, "warning");
    }
  }

  async function handlePlanModelCommand(rawArgs: string, ctx: ExtensionContext): Promise<void> {
    const args = rawArgs.trim();
    if (!args || args === "show") {
      const current = getCurrentModelRef(ctx) ?? "未选择";
      const plan = modelConfig.planModel ?? "未配置";
      const execution = modelConfig.executionModel ?? "未配置";
      const configPath = getGlobalSettingsPath();
      ctx.ui.notify(
        `计划模型配置\n\n- 计划模型: ${plan}\n- 执行模型: ${execution}\n- 当前模型: ${current}\n- 全局配置: ${configPath}\n\n用法:\n- /plan model 计划     ← 显示可用模型列表\n- /plan model 执行     ← 显示可用模型列表\n- /plan model 计划 provider/model   ← 手动输入\n- /plan model 执行 provider/model   ← 手动输入\n- /plan model clear 计划|执行`,
        "info",
      );
      return;
    }

    const tokens = args.split(/\s+/).filter(Boolean);
    const command = tokens[0]?.toLowerCase();

    if (command === "clear") {
      const target = tokens[1]?.toLowerCase();
      if (target !== "计划" && target !== "执行") {
        ctx.ui.notify("用法: /plan model clear 计划|执行", "warning");
        return;
      }

      if (target === "计划") delete modelConfig.planModel;
      else delete modelConfig.executionModel;

      if (!savePlanModelConfig(modelConfig)) {
        ctx.ui.notify("保存计划模型配置失败。", "error");
        return;
      }

      ctx.ui.notify(`[计划] 已清除 ${target} 模型配置。`, "info");
      return;
    }

    let target: "计划" | "执行" | undefined;
    let modelRefText = "";

    if (command === "计划" || command === "执行") {
      target = command;
      modelRefText = tokens.slice(1).join(" ");
    } else if (command === "set") {
      const slot = tokens[1]?.toLowerCase();
      if (slot === "计划" || slot === "执行") {
        target = slot;
        modelRefText = tokens.slice(2).join(" ");
      }
    }

    // 列出可用模型并让用户选择
    if (!modelRefText && target) {
      const slotLabel = target === "计划" ? "计划" : "执行";
      const availableModels = ctx.modelRegistry.getAvailable();

      if (availableModels.length === 0) {
        ctx.ui.notify("当前无可用模型（请先配置 API Key）", "warning");
        return;
      }

      // 按 provider 分组显示
      const modelOptions: string[] = [];
      const modelMap = new Map<string, string>(); // displayText -> ref

      for (const m of availableModels) {
        const ref = `${m.provider}/${m.id}`;
        const currentMark = getCurrentModelRef(ctx) === ref ? " ←当前" : "";
        const display = `${m.provider}/${m.id}${currentMark}`;
        modelOptions.push(display);
        modelMap.set(display, ref);
      }

      // 添加取消选项
      modelOptions.push("取消");

      const choice = await ctx.ui.select(
        `选择${slotLabel}模型（${target}）：`,
        modelOptions,
      );

      if (!choice || choice === "取消") {
        ctx.ui.notify("已取消选择。", "info");
        return;
      }

      const selectedRef = modelMap.get(choice);
      if (!selectedRef) {
        ctx.ui.notify("选择无效。", "error");
        return;
      }

      modelRefText = selectedRef;
    }

    if (!target || !modelRefText) {
      ctx.ui.notify("用法: /plan model 计划 或 /plan model 执行（显示模型列表）", "warning");
      return;
    }

    const parsed = parseModelRef(modelRefText);
    if (!parsed) {
      ctx.ui.notify("模型格式错误，应为 provider/model。", "warning");
      return;
    }

    const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) {
      ctx.ui.notify(`未找到模型: ${parsed.ref}`, "warning");
      return;
    }

    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      ctx.ui.notify(`已保存 ${parsed.ref}，但当前尚未配置可用认证。`, "warning");
    }

    if (target === "计划") modelConfig.planModel = parsed.ref;
    else modelConfig.executionModel = parsed.ref;

    if (!savePlanModelConfig(modelConfig)) {
      ctx.ui.notify("保存计划模型配置失败。", "error");
      return;
    }

    ctx.ui.notify(`[计划] 已设置 ${target} 模型为 ${parsed.ref}`, "info");

    const shouldApplyImmediately =
      (target === "计划" && (phase === "explore" || phase === "review")) ||
      (target === "执行" && phase === "build");

    if (shouldApplyImmediately) {
      await applyModelForPhase(ctx, phase, { notifyOnSuccess: true });
      persistState();
    }
  }

  function hydratePlanFromMarkdown(markdown: string): boolean {
    const restoredTodos = extractTodoItemsFromSavedMarkdown(markdown);
    if (restoredTodos.length === 0) return false;

    const parsed = extractStructuredPlan(markdown);
    todoItems = restoredTodos;
    structuredPlan = {
      ...parsed,
      steps: [...restoredTodos],
      rawMarkdown: markdown.trim(),
    };
    return true;
  }

  async function resumeLatestPlan(ctx: ExtensionContext): Promise<void> {
    const latestPath = path.join(ctx.cwd, ".plans", "PLAN.md");
    if (!fs.existsSync(latestPath)) {
      ctx.ui.notify("未找到 .plans/PLAN.md，请先生成或保存计划。", "warning");
      return;
    }

    let markdown = "";
    try {
      markdown = fs.readFileSync(latestPath, "utf-8");
    } catch (err) {
      ctx.ui.notify(`读取计划失败: ${err}`, "error");
      return;
    }

    if (!hydratePlanFromMarkdown(markdown)) {
      ctx.ui.notify("无法从 PLAN.md 解析步骤（请确认文件包含 ## 步骤 清单）。", "warning");
      return;
    }

    ensureToolsSnapshot();
    ensureModelSnapshot(ctx);
    const completed = todoItems.filter((t) => t.completed).length;
    const total = todoItems.length;
    const next = getNextPendingItem(todoItems);

    if (!next) {
      phase = "review";
      applyToolsForPhase();
      await applyModelForPhase(ctx, phase, { notifyOnSuccess: true });
      updateStatus(ctx);
      persistState();
      ctx.ui.notify(`计划已恢复（${completed}/${total}），所有步骤均已完成。`, "info");
      return;
    }

    phase = "build";
    applyToolsForPhase();
    await applyModelForPhase(ctx, phase, { notifyOnSuccess: true });
    updateStatus(ctx);
    persistState();
    savePlanToMarkdown(ctx);

    pi.sendMessage(
      {
        customType: "agent-plan-build",
        content: `已从 .plans/PLAN.md 恢复计划（${completed}/${total}）。\n请从第 ${next.step} 步继续：${next.text}`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  function resetPlan(): void {
    phase = "off";
    todoItems = [];
    structuredPlan = emptyStructured();
    planCreatedAt = "";
    restoreToolsIfNeeded();
  }

  async function enterExplore(ctx: ExtensionContext): Promise<void> {
    ensureToolsSnapshot();
    ensureModelSnapshot(ctx);
    phase = "explore";
    todoItems = [];
    structuredPlan = emptyStructured();
    planCreatedAt = "";
    applyToolsForPhase();
    await applyModelForPhase(ctx, phase, { notifyOnSuccess: true });
    updateStatus(ctx);
    persistState();
    ctx.ui.notify(
      "[计划·探索] 已启用只读探索\n\n可用: read, bash(只读), grep, find, ls\n禁用: edit, write\n\n流程: 探索 → 审阅 → 构建\n命令: /plan 切换 | /plan resume 恢复计划 | /plan model 配置模型（自动列出可用模型） | /build 批准构建 | /todos 进度 | /plans 文档",
      "info",
    );
  }

  async function exitPlanMode(ctx: ExtensionContext, message?: string): Promise<void> {
    resetPlan();
    await restoreModelIfNeeded(ctx);
    updateStatus(ctx);
    persistState();
    if (message) ctx.ui.notify(message, "info");
  }

  async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
    if (phase === "off") {
      await enterExplore(ctx);
      return;
    }
    await exitPlanMode(ctx, "[计划] 已退出，完整工具访问已恢复。");
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

    ensureToolsSnapshot();
    ensureModelSnapshot(ctx);
    phase = "build";
    applyToolsForPhase();
    await applyModelForPhase(ctx, phase, { notifyOnSuccess: true });
    updateStatus(ctx);
    persistState();
    savePlanToMarkdown(ctx);

    const next = getNextPendingItem(todoItems);
    const msg = next
      ? `计划已批准。请从第 ${next.step} 步开始：${next.text}`
      : "计划已批准，请开始执行。";

    pi.sendMessage(
      { customType: "agent-plan-build", content: msg, display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    return true;
  }

  async function handleReview(ctx: ExtensionContext): Promise<void> {
    ensureToolsSnapshot();
    ensureModelSnapshot(ctx);
    phase = "review";
    applyToolsForPhase();
    await applyModelForPhase(ctx, phase, { notifyOnSuccess: true });
    updateStatus(ctx);
    persistState();
    savePlanToMarkdown(ctx);

    const summary = formatStructuredSummary(structuredPlan);
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
      applyToolsForPhase();
      await applyModelForPhase(ctx, phase, { notifyOnSuccess: true });
      updateStatus(ctx);
      persistState();
      const refinement = await ctx.ui.editor("请说明需要调整的内容：", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(
          `请根据以下反馈修订计划（保持结构化格式，仍为只读探索）：\n\n${refinement.trim()}`,
          { deliverAs: "followUp" },
        );
      }
    } else if (choice?.startsWith("💾")) {
      phase = "review";
      ctx.ui.notify("计划已保存。输入 /build 可随时开始构建，/plan 退出计划模式。", "info");
      persistState();
    } else {
      await exitPlanMode(ctx, "计划已取消。");
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
        pi.sendUserMessage(answers.trim(), { deliverAs: "followUp" });
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
    description: "切换计划模式；支持 /plan resume 与 /plan model ...",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw) {
        await togglePlanMode(ctx);
        return;
      }

      const [subcommand, ...rest] = raw.split(/\s+/);
      const normalized = subcommand.toLowerCase();

      if (normalized === "resume") {
        await resumeLatestPlan(ctx);
        return;
      }

      if (normalized === "model") {
        await handlePlanModelCommand(rest.join(" "), ctx);
        return;
      }

      ctx.ui.notify("未知参数。用法: /plan | /plan resume | /plan model ...", "warning");
    },
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
    handler: async (ctx) => {
      await togglePlanMode(ctx);
    },
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

  pi.on("before_agent_start", async (_event, ctx) => {
    if (phase === "explore") {
      return {
        message: {
          customType: "agent-plan-context",
          content: buildExplorePrompt(ctx.model),
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
          content: buildReviewPrompt(md, ctx.model),
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
          content: buildBuildPrompt(remaining, ctx.model),
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
        await exitPlanMode(ctx);
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
    modelConfig = loadPlanModelConfig(ctx.cwd);

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
      toolsBeforePlanMode = saved.data.toolsBeforePlanMode;
      modelBeforePlanMode = saved.data.modelBeforePlanMode;
      modelSnapshotCaptured = saved.data.modelSnapshotCaptured ?? false;
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

    if (phase === "off") {
      restoreToolsIfNeeded();
      await restoreModelIfNeeded(ctx);
    } else {
      ensureToolsSnapshot();
      ensureModelSnapshot(ctx);
      applyToolsForPhase();
      await applyModelForPhase(ctx, phase);
    }

    updateStatus(ctx);
  });
}
