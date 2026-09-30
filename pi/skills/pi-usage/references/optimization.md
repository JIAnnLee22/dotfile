# 优化清单

先读 `$PI_CODING_AGENT_DIR/settings.json` 看当前实际值，再动手改。官方字段定义以当前 Pi 安装包的 `docs/settings.md` 为准。

## 当前配置解读（迁移后，实际值仍以 settings.json 为准）

| 字段 | 当前值 | 含义 |
|------|--------|------|
| `packages` | fff、web-access、context-mode、todos-tool、pi-antigravity、pi-plan、pi-loop-mode、pi-subagent | 社区扩展包；版本以 settings.json 为准 |
| `skills` | `["./skills"]` | 自定义 skills 目录 |
| `defaultProvider` / `defaultModel` | `openai-codex` / `gpt-6-sol` | 默认 provider 与模型 |
| `defaultThinkingLevel` | `xhigh` | 思考强度（off/minimal/low/medium/high/xhigh/max） |
| `theme` | `dark` | 主题 |
| `quietStartup` | `true` | 隐藏启动头 |
| `collapseChangelog` | `true` | 更新后显示精简 changelog |
| `hideThinkingBlock` | `false` | 显示思考块 |
| `tuiMode` | `fullscreen` | 全屏 TUI（`regular` 为传统模式） |
| `fullscreenScrollbar` | `hidden` | 全屏滚动条策略（auto/always/hidden） |
| `outputPad` / `editorPaddingX` | `0` | 输出/编辑器内边距 |
| `warnings.anthropicExtraUsage` | `false` | 关闭 Anthropic 额外用量提示 |

## 可优化方向

**模型与成本**
- `defaultModel` 换更强模型或按任务临时 `/model` 切换；`defaultThinkingLevel` 调低可显著降成本/延迟，`max` 适合复杂编码任务。
- 自定义 provider/model 编辑 `models.json`（参考 docs/models.md、custom-provider.md）。

**上下文与记忆（本机亮点）**
- 大输出用 `ctx_execute`/`ctx_execute_file` 处理，避免撑爆对话；文档用 `ctx_index` 持久化。
- 定期 `ctx_stats` 查看上下文节省量；`ctx_doctor` 排查集成问题；升级用 `ctx_upgrade`（升级后需重启会话）。
- 旧会话/无用索引用 `ctx_purge`（破坏性，需 confirm:true）。

**Skills 与扩展**
- 新能力优先做成 skill（`~/.config/pi/skills/<name>/SKILL.md`，frontmatter 需 name+description；description 决定何时自动加载，要写具体）。
- 计划/循环/并行任务改用社区扩展；本地只保留 `extensions/usage/` 和兼容入口。切换包前核对 Pi 版本、peer 依赖、权限边界与持久化格式。
- `/skill:名称` 可强制加载 skill；`enableSkillCommands` 控制此命令注册（默认 true）。

**使用习惯**
- 快捷键/键位自定义见 docs/keybindings.md。
- 会话管理：`sessions/` 目录、`/resume` 恢复；compact 策略见 docs/compaction.md。
- 环境变量（代理、API key 等）见 docs/environment-variables.md。
- 输出风格等提示词层面的调优改 `APPEND_SYSTEM.md`（当前已含沟通风格规范）。

## 安全与维护

- `auth.json` 含凭据，勿入库；`web-search.json` 只保存非敏感的 `toolActivation: eager`，不要把密钥写入跟踪文件。
- 修改配置前备份或依赖 git 仓库（dotfile/pi）可回滚；改动后重启 pi 生效（`tuiMode` 等个别项即时生效）。
- 敏感路径（`.env`、`.git`、`node_modules`）操作前确认。
- 更新 pi 本体：`npm -g update @earendil-works/pi-coding-agent`（或按安装方式）；升级后看 changelog 确认兼容性。
