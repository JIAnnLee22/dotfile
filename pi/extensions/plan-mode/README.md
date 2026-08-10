# Plan Mode 扩展（带歧义处理）

为 [pi coding agent](https://pi.dev) 提供的计划模式扩展：**只读探索 → 生成计划 → 用户确认 → 执行计划**，
核心亮点是**在创建计划时处理歧义**——不猜测、不擅自拍板，挂起计划创建并让用户决定。

## 安装

本扩展位于 `extensions/plan-mode/`，`settings.json` 的 `extensions` 已配置
`~/.config/pi/extensions/plan-mode`。进入 pi 后执行 `/reload` 即可生效。

```bash
# 手动安装（如果尚未配置）
pi install ./extensions/plan-mode
```

## 用法

1. 进入计划模式：`/plan`、`Ctrl+Alt+P`，或启动时 `pi --plan`
2. 让 agent 分析代码并制定计划；计划阶段只保留只读工具（edit/write 被禁用）
3. agent 遇到歧义时（见下），扩展会**挂起计划创建**，把歧义抛给你选择
4. 你做出决定后，agent 带着决定**继续创建计划**，最终输出 `Plan:` 编号计划
5. 弹出「下一步」选择：**Execute the plan**（恢复工具、开始执行）、**Stay in plan mode**、
   **Refine the plan**（继续完善）
6. 执行阶段用 `[DONE:n]` 标记追踪进度，**全屏 UI 顶部**常驻进度条 + 步骤列表
   （当前步骤高亮、已完成划线），footer 状态栏与 `/todos` 同步显示完成情况

## 歧义处理机制（双通道）

### 主通道：`report_ambiguity` 工具

计划模式下 agent 被引导：遇到需求不明确 / 多方案选型 / 约束冲突 / 意图不明时，
调用 `report_ambiguity` 工具，一次性提交一个或多个歧义点：

```
report_ambiguity({
  ambiguities: [
    { id: "q1", question: "使用哪个数据库？",
      options: [
        { value: "postgres", label: "PostgreSQL", description: "生态好，团队熟悉" },
        { value: "sqlite",   label: "SQLite",     description: "零运维，单文件" },
      ] },
    { id: "q2", question: "是否迁移现有数据？", options: [ ... ] },
  ]
})
```

工具执行期间 agent 循环**天然挂起**（等待工具结果），扩展逐个弹出选择框询问你；
选项之外还可以选「✏️ 自定义输入…」。你的决定以工具结果形式返回给 agent，
agent 据此**继续创建计划**。

### fallback：文本 `<ambiguity>` 标记

若 agent 未调用工具，而在回复中输出了 `<ambiguity>` 标记（或 `AMBIGUITY:` 段落），
扩展会 `ctx.abort()` **强制挂起**当前 agent，解析标记中的问题与选项并询问你，
再把你的决定以 followUp 消息注入，继续创建计划。

### 无 UI 模式（print/json/rpc）

无法弹窗询问时，工具返回明确提示，让 agent 自行选择最合理方案并注明假设，
供你事后确认——避免在非交互模式下卡死。

## 顶部进度显示（全屏模式）

全屏 UI 默认把扩展 widget 渲染在**编辑器上方（底部 dock）**。本扩展通过
`top-widget.ts` 的运行时布局补丁，把 widget 容器提升到 **transcript 上方**，
形成"屏幕顶部常驻进度条"：

```
┌─────────────────────────────────────┐
│ 📋 3/7  [███████░░░░░░░░░░░░░] 43%  │ ← 顶部 widget（常驻，不随滚动消失）
│ ☑ 1. 检查 plan-mode 扩展结构        │
│ ▶ 2. 修复 fallback 无 UI 卡死       │ ← 当前步骤高亮
│ ☐ 3. 计划落盘 .plan/*.md            │
│ ☐ 4. ...                            │
├─────────────────────────────────────┤
│ transcript（滚动区）                │
├─────────────────────────────────────┤
│ editor / footer                     │
└─────────────────────────────────────┘
```

- planning 阶段显示模式提示；executing 阶段显示进度条 + 步骤列表；
  off 阶段完全不占行（entry.visible 控制）
- 步骤超过 8 行自动截断并提示剩余数；全部完成显示 ✅
- 补丁幂等且带结构守卫：pi 升级后若内部结构变化，自动跳过并回退
  到"编辑器上方"原位置（不影响其余功能），并在控制台输出 warn

## 状态与持久化

- 计划阶段/执行阶段、步骤进度、切换前的工具集均通过 `pi.appendEntry("plan-mode", …)` 持久化
- `/reload` 或会话恢复后，`session_start` 自动恢复阶段与进度（执行阶段重扫 `[DONE:n]`）

## 文件结构

- `index.ts` —— 扩展主逻辑：阶段机、`report_ambiguity` 工具、fallback、命令/快捷键
- `ambiguity.ts` —— 歧义数据模型、标记解析、决定格式化（纯函数，可测试）
- `plan.ts` —— `Plan:` 提取、`[DONE:n]` 进度、顶部 widget 视图（纯函数，源自官方示例 utils）
- `top-widget.ts` —— 顶部 widget 布局提升：把扩展 widget 容器从底部 dock 移到
  fullscreen 布局顶部（运行时补丁，幂等 + 结构守卫，上游变化时自动回退到编辑器上方）
- `test/plan-mode.test.ts` —— 纯函数单元测试（`node test/plan-mode.test.ts` 运行）

## 与官方示例的差异

官方 `examples/extensions/plan-mode` 只做"只读 + 计划提取 + 执行跟踪"，遇到拿不准的
问题会自行猜测。本扩展在其基础上加入歧义处理闭环：

| 环节 | 官方示例 | 本扩展 |
|---|---|---|
| 歧义 | 无，agent 自行假设 | `report_ambiguity` 工具 + 文本标记双通道 |
| 挂起 | 无 | 工具执行等待（主通道）/ `ctx.abort()`（fallback） |
| 用户决定 | 无 | `ctx.ui.select/input` 抛给用户 |
| 继续 | — | 决定作为工具结果 / followUp 消息注入 agent |
| 引导 | 无 | `before_agent_start` 注入歧义处理约定 |
