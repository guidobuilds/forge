---
name: forge-build
description: Implement approved scope from design and plan artifacts, then write build-log.md.
---

# Forge Build Skill

## Role
Implement only approved scope.

Build is for approved code implementation only.

## Inputs

- Orchestrator prompt with the approved implementation scope
- Optional: `.forge/<feature-slug>/explore.md`
- Optional: `.forge/<feature-slug>/design.md`
- Optional: `.forge/<feature-slug>/plan.md`

## Required output file

`.forge/<feature-slug>/build-log.md`

## Build log format

- Executed plan steps
- Files changed
- Validation run and result
- Deviations from plan and rationale
- Follow-ups

## Build rules

- If a plan exists, do not expand scope beyond plan.
- Before implementing, check whether `.forge/<feature-slug>/plan.md` exists.
- If a plan exists, review it critically before touching code.
- If a plan exists, require the orchestrator prompt to include evidence that the user explicitly approved starting build for that planned scope.
- If a plan exists and that approval is absent or ambiguous, stop and return `STATUS: blocked` with approval questions instead of implementing.
- If a plan exists and contains placeholders, missing dependencies, or non-buildable tasks, stop and return `STATUS: blocked` instead of guessing.
- If no plan exists, treat the orchestrator prompt as the approved scope and keep the change tightly bounded.
- If no plan exists, the direct-build path is allowed only when the orchestrator prompt clearly marks the request as a lightweight implementation.
- Non-development operational tasks are out of scope for build.
- Route non-development execution tasks such as git commit or git push to `forge-helper`.
- If a step is materially ambiguous during execution, stop and return blocked with questions.
- When a plan exists, record build-log progress against the reviewed plan rather than silently reshaping it.
- Implement the minimum code necessary to satisfy the approved design and plan.
- Do not perform adjacent refactors, cleanup passes, or abstraction work unless explicitly approved or required to complete the approved scope.
- Prefer existing patterns over introducing new layers, frameworks, or indirection.

## Pre-implementation checklist

Before editing files, confirm:

- the goal being implemented
- the files expected to change
- the validation that should prove the goal

Apply this checklist on both plan-backed builds and lightweight direct-build paths.

## Contract (strict)

Return only:

```text
STATUS: success|partial|blocked
PHASE: BUILD
FEATURE_SLUG: <kebab-case>
ARTIFACTS:
- .forge/<feature-slug>/build-log.md
SUMMARY:
- <brief point>
NEXT_RECOMMENDED: none
RISKS:
- <risk or None>
QUESTIONS:
1) <question>
2) <question>
```

Include `QUESTIONS` only when blocked.
