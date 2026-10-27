# Pi 配置仓库协作说明

本目录是 `$PI_CODING_AGENT_DIR`（`~/.pi/agent`），修改插件配置前先检查 `git status --short` 和 `settings.json`；不要覆盖 `auth.json`、`models-store.json`、会话与使用数据。官方行为以当前安装的 Pi 文档和包源码为准，不依赖旧版镜像。

## 包安装与版本一致性

`~/.pi/agent` 是符号链接；安装、移除或更新包时使用实际目录，避免 npm 将锁文件路径写成递归的 `../../../nixos-config/...`：`PI_CODING_AGENT_DIR="$(readlink -f ~/.pi/agent)" pi install npm:<包名>@<版本>`（`pi remove`、`pi update` 同理）。`settings.json` 固定的版本应与 `npm/package.json` 一致；管理目录的 `npm/.npmrc` 保持 `save-exact=true`，避免安装其他包时意外升级已固定的插件。TPS 已迁移为本地 `extensions/tps/index.ts`（基于上游 `1.3.16`）；生成过程中每秒刷新默认 footer，仅显示状态符号与生成平均 tok/s 单值（数字加粗、单位弱化；排除首字等待和工具时间，不扣流式停顿），结束后保留最终速率；`/tps` 查看多维详情，`/tps full` 显示 TTFT、输出量、近 1s/3s、端到端等诊断指标，`/tps compact` 恢复极简单值。不要同时安装/启用 npm 版 TPS。

## 当前扩展工作流

- **计划**：社区包 `@bacnh85/pi-plan@0.16.7`，其 peer 范围覆盖当前 Pi 1.1.0；升级 Pi 时重新核对兼容范围。`/plan` 只读调研，`write_plan` 生成 Markdown，`/plan-approve current|new` 经人工确认后实施。`pi-plan.autoFlow` 明确设为 `false`；不使用 `/plan-auto`、`/goal` 或自动 review/fix flow。计划文件默认写入项目 `.agents/plans/`。
- **并行子任务**：社区包 `@parke.dev/pi-subagent` 的 `subagent` 工具。独立的只读工作用 `explore` profile；编码用 `general` + `isolation: "worktree"`，先查看 diff，再决定 apply/discard。worktree 不是操作系统沙箱。
- **输入翻译**：本地 `extensions/input-translate/index.ts`，默认将用户输入英译后交给当前主模型、主模型默认中文回复；按目录单价选最便宜的可用 `openai-codex` 模型，不推理、不请求 priority，5 秒超时原文放行。`/translate on|off|status` 控制本次运行，重载默认开启；命令、扩展消息、即时纠偏和超长文本直接放行，详见同目录 README。
- **本地用量面板**：`extensions/usage/index.ts`，保留 `/usage`、`/usage-opencode-go`、`/usage-chatgpt`、`/usage-codex`、`/usage-antigravity`、`/usage-vimedia`；`extensions/usage-overlay.ts` 是兼容入口。
- **网页与大输出**：`pi-web-access` 提供 `web_search`、`source_check`、`fetch_content`、`get_search_content`；`web-search.json` 使用 eager 加载以保持这些工具可见。大输出先在 `bash` 内汇总，只返回必要结果；需要脚本编排工具时可按需用 `pi --tools +codemode` 启用内置能力。当前不启用自主循环或持久知识库，不要主动安装相关插件；已有历史数据保留。

旧 `plan-mode`、`autopilot`、`parallel-tasks` 和自定义标题扩展已移除；旧的 `PLAN_MODE_REQUIREMENTS_A.md`/`B.md` 是历史设计文档，不能当作当前插件的能力说明。需要恢复旧实现时从迁移前提交 `268c493` 查阅，不要再调用 `plan_submit`、`autopilot_submit`、`parallel_tasks` 等旧工具。

升级或切换包后重启 Pi（或 `/reload`），通过 `pi list` 及 RPC `get_commands` 核对实际加载。第三方插件在 Pi 进程内具有宿主权限；安装前检查来源、版本和依赖。
