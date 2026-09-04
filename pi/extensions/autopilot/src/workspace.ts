import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalJson, comparePaths, normalizePathScope, sha256 } from "./canonical.ts";
import type { MissionDraft, MissionSpec, WorkspaceSnapshot, WorkspaceSnapshotEntry } from "./domain.ts";

export interface WorkspaceSnapshotLimits {
	readonly maxScopes: number;
	readonly maxEntries: number;
	readonly maxDepth: number;
	readonly maxFileBytes: number;
	readonly maxTotalBytes: number;
	readonly timeoutMs: number;
}

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceSnapshotLimits = {
	maxScopes: 64,
	maxEntries: 2_000,
	maxDepth: 32,
	maxFileBytes: 8 * 1024 * 1024,
	maxTotalBytes: 32 * 1024 * 1024,
	timeoutMs: 2_000,
};

export class WorkspaceSnapshotError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceSnapshotError";
	}
}

export function dependencyScopes(value: MissionDraft | MissionSpec): string[] {
	return [...(value.dependencyScopes ?? [])];
}

function normalizeScopes(values: readonly string[], limits: WorkspaceSnapshotLimits): string[] {
	const unique = [...new Set(values.map(normalizePathScope))].sort();
	if (unique.length > limits.maxScopes) throw new WorkspaceSnapshotError(`Dependency scopes exceed ${limits.maxScopes}`);
	return unique.filter((scope, index) => {
		for (let candidateIndex = 0; candidateIndex < unique.length; candidateIndex++) {
			if (candidateIndex === index) continue;
			const candidate = unique[candidateIndex];
			if (candidate.endsWith("/") && scope !== candidate && (candidate === "./" || scope.startsWith(candidate))) return false;
		}
		return true;
	});
}

function relativePath(root: string, target: string): string {
	const relative = path.relative(root, target);
	if (relative === "") return ".";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new WorkspaceSnapshotError(`Dependency path escapes workspace: ${target}`);
	}
	return relative.split(path.sep).join("/");
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
	const relative = relativePath(root, target);
	if (relative === ".") return;
	let cursor = root;
	for (const segment of relative.split("/")) {
		cursor = path.join(cursor, segment);
		try {
			const stat = await fs.lstat(cursor);
			if (stat.isSymbolicLink()) throw new WorkspaceSnapshotError(`Dependency scope crosses a symlink: ${relativePath(root, cursor)}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

export async function captureWorkspaceSnapshot(
	cwd: string,
	rawScopes: readonly string[],
	options: Partial<WorkspaceSnapshotLimits> = {},
	now = () => new Date().toISOString(),
): Promise<WorkspaceSnapshot> {
	const limits = { ...DEFAULT_WORKSPACE_LIMITS, ...options };
	const scopes = normalizeScopes(rawScopes, limits);
	const root = await fs.realpath(path.resolve(cwd));
	const started = Date.now();
	const entries = new Map<string, WorkspaceSnapshotEntry>();
	let totalBytes = 0;

	const checkBudget = (depth: number): void => {
		if (Date.now() - started > limits.timeoutMs) throw new WorkspaceSnapshotError(`Workspace snapshot exceeded ${limits.timeoutMs}ms`);
		if (depth > limits.maxDepth) throw new WorkspaceSnapshotError(`Workspace snapshot exceeded depth ${limits.maxDepth}`);
		if (entries.size >= limits.maxEntries) throw new WorkspaceSnapshotError(`Workspace snapshot exceeded ${limits.maxEntries} entries`);
	};

	const scan = async (absolute: string, mode: "directory" | "exact" | "descendant", depth: number): Promise<void> => {
		checkBudget(depth);
		const relative = relativePath(root, absolute);
		let stat;
		try {
			stat = await fs.lstat(absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				entries.set(relative, { path: relative, kind: "missing" });
				return;
			}
			throw new WorkspaceSnapshotError(`Cannot inspect dependency '${relative}': ${error instanceof Error ? error.message : String(error)}`);
		}
		if (stat.isSymbolicLink()) throw new WorkspaceSnapshotError(`Dependency scope contains symlink '${relative}'`);
		if (stat.isFile()) {
			if (mode === "directory") throw new WorkspaceSnapshotError(`Directory dependency scope resolves to file '${relative}'`);
			if (stat.size > limits.maxFileBytes) throw new WorkspaceSnapshotError(`Dependency file '${relative}' exceeds ${limits.maxFileBytes} bytes`);
			if (totalBytes + stat.size > limits.maxTotalBytes) {
				throw new WorkspaceSnapshotError(`Workspace snapshot exceeds ${limits.maxTotalBytes} total bytes`);
			}
			let handle;
			try {
				handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				const opened = await handle.stat();
				if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
					throw new WorkspaceSnapshotError(`Dependency file identity changed before open '${relative}'`);
				}
				const hash = createHash("sha256");
				let fileBytes = 0;
				while (true) {
					checkBudget(depth);
					const buffer = Buffer.allocUnsafe(64 * 1024);
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
					if (bytesRead === 0) break;
					fileBytes += bytesRead;
					if (fileBytes > limits.maxFileBytes) {
						throw new WorkspaceSnapshotError(`Dependency file '${relative}' exceeds ${limits.maxFileBytes} bytes while reading`);
					}
					if (totalBytes + fileBytes > limits.maxTotalBytes) {
						throw new WorkspaceSnapshotError(`Workspace snapshot exceeds ${limits.maxTotalBytes} total bytes while reading`);
					}
					hash.update(buffer.subarray(0, bytesRead));
				}
				checkBudget(depth);
				const after = await handle.stat();
				if (
					!after.isFile() ||
					after.dev !== opened.dev ||
					after.ino !== opened.ino ||
					after.size !== opened.size ||
					after.mtimeMs !== opened.mtimeMs ||
					fileBytes !== opened.size
				) {
					throw new WorkspaceSnapshotError(`Dependency file changed during snapshot '${relative}'`);
				}
				totalBytes += fileBytes;
				entries.set(relative, { path: relative, kind: "file", size: fileBytes, contentHash: hash.digest("hex") });
				return;
			} catch (error) {
				if (error instanceof WorkspaceSnapshotError) throw error;
				throw new WorkspaceSnapshotError(`Cannot safely read dependency '${relative}': ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				await handle?.close();
			}
		}
		if (!stat.isDirectory()) throw new WorkspaceSnapshotError(`Dependency scope is a special file '${relative}'`);
		if (mode === "exact" && relative !== ".") {
			throw new WorkspaceSnapshotError(`Directory dependency scope must end in '/': ${relative}`);
		}
		entries.set(relative, { path: relative, kind: "directory" });
		const before = (await fs.readdir(absolute)).sort();
		checkBudget(depth);
		if (entries.size + before.length > limits.maxEntries) {
			throw new WorkspaceSnapshotError(`Workspace snapshot exceeded ${limits.maxEntries} entries`);
		}
		for (const name of before) await scan(path.join(absolute, name), "descendant", depth + 1);
		const after = (await fs.readdir(absolute)).sort();
		checkBudget(depth);
		if (canonicalJson(before) !== canonicalJson(after)) throw new WorkspaceSnapshotError(`Dependency directory changed during snapshot '${relative}'`);
	};

	for (const scope of scopes) {
		const directory = scope.endsWith("/");
		const scopePath = directory ? scope.slice(0, -1) || "." : scope;
		const absolute = path.resolve(root, scopePath);
		relativePath(root, absolute);
		await assertNoSymlinkComponents(root, absolute);
		await scan(absolute, directory ? "directory" : "exact", 0);
	}

	const sortedEntries = [...entries.values()].sort((left, right) => comparePaths(left.path, right.path));
	const hashable = { schema: "dev.pi.workspace-snapshot/v1" as const, scopes, entries: sortedEntries, totalBytes };
	return {
		...hashable,
		capturedAt: now(),
		digest: sha256(canonicalJson(hashable)),
	};
}
