# Pi Coding Agent Plan Mode 产品需求文档（方案 A v0.4）

## 元数据

| 字段 | 内容 |
|---|---|
| 文档状态 | v0.4 主流交互重构实施基线 |
| 方案定位 | 产品与交互主基线；方案 B 仅作技术补充 |
| 目标版本 | Plan Mode Extension v2 |
| Pi 兼容基线 | `@earendil-works/pi-coding-agent` 0.84.4 |
| 权威计划 schema | `dev.pi.plan/v2` |
| 规划期安全等级 | `agent-tools-only` |
| 最后更新 | 2026-09-03 |

## 摘要

Plan Mode v2 采用 Claude Code、Cursor、OpenAI Codex CLI 与 Gemini CLI 计划模式的共同用户语义：**进入只读规划 → 调研与必要澄清 → 审阅/编辑计划 → 一次“实施”确认 → 连续实施**。

本版本不再把 Plan Mode 做成逐步骤路径沙箱或能力执行器。用户确认实施后，扩展恢复进入规划前的普通工具，并临时确保内置 `edit`、`write`、`bash` 已实际 active；后续普通工具调用遵循 Pi 原有权限。扩展仍维护 Todo 进度、阻塞、暂停恢复、版本化工件和审计，但 `plan_step_complete` 不再要求每类 capability 的成功证据，实施期也不再按 `pathScopes` 或 `ExecutionGrant` 硬拦截。

规划期仍是明确权限状态：只有来源锁定 capability registry 中允许的只读/研究工具可调用；未知、来源漂移、配置错误或不可证明副作用的工具 fail-closed。网络和 context-mode 索引工具在每个计划首次调用时请求一次用户授权。

Pi 保持 minimal core / extension-first；MVP 继续交付为 `extensions/plan-mode/` 用户级 Extension，不修改 Pi 核心。

## v0.4 已确认决策

1. **主流授权语义**：用户选择“实施”后退出只读权限，恢复普通 Pi 工具；实施期不保留步骤级路径、能力、证据硬门禁。
2. **连续实施**：仍要求模型通过 `plan_step_complete` 逐步上报，扩展自动续跑到完成或 `plan_blocked`；步骤完成只校验当前步骤和非空总结。
3. **工具切换顺序**：审阅 UI 展示拟临时启用的 `edit/write/bash`；用户确认后先 `setActiveTools()`，再用 `getActiveTools()` 读回校验，全部存在后才提交 ApprovalRecord 和 `implementing` 状态。
4. **精简 PlanSpec v2**：模型只提交目标、关键决策、步骤、涉及文件、验证和风险；ID、版本、hash、scope、审批和运行态由扩展维护。
5. **一次审阅面板**：统一提供“实施 / 编辑计划 / 继续规划 / 取消”。“编辑”收集修改意见并让模型重新提交结构化新版本，不解析自由 Markdown。
6. **恢复语义**：reload、resume、模型切换、进程中断均恢复 `paused`；一次 `/plan resume` 确认后续跑。只有工件缺失、schema/hash/审计损坏进入 `stale`。
7. **分支语义**：`/tree` 按目标分支恢复对应计划但统一 `paused`；fork/clone 复制计划及当前 Todo 为新的 v2 lineage，清除审批并等待 resume。
8. **v1 迁移**：旧 `dev.pi.plan/v1` 工件可查看/导出；旧 active 状态恢复 `paused`，resume 时生成 v2 副本，不继承旧批准。
9. **来源锁定 registry**：代码内置已审计适配器，并支持 `$PI_CODING_AGENT_DIR/plan-mode-policy.json`；自定义项必须绑定工具名、capability 与 `source/path`。
10. **网络首询**：规划期首次调用 `network.read` 或受管索引能力时询问一次并绑定当前 plan；TUI/RPC 可确认，Print/JSON 无 UI 时拒绝。
11. **context-mode 分类**：`ctx_search`、`ctx_stats`、`ctx_doctor` 可在来源验证后默认开放；实测 context-mode 1.0.169 的 `ctx_execute`、`ctx_execute_file`、`ctx_batch_execute` 均可在项目 cwd 持久写入宿主，规划期必须拒绝；`ctx_index`、`ctx_fetch_and_index` 需计划级首次授权；`ctx_upgrade`、`ctx_purge`、`ctx_insight` 始终拒绝。
12. **兼容基线**：只支持 Pi 0.84.4；实现前以后安装包 docs/types/运行时行为为准。

## 主流产品参考结论

| 产品 | 已核对的共同模式 | v2 采用方式 |
|---|---|---|
| Claude Code | Plan 是明确只读 permission mode，确认后进入实施 | 规划期工具门禁；实施后恢复普通工具 |
| Cursor | 调研、澄清、可审阅/编辑计划、Build | 单一审阅面板与修改意见回路 |
| OpenAI Codex CLI | `/plan [goal]` 先计划再实现 | `/plan [goal]` 一步进入并启动调研 |
| Gemini CLI | 只读规划、受管计划写入、只读 MCP/网络可配置、批准后实施 | 来源锁定 registry、计划级网络授权、确认后实施 |

不同产品没有共同的步骤级路径 grant 或证据状态机，因此 v2 不再把这些机制作为 Plan Mode 默认语义。

## 目标

- 用户只需理解“规划、审阅、实施、暂停/完成”，无需操作 hash、grant、epoch 或 capability。
- 规划期项目零修改；未知或不可验证工具默认拒绝。
- 计划可版本化、可 diff、可审计、可跨会话和分支安全恢复。
- 用户一次确认后，实施工具已实际可用并连续执行，无逐步骤权限确认。
- TUI、RPC、Print、JSON 共用一个 controller 和稳定 action/result/error 协议。
- 保留 Pi 0.84.4 的 extension-first 交付，不修改核心。

## 非目标

- 不在用户确认实施后继续限制普通 Pi 的写路径、命令、网络或第三方工具。
- 不提供 OS 沙箱、恶意扩展隔离或核心级不可绕过权限。
- 不根据模型自由文本自动批准或改变步骤进度。
- 不自动证明计划、实现或测试在业务意义上正确。
- 不把 `ctx_execute*` 的临时脚本目录误称为文件系统沙箱。

## 用户流程

### 1. 进入规划

- `/plan [goal]` 或 `Ctrl+Alt+P`。
- inactive 下裸 `/plan`：TUI/RPC 请求目标；Print/JSON 返回 `UI_REQUIRED`。
- 进入前立即持久化 `ToolBaselineRecord`，然后应用 planning-safe active set。
- 状态栏显示 `PLAN · READ ONLY`。

### 2. 调研与澄清

- 可调用 registry 中来源匹配、capability 允许的研究工具。
- 高影响歧义使用 `plan_question`；无 UI 时进入 `awaiting_input`。
- 网络/索引工具首次调用触发一次 plan-level confirm；拒绝或断连不授权。
- 未知工具、来源变化、参数不可验证、context-mode 可写执行器全部 block。

### 3. 提交与审阅

模型通过精简 `plan_submit` 提交：

```ts
type PlanDraftV2 = {
  goal: string;
  decisions: string[];
  steps: Array<{
    title: string;
    actions: string[];
    files: string[];
    validation: string[];
  }>;
  risks: string[];
};
```

扩展规范化字段、生成稳定步骤 ID、写不可变 JSON 和 Markdown，并进入 `review`。审阅面板提供：

1. **实施**：显示拟启用 `edit/write/bash` 和普通 baseline。
2. **编辑计划**：收集修改意见，回到 planning，模型提交新版本。
3. **继续规划**：保留当前版本作为参考，回到 planning。
4. **取消**：终止计划并恢复 baseline。

### 4. 实施前工具事务

用户选择“实施”后按固定顺序执行：

1. 校验精确 PlanRef、工件 hash、可信用户通道和 idle/排空条件。
2. 校验 `edit/write/bash` 已注册且来源为 builtin。
3. 计算 `implementationTools = baseline ∪ {edit, write, bash}`。
4. 调用 `setActiveTools(implementationTools)`。
5. 立即读取 `getActiveTools()`，验证三项均 active。
6. 读回失败：恢复 planning-safe 集，返回 `TOOL_UNAVAILABLE`，状态仍为 review/paused。
7. 读回成功：追加 ApprovalRecord，再提交 `implementing` 状态。
8. 排队一次 implementation follow-up。

`setActiveTools()` 不是原子事务或安全边界；上述顺序只保证 controller 不会在已知工具缺失时声称实施已启动。

### 5. 连续实施

- 普通工具调用不再经过 Plan Mode 的 capability/path/evidence 硬门禁，权限等同普通 Pi。
- `plan_step_complete(summary)` 是进度权威入口；只接受当前步骤和非空总结。
- 工具结果保存为信息性 EvidenceRecord，但缺少某类证据不阻止推进。
- 每次步骤完成后显式排队下一 Todo。
- 意外停止由 `agent_settled` 检测；连续两次 settled 且步骤 revision 未变化则 pause。
- `plan_blocked(reason)` 立即 pause 并恢复 planning-safe 工具。
- 最后一步完成后请求最终总结，随后归档 completed、恢复 baseline、清理 widget。

### 6. 编辑、暂停、取消

- `/plan pause`：停止续跑、递增 revision/epoch、恢复 planning-safe 集。
- `/plan resume`：显示当前 Todo 和工具清单；重复实施前工具事务，成功后续跑。
- `/plan cancel`：停止跟踪并恢复 baseline。
- 计划内容修改始终生成新版本并使旧审批失效。

## 权威领域模型

### PlanSpecV2（不可变）

```ts
type PlanSpecV2 = {
  schema: "dev.pi.plan/v2";
  planId: string;
  version: number;
  parentVersion: number | null;
  importedFrom?: { schema: "dev.pi.plan/v1"; planId: string; version: number; contentHash: string };
  createdAt: string;
  createdBy: Actor;
  goal: string;
  decisions: string[];
  scope: PlanScope;
  steps: Array<{
    id: string;
    title: string;
    actions: string[];
    files: string[];
    validation: string[];
  }>;
  risks: string[];
  contentHash: string;
};
```

### 独立记录

- `ApprovalRecordV2`：绑定精确 PlanRef、用户主体、通道、时间、会话/分支。
- `ResearchPermissionRecord`：绑定 planId、capability、工具来源摘要、用户决策和通道。
- `ToolBaselineRecord`：进入规划前 active tool names；在任何工具缩减前持久化。
- `PlanRuntimeStateV2`：状态、当前步骤、step revision、步骤总结、baseline 引用、暂停原因。
- `EvidenceRecordV2`：信息性工具结果和步骤上报，不承担权限证明。
- `AuditEventV2`：append-only 权威历史。

v2 不包含 `ExecutionGrant`、`pathScopes`、`requiredCapabilities`、`dependencyScopes` 或 workspace snapshot。v1 解析器仅用于查看和迁移。

## 状态机

```text
inactive
  → planning ↔ awaiting_input
  → review ↔ planning
  → implementing ↔ paused
  → completed → inactive

review/paused → cancelled → inactive
任意活动态 → failed → inactive
工件/审计完整性损坏 → stale
```

| 当前状态 | 事件 | 新状态 | 关键条件 |
|---|---|---|---|
| inactive | start | planning | baseline 先持久化，再缩减工具 |
| planning | request-input | awaiting_input | 模型受管提问 |
| awaiting_input | answer | planning | 可信用户输入 |
| planning/review | submit | review | v2 工件原子写入成功 |
| review | edit/continue | planning | 不继承旧批准 |
| review | implement | implementing | 工具 set+readback 成功后才提交审批/状态 |
| implementing | complete-step | implementing/completed | 当前步骤 + 非空总结 |
| implementing | block/pause | paused | 停止续跑并降权 |
| paused | resume | implementing | 一次确认并重复工具事务 |
| 活动态 | cancel | cancelled/inactive | 恢复 baseline |
| 活动态 | integrity-error | stale | 禁止实施，保留诊断信息 |

`approved` 不再是持久用户状态；审批和 implementing 在一次用户动作中按事务顺序提交。

## Capability Registry

### capability

- `workspace.read`
- `metadata.read`
- `network.read`
- `managed.index.write`
- `fs.write`
- `process.exec`
- `external.mutate`

### 默认适配器

| 工具 | capability | 规划期 |
|---|---|---|
| builtin `read/grep/find/ls` | workspace.read | 来源匹配时允许 |
| `ffgrep/fffind` | workspace.read | `npm:@ff-labs/pi-fff` 来源匹配时允许 |
| `ctx_search/ctx_stats/ctx_doctor` | metadata/workspace.read | `npm:context-mode` 来源匹配时允许 |
| `ctx_execute/ctx_execute_file/ctx_batch_execute` | process.exec + fs.write potential | 拒绝 |
| `web_search/source_check/fetch_content/get_search_content` | network.read | 首次确认后允许 |
| `ctx_index/ctx_fetch_and_index` | managed.index.write (+ network.read) | 首次确认后允许 |
| `ctx_upgrade/ctx_purge/ctx_insight` | external.mutate | 始终拒绝 |

context-mode 1.0.169 的 `PolyglotExecutor` 在项目根 cwd 执行任意代码；临时探针已证明可持久写宿主，因此不得因“sandbox”文案自动授予只读。

### 用户策略文件

`$PI_CODING_AGENT_DIR/plan-mode-policy.json` 可补充适配器。每项至少包含：

```json
{
  "tools": [{
    "name": "my_read_tool",
    "capabilities": ["workspace.read"],
    "source": "npm:my-package",
    "path": "/absolute/or/agent-dir-relative/source.ts"
  }]
}
```

配置异常、来源不匹配、重复冲突或未知 capability 使对应条目不可用并生成稳定诊断；不得退化为 name-only 信任。

## 会话、分支与迁移

| 场景 | v2 行为 |
|---|---|
| reload/resume/process restart | implementing → paused；planning/review/paused 原样降权恢复 |
| model change | implementing → paused；计划本身不 stale |
| `/tree` | 仅从目标 `getBranch()` 投影；活动计划统一 paused |
| fork/clone | 新 planId/v2 lineage，复制计划和当前步骤，清除审批，paused |
| compaction | 不改变权威状态；每轮从工件注入摘要 |
| v1 active state | paused；resume 时生成带 importedFrom 的 v2 工件并重新确认 |
| 工件/hash/审计损坏 | stale；不得 resume |
| `--no-session` | 进程内可用；重启不承诺恢复 |

baseline 必须在进入 planning 前写入审计。reload 时若状态已受限，不得把当前 planning-safe active set 重新捕获为 baseline。

## 统一 Action 协议

```ts
type PlanActionV2 =
  | "start" | "request_input" | "answer" | "submit"
  | "status" | "show" | "diff"
  | "continue_planning" | "edit_feedback" | "implement"
  | "complete_step" | "block" | "pause" | "resume"
  | "cancel" | "audit" | "migrate_v1";
```

所有适配器调用同一 controller。`run` 可作为 `implement` 的兼容别名；旧 `approve/execute/verify/reset` 不进入正常文档，可返回迁移提示或兼容映射。

稳定错误码至少包括：`INVALID_ACTION`、`INVALID_STATE`、`INVALID_PLAN`、`PLAN_REF_MISMATCH`、`APPROVAL_REQUIRED`、`TOOL_UNAVAILABLE`、`PERMISSION_REQUIRED`、`SOURCE_MISMATCH`、`STALE`、`UI_REQUIRED`、`STORAGE_ERROR`、`UNSUPPORTED_MODE`、`SAFETY_BOUNDARY_DEGRADED`。

## 模式语义

- **TUI**：审阅使用一个 select/custom 面板；修改意见用 editor；网络首次授权用 confirm。
- **RPC**：使用 extension_ui_request/response；断连、取消、超时均拒绝。继续报告 RPC direct bash 不受规划 tool_call 门禁覆盖。
- **Print/JSON**：不弹 UI；提交后停在 review；通过精确 PlanRef 的显式 `implement`/`resume` action 继续。网络首次授权无 UI 时拒绝。
- **SDK**：P1 导出 controller 类型；不要求调用方解析模型文本。

## 安全边界

### 规划期保证

- 对可信扩展集合中的模型工具调用执行 agent-tools-only 门禁。
- 未知、来源漂移和不可验证副作用工具 fail-closed。
- `setActiveTools()` 只降低可见性；`tool_call` 是规划期最终门禁。
- 无 UI 不产生网络/索引授权。

### 实施期保证

实施确认后，Plan Mode 不再限制普通工具；`edit/write/bash` 以当前用户权限运行，可能修改任意用户可写路径、启动进程或访问网络。扩展只保证在报告 implementing 前这三个工具已 active，不保证它们的效果受计划范围约束。

### 边界外

恶意扩展、扩展直接 Node I/O、`pi.exec()`、用户 `!`/`!!`、RPC direct bash、工具内部未声明副作用、其他扩展对 active set 的竞态，以及 OS 级隔离均在 Extension-only 边界外。

## P0 需求

- **PM4-P0-001**：`/plan [goal]` 进入 planning，并在缩减工具前持久化 baseline。
- **PM4-P0-002**：规划期 capability registry 来源锁定；未知/冲突/不可验证工具拒绝。
- **PM4-P0-003**：网络和索引首次调用按计划确认，无 UI 拒绝。
- **PM4-P0-004**：模型通过精简 PlanDraftV2 提交不可变 PlanSpecV2 与 Markdown。
- **PM4-P0-005**：审阅面板统一实施、编辑、继续规划、取消。
- **PM4-P0-006**：implement/resume 必须先 set 工具、读回验证 edit/write/bash，再提交审批和 implementing。
- **PM4-P0-007**：实施期恢复普通 Pi 权限，不执行步骤级路径/capability/evidence 硬门禁。
- **PM4-P0-008**：步骤只通过受管 `plan_step_complete` 推进；总结必填，证据仅信息性。
- **PM4-P0-009**：连续实施由显式 follow-up 与 `agent_settled` 停滞防护驱动；两次无步骤 revision 变化则 pause。
- **PM4-P0-010**：pause/block/cancel/complete 正确降权或恢复 baseline，无工具泄漏。
- **PM4-P0-011**：reload/resume/model change/process restart 恢复 paused；不自动实施。
- **PM4-P0-012**：tree/fork/clone/compaction 使用 branch-only 权威投影和本文恢复规则。
- **PM4-P0-013**：v1 可查看且 active 状态迁移为 paused；生成 v2 新 lineage 后才能 resume。
- **PM4-P0-014**：TUI/RPC/Print/JSON 共用 action/result/error 协议。
- **PM4-P0-015**：工件、审批、权限、工具切换、步骤、阻塞、恢复均有脱敏 append-only 审计。
- **PM4-P0-016**：Extension 显著说明规划期与实施期不同安全边界。

## 可量化验收

1. planning/review/paused 下 `edit/write/bash`、ctx execute 系列及任意未知工具成功执行数为 0。
2. 已验证内置/fff/context 只读适配器可用；来源 path/source 改变后 100% 拒绝。
3. network/index 首次调用在 TUI/RPC 只确认一次；拒绝/断连/Print/JSON 100% 不授权。
4. 每个成功 implement/resume 都满足：`getActiveTools()` 已包含 `edit/write/bash`，且审批/implementing 事件发生在读回之后。
5. 缺工具、静默忽略或审计失败时状态保持 review/paused，并恢复 planning-safe 集。
6. 实施期普通第三方工具不被 Plan Mode 硬门禁阻断。
7. `plan_step_complete` 无 capability evidence 也可推进，但自由文本不能推进。
8. `agent_end` 不驱动续跑；retry/compaction/follow-up 未 settled 时不计停滞。
9. 两次 settled 无步骤变化后 pause；正常步骤上报可连续到 complete。
10. 完成/取消/失败后 baseline 恢复准确率 100%。
11. reload/resume/model/tree/fork/clone 不自动进入 implementing。
12. v1 工件不被修改，迁移 v2 不继承旧批准。
13. plan-mode 与 autopilot 交叉回归零失败。

## 里程碑

- **M0 文档与 API 基线**：冻结 v0.4、验证 Pi 0.84.4 和第三方工具来源/副作用。
- **M1 v2 领域与迁移**：PlanSpecV2、状态机、canonical、v1 importer、journal。
- **M2 规划策略**：capability registry、用户策略文件、network/index 首询。
- **M3 主流 UX 与工具租约**：审阅面板、set/readback、连续实施、agent_settled。
- **M4 恢复与多模式**：resume/tree/fork/clone/compaction、TUI/RPC/Print/JSON。
- **M5 回归与发布**：运行时 E2E、autopilot 兼容、文档校正。

## 追踪矩阵

| 需求 | 主要实现 | 主要测试 |
|---|---|---|
| PM4-P0-001/006/010 | `index.ts`、`src/tool-session.ts`、`src/controller.ts` | `tool-session.test.ts`、`runtime-modes.test.ts` |
| PM4-P0-002/003 | `src/capability-registry.ts`、`src/config.ts`、`src/policy.ts` | `capability-registry.test.ts`、`policy.test.ts` |
| PM4-P0-004/013 | `src/domain.ts`、`src/canonical.ts`、`src/artifact-store.ts`、`src/legacy-v1.ts` | `canonical.test.ts`、`migration.test.ts` |
| PM4-P0-005/014 | `src/review-ui.ts`、`index.ts` | `ui.test.ts`、`modes.test.ts`、`runtime-modes.test.ts` |
| PM4-P0-007/008/009 | `src/controller.ts`、`src/execution-loop.ts`、`index.ts` | `controller.test.ts`、`execution-loop.test.ts` |
| PM4-P0-011/012/015 | `src/journal.ts`、`src/controller.ts`、session hooks | `recovery.test.ts`、`concurrency-property.test.ts` |
| PM4-P0-016 | `README.md`、TUI/RPC warning | `runtime-modes.test.ts` |

任何 P0 需求没有实现与失败路径测试链接时不得标记完成。

## 已知限制

- active tool 切换没有跨扩展原子所有权；读回校验不能阻止后置扩展再次修改。
- capability registry 证明的是工具来源与本地审计结论，不证明第三方包无恶意代码。
- implementing 权限等同普通 Pi；需要强隔离时必须在容器/VM/OS sandbox 中运行整个 Pi。
- context-mode execute 系列不是文件系统沙箱，规划期保持拒绝。
