# Backend / API Audit — Forge

- **Repository:** `/Users/guido/dev/forge`
- **Audit scope:** Backend / API surface only (REST / GraphQL / Node / Python / Java / serverless / CLI contract / file-system state layer / network clients / subprocess boundaries).
- **Audit date:** 2026-09-02
- **Auditor:** forge-worker (coordinator, `inspect`, task `audit-api`)
- **Slug:** `application-audit`

## Executive Summary

**There is no HTTP / REST / GraphQL / RPC / serverless endpoint surface in this repository.** `forge` (`@guidobuilds/forge-ai`, v0.8.0) is a **Node.js (TypeScript) command-line tool** that installs an "operating model" (agent + skill definition files) into four AI-coding-agent homes (OpenCode, Claude Code, Codex, Grok Build). The only "API" the process exposes is a **stdin/stdout CLI contract**, a **public TypeScript module surface** (`src/index.ts`), and a **file-system + JSON state layer** that acts as the tool's backend.

Because the audit is explicitly scoped to *backend/API*, the applicable and audited surface is:

1. **CLI contract** — `src/cli.ts` hand-rolled argument parser, command dispatch, exit codes, and output format.
2. **Public TS API** — `src/index.ts` re-exports of `model.ts`, `processor.ts`, `writer.ts`.
3. **State / persistence backend** — `src/manifest.ts` (install ledger, checksums, prune/delete), `src/model-preferences.ts`.
4. **File-system backend** — `src/paths.ts`, `src/processor.ts` (path resolution + collision classification), `src/writer.ts`, `src/discovery.ts`, `src/frontmatter.ts`.
5. **Network clients** — `src/version-check.ts` (npm-registry `fetch`) and `src/self-update.ts` (spawns `pnpm`/`npm`/`forge-ai`).
6. **Subprocess boundary** — `src/opencode-discovery.ts` (spawns `opencode models`).

Classic HTTP-API concerns (pagination, filtering, sorting, rate limits, route versioning, REST resource naming) are **not applicable** to this surface; where an analogue exists (e.g. `forge-ai list` has no deterministic ordering, `--model-map` filtering, the version-check "rate limit" TTL), it is noted inline. The concerns that *do* apply — **input validation, injection, secrets/data exposure, auth/authz, path-traversal, integrity of the state that drives destructive operations, error-format consistency, resilience, observability, tests, and modern best practices** — produced real findings.

The headline risk is a **trust-integrity gap around the install manifest**: the manifest is read as if authoritative and drives `rm`/overwrite operations, yet its `path`/`checksum` fields are neither authenticated nor scope-validated (Finding A). Secondary risks are **subprocess/PATH execution over an attacker-influenced working directory** (Finding B) and **unvalidated OpenCode permission passthrough** (Finding C). All three have concrete, low-effort mitigations specified in `report/api-fix.md`.

The codebase is otherwise disciplined: strong name/path validation, checksum-gated overwrite protection with backup-before-overwrite, a structurally-enforced least-privilege orchestrator, and an unusually thorough conformance + golden-fixture test suite (documented in Positive Observations).

---

## Major Issues

### A. Unauthenticated install manifest drives arbitrary file deletion (`rm`) and overwrite

- **Severity:** High (integrity / data-loss; local attacker or a compromised agent process)
- **Files:** `src/manifest.ts:191-229`, `src/manifest.ts:136-145`, `src/cli.ts:164-211`, `src/cli.ts:491-565`

The install manifest under `~/.forge/state/` — `user-manifest.json` for user scope, `projects/<projectPathHash>/manifest.json` for project scope — is the source of truth for what Forge owns, and it is loaded with no schema/path validation and no authentication:

```ts
// manifest.ts:136-145 — loadManifest only tolerates ENOENT; any parseable JSON is trusted as-is
export async function loadManifest(manifestPath: string): Promise<AssetManifest | undefined> {
  try {
    const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifestV1 | AssetManifest;
    if (raw.schemaVersion === 1) return upgradeManifestV1(raw);
    return raw;                       // <- no validation of entries[].path / checksum shape
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
```

Stale entries are computed purely from the manifest, and pruning deletes whatever `entry.path` says, gated only by a checksum the attacker can compute:

```ts
// manifest.ts:191-195 — "stale" = manifest entry whose path isn't in the new file set
export function staleEntries(oldManifest: AssetManifest | undefined, files: OutputFile[]): ManifestEntry[] {
  if (!oldManifest) return [];
  const currentPaths = new Set(files.map((file) => file.path));
  return oldManifest.entries.filter((entry) => !currentPaths.has(entry.path));
}

// manifest.ts:197-213 — deletable requires sha256 match (attacker can precompute sha256)
export async function classifyPruneEntries(entries: ManifestEntry[]): Promise<{ deletable; skipped }> {
  for (const entry of entries) {
    ...
    if (sha256(content) === entry.checksum) deletable.push(entry);
    else skipped.push({ ...entry, reason: 'checksum-mismatch' });
  }
}

// manifest.ts:215-229 — deletion has no path-scope guard
export async function pruneEntries(entries: PrunePlanItem[]): Promise<void> {
  for (const entry of entries) {
    ...
    await rm(entry.path, { force: true });   // <- rm on a path read straight from the manifest
  }
}
```

Nothing anywhere checks that `entry.path` is inside a Forge-managed directory (user `~/.claude|.opencode|.codex|.grok|.agents` or project `.claude|.opencode|.codex|.grok|.agents`). A manifest entry `{ path: "/Users/guido/important.txt", checksum: "<sha256 of that file>" }` would be **deleted** by `forge-ai update --prune` (or `uninstall`), and the `checksum-mismatch` branch deletes-with-backup on `--yes`/`--force`. The same trust gap underlies `buildManifest` carrying forward `oldManifest.entries` untouched (`manifest.ts:169-179`).

**Impact:** a corrupted manifest, or a malicious process/agent that already has user-level write access to `~/.forge/state/` (exactly the class of process Forge itself spawns and grants file tools to), can cause deletion or overwrite of arbitrary user files outside any Forge-managed path.

### B. Subprocess execution resolved from `PATH` over an attacker-influenced working directory

- **Severity:** Medium (arbitrary code execution in a dev tool)
- **Files:** `src/opencode-discovery.ts:22-47`, `src/self-update.ts:81-97`

Model discovery shells out to a binary named `opencode` (then `opencode2`) looked up on `PATH`, with `cwd` set to the user's project directory:

```ts
// opencode-discovery.ts:22-29
const defaultRunner: ModelDiscoveryRunner = (command, args, options) => {
  const result = spawnSync(command, args, { cwd: options.cwd, timeout: options.timeoutMs, ... });
  ...
};
// opencode-discovery.ts:36-47
export function discoverOpenCodeModels(cwd: string, ...) {
  for (const command of ['opencode', 'opencode2']) {
    const result = runner(command, ['models'], { cwd, timeoutMs });
    ...
```

This runs during interactive `install`/`configure` (model selection), invoked with `cwd = process.cwd()` (`src/cli.ts:396`, `src/cli.ts:713`). `spawnSync(command, …)` resolves `command` via the ambient `PATH`; a repository that ships an `opencode` executable (e.g. via `node_modules/.bin`, or a literal `opencode` file when `.`/relative entries are on `PATH`) will have it executed with the user's privileges when the user runs `forge-ai install`/`configure` inside that repo. `runSelfUpdate` has the same shape for `pnpm`/`npm`/`forge-ai` (`src/self-update.ts:81,90`), and `defaultSpawner` inherits stdio (`:94-97`). No absolute path resolution, allowlist, or `path` sanitization is applied to the spawned commands.

**Impact:** running Forge against an untrusted checkout (`--source` is user-supplied and the docs encourage `forge-ai install --source .`) can execute attacker-controlled binaries from the checkout's `PATH`.

### C. OpenCode permission block is passed through unvalidated (`permissions` is `unknown`)

- **Severity:** Low–Medium (validation/contract gap on a user-supplied source tree)
- **Files:** `src/model.ts:8-12`, `src/adapters/opencode.ts:16`

Unlike Claude / Grok / Codex, which validate their permission shapes (`stringList`/`patternList` in `src/adapters/shared.ts:10-16`, `safeSandboxModes` in `src/adapters/codex.ts:7`), the OpenCode agent renderer emits the raw value with no validation and under a **different key name** (`permission`, singular):

```ts
// model.ts:8-12 — permissions typed unknown
export type ProductConfig = { permissions?: unknown; model?: string; kind?: SourceKind };

// opencode.ts:16 — unvalidated passthrough
if (artifact.opencode?.permissions) fm.permission = artifact.opencode.permissions;
```

A malformed or adversarial `opencode.permissions` (arbitrary nested structure, non-scalar values) is serialized verbatim into the installed agent's YAML frontmatter via `stringifyYaml` (`src/frontmatter.ts:21-24`). There is no shape check, no size bound, and no diagnostic — inconsistent with the other three adapters and with the rest of the processor's strict frontmatter validation (`src/processor.ts:102-138`).

**Impact:** invalid/oversized permission blocks are installed silently rather than caught at `validate`/`install` time; the divergence between canonical `permissions` and emitted `permission` is an undocumented contract smell.

---

## Minor Issues & Smells

1. **`--to <version>` is unvalidated and flows into a package-install spec.** `src/self-update.ts:35-48` builds `` `${PACKAGE}@${version}` `` from the user-supplied `--to` value with no format check. argv-array spawning prevents shell injection, but a value like `--to "github:user/repo"` or `--to "0.4.0 --dangerous"` reaches `pnpm add -g`/`npm install -g` as a spec argument; `npm install -g @pkg@github:...` can resolve non-registry sources. Suggest validating against a semver or `latest` allowlist.

2. **Corrupt state files crash with a raw stack trace.** `loadManifest` (`src/manifest.ts:142-143`) and `loadModelPreferences` (`src/model-preferences.ts:22-26`) re-throw any non-`ENOENT` error. A partially-written or hand-corrupted `manifest.json` / `user-model-preferences.json` produces an uncaught exception (printed by `bin/forge-ai.mjs:4-6`) instead of a recoverable "state file is corrupt — re-run `forge-ai install`" message.

3. **`parseModelMap` splits on `=` and `,`.** `src/cli.ts:436-444` splits each comma-pair on *every* `=` via `pair.split('=')` (not the first only). Model ids or artifact names containing `=` (legal in OpenCode `provider/model` ids) mis-parse: a third and later `=`-separated segment is silently dropped (e.g. `name=model=x` yields `{name: "model"}`), while a fully-empty `name` or `model` segment is rejected with an `Invalid --model-map` error rather than dropped. The `--model` path (`applyModelFlags`, `src/cli.ts:446-464`) also does not validate the model string at all (it is only pattern-checked later by the renderers as a warning).

4. **Non-deterministic `forge-ai list` ordering.** `listInstalls` (`src/manifest.ts:108-128`) iterates `readdir(root/projects)` in raw directory order, so project installs print in an arbitrary, non-reproducible sequence. `discoverSources` sorts (`src/discovery.ts:13`) but `listInstalls` does not.

5. **Sequential I/O in hot loops (N+1-style).** `classifyDestinations` awaits `classifyFile` (an `access` + `readFile`) serially per file (`src/processor.ts:214-229`); `discoverArtifacts` reads each artifact serially (`src/discovery.ts:17-28`); `listInstalls` loads each project manifest serially (`src/manifest.ts:122-126`). `buildManifest` correctly uses `Promise.all` (`src/manifest.ts:157`) — the others should too for large installs.

6. **TOML rendering via `JSON.stringify` is an undocumented escape-compatibility assumption.** `tomlString` (`src/adapters/shared.ts:18-20`) emits Codex `name`/`description`/`developer_instructions`/`model` as JSON string literals. JSON and TOML basic-string escaping overlap but are not identical; there is no test for multi-line, Unicode, or control-character bodies in Codex output, and `developer_instructions` carries the entire (arbitrary-length) body (`src/adapters/codex.ts:11`).

7. **Cross-platform coupling: a Claude-only field drives Grok/OpenCode diagnostics.** `renderGrokSkill` (`src/adapters/grok.ts:41`) and `renderOpenCodeSkill` (`src/adapters/opencode.ts:24`) read `artifact.claude?.['user-invocable'] === false` to decide whether to warn that a "background-only" skill can't be hidden on that platform. Intentional, but a Claude-specific frontmatter key silently leaking into other adapters' behavior is a maintenance hazard (documented only implicitly in the diagnostic message).

8. **Fragile direct-execution guard.** `src/cli.ts:833` compares `import.meta.url === 'file://' + process.argv[1]` to decide whether to self-run. This breaks under symlinks, non-normalized paths, or runtimes that don't normalize `argv[1]` (e.g. `tsx`/`ts-node`). The `bin/forge-ai.mjs` shim already calls `main()` explicitly, so the guard is vestigial and only risks a double-run/`main()`-never-runs edge.

9. **CLI contract is free-text only; no machine-readable output.** Exit codes are binary 0/1, errors are unstructured `console.error` strings, and there is no `--json` output for a tool that is otherwise scriptable (`--yes`, `--dry-run`). Aliases `i`, `upgrade`, `ls` (`src/cli.ts:754-763`) are accepted but undocumented in `showUsage` (`src/cli.ts:802-813`), which is the only CLI reference (README documents the rest).

10. **No observability on the network surface.** `fetchLatest` (`src/version-check.ts:58-71`) swallows every failure (network, non-200, malformed JSON) silently and never logs; `checkLatestVersion` errors are `.catch(() => undefined)` at the call site (`src/cli.ts:101-103`). A user with a broken proxy/registry gets no signal that version checks are failing.

11. **`classifyPruneEntries` aborts the whole operation on non-`ENOENT` read errors.** `src/manifest.ts:204-207` re-throws anything other than `ENOENT`; an unreadable (permission-denied) managed file makes `update --prune`/`uninstall` fail hard rather than skipping that one entry with a warning.

12. **TOCTOU between collision classification and write.** `classifyFile` reads + hashes the destination (`src/processor.ts:231-241`), then `writeOutputs` re-reads and writes later (`src/writer.ts:6-20`). For a local install tool the window is benign, but the re-read in `writeOutputs` only catches the "file vanished" case, not "file changed between classification and backup".

---

## Positive Observations

1. **Name/path-traversal is well defended at the source.** Artifact `name` is constrained to `^[a-z0-9]+(?:-[a-z0-9]+)*$` and must match its containing directory (`src/processor.ts:18`, `:140-141`), and it is the only variable interpolated into output paths (`src/paths.ts:5-16`). A `../` traversal via `name` is structurally impossible.

2. **Backup-path traversal is explicitly guarded.** `resolveBackupPath` rejects `..`/absolute relative results before joining into the backup root (`src/manifest.ts:236-242`).

3. **Checksum-gated overwrite with backup-before-overwrite.** Destinations are classified new / managed-unmodified / managed-modified / foreign (`src/processor.ts:231-241`); locally-edited managed files are backed up before overwrite (`src/writer.ts:6-20`) and destructive actions require `--yes`/`--force` or interactive consent (`src/cli.ts:169-185`). `buildManifest` re-reads on-disk content so checksums reflect reality, not pre-write content (`src/manifest.ts:157`, verified by `tests/forge-cli.test.ts:1042-1051`).

4. **Structurally-enforced least privilege for the orchestrator.** The `forge` agent is emitted with a dispatch-only tool allowlist on Claude (`Agent(forge-worker, forge-adversary), TodoWrite, Skill, AskUserQuestion`), explicit denies on OpenCode, and `read-only` sandbox on Codex; workers get `task: allow`/`deny` split by role (`src/adapters/*`, locked by conformance tests `tests/forge-cli.test.ts:1105-1120`, `:1125-1156`).

5. **Excellent verification posture.** Golden-file snapshots for every platform/artifact (`tests/forge-cli.test.ts:1175-1195`), a conformance suite asserting on *rendered output* rather than declared frontmatter (`:1122-1173`), and a "no policy-class snippet diverges" invariant test (`:1210-1217`). ~101 tests cover the CLI, adapters, manifest migration, prune, uninstall, version-check, and self-update.

6. **Resilient version-check design.** Timeout via `AbortController` (1.5s), 1h TTL cache, and stale-cache fallback on network failure (`src/version-check.ts:26-37`, `:58-71`).

7. **Safe, reversible state migration.** `migrateStateDirectory` copies rather than moves, leaves a `MIGRATED` breadcrumb, and never deletes the old directory (`src/manifest.ts:52-64`); legacy-state drift is detected by timestamp and surfaced as a warning (`src/manifest.ts:89-96`).

8. **Model-id portability is enforced at the CLI boundary.** `--model`/`--model-map` require an explicit single `--platform` (`src/cli.ts:283`), preventing cross-platform model-id leakage.

9. **Non-interactive safety by default.** Interactive detection gates prompting and update-checking (`src/cli.ts:765-779`), and `CI=true` / `FORGE_NO_UPDATE_CHECK` are honored.
