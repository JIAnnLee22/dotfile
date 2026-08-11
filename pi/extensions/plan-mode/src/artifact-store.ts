import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { calculatePlanHash, canonicalJson, sha256, validatePlanSpec } from "./canonical.ts";
import type { PlanRef, PlanSpec } from "./domain.ts";
import { samePlanRef } from "./domain.ts";

const SAFE_ID = /^[0-9a-f-]{16,}$/i;

export interface ArtifactPaths {
	readonly directory: string;
	readonly spec: string;
	readonly review: string;
}

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

- 目的：${step.purpose}
- 能力：${step.requiredCapabilities.join(", ") || "fs.read"}
- 依赖范围：${step.dependencyScopes?.join(", ") || "（未声明依赖）"}
- 变更范围：${step.pathScopes.join(", ") || "（无写路径）"}

#### 操作
${markdownList(step.actions)}

#### 验收
${markdownList(step.acceptance)}

#### 回滚
${markdownList(step.rollback)}`,
		)
		.join("\n\n");
	return `# Plan: ${spec.goal}

> PlanRef: \`${spec.planId}@${spec.version}:${spec.contentHash}\`
> Security: \`agent-tools-only\`
> This Markdown file is a review projection. \`spec.json\` is authoritative.

## 已确认事实
${markdownList(spec.facts)}

## 假设与待确认问题
${markdownList(spec.assumptions)}

## 实施步骤

${steps}

## 风险
${markdownList(spec.risks)}

## 范围

- cwd: \`${spec.scope.cwd}\`
- session: \`${spec.scope.sessionId}\`
- branch: \`${spec.scope.branchLeafId ?? "none"}\`
- policyDigest: \`${spec.policyDigest}\`
- contextDigest: \`${spec.contextDigest}\`
- workspaceDigest: \`${spec.workspaceSnapshot?.digest ?? "not-captured"}\`
- workspaceEntries: ${spec.workspaceSnapshot?.entries.length ?? 0}
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
		// link() fails with EEXIST and cannot overwrite a competing immutable version.
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
		if (errors.length) throw new ArtifactStoreError(`Invalid PlanSpec: ${errors.join("; ")}`);
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
			const oldReview = await existingContent(paths.review);
			if (oldReview !== reviewContent) {
				if (oldReview !== undefined) await fs.rm(paths.review);
				await atomicWrite(paths.review, reviewContent);
			}
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

	async loadVersion(planId: string, version: number): Promise<PlanSpec> {
		const paths = this.paths({ planId, version });
		try {
			const parsed = JSON.parse(await fs.readFile(paths.spec, "utf8")) as PlanSpec;
			const errors = validatePlanSpec(parsed);
			if (errors.length) throw new ArtifactStoreError(`Stored PlanSpec is invalid: ${errors.join("; ")}`);
			if (parsed.planId !== planId || parsed.version !== version) {
				throw new ArtifactStoreError("Stored PlanSpec identity does not match its version path");
			}
			if (calculatePlanHash(parsed) !== parsed.contentHash) throw new ArtifactStoreError("Stored PlanSpec hash mismatch");
			return parsed;
		} catch (error) {
			if (error instanceof ArtifactStoreError) throw error;
			throw new ArtifactStoreError("Failed to load PlanSpec version", error);
		}
	}

	async load(ref: PlanRef): Promise<PlanSpec> {
		const parsed = await this.loadVersion(ref.planId, ref.version);
		if (!samePlanRef(ref, parsed)) throw new ArtifactStoreError("Stored PlanSpec does not match requested PlanRef");
		return parsed;
	}
}
