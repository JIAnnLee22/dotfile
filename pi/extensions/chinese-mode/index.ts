/**
 * Chinese Mode Extension (中文模式扩展)
 *
 * 自动强制 AI 使用中文进行思考和输出：
 * - 中文思考和推理
 * - 中文对话输出
 * - 中文代码注释
 * - 中文 Git 提交信息
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 中文模式指令
const CHINESE_MODE_PROMPT = `[中文模式已激活]

你当前处于中文模式 - 必须使用中文进行所有思考和输出。

[核心规则]

1. 思考语言
   - 必须使用中文进行思考和推理
   - 即使代码是英文，思考过程也要用中文表达
   - 内部独白、分析、决策全部使用中文

2. 输出语言
   - 所有对话回复使用中文
   - 代码注释使用中文
   - Git 提交信息使用中文
   - 错误信息和警告使用中文描述
   - 文档和 README 使用中文

3. 代码规范
   - 变量名、函数名保持英文（编程规范要求）
   - 但代码注释必须是中文
   - 配置文件中的注释使用中文
   - 日志输出使用中文

[示例]

代码注释：
// 计算用户年龄（从出生日期计算）
function calculateAge(birthDate) {
  // 获取当前日期
  const today = new Date();
  // 计算年龄差
  const age = today.getFullYear() - birthDate.getFullYear();
  return age;
}

Git 提交信息：
feat: 添加用户登录功能

- 实现 JWT token 认证
- 添加密码加密处理
- 优化错误提示信息

[注意事项]
- 不要强制翻译变量名 - 变量名、函数名、类名保持英文
- 技术文档可以中英混用 - 某些技术文档可以保留英文原文
- 错误堆栈保持英文 - 系统错误信息通常保持原样
- 代码关键字保持英文 - if, for, while, function 等保持英文

[重要] 始终使用中文进行思考和输出，不要切换到其他语言。`;

/**
 * 中文模式扩展主函数
 */
export default function chineseModeExtension(pi: ExtensionAPI): void {
  // 注册配置
  pi.registerFlag("chinese", {
    description: "启用中文模式",
    type: "boolean",
    default: true,
  });

  // 注册命令
  pi.registerCommand("chinese", {
    description: "切换中文模式",
    handler: async (_args, ctx) => {
      const enabled = pi.getFlag("chinese") !== false;
      ctx.ui.notify(
        `中文模式已${enabled ? "启用" : "禁用"}\n\n` +
        `使用 --no-chinese 参数可禁用中文模式`,
        "info"
      );
    },
  });

  // 注入中文模式上下文
  pi.on("before_agent_start", async () => {
    // 检查是否启用中文模式
    if (pi.getFlag("chinese") === false) {
      return;
    }

    return {
      message: {
        customType: "chinese-mode-context",
        content: CHINESE_MODE_PROMPT,
        display: false,
      },
    };
  });

  // 过滤非中文模式下的陈旧上下文
  pi.on("context", async (event) => {
    if (pi.getFlag("chinese") === false) {
      return {
        messages: event.messages.filter((m: any) => {
          if (m.customType === "chinese-mode-context") return false;
          return true;
        }),
      };
    }
  });

  // 显示启动信息
  if (pi.getFlag("chinese") !== false) {
    console.log(`
╔══════════════════════════════════════╗
║      Chinese Mode v1.0.0            ║
║  中文模式已启用 - 强制中文输出      ║
╚══════════════════════════════════════╝

📝 中文模式功能:
   - 强制中文思考和推理
   - 中文对话输出
   - 中文代码注释
   - 中文 Git 提交信息

⌨️  快捷键:
   /chinese    - 显示中文模式状态
   --no-chinese - 启动时禁用中文模式
`);
  }
}
