# 工具速查

安装与版本以 `settings.json`、`pi list` 为准；内置工具语义以当前 Pi 的 `docs/` 为准。下列社区包和本地扩展在 Pi 启动时加载。

| 来源 | 能力与入口 | 注意 |
|---|---|---|
| Pi 内置 | `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` | 不要把工具可见性误当安全沙箱 |
| `@ff-labs/pi-fff` | `fffind`、`ffgrep`，模糊路径/内容搜索 | Git-aware + frecency 排序，优先用它定位 |
| `pi-web-access` | `web_search`、`source_check`、`fetch_content`、`get_search_content` | `web-search.json` 固定 `toolActivation: eager`；多 provider、网页/PDF/视频抓取与来源索引；`source_check` 不是真相判定器 |
| `@gamaraan/todos-tool` | `todo`、`/todo` | 分阶段任务追踪，按原任务项及时完成 |
| `pi-antigravity` | Google Antigravity 提供者与图片生成工具 | 认证与模型选择遵循包文档 |
| `@bacnh85/pi-plan` | `/plan`、`/plan-approve current\|new`、`write_plan`、`ask_user_question` | 固定 0.16.7，兼容 Pi 1.1.0；`autoFlow: false`，只使用人工批准流程 |
| `@parke.dev/pi-subagent` | `subagent` 工具、`/subagents`、`/subagent-cost` | 并行只读 profile `explore`；写任务显式 worktree，审查 diff 后 apply |
| 本地 `extensions/usage/` | `/usage` 及各 provider 子命令 | 保留自研用量面板；`usage-overlay.ts` 仅作历史兼容入口 |
| 本地 `extensions/tps/` | `/tps`、`/tps-export`、`/session-export` | 实时速率、延迟与单轮遥测；导出前注意敏感信息 |
| 本地 `extensions/gpt-fast.ts` | `/fast` | 匹配 Codex GPT-6 时默认请求 priority，重载后恢复开启；可能增加额度消耗 |
| Pi 内置 `codemode`（按需） | 用 JavaScript 编排工具并过滤结果 | 当前不默认启用；可用 `pi --tools +codemode`，不是额外持久知识库 |

推荐：找文件 `fffind` → `read`；找符号 `ffgrep` → `read`；最新资料 `web_search` + `source_check`；海量输出先在 `bash` 内汇总；多块独立任务用 `subagent`。不启用自主循环或额外持久知识库。新会话与 `/reload` 后重新核对工具实际是否可用。
