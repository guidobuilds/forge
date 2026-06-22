---
name: using-forge
description: Route work through the lightest safe Forge workflow using dynamic runtime routing.
kind: skill
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

## Route announcement

Before the first dispatch, state the chosen route to the user: work types joined by arrows (e.g. `build -> verify`, `inspect -> build -> verify`, `inspect -> design -> plan -> build -> verify`), whether a `forge-grill` pass runs before build and an independent verify or `forge-adversary` gate runs after, and one clause on why it is the lightest safe route. Re-announce only when the route changes materially mid-flight.

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

## Worker sub-delegation

Forge uses **two levels below the orchestrator** (`DISPATCH_DEPTH` 0 → 1 → 2) across harnesses:

| Depth | Role | Artifact | Spawns |
|-------|------|----------|--------|
| 0 | orchestrator | `forge` | `forge-worker` |
| 1 | coordinator | `forge-worker` | `forge-worker-leaf` |
| 2 | terminal | `forge-worker-leaf` | nothing |

### Coordinator triggers

`forge-worker` **must** spawn leaves (or return `DELEGATION_REQUESTS` on Codex) when any: ≥ 8 file reads, ≥ 6 searches, ≥ 20 tool calls, ≥ 5 files to edit, `DELEGATION: required`, or plan implies ≥ 3 shards. **Never** sub-delegate `verify` or adversary work.

### Orchestrator dispatch hints

```text
DISPATCH_DEPTH: 0
DELEGATION: allowed|required|forbidden
EFFORT: low|medium|high
TASK_ID: <unique>
```

- Unfamiliar-repo `inspect` → `DELEGATION: allowed`
- Narrow bugfix → `DELEGATION: forbidden`
- Codex: parse `DELEGATION_REQUESTS` and fan out `forge-worker-leaf` yourself

## Routing rules

- Never do worker work inline.
- Translate the request into goal, constraints, and safest routing before delegating.
- Announce the chosen route to the user before the first dispatch (see Route announcement).
- Run `forge-grill` proactively: stress-test any plan or design before build when work is non-trivial, risk-bearing, multi-step, or carries unresolved assumptions. Skip for trivial, surgical, or read-only work.
- Delegate all development and operational execution to `forge-worker`.
- Prefer one bounded worker run when it is sufficient; add more runs only when they reduce ambiguity, risk, or elapsed time.
- Do not let workers silently infer missing build-shaping goals.
- If a worker returns `blocked`, decide whether to ask the user, refine the subgoal, or launch another worker run for more inspection.
- Size the state model to the work (see State model): skip it for trivial changes; add it for non-trivial or multi-session work.
- For non-trivial work, do not accept a builder's self-certified `passing`; dispatch a separate verify run to confirm it (`forge-adversary` for risk-bearing work, else a `forge-worker` verify run).
- Delegate by size: handle inline only a 1-3 file read, a mechanical known write, or a git status check; delegate to `forge-worker` when the work needs 4+ files read, multi-file analysis or writes, or running tests/builds/installs. Inside a coordinator run, ≥ 8 reads or the sub-delegation triggers above → `forge-worker-leaf`. The orchestrator thread stays thin because it accumulates summaries, not implementations.
- Assign an effort level per dispatch (see Effort routing).
- When `.forge/repo-facts.md` or `.forge/lessons.md` exist, have the worker read them so it reuses known facts and avoids repeating past mistakes.

## Approval heuristics

Approvals depend on the action being authorized and the risk of that action, not on the existence of a specific artifact.

- Inspection, lightweight analysis, and drafting work can proceed when clearly requested.
- Implementation, destructive operational actions, or state-changing actions require explicit user intent for that action.
- A finished plan or design does not automatically authorize build.
- The existence of `.forge/<feature-slug>/plan.md` does not by itself require or grant build approval.
- If the requested action is already explicit and low-risk, do not create artificial gates.
- If a materially important decision is unresolved, use the worker contract to escalate it and keep the user thread in the orchestrator.

## Effort routing

Match model effort to the work, not the reverse — higher effort spends more reasoning and tool calls, not more speed, so over-spending wastes tokens and time for the same result. State an effort level in each dispatch:

- **low**: `inspect`, `verify`, `operate`, and routine/mechanical `build`.
- **medium**: most `build` and `plan`.
- **high**: `design`, hard trade-offs, synthesis across many worker results, or genuinely novel build.

When unsure, start low and escalate only if the result is insufficient. The host harness owns actual model selection; this is the routing intent the orchestrator states and the worker honors.

## Artifact toolkit

Preferred process artifacts (write when they help future runs or clarify approval state):

- `.forge/<feature-slug>/explore.md`
- `.forge/<feature-slug>/design.md`
- `.forge/<feature-slug>/plan.md`
- `.forge/<feature-slug>/build-log.md`

State-model artifacts (the source of truth for non-trivial or multi-session work, see State model):

- `.forge/<feature-slug>/feature-list.json` — unit-of-work ledger: `behavior` + `verification` + `state`
- `.forge/<feature-slug>/verification.md` — recorded verification evidence (the Definition of Done store)
- `.forge/<feature-slug>/progress.md` — session continuity log
- `.forge/<feature-slug>/session-handoff.md` — cross-session / blocked handoff

Project-scoped files (persist across features, not under a slug):

- `.forge/repo-facts.md` — durable stack/commands/conventions/constraints (the standing "where to go" spec)
- `.forge/lessons.md` — topic-keyed accumulated lessons (the Feedback ratchet)
- `.forge/index.md` — one-line-per-slug cross-task ledger

Skip any artifact when it would add ceremony without reducing risk. `forge-worker` owns the exact schema and templates.

## State model (adaptive)

Size the state model to the work so the lightest safe workflow stays the default.

- **Trivial / surgical** (single-file, low-risk, obvious, no cross-session memory): no state artifacts. Route `build -> verify` (or `inspect -> build -> verify`). The builder may self-verify.
- **Single non-trivial feature**: create `feature-list.json` and `verification.md`. A separate verify dispatch must record evidence before any feature reaches `passing`.
- **Multi-feature / multi-session / blocked / handoff-likely**: also create `progress.md` and `session-handoff.md`; carry multiple `feature-list.json` entries with `dependencies`.

Triggers:
- Create `feature-list.json` when the request decomposes into one or more verifiable behaviors and the work is state-changing, risky, or judged on "is it done?".
- Create `progress.md` when work spans more than one mutating worker run, or a run returns `partial`/`blocked`.
- Create `session-handoff.md` when a session ends with any non-`passing` feature, or a later session is anticipated.
- Bootstrap `.forge/repo-facts.md` on the first non-trivial change to an unfamiliar repo (an `inspect` dispatch); reuse it thereafter.
- Record lessons in `.forge/lessons.md` after any run that made a decision, fixed a non-obvious bug, set a convention, or hit a failure.
- Never create state artifacts for read-only inspection or one-shot obvious edits.

Feature `state` is one of `not_started | active | blocked | passing`. The orchestrator owns transitions: a builder may move `not_started -> active`, but only a verify dispatch (`forge-adversary` or a `forge-worker` verify run) moves a feature to `passing` (or `-> blocked` on failure).

Closure: when a feature reaches `passing`, the verify dispatch flushes durable lessons to `.forge/lessons.md` and appends a line to `.forge/index.md`. When all features in a slug are `passing` and their `archiveWhen` conditions hold, the slug may be archived under `.forge/_archive/<slug>/`.

## Definition of Done

A feature's `state` may become `passing` only when ALL hold:

1. its `verification` command was actually run,
2. the result is recorded in `.forge/<feature-slug>/verification.md` (command + output excerpt + pass verdict + timestamp),
3. `evidence` in `feature-list.json` points to that entry,
4. every `id` in its `dependencies` is already `passing`.

No feature moves to `passing` on assertion alone, and never by weakening, deleting, skipping, or stubbing the check; the recorded output must actually exercise the named `behavior`. A failed or unrun verification keeps it `active` or moves it to `blocked` with a one-line reason.

Independent, adversarial verification: for non-trivial work the builder may NOT self-certify. Dispatch a SEPARATE verify run whose job is to try to *disprove* "done" — use `forge-adversary` for risk-bearing work (the dedicated breaker) and a `forge-worker` `WORK_TYPE: verify` run otherwise. It runs the verification commands, judges strictly, and for risk-bearing features refutes across up to three distinct lenses, keeping `passing` only if at least two fail to refute. It writes `verification.md` (logging refuted/uncertain candidates too) and flips states. Build and verify are different instances. Trivial-tier work is exempt.

## Contract enforcement

Every worker response must use the Forge worker contract exactly:

```text
STATUS: success|partial|blocked
WORK_TYPE: inspect|design|plan|build|operate|verify|mixed
FEATURE_SLUG: <kebab-case>
DISPATCH_DEPTH: 0|1|2
WORKER_ROLE: coordinator|leaf
ARTIFACTS:
- <path or None>
SUMMARY:
- <point>
SUB_RESULTS:
- task_id: <id> | status: success|partial|blocked | work_type: <type> | summary: <one line>
DELEGATION_REQUESTS:
- task_id: <id> | work_type: <type> | role: leaf | parallel: true|false | subgoal: <bounded> | files_hint: <paths or None>
NEXT_RECOMMENDED: inspect|design|plan|build|operate|verify|sub-delegate|ask-user|none
RISKS:
- <risk or None>
QUESTIONS:
1) <question>
```

Use `QUESTIONS` only when blocked. `SUB_RESULTS` / `DELEGATION_REQUESTS` optional. Missing depth/role fields → treat as coordinator at depth 1 during transition.
