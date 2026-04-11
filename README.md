# Forge

Forge is a personal project for building and learning about code agents, focused on OpenCode.

Its goal is to help people get better results when working with code agents by providing a structured workflow, durable markdown artifacts, and a small set of specialized agents plus reusable skills.

## Status

Forge is experimental.

It is actively shaped by hands-on usage, and there is no guarantee that development will continue or that the workflow will remain stable over time.

## What Forge Is

Forge is an OpenCode-oriented workflow framework built around one orchestrator, four phase agents, one helper agent, and reusable skills.

It is designed to:
- reduce ambiguity before implementation
- keep agent behavior structured and repeatable
- keep durable context in markdown artifacts under `.forge/`

Forge is not a plugin platform.

It is a an operating model for running code agents more effectively while staying minimal.

## How It Works

Forge uses a phased workflow.

The main agent, `forge`, acts as the orchestrator. It decides which path is appropriate for the request and delegates the actual phase work to specialized subagents.

Standard flow:

```text
explore -> design -> plan -> build -> done
```

Phase responsibilities:
- `explore`: what exists
- `design`: close critical decisions first, then capture what should change and the intended technical shape in one artifact
- `plan`: execution order derived from the approved design, without redefining it
- `build`: implementation plus validation reporting

Operational helper responsibilities:
- `helper`: non-development execution tasks that support the orchestrator, such as git commit or git push, without writing code or implementing features

Important: a successful `plan` phase does not automatically authorize `build`. Forge should stop after planning and ask for explicit user approval before implementation unless the user already clearly approved implementation in the same request.

Important: `design` includes an internal clarification gate. If critical decisions are still open after exploration, Forge stays in `design`, asks only the smallest useful batch of questions with explicit recommendations, and does not write `design.md` until those decisions are resolved.

For smaller and clearer changes, Forge can use shorter paths such as:

```text
explore -> plan -> build -> done
explore -> build -> done
build -> done
```

The shortened paths still follow the same approval rule: `plan -> build` requires explicit user approval, while direct `build` is reserved for lightweight, tightly bounded requests that are already clear enough to implement safely.

The idea is simple: use the lightest workflow that still gives enough clarity and safety.

## Canonical Artifacts

Forge phases use a stable artifact convention under `.forge/<feature-slug>/`:

- `explore.md`: what exists
- `design.md`: merged product and technical design, with stable `TASK-*` requirements and a concise `Decision Log` for critical design decisions resolved during clarification
- `plan.md`: execution order derived from the approved design, without restating it
- `build-log.md`: implementation record, validation performed, and any deviations or follow-ups

## Agents

Forge installs six OpenCode agent definition files:

- `forge.md`: the main orchestrator that routes work and selects the workflow
- `forge-explore.md`: inspects the repository and captures what already exists, its current state, and relevant intersections with the rest of the codebase in `explore.md`
- `forge-design.md`: closes critical design questions and then produces the canonical `design.md` artifact
- `forge-plan.md`: defines the execution order in `plan.md` from the approved design artifact, with a concrete file map and buildable tasks
- `forge-build.md`: executes the approved work, reviews plans critically before implementation, and reports implementation and validation outcomes in `build-log.md`
- `forge-helper.md`: executes non-development operational tasks for the orchestrator, such as commit or push, without doing code implementation

## Skills

Forge installs reusable markdown skills that hold the canonical operating knowledge for the framework:

- `using-forge`: workflow selection, routing, artifact conventions, and approval rules
- `forge-design`: design-gate policy, question quality, and `design.md` structure
- `forge-plan`: planning policy, file map, buildability, and `plan.md` expectations
- `forge-build`: plan review, build-phase scope, approval, validation, and `build-log.md` expectations

These skills are internal Forge assets, not plugins.

## Installation

Forge installs the managed agent files and skill files into your OpenCode configuration directories by fetching them from `raw.githubusercontent.com`.

Default ref: `main`

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.sh | bash
```

Installed to:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/opencode/agents
${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills
```

### Windows

```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.ps1').Content))"
```

Installed to:

```text
$env:APPDATA\opencode\agents
$env:APPDATA\opencode\skills
```

## Updating

Re-run the installer to overwrite the managed Forge agent and skill files in place.

The installer also removes the obsolete legacy agents `forge-spec.md` and `forge-tech.md` if they are still present from an older installation.

## Local Checkout Fallback

If you are developing locally or prefer running from a checkout, these commands remain supported:

### macOS / Linux

```sh
sh install.sh
```

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

## Optional Ref Override

The installers use `main` by default.

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.sh | FORGE_REF=<ref> bash
```

### Windows

```powershell
$env:FORGE_REF = '<ref>'
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.ps1').Content))"
```

Clear `FORGE_REF` afterward if you do not want it to affect later runs.

## Uninstall

Delete these files from your OpenCode agents directory:

- `forge.md`
- `forge-explore.md`
- `forge-design.md`
- `forge-plan.md`
- `forge-build.md`
- `forge-helper.md`

Delete these skill files from your OpenCode skills directory:

- `using-forge/SKILL.md`
- `forge-design/SKILL.md`
- `forge-plan/SKILL.md`
- `forge-build/SKILL.md`

If you still have an older Forge installation, also remove these legacy agent files if present:

- `forge-spec.md`
- `forge-tech.md`
