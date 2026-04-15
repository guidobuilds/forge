---
name: forge-plan
description: Create an execution plan from explore and design artifacts.
---

# Forge Plan Skill

## Role
Create the execution plan from the approved design work.

## Inputs

- `.forge/<feature-slug>/explore.md`
- `.forge/<feature-slug>/design.md`

## Required output file

`.forge/<feature-slug>/plan.md`

## Plan format

The plan defines execution order using building tasks.

A building task is a unit of work that must be implementable and testable.

The plan must include:
- Scope for the current delivery
- File Map covering the likely files or modules to touch and why
- Building tasks to execute
- Execution order of those building tasks
- Expected result of each building task
- Files or components touched by each building task
- Verification for each building task
- References to relevant `TASK-*` items when they clarify scope, sequencing, or dependencies

The plan must not include:
- Design definitions that belong in `design.md`
- Rationale for why a solution was chosen over another
- Code blocks
- Unresolved questions inside the plan document
- Placeholder language such as `TBD`, `TODO`, `implement later`, `adjust as needed`, or catch-all steps that hide concrete work

## Planning rules

- Use `design.md` as the source of truth for behavior and technical shape.
- Do not plan from a design artifact that still has unresolved critical decisions.
- Sequence delivery work without redefining the design.
- Make each building task buildable without guesswork.
- Prefer finer-grained tasks than the current format, but do not break work into trivial micro-steps.
- Ask questions only when uncertainty materially changes execution strategy or task ordering.
- A completed plan does not authorize implementation by itself.
- Default to `NEXT_RECOMMENDED: plan` when the plan is ready but waiting for user approval to build.
- Return `NEXT_RECOMMENDED: build` only when the orchestrator prompt explicitly states that the user has already approved implementation.
- Keep tasks surgically scoped to the approved goal; optional cleanup belongs outside the plan unless explicitly requested.
- The file map must justify why each listed file or module is expected to be touched.
- Prefer existing patterns and minimum necessary changes over broader structural rewrites.
- Each task must include minimal verification tied to the requested goal, not just a generic test step.
- If execution would require guesswork about assumptions, unknowns, or missing dependencies, stop and block instead of padding the plan with placeholders.

## Contract (strict)

Return only:

```text
STATUS: success|partial|blocked
PHASE: PLAN
FEATURE_SLUG: <kebab-case>
ARTIFACTS:
- .forge/<feature-slug>/plan.md
SUMMARY:
- <brief point>
NEXT_RECOMMENDED: plan|build
RISKS:
- <risk or None>
QUESTIONS:
1) <question>
2) <question>
```

Use `STATUS: blocked` when planning cannot continue due to missing critical decisions.
Include `QUESTIONS` only when blocked.
