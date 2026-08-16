import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { calculateMissionHash, canonicalJson, sha256, validateMissionSpec } from "./canonical.ts";
import type { MissionRef, MissionSpec } from "./domain.ts";
import { sameMissionRef } from "./domain.ts";

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

export function renderMissionMarkdown(spec: MissionSpec): string {
	const acceptance = spec.acceptance
		.map((criterion) => `### ${criterion.id}${criterion.required === false ? "（可选）" : ""}：${criterion.title}\n\n- 验证方式：\`${criterion.verify}\``)
		.join("\n\n");
	return `# Autopilot Mission: ${spec.goal}

> MissionRef: \`${spec.missionId}@${spec.version}:${spec.contentHash}\`
> Security: \`agent-tools-only\`
> This Markdown file is a review projection. \`spec.json\` is authoritative.

## 验收标准

${acceptance}

## 已确认事实
${markdownList(spec.facts)}

## 假设
${markdownList(spec.assumptions)}

## 写路径范围（cwd 之外）
${markdownList(spec.pathScopes)}

## 依赖范围
${markdownList(spec.dependencyScopes)}

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

export class MissionArtifactStore {
	readonly root: string;
	readonly projectId: string;

	constructor(root: string, cwd: string) {
		this.root = path.resolve(root);
		this.projectId = sha256(path.resolve(cwd)).slice(0, 20);
	}

	static defaultRoot(): string {
		return path.join(os.homedir(), ".pi", "agent", "missions");
	}

	paths(ref: Pick<MissionRef, "missionId" | "version">): ArtifactPaths {
		if (!SAFE_ID.test(ref.missionId)) throw new ArtifactStoreError("Unsafe missionId");
		if (!Number.isInteger(ref.version) || ref.version < 1) throw new ArtifactStoreError("Unsafe mission version");
		const directory = path.join(this.root, this.projectId, ref.missionId, `v${String(ref.version).padStart(4, "0")}`);
		return { directory, spec: path.join(directory, "spec.json"), review: path.join(directory, "review.md") };
	}

	async nextAvailableVersion(missionId: string, suggestedVersion: number): Promise<number> {
		let version = suggestedVersion;
		while (true) {
			try {
				await fs.access(this.paths({ missionId, version }).spec);
				version++;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return version;
				throw new ArtifactStoreError("Failed to inspect existing mission versions", error);
			}
		}
	}

	async save(spec: MissionSpec): Promise<ArtifactPaths> {
		const errors = validateMissionSpec(spec);
		if (errors.length) throw new ArtifactStoreError(`Invalid MissionSpec: ${errors.join("; ")}`);
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
			const reviewContent = renderMissionMarkdown(spec);
			const oldSpec = await existingContent(paths.spec);
			if (oldSpec !== undefined && oldSpec !== specContent) {
				throw new ArtifactStoreError("Immutable MissionSpec version already exists with different content");
			}
			if (oldSpec === undefined) {
				try {
					await atomicCreateImmutable(paths.spec, specContent);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const winner = await existingContent(paths.spec);
					if (winner !== specContent) {
						throw new ArtifactStoreError("Concurrent writer committed different immutable MissionSpec content");
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
			throw new ArtifactStoreError("Failed to persist MissionSpec atomically", error);
		}
	}

	async loadVersion(missionId: string, version: number): Promise<MissionSpec> {
		const paths = this.paths({ missionId, version });
		try {
			const parsed = JSON.parse(await fs.readFile(paths.spec, "utf8")) as MissionSpec;
			const errors = validateMissionSpec(parsed);
			if (errors.length) throw new ArtifactStoreError(`Stored MissionSpec is invalid: ${errors.join("; ")}`);
			if (parsed.missionId !== missionId || parsed.version !== version) {
				throw new ArtifactStoreError("Stored MissionSpec identity does not match its version path");
			}
			if (calculateMissionHash(parsed) !== parsed.contentHash) throw new ArtifactStoreError("Stored MissionSpec hash mismatch");
			return parsed;
		} catch (error) {
			if (error instanceof ArtifactStoreError) throw error;
			throw new ArtifactStoreError("Failed to load MissionSpec version", error);
		}
	}

	async load(ref: MissionRef): Promise<MissionSpec> {
		const parsed = await this.loadVersion(ref.missionId, ref.version);
		if (!sameMissionRef(ref, parsed)) throw new ArtifactStoreError("Stored MissionSpec does not match requested MissionRef");
		return parsed;
	}
}
