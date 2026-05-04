# Forge

Forge is a personal project for working with code agents more reliably.

It started as a way to get better results from OpenCode, and now also supports Codex and Claude Code. The idea is to give agents a lightweight operating model for turning vague software requests into smaller, safer, verifiable changes without adding a heavy process around them.

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

## Durable Context

When a task benefits from persistent context, Forge writes notes under `.forge/<feature-slug>/`.

These notes are useful for:

- resuming work across agent sessions
- reviewing the reasoning behind a change
- keeping implementation aligned with approved decisions
- making follow-up work easier to delegate

Small, obvious changes do not need ceremony. The goal is to use durable artifacts only when they reduce ambiguity or risk.

## Supported Agents

Forge currently installs support for:

- OpenCode
- Codex
- Claude Code

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

## Local Development

From a local checkout:

```sh
npm install
npm run build
node bin/forge-ai.mjs install --source . --platform all --scope user
```

To preview local output without writing:

```sh
node bin/forge-ai.mjs install --source . --platform all --scope project --dry-run
```

## Updating

Run the npm updater:

```sh
npx @guidobuilds/forge-ai update
```

Forge replaces its managed agent and skill definitions in your supported agent configuration directories.

Forge records installed files in manifests under `~/.forge-ai/` so updates can safely remove files that are no longer bundled. `update` prunes stale managed files by default only when the current file still matches the recorded checksum; use `--no-prune` to keep stale managed files. `--dry-run` previews writes and deletes without changing files or manifests.

## Uninstalling

Remove Forge from the agent configuration directories for OpenCode, Codex, or Claude Code by deleting the installed Forge agent and skill entries.

If you installed Forge for multiple tools, repeat the removal for each one you no longer want to use.

## Project Status

Forge is experimental and personal.

There is no promise that the workflow will stay stable or that every agent/tool combination will keep working the same way. I am using it, changing it, and keeping the parts that make agent work better in practice.

Feedback, issues, and pull requests are welcome, especially when they come from real usage.
