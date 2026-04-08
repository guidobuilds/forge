# Forge

Forge is a personal project for building and learning about code agents, focused on OpenCode.

Its goal is to help people get better results when working with code agents by providing a structured workflow and a small set of specialized agents.

## Status

Forge is experimental.

It is actively shaped by hands-on usage, and there is no guarantee that development will continue or that the workflow will remain stable over time.

## What Forge Is

Forge is an OpenCode-oriented workflow framework built around one orchestrator and four phase agents.

It is designed to:
- reduce ambiguity before implementation
- make agent work more structured and repeatable
- separate exploration, specification, planning, and execution
- support longer working sessions through context engineering and subagents
- improve the precision of code-agent-driven delivery

Forge is not a general-purpose product platform. It is a personal operating model for running code agents more effectively.

## How It Works

Forge uses a phased workflow.

The main agent, `forge`, acts as the orchestrator. It decides which path is appropriate for the request and delegates the actual phase work to specialized subagents.

Standard flow:

```text
explore -> ask/spec loop -> plan -> build -> done
```

For smaller and clearer changes, Forge can use shorter paths such as:

```text
explore -> plan -> build -> done
explore -> build -> done
build -> done
```

The idea is simple: use the lightest workflow that still gives enough clarity and safety.

## Agents

Forge installs five OpenCode agent definition files:

- `forge.md`: the main orchestrator that routes work and selects the workflow
- `forge-explore.md`: inspects the repository and captures what already exists, its current state, and relevant intersections with the rest of the codebase
- `forge-spec.md`: produces the source-of-truth spec for code agents, optimized for implementation precision
- `forge-plan.md`: defines the execution order as building tasks, including expected outcomes for each task
- `forge-build.md`: executes the approved work and reports implementation and validation outcomes

## Installation

Forge installs the managed agent files into your OpenCode agents directory by fetching them from `raw.githubusercontent.com`.

Default ref: `main`

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.sh | bash
```

Installed to:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/opencode/agents
```

### Windows

```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/install.ps1').Content))"
```

Installed to:

```text
$env:APPDATA\opencode\agents
```

## Updating

Re-run the installer to overwrite the managed Forge agent files in place.

## Local checkout fallback

If you are developing locally or prefer running from a checkout, these commands remain supported:

### macOS / Linux

```sh
sh install.sh
```

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

## Optional ref override

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
- `forge-spec.md`
- `forge-plan.md`
- `forge-build.md`
