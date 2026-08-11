import type { ExecutionState, PlanStatus } from "./domain.ts";

const ALLOWED_TRANSITIONS: Readonly<Record<PlanStatus, ReadonlySet<PlanStatus>>> = {
	inactive: new Set(["researching"]),
	researching: new Set(["awaiting_input", "review", "cancelled", "failed"]),
	awaiting_input: new Set(["researching", "review", "cancelled", "failed"]),
	review: new Set(["review", "approved", "rejected", "cancelled", "failed"]),
	approved: new Set(["review", "executing", "stale", "cancelled", "failed"]),
	executing: new Set(["executing", "paused", "completed", "stale", "cancelled", "failed"]),
	paused: new Set(["review", "executing", "stale", "cancelled", "failed"]),
	completed: new Set(["inactive"]),
	rejected: new Set(["inactive", "researching"]),
	cancelled: new Set(["inactive", "researching"]),
	stale: new Set(["review", "cancelled", "failed"]),
	failed: new Set(["inactive", "researching"]),
};

export class InvalidTransitionError extends Error {
	readonly from: PlanStatus;
	readonly to: PlanStatus;

	constructor(from: PlanStatus, to: PlanStatus) {
		super(`Invalid Plan Mode transition: ${from} -> ${to}`);
		this.name = "InvalidTransitionError";
		this.from = from;
		this.to = to;
	}
}

export function canTransition(from: PlanStatus, to: PlanStatus): boolean {
	return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertTransition(from: PlanStatus, to: PlanStatus): void {
	if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: PlanStatus): boolean {
	return status === "completed" || status === "rejected" || status === "cancelled" || status === "failed";
}

export function hasElevatedGrant(state: ExecutionState): boolean {
	return state.status === "executing" && state.grantId !== undefined;
}

export function usesPlanningSafePolicy(status: PlanStatus): boolean {
	return status !== "inactive";
}
