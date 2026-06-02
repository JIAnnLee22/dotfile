/**
 * Plan Mode Extension (优化版)
 *
 * 只读探索模式，用于安全地分析代码并制定计划。
 *
 * 改进点：
 * - 更美观的 UI 显示（进度条、颜色主题）
 * - 更流畅的流程切换（计划模式 → 执行模式）
 * - 中文界面支持
 * - 更健壮的计划解析
 * - 支持跳过步骤
 * - 实时进度反馈
 * - 右上角悬浮计划窗口，支持滚动
 * - 计划自动保存为 Markdown 文档（.plans/ 目录）
 *
 * 快捷键：
 * - /plan - 切换计划模式
 * - /todos - 显示当前进度
 * - /plans - 查看已保存的计划文档
 * - Ctrl+Alt+L - 切换计划模式
 * - Ctrl+Alt+P - 显示/隐藏计划悬浮窗口
 */

import fs from "fs";
import path from "path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
  extractTodoItems,
  isSafeCommand,
  markCompletedSteps,
  markSkippedSteps,
  getNextPendingItem,
  generateProgressBar,
  formatPlanList,
  generatePlanMarkdown,
  parseAmbiguousSteps,
  buildResolvedText,
  type TodoItem,
  type AmbiguousStep,
} from "./utils.ts";
import { createPlanListOverlay, type PlanListComponent } from "./plan-list-overlay.ts";

// 工具列表配置（计划模式 = 只读；执行/正常模式 = 只读 + 编辑）
const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
const PLAN_MODE_TOOLS = [...READONLY_TOOLS];
const EXECUTION_MODE_TOOLS = [...READONLY_TOOLS, "edit", "write"];
const NORMAL_MODE_TOOLS = EXECUTION_MODE_TOOLS;

// 类型守卫
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

// 提取消息文本内容
function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];
  let currentSessionId = "";
  let currentCwd = "";
  
  // 悬浮窗口状态
  let planOverlayHandle: { close: () => void; setHidden: (hidden: boolean) => void } | null = null;
  let planOverlayComponent: PlanListComponent | null = null;
  let planOverlayVisible = false;
  let closingOverlay = false;

  // 注册命令行参数
  pi.registerFlag("plan", {
    description: "以计划模式启动（只读探索）",
    type: "boolean",
    default: false,
  });

  function resetOverlayState(): void {
    planOverlayHandle = null;
    planOverlayComponent = null;
    planOverlayVisible = false;
    closingOverlay = false;
  }

  function closePlanOverlay(): void {
    if (!planOverlayHandle) {
      resetOverlayState();
      return;
    }
    if (closingOverlay) return;
    closingOverlay = true;
    planOverlayHandle.close();
  }

  function openPlanOverlay(ctx: ExtensionContext): void {
    if (todoItems.length === 0) {
      ctx.ui.notify("暂无计划可显示。请先创建计划。", "info");
      return;
    }
    if (planOverlayVisible && planOverlayHandle) {
      return;
    }

    if (planOverlayVisible && !planOverlayHandle) {
      resetOverlayState();
    }

    planOverlayVisible = true;
    void ctx.ui.custom(
      (_tui, theme, _keybindings, done) => {
        const component = createPlanListOverlay(theme as any, () => {
          resetOverlayState();
          done(undefined);
        });
        component.setItems(todoItems);
        planOverlayComponent = component;
        return component;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-right",
          width: 45,
          maxHeight: "60%",
          margin: 1,
        },
        onHandle: (handle) => {
          planOverlayHandle = handle;
          closingOverlay = false;
        },
      }
    );
  }

  /**
   * 显示/隐藏计划悬浮窗口
   */
  function togglePlanOverlay(ctx: ExtensionContext): void {
    if (todoItems.length === 0) {
      ctx.ui.notify("暂无计划可显示。请先创建计划。", "info");
      return;
    }
    if (planOverlayVisible) {
      if (planOverlayHandle) {
        closePlanOverlay();
      } else {
        resetOverlayState();
        openPlanOverlay(ctx);
      }
      return;
    }
    openPlanOverlay(ctx);
  }

  /**
   * 更新 UI 状态显示
   */
  function updateStatus(ctx: ExtensionContext): void {
    // 底部状态栏
    if (executionMode && todoItems.length > 0) {
      const completed = todoItems.filter((t) => t.completed).length;
      const total = todoItems.length;
      const progress = generateProgressBar(completed, total, 10);
      ctx.ui.setStatus(
        "plan-mode",
        ctx.ui.theme.fg("accent", `[EXEC] ${progress} ${completed}/${total}`),
      );
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "[PLAN]"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }

    // 更新悬浮窗口内容
    if (planOverlayComponent && planOverlayVisible) {
      planOverlayComponent.setItems(todoItems);
    }
  }

  /**
   * 切换计划模式
   */
  function togglePlanMode(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled;
    executionMode = false;
    todoItems = [];

    if (planModeEnabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
      ctx.ui.notify("[PLAN] 计划模式已启用\n\n可用工具: read, bash (只读), grep, find, ls\n\n请分析代码并创建计划。\n按 Ctrl+Alt+L 切换计划模式，按 Ctrl+Alt+P 显示/隐藏计划窗口。", "info");
    } else {
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      closePlanOverlay();
      ctx.ui.notify("[PLAN] 计划模式已禁用，完整访问权限已恢复。", "info");
    }
    updateStatus(ctx);
  }

  /**
   * 持久化状态
   */
  function persistState(): void {
    pi.appendEntry("plan-mode", {
      enabled: planModeEnabled,
      todos: todoItems,
      executing: executionMode,
    });
  }

  /**
   * 获取计划保存目录
   */
  function getPlansDir(cwd: string): string {
    const plansDir = path.join(cwd, ".plans");
    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }
    return plansDir;
  }

  /**
   * 保存计划为 Markdown 文档
   */
  function savePlanToMarkdown(ctx: ExtensionContext): void {
    if (todoItems.length === 0) return;

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const plansDir = getPlansDir(ctx.cwd);
    const fileName = `plan-${currentSessionId}.md`;
    const filePath = path.join(plansDir, fileName);

    // 读取已有的创建时间
    let createdAt = timestamp;
    if (fs.existsSync(filePath)) {
      try {
        const existing = fs.readFileSync(filePath, "utf-8");
        const match = existing.match(/\| 创建时间 \| (.+) \|/);
        if (match) createdAt = match[1];
      } catch {}
    }

    const md = generatePlanMarkdown(todoItems, {
      sessionId: currentSessionId,
      cwd: ctx.cwd,
      createdAt,
      updatedAt: timestamp,
    });

    try {
      fs.writeFileSync(filePath, md, "utf-8");
    } catch (err) {
      ctx.ui.notify(`计划保存失败: ${err}`, "error");
    }
  }

  /**
   * 列出已保存的计划文件
   */
  function listSavedPlans(cwd: string): string[] {
    const plansDir = path.join(cwd, ".plans");
    if (!fs.existsSync(plansDir)) return [];
    return fs.readdirSync(plansDir)
      .filter((f) => f.endsWith(".md") && f.startsWith("plan-"))
      .sort();
  }

  /**
   * 解析歧义步骤 - 让用户选择方案
   */
  async function resolveAmbiguities(ambiguous: AmbiguousStep[], ctx: ExtensionContext): Promise<void> {
    for (const amb of ambiguous) {
      // 构建选项列表：所有方案 + 自定义输入 + 跳过此步
      const options = [
        ...amb.options,
        "✏️ 自定义输入",
        "⏭️ 跳过此步（不执行）",
      ];

      const title = `步骤 ${amb.step}：${amb.description}\n\n检测到多种等效方案，请选择：`;
      const choice = await ctx.ui.select(title, options);

      if (!choice) {
        // 用户取消选择，保留原始文本
        continue;
      }

      if (choice === "⏭️ 跳过此步（不执行）") {
        // 移除此步骤
        todoItems = todoItems.filter((t) => t.step !== amb.step);
        ctx.ui.notify(`步骤 ${amb.step} 已跳过。`, "info");
        continue;
      }

      if (choice === "✏️ 自定义输入") {
        const customText = await ctx.ui.input(
          `步骤 ${amb.step}：${amb.description}\n\n请输入你的方案：`,
          "例如：使用 Redis 做缓存",
        );
        if (customText?.trim()) {
          const item = todoItems.find((t) => t.step === amb.step);
          if (item) {
            item.text = buildResolvedText(amb.description, [customText.trim()]);
          }
          ctx.ui.notify(`步骤 ${amb.step} 已更新为自定义方案。`, "info");
        }
        continue;
      }

      // 检查是否允许多选（用户可能想组合多个方案）
      const multiSelect = await ctx.ui.confirm(
        `已选择「${choice}」`,
        "是否还需要添加其他方案？",
      );

      if (multiSelect) {
        // 让用户再选一个
        const remainingOptions = amb.options.filter((o) => o !== choice);
        if (remainingOptions.length > 0) {
          const secondChoice = await ctx.ui.select(
            `步骤 ${amb.step}：再选一个方案（将组合使用）`,
            [...remainingOptions, "不再添加"],
          );
          if (secondChoice && secondChoice !== "不再添加") {
            const item = todoItems.find((t) => t.step === amb.step);
            if (item) {
              item.text = buildResolvedText(amb.description, [choice, secondChoice]);
            }
          } else {
            const item = todoItems.find((t) => t.step === amb.step);
            if (item) {
              item.text = buildResolvedText(amb.description, [choice]);
            }
          }
        } else {
          const item = todoItems.find((t) => t.step === amb.step);
          if (item) {
            item.text = buildResolvedText(amb.description, [choice]);
          }
        }
      } else {
        const item = todoItems.find((t) => t.step === amb.step);
        if (item) {
          item.text = buildResolvedText(amb.description, [choice]);
        }
      }

      ctx.ui.notify(`步骤 ${amb.step} 已更新。`, "info");
    }
  }

  // 注册 /plan 命令
  pi.registerCommand("plan", {
    description: "切换计划模式（只读探索）",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  // 注册 /todos 命令
  pi.registerCommand("todos", {
    description: "显示当前计划进度",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("暂无计划。请先使用 /plan 启用计划模式，然后创建计划。", "info");
        return;
      }
      const list = formatPlanList(todoItems);
      const completed = todoItems.filter((t) => t.completed).length;
      const total = todoItems.length;
      const progress = generateProgressBar(completed, total, 20);
      ctx.ui.notify(
        `计划进度 ${completed}/${total}\n${progress}\n\n${list}`,
        "info",
      );
    },
  });

  // 注册 /plans 命令 - 查看已保存的计划文档
  pi.registerCommand("plans", {
    description: "查看已保存的计划文档",
    handler: async (_args, ctx) => {
      const plans = listSavedPlans(ctx.cwd);
      if (plans.length === 0) {
        ctx.ui.notify("暂无已保存的计划文档。", "info");
        return;
      }
      const plansDir = path.join(ctx.cwd, ".plans");
      const list = plans.map((f) => {
        const filePath = path.join(plansDir, f);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          // 提取状态行
          const statusMatch = content.match(/\| 状态 \| \*\*(\d+\/\d+)\*\*/);
          const timeMatch = content.match(/\| 更新时间 \| (.+) \|/);
          const status = statusMatch ? statusMatch[1] : "?/?";
          const time = timeMatch ? timeMatch[1] : "未知";
          return `  📄 ${f}  [${status}]  ${time}`;
        } catch {
          return `  📄 ${f}  (读取失败)`;
        }
      });
      ctx.ui.notify(
        `已保存的计划 (${plans.length} 个)\n${"\u2500".repeat(40)}\n${list.join("\n")}\n\n文件位置: ${plansDir}`,
        "info",
      );
    },
  });

  // 注册快捷键 - 切换计划模式
  pi.registerShortcut(Key.ctrlAlt("l"), {
    description: "切换计划模式",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // 注册快捷键 - 显示/隐藏计划悬浮窗口
  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "显示/隐藏计划悬浮窗口",
    handler: async (ctx) => {
      if (planOverlayVisible && !planOverlayHandle) {
        resetOverlayState();
      }
      togglePlanOverlay(ctx);
    },
  });

  // 拦截危险的 bash 命令
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return;

    const command = event.input.command as string;
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `[PLAN] 计划模式：命令被阻止（不在允许列表中）\n\n命令: ${command}\n\n如需执行修改操作，请先使用 /plan 退出计划模式。`,
      };
    }
  });

  // 过滤非计划模式下的陈旧上下文
  pi.on("context", async (event) => {
    if (planModeEnabled) return;

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType === "plan-mode-context") return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (typeof content === "string") {
          return !content.includes("[PLAN MODE ACTIVE]");
        }
        if (Array.isArray(content)) {
          return !content.some(
            (c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
          );
        }
        return true;
      }),
    };
  });

  // 注入计划/执行上下文
  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[计划模式已激活]

你当前处于计划模式 - 一个用于安全代码分析的只读探索模式。

[限制]
- 只能使用: read, bash (只读命令), grep, find, ls
- 不能使用: edit, write（文件修改已禁用）
- Bash 命令仅限于安全的只读命令

[任务]
1. 深入分析代码结构、逻辑和依赖关系
2. 精确定位需要修改的文件、函数和代码行
3. 创建详细的执行计划，每步说明具体修改内容

[创建计划]
请在响应中使用以下格式创建计划：

Plan:
1. [文件路径] 修改描述：具体说明要修改什么内容
2. [文件路径] 修改描述：具体说明要修改什么内容
3. [文件路径] 修改描述：具体说明要修改什么内容
...

[歧义标记]
如果某一步骤有多种等效的解决方案（效果差不多），请使用 [?] 标记并列出选项：

格式：1. [文件路径] 步骤描述 [?] 方案A | 方案B | 方案C

示例：
1. [src/auth.ts] 实现用户认证 [?] JWT Token | Session-based | OAuth2
2. [src/cache.ts] 添加缓存层 [?] Redis | Memcached | 本地 LRU Cache
3. [src/db.ts] 选择数据库ORM [?] Prisma | TypeORM | Drizzle

注意：
- 只在方案效果相近时才使用 [?] 标记
- 如果有明显最佳方案，直接写出即可，不需要标记
- 选项用 | 分隔，至少列出 2 个选项

[计划要求]
- 每一步必须明确指出涉及的文件路径（如 src/auth/login.ts）
- 每一步必须简要说明具体的修改内容（如：在 login 函数中添加参数验证逻辑）
- 避免模糊描述（如"修改代码"、"更新文件"）
- 如果涉及多个文件的关联修改，应在同一步骤中说明

[重要] 不要尝试进行任何修改，只需详细描述你会做什么。`,
          display: false,
        },
      };
    }

    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((t) => !t.completed);
      const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[执行计划中 - 完整工具访问已启用]

剩余步骤:
${todoList}

[执行规则]
1. 按顺序执行每个步骤
2. 完成步骤后，在响应中包含 [DONE:n] 标记（n 为步骤编号）
3. 如需跳过某步骤，使用 [SKIP:n] 标记

请确保每个步骤都得到妥善处理。`,
          display: false,
        },
      };
    }
  });

  // 跟踪每轮执行进度
  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);

    // 检查完成的步骤
    const completedCount = markCompletedSteps(text, todoItems);
    const skippedCount = markSkippedSteps(text, todoItems);

    if (completedCount > 0 || skippedCount > 0) {
      updateStatus(ctx);
      persistState();
      savePlanToMarkdown(ctx);
    }
  });

  // 处理计划完成和 UI 交互
  pi.on("agent_end", async (event, ctx) => {
    // 检查执行是否完成
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed || t.skipped)) {
        const completedList = todoItems
          .map((t) => (t.skipped ? `[SKIP] ${t.text}` : `[DONE] ${t.text}`))
          .join("\n");

        const skippedCount = todoItems.filter((t) => t.skipped).length;
        const completedCount = todoItems.filter((t) => t.completed && !t.skipped).length;
        const summary = `[完成] 计划执行完成！\n\n完成: ${completedCount}\n跳过: ${skippedCount}\n总计: ${todoItems.length}\n\n${completedList}`;

        pi.sendMessage(
          { customType: "plan-complete", content: summary, display: true },
          { triggerTurn: false },
        );
        savePlanToMarkdown(ctx);
        executionMode = false;
        todoItems = [];
        pi.setActiveTools(NORMAL_MODE_TOOLS);
        
        closePlanOverlay();
        
        updateStatus(ctx);
        persistState();
      }
      return;
    }

    if (!planModeEnabled || !ctx.hasUI) return;

    // 从最后的助手消息中提取计划
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractTodoItems(getTextContent(lastAssistant));
      if (extracted.length > 0) {
        todoItems = extracted;
      }
    }

    // 检测歧义步骤并让用户选择
    if (todoItems.length > 0) {
      const ambiguous = parseAmbiguousSteps(todoItems);
      if (ambiguous.length > 0) {
        ctx.ui.notify(`检测到 ${ambiguous.length} 个歧义步骤，请逐一选择方案。`, "info");
        await resolveAmbiguities(ambiguous, ctx);
      }
    }

    // 显示计划步骤
    if (todoItems.length > 0) {
      const planDisplay = formatPlanList(todoItems);
      const total = todoItems.length;
      const plansDir = getPlansDir(ctx.cwd);
      const fileName = `plan-${currentSessionId}.md`;
      const filePath = path.join(plansDir, fileName);
      const fileHint = fs.existsSync(filePath) ? `\n📄 已保存至: .plans/${fileName}` : "";

      // 保存计划为 Markdown
      savePlanToMarkdown(ctx);

      pi.sendMessage(
        {
          customType: "plan-todo-list",
          content: `**计划已创建** (${total} 步)\n\n${planDisplay}\n\n按 Ctrl+Alt+P 显示/隐藏计划悬浮窗口${fileHint}`,
          display: true,
        },
        { triggerTurn: false },
      );
      
      // 自动显示悬浮窗口
      if (!planOverlayVisible || !planOverlayHandle) {
        openPlanOverlay(ctx);
      }
    }

    // 选择下一步操作（无计划时不展示执行选项）
    const hasPlanItems = todoItems.length > 0;
    const choices = hasPlanItems
      ? [
          "执行计划（跟踪进度）",
          "继续完善计划",
          "取消计划",
        ]
      : [
          "继续完善计划",
          "取消计划",
        ];

    const choice = await ctx.ui.select("计划模式 - 下一步操作？", choices);

    if (choice?.startsWith("执行")) {
      if (!hasPlanItems) {
        ctx.ui.notify(
          "未检测到计划步骤。请先选择「继续完善计划」并使用 Plan:\n1. [文件路径] 修改描述 格式。",
          "warning",
        );
        return;
      }

      planModeEnabled = false;
      executionMode = true;
      pi.setActiveTools(EXECUTION_MODE_TOOLS);
      updateStatus(ctx);
      persistState();

      const next = getNextPendingItem(todoItems);
      const execMessage = next
        ? `开始执行计划。请从第 ${next.step} 步开始: ${next.text}`
        : "执行你刚才创建的计划。";
      pi.sendMessage(
        { customType: "plan-mode-execute", content: execMessage, display: true },
        { triggerTurn: true },
      );
    } else if (choice?.startsWith("继续")) {
      const refinement = await ctx.ui.editor("请完善或修改计划：", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim());
      }
    } else if (choice?.startsWith("取消")) {
      todoItems = [];
      executionMode = false;
      planModeEnabled = false;
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      
      closePlanOverlay();
      
      updateStatus(ctx);
      persistState();
      ctx.ui.notify("计划已取消。", "info");
    }
  });

  // 会话启动/恢复时的状态恢复
  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    currentCwd = ctx.cwd;

    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries();

    // 恢复持久化状态
    const planModeEntry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
      .pop() as { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean } } | undefined;

    if (planModeEntry?.data) {
      planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
      todoItems = planModeEntry.data.todos ?? todoItems;
      executionMode = planModeEntry.data.executing ?? executionMode;
    }

    // 恢复时重新扫描消息以重建完成状态
    const isResume = planModeEntry !== undefined;
    if (isResume && executionMode && todoItems.length > 0) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; customType?: string };
        if (entry.customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }

      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
          messages.push(entry.message as AssistantMessage);
        }
      }
      const allText = messages.map(getTextContent).join("\n");
      markCompletedSteps(allText, todoItems);
      markSkippedSteps(allText, todoItems);
    }

    if (executionMode) {
      pi.setActiveTools(EXECUTION_MODE_TOOLS);
    } else if (planModeEnabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
    }
    updateStatus(ctx);
  });
}
