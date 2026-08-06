# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions prior to 0.3.0 are not reconstructed here; see git history for earlier changes.

## [Unreleased]

## [0.7.0] - 2026-08-06

### Added

- **Claude Code plugin distribution channel** — Forge can now be installed as a Claude Code plugin (`/plugin marketplace add guidobuilds/forge` then `/plugin install forge@guidobuilds`), generated from the same canonical `artifacts/` source as the CLI via the new `forge-ai build-plugin` command. Claude Code only — other platforms remain CLI-only (`npx @guidobuilds/forge-ai install`). Plugin skills are namespaced, so the orchestrator is invoked as `/forge:forge` instead of `/forge`.
- **Codex plugin distribution channel** — a standalone, skills-only Forge plugin is available through the repository marketplace `guidobuilds-forge`. `forge-ai build-plugin --target codex` generates its public orchestrator skill and private worker, leaf, adversary, routing, and grill contracts without relying on `.codex/agents`.

## [0.6.0] - 2026-07-05

### Added

- **`forge-worker-leaf` agent** — terminal worker for bounded subgoal shards at `DISPATCH_DEPTH: 2`. No spawn tools (`task: deny` on OpenCode; no `Agent`/`task` on Claude/Grok). Installed alongside `forge-worker` on all platforms.
- **Worker sub-delegation** — `forge-worker` is now a coordinator that spawns `forge-worker-leaf` when context triggers fire (≥ 8 file reads, ≥ 6 searches, ≥ 20 tool calls, ≥ 5 files to build, or `DELEGATION: required`). Extended worker contract: `DISPATCH_DEPTH`, `WORKER_ROLE`, `SUB_RESULTS`, `DELEGATION_REQUESTS`, `NEXT_RECOMMENDED: sub-delegate`.
- **Pre-build approval gate** — for non-trivial work, the orchestrator presents an approval brief (conclusions, path/tasks, why) after inspect/design/plan (and `forge-grill` if it ran) and waits for the user's explicit approval before the first build dispatch. Trivial, explicit, low-risk requests remain self-approving — no artificial gate is created.
- **Per-feature `tasks[]` ledger** — each feature in `feature-list.json` can carry a `tasks[]` array (`id`, `title`, `workType`, `files`, `expectedOutcome`, `validation`, `state`) so any agent can resume mid-build knowing what a task was, what it touches, what "done" looks like, and how to validate it. `forge-worker` owns the schema.
- **Claude Code skill frontmatter** — canonical artifacts can now set `claude.when_to_use`, `claude.model`, and `claude.user-invocable` (Claude Code now supports `model` on skills, not just agents). Applied to the three artifacts that render as Claude Code skills: `forge` and `forge-grill` runs on `opus`, `forge` is the only one left user-invocable; `using-forge` run on `sonnet` and are set (along with `forge-grill`) `user-invocable: false` (Claude still loads them automatically; they no longer appear in the `/` menu or run as standalone commands).

### Changed

- **`forge-worker` frontmatter** — Claude adds `Agent`; Grok adds `task`, `get_task_output`, `kill_task`; OpenCode adds `task: allow`.
- **README** — corrects outdated claim that Claude subagents cannot spawn subagents. Nested sub-agents are supported since Claude Code v2.1.172 (platform max 5 levels); Forge caps at depth 2 by cross-harness policy.
- **`using-forge`**, **`forge`**, **`forge-grill`**, **`forge-adversary`** — document two-tier worker model and Codex `DELEGATION_REQUESTS` fan-out fallback.
- **Route announcement** — for non-trivial work, the announcement is now followed by the pre-build approval brief; re-announcing mid-flight also re-triggers approval.
- **`forge-worker` plan/build modes** — plan populates `tasks[]`; build flips task `state` (`not_started -> active -> done`) as it works. Task `done` is distinct from feature `state`, which only a verify dispatch can move to `passing`.
- **`forge-adversary`** — cross-checks that each task's `validation` was actually satisfied, not just the feature's top-level `verification` command.
- **`progress.md` / `session-handoff.md` templates** — now reference the active `<feature-id>/<task-id>` so a resuming agent finds its place immediately.
- **`renderClaudeSkill`** — no longer drops the `model` field for Claude Code skills; it now validates it against known Claude models the same way `renderClaudeAgent` does.

### Migration from 0.5.0

- Run `npx @guidobuilds/forge-ai update` to install `forge-worker-leaf` and refresh coordinator artifacts. Requires Claude Code **v2.1.172+** for structural sub-delegation on Claude.

## [0.5.0] - 2026-06-20

### Added

- **Grok Build (`--platform grok`) as a first-class target.** `forge`, `forge-grill`, and `using-forge` install as Grok skills under `.grok/skills/<name>/SKILL.md`; `forge-worker` and `forge-adversary` install as Grok subagents under `.grok/agents/<name>.md`. Grok's built-in tool IDs (`run_terminal_cmd`, `grep_search`, `search_replace`, etc.) are used in the worker and adversary toolsets, replacing the Claude-specific names. Included in `--platform all`. Grok Build v0.2.56+ required.

### Changed

- **Orchestrator route announcement**: before the first dispatch, the orchestrator now states the chosen route to the user — work types joined by arrows (e.g. `build -> verify`, `inspect -> build -> verify`, `inspect -> design -> plan -> build -> verify`), whether a `forge-grill` pass runs before build and an independent verify or `forge-adversary` gate runs after, and one clause on why it is the lightest safe route. Re-announced only when the route changes materially mid-flight.
- **Proactive `forge-grill`**: the orchestrator now runs `forge-grill` proactively before build for non-trivial, risk-bearing, or multi-step work with unresolved assumptions. Previously grill was effectively opt-in (user-triggered via `/forge-grill`). Trivial, surgical, and read-only work still skips grill.

### Migration from 0.4.0

- Run `npx @guidobuilds/forge-ai update` to add the new `forge-grill` and `using-forge` prompt changes and the Grok Build artifacts. No breaking changes to the CLI, state files, or existing Claude/OpenCode/Codex installs.

## [0.4.0] - 2026-06-16

### Added

- **Adaptive `.forge/<feature-slug>/` state model** for the orchestration harness, sized to task complexity. Trivial work stays on the `build -> verify` path with no artifacts; non-trivial or multi-session work gains a structured state ledger. Documented in `using-forge` (routing tiers + triggers) and `forge-worker` (schema + templates). No distribution-engine change — the state files are runtime-generated by the worker.
- **`feature-list.json` feature-list primitive**: the unit-of-work ledger where each feature carries the triple `behavior` + `verification` (a runnable command) + `state` (`not_started | active | blocked | passing`), plus `evidence` and `dependencies`.
- **Definition of Done with verification-evidence gating**: a feature reaches `passing` only after its verification command was actually run and recorded in `verification.md`; never on assertion alone.
- **Independent verification**: for non-trivial work the builder may not self-certify; the orchestrator dispatches a separate `forge-worker` verify run that re-runs the checks and flips state.
- **`forge-adversary` agent — dedicated post-build red-team gate.** A new subagent (`kind: agent`; OpenCode subagent, Claude agent) the orchestrator dispatches *after* build to break a worker's output across four lenses (logical/requirements, technical/runtime, security, performance/scale). It writes reproductions under `.forge/<slug>/adversary/`, records every attempt in `verification.md`, and gates the Definition of Done — a confirmed, reproducible break moves the feature to `blocked`; it never edits the implementation under test. Reports `WORK_TYPE: verify`, so the worker contract is unchanged. Complements `forge-grill` (which grills plans/designs *before* build). `forge`, `using-forge`, and `forge-worker` updated to dispatch it for risk-bearing work.
- **Persisted handoff/progress**: `progress.md` and `session-handoff.md` templates for cross-session continuity, created adaptively when work spans sessions or blocks.
- `forge-ai self-update` command. Detects how the CLI is installed (pnpm global, npm global, Homebrew npm, npx, or unknown) and runs the right update command with the right flags (`--prefer-online` for pnpm to sidestep its metadata cache). After updating the binary it automatically runs `forge-ai update` to refresh the spec kit. Flags: `--to <version>` to pin a specific version, `--dry-run` to preview, `--skip-spec-update` to only bump the CLI.
- Background version check on every interactive run. Calls the npm registry (with 1.5s timeout, cached for 1h at `~/.forge-ai/version-check.json`) and prints `forge-ai vX.Y.Z (vA.B.C available — run \`forge-ai self-update\` to upgrade)` when a newer version exists. Silent on failure; never blocks the command.
- `--no-update-check` CLI flag and `FORGE_NO_UPDATE_CHECK=1` env var to opt out of the version check. Also auto-skipped in CI (`CI=true`) and non-interactive runs.
- README "How to Use" section explaining how to invoke Forge per platform: `/forge` skill on Claude Code (with `forge-worker` as a delegated subagent), `forge` primary agent on OpenCode, and the partial `.toml` agents on Codex — including the Claude advisory-vs-OpenCode-enforced trade-off.
- **Feedback ratchet — `.forge/lessons.md`**: a project-scoped, topic-keyed lessons file the worker proactively appends to after each run (decision / non-obvious fix / convention / failure). Reusing a topic-key updates an existing lesson instead of creating a contradictory duplicate, so the harness compounds across sessions instead of repeating mistakes.
- **Bootstrap repo-facts — `.forge/repo-facts.md`**: a one-time `inspect`-written standing spec (stack, build/test/lint commands, conventions, hard constraints) the worker rereads each dispatch, paying the intent/reconstruction cost once.
- **Closure + cross-task index — `.forge/index.md` and `.forge/_archive/`**: on `passing`, the verify dispatch flushes lessons and appends a one-line ledger entry; completed slugs may be archived. Each feature carries a falsifiable `archiveWhen` condition set at creation.
- **Effort routing**: the orchestrator now states an effort level per worker dispatch (low for `inspect`/`verify`/`operate`/routine `build`, medium for most `build`/`plan`, high for `design`/synthesis/novel work) — match effort to difficulty rather than defaulting high.
- **Inline-vs-delegate threshold**: the orchestrator handles inline only a 1-3 file read / mechanical write / git status, and delegates at 4+ files, multi-file writes, or running tests/builds/installs — keeping the thread thin (summaries, not implementations).
- **Optional hooks pack** (README): an opt-in Claude Code `settings.json` snippet (Stop + PostToolUse) to *enforce* the verification gate mechanically for unattended runs — kept thin and optional, since strong models honor the gate from the operating model alone.
- **Harness-content validation**: `validate`/`install` emit a `BODY_OVER_BUDGET` info diagnostic when an artifact body exceeds its soft line budget (keep always-loaded files small). Never an error; does not block installs.

### Changed

- **Independent verification is now adversarial.** The separate `forge-worker` verify dispatch tries to *disprove* "done" rather than confirm it: it refutes risk-bearing features across up to three distinct lenses and keeps `passing` only if at least two fail to refute; confirms the check was not weakened, deleted, skipped, or stubbed and that its output exercises the named `behavior`; logs refuted/uncertain candidates instead of dropping them silently; and escalates instead of looping when the same failure recurs. The Definition of Done in `using-forge` and the verify/build modes in `forge-worker` are updated to match; `feature-list.json` gains an `archiveWhen` field.

### Migration from 0.3.0

- Run `npx @guidobuilds/forge-ai update` (not `install`) to add the new `forge-adversary` agent and refresh the `forge`, `using-forge`, and `forge-worker` artifacts to the adversarial-verification operating model. Local edits to managed files are backed up automatically to `~/.forge-ai/backups/`.
- No breaking changes to the CLI or distribution layout. The `.forge/<feature-slug>/` state files (`feature-list.json`, `verification.md`, `lessons.md`, `repo-facts.md`, `index.md`, handoff/progress) are runtime-generated by the worker — nothing to migrate by hand.
- If you installed the CLI globally, `forge-ai self-update` (new in 0.4.0) bumps the binary and then refreshes the spec kit for you.

## [0.3.0] - 2026-05-15

### Added

- Unified canonical **artifact** model: all sources live under `artifacts/<name>/<name>.md` and declare `kind: agent | skill` in frontmatter. Each per-platform block can override `kind`, so one artifact renders as an agent on one platform and a skill on another.
- `forge` orchestrator installs as a Claude Code **skill** (`/forge`) on Claude Code, while remaining a primary agent on OpenCode and Codex. This fixes the previous setup where `forge` was installed as a Claude subagent and could not delegate to `forge-worker` (Claude subagents cannot call `Task`).
- Installer **classifies each destination** as one of `new`, `managed-unmodified`, `managed-modified`, or `foreign`, and prints the status next to each file (`[refresh]`, `[overwrite, backup -> …]`, `[foreign overwrite]`, `[new]`).
- **Automatic backups** of user-edited Forge files before overwrite or prune, stored under `~/.forge-ai/backups/<scope>/<ISO-timestamp>/<relative-path>`. A single timestamp directory groups all backups from one run.
- **Combined confirmation prompt** in interactive mode listing every file that needs the user's decision (edited overwrites, edited deletions, foreign overwrites) with the destination backup directory.
- Non-interactive installs refuse with exit code 1 when there are edited or foreign files and neither `--yes` nor `--force` is set, instead of silently overwriting.
- New diagnostic codes: `MANAGED_FILE_OVERWRITE`, `FOREIGN_FILE_OVERWRITE`, `MISSING_KIND`, `INVALID_KIND`, `INVALID_PLATFORM_KIND`, `OPENCODE_MODE_ON_SKILL`, `SUPPORT_FILES_NOT_COPIED`.
- Claude tool and model validation (`src/adapters/claude-known.ts`): unknown tools/models in agent frontmatter emit warnings instead of being silently accepted.
- Skill source directories now allow sibling files (groundwork for future support-file bundling); detected files emit an `info` diagnostic noting that copying is not yet implemented.

### Changed

- Source layout: `agents/` and `skills/` directories are gone; everything moved to `artifacts/<name>/<name>.md`.
- `forge-worker` agent and `forge-worker` skill (previously two files with the same name in separate namespaces) merged into a **single** `forge-worker` artifact rendered as a subagent on every platform. The artificial "thin agent loads a skill" indirection is removed.
- `package.json` `files` now ships `artifacts/` instead of `agents/` + `skills/`.
- Refreshing a managed-unmodified file is **silent** — no warning emitted. Previously every existing destination produced an indiscriminate `OVERWRITE_FORCED`.
- Stale-managed files the user edited are now **backed up and deleted** during `update` (when `--yes`/`--force`); previously they were left on disk with a `CHECKSUM_MISMATCH` warning. Interactive runs prompt before backing up + deleting.
- OpenCode `permissions` keys switched from boolean (`true`/`false`) to explicit strings (`allow`/`deny`); orchestrator now explicitly denies file/code operations.
- Adapters consume a unified `CanonicalArtifact` type (with `body` field) instead of separate `CanonicalAgent`/`CanonicalSkill` types.
- Frontmatter parsing now uses the `yaml` library (replaces the hand-rolled parser), with stricter spec compliance and better edge-case handling (colons in descriptions, horizontal rules in bodies, BOM, CRLF).
- Claude agent `tools` and skill `allowed-tools` are emitted as comma-separated strings (matches Claude Code's native format).
- Development tooling migrated from npm to **pnpm**: `packageManager: "pnpm@11.1.1"` pinned via Corepack (no global install needed); `pnpm.onlyBuiltDependencies: []` allowlist is explicit so postinstall script blocking is documented behavior. The published package is unaffected — consumers still install via `npx`.

### Removed

- `CanonicalAgent` and `CanonicalSkill` types (replaced by `CanonicalArtifact`).
- `agents/` and `skills/` source directories.
- `DESTINATION_EXISTS` error and `OVERWRITE_FORCED` warning (replaced by status-aware `MANAGED_FILE_OVERWRITE` and `FOREIGN_FILE_OVERWRITE`).
- `CHECKSUM_MISMATCH` warning during prune (the file is now backed up and deleted on consent).
- `package-lock.json` (replaced by `pnpm-lock.yaml`).

### Fixed

- `forge` orchestrator deployment to Claude Code now actually works: it is installed as a `/forge` skill in the main thread, which retains the `Task` tool and can delegate to the `forge-worker` subagent. The previous subagent install was inert because Claude subagents cannot call `Task`.
- Installer no longer raises spurious overwrite warnings for files Forge installed itself and that have not been edited.

### Security

- Migrated the development workflow to pnpm. pnpm 10+ **blocks postinstall scripts by default** (`onlyBuiltDependencies` allowlist), enforces strict `node_modules` (no phantom dependencies), and uses an auditable text lockfile (`pnpm-lock.yaml`). The npm registry is the same, but install-time defaults are hardened.
- User edits to Forge-managed files are **always backed up** before being overwritten or deleted, eliminating silent data loss when running `update` against a customized install.

### Migration from 0.2.0

- Run `npx @guidobuilds/forge-ai update` (not `install`) after upgrading. `update` prunes the now-orphaned `.claude/agents/forge.md` and the old standalone `forge-worker` skill from the previous layout. Local edits to any of those files are backed up automatically to `~/.forge-ai/backups/`.
- `install` (without `update`) will leave the orphaned files on disk. They are harmless but unmanaged.
