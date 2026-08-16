import type { ExecutionState, MissionSpec } from "./domain.ts";

const MAX_AC_TITLE_CODEPOINTS = 48;

export function truncateAcTitle(title: string, limit = MAX_AC_TITLE_CODEPOINTS): string {
	if (limit <= 0) return "";
	const codepoints = Array.from(title.trim());
	if (codepoints.length <= limit) return codepoints.join("");
	if (limit === 1) return "…";
	return `${codepoints.slice(0, limit - 1).join("")}…`;
}

function marker(state: ExecutionState["acResults"][string] | undefined): string {
	if (state?.status === "pass" || state?.status === "ready") return "✓";
	if (state?.status === "fail" || state?.status === "not_ready") return "!";
	if (state?.status === "pending") return "○";
	return "○";
}

/** Single status line for the footer. */
export function buildAutopilotStatusSummary(spec: MissionSpec | undefined, state: ExecutionState): string | undefined {
	if (!spec) return undefined;
	const required = spec.acceptance.filter((criterion) => criterion.required !== false);
	const passed = required.filter((criterion) => state.acResults[criterion.id]?.status === "pass").length;
	const ready = required.filter((criterion) => state.acResults[criterion.id]?.status === "ready").length;
	const failed = required.filter((criterion) => {
		const status = state.acResults[criterion.id]?.status;
		return status === "fail" || status === "not_ready";
	}).length;
	const pending = required.length - passed - ready - failed;
	return `${passed}/${required.length} pass · ${ready} ready · ${failed} fail · ${pending} pending`;
}

/** Compact multi-line AC widget. */
export function buildAcWidgetLines(spec: MissionSpec | undefined, state: ExecutionState, maxVisible = 12): string[] | undefined {
	if (!spec) return undefined;
	const required = spec.acceptance;
	const passed = required.filter((criterion) => state.acResults[criterion.id]?.status === "pass").length;
	const ready = required.filter((criterion) => state.acResults[criterion.id]?.status === "ready").length;
	const pending = required.length - passed - ready;
	const header = `AC — ${passed}/${required.length} passed · ${ready} ready · ${pending} pending`;
	if (required.length === 0) return [header];

	const limit = Math.max(1, Math.floor(maxVisible));
	const failed = required.filter((criterion) => {
		const status = state.acResults[criterion.id]?.status;
		return status === "fail" || status === "not_ready";
	});
	const failedIds = new Set(failed.map((criterion) => criterion.id));
	const failedFirst = [...failed, ...required.filter((criterion) => !failedIds.has(criterion.id))];
	const shown = failedFirst.length <= limit ? failedFirst : [...failed, ...required.filter((criterion) => !failedIds.has(criterion.id))].slice(0, limit);
	const entries: string[] = [];
	for (const criterion of shown) {
		const label = criterion.required === false ? `${criterion.id}*` : criterion.id;
		entries.push(`${marker(state.acResults[criterion.id])} ${label} ${truncateAcTitle(criterion.title)}`);
	}
	if (failedFirst.length > limit) entries.push(`… ${failedFirst.length - limit} more`);
	return [header, ...entries.map((entry, index) => `${index === entries.length - 1 ? "└─" : "├─"} ${entry}`)];
}
