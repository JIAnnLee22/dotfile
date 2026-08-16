# Autopilot Extension

完全自主的开发模式：当你说"需要一直自检直到目标达成才停止开发"（或 `/autopilot <目标>`、`--autopilot`），agent 自己决定一切、使用全部核心功能、无需任何确认，自动定义验收标准（AC）→ 干跑校验 AC 可执行 → 开发 + 自检循环 → 全部 AC 通过才停止，并输出验收报告。

流程（零人工干预）：

1. **drafting（自主规划）**：agent 只读研究项目，重述目标，自主定义验收标准（每个 AC 带具体的可执行验证命令）。不允许问用户问题。
2. **dryrun（AC 干跑校验）**：提交 MissionSpec 后进入只读阶段。agent 逐个实际运行每个 AC 的验证命令，确认可执行、可判定，然后报告 `ready/not_ready`。**全部 ready 之前不会改动任何文件**——这是"目标理解错误"的最后防线。
3. **running（开发+自检循环）**：全部工具开放（读写、bash、搜索）。agent 开发 → 跑验证 → 报告 `pass/fail` → 未通过的继续修复重验，循环直到所有必需 AC pass。任何 pass 声明必须伴随当前报告窗口内的成功工具证据，无证据的"通过"会被扩展拒绝。
4. **completed**：输出验收报告（每个 AC 的状态与证据），自动回到 inactive。

## 安全边界

安全级别 **`agent-tools-only`**。模型工具调用经 `tool_call` fail-closed 拦截：

- **drafting**：只读（read/grep/find/ls/ffgrep/fffind），bash 与写工具全部拒绝。
- **dryrun**：只读 + bash（仅验证命令，危险命令仍拦截），写工具拒绝。
- **running**：read/bash/edit/write 全开放，但：
  - 写路径限制在项目 cwd 内；`pathScopes` 声明后可进一步收紧到指定子目录。
  - bash 危险命令黑名单（`rm -rf /`、`mkfs`、`dd` 写设备、fork bomb、`git push --force`、`shutdown/reboot`、`chmod -R 777 /` 等）；设 `AUTOPILOT_DISABLE_DANGER_FILTER=1` 可显式关闭（不推荐）。
  - 未知来源工具一律 deny（fail-closed）。
- 每个决策、证据、报告全部写入 append-only 审计日志（会话 custom entries + 不可变 MissionSpec 落盘 `~/.pi/agent/missions/<project>/<mission>/vNNNN/spec.json`）。
- 停滞防护：连续 2 轮自动续跑无工具证据 → 自动 pause；单次任务自动续跑上限 128 轮 → pause。
- 任意时刻可中止：`Esc`、`/autopilot pause`、`/autopilot cancel`。resume 后证据窗口重置，必须重新验证才能再次声明 pass。

它**不是** OS 沙箱：无法约束恶意扩展、扩展自身的 Node I/O、`pi.exec()`、用户 `!`/`!!`、RPC 直接 bash。`setActiveTools()` 只是可见性降低，权威边界在 `tool_call` 策略与审计。模型可以撒谎（比如跑了无关命令后宣称 pass），审计轨迹保留完整证据链供事后复查——这是 agent-tools-only 级别的承诺。

## 使用

```text
# 触发方式一：自然语言（中文/英文关键词）
> 请一直自检直到达到目标才停止开发：给 README 加安装章节并自检通过

# 触发方式二：命令
/autopilot <目标>

# 触发方式三：启动 flag（print/json 模式）
pi -p --autopilot --autopilot-goal "修复 CI 并自检通过" "run-autopilot"
```

状态与恢复命令：`/autopilot status`、`/autopilot show`（查看 AC）、`/autopilot audit`（审计轨迹）、`/autopilot pause`、`/autopilot resume`、`/autopilot cancel`。

会话恢复（/resume、/tree、fork）：dryrun/running 一律恢复为 paused（执行状态永不自动恢复），证据重置；`/autopilot resume` 后重新验证。

## 与 plan-mode 的关系

- **plan-mode**（`extensions/plan-mode/`）：计划 → 一次人工确认 → 逐 Todo 执行。适合需要人看一眼计划的场景。
- **autopilot**（本目录）：一句话触发 → 零确认 → 自主 AC + 干跑校验 + 自检循环到验收。适合你已经信任目标、要它自己跑完的场景。
- 两者状态机与工具互不干扰；autopilot 活跃期间 `plan_question` 等 plan-mode 工具会被 autopilot 策略拒绝（自主模式不问用户，属设计行为）。

## 测试

```bash
node --experimental-strip-types --test extensions/autopilot/tests/*.test.ts
```

覆盖：完整旅程（触发→drafting→dryrun→running→completed）、AC 干跑证据门禁、报告证据窗口（旧证据不计）、版本化不可变 MissionSpec、可选 AC、暂停/恢复/取消/重置、未知 AC/非法状态拒绝、审计损坏与 artifact 缺失 fail-closed、并发串行化、策略阶段限制（drafting 只读 / dryrun 禁写 / running cwd 内写）、危险命令黑名单、写路径 scope 收紧、只读扩展工具放行、受管工具来源校验。
