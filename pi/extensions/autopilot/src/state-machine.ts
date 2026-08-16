import type { AutopilotStatus, ExecutionState } from "./domain.ts";

const ALLOWED_TRANSITIONS: Readonly<Record<AutopilotStatus, ReadonlySet<AutopilotStatus>>> = {
	inactive: new Set(["drafting"]),
	drafting: new Set(["dryrun", "paused", "cancelled", "failed"]),
	dryrun: new Set(["dryrun", "running", "paused", "cancelled", "failed"]),
	running: new Set(["running", "completed", "paused", "cancelled", "failed"]),
	paused: new Set(["dryrun", "running", "cancelled", "failed"]),
	completed: new Set(["inactive"]),
	cancelled: new Set(["inactive"]),
	failed: new Set(["inactive"]),
};

export class InvalidTransitionError extends Error {
	readonly from: AutopilotStatus;
	readonly to: AutopilotStatus;

	constructor(from: AutopilotStatus, to: AutopilotStatus) {
		super(`Invalid Autopilot transition: ${from} -> ${to}`);
		this.name = "InvalidTransitionError";
		this.from = from;
		this.to = to;
	}
}

export function canTransition(from: AutopilotStatus, to: AutopilotStatus): boolean {
	return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertTransition(from: AutopilotStatus, to: AutopilotStatus): void {
	if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: AutopilotStatus): boolean {
	return status === "completed" || status === "cancelled" || status === "failed";
}

export function isActiveStage(status: AutopilotStatus): status is "dryrun" | "running" {
	return status === "dryrun" || status === "running";
}
