/**
 * 纯函数单元测试 —— 直接用 node 运行（node 24 原生支持 TS type stripping）：
 *
 *   node test/plan-mode.test.ts
 *
 * 覆盖：歧义标记解析、决定格式化、Plan: 提取、[DONE:n] 进度。
 */

import {
	formatResolutionsForAgent,
	hasAmbiguityMarker,
	parseAmbiguityMark,
	stripAmbiguityMarker,
} from "../ambiguity.ts";
import {
	cleanStepText,
	extractDoneSteps,
	extractTodoItems,
	markCompletedSteps,
} from "../plan.ts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}`, detail ?? "");
	}
}

function checkEq<T>(name: string, actual: T, expected: T): void {
	const ok = JSON.stringify(sortKeys(actual)) === JSON.stringify(sortKeys(expected));
	if (ok) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
	}
}

/** 递归按键排序（消除对象属性顺序导致的比较差异） */
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.map(([k, v]) => [k, sortKeys(v)] as const)
				.sort((a, b) => (a[0] < b[0] ? -1 : 1)),
		);
	}
	return value;
}

// ---------- hasAmbiguityMarker ----------
console.log("hasAmbiguityMarker");
check("无标记返回 false", !hasAmbiguityMarker("这是一个正常回复"));
check("<ambiguity> 标签返回 true", hasAmbiguityMarker("先看下代码\n<ambiguity>\n1. 用哪个库？\n</ambiguity>"));
check("AMBIGUITY: 前缀返回 true", hasAmbiguityMarker("AMBIGUITY: 方案未定"));
check("空文本返回 false", !hasAmbiguityMarker(""));

// ---------- parseAmbiguityMark ----------
console.log("parseAmbiguityMark");
const mark = `我先探索了代码库，这里有一个歧义需要你决定：

<ambiguity>
1. 使用哪个数据库？
- PostgreSQL [postgres]: 社区生态好
- SQLite [sqlite]: 零运维
2. 是否需要迁移现有数据？
- 是 / 否
</ambiguity>

其余部分我继续分析。`;
const questions = parseAmbiguityMark(mark);
check("能解析出两个问题", questions !== null && questions.length === 2, questions);
checkEq(
	"问题1 正确解析",
	questions?.[0],
	{ id: "q1", question: "使用哪个数据库？", options: [
		{ value: "postgres", label: "PostgreSQL", description: "社区生态好" },
		{ value: "sqlite", label: "SQLite", description: "零运维" },
	], allowOther: true },
);
checkEq(
	"问题2 正确解析",
	questions?.[1]?.question,
	"是否需要迁移现有数据？",
);
check("问题2 选项数为 2（是/否 拆分）", questions?.[1]?.options.length === 2, questions?.[1]?.options);
checkEq("问题2 选项值", questions?.[1]?.options?.map((o) => o.value), ["是", "否"]);

const am = parseAmbiguityMark("AMBIGUITY: 先决条件不明\n- 方案A [a]\n- 方案B [b]");
check("AMBIGUITY: 前缀段落可解析", am !== null && am.length === 1, am);
check("前缀段落问题文本", am?.[0]?.question === "先决条件不明", am?.[0]?.question);
checkEq("前缀段落选项", am?.[0]?.options?.map((o) => o.value), ["a", "b"]);

check("无标记解析返回 null", parseAmbiguityMark("没有歧义") === null);

// ---------- stripAmbiguityMarker ----------
console.log("stripAmbiguityMarker");
checkEq(
	"剥离标签保留其余文本",
	stripAmbiguityMarker("前言\n<ambiguity>内容</ambiguity>\n后记"),
	"前言\n后记",
);

// ---------- formatResolutionsForAgent ----------
console.log("formatResolutionsForAgent");
const formatted = formatResolutionsForAgent([
	{ id: "q1", question: "使用哪个数据库？", value: "postgres", label: "PostgreSQL" },
	{ id: "q2", question: "是否迁移数据？", value: "", label: "", note: "用户未回答" },
]);
check("包含问题文本", formatted.includes("使用哪个数据库？"), formatted);
check("包含用户选择", formatted.includes('"postgres"'), formatted);
check("包含未回答提示", formatted.includes("用户未回答"), formatted);
check("空列表有兜底文案", formatResolutionsForAgent([]).includes("假设"), formatResolutionsForAgent([]));

// ---------- extractTodoItems / cleanStepText ----------
console.log("plan.ts");
const planMsg = `分析完成，计划如下：

Plan:
1. **Add validation** to the login form
2. \`Refactor\` the API layer
3. Use pytest to write tests
4. Update error messages`;
const todos = extractTodoItems(planMsg);
check("提取 4 个步骤", todos.length === 4, todos);
checkEq("步骤1 清理文本", todos[0]?.text, "Validation to the login form");
checkEq("步骤2 保留 Refactor", todos[1]?.text, "Refactor the API layer");
checkEq("步骤3 清理动词", todos[2]?.text, "Pytest to write tests");
checkEq("步骤编号连续", todos.map((t) => t.step), [1, 2, 3, 4]);
check("无 Plan: 返回空", extractTodoItems("没有计划").length === 0);
checkEq("cleanStepText 去代码", cleanStepText("`Refactor` the API layer"), "Refactor the API layer");
check("cleanStepText 截断长文本", cleanStepText("A".repeat(100)).length <= 50);

// ---------- markCompletedSteps ----------
console.log("markCompletedSteps");
const items = todos.map((t) => ({ ...t, completed: false }));
const done = markCompletedSteps("第一步完成 [DONE:1]，第三步也完成 [DONE:3]", items);
check("检测到 2 个 DONE", done === 2, done);
check("步骤1 完成", items[0]?.completed === true);
check("步骤2 未完成", items[1]?.completed === false);
check("步骤3 完成", items[2]?.completed === true);
checkEq("extractDoneSteps 提取编号", extractDoneSteps("a [DONE:2] b [done:4]"), [2, 4]);

// ---------- 汇总 ----------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
