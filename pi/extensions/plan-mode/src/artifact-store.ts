import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { calculatePlanHash, canonicalJson, sha256, validatePlanSpec } from "./canonical.ts";
import type { PlanRef, PlanSpec } from "./domain.ts";
import { samePlanRef } from "./domain.ts";
import {
	calculateLegacyPlanHash,
	isLegacyPlanSpec,
	legacyPlanRef,
	validateLegacyPlanSpec,
	type LegacyPlanSpec,
} from "./legacy-v1.ts";

const SAFE_ID = /^[0-9a-f-]{16,}$/i;

export interface ArtifactPaths {
	readonly directory: string;
	readonly spec: string;
	readonly review: string;
}

export type StoredPlanSpec = PlanSpec | LegacyPlanSpec;

export class ArtifactStoreError extends Error {
	readonly causeValue?: unknown;

	constructor(message: string, causeValue?: unknown) {
		super(message);
		this.name = "ArtifactStoreError";
		this.causeValue = causeValue;
	}
}

function markdownList(values: readonly string[], empty = "- 无"): string {
	return values.length ? values.map((value) => `- ${value}`).join("\n") : empty;
}

export function renderPlanMarkdown(spec: PlanSpec): string {
	const steps = spec.steps
		.map(
			(step) => `### ${step.id}：${step.title}

#### 操作
${markdownList(step.actions)}

#### 涉及文件
${markdownList(step.files, "- （未指定）")}

#### 验证
${markdownList(step.validation, "- （由实施者按实际情况验证）")}`,
		)
		.join("\n\n");
	return `# Plan: ${spec.goal}

> PlanRef: \`${spec.planId}@${spec.version}:${spec.contentHash}\`
> Schema: \`${spec.schema}\`
> Security: planning is \`agent-tools-only\`; implementation restores normal Pi permissions.
> This Markdown file is a review projection. \`spec.json\` is authoritative.

## 关键决策
${markdownList(spec.decisions)}

## 实施步骤

${steps}

## 风险
${markdownList(spec.risks)}

## 范围

- cwd: \`${spec.scope.cwd}\`
- session: \`${spec.scope.sessionId}\`
- branch: \`${spec.scope.branchLeafId ?? "none"}\`
- importedFrom: \`${spec.importedFrom ? `${spec.importedFrom.planId}@${spec.importedFrom.version}:${spec.importedFrom.contentHash}` : "none"}\`
`;
}

export function renderLegacyPlanMarkdown(spec: LegacyPlanSpec): string {
	const steps = spec.steps
		.map(
			(step) => `### ${step.id}：${step.title}

- 目的：${step.purpose}
- 旧能力字段：${step.requiredCapabilities.join(", ") || "none"}
- 旧依赖范围：${step.dependencyScopes?.join(", ") || "none"}
- 旧变更范围：${step.pathScopes.join(", ") || "none"}

#### 操作
${markdownList(step.actions)}

#### 验收
${markdownList(step.acceptance)}`,
		)
		.join("\n\n");
	return `# Legacy Plan (view only): ${spec.goal}

> PlanRef: \`${spec.planId}@${spec.version}:${spec.contentHash}\`
> Schema: \`${spec.schema}\`
> This v1 artifact is immutable and cannot resume directly. Migrate to v2 and confirm again.

## 已知事实
${markdownList(spec.facts)}

## 假设
${markdownList(spec.assumptions)}

## 步骤

${steps}

## 风险
${markdownList(spec.risks)}
`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try {
		await fs.rename(temporary, filePath);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

async function atomicCreateImmutable(filePath: string, content: string): Promise<void> {
	const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try {
		await fs.link(temporary, filePath);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

async function existingContent(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export class PlanArtifactStore {
	readonly root: string;
	readonly projectId: string;

	constructor(root: string, cwd: string) {
		this.root = path.resolve(root);
		this.projectId = sha256(path.resolve(cwd)).slice(0, 20);
	}

	static defaultRoot(): string {
		return path.join(os.homedir(), ".pi", "agent", "plans");
	}

	paths(ref: Pick<PlanRef, "planId" | "version">): ArtifactPaths {
		if (!SAFE_ID.test(ref.planId)) throw new ArtifactStoreError("Unsafe planId");
		if (!Number.isInteger(ref.version) || ref.version < 1) throw new ArtifactStoreError("Unsafe plan version");
		const directory = path.join(this.root, this.projectId, ref.planId, `v${String(ref.version).padStart(4, "0")}`);
		return { directory, spec: path.join(directory, "spec.json"), review: path.join(directory, "review.md") };
	}

	async nextAvailableVersion(planId: string, suggestedVersion: number): Promise<number> {
		let version = suggestedVersion;
		while (true) {
			try {
				await fs.access(this.paths({ planId, version }).spec);
				version++;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return version;
				throw new ArtifactStoreError("Failed to inspect existing plan versions", error);
			}
		}
	}

	async save(spec: PlanSpec): Promise<ArtifactPaths> {
		const errors = validatePlanSpec(spec);
		if (errors.length) throw new ArtifactStoreError(`Invalid PlanSpec v2: ${errors.join("; ")}`);
		const paths = this.paths(spec);
		try {
			await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
			const canonicalRoot = await fs.realpath(this.root);
			const canonicalDirectory = await fs.realpath(paths.directory);
			const relative = path.relative(canonicalRoot, canonicalDirectory);
			if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
				throw new ArtifactStoreError("Artifact path escapes configured root");
			}

			const specContent = `${canonicalJson(spec)}\n`;
			const reviewContent = renderPlanMarkdown(spec);
			const oldSpec = await existingContent(paths.spec);
			if (oldSpec !== undefined && oldSpec !== specContent) {
				throw new ArtifactStoreError("Immutable PlanSpec version already exists with different content");
			}
			if (oldSpec === undefined) {
				try {
					await atomicCreateImmutable(paths.spec, specContent);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const winner = await existingContent(paths.spec);
					if (winner !== specContent) {
						throw new ArtifactStoreError("Concurrent writer committed different immutable PlanSpec content");
					}
				}
			}
			if ((await existingContent(paths.review)) !== reviewContent) await atomicWrite(paths.review, reviewContent);
			return paths;
		} catch (error) {
			if (error instanceof ArtifactStoreError) throw error;
			throw new ArtifactStoreError("Failed to persist PlanSpec atomically", error);
		}
	}

	async listVersions(planId: string): Promise<number[]> {
		if (!SAFE_ID.test(planId)) throw new ArtifactStoreError("Unsafe planId");
		const planDirectory = path.join(this.root, this.projectId, planId);
		try {
			const entries = await fs.readdir(planDirectory, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isDirectory() && /^v\d{4,}$/.test(entry.name))
				.map((entry) => Number(entry.name.slice(1)))
				.filter((version) => Number.isSafeInteger(version) && version > 0)
				.sort((left, right) => left - right);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new ArtifactStoreError("Failed to list PlanSpec versions", error);
		}
	}

	async loadAnyVersion(planId: string, version: number): Promise<StoredPlanSpec> {
		const paths = this.paths({ planId, version });
		try {
			const parsed = JSON.parse(await fs.readFile(paths.spec, "utf8")) as unknown;
			if (isLegacyPlanSpec(parsed)) {
				const errors = validateLegacyPlanSpec(parsed);
				if (errors.length) throw new ArtifactStoreError(`Stored legacy PlanSpec is invalid: ${errors.join("; ")}`);
				if (parsed.planId !== planId || parsed.version !== version || calculateLegacyPlanHash(parsed) !== parsed.contentHash) {
					throw new ArtifactStoreError("Stored legacy PlanSpec identity/hash does not match its path");
				}
				return parsed;
			}
			const v2 = parsed as PlanSpec;
			const errors = validatePlanSpec(v2);
			if (errors.length) throw new ArtifactStoreError(`Stored PlanSpec v2 is invalid: ${errors.join("; ")}`);
			if (v2.planId !== planId || v2.version !== version || calculatePlanHash(v2) !== v2.contentHash) {
				throw new ArtifactStoreError("Stored PlanSpec v2 identity/hash does not match its path");
			}
			return v2;
		} catch (error) {
			if (error instanceof ArtifactStoreError) throw error;
			throw new ArtifactStoreError("Failed to load PlanSpec version", error);
		}
	}

	async loadVersion(planId: string, version: number): Promise<PlanSpec> {
		const spec = await this.loadAnyVersion(planId, version);
		if (isLegacyPlanSpec(spec)) throw new ArtifactStoreError("Requested PlanSpec is legacy v1; migrate before implementation");
		return spec;
	}

	async loadAny(ref: PlanRef): Promise<StoredPlanSpec> {
		const parsed = await this.loadAnyVersion(ref.planId, ref.version);
		const actual = isLegacyPlanSpec(parsed) ? legacyPlanRef(parsed) : parsed;
		if (!samePlanRef(ref, actual)) throw new ArtifactStoreError("Stored PlanSpec does not match requested PlanRef");
		return parsed;
	}

	async load(ref: PlanRef): Promise<PlanSpec> {
		const parsed = await this.loadAny(ref);
		if (isLegacyPlanSpec(parsed)) throw new ArtifactStoreError("Requested PlanSpec is legacy v1; migrate before implementation");
		return parsed;
	}
}
