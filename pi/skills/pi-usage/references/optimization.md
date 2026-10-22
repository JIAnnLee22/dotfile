# 优化清单

先读 `$PI_CODING_AGENT_DIR/settings.json` 看当前实际值，再动手改。官方字段定义以当前 Pi 安装包的 `docs/settings.md` 为准。

## 当前配置解读（迁移后，实际值仍以 settings.json 为准）

| 字段 | 当前值 | 含义 |
|------|--------|------|
| `packages` | fff、web-access、todos-tool、pi-antigravity、pi-plan、pi-subagent | 社区扩展包；版本以 settings.json 为准 |
| `skills` | `["./skills"]` | 自定义 skills 目录 |
| `defaultProvider` / `defaultModel` | `antigravity` / `gemini-3.8-flash` | 默认 provider 与模型，依赖 pi-antigravity |
| `defaultThinkingLevel` | `xhigh` | 按模型能力限制生效；当前模型运行时为 high |
| `pi-plan.autoFlow` | `false` | 计划必须人工批准；不启用自动实施循环 |
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

**大输出与上下文**
- 大输出先在 `bash` 中做过滤、计数或汇总，只返回必要结果，避免整段日志进入对话。
- 需要脚本编排工具时，用 `pi --tools +codemode` 按需启用 Pi 内置能力；脚本只输出需要的结果，不建立额外知识库。
- 当前不使用持久知识库；卸载相关插件后保留原有数据，未经明确授权不清理。

**Skills 与扩展**
- 新能力优先做成 skill（`~/.pi/agent/skills/<name>/SKILL.md`，frontmatter 需 name+description；description 决定何时自动加载，要写具体）。
- 计划与并行任务使用社区扩展；不启用自主循环。计划包固定 `@bacnh85/pi-plan@0.16.7`，peer 范围覆盖 Pi 1.1.0；升级宿主后重新核对。
- 本地保留 `extensions/usage/`、`extensions/tps/`、`extensions/gpt-fast.ts` 及兼容入口。切换包前核对 Pi 版本、peer 依赖、权限边界与持久化格式。
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
- 当前 Pi 由 Nix 提供，应通过对应 Nix 配置更新，不能用 npm 全局更新替代。包安装/移除使用实际配置目录：`PI_CODING_AGENT_DIR="$(readlink -f ~/.pi/agent)" pi install npm:<包名>@<版本>`（移除用 `pi remove`）；保持 `npm/.npmrc` 的 `save-exact=true`。
