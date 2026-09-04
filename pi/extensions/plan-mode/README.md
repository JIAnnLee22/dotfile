# Plan Mode Extension v2

面向 Pi Coding Agent 0.84.4 的主流计划工作流：**只读规划 → 必要澄清 → 审阅/编辑 → 一次实施确认 → 连续实施**。

> 当前文档描述 v2 重构目标；实现完成前仓库中的运行代码仍可能包含 v1 strict 行为。权威需求见 `PLAN_MODE_REQUIREMENTS_A.md` v0.4。

## 用户体验

```text
/plan 修复登录竞态
```

1. 扩展在缩减工具前保存当前 active tool baseline。
2. 模型使用来源验证的只读/研究工具调查代码；重大歧义通过 `plan_question` 确认。
3. 模型调用精简 `plan_submit`，提交目标、决策、步骤、涉及文件、验证和风险。
4. 审阅面板统一提供：
   - 实施
   - 编辑计划（填写修改意见，由模型生成新版本）
   - 继续规划
   - 取消
5. 用户选择实施后，面板展示临时启用的 `edit/write/bash`。扩展先设置工具并读回验证，再记录批准并进入实施。
6. 模型通过 `plan_step_complete` 逐步上报；扩展自动继续下一步。真实阻塞调用 `plan_blocked`。
7. 完成、取消或失败后恢复进入规划前的工具 baseline。

常用命令：

```text
/plan [goal]
/plan status
/plan show
/plan diff
/plan edit
/plan pause
/plan resume
/plan cancel
/plan audit
```

`/plan run` 可作为 `implement` 的兼容别名。hash、审批 ID 和内部 revision 不进入普通用户流程。

## 与 v1 strict 模式的区别

v2 有意移除以下实施期硬门禁：

- `ExecutionGrant`
- `pathScopes`
- `requiredCapabilities`
- capability evidence 完成门槛
- model/tool digest 变化直接 stale

实施确认后，普通工具权限等同普通 Pi。计划中的文件和验证项是上下文及审阅信息，不是沙箱边界。`plan_step_complete` 仍是 Todo 进度的唯一模型入口，但只校验当前步骤和非空总结；工具结果仅作为信息性审计。

## 规划期工具策略

规划期、审阅期和暂停期仍执行 `agent-tools-only` 门禁。工具必须匹配来源锁定 capability registry；未知、来源漂移或配置错误时 fail-closed。

默认分类：

| 工具 | 规划期行为 |
|---|---|
| builtin `read/grep/find/ls` | 允许 |
| `ffgrep/fffind` | 来源为 `npm:@ff-labs/pi-fff` 时允许 |
| `ctx_search/ctx_stats/ctx_doctor` | 来源为 `npm:context-mode` 时允许 |
| `web_search/source_check/fetch_content/get_search_content` | 本计划首次调用时确认 |
| `ctx_index/ctx_fetch_and_index` | 本计划首次调用时确认 |
| `ctx_execute/ctx_execute_file/ctx_batch_execute` | 拒绝 |
| `ctx_upgrade/ctx_purge/ctx_insight` | 拒绝 |

### 为什么拒绝 context-mode execute 系列

context-mode 1.0.169 虽称“sandboxed subprocess”，但 `PolyglotExecutor` 只把脚本存入临时目录，实际在项目根 cwd 执行任意 JS/Python/shell。临时项目探针已确认 `ctx_execute` 可持久写入宿主文件；`ctx_execute_file` 复用同一执行器。因此这些工具不能归类为只读。

### 自定义 registry

可在以下位置扩展：

```text
$PI_CODING_AGENT_DIR/plan-mode-policy.json
```

每项必须绑定工具名、capability、source，并可绑定 path。示例见 `plan-mode-policy.example.json`。name-only 配置无效；错误配置拒绝对应工具。

网络/索引授权只在当前计划有效：TUI/RPC 首次调用弹一次确认；Print/JSON 无 UI 时拒绝。

## 实施工具事务

用户选择实施或 resume 后：

1. 验证精确 PlanRef 和工件 hash。
2. 确认 builtin `edit/write/bash` 均已注册。
3. 计算 `baseline ∪ {edit, write, bash}`。
4. 调用 `setActiveTools()`。
5. 用 `getActiveTools()` 读回。
6. 缺任一工具则返回 `TOOL_UNAVAILABLE`，恢复 planning-safe 集，不记录批准、不进入 implementing。
7. 全部 active 后才记录 ApprovalRecord、提交 implementing，并排队实施回合。

这能避免“状态已 executing 但模型没有可变工具”，但 `setActiveTools()` 没有跨扩展原子所有权；其他扩展仍可能在读回后改变工具集。

## 连续实施

- 实施开始和每次 `plan_step_complete` 后显式排队下一回合。
- 使用 Pi 0.84.4 的 `agent_settled` 检测真正停止；不再使用 `agent_end`，因为其后可能还有 retry、compaction 或 follow-up。
- 连续两次 settled 且步骤 revision 未变化时自动 pause。
- `plan_blocked` 立即 pause 并切回 planning-safe 工具。
- 最后步骤完成后请求最终总结，再恢复 baseline 和清理 widget。

## 计划工件

v2 权威工件仍为不可变 canonical JSON：

```text
~/.pi/agent/plans/<project-id>/<plan-id>/vNNNN/spec.json
```

`review.md` 是确定性人类投影。模型提交的公开字段：

```ts
{
  goal: string;
  decisions: string[];
  steps: Array<{
    title: string;
    actions: string[];
    files: string[];
    validation: string[];
  }>;
  risks: string[];
}
```

扩展生成步骤 ID、版本、lineage、scope 和 contentHash。ApprovalRecord、ResearchPermission、baseline、进度、证据和审计不写回 spec。

## v1 迁移

- `dev.pi.plan/v1` 永不原地修改，可继续查看和导出。
- 旧 active 状态恢复为 paused。
- resume 时创建带 `importedFrom` 的新 v2 lineage，映射旧目标、事实/假设、步骤、pathScopes 和 acceptance。
- 旧 approval/grant 不继承，必须重新确认。
- 无法映射时保持 view-only 并显示具体字段错误。

## 恢复

- reload/resume/process restart/model change：implementing → paused。
- `/tree`：只从目标 branch 恢复，活动计划 paused。
- fork/clone：新 v2 lineage，复制当前 Todo/进度，清审批，paused。
- compaction：不改变权威状态；每轮从工件重新注入。
- 工件缺失、schema/hash/审计损坏：stale，不允许 resume。

baseline 在进入 planning 前持久化；reload 时不得把当前受限工具集重新捕获为 baseline。

## 多运行模式

- **TUI**：完整审阅面板、修改意见 editor、网络确认、Todo widget。
- **RPC**：使用 `extension_ui_request/response`；取消、断连和超时不授权。
- **Print/JSON**：submit 后停在 review；通过携带精确 PlanRef 的显式 implement/resume action 继续。
- **RPC direct bash**：不经过模型 `tool_call`，规划期仍显示 `SAFETY_BOUNDARY_DEGRADED`。

## 安全边界

Plan Mode v2 不是 OS 沙箱。

规划期只约束可信扩展集合中的模型工具调用；不能约束恶意扩展、扩展直接 Node I/O、`pi.exec()`、用户 `!`/`!!` 或 RPC direct bash。实施期明确恢复普通 Pi 权限，`edit/write/bash` 以当前用户权限运行，可能修改文件、启动子进程或访问网络。

强隔离任务应在容器、VM 或 OS sandbox 中运行整个 Pi。

## 开发与测试

```bash
node --experimental-strip-types --test extensions/plan-mode/tests/*.test.ts
node --experimental-strip-types --test extensions/autopilot/tests/*.test.ts
```

还必须运行 Pi 0.84.4 的 Print/JSON/RPC runtime tests，覆盖：工具 set/readback 顺序、审阅动作、网络首次确认、agent_settled 连续实施、baseline 恢复、v1 迁移、tree/fork/clone/compaction。
