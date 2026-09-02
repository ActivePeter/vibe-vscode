---
name: design-cohesive-roles
description: Design, split, document, or review software roles and component boundaries for high cohesion and low coupling. Use when assigning state, invariants, lifecycle, orchestration, persistence, adapters, services, workers, or external actors; when a module accesses another role's internals; or when an architecture or process diagram needs explicit owners and contracts.
---

# Design Cohesive Roles

Treat a role as an ownership boundary, not as a label for a helper function. Keep each invariant and resource with one owner, and connect roles through the smallest stable contract.

## Partition by Responsibility

1. Inventory the state, resources, invariants, operations, failures, and lifecycle transitions.
2. Group items that change for the same reason and must remain consistent together.
3. Create a separate role only when it owns a distinct invariant, lifecycle, permission, persistence, or external-system boundary.
4. Assign each state and resource one mutation authority and one final-release owner.
5. Keep orchestration in the composition role; keep domain state and cleanup inside the owning role.

Do not create a role that only renames a call, forwards parameters, unwraps a result, or reaches into another role's fields.

## Define the Contract

For each role, state:

- its single purpose;
- the state and resources it owns;
- accepted inputs and observable outputs;
- success, failure, cancellation, and retry semantics;
- startup and shutdown preconditions and postconditions;
- what it explicitly does not own.

Expose contracts rather than internal fields. Keep dependency direction acyclic where possible. If role A depends on role B, initialize B before A and release A before B. Let independent roles remain independent instead of coordinating them through global state.

## Draw Interactions with Mermaid

Use fenced Mermaid diagrams for process, lifecycle, branching, and cross-role interactions. Do not use ASCII arrow diagrams or numbered lists as pseudo-flowcharts.

- Use `sequenceDiagram` for calls, awaits, delegation, acknowledgements, and cross-role failure.
- Use `stateDiagram-v2` for lifecycle states and legal transitions.
- Use `flowchart` for decisions, data pipelines, ownership, and static dependency direction.
- Name participants after real roles or authorities, not private methods.
- Keep internal steps inside their owner; cross a role boundary only through a labeled contract.
- Show meaningful alternatives, retries, cancellation, and completion barriers.
- Let the diagram own ordering; use prose for invariants, rationale, and exceptions instead of restating every step.

## Review the Boundary

Apply these checks:

1. Cohesion: does each role own a complete invariant or lifecycle instead of fragments of several concerns?
2. Authority: can every mutable fact and final release name exactly one owner?
3. Coupling: can one role's implementation change without edits to another role when the contract is unchanged?
4. Surface: does each dependency expose only information required by its consumer?
5. Direction: are callbacks, locks, startup, and shutdown compatible with the dependency graph?
6. Change locality: does a semantic change normally touch one owner and its contract tests rather than several parallel implementations?
7. Diagram fidelity: do Mermaid participants match the declared roles and show only real boundary crossings?

## Limit the Design

- Do not split a small cohesive module for symmetry or file-size targets.
- Do not add a global coordinator when local ordering is sufficient.
- Do not introduce speculative roles or generic frameworks for unproven future consumers.
- Do not duplicate state to simplify a diagram.
- Do not move responsibilities unrelated to the requested change.

For a design, report each role, its owned invariant, and its dependencies. For a review, identify the misplaced responsibility and the smallest owner boundary that can absorb it.
