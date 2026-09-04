import { createHash } from "node:crypto";
import * as path from "node:path";
import { PLAN_SCHEMA, type PlanDraft, type PlanRef, type PlanSpec, type PlanStepSpec, samePlanRef } from "./domain.ts";

function canonicalValue(value: unknown, seen: Set<object>): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
		return value;
	}
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
		throw new TypeError(`Canonical JSON rejects ${typeof value}`);
	}
	if (typeof value !== "object") throw new TypeError("Unsupported canonical JSON value");
	if (seen.has(value)) throw new TypeError("Canonical JSON rejects cycles");
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Canonical JSON only accepts plain objects");
		}
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item === undefined) throw new TypeError(`Canonical JSON rejects undefined field: ${key}`);
			output[key] = canonicalValue(item, seen);
		}
		return output;
	} finally {
		seen.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value, new Set()));
}

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function comparePaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Shared path normalizer retained for autopilot and legacy-v1 compatibility. */
export function normalizePathScope(value: string): string {
	const trimmed = value.trim().replaceAll("\\", "/");
	if (!trimmed) throw new TypeError("Path scope must not be empty");
	if (trimmed.length > 1024) throw new TypeError("Path scope exceeds 1024 characters");
	if (trimmed.includes("\0")) throw new TypeError("Path scope contains a NUL byte");
	if (trimmed.startsWith("@") || trimmed === "~" || trimmed.startsWith("~/")) {
		throw new TypeError(`Path scope uses tool-specific expansion syntax: ${value}`);
	}
	if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
		throw new TypeError(`Path scope must be relative: ${value}`);
	}
	const directory = trimmed.endsWith("/");
	const withoutSuffix = directory ? trimmed.slice(0, -1) : trimmed;
	if (!withoutSuffix || withoutSuffix === ".") return directory ? "./" : ".";
	const normalized = path.posix.normalize(withoutSuffix);
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new TypeError(`Path scope escapes cwd: ${value}`);
	}
	if (normalized !== withoutSuffix.replace(/^\.\//, "")) {
		throw new TypeError(`Path scope is not normalized: ${value}`);
	}
	return `${normalized}${directory ? "/" : ""}`;
}

function normalizeStrings(values: readonly string[] | undefined, limit: number, label: string): string[] {
	const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
	if (normalized.length > limit) throw new TypeError(`${label} exceeds ${limit} entries`);
	for (const value of normalized) {
		if (value.length > 4096) throw new TypeError(`${label} entry exceeds 4096 characters`);
	}
	return normalized;
}

function normalizeFiles(values: readonly string[] | undefined): string[] {
	const files = [...new Set((values ?? []).map(normalizePathScope))];
	if (files.length > 128) throw new TypeError("step files exceed 128 entries");
	return files;
}

export function normalizeDraft(draft: PlanDraft): PlanDraft {
	const goal = draft.goal.trim();
	if (!goal) throw new TypeError("Plan goal is required");
	if (goal.length > 16_384) throw new TypeError("Plan goal exceeds 16384 characters");
	if (!Array.isArray(draft.steps) || draft.steps.length === 0) throw new TypeError("At least one plan step is required");
	if (draft.steps.length > 128) throw new TypeError("Plan steps exceed 128 entries");
	return {
		goal,
		decisions: normalizeStrings(draft.decisions, 256, "decisions"),
		steps: draft.steps.map((step, index) => {
			const title = step.title.trim();
			if (!title) throw new TypeError(`steps[${index}].title is required`);
			if (title.length > 1024) throw new TypeError(`steps[${index}].title exceeds 1024 characters`);
			const actions = normalizeStrings(step.actions, 256, `steps[${index}].actions`);
			if (actions.length === 0) throw new TypeError(`steps[${index}].actions must not be empty`);
			return {
				title,
				actions,
				files: normalizeFiles(step.files),
				validation: normalizeStrings(step.validation, 256, `steps[${index}].validation`),
			};
		}),
		risks: normalizeStrings(draft.risks, 256, "risks"),
	};
}

export function materializeSteps(draft: PlanDraft): PlanStepSpec[] {
	return draft.steps.map((step, index) => ({
		id: `S${index + 1}`,
		title: step.title,
		actions: step.actions,
		files: step.files ?? [],
		validation: step.validation ?? [],
	}));
}

export function calculatePlanHash(spec: Omit<PlanSpec, "contentHash"> | PlanSpec): string {
	const { contentHash: _ignored, ...hashable } = spec as PlanSpec;
	return sha256(canonicalJson(hashable));
}

export function validatePlanSpec(spec: PlanSpec): string[] {
	const errors: string[] = [];
	if (spec.schema !== PLAN_SCHEMA) errors.push(`Unsupported schema: ${String(spec.schema)}`);
	if (!/^[0-9a-f-]{16,}$/i.test(spec.planId)) errors.push("planId must be an opaque UUID-like identifier");
	if (!Number.isInteger(spec.version) || spec.version < 1) errors.push("version must be a positive integer");
	if (spec.parentVersion !== null && (!Number.isInteger(spec.parentVersion) || spec.parentVersion >= spec.version)) {
		errors.push("parentVersion must be null or lower than version");
	}
	if (!Number.isFinite(Date.parse(spec.createdAt))) errors.push("createdAt must be an RFC3339 timestamp");
	if (!spec.goal?.trim()) errors.push("goal is required");
	if ((spec.goal?.length ?? 0) > 16_384) errors.push("goal exceeds 16384 characters");
	if (!path.isAbsolute(spec.scope?.cwd ?? "")) errors.push("scope.cwd must be absolute");
	if (!Array.isArray(spec.decisions) || spec.decisions.length > 256) errors.push("decisions must contain at most 256 entries");
	if (!Array.isArray(spec.risks) || spec.risks.length > 256) errors.push("risks must contain at most 256 entries");
	if (!Array.isArray(spec.steps) || spec.steps.length === 0 || spec.steps.length > 128) {
		errors.push("steps must contain between 1 and 128 entries");
	}
	if (spec.importedFrom) {
		if (spec.importedFrom.schema !== "dev.pi.plan/v1") errors.push("importedFrom schema must be dev.pi.plan/v1");
		if (!spec.importedFrom.planId || !Number.isInteger(spec.importedFrom.version) || !spec.importedFrom.contentHash) {
			errors.push("importedFrom must contain a complete legacy PlanRef");
		}
	}
	if (spec.forkedFrom && (!spec.forkedFrom.planId || !Number.isInteger(spec.forkedFrom.version) || !spec.forkedFrom.contentHash)) {
		errors.push("forkedFrom must contain a complete PlanRef");
	}
	if (spec.importedFrom && spec.forkedFrom) errors.push("PlanSpec cannot contain both importedFrom and forkedFrom");
	const ids = new Set<string>();
	for (const [index, step] of (spec.steps ?? []).entries()) {
		if (!/^S[1-9]\d*$/.test(step.id)) errors.push(`steps[${index}].id must be generated as S<n>`);
		if (ids.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
		ids.add(step.id);
		if (!step.title?.trim()) errors.push(`steps[${index}].title is required`);
		if (!Array.isArray(step.actions) || step.actions.length === 0) errors.push(`steps[${index}].actions must not be empty`);
		if (!Array.isArray(step.files) || step.files.length > 128) errors.push(`steps[${index}].files is invalid`);
		if (!Array.isArray(step.validation) || step.validation.length > 256) errors.push(`steps[${index}].validation is invalid`);
		for (const file of step.files ?? []) {
			try {
				if (normalizePathScope(file) !== file) errors.push(`steps[${index}].file is not canonical: ${file}`);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	try {
		const expected = calculatePlanHash(spec);
		if (spec.contentHash !== expected) errors.push("contentHash does not match canonical PlanSpec content");
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	return errors;
}

export function assertPlanRef(expected: PlanRef | undefined, actual: PlanRef | undefined): asserts expected is PlanRef {
	if (!samePlanRef(expected, actual)) {
		throw new Error(
			`Plan reference mismatch: expected=${expected ? canonicalJson(expected) : "missing"} actual=${actual ? canonicalJson(actual) : "missing"}`,
		);
	}
}
