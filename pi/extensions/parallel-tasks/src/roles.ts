/// <reference path="../../types.d.ts" />
/**
 * roles - parallel_tasks 子任务角色的加载与只读/可写判定。
 *
 * 角色定义在 `roles/*.md` 的 frontmatter 中；声明了 `write`/`edit` 工具的角色是可写角色，
 * 在隔离的 git worktree 中运行，其余角色保持只读。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 轻量 frontmatter 解析：角色定义使用简单的 `key: value` 单行字段
 * （name/description/tools/model），无需引入 pi 运行时依赖，便于独立测试。
 */
function parseFrontmatterSimple(content: string): { frontmatter: Record<string, string>; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key) frontmatter[key] = value;
	}
	return { frontmatter, body: match[2] };
}

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
export const WRITABLE_TOOLS = ["write", "edit"] as const;
export const ALLOWED_TOOLS: string[] = [...READ_ONLY_TOOLS, ...WRITABLE_TOOLS];
/** Writable children deliberately omit bash: worktree isolation is not an OS sandbox. Main session runs validation after applying the reviewed diff. */
export const WRITABLE_ROLE_TOOLS = ["read", "grep", "find", "ls", ...WRITABLE_TOOLS] as const;
export const WRITABLE_SET = new Set<string>(WRITABLE_TOOLS);

/** 扩展自带的角色目录，供调用方（parallel_tasks 工具与 plan-mode 步骤派发）加载标准角色。 */
export const ROLES_DIR = path.resolve(import.meta.dirname, "../roles");

export interface Role {
	name: string;
	description: string;
	tools: string[];
	/** 该角色是否可写文件；可写角色在隔离的 git worktree 中运行。 */
	writable: boolean;
	model?: string;
	systemPrompt: string;
}

export function loadRoles(rolesDir: string): Role[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(rolesDir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}

	const roles: Role[] = [];
	for (const entry of entries) {
		let content: string;
		try {
			content = fs.readFileSync(path.join(rolesDir, entry), "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatterSimple(content);
		if (!frontmatter?.name || !frontmatter?.description) continue;

		const declared = (frontmatter.tools ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		// 声明了 write/edit 的角色是可写角色，在隔离 worktree 中运行；
		// 其余角色保持只读，声明里的写工具一律丢弃。
		const writable = declared.some((t) => WRITABLE_SET.has(t));
		const allowed: readonly string[] = writable ? WRITABLE_ROLE_TOOLS : READ_ONLY_TOOLS;
		const tools = declared.filter((t) => allowed.includes(t));

		roles.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools.length > 0 ? tools : [...READ_ONLY_TOOLS],
			writable,
			model: frontmatter.model,
			systemPrompt: body,
		});
	}
	return roles;
}

/** 只读角色名列表，供规划期 policy 与派发调用方判定安全角色。 */
export function readOnlyRoleNames(roles: Role[]): string[] {
	return roles.filter((role) => !role.writable).map((role) => role.name);
}
