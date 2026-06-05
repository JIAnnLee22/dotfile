/**
 * 融合 Claude Code / Cursor / OpenCode 的计划模式提示词
 *
 * Claude Code: 只读探索、结构化计划、用户批准后才构建
 * Cursor: 澄清问题、迭代完善、Explore → Plan → Build 流水线
 * OpenCode: 简洁模式切换、计划落盘、明确阶段边界
 */

export type PlanPhase = "off" | "explore" | "review" | "build";

export const PHASE_LABELS: Record<PlanPhase, string> = {
  off: "正常",
  explore: "探索",
  review: "审阅",
  build: "构建",
};

export function buildExplorePrompt(): string {
  return `[计划模式 · 探索阶段]

你处于计划模式的探索阶段（融合 Claude Code / Cursor / OpenCode 工作流）。
此阶段**只读**：可以分析代码，但**不得**修改任何文件。

## 可用工具
- read, bash（仅只读命令）, grep, find, ls

## 禁用
- edit, write 及一切会改动仓库的操作

## 工作流（按顺序）

### 1. 理解需求
- 若需求不明确、存在多种合理解读或缺少关键约束，先输出「澄清问题」区块，**不要**直接写执行步骤
- 每个问题应具体、可回答，并说明为何需要该信息

### 2. 探索代码库
- 阅读相关文件，理清依赖、调用链与现有约定
- 定位需要改动的文件、函数、类型

### 3. 输出结构化计划
当信息足够时，用以下 Markdown 结构输出（区块标题必须保留）：

---
## 概述
（1-3 句话说明目标与范围）

## 方案
（整体思路、技术选型、为何这样设计）

## 关键文件
- \`path/to/file.ts\` — 作用与改动要点
- ...

## 风险
- 风险点与缓解措施（无则写「无明显风险」）

## 执行步骤
Plan:
1. [\`path/to/file.ts\`] 具体修改说明（避免「改一下」「更新文件」等模糊表述）
2. ...

## 验证
- 如何验证改动正确（测试、手动检查项等）
---

## 歧义步骤（可选）
若某步有多种等效方案，使用 [?] 并列出选项：
\`N. [path] 描述 [?] 方案A | 方案B | 方案C\`

## 规则
- 先探索、后计划；不要在探索不充分时仓促列步骤
- 每步必须包含文件路径与具体改动说明
- **不要**执行任何修改；只描述你会做什么
- 用户批准计划后才会进入构建阶段`;
}

export function buildReviewPrompt(planMarkdown: string): string {
  return `[计划模式 · 审阅阶段]

用户正在审阅以下计划。此阶段仍为只读，请根据用户反馈**修订计划**，不要执行修改。

## 当前计划
${planMarkdown}

## 修订要求
- 保持「概述 / 方案 / 关键文件 / 风险 / 执行步骤 / 验证」结构
- 执行步骤仍使用 \`Plan:\` + 编号列表
- 若用户提出新约束，更新相关区块而非只改单步`;
}

export function buildBuildPrompt(remainingSteps: string): string {
  return `[计划模式 · 构建阶段]

计划已批准，完整工具访问已启用。请按顺序执行剩余步骤。

## 剩余步骤
${remainingSteps}

## 执行规则
1. 严格按步骤顺序执行，每步聚焦一个明确目标
2. 完成某步后，在回复中包含 \`[DONE:n]\`（n 为步骤编号）
3. 若某步应跳过，使用 \`[SKIP:n]\` 并简要说明原因
4. 遵守项目既有风格与约定；改动范围保持在计划内
5. 完成后运行「验证」区块中的检查项（如适用）`;
}

export function buildQuestionsFollowUp(questions: string[]): string {
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return `在继续制定计划前，请先回答以下澄清问题：\n\n${list}`;
}
