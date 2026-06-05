/**
 * Task Timer Extension
 *
 * 功能：
 * 1. 在每个 agent turn、tool 执行开始时打印当前时间戳
 * 2. Working 时实时显示当前正在做什么（LLM 生成中 / 读取文件 / 执行命令等）
 * 3. 在状态栏实时显示当前 turn 已运行时长
 * 4. 当 agent 长时间无新 turn/tool 进展时，发出超时警告
 *
 * 快捷键：
 * - /timer      查看当前任务计时信息
 * - Ctrl+Alt+T  快速查看计时
 *
 * 配置：
 * - --stall-timeout=120   无进展超时秒数（默认 120）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

// nerd font icons (不依赖 emoji，终端兼容性好)
const I_CLOCK   = "\uf017"; // 
const I_PLAY    = "\uf04b"; // 
const I_DONE    = "\uf00c"; // 
const I_FAIL    = "\uf00d"; // 
const I_WARN    = "\uf071"; // 
const I_TOOL    = "\uf085"; // 
const I_TURN    = "\uf0e7"; // 
const I_SEP     = "\uf460"; // 
const I_THINK   = "\uf0eb"; // 
const I_LLM     = "\uf084"; // 
const I_FILE    = "\uf15c"; // 
const I_CMD     = "\uf489"; // 
const I_SEARCH  = "\uf002"; // 
const I_EDIT    = "\uf303"; // 
const I_WRITE   = "\uf0f6"; // 

const TOOL_ICONS: Record<string, string> = {
  bash: I_CMD, read: I_FILE, write: I_WRITE, edit: I_EDIT,
  grep: I_SEARCH, find: I_SEARCH, ls: I_FILE,
};

function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] || I_TOOL;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m${rs}s`;
}

export default function taskTimerExtension(pi: ExtensionAPI): void {
  let agentStartTime: number | null = null;
  let turnStartTime: number | null = null;
  let lastTurnDuration: number | null = null;
  let lastTurnIndex: number = -1;
  let turnStartTimestamp: Date | null = null;

  let lastActivityTime: number | null = null;
  let turnIndex = -1;
  let toolCallCount = 0;
  let isStreaming = false;
  let currentToolSummary = "";

  let statusInterval: ReturnType<typeof setInterval> | null = null;
  let stallCheckInterval: ReturnType<typeof setInterval> | null = null;
  let stallTimeoutMs = 120_000;
  let stallWarningFired = false;

  pi.registerFlag("stall-timeout", {
    description: "无进展超时秒数（默认 120）",
    type: "string",
    default: "120",
  });

  function clearTimers(): void {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
    if (stallCheckInterval) { clearInterval(stallCheckInterval); stallCheckInterval = null; }
  }

  function updateStatusBar(ctx: ExtensionContext): void {
    if (!agentStartTime || !isStreaming) {
      ctx.ui.setStatus("task-timer", undefined);
      return;
    }
    const elapsed = formatDuration(Date.now() - agentStartTime);
    const turnStr = turnIndex >= 0 ? `T${turnIndex}` : "--";
    const toolsStr = toolCallCount > 0 ? ` ${I_SEP} ${I_TOOL}x${toolCallCount}` : "";
    const curTurnStr = turnStartTimestamp ? ` ${I_SEP} T${turnIndex} ${I_CLOCK} ${formatTime(turnStartTimestamp)}` : "";
    ctx.ui.setStatus(
      "task-timer",
      ctx.ui.theme.fg("accent", `${I_CLOCK} ${turnStr}${toolsStr}${curTurnStr} ${I_SEP} ${elapsed}`),
    );
  }

  function startMonitoring(ctx: ExtensionContext): void {
    clearTimers();
    stallWarningFired = false;
    lastActivityTime = Date.now();
    statusInterval = setInterval(() => updateStatusBar(ctx), 1000);
    stallCheckInterval = setInterval(() => {
      if (!lastActivityTime || !isStreaming) return;
      const silenceMs = Date.now() - lastActivityTime;
      if (silenceMs >= stallTimeoutMs && !stallWarningFired) {
        stallWarningFired = true;
        const s = formatDuration(silenceMs);
        ctx.ui.notify(
          `${I_WARN} 任务已停滞 ${s}，无新活动。\n按 Ctrl+Alt+T 可查看状态，或按 Ctrl+C 中止后重试。`,
          "warning",
        );
        ctx.ui.setStatus("task-timer", ctx.ui.theme.fg("warning", `${I_WARN} STALLED ${s}`));
      }
    }, 10_000);
  }

  /** 从 tool args 提取摘要 */
  function summarizeToolArgs(toolName: string, args: any): string {
    if (!args) return "";
    try {
      switch (toolName) {
        case "bash": {
          const cmd = (args.command || "").toString();
          return cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
        }
        case "read":
        case "write":
        case "edit": {
          const p: string = args.path || "";
          const parts = p.split("/");
          return parts.length > 3 ? `.../${parts.slice(-2).join("/")}` : p;
        }
        case "grep": return `"${args.pattern || ""}" in ${args.path || "."}`;
        case "find": return args.path || args.pattern || "";
        default: return "";
      }
    } catch { return ""; }
  }

  // ==================== Working Message ====================

  /**
   * setWorkingMessage 需要带 ANSI 转义码才能替换默认的 "Working..." 文字。
   * 使用 24-bit RGB 格式: \x1b[38;2;r;g;bm ... \x1b[39m
   */
  function rgb(r: number, g: number, b: number, text: string): string {
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  }
  // 预定义颜色
  const C_CYAN   = (t: string) => rgb(86, 189, 196, t);
  const C_GREEN  = (t: string) => rgb(152, 195, 121, t);
  const C_YELLOW = (t: string) => rgb(229, 192, 123, t);
  const C_RED    = (t: string) => rgb(224, 108, 117, t);
  const C_BLUE   = (t: string) => rgb(97, 175, 239, t);
  const C_PURPLE = (t: string) => rgb(198, 120, 221, t);
  const C_DIM    = (t: string) => rgb(120, 120, 120, t);

  function setWM(ctx: ExtensionContext, msg: string): void {
    ctx.ui.setWorkingMessage(msg);
  }

  // ==================== 事件监听 ====================

  // 会话初始化
  pi.on("session_start", async (_event, ctx) => {
    const flag = pi.getFlag("stall-timeout");
    if (flag) {
      const n = parseInt(String(flag), 10);
      if (!isNaN(n) && n > 0) stallTimeoutMs = n * 1000;
    }
    console.log(`[task-timer] 初始化 | 停滞超时: ${formatDuration(stallTimeoutMs)}`);
  });

  // before_agent_start - 用户发消息后
  pi.on("before_agent_start", async (_event, ctx) => {
    agentStartTime = agentStartTime || Date.now();
    isStreaming = true;
    setWM(ctx, C_CYAN(`${I_LLM} LLM 分析中...`));
  });

  // Agent 整体开始
  pi.on("agent_start", async (_event, ctx) => {
    agentStartTime = Date.now();
    isStreaming = true;
    turnIndex = 0;
    toolCallCount = 0;
    startMonitoring(ctx);
    setWM(ctx, C_CYAN(`${I_PLAY} Agent 启动中...`));
    console.log(`[task-timer] ${I_PLAY} Agent 开始 @ ${formatTime(new Date())}`);
  });

  // Agent 整体结束
  pi.on("agent_end", async (_event, ctx) => {
    isStreaming = false;
    clearTimers();
    if (agentStartTime) {
      const dur = formatDuration(Date.now() - agentStartTime);
      console.log(`[task-timer] ${I_DONE} Agent 结束 @ ${formatTime(new Date())} | 总耗时: ${dur}`);
      ctx.ui.setStatus("task-timer", ctx.ui.theme.fg("success", `${I_DONE} 完成 | ${dur}`));
      setTimeout(() => ctx.ui.setStatus("task-timer", undefined), 5000);
    }
    agentStartTime = null;
    lastActivityTime = null;
    setWM(ctx, C_GREEN(`${I_DONE} 完成`));
  });

  // Turn 开始
  pi.on("turn_start", async (event, ctx) => {
    turnIndex = event.turnIndex;
    turnStartTime = Date.now();
    turnStartTimestamp = new Date();
    lastActivityTime = Date.now();
    stallWarningFired = false;
    setWM(ctx, C_PURPLE(`${I_TURN} Turn ${event.turnIndex} - 思考中...`));
    console.log(`[task-timer] ${I_TURN} Turn ${event.turnIndex} 开始 @ ${formatTime(turnStartTimestamp)}`);
    updateStatusBar(ctx);
  });

  // Turn 结束
  pi.on("turn_end", async (event, ctx) => {
    lastActivityTime = Date.now();
    if (turnStartTime) {
      lastTurnDuration = Date.now() - turnStartTime;
      lastTurnIndex = event.turnIndex;

      const dur = formatDuration(lastTurnDuration);
      ctx.ui.notify(
        `${I_DONE} Turn ${event.turnIndex} 完成 | 耗时: ${dur}`,
        "info",
      );
      console.log(`[task-timer] ${I_DONE} Turn ${event.turnIndex} 结束 | 耗时: ${dur}`);
    }
    turnStartTime = null;
    setWM(ctx, C_DIM(`${I_CLOCK} 等待响应...`));
  });

  // LLM 消息流式生成
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role === "assistant") {
      const turnStr = turnIndex >= 0 ? ` T${turnIndex}` : "";
      setWM(ctx, C_CYAN(`${I_LLM} LLM 生成中${turnStr}`));
    }
  });

  // Tool 开始
  pi.on("tool_execution_start", async (event, ctx) => {
    lastActivityTime = Date.now();
    toolCallCount++;
    stallWarningFired = false;
    currentToolSummary = summarizeToolArgs(event.toolName, event.args);

    const icon = getToolIcon(event.toolName);
    const label = currentToolSummary
      ? C_BLUE(`${icon} ${event.toolName} ${I_SEP} ${currentToolSummary}`)
      : C_BLUE(`${icon} ${event.toolName}`);
    setWM(ctx, label);

    const ts = formatTime(new Date());
    const extra = currentToolSummary ? ` | ${currentToolSummary}` : "";
    console.log(`[task-timer] ${icon} Tool [${event.toolName}] 开始 @ ${ts} (#${toolCallCount})${extra}`);
  });

  // Tool 执行中
  pi.on("tool_execution_update", async (event, ctx) => {
    lastActivityTime = Date.now();
    const icon = getToolIcon(event.toolName);
    const sp = currentToolSummary ? ` ${I_SEP} ${currentToolSummary}` : "";
    setWM(ctx, C_YELLOW(`${icon} ${event.toolName} 执行中...${sp}`));
  });

  // Tool 结束
  pi.on("tool_execution_end", async (event, ctx) => {
    lastActivityTime = Date.now();
    const colorFn = event.isError ? C_RED : C_GREEN;
    const icon = event.isError ? I_FAIL : I_DONE;
    const hint = event.isError ? "失败" : "完成";
    setWM(ctx, colorFn(`${icon} ${event.toolName} ${hint} - 处理中...`));
    console.log(`[task-timer] ${icon} Tool [${event.toolName}] ${hint}`);
    currentToolSummary = "";
  });

  // ==================== 命令 & 快捷键 ====================

  pi.registerCommand("timer", {
    description: "查看当前任务计时信息",
    handler: async (_args, ctx) => {
      if (!agentStartTime) {
        ctx.ui.notify(`${I_CLOCK} 当前无活跃任务。`, "info");
        return;
      }
      const now = Date.now();
      ctx.ui.notify(
        `${I_CLOCK} 任务计时信息\n` +
        `${"─".repeat(32)}\n` +
        `  当前时间:     ${formatTime(new Date())}\n` +
        `  总运行时长:   ${formatDuration(now - agentStartTime)}\n` +
        `  当前 Turn:    ${turnIndex >= 0 ? turnIndex : "--"} | 耗时: ${turnStartTime ? formatDuration(now - turnStartTime) : "--"}\n` +
        `  工具调用数:   ${toolCallCount}\n` +
        `  最后活动距今: ${lastActivityTime ? formatDuration(now - lastActivityTime) : "--"}\n` +
        `  停滞超时阈值: ${formatDuration(stallTimeoutMs)}\n` +
        `  状态:         ${stallWarningFired ? `${I_WARN} 已停滞` : `${I_DONE} 正常`}`,
        stallWarningFired ? "warning" : "info",
      );
    },
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "查看任务计时信息",
    handler: async (ctx) => {
      if (!agentStartTime) {
        ctx.ui.notify(`${I_CLOCK} 当前无活跃任务。`, "info");
        return;
      }
      const now = Date.now();
      ctx.ui.notify(
        `${I_CLOCK} T${turnIndex} ${I_SEP} x${toolCallCount} ${I_SEP} 运行 ${formatDuration(now - agentStartTime)} ${I_SEP} 最后活动 ${lastActivityTime ? formatDuration(now - lastActivityTime) : "--"} 前`,
        stallWarningFired ? "warning" : "info",
      );
    },
  });
}
