---
name: write-cohesive-docs
description: Draft, restructure, or review technical documentation so each concept, contract, and lifecycle has one canonical explanation, related causal details stay together, and other sections depend only on concise summaries or links. Use for README, design, API, and developer documentation when explanations are duplicated, details are scattered across headings or files, abstraction levels are mixed, or one semantic change would require editing several places.
---

# Write Cohesive Documentation

Make the document easy to change correctly: explain each concept fully in one place and let the rest of the document depend on that explanation without copying it.

## Assign One Canonical Home

1. List the concepts, contracts, lifecycle stages, and reader questions in scope.
2. Assign each item one canonical section or document.
3. Keep one formal name for each concept.
4. State stable conclusions at the highest useful level; place mechanics only under the section that owns them.

Use these default ownership boundaries:

- Overview: outcome, scope, and major boundaries.
- Concept or contract section: meaning, authority, inputs, outputs, and exclusions.
- Lifecycle section: ordered behavior for creation, update, restore, failure, and shutdown.
- Implementation index: file locations only, with short responsibility labels.
- Parent document: concise summary and link; specialized document: full explanation.

## Keep Causal Details Together

Place a complete behavioral chain under the lifecycle stage where it occurs:

```text
trigger → precondition → data transformation → side effect → durable result → failure behavior
```

Keep related types and their handoff in that same section. Do not explain half of a relationship in a type inventory and the other half in a lifecycle section.

Move details instead of copying them. A non-owning section may retain one short invariant or dependency and link to the canonical explanation. Repeat a safety constraint only where a reader must act on it; keep the repeated form brief and semantically identical.

## Limit the Restructure

- Preserve correct content, links, terminology, and externally visible promises.
- Do not create extra sections or documents unless they establish a real ownership boundary.
- Do not combine unrelated concepts merely to reduce heading count.
- Do not turn an overview into an implementation walkthrough.
- Do not hide important failure behavior behind a link when the local action depends on it.

## Review and Validate

1. Summarize every paragraph in one phrase and verify it answers its heading.
2. Move paragraphs whose primary subject belongs to another owner section.
3. Remove partial restatements after the canonical explanation is complete.
4. Check progressive disclosure: conclusion first, contract next, mechanics and exceptions later.
5. Apply the single-edit test: changing one concept should normally require changing one canonical explanation plus links, not several parallel explanations.
6. Check that retained summaries do not introduce a second authority, conflicting terminology, or a different abstraction level.
7. Validate links, formatting, and the final diff; report any intentional repetition.

For a review, identify the duplicated or misplaced concept and name its canonical destination. For an edit, report which explanation became canonical and which duplicates were removed.
