---
name: forge-design
description: Create the canonical design artifact that merges product and technical design into design.md.
---

# Forge Design Skill

## Role
Close critical design decisions and then produce the single design artifact for the work item.

`design.md` is the default source of truth for both intended behavior and technical shape. There is no separate `tech.md` in this flow.

## Inputs

- `.forge/<feature-slug>/explore.md`
- Feature request and user clarifications

## Required output file

`.forge/<feature-slug>/design.md`, but only after the clarification gate is fully closed.

## Clarification gate

Before writing `design.md`, review:

- `.forge/<feature-slug>/explore.md`
- the user request
- prior user clarifications in the current thread

Classify open questions into:

- critical decisions that materially change behavior, scope, interface, or technical shape
- non-critical details that can be fixed by a reasonable default

Rules:

- Resolve all critical decisions before writing `design.md`.
- Do not ask questions that can be answered from the repo, existing artifacts, or docs.
- Ask the smallest useful batch of independent questions.
- Every question must include:
  - the decision to resolve
  - a recommended answer
  - brief impact of that recommendation
- If critical decisions remain, return `STATUS: blocked`, `NEXT_RECOMMENDED: design`, and do not write `design.md` yet.

## Design format

The document must stay compact and optimized for LLM consumption.

Expected content:
- Objective
- Non-objectives
- Decision Log
- Requirements with stable `TASK-*` identifiers
- Technical shape for those same `TASK-*` items
- Constraints and dependencies that materially affect implementation
- Acceptance checks

## Design rules

- Merge product and technical design into one artifact, but keep those concerns clearly separated by section.
- Include only resolved design-relevant decisions in the `Decision Log`.
- Reuse stable `TASK-*` identifiers across the artifact.
- Be concrete about files, modules, integration points, and constraints when they materially shape implementation.
- Do not turn `design.md` into an execution checklist; sequencing belongs in `plan.md`.
- Use reasonable defaults only for non-critical details.
- Do not write `design.md` with unresolved critical decisions.

## Phase intent

- `design.md` answers: what should change, and what is the intended technical shape?
- It is the design source of truth for downstream planning and implementation after the clarification gate has been closed.

## Contract (strict)

Return only:

```text
STATUS: success|partial|blocked
PHASE: DESIGN
FEATURE_SLUG: <kebab-case>
ARTIFACTS:
- .forge/<feature-slug>/design.md | None
SUMMARY:
- <brief point>
NEXT_RECOMMENDED: design|plan
RISKS:
- <risk or None>
QUESTIONS:
1) Decision: <decision>
   Recommendation: <recommended answer>
   Impact: <brief why>
2) Decision: <decision>
   Recommendation: <recommended answer>
   Impact: <brief why>
```

Use `STATUS: blocked` when critical decisions still require user input.
Include `QUESTIONS` only when blocked.
