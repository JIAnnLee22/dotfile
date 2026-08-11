import { createHash } from "node:crypto";
import * as path from "node:path";
import {
	PLAN_SCHEMA,
	type Capability,
	type PlanDraft,
	type PlanRef,
	type PlanSpec,
	samePlanRef,
} from "./domain.ts";

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

export function calculatePlanHash(spec: Omit<PlanSpec, "contentHash"> | PlanSpec): string {
	const { contentHash: _ignored, ...hashable } = spec as PlanSpec;
	return sha256(canonicalJson(hashable));
}

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

function normalizeStrings(values: readonly string[] | undefined): string[] {
	return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function normalizeCapabilities(values: readonly Capability[]): Capability[] {
	return [...new Set(values)];
}

export function normalizeDraft(draft: PlanDraft): PlanDraft {
	return {
		goal: draft.goal.trim(),
		facts: normalizeStrings(draft.facts),
		assumptions: normalizeStrings(draft.assumptions),
		steps: draft.steps.map((step) => ({
			id: step.id.trim(),
			title: step.title.trim(),
			purpose: step.purpose.trim(),
			actions: normalizeStrings(step.actions),
			dependencyScopes: [...new Set((step.dependencyScopes ?? []).map(normalizePathScope))],
			pathScopes: [...new Set(step.pathScopes.map(normalizePathScope))],
			requiredCapabilities: normalizeCapabilities(step.requiredCapabilities),
			acceptance: normalizeStrings(step.acceptance),
			rollback: normalizeStrings(step.rollback),
		})),
		risks: normalizeStrings(draft.risks),
	};
}

export function validatePlanSpec(spec: PlanSpec): string[] {
	const errors: string[] = [];
	if (spec.schema !== PLAN_SCHEMA) errors.push(`Unsupported schema: ${String(spec.schema)}`);
	if (!/^[0-9a-f-]{16,}$/i.test(spec.planId)) errors.push("planId must be an opaque UUID-like identifier");
	if (!Number.isInteger(spec.version) || spec.version < 1) errors.push("version must be a positive integer");
	if (spec.parentVersion !== null && (!Number.isInteger(spec.parentVersion) || spec.parentVersion >= spec.version)) {
		errors.push("parentVersion must be null or lower than version");
	}
	if (!spec.goal.trim()) errors.push("goal is required");
	if (spec.goal.length > 16_384) errors.push("goal exceeds 16384 characters");
	if (!path.isAbsolute(spec.scope.cwd)) errors.push("scope.cwd must be absolute");
	if (spec.steps.length === 0) errors.push("at least one step is required");
	if (spec.steps.length > 128) errors.push("steps exceed the limit of 128");
	if (spec.facts.length > 256 || spec.assumptions.length > 256 || spec.risks.length > 256) {
		errors.push("facts, assumptions or risks exceed the limit of 256 entries");
	}
	const ids = new Set<string>();
	for (const [index, step] of spec.steps.entries()) {
		if (!step.id) errors.push(`steps[${index}].id is required`);
		if (ids.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
		ids.add(step.id);
		if (!step.title) errors.push(`steps[${index}].title is required`);
		if (!step.purpose) errors.push(`steps[${index}].purpose is required`);
		if (step.actions.length === 0) errors.push(`steps[${index}].actions must not be empty`);
		if (step.acceptance.length === 0) errors.push(`steps[${index}].acceptance must not be empty`);
		for (const capability of step.requiredCapabilities) {
			if (capability !== "fs.read" && capability !== "fs.write" && capability !== "process.exec") {
				errors.push(`steps[${index}] contains unsupported capability: ${String(capability)}`);
			}
		}
		if (step.requiredCapabilities.includes("fs.write") && step.pathScopes.length === 0) {
			errors.push(`steps[${index}] requests fs.write without pathScopes`);
		}
		if (step.pathScopes.length > 128) errors.push(`steps[${index}] exceeds 128 pathScopes`);
		if ((step.dependencyScopes?.length ?? 0) > 128) errors.push(`steps[${index}] exceeds 128 dependencyScopes`);
		if (step.actions.length > 256 || step.acceptance.length > 256 || step.rollback.length > 256) {
			errors.push(`steps[${index}] actions, acceptance or rollback exceed 256 entries`);
		}
		for (const [kind, scopes] of [
			["dependency", step.dependencyScopes ?? []],
			["mutation", step.pathScopes],
		] as const) {
			for (const scope of scopes) {
				try {
					if (normalizePathScope(scope) !== scope) errors.push(`steps[${index}] ${kind} scope is not canonical: ${scope}`);
				} catch (error) {
					errors.push(error instanceof Error ? error.message : String(error));
				}
			}
		}
	}
	if (spec.workspaceSnapshot) {
		const snapshot = spec.workspaceSnapshot;
		if (snapshot.schema !== "dev.pi.workspace-snapshot/v1") errors.push("unsupported workspace snapshot schema");
		if (!Number.isFinite(Date.parse(snapshot.capturedAt))) errors.push("workspace snapshot capturedAt is invalid");
		if (snapshot.scopes.length > 64) errors.push("workspace snapshot exceeds 64 scopes");
		if (snapshot.entries.length > 2_000) errors.push("workspace snapshot exceeds 2000 entries");
		if (!Number.isSafeInteger(snapshot.totalBytes) || snapshot.totalBytes < 0 || snapshot.totalBytes > 32 * 1024 * 1024) {
			errors.push("workspace snapshot totalBytes is invalid");
		}
		for (const scope of snapshot.scopes) {
			try {
				if (normalizePathScope(scope) !== scope) errors.push(`workspace dependency scope is not canonical: ${scope}`);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		const paths = snapshot.entries.map((entry) => entry.path);
		if (new Set(paths).size !== paths.length || canonicalJson(paths) !== canonicalJson([...paths].sort())) {
			errors.push("workspace snapshot entries must have unique sorted paths");
		}
		const expectedSnapshotDigest = sha256(
			canonicalJson({
				schema: snapshot.schema,
				scopes: snapshot.scopes,
				entries: snapshot.entries,
				totalBytes: snapshot.totalBytes,
			}),
		);
		if (snapshot.digest !== expectedSnapshotDigest) errors.push("workspace snapshot digest mismatch");
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
