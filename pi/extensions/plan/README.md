# Agent Plan — 融合计划模式

融合 Claude Code、Cursor、OpenCode 主流 Agent 的计划工作流，适配 pi 终端环境（无悬浮层，通过状态栏与命令交互）。

## 融合要点

> 本版本额外参考了官方高使用率 `examples/extensions/plan-mode` 的交互习惯，并做了工作流对齐。

| 来源 | 吸收的能力 |
|------|-----------|
| **Claude Code** | 只读探索、结构化计划、用户批准后才构建 |
| **Cursor** | 澄清问题、迭代完善、Explore → Plan → Build 流水线 |
| **OpenCode** | 简洁阶段切换、计划落盘、明确模式边界 |

## 阶段

```
正常(off) → 探索(explore) → 审阅(review) → 构建(build) → 正常(off)
```

| 阶段 | 工具 | 说明 |
|------|------|------|
| 探索 | 只读 + 保留自定义工具 | 分析代码、输出结构化计划或澄清问题 |
| 审阅 | 只读 + 保留自定义工具 | 用户确认、修订或保存计划 |
| 构建 | 读写 + 保留自定义工具 | 按步骤执行，跟踪 `[DONE:n]` / `[SKIP:n]` |

## 命令

| 命令 | 功能 |
|------|------|
| `/plan` | 切换计划模式（进入探索 / 退出） |
| `/plan resume` | 从 `.plans/PLAN.md` 恢复计划并继续执行 |
| `/plan model` | 查看计划模型配置（smart/cheap） |
| `/plan model smart provider/model` | 设置创建计划时使用的智能模型 |
| `/plan model cheap provider/model` | 设置执行计划时使用的经济模型 |
| `/plan model clear smart|cheap` | 清除对应模型配置 |
| `/build` | 批准计划并开始构建 |
| `/todos` | 显示当前进度 |
| `/plans` | 查看已保存计划文档 |

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Alt+L` | 切换计划模式 |

## 计划格式

Agent 应输出以下结构化 Markdown：

```markdown
## 概述
目标与范围

## 方案
整体思路

## 关键文件
- `path/to/file.ts` — 改动说明

## 风险
- 风险与缓解

## 执行步骤
Plan:
1. [`path/to/file.ts`] 具体修改说明
2. ...

## 验证
- 测试与检查项
```

### 澄清问题（Cursor 风格）

需求不明确时，Agent 先输出：

```markdown
## 澄清问题
- 问题一？
- 问题二？
```

用户回答后继续制定计划。

### 歧义步骤

```
1. [src/auth.ts] 实现认证 [?] JWT | Session | OAuth2
```

审阅阶段会自动弹出选择对话框。

## 计划文档

- **最新计划**: `.plans/PLAN.md`
- **会话归档**: `.plans/plan-{sessionId}.md`

保存时机：审阅、步骤完成、构建完成。

## 工作流增强

- 进入计划模式会记录当前工具集，退出时自动恢复，避免影响你已有的自定义工作流。
- 构建阶段会在编辑器上方显示执行步骤小组件（最多 8 条，完整列表用 `/todos`）。
- 审阅阶段触发的“继续完善/批准构建”消息使用 follow-up 队列，减少并发时序问题。
- 可为不同阶段配置不同模型：创建计划用 smart，执行计划用 cheap。

## 阶段模型配置（smart / cheap）

计划模式支持按阶段自动切换模型：

- `explore/review`：优先切到 `smartModel`
- `build`：优先切到 `cheapModel`
- 退出计划模式：自动尝试恢复进入计划模式前的模型

配置文件位置：`.plans/model-config.json`

示例：

```bash
/plan model smart anthropic/claude-opus-4-5
/plan model cheap openai/gpt-4.1-mini
/plan model
```

## 工作流示例

1. `/plan` 进入探索阶段（状态栏显示 `[计划·探索]`）
2. 描述任务，Agent 探索代码并输出结构化计划
3. 进入审阅，选择「批准并开始构建」或 `/build`
4. 构建阶段 Agent 按步骤执行，输出 `[DONE:1]` 等标记
5. 全部完成后自动退出计划模式

## 测试

```bash
npx tsx extensions/plan/utils.test.ts
```
