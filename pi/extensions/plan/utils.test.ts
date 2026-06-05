/**
 * 运行: npx tsx extensions/plan/utils.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  splitCommandSegments,
  hasUnsafeRedirect,
  isSafeCommand,
  extractTodoItems,
  extractClarifyingQuestions,
  extractStructuredPlan,
  hasActionablePlan,
  markCompletedSteps,
  markSkippedSteps,
  generateProgressBar,
  formatPlanList,
  getNextPendingItem,
  generatePlanMarkdown,
  isAmbiguousStep,
  parseAmbiguousSteps,
  buildResolvedText,
  formatStructuredSummary,
} from "./utils.ts";

describe("splitCommandSegments", () => {
  it("splits pipes and logical operators", () => {
    assert.deepEqual(splitCommandSegments("ls -la | head -5"), ["ls -la", "head -5"]);
    assert.deepEqual(splitCommandSegments("ls && pwd"), ["ls", "pwd"]);
  });
});

describe("isSafeCommand", () => {
  it("allows safe read-only commands", () => {
    assert.equal(isSafeCommand("ls -la | head -5"), true);
    assert.equal(isSafeCommand("git status"), true);
  });

  it("blocks destructive commands", () => {
    assert.equal(isSafeCommand("rm -rf /"), false);
    assert.equal(isSafeCommand("npm install foo"), false);
  });
});

describe("extractClarifyingQuestions", () => {
  it("extracts questions from structured section", () => {
    const msg = `## 澄清问题\n- 目标用户是谁？\n- 是否需要兼容旧 API？`;
    const qs = extractClarifyingQuestions(msg);
    assert.equal(qs.length, 2);
    assert.match(qs[0], /目标用户/);
  });
});

describe("extractStructuredPlan", () => {
  it("parses all sections and steps", () => {
    const msg = `## 概述\n重构登录模块\n\n## 方案\n使用 JWT\n\n## 关键文件\n- src/auth.ts\n\n## 风险\n无明显风险\n\n## 执行步骤\nPlan:\n1. [src/auth.ts] 添加验证\n\n## 验证\n- 运行单元测试`;
    const plan = extractStructuredPlan(msg);
    assert.match(plan.overview, /重构登录/);
    assert.match(plan.approach, /JWT/);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].step, 1);
    assert.match(plan.verification, /单元测试/);
    assert.equal(hasActionablePlan(plan), true);
  });
});

describe("extractTodoItems", () => {
  it("preserves original step numbers", () => {
    const items = extractTodoItems(`Plan:\n1. First step here\n5. Fifth step here\n`);
    assert.equal(items.length, 2);
    assert.equal(items[0].step, 1);
    assert.equal(items[1].step, 5);
  });
});

describe("markCompletedSteps / markSkippedSteps", () => {
  it("marks by step number", () => {
    const items = [
      { step: 1, text: "A", completed: false },
      { step: 5, text: "B", completed: false },
    ];
    markCompletedSteps("done [DONE:5]", items);
    assert.equal(items[1].completed, true);
    markSkippedSteps("[SKIP:1]", items);
    assert.equal(items[0].skipped, true);
  });
});

describe("generatePlanMarkdown", () => {
  it("includes structured sections and phase", () => {
    const md = generatePlanMarkdown(
      [{ step: 1, text: "Do thing", completed: false }],
      { sessionId: "s1", phase: "审阅", cwd: "/tmp" },
      { overview: "目标", approach: "方案", keyFiles: "a.ts", risks: "低", verification: "测试" },
    );
    assert.match(md, /## 概述/);
    assert.match(md, /\| 阶段 \| \*\*审阅\*\* \|/);
    assert.match(md, /## 验证/);
  });
});

describe("formatStructuredSummary", () => {
  it("builds readable summary", () => {
    const summary = formatStructuredSummary({
      overview: "概述内容",
      approach: "",
      keyFiles: "",
      risks: "",
      verification: "",
      steps: [{ step: 1, text: "步骤一", completed: false }],
      questions: [],
      rawMarkdown: "",
    });
    assert.match(summary, /\*\*概述\*\*/);
    assert.match(summary, /步骤一/);
  });
});

describe("parseAmbiguousSteps", () => {
  it("parses pipe-separated options", () => {
    const items = [{ step: 1, text: "认证 [?] JWT | Session", completed: false }];
    const ambiguous = parseAmbiguousSteps(items);
    assert.equal(ambiguous.length, 1);
    assert.deepEqual(ambiguous[0].options, ["JWT", "Session"]);
  });
});

describe("buildResolvedText", () => {
  it("combines options", () => {
    assert.equal(buildResolvedText("实现认证", ["JWT"]), "实现认证：JWT");
    assert.equal(buildResolvedText("实现认证", ["JWT", "OAuth"]), "实现认证：JWT + OAuth");
  });
});
