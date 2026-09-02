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

Install with the npm CLI:

```sh
npx @guidobuilds/forge-ai install
```

The installer prompts for the target agent platform, whether Forge should be installed globally for your user or locally for the current project, and — interactively — which model each agent should use: keep each agent's recommended default, or choose per agent. For OpenCode, the per-agent prompt shows the models you actually have configured (via `opencode models`, falling back to free-text entry if that command isn't available), not a generic list.

To choose models non-interactively (requires an explicit single `--platform` — model ids aren't portable across platforms):

```sh
npx @guidobuilds/forge-ai install --platform claude --scope user --model opus --yes
npx @guidobuilds/forge-ai install --platform opencode --scope user --model-map forge=anthropic/claude-opus-4-1,forge-worker=anthropic/claude-sonnet-4-5 --yes
```

`--model` applies to every agent that supports a model on the target platform; `--model-map name=model,...` sets it per artifact. Choices persist across `update` — they are not silently reset back to the canonical default. To change a model later without a full reinstall, see [Configuring models](#configuring-models) below.

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
| `forge` | subagent (`model: opus`, structural `tools` allowlist) | mention it by name, `@forge`, or `claude --agent forge` |
| `forge-grill` | skill (`model: sonnet`, not user-invocable) | loaded automatically by `forge` before non-trivial or risk-bearing builds |
| `using-forge` | skill (`model: sonnet`, not user-invocable) | loaded automatically by `forge` before routing work |
| `forge-worker` | subagent | coordinator; `forge` delegates via `Agent(forge-worker, forge-adversary)` |
| `forge-worker-leaf` | subagent | terminal shard; spawned by `forge-worker` (or orchestrator on Codex) |
| `forge-adversary` | subagent | the orchestrator delegates to it after build to gate risk-bearing work |

`forge` installs as a real Claude Code subagent with a structural `tools` allowlist (`Agent(forge-worker, forge-adversary)`, `TodoWrite`, `Skill`, `AskUserQuestion`) — it cannot Read/Write/Edit/Bash itself, only dispatch. It loads `using-forge` and `forge-grill` via the `Skill` tool and can still ask you clarifying questions directly (`AskUserQuestion` is retained for an agent running as the session's main driver, unlike a bounded sub-task dispatch). Requires **Claude Code v2.1.172+**.

To make `forge` the automatic default for a project (equivalent to the old `/forge` auto-load), add to `.claude/settings.json`:

```json
{ "agent": "forge" }
```

Without that, invoke it explicitly per session (mention it by name, `@forge`, or `claude --agent forge`). `forge-ai install`/`update`/`uninstall` manage `forge`'s own file; they do not write `settings.json` for you.

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
| `forge`, `forge-worker`, `forge-worker-leaf`, `forge-adversary` | agents (`.toml`) | `~/.codex/agents/` (or `.codex/agents/` per project) |
| `using-forge`, `forge-grill` | skills | `~/.agents/skills/` (or `.agents/skills/` per project) |

The CLI writes agent `.toml` files but does not generate `AGENTS.md` or profiles.

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

Forge records installed files in manifests under `~/.forge/state/` (migrated automatically and transparently from the earlier `~/.forge-ai/` on first run — the old directory is left in place, marked with a `MIGRATED` note, and never deleted automatically) so updates can safely remove files that are no longer bundled. `update` prunes stale managed files by default only when the current file still matches the recorded checksum; use `--no-prune` to keep stale managed files. `--dry-run` previews writes and deletes without changing files or manifests.

Forge routes a single canonical artifact to the right artifact kind per agent: the orchestrator installs as a real subagent on Claude Code, OpenCode, and Codex, and as a skill on Grok. If you installed an earlier version where Claude's orchestrator was a skill, run `update` (not `install`) so Forge prunes the now-stale `~/.claude/skills/forge/SKILL.md` left by the previous layout.

## Uninstalling

```sh
npx @guidobuilds/forge-ai uninstall
```

This removes exactly the files Forge's manifest recorded for the given `--scope` (default: `user`), refusing to silently delete anything you edited locally — a locally-modified file is backed up and requires `--yes`/`--force` (or interactive confirmation) before it's removed, mirroring `update`'s overwrite protection. Pass `--platform` to uninstall a single agent instead of all of them, and `--dry-run` to preview what would be removed.

## Listing installs

```sh
npx @guidobuilds/forge-ai list
```

Prints every recorded install — the user-scope one, if any, plus one line per project you've installed Forge into — with the Forge version, file count, platforms, and last-updated time for each.

## Configuring models

```sh
npx @guidobuilds/forge-ai configure --platform claude --scope user
```

Change which model an already-installed agent uses without a full reinstall. Interactively, it walks every agent on the given scope/platform that supports a model (using OpenCode's live `opencode models` output where applicable, same as `install`). Non-interactively, pass `--model <id>` or `--model-map name=model,...` (same rules as `install`: an explicit single `--platform`, no `--force`/`--yes` — the point of the command is to make a choice, not skip one). Only the affected files are rewritten; the manifest and every other installed platform are left untouched.

## Project Status

Forge is experimental and personal.

There is no promise that the workflow will stay stable or that every agent/tool combination will keep working the same way. I am using it, changing it, and keeping the parts that make agent work better in practice.

Feedback, issues, and pull requests are welcome, especially when they come from real usage.
