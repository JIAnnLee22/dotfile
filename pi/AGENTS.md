# Pi 配置仓库协作说明

## Plan Mode 后续开发交接

当用户要求继续开发 Pi Coding Agent 的计划模式时，必须先完整阅读：

1. `PLAN_MODE_REQUIREMENTS_A.md` — 主需求基线，产品流程、MVP 范围和验收要求以此为准。
2. `PLAN_MODE_REQUIREMENTS_B.md` — 技术与安全补充，用于状态机、权限、持久化、审计和测试设计。
3. Pi 安装包的 `README.md`、`docs/extensions.md`、`docs/tui.md`，以及 `examples/extensions/plan-mode/` 下的全部文件。

### 已有评审结论

- 选择方案 A 作为后续开发指导文档的主基线，方案 B 只作为技术补充。
- 两份文档目前均是评审草案，不应不加修订地直接编码。
- 开发前应先将方案 A 修订为 v0.2，至少解决：
  1. 将不可变 `PlanSpec`、`ApprovalRecord`、可变 `ExecutionState` 和 `AuditEvent` 分离。
  2. 定义 TUI、Print、JSON、RPC 的统一审批、查询、执行和错误协议。
  3. 明确 extension-only 的安全边界；`setActiveTools()` 仅用于降低工具可见性，不是安全边界。
  4. 明确审批是普通模式解锁，还是带能力、路径及步骤范围的 `ExecutionGrant`。
  5. 补全 `stale/cancelled/failed/completed` 转换，以及 `/tree`、resume、fork、clone、compaction 后的恢复规则。
  6. 建立需求 ID 到里程碑、实现和测试的追踪矩阵。

### 实现约束

- 遵守 Pi 的 minimal core / extension-first 哲学；MVP 优先交付为可安装 Extension / Pi Package。
- 现有 `examples/extensions/plan-mode/` 是基线示例，不应从零重复实现。
- 不得仅依靠 shell 正则、工具名称、模型输出的 `Plan:` 或 `[DONE:n]` 建立安全或权威状态。
- 未知或无法验证副作用的工具在规划阶段应 fail-closed。
- 未获得显式、版本/hash 匹配的批准时，不得进入执行阶段。
- 若现有扩展 API 无法提供不可绕过的保证，必须明确降级安全承诺，或单独提出最小通用核心增强，不得伪装成已实现的安全边界。

### 新会话启动步骤

1. 检查当前 Git 状态和现有实现。
2. 阅读上述文档与 Pi 官方本地文档。
3. 先输出方案 A v0.2 的修订建议和实施计划，确认关键待决策项。
4. 用户确认后再实现，并同步添加单元、属性、并发、会话恢复和多运行模式测试。

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
