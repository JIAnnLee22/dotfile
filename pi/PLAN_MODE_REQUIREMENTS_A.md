# Pi Coding Agent Plan Mode 产品需求文档（方案 A v0.3）

## 元数据

| 字段 | 内容 |
|---|---|
| 文档状态 | v0.3 简化交互实施基线 |
| 方案定位 | 产品与交互导向、稳健 MVP、扩展优先 |
| 目标版本 | Plan Mode Extension v0.1–v1.0 |
| 优先交付形态 | 配置仓库中自动发现的 TypeScript Extension |
| 目标用户 | 希望先调研、审阅方案、再授权实施的 Pi 用户与集成方 |
| 规范版本 | `dev.pi.plan/v1` |
| MVP 安全等级 | `agent-tools-only` |
| 最后更新 | 2026-08-11 |
| 竞品资料访问日期 | 2026-08-11 |

## 摘要

本方案为 Pi 提供用户可见仅包含“进入规划—必要澄清—审阅计划—一次确认—连续执行到完成”的计划工作流，同时维持 Pi 的 minimal core 与 extension-first 原则。版本、hash、审批记录、执行 grant、证据和恢复状态仍由扩展在后台维护，不得要求普通用户逐项理解或操作。Pi README 明确表示核心保持最小化，plan mode 应通过文件、扩展或第三方 package 实现；发行包也已经附带 `examples/extensions/plan-mode/` 示例。因此本需求不是从零开发 Plan Mode，而是基于现有示例进行产品化。

MVP 直接放入配置仓库的 `extensions/plan-mode/`，由 Pi 的用户级 Extension 自动发现机制加载；暂不增加独立 Pi Package。实现利用 `pi.registerCommand()`、`pi.registerFlag()`、`pi.setActiveTools()`、`tool_call`、`before_agent_start`、`session_start`、`session_before_tree`、`session_before_compact`、`pi.appendEntry()` 与 `ctx.ui`。只有扩展 API 无法可靠保证的通用机制，例如可证明不可绕过的进程级只读执行策略，才考虑最小核心增强。

## v0.3 已确认决策

1. 方案 A 是产品与 MVP 的唯一主基线；方案 B 只提供状态机、安全、持久化和测试补充。
2. MVP 的安全承诺为 `agent-tools-only`：它约束可信扩展集合中的模型工具调用，不宣称约束恶意扩展、扩展直接 Node I/O、`pi.exec()`、用户 `!`/`!!` 或 RPC 直接 `bash`。
3. 权威模型分为不可变 `PlanSpec`、不可变 `ApprovalRecord`、不可变 `ExecutionGrant`、事件派生的 `ExecutionState` 和 append-only `AuditEvent`，不得把审批或执行进度嵌入 `PlanSpec`。
4. 用户的一次“执行计划”确认在 controller 内依次创建 `ApprovalRecord` 和 `ExecutionGrant`；二者仍保持独立，批准本身不等于恢复普通模式。执行按计划步骤、能力和规范化路径收窄，`setActiveTools()`只降低可见性，最终门禁在每次 `tool_call`。
5. Canonical JSON 是权威计划工件；Markdown 是供人审阅的确定性投影。任何编辑都创建新版本并使旧批准及 grant 失效。
6. 规划阶段禁用模型 `bash` 与网络能力；用户确认后，仅当前步骤显式声明 `process.exec` 时开放来源可验证的内置 `bash`。该授权不解析 shell、不提供路径或网络沙箱，命令可调用网络程序，审批 UI 必须明确提示其使用用户进程权限。未知、自定义和参数无法验证的工具仍 fail-closed。
7. 工件默认存入用户目录；只有可信项目和显式导出操作才写 `.pi/plans/`。
8. Print/JSON 通过显式 CLI action flags 工作；RPC MVP 通过 extension command 与现有 UI 协议工作。所有适配器调用同一个结构化 controller。
9. Extension-only 无法实现全进程不可绕过策略；统一 execution-policy hook 作为独立核心增强提案，不阻塞 Extension MVP。
10. 用户默认不执行 `approve → execute → verify-step → reset` 命令链：计划提交后立即展示一次执行确认；模型通过受管、证据约束的步骤完成工具推进 Todo；未完成时自动续跑，完成后自动清理并恢复普通工具。高级命令只保留为恢复、诊断和非交互适配器接口。

## 背景、现状与示例缺口

现有示例位于：

- `examples/extensions/plan-mode/README.md`
- `examples/extensions/plan-mode/index.ts`
- `examples/extensions/plan-mode/utils.ts`

它已经具备 `/plan`、`--plan`、`Ctrl+Alt+P`、工具切换、只读 bash 过滤、计划提取、执行进度和会话恢复，证明主体能力可由扩展实现。但距离稳定产品仍有以下缺口：

1. bash 安全边界依赖命令字符串正则。`isSafeCommand()`虽然同时检查安全和破坏性模式，但 shell 语法、`find -exec`、解释器能力、命令替换、脚本副作用及网络端行为难以靠黑白名单完整判断。
2. 计划结构依赖助手输出 `Plan:` 和编号列表；格式漂移、多级编号或自然语言计划可能导致解析失败。
3. 完成状态依赖模型在文本中自报 `[DONE:n]`，不能证明对应修改、测试或验证已实际完成。
4. 审批流程主要位于 `agent_end` 的 TUI `select()`；print、JSON 和无交互客户端缺少明确降级协议。
5. 计划仅作为消息和 todo 状态存在，不是独立、可编辑、可版本化、可审计的 Markdown 工件。
6. 状态恢复通过 custom entry 与消息重扫实现，但产品版必须按当前会话分支恢复，避免把废弃分支或旧计划状态混入当前分支。
7. “恢复正常工具”需要准确保留进入前工具集，并处理其他扩展动态增删工具的冲突。
8. 当前完成判定只看模型标记，未把工具结果、文件变更和验证证据纳入步骤状态。

以上是对示例实现边界的描述，不代表该示例承诺提供强安全沙箱。

## 竞品证据矩阵

| 产品 | 官方确认事实 | 对 Pi 的启示 |
|---|---|---|
| Claude Code | Plan mode 属于 permission mode，用于只读分析和制定方案；可用 `claude --permission-mode plan` 启动。 | 模式应是明确权限状态，而不只是提示词；启动时进入计划模式应是一等入口。 |
| Cursor | 编码前研究代码库、澄清问题并生成可审阅或编辑的计划，用户选择 Build；可由模式选择器或 Shift+Tab 进入；计划可保存在 home 或 workspace。 | 计划应成为可编辑工件，批准执行必须是显式动作；存储位置应可配置。 |
| OpenAI Codex CLI | `/plan` 可切换至 plan mode并携带提示，先提出执行计划再实现。 | `/plan [goal]` 应同时承担切换和任务启动，减少操作步骤。 |
| Gemini CLI | 提供只读规划环境；支持 `--approval-mode=plan`、`/plan [goal]`、Shift+Tab及自然语言进入；允许只读文件、搜索、研究工具及只读 MCP 工具，写入仅限受管 plans 目录；批准后退出并实施；可配置策略和计划目录。 | Pi 可允许扩展受管目录写入计划，但不得把该例外扩展到项目文件；权限策略与工件目录应可配置。 |

这些产品的入口、权限模型、计划格式和执行语义并不完全等同，表中启示是面向 Pi 的产品判断，而非官方行为等价声明。

## 问题、目标与非目标

### 问题

用户缺少一个可验证的边界，在充分理解代码库和风险前阻止代理改动项目；同时缺少跨会话、跨分支可恢复的计划工件和明确审批记录。

### 目标

- 默认只读、失败关闭，未经批准不修改项目。
- 计划可审阅、编辑、拒绝、版本化并独立审计。
- TUI 体验完整，非交互模式具有确定性语义。
- 复用会话树和 compaction，不引入第二套会话系统。
- 以自动发现的用户级 Extension 交付并兼容其他工具扩展。

### 非目标

- 不提供操作系统级安全沙箱或恶意扩展隔离。
- 不自动保证计划技术正确。
- 不替代容器、最小权限账户或代码审查。
- MVP 不实现多人实时协作、云端计划服务或自动任务编排。
- 不把 Plan Mode 固化为不可替换的核心工作流。

## 术语与权威领域模型

- **计划模式**：代理仅能调研、澄清和提交结构化计划的权限状态。
- **`PlanRef`**：`planId + version + contentHash`，所有审批、执行和错误响应均携带它。
- **`PlanSpec`**：不可变的计划版本，只包含目标、事实、假设、步骤、风险、预期能力、路径范围和验收条件。
- **`ApprovalRecord`**：不可变审批记录，绑定 `PlanRef`、审批主体、通道、时间、nonce、会话和分支锚点。
- **`ExecutionGrant`**：由有效审批派生的短期授权，绑定步骤、能力、规范化路径、策略摘要、分支、epoch 与可选过期时间。
- **`ExecutionState`**：由审计事件派生的当前投影，包含模式状态、epoch、当前步骤、步骤证据、暂停/失败原因及当前引用。
- **`AuditEvent`**：append-only 结构化事件，是状态转换、审批、门禁判定、证据和恢复的权威历史。
- **计划工件**：canonical JSON `PlanSpec` 及其确定性 Markdown 投影。
- **漂移**：计划、分支、cwd、工具策略或受影响工作区与批准时摘要不一致。
- **受管写入**：由扩展内部固定实现写入专用计划根目录，不向模型开放通用写能力。

### 模型分离不变量

1. `PlanSpec` 一经创建不得原地修改；数组顺序有意义，hash 排除 `contentHash` 字段本身。
2. `ApprovalRecord` 和 `ExecutionGrant` 不得嵌入或回写 `PlanSpec`。
3. `ExecutionState` 只是可重建投影；损坏或缺失时必须从当前分支 `AuditEvent` 重建。
4. `AuditEvent` 不记录完整敏感输入或工具输出，只记录摘要、digest 和证据引用。
5. grant 必须引用完全匹配的 `PlanRef`；计划、策略或分支漂移立即撤销 grant。
6. 模型文本不得直接创建审批、grant、步骤完成或权限提升。

## 用户故事

- 作为开发者，我希望 `/plan 修复登录竞态` 后代理只能读取和提问。
- 作为审阅者，我希望在实施前编辑计划并看到风险、验证方式和影响文件。
- 作为安全敏感用户，我希望任何未知工具默认被禁用，而不是因名称看似安全而放行。
- 作为恢复会话的用户，我希望继续当前分支对应的计划和执行进度。
- 作为 RPC 客户端作者，我希望不依赖 TUI 弹窗也能批准、拒绝和查询状态。

## 功能需求

### P0

- **PM-P0-001**（原 P0-01）：提供 `/plan [goal]` 与 `--plan`；inactive 状态下，TUI/RPC 的裸 `/plan` 必须提示输入目标、进入调研并将目标作为真实用户消息触发模型回合，Print/JSON 的裸 `/plan` 必须返回稳定 `UI_REQUIRED` 并提示使用 `/plan <goal>`；进入时保存可见工具基线并切换至 planning-safe 集合。
- **PM-P0-002**（原 P0-02）：planning/review 默认仅允许包内固定适配器确认的 `read`、`grep`、`find`、`ls`；未知、同名覆盖、声明冲突和参数无法验证的工具失败关闭。
- **PM-P0-003**（原 P0-03）：planning/review 阶段禁用模型 `bash` 与网络能力；executing 仅在当前获批步骤同时声明并获得 `process.exec` grant 时允许来源可验证的内置 `bash`。该进程可产生文件、子进程和网络副作用，不得把 shell 正则判断包装成路径/网络沙箱或只读保证。
- **PM-P0-004**（原 P0-04）：支持澄清问题；无 UI 时返回结构化 `awaiting_input`，不得擅自采用高影响假设。
- **PM-P0-005**（原 P0-05）：模型通过结构化受管接口提交 `PlanSpec`；扩展生成 canonical JSON 和 Markdown 投影，不解析自由文本 `Plan:` 作为权威计划。
- **PM-P0-006**（原 P0-06）：计划提交后自动展示目标、Todos、风险、写范围和 process 警告，并只请求一次“执行此计划”确认；确认在内部创建独立 `ApprovalRecord`，绑定精确 `PlanRef`、主体、通道、时间、nonce 和分支锚点。
- **PM-P0-007**（原 P0-07）：同一次用户确认在 approval 成功后重新校验并签发受步骤、能力、路径和 epoch 限制的 `ExecutionGrant`，直接进入 executing；中间内部状态不得转化为第二次用户操作。
- **PM-P0-008**（原 P0-08）：模型通过受管 `plan_step_complete` 推进当前 Todo；controller 仅在每项声明能力均已有对应成功工具结果时接受，并追加独立 verification evidence。普通步骤不要求用户逐项确认，模型自由文本或 `[DONE:n]` 仍不能改变状态。
- **PM-P0-009**（原 P0-09）：支持 pause/resume/cancel；模型发现真实阻塞、范围变化或新增高风险决策时通过受管 `plan_blocked` 立即 pause。执行未完成而 agent 回合意外结束时自动触发后续回合，连续两次自动续跑无新增工具证据也视为阻塞并 pause，避免无限循环。转换先递增 epoch、阻止新调用并请求 abort，无法确认排空时保持最低权限。
- **PM-P0-010**（原 P0-10）：以 `pi.appendEntry()`追加工件提交、状态提交和审计事件，只从当前 `getBranch()`重建；尾部未提交事务必须忽略。
- **PM-P0-011**（原 P0-11）：TUI、Print、JSON、RPC 使用统一 action/result/error 协议；无 UI、超时、取消和断连不得隐式批准。
- **PM-P0-012**（原 P0-12）：每次权限转换、批准、拒绝、grant、步骤证据、策略判定、迁移和恢复均生成脱敏 `AuditEvent`。
- **PM-P0-013**：resume、tree、fork、clone 和 compaction 必须遵守本文恢复表；恢复不得自动进入 executing。
- **PM-P0-014**：状态转换使用串行 mutex 和单调 epoch；并行 tool call 捕获旧 epoch 时必须拒绝或被 abort。
- **PM-P0-015**：扩展显著展示 `agent-tools-only` 安全等级；若客户端仍开放 RPC 直接 bash，必须报告降级而不是宣称全局只读。

### P1

- **P1-01**：提供计划版本差异、复制、归档和 workspace/home 存储策略；结构化版本 diff 已进入 M2，复制/归档仍待实现。
- **P1-02**：将只读 `dependencyScopes` 与写授权 `pathScopes` 分离；对明确依赖建立有界内容快照，并在 approve/execute/resume/recovery 前检测漂移。快照只作 `agent-tools-only` 漂移信号，不宣称消除 TOCTOU。
- **P1-03**：提供步骤依赖、阻塞原因、验证命令和回滚说明。
- **P1-04**：与 `/tree`、`/fork`、`/clone` 联动显示计划分支和批准点。
- **P1-05**：允许第三方工具通过显式 capability 元数据声明 `read-only`、`managed-write` 或 `mutating`。

### P2

- **P2-01**：团队策略模板、签名审批和多人审批。
- **P2-02**：计划质量评分、成本估算和历史计划检索。
- **P2-03**：在容器或远端执行后端中验证只读 shell 能力。

## 详细 UX

1. **进入**：用户执行 `/plan [goal]`、`--plan`或快捷键。inactive 状态下，TUI/RPC 的裸 `/plan` 与快捷键只询问目标；状态转换成功后，扩展将目标作为真实用户消息发送并立即触发模型回合。已有计划时裸 `/plan` 查询状态，避免意外取消。状态栏显示“PLAN · READ ONLY”。
2. **调研与澄清**：代理只读检索；只有会实质改变方案的歧义才通过 `ctx.ui.select/input/editor` 提问。RPC 使用 `extension_ui_request`；无 UI 则进入 `awaiting_input`，不得猜测高影响决策。
3. **生成与确认**：代理提交结构化计划，扩展保存工件、展示可读 Todo 树、风险及 process 警告，并只询问一次“执行此计划？”。编辑或取消属于该确认的替代路径，不新增审批阶段。
4. **连续执行**：确认后 controller 内部完成 approve+grant，立即执行第一项 Todo。`plan_step_complete` 在已有对应成功工具证据时自动推进下一项；agent 不得为普通步骤要求用户确认。回合提前结束时扩展自动续跑。
5. **进度**：widget 多行展示 `completed / in progress / pending / failed` 计数及 Todo 树；内部 PlanRef、hash、grantId 和 epoch 不进入默认 UI。
6. **暂停与阻塞**：用户可随时 pause/cancel；范围变化、漂移、不可恢复错误或连续两次续跑无证据进展时暂停并说明原因。恢复只需一次确认并签发新 grant。
7. **完成**：全部 Todo 有能力匹配的成功工具证据和结构化完成记录后标记完成；代理输出变更、测试、偏差和未决事项，`agent_end` 自动 reset 并恢复进入 plan 前的普通工具。

## 状态机

```text
inactive
  → researching ↔ awaiting_input
  → review
  → approved
  → executing ↔ paused
  → completed

review → rejected
任意非终态 → cancelled
approved/executing/paused → stale → review
任意非终态 → failed
completed → inactive（`agent_end` 自动 reset；显式 reset 仅作后备）
rejected|cancelled|failed → inactive（显式 reset）
```

| 当前状态 | 事件 | 新状态 | 必要条件与权限结果 |
|---|---|---|---|
| inactive | start | researching | 创建 planId、策略快照和 epoch；应用 planning-safe 工具集 |
| researching/awaiting_input | submit | review | `PlanSpec` 校验、hash 和原子落盘成功 |
| review | revise | review | 创建新版本；清除旧 approval/grant |
| approved/paused | edit | review | 安全降权并创建新版本；清除旧 approval/grant |
| review | run（一次用户确认） | approved → executing | 主体可信且精确 `PlanRef` 匹配；内部先提交 approval，再校验并签发 grant，不要求第二次操作 |
| approved | execute（内部/兼容接口） | executing | agent idle、分支/策略一致；签发新 grant |
| executing | complete-step | executing/completed | 受管调用且每项声明能力均有成功工具证据；全部 Todo 通过才 completed |
| executing | pause | paused | epoch 递增、grant 撤销、请求 abort |
| paused | resume | executing | 重新校验并签发新 grant，不复用旧 grant |
| 任意非终态 | cancel | cancelled | epoch 递增、grant 撤销、保持最低权限 |
| approved/executing/paused | drift | stale | grant 撤销，必须重新审阅 |
| 任意非终态 | unrecoverable-error | failed | 保存错误，保持最低权限 |

`approved` 表示存在有效 ApprovalRecord，不表示当前拥有写能力。`executing` 必须同时存在当前进程新签发、epoch 匹配的 ExecutionGrant；`failed/cancelled/stale` 均不得自动恢复进入前工具集。

## 工具权限矩阵与 shell 防绕过

| 能力 | 计划模式 | 执行模式 | 说明 |
|---|---:|---:|---|
| `read/grep/find/ls` | 允许 | 允许 | 仍受路径与项目信任约束 |
| `edit/write` | 禁止 | 仅 grant 覆盖的步骤和路径 | 每次调用重新规范化路径并校验 epoch |
| 未知扩展工具 | 禁止 | 禁止 | P0 不接受自声明能力；后续需可信 capability 来源 |
| 模型 `bash` | 禁止 | 仅当前 grant 步骤声明 `process.exec` | 只验证内置工具来源和 grant，不声称命令只读或路径隔离 |
| 扩展写计划目录 | 允许 | 允许 | 不作为模型通用工具暴露 |
| 用户 `!`/`!!` | 允许但提示 | 允许 | 属于用户直接操作，不伪装为代理安全保证 |

规划阶段不尝试猜测“安全 shell”，`bash` 一律不可见且被最终门禁拒绝。执行阶段的 `process.exec` 是用户对计划中该步骤的显式进程执行授权：扩展不解析 shell、不按命令推断写路径或网络目标，也不把正则过滤宣传为沙箱；确认框必须说明命令以当前用户权限运行并可能产生文件、子进程或网络副作用。若需要更强约束，应采用隔离执行后端或 OS 沙箱。

## 计划工件与独立记录 Schema

默认权威目录为 `~/.pi/agent/plans/<project-id>/<plan-id>/vNNNN/`：

- `spec.json`：不可变 canonical `PlanSpec`，权威来源。
- `review.md`：由 `spec.json` 确定性生成的人类审阅投影，不承载批准或执行状态。
- workspace `.pi/plans/` 仅由可信项目中的显式 export 写入，不作为默认权威目录。

`PlanSpec` 最少包含：

```json
{
  "schema": "dev.pi.plan/v1",
  "planId": "uuid",
  "version": 1,
  "parentVersion": null,
  "createdAt": "RFC3339",
  "createdBy": {"kind": "model|user|rpc-client", "id": "string"},
  "goal": "string",
  "facts": ["string"],
  "assumptions": ["string"],
  "scope": {"cwd": "absolute-path", "sessionId": "string", "branchLeafId": "string|null"},
  "steps": [{
    "id": "S1",
    "title": "string",
    "purpose": "string",
    "actions": ["string"],
    "dependencyScopes": ["normalized-relative-file-or-directory"],
    "pathScopes": ["normalized-relative-mutation-path"],
    "requiredCapabilities": ["fs.read|fs.write|process.exec"],
    "acceptance": ["string"],
    "rollback": ["string"]
  }],
  "risks": ["string"],
  "policyDigest": "sha256",
  "contextDigest": "sha256",
  "workspaceSnapshot": {
    "schema": "dev.pi.workspace-snapshot/v1",
    "scopes": ["dependency-scope"],
    "entries": [{"path": "string", "kind": "missing|file|directory", "size": 0, "contentHash": "sha256|null"}],
    "totalBytes": 0,
    "digest": "sha256"
  },
  "contentHash": "sha256"
}
```

hash 对移除 `contentHash` 后的 canonical JSON 计算；对象键排序、数组顺序保留、禁止非有限数值和隐式字段丢弃。依赖快照按规范化 scope、排序条目、文件内容 hash 及硬预算计算；symlink、特殊文件、扫描中变化、权限错误或超预算均失败关闭。`ApprovalRecord`、`ExecutionGrant`、`ExecutionState`、证据和审计只存在于 append-only session events 或独立审计导出中，不得回写 `spec.json`。编辑 canonical JSON 或通过受管编辑器修改后必须创建新版本；直接修改 `review.md` 不改变权威计划，导入功能必须显式解析、验证并创建新版本。

## 会话树、恢复与 Compaction

计划状态和审计写入 custom entries，不直接进入模型上下文；每轮由 `before_agent_start`从权威 `PlanSpec`和 `ExecutionState`注入当前摘要。恢复只沿 `getBranch()`读取完整提交的事务，禁止从全部 `getEntries()`选择最后记录。写入顺序为“工件原子落盘 → artifact-written 事件 → state-committed 事件”；缺少最后提交事件的尾部记录忽略。

| 场景 | 恢复规则 |
|---|---|
| 同一会话 resume/reload | researching/review/paused 原样降权恢复；approved 保留批准但不恢复 grant；executing 一律变 stale |
| `/tree` | 切换后从目标 branch 重建；分支上没有精确 ApprovalRecord 锚点则 review/stale |
| fork/clone | 可复制 PlanSpec lineage，但清除 approval/grant；新会话从 review 开始 |
| compaction | 不改变权威状态；摘要可包含 PlanRef、状态和剩余步骤，但每轮仍从工件重新注入 |
| 尾部截断/重复事件 | 只接受 schema、序号、事务和 hash 均有效的最后提交；重复 eventId 幂等忽略 |
| `--no-session` | 标记 `ephemeralSession: true`；进程重启不承诺恢复，仍不得自动授权 |

`session_before_tree/session_tree`负责切换前降权及切换后重建；`session_before_fork/session_start(reason="fork")`负责清除跨会话批准；`session_before_compact/session_compact`只校验摘要和重新注入，不把摘要升级为权威状态。

## 配置、命令、快捷键与 UI

建议配置：

```json
{
  "planMode": {
    "artifactScope": "project",
    "planDirectory": ".pi/plans",
    "bashPolicy": "disabled",
    "unknownToolPolicy": "deny",
    "requireReapprovalOnDrift": true,
    "keepVersions": true
  }
}
```

默认入口只有 `/plan [goal]` 与 `Ctrl+Alt+P`。常用恢复/查询命令为 `/plan status|show|edit|diff|run|pause|resume|cancel|audit`；`approve|execute|verify|reset`仅作为兼容、诊断或底层适配器动作保留，不进入正常教程。`/plan diff [fromVersion] [toVersion]`默认比较当前版本与最近前序版本。TUI 使用 `setStatus()`显示阶段和安全等级、`setWidget()`显示多行 Todo 树；默认 UI 不展示 hash、grantId、epoch 等内部标识。复杂审阅可用 `ctx.ui.custom()`，所有组件遵守 `docs/tui.md` 的宽度、主题和按键规则。

## 统一 Action、Result 与 Error 协议

所有适配器必须调用同一个 controller，不得在 UI 层复制状态转换：

```ts
type PlanActionRequest = {
  protocolVersion: "dev.pi.plan-action/v1";
  requestId: string;
  action: "start" | "status" | "show" | "diff" | "edit" | "run" | "approve" |
          "execute" | "complete_step" | "reject" | "pause" | "resume" | "verify" |
          "cancel" | "reset" | "audit" | "export";
  expectedPlan?: { planId: string; version: number; contentHash: string };
  actor: { channel: "tui" | "print" | "json" | "rpc" | "sdk"; id: string };
  payload?: unknown;
};

type PlanActionResult = {
  requestId: string;
  ok: boolean;
  state: ExecutionState;
  planRef?: PlanRef;
  approvalRef?: string;
  grantRef?: string;
  pendingInput?: { kind: string; prompt: string; choices?: string[] };
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean; details?: unknown };
};
```

稳定错误码至少包括 `INVALID_ACTION`、`INVALID_STATE`、`BUSY`、`PLAN_REF_MISMATCH`、`APPROVAL_REQUIRED`、`GRANT_SCOPE_DENIED`、`STALE`、`UI_REQUIRED`、`STORAGE_ERROR`、`UNSUPPORTED_MODE` 和 `SAFETY_BOUNDARY_DEGRADED`。

## Interactive、Print、JSON 与 RPC 降级语义

- **Interactive**：`plan_submit` 后直接展示可读计划并发起一次执行 confirm；controller 在后台绑定精确 PlanRef，用户不输入或查看 hash。Todo widget 持续展示进度，普通步骤由证据约束的受管工具推进。
- **Print**：无隐式审批；使用一次 `--plan-action run` 配合 `--plan-id`、`--plan-version`、`--plan-hash`完成批准与启动。缺少精确引用时返回结构化错误并保持最低权限。Pi 0.84.1 的 output guard 将扩展直接输出重定向到 stderr，且公开 API 不能写 raw stdout，因此 MVP 的 action control record 明确写 stderr；stdout 保留给最终 assistant 文本。
- **JSON**：与 Print 使用同一 flags；输出普通 agent 事件及可机器识别的 custom message/entry，不得向 stdout 混入非 JSON。
- **RPC**：MVP 通过 `prompt`调用 `/plan ...` extension command，并使用 `extension_ui_request/response`；客户端不支持、超时或断连时保持 awaiting_input/review。`get_entries`提供审计查询。
- **SDK**：P1 导出类型化 `PlanController`；MVP 可加载 extension，但不得要求 SDK 调用方解析模型文本。
- 所有模式在缺少持久会话时仍可生成用户目录工件，但必须标记 `ephemeralSession: true`；无法安全保存时失败而非假装成功。

## 安全

Plan Mode 是可信扩展集合内的代理工具权限控制，不是系统沙箱。MVP 安全等级固定标记为 `agent-tools-only`：`setActiveTools()`只减少模型可见工具，真正门禁是每次 `tool_call`；但该门禁不覆盖扩展直接 Node I/O、`pi.exec()`、用户 `!`/`!!`和 RPC 直接 `bash`，也不能隔离恶意扩展。多个 `tool_call`处理器按加载顺序运行且可修改输入，因此本 Extension 只能在受信任扩展集合与已知加载策略内提供保证；发现工具来源变化时必须 stale/fail-closed。

项目级配置仅在 `ctx.isProjectTrusted()`为真时采用。路径必须规范化、校验现存目标或最近现存父目录的 realpath、防止符号链接逃逸，并记录 TOCTOU 降级边界。工件不得包含密钥或完整敏感工具输出。批准绑定 PlanRef，grant 额外绑定策略、分支和 epoch。与其他权限扩展冲突时采用最严格结果，不得静默扩大权限。若未来要求覆盖 RPC 直接执行和所有宿主入口，必须新增最小通用 execution-policy core hook。

## 可观测性

记录 `plan_id`、版本、状态转换、会话 ID、分支 entry ID、工具策略决策、步骤耗时、验证结果和错误类型。默认仅写本地 session/custom entry；不新增远程遥测。日志不得记录密钥、完整提示或敏感文件内容。RPC/JSON 客户端可通过 `get_entries`和现有事件流获取审计信息。

## 可量化验收标准

1. planning/review 下针对 `edit`、`write`、`bash`及 30 组 shell 绕过用例，项目文件零变化；executing 下 `bash`仅在当前获批步骤声明 `process.exec` 时可调用。
2. 100% 未知工具在无 capability 声明时被拒绝。
3. 计划编辑后，旧批准哈希 100% 失效。
4. 在 `/resume`、`/tree`、`/fork`、`/clone`和 compaction 后，当前分支状态恢复正确率 100%，且 executing 不自动恢复。
5. TUI、Print、JSON、RPC 四种模式均通过统一 action/result/error 契约测试。
6. 无 UI 场景不存在自动批准；仅携带精确 PlanRef 的显式 `run` action 可在一次调用中创建 approval 并签发 grant。
7. 每个自动完成步骤都至少包含覆盖其全部声明能力的成功工具结果和一条结构化 verification evidence；仅模型自由文本或 `[DONE:n]`不能改变状态。
8. TUI/RPC 正常流程从计划展示到 executing 只出现一次确认，执行各 Todo 不再出现人工 verify；未完成回合自动续跑，连续两次无证据进展后暂停。
9. 完成后的 `agent_end` 自动 reset 并恢复 plan 前工具集，不要求用户输入 cleanup 命令。
10. 计划生成到工件落盘成功率达到 99%，失败时不进入 approved。
11. Extension 的加载、禁用、热重载和移除不要求修改 Pi 核心。

## 测试场景

- TUI/RPC 在 inactive 状态执行裸 `/plan`，输入目标后进入 researching，并出现对应真实用户消息及模型回合；Print/JSON 返回 `UI_REQUIRED`，显式 `/plan <goal>` 可进入。
- 正常调研、两轮必要澄清、计划展示、一次确认、自动推进多个 Todo、最终总结和自动恢复普通工具；断言无逐步骤人工 verify。
- 拒绝计划后继续调研，确认写工具仍禁用。
- planning/review 尝试重定向、命令替换、`find -exec`、解释器、curl 下载及自定义变更工具；断言全部被拒绝。executing 分别验证未声明 `process.exec` 的 bash 被拒绝、已声明步骤的内置 bash 被允许且 UI 展示非沙箱警告。
- 批准后手工编辑计划，确认变为 stale。
- 执行中 Escape、`/plan pause`、进程退出和 `/resume`。
- 在计划与执行节点使用 `/tree`切换分支并返回。
- 计划生成前后触发 threshold/overflow compaction。
- 项目不受信任、只读文件系统、符号链接逃逸、`--no-session`。
- RPC 客户端响应、取消或忽略审批请求。
- 与动态工具扩展并存，确认退出时准确恢复原工具集且不扩大权限。

## 分阶段里程碑

### M0：领域模型、协议与威胁夹具

冻结 PlanSpec/ApprovalRecord/ExecutionGrant/ExecutionState/AuditEvent schema、canonical hash、状态机、epoch 并发模型、统一 action 协议和安全回归语料。

### M1：简洁交互与安全边界 MVP

发布位于 `extensions/plan-mode/` 的自动发现 Extension：结构化 plan submission、用户目录工件、一次 run 确认、后台 ApprovalRecord/ExecutionGrant、证据约束的自动 Todo 推进、agent 回合自动续跑、规划期 bash/network 禁用、执行期显式 `process.exec`、TUI/Print/JSON/RPC 降级和基础审计。

### M2：恢复与证据产品化

加入 branch-only journal recovery、tree/fork/clone/compaction、步骤证据、计划 diff、漂移检测、配置迁移和完整模式矩阵测试。当前已完成结构化版本 diff 与显式 dependency scope 内容快照；自动 verifier、配置迁移和真实 TUI tree/compaction E2E 继续推进。

### M3：生态扩展

定义可信工具 capability 来源、网络策略、workspace export 和隔离执行后端；未验证来源继续拒绝。

### M4：最小核心缺口评审

单独评审统一 execution-policy hook，使其覆盖模型工具与 RPC/宿主直接执行入口；未注册策略时保持现有核心行为。不把完整 Plan Mode 移入核心。

## 需求追踪矩阵

| 需求 | 里程碑/状态 | 实现路径 | 测试路径与剩余项 |
|---|---|---|---|
| PM-P0-001–003 | M1 已实现 strict policy | `extensions/plan-mode/index.ts`、`src/policy.ts` | `policy.test.ts`、`runtime-modes.test.ts`；后置恶意 extension 仍属边界外 |
| PM-P0-004–005 | M1 已实现 | `plan_question`/`plan_submit`、`src/canonical.ts`、`src/artifact-store.ts` | `controller.test.ts`、`canonical.test.ts`、`policy.test.ts` |
| PM-P0-006–007 | M1 已实现一次 run、内部 approval/grant 分离 | `index.ts`确认适配、`src/controller.ts` run、`src/domain.ts`、`src/policy.ts` | `controller.test.ts`、`modes.test.ts`、`policy.test.ts`、`concurrency-property.test.ts` |
| PM-P0-008 | M1 已实现能力证据约束的自动推进 | `plan_step_complete`、`src/controller.ts` EvidenceRecord/completeStep/tool result | `controller.test.ts`、`ui.test.ts`；业务语义级 verifier 仍不在 Extension 保证范围内 |
| PM-P0-009、014 | M1 extension 可达范围已实现 | `src/controller.ts` mutex/epoch、`index.ts` abort 与最终重检 | `concurrency-property.test.ts`；核心无原子 final-policy hook，后置 handler/TOCTOU 不能完全消除 |
| PM-P0-010、013 | M1 核心恢复已实现；完整 UI E2E 留 M2 | `src/journal.ts`、`src/artifact-store.ts`、`src/controller.ts`、session hooks | `recovery.test.ts`；真实 TUI tree/compaction 自动化仍待 M2 |
| PM-P0-011 | M1 controller 与 Print/JSON/RPC runtime 已实现 | `src/domain.ts` action 协议、`index.ts` adapters | `modes.test.ts`、`runtime-modes.test.ts`；真实终端 TUI 自动化待 M2 |
| PM-P0-012 | M1 基础实现 | `src/controller.ts` append-only audit、digest 与 bounded redaction | `controller.test.ts`、`concurrency-property.test.ts`；系统化敏感语料待 M2 |
| PM-P0-015 | M1 报告已实现；M4 核心缺口开放 | `src/domain.ts` safety level、RPC warning、README 边界声明 | `runtime-modes.test.ts`；RPC direct bash 只能报告，不能由 extension 阻断 |
| P1-01 diff | M2 已实现 | `src/diff.ts`、artifact version listing、`/plan diff` | `diff.test.ts`；复制、归档仍待实现 |
| P1-02 dependency drift | M2 已实现保守快照 | `src/workspace.ts`、PlanSpec snapshot、approve/execute/recovery guard | `workspace.test.ts`；后置扩展、symlink TOCTOU 和 OS 级竞态仍属边界外 |

实现 PR 与测试名称必须引用需求 ID；任何 P0 行没有实现和测试链接时不得标记完成。当前 Extension 只声明 `agent-tools-only`，表中标注的 M2/M4 剩余项不得被宣传为已交付。

## 风险

- 工具名称或描述不能证明无副作用，需默认拒绝。
- 多扩展同时调用 `setActiveTools()`可能产生竞态，应保存基线并在每次转换重新求交集。
- 计划工件与代码可能漂移，需哈希和重新批准。
- 模型可能遗漏风险或伪报完成，需证据化状态。
- 过强限制降低调研能力；应通过显式策略逐步开放，而非弱化默认安全。
- custom entry schema 升级可能影响旧会话，需版本字段和迁移测试。

## 已决策项与后续开放问题

### v0.3 已决策

1. P0 只信任 Plan Mode Extension 内固定内置工具适配器；第三方 capability 协议后置。
2. planning/review 禁用模型 bash 和 network；executing 仅对当前计划步骤的 `process.exec` grant 开放内置 bash，不做正则“安全命令”猜测，也不声称路径沙箱。
3. 权威工件默认用户目录，workspace 只显式导出。
4. 普通步骤由受管 `plan_step_complete` 在能力匹配的成功工具证据基础上推进；人工确认只作为恢复/诊断后备，不进入默认执行流程。
5. Print/JSON 使用通用字符串 CLI action flags；RPC MVP 使用 extension command。
6. Canonical JSON 权威，Markdown 是投影；ApprovalRecord 与 ExecutionGrant 独立，但由用户一次 run 确认连续创建。
7. 完成后自动 reset；执行回合提前结束自动续跑，两次无证据进展即 pause。

### 后续开放

1. 第三方工具 capability 由扩展元数据、用户策略还是核心签名来源提供。
2. 是否在已实现的显式 dependency content hash 之外，再将 Git HEAD/dirty 作为可选宽范围漂移信号；默认不因无关 dirty 文件撤销批准。
3. RPC 审批身份使用进程凭据、客户端认证还是外部身份提供器。
4. 是否以及何时接受最小通用 execution-policy core hook。
5. 受限测试执行应采用结构化 argv runner、容器后端还是用户手工证据。

## 参考资料

### Pi 本地资料

- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/README.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/utils.ts`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/compaction.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/json.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`

### 官方竞品资料

- https://docs.anthropic.com/en/docs/claude-code/common-workflows
- https://docs.anthropic.com/en/docs/claude-code/permissions
- https://docs.anthropic.com/en/docs/claude-code/cli-usage
- https://cursor.com/docs/agent/plan-mode
- https://developers.openai.com/codex/cli/slash-commands
- https://developers.openai.com/codex/cli/reference
- https://geminicli.com/docs/cli/plan-mode/
- https://geminicli.com/docs/tools/planning/
