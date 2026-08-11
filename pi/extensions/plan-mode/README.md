# Plan Mode Extension

Strict, versioned Plan Mode for Pi Coding Agent 0.84.x (validated against 0.84.1). The extension is based on Pi's bundled `examples/extensions/plan-mode/`, but replaces free-text plan parsing, `[DONE:n]` progress, bash regex filtering, and normal-tool restoration with structured artifacts, exact approvals, scoped execution grants, append-only audit events, and branch-local recovery.

## Security boundary

The extension reports the safety level **`agent-tools-only`**.

It fail-closes model tool calls through `tool_call`, verifies known built-in tool origins, denies unknown tools, and restricts `edit`/`write` to the current approved step and path scope. P0 denies model `bash` and network access in every Plan Mode state.

It is **not** an OS sandbox and cannot constrain malicious extensions, extension-owned Node I/O, `pi.exec()`, user `!`/`!!`, or RPC's direct `bash` command. `setActiveTools()` is only a visibility reduction, never the authority boundary.

## Usage

This directory is auto-discovered as `$PI_CODING_AGENT_DIR/extensions/plan-mode/index.ts`. In this configuration repository, run `/reload` after changing the source. For an isolated one-off launch from the repository root, use:

```bash
pi -e ./extensions/plan-mode/index.ts
```

Commands:

```text
/plan <goal>
/plan start <goal>
/plan status
/plan show
/plan diff [fromVersion] [toVersion]
/plan edit
/plan approve [<version> <hash> | <planId> <version> <hash>]
/plan execute [<version> <hash> | <planId> <version> <hash>]
/plan pause
/plan resume [<version> <hash> | <planId> <version> <hash>]
/plan verify [stepId] [reason]
/plan reject [reason]
/plan cancel [reason]
/plan reset
/plan audit
```

In TUI/RPC, approve/execute/resume may display and confirm the exact current PlanRef. Print and JSON require explicit flags:

```bash
pi -p --plan-action status "run-plan-action"
pi -p --plan-action approve --plan-id <id> --plan-version <n> --plan-hash <sha256> "run-plan-action"
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

The model submits plans through the structured `plan_submit` managed tool. This tool writes only to the extension-owned user plan store. Each step declares read-only `dependencyScopes` separately from mutation `pathScopes`. The extension captures a bounded content snapshot of explicit dependencies and rejects approval/execution if they drift. Static symlinks, special files, detected scan instability, permission errors, or budget overflow fail closed. Files are read through bounded `O_NOFOLLOW` file handles where supported; parent-directory races still remain an extension-only TOCTOU boundary.

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

Tests cover canonical hashing, immutable versioning, approval replay, grant path/epoch enforcement, unknown tools, symlink escapes, concurrency, audit fail-closed behavior, branch recovery, fork/resume semantics, artifact corruption, and TUI/Print/JSON/RPC controller parity.
