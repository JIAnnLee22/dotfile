# Pi 配置仓库协作说明

本目录是 `$PI_CODING_AGENT_DIR`（`~/.pi/agent`），修改插件配置前先检查 `git status --short` 和 `settings.json`；不要覆盖 `auth.json`、`models-store.json`、会话与使用数据。官方行为以当前安装的 Pi 文档和包源码为准，不依赖旧版镜像。

## 当前扩展工作流

- **计划**：社区包 `@bacnh85/pi-plan`；`/plan` 只读调研，`write_plan` 生成 Markdown，`/plan-approve` 经人工确认后实施。`/plan-auto` 会自动批准，不要把它当作普通 `/plan` 使用。计划文件默认写入项目 `.agents/plans/`。
- **自主循环**：社区包 `pi-loop-mode`；需要客观完成条件时使用 `/loop start <目标> --check "<验证命令>" --until-done --max 50`。默认循环无上限；务必给出 `--max`。其 `--check` 不等于旧本地 autopilot 的 AC 干跑或写路径门禁；无人值守任务最好在隔离环境运行。
- **并行子任务**：社区包 `@parke.dev/pi-subagent` 的 `subagent` 工具。独立的只读工作用 `explore` profile；编码用 `general` + `isolation: "worktree"`，先查看 diff，再决定 apply/discard。worktree 不是操作系统沙箱。
- **本地用量面板**：`extensions/usage/index.ts`，保留 `/usage`、`/usage-opencode-go`、`/usage-chatgpt`、`/usage-codex`、`/usage-antigravity`；`extensions/usage-overlay.ts` 是兼容入口。
- **网页与上下文**：`pi-web-access` 提供 `web_search`、`source_check`、`fetch_content`、`get_search_content`；`web-search.json` 使用 eager 加载以保持这些工具可见。`context-mode` 提供 `ctx_*`，大量输出优先在执行器中汇总或索引后按需检索。其 `ctx_execute` 等可在项目 cwd 写文件，不是只读安全边界。

旧 `plan-mode`、`autopilot`、`parallel-tasks` 和自定义标题扩展已移除；旧的 `PLAN_MODE_REQUIREMENTS_A.md`/`B.md` 是历史设计文档，不能当作当前插件的能力说明。需要恢复旧实现时从迁移前提交 `268c493` 查阅，不要再调用 `plan_submit`、`autopilot_submit`、`parallel_tasks` 等旧工具。

升级或切换包后重启 Pi（或 `/reload`），通过 `pi list` 及 RPC `get_commands` 核对实际加载。第三方插件在 Pi 进程内具有宿主权限；安装前检查来源、版本和依赖。
