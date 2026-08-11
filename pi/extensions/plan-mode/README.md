# Plan Mode Extension

A plan-first workflow for Pi Coding Agent 0.84.x (validated against 0.84.1): enter `/plan`, describe the task, answer only material clarifications, review the generated Todos, confirm execution once, and let the agent continue until every Todo is complete. Internally it retains versioned artifacts, exact approval binding, scoped grants, evidence, audit events, and branch-local recovery without exposing those mechanics as routine user steps.

## Security boundary

The extension reports the safety level **`agent-tools-only`**.

It fail-closes model tool calls through `tool_call`, verifies known built-in tool origins, denies unknown tools, and restricts `edit`/`write` to the current approved step and path scope. Planning is read-only. After the single confirmation, built-in `bash` is exposed only for a current step that explicitly declares `process.exec`; those commands run with the user's normal process permissions, are **not path-sandboxed**, and may invoke network-capable programs. Separate network tools remain unsupported.

It is **not** an OS sandbox and cannot constrain malicious extensions, extension-owned Node I/O, `pi.exec()`, user `!`/`!!`, or RPC's direct `bash` command. `setActiveTools()` is only a visibility reduction, never the authority boundary.

## Usage

This directory is auto-discovered as `$PI_CODING_AGENT_DIR/extensions/plan-mode/index.ts`. In this configuration repository, run `/reload` after changing the source. For an isolated one-off launch from the repository root, use:

```bash
pi -e ./extensions/plan-mode/index.ts
```

Normal use needs only:

```text
/plan
/plan <goal>
```

When inactive, bare `/plan` prompts for the goal in TUI/RPC, enters read-only research, and immediately starts the agent. The model uses `plan_question` only for decisions that materially affect the plan. `plan_submit` then shows the plan and opens one **Execute this plan?** confirmation. Confirming creates the internal approval and execution grant together; the agent advances Todos through evidence-backed `plan_step_complete` calls without asking for per-step verification. If execution is genuinely blocked or needs a wider plan, the model uses `plan_blocked` to pause immediately. If an agent turn merely ends early, the extension automatically continues it; two continuation turns without tool-evidence progress also pause instead of looping forever. Completion automatically restores normal mode.

Useful recovery and inspection commands are `/plan status`, `/plan show`, `/plan edit`, `/plan diff`, `/plan pause`, `/plan resume`, `/plan cancel`, and `/plan audit`. `/plan run` retries the single confirmation when a ready plan was previously dismissed. Low-level `/plan approve`, `/plan execute`, `/plan verify`, and `/plan reset` remain compatibility/diagnostic actions, not part of the normal flow.

In Print/JSON, where dialogs are unavailable, use an explicit goal; bare `/plan` returns `UI_REQUIRED`. Non-interactive execution requires one exact `run` action rather than separate approve and execute actions:

```bash
pi -p --plan-action status "run-plan-action"
pi -p --plan-action run --plan-id <id> --plan-version <n> --plan-hash <sha256> "run-plan-action"
pi --mode json --plan-action status "run-plan-action"
pi --mode json --plan-action diff --plan-from-version 1 --plan-to-version 2 "run-plan-action"
```

Pi's Print/JSON modes require an initial input; the extension consumes the placeholder when `--plan-action` is present, so it is never sent to the model. Pi 0.84.1 reserves guarded Print stdout for final assistant text and exposes no raw-output extension API, so Print action results are written as stable control records to **stderr**; JSON/RPC use custom message events. `--plan` starts research mode and lets the real initial prompt continue; `--plan-goal` supplies its goal.

## Artifacts

The authoritative immutable artifact is stored under:

```text
~/.pi/agent/plans/<project-id>/<plan-id>/vNNNN/spec.json
```

`review.md` is a deterministic human-readable projection. Approvals, grants, state, evidence, and audit records are separate append-only Pi custom entries and are never written back into `spec.json`.

The model submits plans through the structured `plan_submit` managed tool. This tool writes only to the extension-owned user plan store. Each step declares read-only `dependencyScopes` separately from mutation `pathScopes`, plus only the capabilities it needs: `fs.read`, `fs.write`, and optionally `process.exec`. The extension captures a bounded content snapshot of explicit dependencies and rejects confirmation/execution if they drift. Static symlinks, special files, detected scan instability, permission errors, or budget overflow fail closed. Files are read through bounded `O_NOFOLLOW` file handles where supported; parent-directory races and approved process execution remain outside a path sandbox.

Editing creates a new immutable version and invalidates the old approval/grant. `/plan diff` renders a structural comparison of plan fields and steps; with no versions it compares the current version to its nearest stored predecessor.

## Recovery

- Approved resumes as approved, without a grant.
- Executing resumes as stale.
- Fork/clone retains the PlanSpec lineage but clears approval and grant.
- Tree navigation rebuilds only from `sessionManager.getBranch()`.
- Compaction summaries are non-authoritative; the extension re-injects state each turn.
- Approved/paused state rechecks dependency snapshots on recovery; executing still always recovers as stale.
- Dependency snapshots are conservative drift signals, not an OS-level or atomic TOCTOU guarantee.

## Tests

Requires Node 22.6 or later. From the configuration repository root:

```bash
node --experimental-strip-types --test extensions/plan-mode/tests/*.test.ts
```

Tests cover the one-action run transition, evidence-backed automatic Todo advancement, canonical hashing, immutable versioning, approval replay, grant path/epoch enforcement, planning-time bash denial, explicit `process.exec`, unknown tools, symlink escapes, concurrency, audit fail-closed behavior, branch recovery, fork/resume semantics, artifact corruption, Todo UI projection, and TUI/Print/JSON/RPC controller parity.
