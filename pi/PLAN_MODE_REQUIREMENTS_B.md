# Pi Coding Agent Plan Mode 方案 B 需求文档

## 元数据

| 字段 | 内容 |
|---|---|
| 文档状态 | 工程评审稿 |
| 方案定位 | 架构、安全与可测试性导向，扩展优先 |
| 优先级 | P0–P2 |
| 目标形态 | MVP 为配置仓库中自动发现的 TypeScript Extension |
| 适用模式 | TUI、RPC、JSON、Print、SDK |
| 访问与核验日期 | 2026-08-11 |
| 兼容基线 | 当前发行包公开 Extension API、Session Format v3 |
| 核心原则 | minimal core、extension-first、默认拒绝、显式审批、可恢复、可审计 |

## 决策摘要

Pi 明确坚持 minimal core / extension-first，README 也将 plan mode 列为应由扩展或 Pi Package 实现的工作流能力。发行包已经包含 `examples/extensions/plan-mode/`，因此本项目不是复制样例，而是将其产品化，并补齐安全边界、版本化计划协议、非 TUI 接口、恢复与测试能力。

MVP 采用 `extensions/plan-mode/` 下的独立 TypeScript Extension，实现状态机、计划工件、审批、审计和最终 `tool_call` 安全门。计划阶段默认不启用 `bash`，只开放经能力声明确认的只读工具；未知、自定义及 MCP 类工具一律 fail-closed。`pi.getActiveTools()` / `pi.setActiveTools()` 仅用于缩减模型可见工具，不作为安全边界，真正授权必须在每次调用的 `tool_call` 阶段重新判定。

仅建议一个最小、通用核心增强：提供覆盖模型工具调用和 RPC 直接执行入口的统一 execution-policy hook。没有注册策略时保持现有行为，从而兼容所有扩展。其动机是当前扩展的 `tool_call` 无法可靠覆盖 RPC `bash` 等非模型执行路径，而“模式安全”不能依赖调用来源。

## Pi 现状、已有示例与约束

现有样例位于：

- `examples/extensions/plan-mode/README.md`
- `examples/extensions/plan-mode/index.ts`
- `examples/extensions/plan-mode/utils.ts`

样例已经演示 `/plan`、`Ctrl+Alt+P`、`pi.getActiveTools()`、`pi.setActiveTools()`、`tool_call` block、`before_agent_start`、`context`、`turn_end`、`agent_end`、`pi.appendEntry()`、`session_start`，以及 `ctx.ui.select/editor/setStatus/setWidget`。它证明主要交互可由扩展完成，但存在以下工程风险：

1. 工具名称 allowlist 不是能力模型；同名工具可被覆盖，自定义工具内部可能执行任意副作用。
2. shell 正则无法可靠分析 shell 语义。允许的命令可通过管道、命令替换、重定向、解释器、环境变量、别名、子进程或组合命令绕过；`curl`、`awk`、`find` 本身也可产生写入或网络副作用。
3. 临时切换 active tools 与动态 `registerTool()`、其他扩展修改工具集、并行 tool calls 之间没有事务或所有权语义。
4. 从模型文本解析 `Plan:`，以及依据 `[DONE:n]` 自报完成，均不可作为审批或进度事实。
5. `pi.appendEntry()` 产生的 custom entry 不进入 LLM 上下文；恢复了状态不等于模型知道获批计划。
6. `agent_end` 后调用 `ctx.ui.select()` 只适合有 UI 的模式；`ctx.hasUI` 在 TUI、RPC 为真，在 JSON、Print 为假，且 `ctx.mode === "tui"` 才代表真实终端。
7. 计划没有独立版本、规范化摘要/hash、审批身份、审批时间和审计链。
8. `agent_end` 后仍可能自动重试、compaction 或处理 follow-up；不能把它等同于最终稳定状态。
9. 现有完成状态来自模型文本，无法证明文件变更、测试或验收条件真实完成。

## 竞品证据矩阵

| 产品 | 官方能力 | 对 Pi 的启示 |
|---|---|---|
| Claude Code | Plan mode 属于 permission mode；先只读分析再实施；CLI 支持 `--permission-mode plan` | 模式必须首先是权限边界，而非提示词样式 |
| Cursor | 研究代码库、澄清、生成可审阅编辑计划，由用户决定 Build；支持模式选择器与 Shift+Tab；计划可保存至 home 或 workspace | 计划应是可编辑、可保存、可审批的独立工件 |
| OpenAI Codex CLI | `/plan` 可切换计划模式并附目标，先提出计划再实现 | 命令入口需支持目标参数和明确阶段转换 |
| Gemini CLI | 只读环境；支持参数、`/plan`、Shift+Tab/自然语言；仅允许向 plans 目录写 Markdown；批准后执行；策略可配置 | 可引入受限工件写入，但代码库写入必须与计划目录隔离 |

事实来源见“参考资料”，不推断未由官方资料确认的内部实现。

## 架构边界

系统分为五层：

1. **Mode Controller**：维护状态机，只允许在 agent idle 或已中止并排空调用后切换。
2. **Capability Policy**：按副作用能力判断调用，拒绝未知能力。
3. **Plan Artifact Store**：保存不可变版本、hash、审批和分支关系。
4. **Context Adapter**：通过 `before_agent_start` 注入当前计划摘要、版本和约束；通过 `context` 清除过期模式消息。
5. **Adapters**：分别适配命令、TUI、RPC/JSON、SDK，不在 UI 层复制状态逻辑。

扩展代码拥有宿主进程权限，Plan Mode 不能防御恶意扩展本身；其他第三方扩展仍须遵循 Pi 的信任和源码审查模型。安全承诺限于代理可调用工具及纳入统一策略钩子的宿主执行入口。

## 目标与非目标

### 目标

- 建立可验证的只读规划边界。
- 形成可编辑、版本化、可审批、可恢复的计划工件。
- 在所有运行模式提供确定性接口和明确降级。
- 对自定义、动态和 MCP 类工具默认拒绝。
- 将计划执行进度建立在事件和验证证据上，而非模型自报。
- 保持核心最小化，MVP 不修改核心。

### 非目标

- 不提供通用容器或操作系统级沙箱。
- 不保证恶意扩展、被攻陷工具服务或外部进程无副作用。
- 不自动判断计划在业务意义上正确。
- 不将 Plan Mode 内建为 Pi 核心工作流。
- 不把任意 shell 命令静态证明为只读。

## 需求

### P0

- **PM-P0-001**：支持 `off → planning → review → approved → executing → completed` 状态及 `failed`、`cancelled`、`stale` 分支。
- **PM-P0-002**：planning/review 状态仅允许能力为 `fs.read`、`metadata.read`、`vcs.read` 的工具；网络读取默认关闭。
- **PM-P0-003**：所有未知、未声明、声明冲突或参数无法验证的工具调用必须 block。
- **PM-P0-004**：不得以工具名称或 shell 正则作为最终授权依据；MVP 计划阶段默认移除并阻断 `bash`。
- **PM-P0-005**：每次 `tool_call` 执行前按当前不可变 policy snapshot 校验；active tools 只作最小暴露。
- **PM-P0-006**：计划必须以版本化 schema 保存，规范化后计算 SHA-256；审批绑定 `planId + version + hash`。
- **PM-P0-007**：编辑计划必须创建新版本并使旧审批失效，不得原地修改已审批版本。
- **PM-P0-008**：执行必须由显式用户或可信 RPC/SDK 调用方批准；模型不能批准自身计划。
- **PM-P0-009**：通过 `pi.appendEntry()` 追加状态、工件和审计事件，并在 `session_start` 从当前活动分支重建。
- **PM-P0-010**：进入 executing 前须把获批版本、hash、步骤及验收条件作为 LLM 上下文注入；不能依赖 custom entry。
- **PM-P0-011**：非交互模式缺少明确审批参数或令牌时不得执行；超时、取消、断连均视为拒绝。
- **PM-P0-012**：完成步骤必须由工具结果、测试结果或用户确认形成证据；`[DONE:n]` 仅可作为提示，不改变权威状态。
- **PM-P0-013**：崩溃恢复后 planning 保持受限；approved 恢复为 approved；executing 恢复为 `stale`，须重新确认后继续。
- **PM-P0-014**：状态切换时若存在运行中或已预检的并行调用，先 abort/等待 settled；无法确认排空则拒绝切换。
- **PM-P0-015**：每个拒绝、审批、执行、迁移及恢复事件均生成结构化审计记录。

### P1

- **PM-P1-001**：提供 workspace 或用户目录计划文件导出；只允许原子写入专用 plans 根目录。
- **PM-P1-002**：支持声明式工具策略配置，项目级配置仅在 `ctx.isProjectTrusted()` 为真时生效。
- **PM-P1-003**：提供 SDK controller 和类型定义，避免 SDK 使用方解析命令文本。
- **PM-P1-004**：提供 RPC 专用 plan 命令和事件；在核心增强前兼容使用 `/plan ...` extension command。
- **PM-P1-005**：compaction 前后保留结构化计划摘要、版本、hash、未完成步骤和证据索引。
- **PM-P1-006**：支持网络只读能力的域名、方法、重定向及响应体预算策略。
- **PM-P1-007**：检测模型、cwd、工具策略或关键上下文变化并标记计划 stale。

### P2

- **PM-P2-001**：支持多审批人、组织身份提供器及签名审批。
- **PM-P2-002**：支持计划差异视图、模板和跨会话导入。
- **PM-P2-003**：支持沙箱后端和受约束 shell AST 执行器。
- **PM-P2-004**：提供策略模拟器，解释某调用为何被允许或拒绝。

## 状态与转换

| 当前状态 | 事件 | 新状态 | 条件 |
|---|---|---|---|
| off | start | planning | 创建 planId 和策略快照 |
| planning | propose | review | 生成有效工件版本 |
| review | revise | planning | 新版本，旧审批失效 |
| review | approve | approved | 身份有效且 hash 匹配 |
| approved | execute | executing | idle、上下文一致、策略可用 |
| executing | verify-all | completed | 所有必需验收通过 |
| 任意非终态 | cancel | cancelled | 立即维持最小权限直至排空 |
| approved/executing | 上下文漂移或恢复不确定 | stale | 必须重新审阅 |
| 任意非终态 | 不可恢复错误 | failed | 保存原因和最后安全状态 |

模式转换使用串行 mutex 和单调递增 `epoch`。每个 tool call 捕获 epoch；epoch 不匹配即拒绝，避免并行预检与临时工具切换竞态。

## 安全不变量

1. planning/review 下任何未明确证明只读的调用都不得执行。
2. active tools 扩大不会扩大权威权限。
3. 已审批内容任何字节变化都会改变 hash 并撤销审批。
4. 没有审批主体、时间、来源和 hash 的记录不构成批准。
5. 恢复、迁移或解析失败不得自动进入更高权限状态。
6. 模型文本不得直接驱动审批、完成或权限提升。
7. 状态不确定时采用 planning 权限或完全禁用工具，而非恢复正常权限。

## 工具分类与防绕过

能力枚举至少包括 `fs.read`、`fs.write`、`process.exec`、`network.read`、`network.write`、`vcs.read`、`vcs.write`、`secret.read`、`external.mutate`。内置 `read/grep/find/ls` 由包内固定适配器分类；`write/edit/bash` 在规划期拒绝。

自定义工具必须由受信任用户配置或包清单声明能力，并可附参数验证器。工具描述、JSON Schema 和名称只能辅助检查，不能自动授予能力。动态注册工具即使被其他扩展加入 active tools，也会在 `tool_call` 被最终门禁拒绝。

`bash` 不做“安全命令”猜测：组合命令、解释器、子进程、重定向及命令替换使正则方案不可证明。若未来启用，只能通过受限执行器或 OS 沙箱。MCP 在 Pi 中不是核心能力；由扩展接入后视同自定义远程工具。未声明副作用、服务身份变化、schema 漂移或参数超界均拒绝。

## 现有 Extension API 支撑判断

| API / 事件 | 支撑度 | 用途与缺口 |
|---|---|---|
| `pi.getActiveTools()` / `pi.setActiveTools()` | 部分 | 可缩减模型可见集合；无事务、能力和所有权语义，不能作安全边界 |
| `tool_call` 返回 `{block:true}` | 主要可用 | 可作模型工具最终门禁；并行调用需 epoch；不覆盖所有宿主直接执行入口 |
| `before_agent_start` | 可用 | 注入模式、获批计划和策略摘要 |
| `context` | 可用 | 删除过期注入并确保当前版本唯一 |
| `agent_end` | 部分 | 可触发 review UI；不是 settled，不应用于最终提交 |
| `pi.appendEntry()` | 可用 | 持久化状态与审计；custom entry 不进入 LLM 上下文 |
| `session_start` | 可用 | 恢复、迁移及重新施加限制 |
| `ctx.ui.select/editor` | 可用但需守卫 | TUI/RPC 可交互；JSON/Print 必须使用显式参数 |
| `ctx.ui.setStatus/setWidget` | 可用 | 展示模式、hash、步骤和警告；不是权威状态 |
| `ctx.mode/ctx.hasUI` | 可用 | 区分 TUI、RPC、JSON、Print；RPC 的 `hasUI=true` 不代表真实 TUI |

## 命令、UI、SDK、RPC 与 JSON 接口

命令：

- `/plan start [目标]`
- `/plan show`
- `/plan edit`
- `/plan approve <version> <hash>`
- `/plan execute <version> <hash>`
- `/plan cancel`
- `/plan status`
- `/plan audit`
- `/plan export [user|workspace]`

TUI 使用 `select` 审批、`editor` 编辑，`setStatus` 显示 `PLAN/REVIEW/EXEC`，`setWidget` 显示步骤和 hash。快捷键不得默认占用现有 Shift+Tab；可配置 `Ctrl+Alt+P`。

RPC MVP 通过 `prompt` 调用 extension command，并使用 `extension_ui_request/extension_ui_response`；P1 增加结构化 `plan_start/get/approve/execute/cancel` 及 `plan_state_changed`。JSON/Print 不弹窗，只接受启动参数或命令中的完整版本与 hash。SDK 通过 `DefaultResourceLoader.additionalExtensionPaths` 加载包；P1 导出 `PlanController`，返回结构化结果而非解析输出。

## 版本化计划工件 Schema

```json
{
  "schema": "dev.pi.plan/v1",
  "planId": "uuid",
  "version": 3,
  "parentVersion": 2,
  "createdAt": "RFC3339",
  "createdBy": {"kind": "model|user|rpc-client", "id": "string"},
  "goal": "string",
  "assumptions": ["string"],
  "scope": {"cwd": "absolute-path", "sessionId": "string", "branchLeafId": "string"},
  "steps": [{
    "id": "stable-id",
    "title": "string",
    "actions": ["string"],
    "expectedEffects": ["string"],
    "acceptance": ["string"],
    "status": "pending|running|verified|failed",
    "evidence": ["audit-event-id"]
  }],
  "riskSummary": "string",
  "policyDigest": "sha256",
  "contextDigest": "sha256",
  "contentHash": "sha256",
  "approval": {
    "subject": "string",
    "channel": "tui|rpc|sdk|cli",
    "approvedAt": "RFC3339",
    "approvedHash": "sha256"
  }
}
```

hash 对排除 `approval` 和 `contentHash` 后的 canonical JSON 计算；数组顺序有意义，禁止静默重排。

## 持久化、迁移、分支、恢复与 Compaction

状态采用 append-only custom entries，加载时只读取当前 `getBranch()`，不得从其他树分支取“最后一条”。Session Format v3 的 `id/parentId` 天然支持分支；分支后的计划复制为新 lineage，并清除审批。旧样例 `plan-mode` 数据仅迁移为未审批草稿；字段异常则隔离并进入 planning-safe。

写入顺序为“工件事件 → 状态提交事件”，恢复时忽略没有提交标记的尾部事务。`--no-session` 下明确提示仅进程内恢复。compaction 是有损的，custom entry 又不进入上下文，因此 `before_agent_start` 每轮从权威工件重注入；`session_before_compact/session_compact` 用于验证摘要是否保留 planId、版本、hash 和未完成步骤，但摘要本身不具权威性。

## 模型与上下文切换

模型切换可以继续 planning，但记录 provider/model；approved 后切换模型、cwd、策略摘要、活动分支或关键输入时标记 stale。思考级别变化仅审计，不默认撤销审批。上下文窗口不足时允许 compaction，不允许丢失权威工件；注入计划超过预算时使用确定性摘要并附 hash，完整内容仍从工件读取。

## 异常、兼容性与降级

schema 校验、hash、存储、策略加载或恢复失败时禁用执行并切回最小工具集。UI 取消、RPC 断连和审批超时均保持 review。策略扩展抛错时 `tool_call` 返回 block，而不是放行。

MVP 与现有会话及扩展兼容，不改变核心默认工具行为。若缺少能力清单，未知工具只在 Plan Mode 中被拒绝。若最小核心 execution-policy hook 尚未提供，RPC 客户端必须禁用直接 `bash`，并把“仅代理工具受保护”的降级边界显著暴露；安全等级标记为 `agent-tools-only`，不得宣称全局只读。

## 威胁模型与安全控制

主要威胁包括提示注入诱导写入、恶意仓库内容、shell 绕过、动态工具替换、MCP 服务副作用、伪造完成标记、重放旧审批、跨分支状态污染和崩溃导致权限误恢复。

控制措施为：最终调用门禁、能力声明、未知拒绝、版本/hash 绑定、审批 nonce 与身份、分支局部重建、epoch 防竞态、append-only 审计、恢复降权、项目信任检查及可选 OS 沙箱。日志不得记录密钥、完整敏感文件或工具返回正文，只记录摘要和 digest。

## 性能预算与日志审计

- 状态查询及普通策略判断 P95 小于 5 ms。
- 不含工具自身耗时的调用门禁 P99 小于 20 ms。
- 1,000 条计划事件恢复 P95 小于 100 ms。
- UI 更新每秒不超过 10 次。
- 单工件默认不超过 256 KiB，单审计事件不超过 16 KiB。

审计字段至少包含事件 ID、时间、session/branch、plan/version/hash、epoch、主体、通道、动作、工具来源、能力、判定、理由和关联证据。支持 JSON 导出和敏感字段脱敏。

## 测试与验收

1. 单元测试覆盖 schema canonicalization、hash、迁移、状态转换、能力矩阵及 fail-closed。
2. 属性测试证明任意未知工具、畸形输入和非法转换均不能提升权限。
3. 并发测试覆盖同一 assistant message 的并行 tool calls、切换 epoch、动态注册与其他扩展修改 active tools。
4. 安全回归包含管道、重定向、命令替换、解释器、子进程、别名、MCP 写操作及工具同名覆盖。
5. 会话测试覆盖 resume、fork、tree 分支、clone、尾部截断、重复事件和 compaction。
6. 模式矩阵覆盖 TUI、RPC、JSON、Print、SDK；无 UI 审批必须失败。
7. 验收标准：规划期零写入工具成功执行；旧 hash 不能执行新版本；崩溃恢复不自动回到 executing；模型自报不能改变步骤状态；所有拒绝和审批均可追溯。

## 发布、灰度与回滚

先以实验性用户级 Extension 发布，默认 `strict` 策略且禁用 bash/network。阶段一由维护者仓库和测试夹具验证；阶段二对自愿用户开放并收集匿名计数，不采集计划正文；阶段三稳定 schema v1。灰度开关按包版本和配置控制。

回滚只需禁用或移除 Extension，不迁移 Pi 核心 session 格式。已写 custom entries 保留但被旧版本忽略。若发现绕过，远程公告并建议立即禁用执行；新版本恢复时旧 approved/executing 状态统一标记 stale。

## 里程碑

1. **M0：模型与协议**——状态机、schema、威胁模型、测试夹具。
2. **M1：安全 MVP**——最终门禁、无 bash 规划、工件与审批、TUI/命令。
3. **M2：恢复与多模式**——分支、崩溃、compaction、RPC/JSON/Print/SDK。
4. **M3：生态扩展**——能力清单、网络策略、计划导出、审计工具。
5. **M4：通用核心缺口评审**——统一 execution-policy hook，保持无策略时完全兼容。

## 风险

- 扩展无法约束恶意扩展自身，用户可能误解为 OS 沙箱。
- 第三方工具能力声明可能失实，需要信任来源和运行时隔离。
- active tools 被其他扩展改写会造成 UI 与策略不一致。
- RPC 直接执行入口在核心增强前无法获得同等级覆盖。
- 计划摘要过长会增加上下文成本，过短又可能遗漏约束。
- 严格默认拒绝可能降低可用性，但不得以静默放宽换取便利。

## 待决策项

1. 统一 execution-policy hook 是否纳入核心，以及覆盖哪些直接执行入口。
2. 能力清单由 Extension 元数据、用户配置还是工具注册 API 提供。
3. workspace plans 目录是否允许在 planning 中写入，还是只在用户命令中导出。
4. RPC 审批身份采用客户端自报、进程凭据还是外部认证。
5. 网络读取是否进入 P0，默认允许域名应为空还是官方文档域。
6. `policyDigest/contextDigest` 哪些变化必须使计划 stale。
7. schema v1 是否采用 JSON 工件为权威、Markdown 仅作派生展示。

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
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- `/home/jiannlee22/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`

### 官方竞品资料

- Claude Code：<https://docs.anthropic.com/en/docs/claude-code/common-workflows>、<https://docs.anthropic.com/en/docs/claude-code/permissions>、<https://docs.anthropic.com/en/docs/claude-code/cli-usage>
- Cursor：<https://cursor.com/docs/agent/plan-mode>
- OpenAI Codex CLI：<https://developers.openai.com/codex/cli/slash-commands>、<https://developers.openai.com/codex/cli/reference>
- Gemini CLI：<https://geminicli.com/docs/cli/plan-mode/>、<https://geminicli.com/docs/tools/planning/>
