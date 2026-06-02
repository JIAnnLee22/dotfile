/**
 * 运行: npx tsx extensions/plan-mode/utils.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  splitCommandSegments,
  hasUnsafeRedirect,
  isSafeCommand,
  extractTodoItems,
  markCompletedSteps,
  markSkippedSteps,
  generateProgressBar,
  formatPlanList,
  getNextPendingItem,
  generatePlanMarkdown,
  isAmbiguousStep,
  parseAmbiguousSteps,
  buildResolvedText,
} from "./utils.ts";

describe("splitCommandSegments", () => {
  it("splits pipes and logical operators", () => {
    assert.deepEqual(splitCommandSegments("ls -la | head -5"), ["ls -la", "head -5"]);
    assert.deepEqual(splitCommandSegments("ls && pwd"), ["ls", "pwd"]);
  });

  it("does not split inside quoted, escaped, or command substitution contexts", () => {
    assert.deepEqual(splitCommandSegments("echo 'a|b;d' | wc -c"), ["echo 'a|b;d'", "wc -c"]);
    assert.deepEqual(splitCommandSegments("echo foo\\|bar | wc -c"), ["echo foo\\|bar", "wc -c"]);
    assert.deepEqual(splitCommandSegments("echo $(printf 'a|b') | wc -c"), ["echo $(printf 'a|b')", "wc -c"]);
    assert.deepEqual(splitCommandSegments("echo `printf 'x;y'` && pwd"), ["echo `printf 'x;y'`", "pwd"]);
  });
});

describe("hasUnsafeRedirect", () => {
  it("allows stderr suppression", () => {
    assert.equal(hasUnsafeRedirect("ls 2>/dev/null"), false);
    assert.equal(hasUnsafeRedirect("ls 2>>/dev/null"), false);
    assert.equal(hasUnsafeRedirect("ls 2>&1"), false);
    assert.equal(hasUnsafeRedirect("ls &>/dev/null"), false);
  });

  it("blocks file write redirects", () => {
    assert.equal(hasUnsafeRedirect("echo hi > out.txt"), true);
    assert.equal(hasUnsafeRedirect("echo hi >> out.txt"), true);
    assert.equal(hasUnsafeRedirect("echo hi 1> out.txt"), true);
    assert.equal(hasUnsafeRedirect("echo hi 1>> out.txt"), true);
    assert.equal(hasUnsafeRedirect("echo hi >| out.txt"), true);
  });

  it("blocks read-write redirection", () => {
    assert.equal(hasUnsafeRedirect("cat <> out.txt"), true);
    assert.equal(hasUnsafeRedirect("cat 0<> out.txt"), true);
  });
});

describe("isSafeCommand", () => {
  it("allows safe piped read-only commands", () => {
    assert.equal(isSafeCommand("ls -la extensions/ 2>/dev/null"), true);
    assert.equal(isSafeCommand("ls -la | head -5"), true);
    assert.equal(isSafeCommand("git rev-parse --show-toplevel"), true);
  });

  it("blocks destructive commands", () => {
    assert.equal(isSafeCommand("rm -rf /"), false);
    assert.equal(isSafeCommand("git add ."), false);
    assert.equal(isSafeCommand("npm install foo"), false);
  });

  it("blocks write redirects in pipelines", () => {
    assert.equal(isSafeCommand("echo x > /tmp/out"), false);
  });
});

describe("extractTodoItems", () => {
  it("preserves original step numbers", () => {
    const msg = `Plan:\n1. First step here\n5. Fifth step here\n`;
    const items = extractTodoItems(msg);
    assert.equal(items.length, 2);
    assert.equal(items[0].step, 1);
    assert.equal(items[1].step, 5);
  });

  it("supports inline header format", () => {
    const msg = "Plan: 1. Analyze repo\n2. Update docs";
    const items = extractTodoItems(msg);
    assert.equal(items.length, 2);
    assert.equal(items[0].step, 1);
    assert.equal(items[1].step, 2);
  });

  it("stops parsing when non-step content appears after plan steps", () => {
    const msg = `Plan:\n1. Analyze repo\n2. Update docs\n\nNotes:\n1. This should not be parsed\n2. Neither should this`;
    const items = extractTodoItems(msg);
    assert.equal(items.length, 2);
    assert.equal(items[0].step, 1);
    assert.equal(items[1].step, 2);
  });

  it("keeps full step text without truncation", () => {
    const longStep = "[extensions/plan-mode/index.ts] 重构 togglePlanOverlay 的显示逻辑并修复自动显示后再次快捷键打开失败的问题，补全状态守卫与资源清理";
    const msg = `Plan:\n1. ${longStep}`;
    const items = extractTodoItems(msg);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, longStep);
  });

  it("keeps file path markers in extracted steps", () => {
    const msg = "Plan:\n1. [src/auth/login.ts] 在 login 函数中添加参数验证逻辑";
    const items = extractTodoItems(msg);
    assert.equal(items.length, 1);
    assert.match(items[0].text, /^\[src\/auth\/login\.ts\]/);
  });
});

describe("markCompletedSteps / markSkippedSteps", () => {
  it("marks by step number not list index", () => {
    const items = [
      { step: 1, text: "A", completed: false },
      { step: 5, text: "B", completed: false },
    ];
    markCompletedSteps("done [DONE:5]", items);
    assert.equal(items[0].completed, false);
    assert.equal(items[1].completed, true);

    markSkippedSteps("[SKIP:1]", items);
    assert.equal(items[0].skipped, true);
    assert.equal(items[0].completed, true);
  });

  it("counts only newly changed items", () => {
    const items = [
      { step: 1, text: "A", completed: false },
      { step: 2, text: "B", completed: false },
    ];
    const changed1 = markCompletedSteps("[DONE:1] [DONE:1]", items);
    const changed2 = markCompletedSteps("[DONE:1]", items);
    const changed3 = markSkippedSteps("[SKIP:2] [SKIP:2]", items);
    const changed4 = markSkippedSteps("[SKIP:2]", items);

    assert.equal(changed1, 1);
    assert.equal(changed2, 0);
    assert.equal(changed3, 1);
    assert.equal(changed4, 0);
  });
});

describe("getNextPendingItem", () => {
  it("returns lowest incomplete step", () => {
    const items = [
      { step: 5, text: "B", completed: false },
      { step: 2, text: "A", completed: false },
    ];
    assert.equal(getNextPendingItem(items)?.step, 2);
  });
});

describe("generateProgressBar", () => {
  it("renders partial fill", () => {
    assert.equal(generateProgressBar(1, 2, 4), "██░░");
  });
});

describe("formatPlanList", () => {
  it("uses item.step in display", () => {
    const list = formatPlanList([{ step: 3, text: "Do thing", completed: false }]);
    assert.match(list, /^3\. /);
  });
});

describe("generatePlanMarkdown", () => {
  it("generates markdown with metadata table", () => {
    const items = [
      { step: 1, text: "First step", completed: false },
      { step: 2, text: "Second step", completed: false },
    ];
    const md = generatePlanMarkdown(items, {
      sessionId: "test-session-001",
      cwd: "/tmp/project",
      createdAt: "2025-06-02T10:00:00",
      updatedAt: "2025-06-02T11:00:00",
    });
    assert.match(md, /# 执行计划/);
    assert.match(md, /\| Session \| `test-session-001` \|/);
    assert.match(md, /\| 工作目录 \| `\/tmp\/project` \|/);
    assert.match(md, /\| 创建时间 \| 2025-06-02T10:00:00 \|/);
    assert.match(md, /\| 更新时间 \| 2025-06-02T11:00:00 \|/);
    assert.match(md, /\*\*0\/2\*\*/);
  });

  it("renders progress bar and step checkboxes", () => {
    const items = [
      { step: 1, text: "Done step", completed: true },
      { step: 2, text: "Pending step", completed: false },
      { step: 3, text: "Skipped step", completed: true, skipped: true },
    ];
    const md = generatePlanMarkdown(items, {
      sessionId: "test-002",
    });
    assert.match(md, /## 进度/);
    assert.match(md, /█.*░/);
    assert.match(md, /\- \[x\] \*\*1\.\*\* ✅ Done step/);
    assert.match(md, /\- \[ \] \*\*2\.\*\* Pending step/);
    assert.match(md, /\- \[x\] \*\*3\.\*\* ⏭️ ~~Skipped step~~ \(已跳过\)/);
  });

  it("includes pending count in status", () => {
    const items = [
      { step: 1, text: "A", completed: true },
      { step: 2, text: "B", completed: false },
      { step: 3, text: "C", completed: false },
    ];
    const md = generatePlanMarkdown(items, { sessionId: "x" });
    assert.match(md, /\*\*1\/3\*\* 完成/);
    assert.match(md, /2 待执行/);
  });
});

describe("isAmbiguousStep", () => {
  it("returns true for steps with [?] marker", () => {
    assert.equal(isAmbiguousStep("实现认证 [?] JWT | Session"), true);
    assert.equal(isAmbiguousStep("选择ORM [?] Prisma / TypeORM"), true);
    assert.equal(isAmbiguousStep("添加缓存 [?] Redis，Memcached"), true);
  });

  it("returns false for steps without [?] marker", () => {
    assert.equal(isAmbiguousStep("添加参数验证"), false);
    assert.equal(isAmbiguousStep("[src/auth.ts] 实现登录"), false);
    assert.equal(isAmbiguousStep("1. [file.ts] 普通步骤"), false);
  });
});

describe("parseAmbiguousSteps", () => {
  it("parses pipe-separated options", () => {
    const items = [
      { step: 1, text: "实现认证 [?] JWT | Session | OAuth", completed: false },
    ];
    const ambiguous = parseAmbiguousSteps(items);
    assert.equal(ambiguous.length, 1);
    assert.equal(ambiguous[0].step, 1);
    assert.equal(ambiguous[0].description, "实现认证");
    assert.deepEqual(ambiguous[0].options, ["JWT", "Session", "OAuth"]);
  });

  it("parses slash-separated options", () => {
    const items = [
      { step: 2, text: "选择ORM [?] Prisma / TypeORM / Drizzle", completed: false },
    ];
    const ambiguous = parseAmbiguousSteps(items);
    assert.equal(ambiguous.length, 1);
    assert.deepEqual(ambiguous[0].options, ["Prisma", "TypeORM", "Drizzle"]);
  });

  it("parses comma-separated options", () => {
    const items = [
      { step: 3, text: "选择缓存 [?] Redis，Memcached，本地LRU", completed: false },
    ];
    const ambiguous = parseAmbiguousSteps(items);
    assert.equal(ambiguous.length, 1);
    assert.deepEqual(ambiguous[0].options, ["Redis", "Memcached", "本地LRU"]);
  });

  it("skips steps without ambiguity marker", () => {
    const items = [
      { step: 1, text: "清晰的步骤描述", completed: false },
      { step: 2, text: "实现认证 [?] JWT | Session", completed: false },
    ];
    const ambiguous = parseAmbiguousSteps(items);
    assert.equal(ambiguous.length, 1);
    assert.equal(ambiguous[0].step, 2);
  });

  it("skips steps with less than 2 options", () => {
    const items = [
      { step: 1, text: "只有一个选项 [?] JWT", completed: false },
    ];
    const ambiguous = parseAmbiguousSteps(items);
    assert.equal(ambiguous.length, 0);
  });

  it("handles multiple ambiguous steps", () => {
    const items = [
      { step: 1, text: "认证 [?] JWT | Session", completed: false },
      { step: 2, text: "正常步骤", completed: false },
      { step: 3, text: "ORM [?] Prisma | TypeORM", completed: false },
    ];
    const ambiguous = parseAmbiguousSteps(items);
    assert.equal(ambiguous.length, 2);
    assert.equal(ambiguous[0].step, 1);
    assert.equal(ambiguous[1].step, 3);
  });
});

describe("buildResolvedText", () => {
  it("combines single option", () => {
    const result = buildResolvedText("实现认证", ["JWT"]);
    assert.equal(result, "实现认证：JWT");
  });

  it("combines multiple options with +", () => {
    const result = buildResolvedText("实现认证", ["JWT", "Session"]);
    assert.equal(result, "实现认证：JWT + Session");
  });

  it("handles three options", () => {
    const result = buildResolvedText("选择方案", ["A", "B", "C"]);
    assert.equal(result, "选择方案：A + B + C");
  });
});
