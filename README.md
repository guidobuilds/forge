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

For smaller and clearer changes, Forge can use shorter paths such as:

```text
explore -> plan -> build -> done
explore -> build -> done
build -> done
```

The exact routing, approval, and clarification rules live in the canonical skills rather than this README. This document stays descriptive so policy can evolve in one place.

## Operating Principles

Forge is designed around four simple principles:
- think before coding
- prefer the simplest viable change
- keep changes surgical and local
- define goals and verification before execution

These principles are enforced by the skills that own Forge behavior.

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
- `forge-explore`: exploration rigor, assumptions/unknowns/tradeoffs capture, and escalation rules
- `forge-design`: design-gate policy, question quality, and `design.md` structure
- `forge-plan`: planning policy, file map, buildability, and `plan.md` expectations
- `forge-build`: plan review, build-phase scope, approval, validation, and `build-log.md` expectations
- `forge-helper`: bounded helper execution and confirmation rules

These skills are internal Forge assets, not plugins.

## Policy Ownership Map

Behavioral policy is intentionally centralized:

| Concern | Canonical owner |
| --- | --- |
| Shared workflow, operating principles, approval semantics | `skills/using-forge/SKILL.md` |
| Explore-phase rigor and artifact shape | `skills/forge-explore/SKILL.md` |
| Design clarification gate and design quality rules | `skills/forge-design/SKILL.md` |
| Planning, task slicing, and verification planning | `skills/forge-plan/SKILL.md` |
| Build discipline and validation reporting | `skills/forge-build/SKILL.md` |
| Helper scope and operational confirmations | `skills/forge-helper/SKILL.md` |
| Agent contracts and execution wrappers | `agents/*.md` |
| User-facing overview and installation docs | `README.md` |

In short: skills own behavioral policy, agents stay thin, and the README describes the system without re-specifying the full rules.

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
- `forge-explore/SKILL.md`
- `forge-design/SKILL.md`
- `forge-plan/SKILL.md`
- `forge-build/SKILL.md`
- `forge-helper/SKILL.md`

If you still have an older Forge installation, also remove these legacy agent files if present:

- `forge-spec.md`
- `forge-tech.md`
