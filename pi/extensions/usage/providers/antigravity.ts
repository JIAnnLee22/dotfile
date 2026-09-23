import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ProviderNotLoggedInError, type UsageProvider, type UsageReport, type UsageSnapshot } from "../framework.ts";

const TIMEOUT_MS = 12_000;
const ENDPOINT_CANDIDATES = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];
const DEFAULT_USER_AGENT =
	"antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)";


// ── Helpers ──

function maskEmail(email?: string): string {
	if (!email || !email.includes("@")) return "";
	const [user, domain] = email.split("@");
	if (user.length <= 3) return `${user[0]}***@${domain}`;
	return `${user.slice(0, 3)}***@${domain}`;
}

function clampFraction(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value));
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), ms);
	try {
		return await fetch(url, { ...init, signal: ac.signal });
	} catch (e) {
		if (ac.signal.aborted) throw new Error(`请求超时 ${Math.round(ms / 1000)}s`);
		throw e;
	} finally {
		clearTimeout(t);
	}
}

// ── Auth Resolution ──

interface AntigravityCredentials {
	token: string;
	projectId?: string;
	email?: string;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

async function resolveCredentials(ctx: ExtensionCommandContext): Promise<AntigravityCredentials> {
	// 1. 优先通过 Pi 的 modelRegistry 获取 (Pi 会自动处理 token 的刷新与格式化)
	try {
		const apiKeyRaw = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
		if (apiKeyRaw) {
			try {
				const parsed = JSON.parse(apiKeyRaw) as { token?: string; projectId?: string; email?: string };
				if (parsed.token) {
					return { token: parsed.token, projectId: parsed.projectId, email: parsed.email };
				}
			} catch {
				// 如果不是 JSON，直接当作 token
				return { token: apiKeyRaw };
			}
		}
	} catch {
		// 继续回退到 auth.json
	}

	// 2. 回退读取 auth.json
	const authPath = join(agentDir(), "auth.json");
	if (existsSync(authPath)) {
		try {
			const authData = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
			const ag = authData.antigravity as Record<string, unknown> | undefined;
			if (ag && typeof ag.access === "string" && ag.access) {
				return {
					token: ag.access,
					projectId: typeof ag.projectId === "string" ? ag.projectId : undefined,
					email: typeof ag.email === "string" ? ag.email : undefined,
				};
			}
		} catch {
			// ignore json parse error
		}
	}

	throw new ProviderNotLoggedInError("Antigravity", "/login antigravity");
}

// ── API Post ──

async function postJson(
	path: string,
	token: string,
	body: Record<string, unknown>,
): Promise<{ endpoint: string; data: Record<string, unknown> }> {
	let lastError: Error | null = null;
	for (const endpoint of ENDPOINT_CANDIDATES) {
		try {
			const res = await fetchWithTimeout(
				`${endpoint}${path}`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						"User-Agent": process.env.ANTIGRAVITY_USER_AGENT || DEFAULT_USER_AGENT,
						Accept: "application/json",
					},
					body: JSON.stringify(body),
				},
				TIMEOUT_MS,
			);
			if (res.ok) {
				const data = (await res.json()) as Record<string, unknown>;
				return { endpoint, data };
			}
			if ([403, 404, 429, 500, 502, 503, 504].includes(res.status)) {
				lastError = new Error(`${path} HTTP ${res.status}`);
				continue;
			}
			throw new Error(`${path} HTTP ${res.status}`);
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	}
	throw lastError || new Error(`${path} 请求失败`);
}

// ── Fetch Usage ──

export async function fetchAntigravityUsage(creds: AntigravityCredentials): Promise<UsageReport> {
	const { token, projectId, email } = creds;

	// 并发请求 loadCodeAssist 与 retrieveUserQuotaSummary
	const [assistPromise, quotaPromise] = await Promise.allSettled([
		postJson("/v1internal:loadCodeAssist", token, {
			metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
		}),
		postJson("/v1internal:retrieveUserQuotaSummary", token, {}),
	]);

	let planLabel: string | undefined;
	if (assistPromise.status === "fulfilled") {
		const assist = assistPromise.value.data;
		const paidTier = assist.paidTier as { name?: string; id?: string } | undefined;
		const currentTier = assist.currentTier as { name?: string; id?: string } | undefined;
		if (paidTier?.name) {
			planLabel = paidTier.name;
		} else if (currentTier?.name) {
			planLabel = currentTier.name;
		}
	}

	const snapshots: UsageSnapshot[] = [];
	let hasQuotaGroups = false;

	if (quotaPromise.status === "fulfilled") {
		const quotaData = quotaPromise.value.data;
		const groups = Array.isArray(quotaData.groups) ? quotaData.groups : [];
		for (const g of groups) {
			const group = g as {
				displayName?: string;
				buckets?: Array<{
					bucketId?: string;
					displayName?: string;
					window?: string;
					resetTime?: string;
					remainingFraction?: number;
				}>;
			};
			const gName = String(group.displayName || "").toLowerCase();
			const isGemini = gName.includes("gemini");
			const is3P = gName.includes("claude") || gName.includes("gpt") || gName.includes("3p");
			const rawBuckets = Array.isArray(group.buckets) ? [...group.buckets] : [];
			// 优先展示 5小时 窗口，再展示 周 窗口
			rawBuckets.sort((a, b) => {
				const a5 = String(a.window || "").includes("5h") || String(a.displayName || "").toLowerCase().includes("five hour");
				const b5 = String(b.window || "").includes("5h") || String(b.displayName || "").toLowerCase().includes("five hour");
				if (a5 && !b5) return -1;
				if (!a5 && b5) return 1;
				return 0;
			});

			for (const b of rawBuckets) {
				const frac = clampFraction(b.remainingFraction);
				if (frac === undefined) continue;
				const percent = Math.round(frac * 1000) / 10;
				const resetTime = b.resetTime || "";
				const w = String(b.window || "").toLowerCase();
				const bName = String(b.displayName || "").toLowerCase();
				const is5h = w === "5h" || bName.includes("five hour") || bName.includes("5h") || bName.includes("5-hour");

				let label: string;
				if (isGemini) {
					label = is5h ? "Gem 5时" : "Gem 周 ";
				} else if (is3P) {
					label = is5h ? "3P  5时" : "3P  周 ";
				} else {
					const shortName = (group.displayName || "Quota").slice(0, 4);
					label = `${shortName} ${is5h ? "5时" : "周 "}`;
				}

				snapshots.push({
					label,
					percent,
					resetsAt: resetTime,
				});
				hasQuotaGroups = true;
			}
		}
	}

	// 若未获取到 QuotaGroups（如免费账号无 retrieveUserQuotaSummary 权限），回退到 fetchAvailableModels
	if (!hasQuotaGroups) {
		try {
			const modelsRes = await postJson("/v1internal:fetchAvailableModels", token, {
				project: projectId || "antigravity-default",
			});
			const modelsObj = modelsRes.data.models as Record<string, Record<string, unknown>> | undefined;
			if (modelsObj) {
				// 提取 Gemini 代表模型
				const geminiModel = modelsObj["gemini-3.8-flash"] || modelsObj["gemini-3.7-flash"] || modelsObj["gemini-3.6-flash"];
				if (geminiModel && typeof geminiModel === "object") {
					const qi = geminiModel.quotaInfo as { remainingFraction?: number; resetTime?: string } | undefined;
					const frac = clampFraction(qi?.remainingFraction);
					if (frac !== undefined) {
						snapshots.push({
							label: "Gemini ",
							percent: Math.round(frac * 1000) / 10,
							resetsAt: qi?.resetTime || "",
						});
					}
				}
				// 提取 Claude/3P 代表模型
				const claudeModel = modelsObj["claude-sonnet-4-6"] || modelsObj["gpt-oss-120b"];
				if (claudeModel && typeof claudeModel === "object") {
					const qi = claudeModel.quotaInfo as { remainingFraction?: number; resetTime?: string } | undefined;
					const frac = clampFraction(qi?.remainingFraction);
					if (frac !== undefined) {
						snapshots.push({
							label: "Claude ",
							percent: Math.round(frac * 1000) / 10,
							resetsAt: qi?.resetTime || "",
						});
					}
				}
			}
		} catch {
			// ignore fallback error
		}
	}

	const extraParts: string[] = [];
	if (planLabel) extraParts.push(`plan: ${planLabel}`);
	if (email) extraParts.push(maskEmail(email));

	return {
		title: "Antigravity Usage",
		snapshots,
		extra: extraParts.length > 0 ? extraParts.join(" · ") : undefined,
		raw: { assistStatus: assistPromise.status, quotaStatus: quotaPromise.status },
	};
}

export async function isAntigravityConfigured(ctx: ExtensionCommandContext): Promise<boolean> {
	try {
		const creds = await resolveCredentials(ctx);
		return !!creds.token;
	} catch {
		return false;
	}
}

export const antigravityProvider: UsageProvider = {
	id: "antigravity",
	title: "Antigravity Usage",
	isConfigured: isAntigravityConfigured,
	async fetch(ctx: ExtensionCommandContext): Promise<UsageReport> {
		const creds = await resolveCredentials(ctx);
		return await fetchAntigravityUsage(creds);
	},
};
