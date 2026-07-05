# Forge

Forge is a personal project for working with code agents more reliably.

It started as a way to get better results from OpenCode, and now also supports Claude Code, Codex and Grok Build. The idea is to give agents a lightweight operating model for turning vague software requests into smaller, safer, verifiable changes without adding a heavy process around them.

Forge is experimental. It is shaped by hands-on use, and the workflow may change as I learn what works and what does not.

## Why It Exists

Code agents are useful, but they often fail in predictable ways: they start coding too early, lose context between steps, overbuild, or make changes without a clear verification path.

Forge is my attempt to make that work more disciplined:

- clarify intent before implementation when it matters
- choose the smallest safe workflow for each request
- keep long-running context in durable project notes
- separate orchestration from execution
- make verification part of the work, not an afterthought

Forge is intentionally minimal. It is not a plugin marketplace, a new IDE, or a replacement for your agent. It is just a small workflow layer for getting agents to pause, inspect, plan when needed, and verify their work.

## What It Does

Forge adds a structured agent workflow for:

- inspect an existing codebase before making changes
- produce design notes for ambiguous or high-risk work
- turn approved direction into an executable plan
- implement focused changes with a minimum-change bias
- run or document validation after implementation
- preserve important decisions and follow-ups under `.forge/`

For simple requests, Forge should stay out of the way and take the shortest safe path. For larger changes, it can slow the process down just enough to reduce rework and bad assumptions.

## How It Works

Forge uses a thin orchestrator and a single worker model.

The orchestrator decides how much process a request needs. The worker does the actual inspection, design, planning, building, operating, or verification work. This keeps the user conversation focused while still giving the agent a repeatable execution pattern.

Typical routes include:

```text
inspect -> build -> verify
inspect -> design -> plan -> build -> verify
build -> verify
```

There is no mandatory lifecycle. Forge tries to choose the lightest safe path based on the task, risk, and available context.

Before delegating, the orchestrator states the chosen route to the user — the work types it plans to run, whether `forge-grill` runs before build, and why it is the lightest safe path for that request. For non-trivial work, it then presents an approval brief — conclusions, planned tasks, why — and waits for an explicit go-ahead before the first build dispatch.

## Durable Context

When a task benefits from persistent context, Forge writes notes under `.forge/<feature-slug>/`.

These notes are useful for:

- resuming work across agent sessions
- reviewing the reasoning behind a change
- keeping implementation aligned with approved decisions
- making follow-up work easier to delegate

Small, obvious changes do not need ceremony. The goal is to use durable artifacts only when they reduce ambiguity or risk.

### State model for non-trivial work

For non-trivial or multi-session work, Forge keeps a small state model under `.forge/<feature-slug>/`, sized to the task:

- `feature-list.json` — the unit-of-work ledger. Each feature carries the triple `behavior` + `verification` (a runnable command) + `state` (`not_started | active | blocked | passing`), plus a `tasks[]` execution ledger (title, files, expected outcome, validation, state) so any agent can resume mid-build.
- `verification.md` — recorded verification evidence: the command, its output, and a pass/fail verdict.
- `progress.md` / `session-handoff.md` — session continuity and handoff, written when work spans sessions or blocks.

Before build starts on non-trivial work, Forge presents an approval brief — conclusions, the planned tasks, and why — and waits for an explicit go-ahead; a finished plan does not authorize build by itself.

Two rules make "done" mean done:

- **Definition of Done.** A feature only reaches `passing` once its verification command was actually run and the evidence is recorded in `verification.md`. No feature is marked done on assertion alone.
- **Independent verification.** For non-trivial work the builder does not certify its own work. The orchestrator dispatches a separate `forge-worker` verify run that re-runs the checks and flips the state.

Trivial, surgical changes skip all of this and stay on the `build -> verify` path.

## Supported Agents

Forge currently installs support for:

- OpenCode
- Codex
- Claude Code
- Grok Build

The same operating model is shared across all supported agents so the workflow stays mostly consistent even when the underlying tool changes.

## Installation

The primary installer is the npm CLI:

```sh
npx @guidobuilds/forge-ai install
```

The installer prompts for the target agent platform and whether Forge should be installed globally for your user or locally for the current project.

To update an existing install:

```sh
npx @guidobuilds/forge-ai update
```

For non-interactive environments:

```sh
npx @guidobuilds/forge-ai install --platform all --scope user --yes
```

Preview the files without writing them:

```sh
npx @guidobuilds/forge-ai install --platform all --scope user --dry-run
```

Validate a local Forge source tree:

```sh
npx @guidobuilds/forge-ai validate --source .
```

## How to Use

Forge installs the **same operating model** on every agent, but **how you invoke it differs per platform**, because each agent exposes different primitives (skills, subagents, agent switching). The installer is only step one — this section is how you actually drive Forge once it is installed.

### The pieces

Forge is one orchestrator, a two-tier worker model, and a dedicated adversary, with two supporting skills:

- **`forge`** — the orchestrator. It talks to you, decides how much process a task needs, and delegates the real work. It does not edit code itself.
- **`forge-worker`** — the coordinator worker. It executes bounded subgoals and spawns `forge-worker-leaf` when context would grow too large (~100k-token peak).
- **`forge-worker-leaf`** — the terminal worker. It runs one bounded shard with no sub-delegation.
- **`forge-adversary`** — the breaker. After a build, the orchestrator dispatches it to *try to break* the work — logically and technically (logic/requirements, runtime, security, performance). It gates the Definition of Done: a confirmed, reproducible break keeps the feature out of `passing`. It complements `forge-grill`, which grills plans *before* building.
- **`using-forge`** — the shared operating-model skill the orchestrator follows.
- **`forge-grill`** — an orchestrator mode for stress-testing a plan or design before building. The orchestrator invokes it proactively before non-trivial or risk-bearing builds; also available as `/forge-grill` for manual use.

What changes per platform is the **kind** each piece is installed as, and therefore how you trigger it.

### Claude Code

| Piece | Installed as | How you invoke it |
|---|---|---|
| `forge` | skill (`model: opus`) | type `/forge` in the prompt — the only Forge skill you invoke directly |
| `forge-grill` | skill (`model: sonnet`, not user-invocable) | loaded automatically by `forge` before non-trivial or risk-bearing builds |
| `using-forge` | skill (`model: sonnet`, not user-invocable) | loaded automatically by `forge` before routing work |
| `forge-worker` | subagent | coordinator; main thread delegates via `Agent` (or legacy `Task`) |
| `forge-worker-leaf` | subagent | terminal shard; spawned by `forge-worker` (or orchestrator on Codex) |
| `forge-adversary` | subagent | the orchestrator delegates to it after build to gate risk-bearing work |

Start a session by typing **`/forge`**. That loads the orchestrator role into your main Claude Code thread, which delegates each bounded task to `forge-worker`, which may spawn `forge-worker-leaf` for heavy inspect/build shards. Requires **Claude Code v2.1.172+** for nested sub-agents. `forge-grill` and `using-forge` are marked `user-invocable: false`: Claude still loads and runs them as part of `forge`'s routing, but they no longer appear in the `/` menu or run as standalone commands — `forge` is the single entry point.

> Why a skill and not an agent on Claude? The main thread retains `Agent`/`Task` and can delegate. A skill injects orchestrator behavior without replacing the main agent. The trade-off: "delegate, never do worker work inline" is followed by instruction at the orchestrator layer, not by tool restrictions — but `forge-worker` **can** structurally spawn leaves when given `Agent` in its tool list.

### OpenCode

| Piece | Installed as | How you invoke it |
|---|---|---|
| `forge` | primary agent | switch your active agent to `forge` |
| `forge-worker` | subagent | coordinator; `forge` delegates with `task: allow` |
| `forge-worker-leaf` | subagent | terminal shard; spawned by coordinator (`task: deny`) |
| `forge-adversary` | subagent | the `forge` agent delegates to it to gate risk-bearing work after build |
| `using-forge`, `forge-grill` | skills | loaded by the agent as needed |

Switch your primary agent to **`forge`**. Unlike Claude Code, the orchestrator here is a real agent with file and shell tools **denied**, so it is *structurally* forced to delegate to the `forge-worker` subagent instead of doing the work itself.

### Codex

| Piece | Installed as | Location |
|---|---|---|
| `forge`, `forge-worker`, `forge-adversary` | agents (`.toml`) | `~/.codex/agents/` (or `.codex/agents/` per project) |
| `using-forge`, `forge-grill` | skills | `~/.agents/skills/` (or `.agents/skills/` per project) |

Codex support is the most partial of the three: Forge writes the agent `.toml` files but does not generate `AGENTS.md` or profiles, so wiring them into a Codex run may take manual steps. Treat Codex support as experimental.

### Project vs user scope

### Grok Build

| Piece | Installed as | How you invoke it |
|---|---|---|
| `forge` | skill | type `/forge` in the prompt |
| `forge-grill` | skill | type `/forge-grill` |
| `using-forge` | skill | `/using-forge` (usually pulled in by `/forge`) |
| `forge-worker` | subagent | coordinator; main thread delegates via `task` |
| `forge-worker-leaf` | subagent | terminal shard; spawned by coordinator |
| `forge-adversary` | subagent | the orchestrator delegates to it after build to gate risk-bearing work |

Start a session by typing **`/forge`**. Like Claude Code, the orchestrator runs as a skill in the main Grok session, which then delegates bounded work to the `forge-worker` subagent. Grok uses its own tool IDs (`run_terminal_cmd`, `grep_search`, `search_replace`, etc.) — the installer translates the worker's toolset automatically.

> **Note:** Grok Build already auto-discovers skills and agents from `~/.claude/` for compatibility. If you have a Claude Code install, Grok may partially pick up those files — but with Claude tool names that Grok doesn't recognize. A native Grok install (`--platform grok`) writes `.grok/`-scoped files with the correct Grok tool IDs.

### Project vs user scope

With `--scope user` (the default) the definitions live under your home directory and apply everywhere. With `--scope project` they live in the repo (`.claude/`, `.opencode/`, `.codex/`, `.agents/`, `.grok/`) and apply only there. Invocation is identical either way.

## Optional: enforce the gate with hooks (Claude Code)

Forge's Definition of Done is followed by instruction, not enforced — strong models honor the gate from the operating model alone. If you want the verification gate enforced *mechanically* on Claude Code (e.g. for unattended runs), add an opt-in hook to your `.claude/settings.json`. Keep it thin: a safety net for the one invariant that must hold, not a compliance layer.

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "<your project's verification command, e.g. pnpm test --silent>" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "<your fast type/lint check, e.g. pnpm typecheck>" } ] }
    ]
  }
}
```

The **Stop** hook re-runs your checks when the agent tries to finish, so a failing gate blocks a premature "done"; the **PostToolUse** hook surfaces type/lint errors after each edit for mid-task self-correction. Point the Stop hook at fast unit checks and leave slow suites to CI. This is intentionally optional — reach for it only when you want the gate enforced without you in the room.

## Local Development

Forge uses [pnpm](https://pnpm.io) for development (pinned via `packageManager` in `package.json`, so `corepack enable` is enough — no global install needed). The published package is still consumed by end users via `npx`/npm, unchanged.

From a local checkout:

```sh
pnpm install
pnpm run build
node bin/forge-ai.mjs install --source . --platform all --scope user
```

To preview local output without writing:

```sh
node bin/forge-ai.mjs install --source . --platform all --scope project --dry-run
```

## Updating

If you have Forge installed globally, the simplest way is:

```sh
forge-ai self-update
```

This detects how the CLI was installed (pnpm global, npm global, Homebrew npm, etc.) and runs the right upgrade command — including the `--prefer-online` flag that sidesteps pnpm's metadata cache when a new version was just published. After bumping the binary, it automatically runs `forge-ai update` to refresh the spec kit.

Forge also pings the registry on every interactive run and prints a one-line notice when a newer version is available, so you don't have to remember to check.

If you don't have a global install (running via `npx`):

```sh
npx @guidobuilds/forge-ai@latest update
```

Forge replaces its managed agent and skill definitions in your supported agent configuration directories.

Forge records installed files in manifests under `~/.forge-ai/` so updates can safely remove files that are no longer bundled. `update` prunes stale managed files by default only when the current file still matches the recorded checksum; use `--no-prune` to keep stale managed files. `--dry-run` previews writes and deletes without changing files or manifests.

Forge now routes a single canonical artifact to the right artifact kind per agent: the orchestrator installs as a Claude Code skill (`/forge`) but as an agent on OpenCode and Codex. If you installed an earlier version, run `update` (not `install`) so Forge prunes the now-stale `forge` agent and standalone `forge-worker` skill left by the previous layout.

## Uninstalling

Remove Forge from the agent configuration directories for OpenCode, Codex, or Claude Code by deleting the installed Forge agent and skill entries.

If you installed Forge for multiple tools, repeat the removal for each one you no longer want to use.

## Project Status

Forge is experimental and personal.

There is no promise that the workflow will stay stable or that every agent/tool combination will keep working the same way. I am using it, changing it, and keeping the parts that make agent work better in practice.

Feedback, issues, and pull requests are welcome, especially when they come from real usage.
