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

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.sh | bash
```

### Windows

```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.ps1').Content))"
```

Re-run the installer at any time to update Forge in place.

## Install From A Specific Ref

Use `FORGE_REF` to install a branch, tag, or other ref.

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.sh | FORGE_REF=<ref> bash
```

### Windows

```powershell
$env:FORGE_REF = '<ref>'
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.ps1').Content))"
```

## Local Development

From a local checkout:

```sh
bash install.sh
```

To force installation from the local files instead of downloading from GitHub:

```sh
bash scripts/install.sh
```

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

## Updating

Run the installer again:

```sh
curl -fsSL https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.sh | bash
```

Forge replaces its managed agent and skill definitions in your supported agent configuration directories.

## Uninstalling

Remove Forge from the agent configuration directories for OpenCode, Codex, or Claude Code by deleting the installed Forge agent and skill entries.

If you installed Forge for multiple tools, repeat the removal for each one you no longer want to use.

## Project Status

Forge is experimental and personal.

There is no promise that the workflow will stay stable or that every agent/tool combination will keep working the same way. I am using it, changing it, and keeping the parts that make agent work better in practice.

Feedback, issues, and pull requests are welcome, especially when they come from real usage.

## Contributing

Forge is open source and contributions are welcome.

Good contributions tend to improve one of these areas:

- clearer agent behavior
- safer routing and approval rules
- better installation and update experience
- sharper documentation
- examples from real code-agent workflows

Please keep changes small, practical, and aligned with Forge's core bias: the lightest safe workflow and the smallest viable change.
