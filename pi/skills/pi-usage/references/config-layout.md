# 配置目录结构

`~/.config/pi` 是指向 `~/dotfile/pi` 的符号链接（同一 git 仓库），所有路径以下以 `~/.config/pi` 为准。

## 顶层文件

| 路径 | 用途 | 备注 |
|------|------|------|
| `settings.json` | 主配置：packages、skills、模型、TUI 外观等 | 见 optimization.md 逐字段解读 |
| `AGENTS.md` | 注入系统提示的全局协作说明（仓库级） | 与项目内 `AGENTS.md` 同机制 |
| `APPEND_SYSTEM.md` | 追加到系统提示的内容（输出风格等） | 当前含沟通风格与编码任务汇报规范 |
| `models.json` | provider/model 清单（用户编辑入口） | 与 `models-store.json` 配套 |
| `models-store.json` | 模型商店缓存/运行时状态 | 由 pi 维护，一般不改 |
| `auth.json` | provider 认证凭据 | 权限 600，不入 git |
| `types.d.ts` | 类型声明（供扩展/包使用） | |
| `pi-debug.log` | 调试日志 | 排查问题时可查 |
| `run-history.jsonl` | 运行历史记录 | |

## 顶层目录

| 路径 | 用途 |
|------|------|
| `skills/` | 自定义 skills（settings.json `"skills": ["./skills"]` 注册），每个子目录一个 `SKILL.md` |
| `extensions/` | 本地 extension（operations-deck、parallel-tasks、plan-mode），开发中扩展放这里 |
| `npm/` | `packages` 字段中 `npm:` 包的安装目录（node_modules 完整依赖树） |
| `sessions/` | 会话存储 |
| `missions/` | missions 相关数据 |
| `.pi-reference/` | pi 安装包源码/示例的本地副本（含 dist 与 examples），离线查实现用 |
| `.pi-subagents/` | 子代理（parallel_tasks 等）相关数据 |
| `.plan/` | 计划模式数据存储 |
| `tmp/`、`web-search-cache/` | 临时文件与网络搜索缓存，可清理 |
| `git/` | git 相关数据（另见仓库内 `git/` 目录） |
| `agent/`、`.codewhale/` | 其他扩展/工具的数据 |

## 加载顺序与覆盖

- 系统提示注入：内置提示 → `APPEND_SYSTEM.md`（如存在）→ `AGENTS.md`（如存在）→ skills 描述（渐进披露，按需 read）。
- skills 发现位置：`~/.pi/agent/skills/`、`~/.agents/skills/`、项目 `.pi/skills/`（仓库受信任后）、`settings.json` 的 `skills` 数组、`--skill` CLI 参数。同名冲突保留先发现的。
- 当前配置只用 `./skills`（相对 settings.json 所在目录解析），未使用 `~/.pi/agent/skills` 等位置。
