import type { ExecutionState } from "./domain.ts";

export type LoopDecision =
	| { readonly kind: "none" }
	| { readonly kind: "queue-step"; readonly reason: string }
	| { readonly kind: "queue-final"; readonly reason: string }
	| { readonly kind: "pause"; readonly reason: string }
	| { readonly kind: "archive"; readonly reason: string };

export interface ExecutionLoopOptions {
	readonly maxStagnantSettles?: number;
	readonly maxContinuations?: number;
}

export class ExecutionLoop {
	private readonly maxStagnantSettles: number;
	private readonly maxContinuations: number;
	private runRevision = -1;
	private observedStepRevision = -1;
	private stagnantSettles = 0;
	private continuations = 0;
	private queued = false;
	private finalSummaryPending = false;

	constructor(options: ExecutionLoopOptions = {}) {
		this.maxStagnantSettles = options.maxStagnantSettles ?? 2;
		this.maxContinuations = options.maxContinuations ?? 256;
	}

	private queue(kind: "queue-step" | "queue-final", reason: string): LoopDecision {
		if (this.queued) return { kind: "none" };
		this.queued = true;
		this.continuations++;
		return { kind, reason };
	}

	onImplementationStarted(state: ExecutionState): LoopDecision {
		if (state.status !== "implementing") return { kind: "none" };
		this.runRevision = state.runRevision;
		this.observedStepRevision = state.stepRevision;
		this.stagnantSettles = 0;
		this.continuations = 0;
		this.queued = false;
		this.finalSummaryPending = false;
		return this.queue("queue-step", `Implementation started at ${state.currentStepId ?? "the current step"}.`);
	}

	onStepReported(state: ExecutionState): LoopDecision {
		this.runRevision = state.runRevision;
		this.observedStepRevision = state.stepRevision;
		this.stagnantSettles = 0;
		this.queued = false;
		if (state.status === "implementing") {
			return this.queue("queue-step", `Continue with ${state.currentStepId ?? "the next step"}.`);
		}
		if (state.status === "completed") {
			this.finalSummaryPending = true;
			return this.queue("queue-final", "All plan steps were reported complete. Summarize implementation and validation.");
		}
		return { kind: "none" };
	}

	onAgentStart(): void {
		this.queued = false;
	}

	onSettled(state: ExecutionState): LoopDecision {
		if (state.status === "completed") {
			if (this.queued) return { kind: "none" };
			if (this.finalSummaryPending) {
				this.finalSummaryPending = false;
				return { kind: "archive", reason: "Final implementation summary settled" };
			}
			return { kind: "archive", reason: "Recovered completed plan archived" };
		}
		if (state.status !== "implementing") {
			this.reset();
			return { kind: "none" };
		}
		if (this.queued) return { kind: "none" };
		if (state.runRevision !== this.runRevision) {
			this.runRevision = state.runRevision;
			this.observedStepRevision = state.stepRevision;
			this.stagnantSettles = 0;
			this.continuations = 0;
		}
		if (state.stepRevision !== this.observedStepRevision) {
			this.observedStepRevision = state.stepRevision;
			this.stagnantSettles = 0;
		} else {
			this.stagnantSettles++;
		}
		if (this.stagnantSettles >= this.maxStagnantSettles) {
			return { kind: "pause", reason: "Implementation paused after two settled runs without a plan_step_complete report" };
		}
		if (this.continuations >= this.maxContinuations) {
			return { kind: "pause", reason: "Implementation paused after reaching the continuation safety limit" };
		}
		return this.queue("queue-step", `Todo ${state.currentStepId ?? "unknown"} is still active.`);
	}

	reset(): void {
		this.runRevision = -1;
		this.observedStepRevision = -1;
		this.stagnantSettles = 0;
		this.continuations = 0;
		this.queued = false;
		this.finalSummaryPending = false;
	}
}
