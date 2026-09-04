/// <reference path="../../types.d.ts" />
/**
 * write-guard - implementer（可写）子任务的护栏
 *
 * 只在 parallel_tasks 派发的 writable 子进程中通过 `-e` 显式加载。
 * 子进程 cwd 是隔离的 git worktree，因此相对路径的文件操作天然落在 worktree 内；
 * 这里拦截明显的越界写入与危险命令，避免误改主仓库或执行破坏性操作。
 *
 * 注意：这不是完整沙箱，无法用字符串匹配穷尽所有 shell 逃逸；隔离的根本保证
 * 是 worktree 目录本身。护栏属于纵深防御，防止意外而非对抗恶意模型。
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WORKTREE = process.env.PI_TASK_WORKTREE || null;

/** 高危命令：系统破坏、远程 git、跨机传输、提权等。 */
const BLOCKED_COMMANDS = new Set([
	"sudo", "su", "doas", "mkfs", "mkswap", "swapon", "dd", "shutdown", "reboot",
	"poweroff", "halt", "mount", "umount", "chown", "chattr", "setfacl", "crontab",
	"ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "curl", "wget",
]);

/** 会改动远程或主仓库的 git 子命令。 */
const BLOCKED_GIT_SUBCOMMANDS = new Set([
	"push", "fetch", "pull", "clone", "worktree", "clean", "reset", "stash",
	"rebase", "merge", "cherry-pick", "submodule",
]);

/** 危险模式：对根目录/家目录的破坏、对设备直接写、fork bomb 等。 */
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
	[/\brm\s+(-[^\s]*r[^\s]*f[^\s]*|[^\s]*rf)\s+(\/|\~|$)/, "rm -rf 根目录或家目录"],
	[/\brm\s+(-[^\s]*r[^\s]*f[^\s]*|[^\s]*rf)\s+\/(?!dev\/null)/, "rm -rf 绝对路径"],
	[/\bchmod\s+-[^\s]*R[^\s]*\s+\//, "chmod -R 绝对路径"],
	[/\bchown\s+-[^\s]*R[^\s]*\s+\//, "chown -R 绝对路径"],
	[/\bdd\s+.*\bof=/i, "dd 写设备"],
	[/:\s*\(\)\s*\{/, "疑似 fork bomb"],
];

/** 解析文件工具调用里的路径参数。 */
function toolPath(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const input = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return null;
}

/** 判断某路径（按 worktree 解析）是否越出 worktree。 */
function escapesWorktree(p: string): boolean {
	if (!WORKTREE) return true;
	const resolved = path.resolve(WORKTREE, p);
	const rel = path.relative(WORKTREE, resolved);
	return rel.startsWith("..") || path.isAbsolute(rel);
}

/** 从 shell 命令中提取形如 `/abs` 或 `~/...` 的绝对路径 token。 */
function absolutePathTokens(command: string): string[] {
	const home = process.env.HOME || "/root";
	const tokens: string[] = [];
	for (const raw of command.split(/\s+/)) {
		let token = raw;
		// 去掉包裹的引号，方便识别路径。
		if (token.length >= 2 && ["'", '"'].includes(token[0]) && token.endsWith(token[0])) {
			token = token.slice(1, -1);
		}
		if (token.startsWith("~/")) {
			tokens.push(path.join(home, token.slice(2)));
		} else if (token.startsWith("/")) {
			tokens.push(token);
		}
	}
	return tokens;
}

/** 提取重定向目标（`>` / `>>` 后的路径），用于拦截越界写入。 */
function redirectTargets(command: string): string[] {
	const targets: string[] = [];
	const re = /(?:^|\s)(?:[0-2]?>>?|>>)\s*("([^"]+)"|'([^']+)'|(\S+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		targets.push(m[2] ?? m[3] ?? m[4]);
	}
	return targets;
}

function validateBash(command: string): string | null {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return "命令为空";

	// 去掉前置环境变量赋值（FOO=bar cmd）。
	let first = 0;
	while (first < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[first])) first++;
	if (first >= tokens.length) return "命令只有环境变量赋值";

	const cmd = tokens[first].replace(/^.*[\\/]/, "");
	if (BLOCKED_COMMANDS.has(cmd)) {
		return `命令 \`${cmd}\` 会访问网络、提权或破坏系统，implementer 子任务禁用`;
	}

	for (const [pattern, reason] of DANGEROUS_PATTERNS) {
		if (pattern.test(command)) return `检测到危险操作：${reason}`;
	}

	if (cmd === "git") {
		const sub = tokens.slice(first).find((t) => !t.startsWith("-"));
		if (sub && BLOCKED_GIT_SUBCOMMANDS.has(sub)) {
			return `\`git ${sub}\` 会改动远程或主仓库，implementer 子任务禁用`;
		}
	}

	// 越界写入检查：绝对路径重定向、以及 rm/mv/cp 等命令对 worktree 外绝对路径的操作。
	for (const target of redirectTargets(command)) {
		if (target.startsWith("/") || target.startsWith("~/")) {
			if (escapesWorktree(target.replace(/^~\//, `${process.env.HOME || "/root"}/`))) {
				return `重定向写入目标 \`${target}\` 越出 worktree`;
			}
		}
	}

	if (["rm", "mv", "cp", "touch", "mkdir", "tee", "install", "ln", "sed", "tar", "unzip"].includes(cmd)) {
		for (const token of absolutePathTokens(command)) {
			if (escapesWorktree(token)) {
				return `命令 \`${cmd}\` 引用了 worktree 外的绝对路径 \`${token}\``;
			}
		}
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "patch") {
			const p = toolPath(event.input);
			if (p && escapesWorktree(p)) {
				return {
					block: true,
					reason: "目标路径越出隔离 worktree。implementer 子任务只能改动 worktree 内的文件。",
				};
			}
			return undefined;
		}

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			const error = validateBash(command);
			if (error) {
				return {
					block: true,
					reason: `${error}。implementer 子任务在隔离 worktree 中运行，请把改动保持在 worktree 内。`,
				};
			}
		}

		return undefined;
	});
}
