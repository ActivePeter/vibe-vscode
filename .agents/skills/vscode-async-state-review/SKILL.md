---
name: vscode-async-state-review
description: Analyze, document, review, and fix VS Code or Vibe VS Code changes involving asynchronous initialization, remote authority, identity or ownership, persistence, and UI projection. Use for PR comments, regressions, or design work involving whenReady gates, provisional versus authoritative state, state captured across await boundaries, Logical Workspace or Project Context, Terminal or PTY ownership, contributed and fallback creation paths, projection generations, early returns, startup races, reconnects, and tests for those behaviors.
---

# Review VS Code Async State

Apply an authority-first review to asynchronous state. Preserve the initiating identity without accepting provisional state as authoritative.

## Load Context

1. Read the repository `AGENTS.md` instructions and `.github/copilot-instructions.md` before editing.
2. Read [references/async-authority-patterns.md](references/async-authority-patterns.md) completely.
3. When Logical Workspace, Project Context, Terminal ownership, or remote view state is in scope, read the applicable canonical design documents completely:
   - `vibe_vscode_doc/design/pr1_logical_workspace_and_fullscreen.md`
   - `vibe_vscode_doc/design/remote_logical_workspace_state.md`
   - `vibe_vscode_doc/design/remote_persistent_state_minimal_interfaces.md`
4. Treat current source and tests as implementation evidence. Treat design documents as intended contracts and report any disagreement instead of silently choosing one.

## Review Workflow

### 1. Identify the State Contract

Record these facts before judging a read or write:

- the resource and its stable identity;
- the single authority for that identity or state;
- any provisional, cached, optimistic, page-local, or projected copies;
- the readiness gate that makes the value authoritative;
- the resource lifetime and persistence boundary;
- the component allowed to mutate the authority.

Do not equate dependency injection, service construction, or a Workbench lifecycle phase with service-specific readiness.

### 2. Trace Every Control Path

Use `rg` to find the entry point, callers, delegated providers, fallback paths, early returns, persistence adapters, and tests. Follow identity through Extension Host, Agent Host, contributed profile, backend, restore, and attach paths when present.

For each branch, note whether it:

- waits for authority readiness;
- resolves an implicit identity;
- preserves an explicit identity;
- returns before a later shared gate;
- rereads mutable current state after an asynchronous boundary.

### 3. Write the Timeline

Express the suspected behavior as an event sequence, including each `await` and state transition. Distinguish these two hazards:

- Capture too late: the user switches from authoritative A to B while work is pending, so A's resource is assigned to B.
- Capture too early: provisional P is captured before authority readiness, then authoritative A replaces P and the resource becomes orphaned.

Require both properties: resolve implicit identity only after its authority is ready, then capture it once before later asynchronous work can change the active selection.

### 4. Check Invariants and History

Apply every relevant invariant and test scenario from the reference. Inspect focused history with `git log` and `git show` to learn which earlier behavior a change was protecting. Never fix a readiness race by reintroducing a previously fixed initiating-context race.

For tracked deployment, persistence, documentation, or fixture changes, also inspect added lines for machine-specific paths and sibling-checkout dependencies before accepting the authority boundary.

Separate findings into:

- exact recurrence of an earlier defect;
- the same concurrency pattern with a different transition;
- a new defect exposed by the interaction of otherwise valid fixes.

### 5. Choose the Smallest Correct Boundary

Prefer resolving the contract at the shared service boundary rather than relying on every caller to remember a gate.

For creation contexts:

1. Preserve a supplied explicit owner and stable resource identity.
2. For an implicit owner, await the authority readiness contract before reading active state.
3. Capture the now-authoritative owner once.
4. Forward the same immutable context through every delegated and fallback branch.
5. Do not silently rebind an inherited context to whichever Workspace is current later.

For projections, serialize or coalesce work and check that the generation remains current before and after every asynchronous boundary. Subscribe to authoritative content changes even when the target identity and activation sequence stay the same. Ensure a newer target or snapshot eventually converges even when an obsolete side effect already began.

### 6. Test the Transition, Not Only the Steady State

Use controllable promises or barriers to expose the race deterministically. At minimum, cover the branches changed by the fix and the inverse regression that an earlier fix prevented. Avoid placing `await whenReady` in test setup when the behavior under test is startup before readiness.

Prefer one snapshot-style assertion that includes owner identity, foreground/background placement, active target, and relevant call counts.

### 7. Validate Proportionally

Run the narrowest related unit tests first. Add targeted type checking only when the change is broad, crosses interfaces, or targeted validation reveals a compilation issue. Do not deploy documentation-only or skill-only changes unless the user explicitly requests deployment.

## Deliverable

Lead with the result. For a diagnosis or review, report:

1. the violated invariant;
2. a concrete event timeline;
3. user-visible impact and severity;
4. the correct fix boundary;
5. regression tests, including the inverse race;
6. relevant earlier fixes and whether this is exact or merely analogous.

For an implementation request, make the change, run focused validation, and identify any uncovered branch explicitly.
