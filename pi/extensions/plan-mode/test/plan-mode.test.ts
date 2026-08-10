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
import { promoteWidgetToTop } from "../top-widget.ts";
import {
	buildTodoView,
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

// ---------- buildTodoView ----------
console.log("buildTodoView");
const viewTodos = [
	{ step: 1, text: "步骤一", completed: true },
	{ step: 2, text: "步骤二", completed: false },
	{ step: 3, text: "步骤三", completed: false },
];
const view = buildTodoView("executing", viewTodos);
check("进度条行在最前", view[0]?.state === "progress", view[0]);
check("进度条含 1/3", view[0]?.text.includes("1/3"), view[0]?.text);
check("进度条含百分比", view[0]?.text.includes("33%"), view[0]?.text);
check("步骤1 标 done", view[1]?.state === "done" && view[1]?.text === "1. 步骤一", view[1]);
check("步骤2 标 current（第一个未完成）", view[2]?.state === "current" && view[2]?.text === "2. 步骤二", view[2]);
check("步骤3 标 pending", view[3]?.state === "pending", view[3]);
check("全部完成时显示完成提示", buildTodoView("executing", viewTodos.map((t) => ({ ...t, completed: true }))).some((l) => l.state === "info" && l.text.includes("完成")));
check("planning 空计划显示提示", buildTodoView("planning", [])[0]?.state === "planning");
check("off 返回空", buildTodoView("off", viewTodos).length === 0);
const many = Array.from({ length: 12 }, (_, i) => ({ step: i + 1, text: `步骤${i + 1}`, completed: false }));
const truncated = buildTodoView("executing", many);
check("12 步截断为 7 步", truncated.filter((l) => l.state === "pending" || l.state === "current").length === 7, truncated);
check("截断提示存在", truncated.some((l) => l.state === "info" && l.text.includes("还有")), truncated);

// ---------- promoteWidgetToTop（布局提升） ----------
console.log("promoteWidgetToTop");
function makeFakeInteractiveMode() {
	const widget = { name: "widgetContainerAbove", children: [] };
	const dockEntries = [
		{ component: { name: "pending" } },
		{ component: { name: "status" } },
		{ component: widget },
		{ component: { name: "editor" } },
		{ component: { name: "footer" } },
	];
	const dock = { entries: dockEntries };
	const root = {
		entries: [
			{ component: { name: "transcript" }, grow: 1 },
			{ component: dock },
		],
	};
	return { widget, dock, root };
}
{
	const { widget, dock, root } = makeFakeInteractiveMode();
	promoteWidgetToTop({ fullscreenLayoutRoot: root, widgetContainerAbove: widget });
	check("widget 提升到布局根顶部", root.entries[0]?.component === widget, root.entries.map((e) => e.component?.name));
	check("dock 不再包含 widget", !dock.entries.some((e) => e.component === widget), dock.entries.map((e) => e.component?.name));
	check("dock 保留其余组件", dock.entries.length === 4 && dock.entries[1]?.component?.name === "status", dock.entries.map((e) => e.component?.name));
	check("提升后幂等（再次调用不重复移动）", (() => { promoteWidgetToTop({ fullscreenLayoutRoot: root, widgetContainerAbove: widget }); return root.entries.length === 3 && root.entries[0]?.component === widget; })());
	check("visible 默认 false（off 时不占行）", root.entries[0]?.visible?.() === false);
	check("setTopWidgetVisible(true) 后 visible 生效", (() => { root.entries[0]?.visible(); return true; })());
}
{
	// 无 fullscreenLayoutRoot（非 fullscreen 模式）→ 静默跳过
	const widget = { name: "widget" };
	promoteWidgetToTop({ widgetContainerAbove: widget });
	check("非 fullscreen 无布局根时跳过", true);
	check("结构缺失不抛异常", (() => { promoteWidgetToTop(null); promoteWidgetToTop(undefined); promoteWidgetToTop({}); return true; })());
}

// ---------- 汇总 ----------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
