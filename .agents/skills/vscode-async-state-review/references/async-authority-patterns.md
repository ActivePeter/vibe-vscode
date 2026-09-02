# Async Authority and Ownership Patterns

Use this reference as the review checklist for state that crosses asynchronous, process, page, or persistence boundaries.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Authority | The component whose state decides identity, ownership, or lifecycle. |
| Projection | A rebuildable UI or in-page representation derived from an authority. |
| Provisional state | A usable placeholder that may be replaced during initialization. |
| Readiness gate | The promise or barrier after which a value may be treated as authoritative. |
| Explicit identity | Identity already resolved by an upstream operation and deliberately forwarded. |
| Implicit identity | Identity inferred from mutable current state by the receiving operation. |
| Generation | A token that determines whether asynchronous projection work may still commit. |

## Invariants

### A1. Readiness precedes implicit authority reads

Never persist, delegate, or attach an implicit owner read from provisional state. A synchronous getter can be safe for display while still being unsafe as a durable identity.

Workbench lifecycle phases and dependency injection do not replace a service's own `whenReady`, `whenConnected`, or equivalent contract.

### A2. Authoritative capture precedes later waits

After readiness, capture the initiating owner before profile resolution, provider activation, backend calls, Quick Picks, editor opens, or other waits that allow the active selection to change.

Moving capture to the very end fixes an early-capture bug by recreating a late-capture bug.

### A3. Explicit context is immutable propagation

Treat an inherited creation context as the upstream operation's resolved intent. Preserve its owner and stable resource ID through nested or delegated calls. Do not replace it with current state merely because the current selection changed.

Validate explicit identity at the boundary that accepts untrusted input when required, but do not silently reinterpret invalid identity as the current owner.

### A4. Every exit observes the same contract

Audit normal, contributed, fallback, custom PTY, local-in-remote, hidden, restore, attach, and failure branches. A readiness gate below an early return protects only the paths that reach it.

Start or await the context-resolution operation early enough that every branch consuming identity receives the same result.

### A5. One layer owns each relationship

Do not keep a second ownership map to repair projection errors.

In this repository:

- Remote Logical Workspace state owns the Workspace catalog, layout, and serialized editor working set.
- Page session state owns the active Logical Workspace selection.
- Terminal or PTY metadata owns Logical Terminal identity and Workspace ownership.
- Session provider or history owns the global Agent Session catalog.
- Project selection owns Explorer and SCM focus projections.

Legacy fields may support migration but must not become a second write authority.

### A6. Projection work rejects stale generations

Serialize or coalesce projection work. Check `isCurrent()` before side effects and after every `await`. A completed obsolete side effect may require a current-generation reconcile; cancellation checks alone cannot undo it.

Promises returned by projection operations must represent the real UI commit, not merely the scheduling of that commit.

### A7. Identity includes its namespace

Process IDs, resource IDs, and revisions are meaningful only inside their authority. Partition Terminal persistence by backend or `remoteAuthority`; never merge resources merely because numeric IDs match.

### A8. Failure does not invent authoritative absence

Do not convert partial, cancelled, skipped, or failed reads into an authoritative empty catalog. When a remote mutation has an unknown outcome, reconcile with a read according to the protocol instead of blindly replaying it.

Do not publish ghost ownership before resource creation succeeds unless the declared authority transaction is explicitly atomic and reversible.

### A9. Restoration must be reachable

Any durable owner written to resource metadata must correspond to an authority identity that can become active or otherwise restore the resource. An unknown owner that causes a resource to move to background is an orphan, not isolation.

### A10. Tests must control readiness

Tests using an always-ready fake cannot validate startup behavior. Production-stack tests that unconditionally await readiness also cannot validate it. Model the readiness transition with a controllable promise and assert both sides of the boundary.

### A11. Same identity does not imply same content

An authoritative update can change layout, editor working set, catalog content, or other projected state without changing the active identity or activation sequence. Subscribe to the complete semantic state slice consumed by each projection. Queue a same-target reconcile so an older in-flight snapshot cannot remain indefinitely current.

### A12. Tracked artifacts are independent of the reviewer's machine

Do not embed developer-specific mount points, home directories, usernames, certificate locations,
state directories, or sibling checkout paths in tracked source, configuration, documentation,
scripts, fixtures, or generated artifacts. Resolve repository resources relative to the checkout;
provide environment-owned paths through one documented local input; use placeholders in published
examples.

Accept explicit absolute paths only when the path itself is part of a platform contract or a clearly
synthetic test. Do not replace one hardcoded path with multiple overlapping configuration channels.

## Common Failure Timelines

### Provisional owner becomes orphaned

```text
service exposes provisional Workspace P
→ Terminal creation captures P
→ remote authority returns catalog containing A, not P
→ creation writes owner P after readiness
→ projection sees P != active A and backgrounds Terminal
→ no catalog entry can activate P, so restore never matches
```

### Initiating owner is lost during delegation

```text
authoritative Workspace A starts creation
→ provider/profile resolution awaits
→ user activates Workspace B
→ nested creation rereads active Workspace
→ resource is incorrectly assigned to B
```

### Early-return branch bypasses readiness

```text
shared setup captures provisional state
→ contributed or fallback branch consumes it
→ branch returns
→ readiness gate lower in the function is never reached
```

### Obsolete projection commits late

```text
projection A starts opening or moving a resource
→ user activates B
→ A's awaited operation completes
→ stale continuation mutates foreground state
→ B is visually overwritten unless generation checks and reconcile converge it
```

### Same-target content update is never projected

```text
projection of Workspace A snapshot v1 starts
→ authority accepts A snapshot v2 without changing active ID or activation sequence
→ no state-slice reconcile is requested
→ v1 still passes identity-only isCurrent checks and commits
→ UI remains at v1 until an unrelated activation or reload
```

## Regression Test Matrix

| Scenario | Required observation |
| --- | --- |
| Delayed authority plus immediate normal creation | Owner equals the authoritative active Workspace, never the provisional ID. |
| Delayed authority plus immediate contributed creation | Delegated context contains the authoritative owner and one stable resource ID. |
| Delayed authority plus fallback provider | The fallback cannot return before its implicit owner is authoritatively resolved. |
| Workspace switch while profiles resolve | Owner remains the authoritative initiating Workspace. |
| Workspace switch inside contributed provider | Nested creation preserves the forwarded context. |
| Delayed editor or Terminal restore plus target switch | Old generation cannot leave the wrong target projected. |
| Same target receives authoritative content v2 during restore of v1 | A same-target reconcile runs and the final projection equals v2. |
| Creation failure | No durable ghost owner or parallel ownership record is published. |
| Persistent Terminal reconnect | Owner restores from PTY metadata; legacy state is migration-only. |
| Local and remote processes share a numeric ID | Persistence and restore remain partitioned by backend authority. |
| Remote read or mutation response fails | The client follows reconcile semantics and does not infer deletion or replay an unknown write. |
| Checkout is moved and local service paths change | Tracked files remain unchanged; repository resources still resolve and environment-owned paths arrive through the declared local input. |

## History Review

Inspect focused history before changing capture position or ownership authority:

```bash
git log --oneline -- <implementation> <tests>
git show --find-renames <commit> -- <implementation> <tests>
```

Ask:

1. Which state transition did the earlier fix protect?
2. Was its captured value already authoritative?
3. Did later work introduce a new readiness or authority boundary?
4. Did test refactoring replace an always-ready fake with production code but then await readiness globally?
5. Does the proposed fix preserve both startup correctness and initiating-context correctness?

Classify the relationship precisely. Similar use of `await` does not make two defects identical; the important comparison is which identity transition invalidates the captured state.
