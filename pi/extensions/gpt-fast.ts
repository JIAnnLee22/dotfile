import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** GPT-6 Fast mode for the ChatGPT/Codex provider; enabled on every reload. */
export default function (pi: ExtensionAPI) {
	let enabled = true;

	function supportsFast(ctx: ExtensionContext): boolean {
		return (
			ctx.model?.provider === "openai-codex" &&
			ctx.model.api === "openai-codex-responses" &&
			/^gpt-6(?:[.-]|$)/.test(ctx.model.id)
		);
	}

	function updateStatus(ctx: ExtensionContext) {
		ctx.ui.setStatus("gpt-fast", enabled && supportsFast(ctx) ? "GPT Fast" : undefined);
	}

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsFast(ctx)) return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		const payload = event.payload as Record<string, unknown>;
		if (payload.model !== ctx.model?.id) return;

		// Fast is a service tier, not a reduction in reasoning effort.
		return { ...payload, service_tier: "priority" };
	});

	pi.registerCommand("fast", {
		description: "GPT-6 Codex Fast 状态或开关：/fast [on|off]（重载后默认开启）",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") enabled = true;
			else if (action === "off") enabled = false;
			else if (action !== "" && action !== "status") {
				ctx.ui.notify("用法：/fast [on|off|status]", "warning");
				return;
			}

			updateStatus(ctx);
			ctx.ui.notify(
				`GPT-6 Codex Fast ${enabled ? "已开启" : "已关闭"}；${
					supportsFast(ctx) ? "适用于当前模型" : "当前模型不适用"
				}。开启会请求 priority 层级，可能增加额度消耗；重载后默认开启。`,
				"info",
			);
		},
	});
}
