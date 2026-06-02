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
} from "./utils.ts";

describe("splitCommandSegments", () => {
  it("splits pipes and logical operators", () => {
    assert.deepEqual(splitCommandSegments("ls -la | head -5"), ["ls -la", "head -5"]);
    assert.deepEqual(splitCommandSegments("ls && pwd"), ["ls", "pwd"]);
  });
});

describe("hasUnsafeRedirect", () => {
  it("allows stderr suppression", () => {
    assert.equal(hasUnsafeRedirect("ls 2>/dev/null"), false);
    assert.equal(hasUnsafeRedirect("ls 2>&1"), false);
  });

  it("blocks file write redirects", () => {
    assert.equal(hasUnsafeRedirect("echo hi > out.txt"), true);
    assert.equal(hasUnsafeRedirect("echo hi >> out.txt"), true);
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
