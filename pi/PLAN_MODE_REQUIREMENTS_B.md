# Pi Coding Agent Plan Mode 方案 B（v0.4 技术与安全补充）

## 定位

本文只补充 `PLAN_MODE_REQUIREMENTS_A.md` v0.4 的架构、事务、并发、持久化和测试设计。用户流程、安全承诺和优先级以方案 A 为准；本文不得重新引入实施期 `ExecutionGrant`、`pathScopes` 或 capability evidence 硬门禁。

兼容基线：Pi 0.84.4，Session Format v3，Extension-first，schema `dev.pi.plan/v2`。

## 架构目标

1. `index.ts` 仅负责 Pi 事件/命令/工具注册和 adapter 编排。
2. controller 是唯一状态转换入口；TUI、RPC、Print、JSON 不复制业务规则。
3. 工件、审批、研究权限、工具 baseline、运行态和审计相互分离。
4. planning/review/paused 的安全由 capability registry + `tool_call` 决策实现；active tools 只是最小暴露。
5. implementing 恢复普通 Pi 权限；Plan Mode 只跟踪步骤和自动续跑。
6. 所有会话恢复只读取当前 `getBranch()`，不把 compaction 摘要作为权威状态。

## 模块边界

| 模块 | 职责 | 不得承担 |
|---|---|---|
| `domain.ts` | v2 schema、action/result/error 类型 | I/O、Pi API |
| `canonical.ts` | canonical JSON/hash/v2 校验、保留共享通用函数 | 会话状态 |
| `legacy-v1.ts` | v1 校验、只读加载、确定性 v2 映射 | 继承旧批准 |
| `artifact-store.ts` | 不可变版本、Markdown、原子保存/读取 | 审批和运行态 |
| `journal.ts` | append-only 事件扫描、branch projection、迁移 | UI |
| `state-machine.ts` | 纯转换矩阵和不变量 | 工具切换 |
| `capability-registry.ts` | 工具 capability、来源、参数适配 | 用户审批状态 |
| `config.ts` | `plan-mode-policy.json` 读取/校验 | 静默放宽 |
| `policy.ts` | planning/review/paused tool_call 判定 | implementing 普通工具限制 |
| `tool-session.ts` | baseline、planning-safe、implementation tool set/readback/restore | 状态提交 |
| `controller.ts` | 串行 action、工件/审批/步骤/恢复 | 直接 TUI |
| `review-ui.ts` | 审阅选择和文本投影 | 权威状态转换 |
| `execution-loop.ts` | follow-up、agent_settled、防重入/停滞 | 工具权限 |
| `ui.ts` | 状态/widget 纯投影 | 状态存储 |
| `index.ts` | 注册与组合 | 领域规则复制 |

## 领域模型

### PlanSpecV2

不可变，包含：

- schema、planId、version、parentVersion、可选 importedFrom
- createdAt、createdBy、scope
- goal、decisions、steps、risks
- contentHash

步骤包含扩展生成的稳定 ID，以及 `title/actions/files/validation`。这些字段用于实施上下文和审阅，不构成权限范围。

### 独立记录

- `ApprovalRecordV2`：一次 implement/resume 的明确用户授权，绑定 PlanRef 和会话分支。
- `ResearchPermissionRecord`：绑定 planId、capability、来源摘要、用户决定；不跨计划复用。
- `ToolBaselineRecord`：缩减 active tools 前的工具名快照。
- `PlanRuntimeStateV2`：状态、currentStepId、stepRevision、步骤结果、baselineId、原因。
- `EvidenceRecordV2`：工具结果/步骤总结，仅用于审计和 UI。
- `AuditEventV2`：append-only 状态事实。

v2 不创建 ExecutionGrant。旧 grant 仅由 v1 importer 读取并丢弃。

## 状态与转换不变量

- `inactive → planning` 前必须先提交 ToolBaselineRecord。
- `review → implementing` 与 `paused → implementing` 只有 ToolSession readback 成功后才允许。
- `implementing → paused` 立即停止新续跑，递增 runRevision，并切到 planning-safe 工具。
- `implementing → completed` 先记录最后步骤，再触发最终总结；最终 settle 后归档并恢复 baseline。
- `completed/cancelled/failed` 最终清理回 inactive；历史事件和工件保留。
- `stale` 只表示工件/审计完整性不可用，不表示普通 model/tool 漂移。
- 模型文本、`[DONE:n]`、工具描述或 UI 显示不能改变状态。

## ToolSession 事务

### capture

1. 在 active set 第一次缩减前读取 `getActiveTools()`。
2. 过滤重复值，但保留顺序。
3. 追加 ToolBaselineRecord 与 state commit。
4. reload 恢复时优先从 branch journal 获取 baseline；不得从当前受限 active set重建。

### enterPlanning

1. registry 从 `getAllTools()` 解析可用来源。
2. 计算 planning-safe set：已允许研究工具 + plan managed tools。
3. `setActiveTools(set)` 后读回。
4. 规划期权限仍以 `tool_call` 为准；readback 仅用于 UX/诊断。

### enterImplementation

用户确认后，在 controller 状态 mutex 外准备、在 commit token 内复核：

1. 校验 PlanRef 和用户通道。
2. 校验 builtin `edit/write/bash` 来源。
3. 目标集为 `baseline ∪ {edit, write, bash}`；去重并过滤已注册工具。
4. `setActiveTools(target)`。
5. `getActiveTools()` 读回，三项缺一即失败。
6. 捕获 run token（planRef + state revision + tool snapshot digest）。
7. controller 再核验 token/PlanRef/state 未变化。
8. 追加 ApprovalRecord，再提交 implementing。
9. 任一步失败恢复 planning-safe set；不得留下批准或 implementing。

Extension API 没有跨扩展原子 active-set 锁。最终安全承诺只能是“状态提交时已读回成功”；后置扩展改变工具集时记录诊断/暂停，不宣称不可绕过。

### restore

恢复 `baseline ∩ currentRegisteredTools`。缺失项记录 warning，不把新注册或原先 inactive 的工具擅自加入。恢复失败进入 failed 并报告，但不得隐藏现存工具状态。

## Capability Registry

### RegistryEntry

```ts
type RegistryEntry = {
  name: string;
  capabilities: Capability[];
  source: string;
  path?: string;
  allowedInPlanning: "always" | "confirm-per-plan" | "never";
  pathAdapter?: "path" | "optional-path" | "none";
};
```

来源匹配至少比较 `name + source`，配置了 path 时比较规范化绝对路径。重复工具名但 capability/source 冲突时拒绝该工具，不取“更宽”配置。

### capability

- `workspace.read`：项目文件读取/搜索。
- `metadata.read`：本地元数据、统计、诊断。
- `network.read`：外部网络读取。
- `managed.index.write`：只写受信任扩展自己的索引库。
- `fs.write`、`process.exec`、`external.mutate`：规划期默认拒绝。

### 当前已审计默认项

- builtin：`read/grep/find/ls`。
- `npm:@ff-labs/pi-fff`：`ffgrep/fffind`。
- `npm:context-mode`：`ctx_search/ctx_stats/ctx_doctor`。
- `npm:pi-web-access`：`web_search/source_check/fetch_content/get_search_content`，confirm-per-plan。
- context-mode `ctx_index/ctx_fetch_and_index`：confirm-per-plan。
- `ctx_execute/ctx_execute_file/ctx_batch_execute`：never。context-mode 1.0.169 的 PolyglotExecutor 在项目 cwd 执行任意代码，实测可持久写宿主。
- `ctx_upgrade/ctx_purge/ctx_insight`：never。

动态注册工具只有进入 `getAllTools()` 且 sourceInfo 可验证后才可匹配。注册前调用或来源不可见时拒绝，不退化为 name-only。

## ResearchPermission 事务

当 registry 决策为 confirm-per-plan：

1. tool_call 进入 controller permission mutex，按 `planId + capability + sourceDigest` 去重。
2. 已有 allow 记录则继续；已有 deny 记录则拒绝。
3. TUI/RPC 显示工具、capability、来源和副作用；Print/JSON 返回 `PERMISSION_REQUIRED`。
4. 用户确认后先追加 ResearchPermissionRecord，再重新评估工具调用。
5. 取消、超时、断连、append 失败均拒绝。
6. 同一计划新版本沿用 planId 时，网络权限是否继承：默认继承到同一 planId；fork/clone 新 planId 不继承。

## Controller 事务与并发

- 所有 action 使用 async mutex 串行化。
- `stateRevision` 每次状态或步骤转换递增。
- implement preflight 使用 token；工具切换期间 PlanRef/stateRevision 变化即回滚。
- 同一 assistant message 的 sibling tool calls 在 Pi 中先串行 preflight、再并发执行；planning 下所有变更调用仍会在 plan_submit 执行前被拒绝。
- tool_result 只追加 EvidenceRecord；不自动推进步骤。
- plan_step_complete 必须来自受信任的本扩展工具、当前 implementing/stale-report 状态、当前步骤和非空总结。
- stale 下 complete/block 只能报告，不能推进或恢复权限。

## 连续实施循环

### 正常路径

- implement commit 后 `queue(stepRevision)` 一次 follow-up。
- plan_step_complete 提交新 revision；有下一步时立即 queue。
- 最后一步提交 completed，queue 最终总结；总结 settled 后 restore/archive。

### 意外停止

只在 `agent_settled` 判断：

- 若已存在 pending continuation token，不重复 queue。
- 若 state 仍 implementing 且 stepRevision 未变化，计一次 stagnant settle 并 queue。
- 连续两次 stagnant settle：controller pause，恢复 planning-safe set。
- 任意步骤 revision 变化清零 stagnant count。
- 设置全计划最大 continuation 上限，防止实现错误造成无限循环。

不得使用 `agent_end` 判定稳定结束，因为其后仍可能 retry、compaction retry 或处理 follow-up。

## 审阅 UI 与适配器

### ReviewDecision

```ts
type ReviewDecision = "implement" | "edit_feedback" | "continue_planning" | "cancel";
```

TUI 优先使用 SelectList/custom panel 展示目标、步骤、文件、验证、风险和拟启用工具；窄终端必须截断/换行且每行不超过 width。RPC 通过 `extension_ui_request` 的 select/editor/confirm；`custom()` 不用于 RPC。

“编辑计划”只采集修改意见并调用 `sendUserMessage()`，不直接解析 Markdown。模型重新调用 plan_submit，创建新版本。

Print/JSON 无 UI：submit 后停在 review；显式 action 必须携带精确 PlanRef。stdout/JSONL framing 不得混入非协议文本。

## 持久化与恢复

Journal 扫描规则：

- 只接受当前 branch entries。
- eventId 重复且内容相同幂等忽略；冲突重复或序号倒退进入 stale/failed。
- 工件写入顺序：immutable artifact → artifact-written → state-committed。
- state commit 不存在的尾部事件不得恢复权限。
- ApprovalRecord 必须位于当前 branch 且匹配 PlanRef；恢复时始终清除运行中授权。

恢复矩阵：

| 来源状态/事件 | 结果 |
|---|---|
| planning/awaiting_input/review | 原语义恢复，工具为 planning-safe |
| implementing + reload/resume/restart/model_select | paused |
| paused | paused |
| tree | 目标 branch 投影后若活动则 paused |
| fork/clone | 生成新 v2 lineage、复制进度、清审批、paused |
| compaction | 状态不变；before_agent_start 重注入 |
| v1 active | legacy paused；resume 创建 v2 后再确认 |
| artifact/hash/audit corrupt | stale |

## v1 → v2 迁移

- v1 JSON 永不原地修改。
- 映射：`facts + assumptions → decisions`；step `title/actions` 保留；`pathScopes → files`；`acceptance → validation`；丢弃 dependency snapshot、capabilities、rollback、approval/grant。
- v2 新 planId，`importedFrom` 记录完整 v1 PlanRef。
- 当前步骤和已完成步骤可复制为信息性进度，但状态为 paused。
- 所有旧 approval/grant 无效，必须一次 resume 确认。
- 映射失败保持 legacy view-only 并给出具体字段错误。

## 安全边界

规划期 `tool_call` 门禁只能覆盖模型工具调用。它不覆盖扩展直接 I/O、`pi.exec()`、用户 `!`/`!!` 或 RPC direct bash。实施期明确恢复普通 Pi 权限，不再宣称 Plan Mode 限制写入。

项目不受信任时不得读取项目级 policy 配置。用户策略文件是代码信任配置，不是第三方工具自身的安全证明。

需要全局不可绕过约束时，应运行整个 Pi 于容器/VM/OS sandbox；本次不提出核心修改。

## 测试设计

### 单元

- v2 normalize/hash/validation/diff。
- v1 映射和错误定位。
- 状态转换和非法转换。
- registry source/path/capability 冲突。
- policy config 解析与 fail-closed。
- ToolSession set/readback/rollback/restore。
- review/UI 纯投影。

### 属性与并发

- 任意未知工具在 planning 不提升权限。
- source/path 任一字节变化拒绝。
- 并发 implement/edit/cancel 不产生旧 PlanRef 审批。
- readback 前状态不进入 implementing。
- permission 首询并发只出现一次决策。
- agent_settled 重入不会重复 queue。

### 恢复

- reload/resume/model/tree/fork/clone/compaction。
- baseline 在 reload 后不被受限 active set覆盖。
- v1 active → paused → v2 copy → resume。
- 工件缺失、hash 损坏、审计截断/重复。

### 多模式/E2E

- TUI review 四选项与 edit feedback。
- RPC extension_ui request/response、取消、断连。
- Print/JSON 精确 PlanRef implement/resume。
- 实际 Pi 0.84.4 工具注册、set/readback 顺序。
- implementing 普通工具不被 Plan Mode block。
- plan-mode 全套与 autopilot 交叉回归。

## 性能与日志

- 普通 policy 判断目标 P95 < 5ms，不做文件内容扫描。
- 工件默认 < 256KiB，审计事件 < 16KiB。
- 审计不写完整工具输出、凭据或用户秘密；记录摘要和 digest。
- UI 更新按状态/步骤 revision 去重，避免流式期间高频重绘。

## 已知 Extension API 限制

1. `setActiveTools()` 没有事务和所有权；其他扩展可在 readback 后改变 active set。
2. 多个 `tool_call` handler 按加载顺序运行并可改参数；Plan Mode 只能在可信扩展集合中工作。
3. RPC direct bash 不经过模型 tool_call。
4. context-mode 等扩展可动态注册工具；注册前 sourceInfo 不可验证。
5. session_shutdown 不保证在强制杀进程时完成；恢复必须依赖 journal，而非内存清理。

上述限制必须进入 README/UI，不得包装成已解决的安全边界。
