import * as path from "node:path";
import { canonicalJson, normalizePathScope, sha256 } from "../../plan-mode/src/canonical.ts";
import { MISSION_SCHEMA, type AcceptanceCriterion, type MissionDraft, type MissionSpec } from "./domain.ts";

export { canonicalJson, normalizePathScope, sha256 } from "../../plan-mode/src/canonical.ts";

export function calculateMissionHash(spec: Omit<MissionSpec, "contentHash"> | MissionSpec): string {
	const { contentHash: _ignored, ...hashable } = spec as MissionSpec;
	return sha256(canonicalJson(hashable));
}

function normalizeStrings(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function normalizeDraft(draft: MissionDraft): MissionDraft {
	const criteria = draft.acceptance.map((criterion) => ({
		id: criterion.id.trim(),
		title: criterion.title.trim(),
		verify: criterion.verify.trim(),
		...(criterion.required === undefined ? {} : { required: criterion.required }),
	}));
	const ids = new Set<string>();
	for (const criterion of criteria) {
		if (!criterion.id) throw new TypeError("Acceptance criterion id must not be empty");
		if (ids.has(criterion.id)) throw new TypeError(`Duplicate acceptance criterion id: ${criterion.id}`);
		ids.add(criterion.id);
		if (!criterion.title) throw new TypeError(`Acceptance criterion ${criterion.id} needs a title`);
		if (!criterion.verify) throw new TypeError(`Acceptance criterion ${criterion.id} needs a verify command/check`);
	}
	return {
		goal: draft.goal.trim(),
		facts: normalizeStrings(draft.facts),
		assumptions: normalizeStrings(draft.assumptions),
		acceptance: criteria,
		pathScopes: normalizeStrings(draft.pathScopes).map(normalizePathScope),
		dependencyScopes: normalizeStrings(draft.dependencyScopes).map(normalizePathScope),
		risks: normalizeStrings(draft.risks),
	};
}

export function validateMissionSpec(spec: MissionSpec): string[] {
	const errors: string[] = [];
	if (spec.schema !== MISSION_SCHEMA) errors.push(`Unsupported schema: ${String(spec.schema)}`);
	if (!/^[0-9a-f-]{16,}$/i.test(spec.missionId)) errors.push("missionId must be an opaque UUID-like identifier");
	if (!Number.isInteger(spec.version) || spec.version < 1) errors.push("version must be a positive integer");
	if (spec.parentVersion !== null && (!Number.isInteger(spec.parentVersion) || spec.parentVersion >= spec.version)) {
		errors.push("parentVersion must be null or lower than version");
	}
	if (!spec.goal.trim()) errors.push("goal is required");
	if (spec.goal.length > 16_384) errors.push("goal exceeds 16384 characters");
	if (!path.isAbsolute(spec.scope.cwd)) errors.push("scope.cwd must be absolute");
	if (spec.acceptance.length === 0) errors.push("at least one acceptance criterion is required");
	if (spec.acceptance.length > 64) errors.push("acceptance criteria exceed the limit of 64");
	const ids = new Set<string>();
	for (const [index, criterion] of spec.acceptance.entries()) {
		if (!criterion.id) errors.push(`acceptance[${index}].id is required`);
		if (ids.has(criterion.id)) errors.push(`duplicate acceptance criterion id: ${criterion.id}`);
		ids.add(criterion.id);
		if (criterion.id.length > 64) errors.push(`acceptance[${index}].id exceeds 64 characters`);
		if (!criterion.title.trim()) errors.push(`acceptance[${index}].title is required`);
		if (criterion.title.length > 4096) errors.push(`acceptance[${index}].title exceeds 4096 characters`);
		if (!criterion.verify.trim()) errors.push(`acceptance[${index}].verify is required`);
		if (criterion.verify.length > 4096) errors.push(`acceptance[${index}].verify exceeds 4096 characters`);
		if (criterion.required !== undefined && typeof criterion.required !== "boolean") {
			errors.push(`acceptance[${index}].required must be boolean`);
		}
	}
	if (spec.facts.length > 256 || spec.assumptions.length > 256 || spec.risks.length > 256) {
		errors.push("facts, assumptions or risks exceed the limit of 256 entries");
	}
	if (spec.pathScopes.length > 128) errors.push("pathScopes exceed the limit of 128");
	if (spec.dependencyScopes.length > 128) errors.push("dependencyScopes exceed the limit of 128");
	for (const [kind, scopes] of [
		["dependency", spec.dependencyScopes],
		["mutation", spec.pathScopes],
	] as const) {
		for (const scope of scopes) {
			try {
				if (normalizePathScope(scope) !== scope) errors.push(`${kind} scope is not canonical: ${scope}`);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
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
		const expected = calculateMissionHash(spec);
		if (spec.contentHash !== expected) errors.push("contentHash does not match canonical MissionSpec content");
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	return errors;
}

export function requiredAcceptance(spec: MissionSpec): AcceptanceCriterion[] {
	return spec.acceptance.filter((criterion) => criterion.required !== false);
}
