---
name: pi-usage
description: pi coding agent 自身的使用手册：配置目录结构、settings.json 各字段含义、内置工具与已安装扩展包（fff / pi-web-access / context-mode）提供的工具速查、以及优化 pi 使用的具体手段。当用户询问 pi 的配置、工具、设置项含义、如何调优 pi、扩展或 skills 机制时加载。
---

# Pi Usage

pi 的官方文档位于 `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/`（`settings.md`、`skills.md`、`extensions.md`、`environment-variables.md`、`keybindings.md` 等），本 skill 是面向本机实际安装与配置的速查，与官方文档结合使用。

## 快速导航

| 主题 | 文件 |
|------|------|
| 配置目录结构与各文件含义 | [references/config-layout.md](references/config-layout.md) |
| 内置工具 + 已装扩展包工具速查 | [references/tools.md](references/tools.md) |
| settings 优化项与使用技巧 | [references/optimization.md](references/optimization.md) |

## 要点速记

- 配置文件主目录：`~/.config/pi` 是符号链接，实际指向 `~/dotfile/pi`（git 仓库，可版本化管理整个配置）。
- 核心文件：`settings.json`（主配置）、`AGENTS.md` / `APPEND_SYSTEM.md`（注入系统提示）、`models.json`（模型/provider 配置）、`auth.json`（凭据，不入库）。
- 已装三个扩展包（`settings.json` 的 `packages` 字段）：`@ff-labs/pi-fff`（ffgrep/fffind 模糊搜索）、`pi-web-access`（web_search/source_check/fetch_content 等网络工具）、`context-mode`（ctx_* 上下文管理工具）。
- 自定义 skills 在 `./skills`（即 `~/.config/pi/skills/`），每个子目录一个 `SKILL.md`；`/skill:名称` 可强制加载。
- 修改配置后无需重启立即生效的项：`tuiMode` 等；多数 settings 项需重启 TUI 生效。

## 操作规范

- 回答配置/工具类问题前，先 `read ~/.config/pi/settings.json` 获取当前实际配置，不要凭记忆。
- 涉及官方语义（字段默认值、行为）时，以 docs 目录或已装包源码为准，引用 `path:line`。
- 用户要求「优化 pi」时，先读 [references/optimization.md](references/optimization.md)，再针对实际配置提出可执行改动，改动前确认。
