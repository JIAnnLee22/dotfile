/**
 * Plan Mode Extension (优化版)
 *
 * 只读探索模式，用于安全地分析代码并制定计划。
 *
 * 改进点：
 * - 更美观的 UI 显示（进度条、emoji 图标、颜色主题）
 * - 更流畅的流程切换（计划模式 → 执行模式）
 * - 中文界面支持
 * - 更健壮的计划解析
 * - 支持跳过步骤
 * - 实时进度反馈
 *
 * 快捷键：
 * - /plan - 切换计划模式
 * - /todos - 显示当前进度
 * - Ctrl+Alt+P - 切换计划模式
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
  extractTodoItems,
  isSafeCommand,
  markCompletedSteps,
  generateProgressBar,
  formatPlanList,
  type TodoItem,
} from "./utils.ts";

// 工具列表配置
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

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

  // 注册命令行参数
  pi.registerFlag("plan", {
    description: "以计划模式启动（只读探索）",
    type: "boolean",
    default: false,
  });

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
        ctx.ui.theme.fg("accent", `🚀 ${progress} ${completed}/${total}`),
      );
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "📝 计划模式"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }

    // 进度小组件
    if (executionMode && todoItems.length > 0) {
      const lines: string[] = [];
      const completed = todoItems.filter((t) => t.completed).length;
      const total = todoItems.length;

      // 标题
      lines.push(ctx.ui.theme.fg("accent", `📋 执行进度 (${completed}/${total})`));
      lines.push("");

      // 进度条
      const progressBar = generateProgressBar(completed, total, 16);
      lines.push(ctx.ui.theme.fg("muted", `  ${progressBar}`));
      lines.push("");

      // 步骤列表
      for (const item of todoItems) {
        if (item.completed) {
          lines.push(
            ctx.ui.theme.fg("success", `  ✅ ${item.text}`),
          );
        } else if (item.skipped) {
          lines.push(
            ctx.ui.theme.fg("muted", `  ⏭️  ${item.text}`),
          );
        } else {
          lines.push(`  ⬜ ${item.text}`);
        }
      }

      ctx.ui.setWidget("plan-todos", lines);
    } else {
      ctx.ui.setWidget("plan-todos", undefined);
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
      ctx.ui.notify("📝 计划模式已启用\n\n可用工具: read, bash (只读命令), grep, find, ls\n\n请分析代码并创建计划。", "info");
    } else {
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      ctx.ui.notify("🔓 计划模式已禁用，完整访问权限已恢复。", "info");
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
        ctx.ui.notify("📋 暂无计划。请先使用 /plan 启用计划模式，然后创建计划。", "info");
        return;
      }
      const list = formatPlanList(todoItems);
      const completed = todoItems.filter((t) => t.completed).length;
      const total = todoItems.length;
      const progress = generateProgressBar(completed, total, 20);
      ctx.ui.notify(
        `📊 计划进度 ${completed}/${total}\n${progress}\n\n${list}`,
        "info",
      );
    },
  });

  // 注册快捷键
  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "切换计划模式",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // 拦截危险的 bash 命令
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return;

    const command = event.input.command as string;
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `🚫 计划模式：命令被阻止（不在允许列表中）\n\n命令: ${command}\n\n如需执行修改操作，请先使用 /plan 退出计划模式。`,
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
          content: `[📝 计划模式已激活]

你当前处于计划模式 - 一个用于安全代码分析的只读探索模式。

🔒 限制：
- 只能使用: read, bash (只读命令), grep, find, ls, questionnaire
- 不能使用: edit, write（文件修改已禁用）
- Bash 命令仅限于安全的只读命令

📋 任务：
1. 分析代码结构和逻辑
2. 识别需要修改的部分
3. 创建详细的执行计划

✅ 创建计划：
请在响应中使用以下格式创建计划：

Plan:
1. 第一步描述
2. 第二步描述
3. 第三步描述
...

⚠️ 重要：不要尝试进行任何修改，只需描述你会做什么。`,
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
          content: `[🚀 执行计划中 - 完整工具访问已启用]

剩余步骤:
${todoList}

📋 执行规则：
1. 按顺序执行每个步骤
2. 完成步骤后，在响应中包含 [DONE:n] 标记（n 为步骤编号）
3. 如需跳过某步骤，使用 [SKIP:n] 标记

⚠️ 请确保每个步骤都得到妥善处理。`,
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

    // 检查跳过的步骤
    for (const match of text.matchAll(/\[SKIP:(\d+)\]/gi)) {
      const step = Number(match[1]);
      const item = todoItems.find((t) => t.step === step);
      if (item) {
        item.skipped = true;
        item.completed = true; // 跳过也视为完成
      }
    }

    if (completedCount > 0) {
      updateStatus(ctx);
    }
    persistState();
  });

  // 处理计划完成和 UI 交互
  pi.on("agent_end", async (event, ctx) => {
    // 检查执行是否完成
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed || t.skipped)) {
        const completedList = todoItems
          .map((t) => (t.skipped ? `⏭️ ~~${t.text}~~` : `✅ ~~${t.text}~~`))
          .join("\n");

        const skippedCount = todoItems.filter((t) => t.skipped).length;
        const completedCount = todoItems.filter((t) => t.completed && !t.skipped).length;
        const summary = `🎉 计划执行完成！\n\n✅ 完成: ${completedCount}\n⏭️ 跳过: ${skippedCount}\n📋 总计: ${todoItems.length}\n\n${completedList}`;

        pi.sendMessage(
          { customType: "plan-complete", content: summary, display: true },
          { triggerTurn: false },
        );
        executionMode = false;
        todoItems = [];
        pi.setActiveTools(NORMAL_MODE_TOOLS);
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

    // 显示计划步骤
    if (todoItems.length > 0) {
      const planDisplay = formatPlanList(todoItems);
      const completed = todoItems.filter((t) => t.completed).length;
      const total = todoItems.length;
      pi.sendMessage(
        {
          customType: "plan-todo-list",
          content: `📋 **计划已创建** (${total} 步)\n\n${planDisplay}`,
          display: true,
        },
        { triggerTurn: false },
      );
    }

    // 选择下一步操作
    const choices = todoItems.length > 0
      ? [
          "🚀 执行计划（跟踪进度）",
          "📝 继续完善计划",
          "❌ 取消计划",
        ]
      : [
          "🚀 执行计划",
          "📝 继续完善计划",
          "❌ 取消计划",
        ];

    const choice = await ctx.ui.select("计划模式 - 下一步操作？", choices);

    if (choice?.startsWith("🚀")) {
      planModeEnabled = false;
      executionMode = todoItems.length > 0;
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      updateStatus(ctx);

      const execMessage =
        todoItems.length > 0
          ? `开始执行计划。请从第一步开始: ${todoItems[0].text}`
          : "执行你刚才创建的计划。";
      pi.sendMessage(
        { customType: "plan-mode-execute", content: execMessage, display: true },
        { triggerTurn: true },
      );
    } else if (choice?.startsWith("📝")) {
      const refinement = await ctx.ui.editor("请完善或修改计划：", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim());
      }
    } else if (choice?.startsWith("❌")) {
      todoItems = [];
      planModeEnabled = false;
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      updateStatus(ctx);
      ctx.ui.notify("🗑️ 计划已取消。", "info");
    }
  });

  // 会话启动/恢复时的状态恢复
  pi.on("session_start", async (_event, ctx) => {
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
    }

    if (planModeEnabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
    }
    updateStatus(ctx);
  });
}
