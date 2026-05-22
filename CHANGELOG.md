# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions prior to 0.3.0 are not reconstructed here; see git history for earlier changes.

## [Unreleased]

### Added

- `forge-ai self-update` command. Detects how the CLI is installed (pnpm global, npm global, Homebrew npm, npx, or unknown) and runs the right update command with the right flags (`--prefer-online` for pnpm to sidestep its metadata cache). After updating the binary it automatically runs `forge-ai update` to refresh the spec kit. Flags: `--to <version>` to pin a specific version, `--dry-run` to preview, `--skip-spec-update` to only bump the CLI.
- Background version check on every interactive run. Calls the npm registry (with 1.5s timeout, cached for 1h at `~/.forge-ai/version-check.json`) and prints `forge-ai vX.Y.Z (vA.B.C available — run \`forge-ai self-update\` to upgrade)` when a newer version exists. Silent on failure; never blocks the command.
- `--no-update-check` CLI flag and `FORGE_NO_UPDATE_CHECK=1` env var to opt out of the version check. Also auto-skipped in CI (`CI=true`) and non-interactive runs.
- README "How to Use" section explaining how to invoke Forge per platform: `/forge` skill on Claude Code (with `forge-worker` as a delegated subagent), `forge` primary agent on OpenCode, and the partial `.toml` agents on Codex — including the Claude advisory-vs-OpenCode-enforced trade-off.

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
