/** TPS：每秒计算一次主会话与并行子任务的合计速率，结束后显示 token 总数。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { registerTpsWidget } from "./src/widget.ts";

export type { TpsPhase, TpsStreamEvent } from "./src/stream.ts";

export default function (pi: ExtensionAPI) {
	registerTpsWidget(pi, truncateToWidth);
}
