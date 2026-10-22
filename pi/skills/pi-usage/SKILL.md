---
name: pi-usage
description: pi coding agent 本机配置与工具手册：settings.json、当前已装社区包、本地用量扩展、skills 以及优化技巧。用户询问 pi 配置、工具、扩展或调优时加载。
---

# Pi Usage

当前 Pi 官方文档位于 Pi 安装包的 `docs/`（当前 Nix 安装布局为 `/nix/store/.../lib/pi/node_modules/@earendil-works/pi-coding-agent/docs/`），以当前安装版本为准。本 skill 是本机配置速查，回答前还要核对 `settings.json`。

## 快速导航

| 主题 | 文件 |
|------|------|
| 配置目录结构与各文件含义 | [references/config-layout.md](references/config-layout.md) |
| 内置工具 + 已装扩展包工具速查 | [references/tools.md](references/tools.md) |
| settings 优化项与使用技巧 | [references/optimization.md](references/optimization.md) |

## 要点速记

- 配置文件主目录：`~/.pi/agent` 是符号链接，实际指向 `~/nixos-config/dotfile/pi`（git 仓库，可版本化管理非敏感配置）。
- 核心文件：`settings.json`（主配置）、`AGENTS.md` / `APPEND_SYSTEM.md`（注入系统提示）、`models.json`（模型/provider 配置）、`auth.json`（凭据，不入库）。
- 已装社区扩展见 `settings.json` 的 `packages` 字段：文件搜索、网页访问、待办、Antigravity、人工审批计划与子代理；不启用自主循环或持久知识库。本地扩展包括 `extensions/usage/`、`extensions/tps/`、`extensions/gpt-fast.ts` 及用量兼容入口。
- 自定义 skills 在 `./skills`（即 `~/.pi/agent/skills/`），每个子目录一个 `SKILL.md`；`/skill:名称` 可强制加载。
- 修改配置后无需重启立即生效的项：`tuiMode` 等；多数 settings 项需重启 TUI 生效。

## 操作规范

- 回答配置/工具类问题前，先 `read ~/.pi/agent/settings.json` 获取当前实际配置，不要凭记忆。
- 涉及官方语义（字段默认值、行为）时，以 docs 目录或已装包源码为准，引用 `path:line`。
- 用户要求「优化 pi」时，先读 [references/optimization.md](references/optimization.md)，再依据实际配置提出可核验改动；明确指示实施时无需重复请求确认。
