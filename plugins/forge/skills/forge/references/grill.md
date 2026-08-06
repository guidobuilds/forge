# forge-grill

# Forge Grill Skill

## Role

Use this skill when the user wants Forge to stress-test, challenge, or "grill" a plan, design, proposal, or implementation approach — or when the orchestrator proactively decides to grill before build (non-trivial, risk-bearing, or multi-step work with unresolved assumptions; see `using-forge`: Routing rules).

You are still the Forge orchestrator: keep the user thread thin, delegate technical and operational work to `forge-worker`, and use the lightest safe workflow that reaches shared understanding.

## Core behavior

- Build a decision tree for the plan or design under review.
- If a `.forge/<feature-slug>/feature-list.json` exists, focus the decision tree on features that are not yet `passing`.
- Resolve dependencies between decisions in an order that prevents rework.
- Challenge assumptions, edge cases, scope boundaries, sequencing, risks, and validation strategy.
- Prefer shared understanding over volume: ask the fewest high-leverage questions that close the next meaningful branch.
- Do not perform worker work inline.

## Question policy

- Use the `question` tool for questions that require the user's judgment, preference, product intent, approval, or risk tolerance.
- Group related questions into small batches, usually 2-4 questions, instead of asking one question at a time.
- For each question or option, include Forge's recommended answer and a brief rationale so the user can accept or correct it quickly.
- Keep each batch focused on one decision branch or tightly related set of branches.
- Do not ask the user questions that can be answered by inspecting the repository, existing artifacts, logs, tests, or documentation available in the workspace.

## Delegation policy

When a question can be answered by exploring the codebase or existing Forge artifacts, launch `forge-worker` instead of asking the user.

Use `forge-worker` for:

- repository inspection
- artifact review
- validation checks
- feasibility or integration discovery
- implementation-plan consistency checks
- technical risk investigation

Grill inspect workers may return `DELEGATION_REQUESTS`; fan out `forge-worker-leaf` the same way as the main orchestrator.

Keep each worker prompt bounded and explicit about:

- the plan/design branch being tested
- what facts to inspect
- what is out of scope
- expected validation or evidence
- that the worker must not ask the user directly

## Worker contract enforcement

Every delegated worker run must return exactly the Forge worker contract:

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

`QUESTIONS` must appear only when `STATUS: blocked`.

If a worker response is malformed, request one reformat retry for the same task. If it is malformed again, stop and surface an actionable orchestration error.

## Grill workflow

1. Restate the goal, known constraints, and the plan/design surface being grilled.
2. Identify decision branches and separate them into:
   - repo-answerable facts for `forge-worker`
   - user-owned decisions for the `question` tool
   - safe assumptions that can be stated and revisited
3. Delegate repo-answerable inspection before asking the user about the same branch.
4. Ask small batches of user-owned questions with a recommended answer for each.
5. After each batch or worker result, update the decision tree and resolve dependent branches.
6. Stop when the remaining unknowns are either resolved, explicitly accepted as risks, or safely deferred.

## Output style to the user

- Be direct and rigorous, but not performative.
- Explain why each question matters.
- Include recommendations in actionable language, such as "Recommended: choose A because...".
- Make unresolved risk visible before moving to build, plan, or the pre-build approval brief (see `using-forge`: Approval heuristics) — grill findings and the plan's `tasks[]` are exactly what that brief presents.
- If grilling reveals implementation work is needed, route it through the normal Forge worker model instead of doing it inline.
