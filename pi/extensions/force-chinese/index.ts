/**
 * 强制中文插件 (Force Chinese)
 *
 * 强制 AI 始终使用中文进行回复。
 * 通过注入系统提示和上下文消息来实现。
 *
 * 用法：
 * - /force-chinese 命令切换中文强制模式
 * - 启动时自动启用
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FORCE_CHINESE_PROMPT = `[语言要求：你必须始终使用中文进行回复。所有回答、解释、代码注释、计划步骤等都必须使用中文。代码本身和命令可以使用英文，但所有自然语言的输出都必须是中文。请严格遵守此要求。]`;

export default function forceChineseExtension(pi: ExtensionAPI): void {
  let enabled = true; // 默认启用

  /**
   * 更新状态栏显示
   */
  function updateStatus(ctx: ExtensionContext): void {
    if (enabled) {
      ctx.ui.setStatus("force-chinese", ctx.ui.theme.fg("accent", "🇨🇳 强制中文"));
    } else {
      ctx.ui.setStatus("force-chinese", undefined);
    }
  }

  /**
   * 持久化状态到会话
   */
  function persistState(): void {
    pi.appendEntry("force-chinese", { enabled });
  }

  /**
   * 切换强制中文模式
   */
  function toggleForceChinese(ctx: ExtensionContext): void {
    enabled = !enabled;
    if (enabled) {
      ctx.ui.notify("🇨🇳 强制中文模式已启用，AI 将使用中文回复。", "info");
    } else {
      ctx.ui.notify("🔓 强制中文模式已禁用，AI 可以使用任何语言回复。", "info");
    }
    updateStatus(ctx);
    persistState();
  }

  // 注册 /force-chinese 命令
  pi.registerCommand("force-chinese", {
    description: "切换强制中文模式",
    handler: async (_args, ctx) => toggleForceChinese(ctx),
  });

  // 注册简写命令
  pi.registerCommand("cn", {
    description: "切换强制中文模式（简写）",
    handler: async (_args, ctx) => toggleForceChinese(ctx),
  });

  // 在 agent 启动前注入中文提示
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return;

    updateStatus(ctx);

    // 方法1：注入隐藏上下文消息
    return {
      message: {
        customType: "force-chinese-context",
        content: FORCE_CHINESE_PROMPT,
        display: false,
      },
      // 方法2：同时修改 system prompt
      systemPrompt: event.systemPrompt + "\n\n" + FORCE_CHINESE_PROMPT,
    };
  });

  // 会话启动时恢复状态
  pi.on("session_start", async (_event, ctx) => {
    // 从持久化条目中恢复状态
    const entries = ctx.sessionManager.getEntries();
    const forceChineseEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "force-chinese",
      )
      .pop() as { data?: { enabled: boolean } } | undefined;

    if (forceChineseEntry?.data) {
      enabled = forceChineseEntry.data.enabled;
    }

    updateStatus(ctx);

    if (enabled) {
      ctx.ui.notify("🇨🇳 强制中文模式：AI 将使用中文回复。使用 /force-chinese 切换。", "info");
    }
  });

  // 清理非中文模式下的残留上下文
  pi.on("context", async (event) => {
    if (enabled) return;

    return {
      messages: event.messages.filter((m: Record<string, unknown>) => {
        if (m.customType === "force-chinese-context") return false;
        return true;
      }),
    };
  });
}
