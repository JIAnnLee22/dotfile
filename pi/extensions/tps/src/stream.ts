/** 主会话与子任务共用的显示阶段。 */
export type TpsPhase = "thinking" | "output";

/** 子任务只上报增量，速率由接收端在统一的 1 秒窗口计算。 */
export interface TpsStreamEvent {
	/** 每个子进程唯一；label 仅为显示名，不作为新协议的身份。 */
	id?: string;
	label?: string;
	phase?: TpsPhase;
	bytesDelta?: number;
	/** 兼容旧生产端的速率事件。 */
	tps?: number;
	/** 该任务已完成响应的累计 token 数。 */
	tokens?: number;
	ended?: boolean;
}
