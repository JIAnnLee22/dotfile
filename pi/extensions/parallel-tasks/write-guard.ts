/// <reference path="../../types.d.ts" />
/**
 * implementer 子任务纵深护栏。真正的隔离边界是独立 git worktree；本扩展再拒绝
 * 明显的越界路径、嵌套解释器、远程/破坏性命令和危险 git 子命令。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WORKTREE = process.env.PI_TASK_WORKTREE || null;

const BLOCKED_COMMANDS = new Set([
	"sudo", "su", "doas", "mkfs", "mkswap", "swapon", "dd", "shutdown", "reboot",
	"poweroff", "halt", "mount", "umount", "chown", "chattr", "setfacl", "crontab",
	"ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "curl", "wget",
	"bash", "sh", "dash", "zsh", "fish", "env", "xargs", "command", "builtin", "nohup",
	"node", "bun", "python", "python3", "perl", "ruby",
]);

const BLOCKED_GIT_SUBCOMMANDS = new Set([
	"push", "fetch", "pull", "clone", "worktree", "clean", "reset", "stash", "commit",
	"rebase", "merge", "cherry-pick", "submodule", "checkout", "switch", "branch", "tag", "remote", "config",
]);

const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
	[/\brm\s+(-[^\s]*r[^\s]*f[^\s]*|[^\s]*rf)\s+(\/|\~|$)/, "rm -rf 根目录或家目录"],
	[/\bchmod\s+-[^\s]*R[^\s]*\s+\//, "chmod -R 绝对路径"],
	[/\bchown\s+-[^\s]*R[^\s]*\s+\//, "chown -R 绝对路径"],
	[/\bdd\s+.*\bof=/i, "dd 写设备"],
	[/:\s*\(\)\s*\{/, "疑似 fork bomb"],
];

function toolPath(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const input = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return null;
}

function nearestExistingRealpath(target: string): string | null {
	let probe = target;
	const suffix: string[] = [];
	while (true) {
		try {
			// lstat sees dangling symlinks; realpath below then rejects them instead of walking past them.
			fs.lstatSync(probe);
			break;
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) return null;
			suffix.unshift(path.basename(probe));
			probe = parent;
		}
	}
	try {
		return path.join(fs.realpathSync.native(probe), ...suffix);
	} catch {
		return null;
	}
}

/** 词法路径和已存在父目录的 realpath 都必须保持在 worktree 内。 */
export function escapesWorktree(candidate: string, worktree: string | null = WORKTREE): boolean {
	if (!worktree) return true;
	let rootReal: string;
	try {
		rootReal = fs.realpathSync.native(worktree);
	} catch {
		return true;
	}
	const lexical = path.resolve(rootReal, candidate.replace(/^~\//, `${process.env.HOME || "/root"}/`));
	const lexicalRel = path.relative(rootReal, lexical);
	if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) return true;
	const realTarget = nearestExistingRealpath(lexical);
	if (!realTarget) return true;
	const realRel = path.relative(rootReal, realTarget);
	return realRel.startsWith("..") || path.isAbsolute(realRel);
}

interface ParsedCommand {
	tokens: string[];
	error?: string;
}

/** 足够保守的单命令 tokenizer；复合 shell 语法一律拒绝。 */
function parseSingleCommand(command: string): ParsedCommand {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escaped) {
			token += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else {
				if (quote === '"' && (ch === "`" || (ch === "$" && command[i + 1] === "("))) {
					return { tokens: [], error: "implementer bash 不允许引号内的命令替换" };
				}
				token += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "`") {
			return { tokens: [], error: "implementer bash 只允许单个命令，不允许复合 shell 或命令替换" };
		}
		if (ch === "$" || ((ch === "<" || ch === ">") && command[i + 1] === "(")) {
			return { tokens: [], error: "implementer bash 不允许变量、命令替换或进程替换" };
		}
		if (/\s/.test(ch)) {
			if (token) tokens.push(token);
			token = "";
		} else {
			token += ch;
		}
	}
	if (quote || escaped) return { tokens: [], error: "命令包含未闭合的引号或转义" };
	if (token) tokens.push(token);
	return { tokens };
}

function redirectTargets(command: string): string[] {
	const targets: string[] = [];
	const re = /[0-2]?>>?\s*("([^"]+)"|'([^']+)'|([^\s;|&]+))/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(command)) !== null) targets.push(match[2] ?? match[3] ?? match[4]);
	return targets;
}

function tokenLooksLikePathEscape(token: string, worktree: string | null): boolean {
	const rawValue = /^[A-Za-z_][A-Za-z0-9_]*=/.test(token) ? token.slice(token.indexOf("=") + 1) : token;
	const cleaned = rawValue.replace(/^[0-2]?>>?/, "").replace(/[,:]$/, "");
	if (!cleaned || cleaned === "/dev/null") return false;
	if (/(^|\/)\.\.(\/|$)/.test(cleaned)) return true;
	if (cleaned.startsWith("/") || cleaned.startsWith("~/")) return escapesWorktree(cleaned, worktree);
	return false;
}

function gitSubcommand(tokens: string[], gitIndex: number): { sub?: string; error?: string } {
	for (let i = gitIndex + 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") return { sub: tokens[i + 1] };
		if (token.startsWith("-")) return { error: `git 子命令前的全局选项 ${token} 在 implementer 中禁用` };
		return { sub: token };
	}
	return {};
}

export function validateBash(command: string, worktree: string | null = WORKTREE): string | null {
	const parsed = parseSingleCommand(command.trim());
	if (parsed.error) return parsed.error;
	const tokens = parsed.tokens;
	if (tokens.length === 0) return "命令为空";

	let first = 0;
	while (first < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[first])) first++;
	if (first >= tokens.length) return "命令只有环境变量赋值";
	const cmd = path.basename(tokens[first]);
	if (BLOCKED_COMMANDS.has(cmd)) return `命令 \`${cmd}\` 会启动嵌套解释器、访问网络、提权或破坏系统`;
	for (const [pattern, reason] of DANGEROUS_PATTERNS) if (pattern.test(command)) return `检测到危险操作：${reason}`;

	if (cmd === "git") {
		const parsedGit = gitSubcommand(tokens, first);
		if (parsedGit.error) return parsedGit.error;
		if (parsedGit.sub && BLOCKED_GIT_SUBCOMMANDS.has(parsedGit.sub)) return `\`git ${parsedGit.sub}\` 在 implementer 子任务中禁用`;
	}

	for (const token of tokens) {
		if (tokenLooksLikePathEscape(token, worktree)) return `命令参数 \`${token}\` 可能越出 worktree`;
	}
	for (const target of redirectTargets(command)) {
		if (escapesWorktree(target, worktree)) return `重定向写入目标 \`${target}\` 越出 worktree`;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "patch") {
			const target = toolPath(event.input);
			if (!target || escapesWorktree(target)) {
				return { block: true, reason: "目标路径缺失或越出隔离 worktree。implementer 只能修改 worktree 内文件。" };
			}
			return undefined;
		}
		if (event.toolName === "bash") {
			const error = validateBash(String(event.input.command ?? ""));
			if (error) return { block: true, reason: `${error}。请把操作保持在隔离 worktree 内。` };
		}
		return undefined;
	});
}
