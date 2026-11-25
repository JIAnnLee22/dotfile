# 输入前置英译

Pi 自动加载 `extensions/input-translate/index.ts`，执行 `/reload` 后生效。默认关闭，不更改当前主模型、默认模型或主模型的 thinking/Fast 设置。

- 将用户本次输入翻译为忠实、通顺、自然的英文，再交给原来的主模型；翻译器只翻译，不执行输入中的要求。不发送历史对话、系统配置或图片给翻译器。
- 主模型默认用简体中文回复；用户明确指定其他输出语言时遵从该要求。代码、命令、路径、URL 等保持原样，图片附件原样传给主模型。
- 翻译模型默认从已认证且可用的 `openai-codex` 聊天模型中按目录 `input + output` 单价升序选取；也可通过 `/translate model` 在可用模型列表中选择任意已认证模型。
- 在 `/translate model` 列表中：
  - 输入文字可模糊搜索模型（支持按 provider、id、名称筛选）。
  - `Enter` 选中为本次运行临时使用的翻译模型。
  - `Ctrl+S` 将高亮模型持久化保存到 `translate.json`（与 `/models`、`/model` 一致）。
  - `Ctrl+X` 清除持久化模型设置，恢复自动选择最便宜的可用 Codex 模型。
  - `Esc` / `Ctrl+C` 取消关闭。
- 独立调用关闭推理（不继承主模型的 thinking / Fast 设置），对 `openai-codex-responses` 使用 SSE；不重试、不自动升级到更贵的模型。最长等待 `timeoutMs`（默认 **5 秒**，含认证等待）；超时、无登录、错误、空输出、未完整输出或占位符损坏时，提示并直接发送原文。
- 若在 `translate.json` 或临时选择中指定了特定模型，但该模型当前不可用（未登录或已下线），会直接提示并发送原文，不会静默改用其他模型。
- 代码块、反引号内容、路径及 URL 在本地替换为占位符，翻译后逐项核对并还原，避免 AI 修改字面量。
- ASCII/英文正文无需翻译；仅含非 ASCII 标点或 emoji 时也直接放行。此快速判断不会识别完全由 ASCII 字符组成的其他语言。
- `/` 命令、`!` 本地命令、扩展注入消息和生成中的即时纠偏（steer）直接放行；排队跟进（followUp）仍可翻译。超过 `maxInputChars`（默认 16,000 字符）的输入提示后直接放行。
- 缓存最近 `cacheSize`（默认 64）条成功翻译，仅保存在内存；按 `provider + model + 原文` 隔离，重载/退出清空。

## 命令

- `/translate` 或 `/translate status`：查看开关、所选模型及来源、配置文件路径与最近翻译耗时/回退原因。
- `/translate model [关键词|provider/id]`：打开交互式模型列表选择翻译模型；若直接传入精确的 `provider/id` 则直接切换本次运行模型。
- `/translate on` / `/translate off`：本次运行期间开启或停用前置翻译和中文回复指令。
- `/translate save`：将当前开关状态与模型选择保存到 `translate.json`。

## 配置文件 `translate.json`

保存在 `$PI_CODING_AGENT_DIR/translate.json`（默认 `~/.pi/agent/translate.json`）。所有字段均可选，外部编辑后会自动按文件修改时间热加载：

```json
{
  "enabled": false,
  "model": {
    "provider": "openai-codex",
    "id": "gpt-6-luna"
  },
  "timeoutMs": 5000,
  "maxInputChars": 16000,
  "cacheSize": 64
}
```

- `enabled` (`boolean`，默认 `false`)：启动或 `/reload` 后是否默认开启输入翻译。
- `model` (`{ provider, id } | "provider/id" | null`)：持久化翻译模型；省略或设为 `null` 时自动选择最便宜的可用 `openai-codex` 模型。
- `timeoutMs` (`number`，默认 `5000`)：翻译请求（含认证刷新）超时毫秒数。
- `maxInputChars` (`number`，默认 `16000`)：超过该字符数则跳过翻译直接发送原文。
- `cacheSize` (`number`，默认 `64`)：内存缓存条数，`0` 表示关闭缓存。
- `translationPrompt` (`string`，可选)：覆盖内置翻译系统提示词。
- `replyGuidance` (`string`，可选)：覆盖注入主模型的默认回复语言提示。

正常会话中的用户消息是英文译文。原文、译文及翻译用量另存为 `input-translation` 自定义会话条目，不进入主模型上下文，便于审计；不会重写已有会话。翻译请求额外消耗对应提供商额度，其用量记录在该条目中，不会自动计入 Pi 默认 footer 的主模型用量统计。分享会话前应检查这些条目中的原文敏感信息。

超时时间是客户端等待上限，不是服务端计费保证；请求发出后即使取消，提供商仍可能计费。AI 翻译仍可能有语义偏差；处理高度敏感或措辞必须逐字保真的内容时，使用 `/translate off`。
