---
name: using-forge
description: Route work through the lightest safe Forge workflow using dynamic runtime routing.
---

# Using Forge Skill

## Role
Apply the Forge operating model from the Forge orchestrator.

Forge is Forge with the same thin orchestration model, durable artifacts, and minimum-change discipline, but without a rigid required lifecycle.

## Operating principles

Apply these rules before choosing or invoking any worker run:

- **Think before acting**: translate the request into the goal, constraints, assumptions, unknowns, and safest routing before delegating work that creates artifacts, edits code, or mutates state.
- **Simplicity first**: prefer the lightest safe workflow and the smallest viable change. Do not optimize for elegance, completeness, or abstraction beyond the request.
- **Surgical changes**: keep scope local, touch only files likely required for the requested outcome, and do not bundle adjacent cleanup or refactors unless explicitly requested or required.
- **Goal-driven execution**: define the intended outcome and expected verification up front so worker runs can report against it.
- **One thin user thread**: the orchestrator stays the only direct interlocutor with the user.

## Shared definitions

- **Goal**: the concrete outcome the user wants.
- **Constraints**: non-goals, approval limits, scope boundaries, or system limits that must remain true.
- **Assumption**: a working belief used to proceed when the repo or request suggests it is safe.
- **Unknown**: missing information that may matter but is not yet proven.
- **Tradeoff**: a deliberate choice between viable options that changes complexity, scope, or behavior.
- **Verification**: the check that will show whether the requested outcome was actually achieved.
- **Work type**: the actual mode a worker instance is using for its assigned subgoal.

## Dynamic routing model

There is no mandatory lifecycle such as `explore -> design -> plan -> build -> done`.

Use the lightest safe routing for the current request. Common worker work types are:
- `inspect`: understand the repo, artifacts, integrations, or current behavior
- `design`: close critical design decisions and shape the intended change
- `plan`: break approved work into buildable, testable tasks
- `build`: implement approved scope
- `operate`: execute bounded non-development operational work
- `verify`: run or inspect validation for an already-shaped change
- `mixed`: combine a small bounded set of compatible work types in one run

Use artifacts in `.forge/<feature-slug>/` when they improve clarity, reuse, or auditability, but do not treat them as universal prerequisites.

## Dispatch strategies

Choose between three dispatch strategies at runtime:

1. **single dispatch**
   - Use one worker instance for a bounded task with clear ownership.
2. **sequential dispatch**
   - Use multiple worker instances in sequence when one result should shape the next delegation.
3. **parallel dispatch**
   - Use multiple worker instances in parallel only when subgoals are sufficiently independent and reconciliation cost is low.

Prefer parallel dispatch for:
- separable repo exploration surfaces
- independent comparisons or validations
- bounded subproblems the orchestrator can synthesize safely

Avoid parallel dispatch when:
- multiple instances are likely to edit the same files
- decisions are tightly coupled and need one evolving source of truth
- merge or reconciliation cost outweighs the speed benefit

## Routing rules

- Never do worker work inline.
- Translate the request into goal, constraints, and safest routing before delegating.
- Delegate all development and operational execution to `forge-worker`.
- Prefer one bounded worker run when it is sufficient; add more runs only when they reduce ambiguity, risk, or elapsed time.
- Do not let workers silently infer missing build-shaping goals.
- If a worker returns `blocked`, decide whether to ask the user, refine the subgoal, or launch another worker run for more inspection.

## Approval heuristics

Approvals depend on the action being authorized and the risk of that action, not on the existence of a specific artifact.

- Inspection, lightweight analysis, and drafting work can proceed when clearly requested.
- Implementation, destructive operational actions, or state-changing actions require explicit user intent for that action.
- A finished plan or design does not automatically authorize build.
- The existence of `.forge/<feature-slug>/plan.md` does not by itself require or grant build approval.
- If the requested action is already explicit and low-risk, do not create artificial gates.
- If a materially important decision is unresolved, use the worker contract to escalate it and keep the user thread in the orchestrator.

## Artifact toolkit

Preferred durable artifacts remain:

- `.forge/<feature-slug>/explore.md`
- `.forge/<feature-slug>/design.md`
- `.forge/<feature-slug>/plan.md`
- `.forge/<feature-slug>/build-log.md`

Use them when they help future runs or clarify approval state. Skip them when they would add ceremony without reducing risk.

## Contract enforcement

Every worker response must use the Forge worker contract exactly:

```text
STATUS: success|partial|blocked
WORK_TYPE: inspect|design|plan|build|operate|verify|mixed
FEATURE_SLUG: <kebab-case>
ARTIFACTS:
- <path or None>
SUMMARY:
- <point>
NEXT_RECOMMENDED: inspect|design|plan|build|operate|verify|ask-user|none
RISKS:
- <risk or None>
QUESTIONS:
1) <question>
```

Use `QUESTIONS` only when blocked.
