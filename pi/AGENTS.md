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
