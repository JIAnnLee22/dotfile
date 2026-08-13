# Operations Deck

编辑器上方的高密度运行状态坞（方案 A）：主任务、Plan Mode 进度、并行子任务与模型/上下文信息一屏尽览。本扩展**不替换** Pi 默认的 footer/编辑器/Markdown 渲染，只使用 `setWidget()` 的 widget 槽位。

## 功能

- **MAIN 区**：运行/空闲、turn 数、当前工具、回合耗时、目标文本（优先 Plan goal，其次最近用户消息）。
- **MODEL 区**（MAIN 行右侧）：provider/model、thinking 级别、上下文占用百分比、累计输入/输出 token 与 cost。
- **PLAN 区**：Plan Mode 状态（RESEARCH/REVIEW/EXECUTING/PAUSED/STALE…）、步骤完成计数、当前步骤标题、证据数与安全等级；步骤行含 `✓/▶/!/○` 状态标记，预算不足时优先保留 running/failed。
- **AGENTS 区**：`parallel_tasks` 每个子任务的 label/role、状态（`●` 运行 / `✓` 成功 / `!` 失败 / `×` 中止 / `○` 排队）、实际模型、turn/tool 数、耗时与 cost；失败/中止任务优先展示并附原因。

## 使用

| 操作 | 效果 |
|---|---|
| `/deck` 或 `Ctrl+Alt+D` | `full → compact → hidden` 循环切换 |
| `/deck full` / `/deck compact` / `/deck hidden` | 指定视图 |

- `full`：按终端高度自适应 6–12 行（<30 行 → 6，30–39 → 8，40–49 → 10，≥50 → 12）。
- `compact`：固定 3 行摘要。
- `hidden`：不渲染；`/deck` 恢复。

## 数据源

- **Plan 状态**：优先订阅 plan-mode 广播的 `operations-deck:plan` 事件（实时）；兜底扫描当前 branch 上 `plan-mode/audit` custom entries 的最后 `state-committed`，并按 `~/.pi/agent/plans/<sha256(cwd) 前 20 位>/<planId>/vNNNN/spec.json` 读取步骤标题（读取失败降级为仅步骤 ID）。
- **子任务**：优先订阅 `parallel-tasks` 广播的 `operations-deck:tasks` 事件与 `tool_execution_update` 的实时 partialResult；兜底扫描 branch 上最后一次 `parallel_tasks` toolResult 的 details。
- **MAIN/MODEL**：Pi 的 agent/turn/tool/model/thinking 生命周期事件 + `ctx.getContextUsage()` + 会话 usage 统计。

## 与现有扩展的关系

- **plan-mode**：deck 处于 `full` 模式时，plan-mode 收到 `operations-deck:mode` 事件后隐藏自己的独立 widget 与 footer 状态（避免重复展示）；切换 `compact`/`hidden` 后自动恢复。plan-mode 的 controller/安全逻辑完全不受影响。
- **parallel-tasks**：`TaskResult` 增加 `model` 字段（从子进程 `message_end` 的 `msg.model` 捕获），无该字段时 AGENTS 区显示 `?`。
- **Dense UI**：本扩展不与 Dense UI 冲突（不占用其 footer/editor 槽），但 Dense 已被移除，默认 Markdown/编辑器/footer 由 Pi 提供。

## 故障降级

- Plan 审计 entries 缺失或损坏：PLAN 区显示 `PLAN unavailable`，其余区域不受影响。
- spec.json 读取失败：步骤只显示 ID 与状态计数，不崩溃。
- `parallel_tasks` 无数据：AGENTS 区显示 `AGENTS none`。
- 非 TUI 模式（print/json/rpc）：不注册 widget 与快捷键，`/deck` 命令仅返回状态文本。

## 测试

```bash
node --experimental-strip-types --test extensions/operations-deck/tests/*.test.ts
```

覆盖：自适应高度分段、full 分区完整性、窄宽降级、长文本截断、步骤预算排序、agents 排序与统计显示、plan reason 呈现、compact/hidden 行数、Plan 审计扫描、PlanSummary 构建、parallel_tasks details 提取与状态分类。
