/// <reference path="../../types.d.ts" />
/**
 * readonly-guard - 子任务只读护栏
 *
 * 只在 parallel_tasks 派发的子进程中通过 `-e` 显式加载（文件名不是 index.ts，
 * 不会被父会话自动发现）。
 *
 * 仅靠 `--exclude-tools write,edit` 挡不住 bash：shell 重定向同样可以写文件。
 * 因此这里拦截 write/edit，并对 bash 使用严格的只读命令白名单。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 允许的只读命令。白名单比黑名单可靠得多。 */
const ALLOWED = new Set([
	"ls", "cat", "head", "tail", "wc", "nl", "column", "comm", "seq",
	"grep", "egrep", "fgrep", "rg", "fd", "find", "tree",
	"sort", "uniq", "cut", "tr", "diff", "cmp",
	"echo", "printf", "pwd", "basename", "dirname", "realpath", "readlink",
	"stat", "file", "du", "df", "date", "uname", "whoami", "which", "type",
	"md5sum", "sha256sum", "jq", "git", "npm",
]);

/** 可以执行任意代码或写入文件的命令，明确拒绝并给出更具体的原因。 */
const DENIED = new Set([
	"python", "python2", "python3", "perl", "ruby", "node", "bun", "deno", "php", "awk", "gawk",
	"sh", "bash", "zsh", "fish", "eval", "exec", "source", "command", "xargs",
	"tee", "dd", "truncate", "install", "cp", "mv", "rm", "rmdir", "mkdir", "touch",
	"chmod", "chown", "ln", "patch", "sed", "tar", "unzip", "curl", "wget", "nc", "ssh", "scp",
]);

/** git 只读子命令。 */
const GIT_READONLY = new Set([
	"log", "diff", "status", "show", "branch", "ls-files", "ls-tree", "blame",
	"rev-parse", "describe", "cat-file", "shortlog", "reflog", "grep", "whatchanged",
]);

const NPM_READONLY = new Set(["list", "ls", "view", "info", "outdated", "why"]);

/** find 的这些谓词可以删除文件、执行命令或写入输出文件。 */
const FIND_WRITE_PREDICATES = new Set([
	"-delete", "-exec", "-execdir", "-ok", "-okdir",
	"-fls", "-fprint", "-fprint0", "-fprintf",
]);

/** git 这些选项可能调用外部 diff/textconv 程序。 */
const GIT_EXECUTING_OPTIONS = new Set(["--ext-diff", "--textconv"]);

/**
 * 禁止 shell 控制语法，而不是试图实现一个完整 shell parser。
 * 管道也禁用：各子任务可以发多个简单命令，避免引号和管道解析绕过白名单。
 */
const SHELL_CONTROL = /[\r\n;&|<>`$(){}]/;

function tokensOf(command: string): string[] {
	// 这里只用于识别命令和危险参数，不用于重新执行命令；保守地按空白拆分即可。
	return command.trim().split(/\s+/).filter(Boolean);
}

function findSubcommand(tokens: string[], readOnly: Set<string>, commandName: string): string | null {
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") return null;

		// 常见的全局选项及其参数。
		if (commandName === "git" && ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"].includes(token)) {
			i++;
			continue;
		}
		if (commandName === "npm" && ["-w", "--workspace", "--prefix", "--userconfig", "--registry", "--cache", "--location"].includes(token)) {
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		return readOnly.has(token) ? token : token;
	}
	return null;
}

function checkSegment(command: string): string | null {
	const tokens = tokensOf(command);
	if (tokens.length === 0) return "命令为空";

	// 去掉前置环境变量赋值（FOO=bar cmd），但不允许借此隐藏 shell 语法。
	let first = 0;
	while (first < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[first])) first++;
	if (first >= tokens.length) return "命令只有环境变量赋值，没有可验证的只读命令";

	const cmd = tokens[first].replace(/^.*[\\/]/, "");
	const args = tokens.slice(first + 1);

	if (DENIED.has(cmd)) return `命令 \`${cmd}\` 可执行任意代码或写入文件，子任务为只读模式`;
	if (!ALLOWED.has(cmd)) return `命令 \`${cmd}\` 不在只读白名单内`;

	if (cmd === "find") {
		for (const arg of args) {
			if (FIND_WRITE_PREDICATES.has(arg) || [...FIND_WRITE_PREDICATES].some((p) => arg.startsWith(`${p}=`))) {
				return `find 谓词 \`${arg}\` 可能修改文件或执行命令，子任务为只读模式`;
			}
		}
	}

	if (cmd === "git") {
		const sub = findSubcommand(tokens.slice(first), GIT_READONLY, "git");
		if (!sub || !GIT_READONLY.has(sub)) return `\`git ${sub ?? ""}\` 不是只读子命令`;
		if (args.some((arg) => GIT_EXECUTING_OPTIONS.has(arg))) {
			return "git 选项可能调用外部 diff/textconv 程序，子任务为只读模式";
		}
	}

	if (cmd === "npm") {
		const sub = findSubcommand(tokens.slice(first), NPM_READONLY, "npm");
		if (!sub || !NPM_READONLY.has(sub)) return `\`npm ${sub ?? ""}\` 不是只读子命令`;
	}

	return null;
}

export function validateCommand(command: string): string | null {
	if (!command.trim()) return "命令为空";
	if (SHELL_CONTROL.test(command)) {
		return "命令包含 shell 重定向、管道、命令拼接或命令替换符号，子任务为只读模式";
	}
	return checkSegment(command);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "patch") {
			return { block: true, reason: "子任务为只读模式，不能修改文件。请把需要改动的内容写进结论，由主会话执行。" };
		}

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			const error = validateCommand(command);
			if (error) {
				return {
					block: true,
					reason: `${error}。子任务只能做只读调研；把结论和建议的改动写进输出，由主会话落地。`,
				};
			}
		}

		return undefined;
	});
}
