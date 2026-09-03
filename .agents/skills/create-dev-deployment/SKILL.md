---
name: create-dev-deployment
description: Create, review, or harden development deployment and restart scripts with pinned-snapshot or always-latest modes, immutable releases, single-writer locking, health checks, and rollback. Use for service-control scripts, restart/update semantics, concurrent deployment bugs, and local or hosted development services.
---

# Create Development Deployments

## Choose One Mode

| Mode | Operator-triggered start/restart |
| --- | --- |
| Pinned snapshot | Reuse one immutable release until `--update-snapshot` is passed |
| Always latest | Build and promote current authoritative source before every invocation |

Automatic crash recovery always reuses the selected release; it never rebuilds.

## Keep the Design Small

Use the project's existing script language and process runner. Prefer standard Linux tools such as `flock`, atomic rename or pointer replacement, and `curl --fail`. Do not add Supervisor.

Keep one repository-owned deployment entry point. Record these separate authorities before editing:

- authoritative source;
- immutable releases and atomic `current` pointer;
- mutable state outside every release;
- stable lock path;
- recognized process identity;
- public and private health boundaries.

Resolve repository-owned files relative to the deployment entry point. Keep mutable state,
credentials, certificates, and machine-specific service locations outside tracked files and pass
them through one documented operator input. A checkout moved to another absolute path must not
require a source edit.

## Preserve One Transaction

Hold one exclusive `flock` across the entire operation:

```text
lock → build unique candidate while old service runs → validate
→ verify process ownership → stop → atomically promote → start → health check
→ cleanup → unlock
```

Enforce these rules:

1. Never mutate the active release or build into `current`.
2. Lock before build and retain it through health checks, rollback, and cleanup.
3. Stop only a process proven to belong to this service; a port or PID alone is insufficient.
4. Before stop, any failure leaves the old service untouched. After stop, any startup or health failure restores and verifies the last-known-good release.
5. Cleanup never removes the active, candidate, last-known-good, or live-process release.

Use a stable lock file outside staging and releases. Prefer fail-fast lock contention; support waiting only when explicitly required. Do not recursively invoke the deployment entry point for rollback.

## Test the Transitions

Use temporary directories and controllable fake build/start/health hooks. Cover:

- three pinned restarts keep one release and perform no build;
- `--update-snapshot` is the only pinned refresh path, while always-latest rebuilds;
- a second deployment gets no side effects while the first holds the lock;
- build failure leaves the old service running;
- candidate health failure restores the old healthy service;
- an unknown process owner is never signalled.

Run syntax and available lint checks. Touch a live service only when requested or required by repository instructions.

## Report

State the mode, update command, lock path and scope, release/state boundaries, ownership check, health gates, rollback path, retention rule, and tests run.
