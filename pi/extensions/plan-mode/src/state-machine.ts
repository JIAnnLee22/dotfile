import type { ExecutionState, PlanStatus } from "./domain.ts";

const ALLOWED_TRANSITIONS: Readonly<Record<PlanStatus, ReadonlySet<PlanStatus>>> = {
	inactive: new Set(["planning"]),
	planning: new Set(["awaiting_input", "review", "cancelled", "failed", "stale"]),
	awaiting_input: new Set(["planning", "cancelled", "failed", "stale"]),
	review: new Set(["review", "planning", "implementing", "cancelled", "failed", "stale"]),
	implementing: new Set(["implementing", "paused", "completed", "cancelled", "failed", "stale"]),
	paused: new Set(["planning", "review", "implementing", "cancelled", "failed", "stale"]),
	completed: new Set(["inactive"]),
	cancelled: new Set(["inactive"]),
	stale: new Set(["cancelled", "inactive"]),
	failed: new Set(["inactive"]),
};

export class InvalidTransitionError extends Error {
	readonly from: PlanStatus;
	readonly to: PlanStatus;

	constructor(from: PlanStatus, to: PlanStatus) {
		super(`Invalid Plan Mode v2 transition: ${from} -> ${to}`);
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
	return status === "completed" || status === "cancelled" || status === "failed";
}

export function hasImplementationAuthority(state: ExecutionState): boolean {
	return state.status === "implementing" && state.approvalId !== undefined;
}

export function usesPlanningPolicy(status: PlanStatus): boolean {
	return status === "planning" || status === "awaiting_input" || status === "review" || status === "paused" || status === "stale";
}
