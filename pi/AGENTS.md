# Pi 配置仓库协作说明

## Plan Mode v2 后续开发交接

当用户要求继续开发 Pi Coding Agent 的计划模式时，必须先完整阅读：

1. `PLAN_MODE_REQUIREMENTS_A.md` — **v0.4 产品与交互主基线**。
2. `PLAN_MODE_REQUIREMENTS_B.md` — v0.4 架构、安全、持久化和测试补充；与 A 冲突时以 A 为准。
3. 当前安装 Pi 0.84.4 的 `README.md`、`docs/extensions.md`、`docs/tui.md`、session/RPC 文档和 `examples/extensions/plan-mode/` 全部文件。
4. 当前 `extensions/plan-mode/` 实现、测试以及 `extensions/autopilot/src/canonical.ts` 的共享依赖。

### 已确认产品语义

- 用户流程采用主流模式：**规划期只读 → 调研/澄清 → 审阅或编辑 → 一次实施确认 → 连续实施**。
- 用户选择实施后恢复普通 Pi 权限，不再使用逐步骤 `ExecutionGrant`、`pathScopes`、capability evidence 作为硬门禁。
- 仍必须通过 `plan_step_complete` 逐步上报并自动续跑；步骤总结是权威进度入口，工具证据仅作信息性审计。
- PlanSpec v2 对模型只暴露目标、关键决策、步骤、涉及文件、验证和风险；内部保留不可变 JSON、Markdown、版本/hash 与 ApprovalRecord。
- 实施前必须显示并临时启用内置 `edit/write/bash`，执行 `setActiveTools()` 后用 `getActiveTools()` 读回；读回成功后才能提交审批和 `implementing`。
- reload/resume/model change/process restart、tree、fork/clone 均不得自动实施；按 A v0.4 恢复为 paused 并要求一次 resume 确认。
- v1 工件只读保留；旧 active 计划先 paused，生成 v2 新 lineage 后再确认。

### 规划期工具策略

- 使用来源锁定 capability registry；未知、来源不匹配、配置错误或不可证明副作用的工具 fail-closed。
- 默认允许来源匹配的 builtin `read/grep/find/ls`、fff `ffgrep/fffind`、context-mode `ctx_search/ctx_stats/ctx_doctor`。
- context-mode 1.0.169 的 `ctx_execute`、`ctx_execute_file`、`ctx_batch_execute` 实测可在项目 cwd 持久写宿主，规划期必须拒绝，不得按“sandbox”文案归类为只读。
- web-access 以及 `ctx_index/ctx_fetch_and_index` 每个计划首次调用时确认；Print/JSON 无 UI 不授权。
- `ctx_upgrade/ctx_purge/ctx_insight` 规划期始终拒绝。
- 用户扩展配置位于 `$PI_CODING_AGENT_DIR/plan-mode-policy.json`，必须绑定工具名、capability 和 source/path。

### 实现约束

- 遵守 Pi minimal core / extension-first；本次不修改核心。
- `setActiveTools()` 只控制可见性且无跨扩展事务；工具读回只能证明提交瞬间 active，不能宣传为不可绕过安全边界。
- planning/review/paused 的 `tool_call` 是 agent-tools-only 门禁；implementing 下普通工具回到 Pi 原有权限。
- 状态恢复只读当前 `sessionManager.getBranch()`；custom entry 和工件是权威，compaction 摘要不是。
- 连续实施必须基于 `agent_settled`，不得用 `agent_end` 判断稳定停止。
- 不得依赖自由文本 `Plan:`、`[DONE:n]`、工具描述或 name-only capability 改变权威状态/权限。
- 修改后必须运行 plan-mode 全套、autopilot 全套、Pi 0.84.4 多模式 runtime tests；测试名称引用 A v0.4 需求 ID。
- 当前工作区存在其他未提交改动；只修改计划声明路径，禁止覆盖 settings/models-store/usage/.codewhale 等无关文件。

### 新会话启动步骤

1. 检查 Git 状态和现有实现，保护用户未提交改动。
2. 核对安装的 Pi 0.84.4 docs/types，而不是只依赖 `.pi-reference` 0.84.1 镜像。
3. 对照 A v0.4/B 和追踪矩阵确认当前 Todo；发现产品语义歧义才询问用户。
4. 实现时同步添加单元、属性、并发、恢复和 TUI/RPC/Print/JSON 测试。

## Autopilot 扩展（自主开发模式）

`extensions/autopilot/` 实现完全自主的开发模式：用户一句话触发（含"一直自检/自主开发/不用确认"等关键词，或 `/autopilot <goal>`、`--autopilot` flag），agent 零确认自主定义验收标准（AC）→ AC 干跑校验（dryrun，只读验证每个 AC 的 verify 命令可执行）→ 开发+自检循环（running）→ 全部 AC pass 才停止并输出验收报告。

核心安全设计（与 plan-mode 相同的哲学，但全局授权而非逐步授权）：

- 状态机 `inactive → drafting → dryrun → running → completed`（+ paused/cancelled/failed），无人工批准环节；方案 C 的"零确认 + 强制 AC 干跑"已确认。
- 阶段工具策略（`src/policy.ts`）：drafting 只读禁 bash；dryrun 只读+验证性 bash 禁写；running 全工具但写路径限 cwd（pathScopes 可收紧）、bash 危险命令黑名单（`AUTOPILOT_DISABLE_DANGER_FILTER=1` 可关闭）、未知工具 fail-closed。
- 证据门禁（`src/controller.ts`）：pass/ready 声明必须有当前报告窗口内的成功工具证据（窗口 = 自上次 report 以来），旧证据不计；审计 append-only，恢复时 dryrun/running 一律降为 paused 且证据重置。
- 停滞防护：连续 2 轮自动续跑无证据变化 → pause；单任务续跑上限 128 轮 → pause。
- 复用 `plan-mode/src/canonical.ts` 的 canonicalJson/sha256/normalizePathScope（跨目录 import）；artifact-store/journal/workspace 为复制改造版（schema 不同，保持 autopilot 自包含）。
- 注意：autopilot 活跃期间 `plan_question` 会被其策略拒绝（自主模式不问用户，设计行为）；两扩展的 tool_call 钩子各自独立评估。

开发约束：修改后跑 `node --experimental-strip-types --test extensions/autopilot/tests/*.test.ts`（27 项）与 plan-mode 全套（70 项）确认互不破坏；类型检查用系统 tsc + paths 指向 pi 安装包（见会话记录）。
