---
name: using-forge
description: Route work through the lightest safe Forge workflow and enforce phase approval rules.
---

# Using Forge Skill

## Role
Apply the Forge operating model from the orchestrator.

Forge is a thin orchestrator over durable markdown artifacts, minimal phase agents, and explicit approval gates.

## Default flow

```text
explore -> design -> plan -> build -> done
```

Phase intent:
- `explore`: capture what exists and relevant intersections in the repo
- `design`: close critical design decisions first, then capture the intended behavior and technical shape in one artifact
- `plan`: sequence approved design work into execution units
- `build`: implement approved scope and report validation

`design` includes an internal clarification gate. Forge stays in `design` until every critical decision that materially changes the design has been resolved.

## Lightweight paths

Use a shorter path only when the request is already tightly bounded.

- `explore -> plan -> build -> done`
- `explore -> build -> done`
- `build -> done`

## Lightweight path criteria

You may skip `design` and/or `plan` only when all of the following are true:
- the change is small, localized, and easy to bound
- the request is already clear enough to implement safely
- no meaningful product or technical design decisions are needed
- the blast radius is low and cross-system coordination is not required

If unsure, start with `explore`.

## Routing rules

- Never do phase work inline.
- Delegate development work to the Forge phase agents.
- Route non-development operational tasks such as git commit or git push to `forge-helper`.
- Keep one thin thread with the user.

## Design gate

- Before `design.md` is written, resolve every critical decision that materially changes behavior, scope, interface, or technical shape.
- If a question can be answered by exploring the repo, existing artifacts, or docs, answer it there instead of asking the user.
- Ask only the smallest useful batch of questions. Small independent batches are allowed; giant interview dumps are not.
- Every design-gate question must include a recommendation and brief impact.
- Do not invoke `forge-plan` until `forge-design` has closed the gate and produced `design.md`.
- `design` may return `STATUS: blocked` multiple times while the clarification gate is open.

## Approval guardrails

- `plan` readiness is not build approval.
- If `.forge/<feature-slug>/plan.md` exists, require explicit user approval before invoking `forge-build`.
- Treat `NEXT_RECOMMENDED: build` as phase readiness only.
- Direct `build` without a plan is allowed only for lightweight requests that are already clear and approved to implement.

## Canonical artifacts

- `.forge/<feature-slug>/explore.md`
- `.forge/<feature-slug>/design.md`
- `.forge/<feature-slug>/plan.md`
- `.forge/<feature-slug>/build-log.md`

## Contract enforcement

Every phase response must use the Forge contract exactly:

```text
STATUS: success|partial|blocked
PHASE: EXPLORE|DESIGN|PLAN|BUILD|HELPER
FEATURE_SLUG: <kebab-case>
ARTIFACTS:
- <path or None>
SUMMARY:
- <point>
NEXT_RECOMMENDED: explore|design|plan|build|none
RISKS:
- <risk or None>
QUESTIONS:
1) <question>
```

Use `QUESTIONS` only when blocked.
