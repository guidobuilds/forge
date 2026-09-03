# Backend / API Fix Specification — Forge

Companion to `report/api-report.md`. Every finding (A, B, C, M1–M12) has a concrete fix with files, steps, benefit, and validation. No application code is modified by this audit; these are specifications for a follow-up build dispatch.

---

## A. Authenticate / scope-validate the install manifest before destructive operations

- **Severity:** High
- **Files (new/changed):**
  - New `src/manifest-validation.ts` (or extend `src/manifest.ts`) — `assertManifestSafe(manifest)`.
  - `src/manifest.ts` — `loadManifest`, `staleEntries`, `classifyPruneEntries`, `pruneEntries`.
  - `src/cli.ts` — `runUninstall` (`:504-505`) and update/prune path (`:165-211`) already flow through the above, so no CLI change beyond wiring the validation.
  - New `tests/forge-cli.test.ts` cases.
- **Steps:**
  1. Define a per-scope allowlist of install roots. User scope: `~/.claude/{agents,skills}`, `~/.config/opencode/{agents,skills}`, `~/.opencode/{agents,skills}`, `~/.codex/agents`, `~/.agents/skills`, `~/.grok/{agents,skills}`. Project scope: the same dirs under `projectPath`.
  2. In `loadManifest`, after parse/upgrade, validate schema (`schemaVersion`, `scope`, `entries[]` fields present and correctly typed) and, for each `entry.path`, assert it is (a) absolute, (b) inside one of the scope's allowed roots (via `path.relative(root, entry.path)` not starting with `..` and not absolute), and (c) `entry.checksum` matches `/^[0-9a-f]{64}$/`.
  3. On violation, do **not** proceed with prune/delete for that entry: mark the manifest entry `skipped` with reason `unsafe-path` (mirroring `checksum-mismatch`/`missing`) and surface a `manifest.ts`-level diagnostic, or refuse the whole destructive operation with a clear message.
  4. Add a `forge-ai`-level guard: `classifyPruneEntries` and `pruneEntries` must be a no-op for any entry that fails scope validation, so a future caller can't bypass it by invoking the lower-level functions directly.
- **Benefit:** closes the arbitrary-file-deletion vector; a poisoned or corrupted manifest can no longer direct `rm`/overwrite outside Forge-managed directories.
- **Validation:** unit test that (a) a manifest entry with `path: <tmp>/victim.txt` + matching `sha256` is *not* deleted by `update --prune` and is reported as `unsafe-path`; (b) a schema-invalid manifest (e.g. `entries: [{ platform: 1 }]`) is rejected with a clear error, not a throw; (c) all existing prune/uninstall tests still pass. Run `pnpm test`.

---

## B. Resolve spawned binaries to absolute paths / add an allowlist at the subprocess boundary

- **Severity:** Medium
- **Files:**
  - `src/opencode-discovery.ts` — `defaultRunner`, `discoverOpenCodeModels`.
  - `src/self-update.ts` — `runSelfUpdate`, `defaultSpawner`.
  - New `tests/forge-cli.test.ts` cases (already have runner/spawner injection points).
- **Steps:**
  1. For `discoverOpenCodeModels`, resolve `opencode`/`opencode2` to an absolute executable path first (e.g. `which`-style resolution via `spawnSync` of the platform's `which`/`where`, or an explicit `process.env.PATH` scan — note Node has no built-in `findExecutable`), and pass the resolved absolute path to `spawnSync`. Fail closed to `undefined` (existing fallback) if resolution returns nothing.
  2. Add a `cwd`-safety check: only run model discovery when the resolved binary lives outside the current working tree (or, more simply, drop `cwd` from the `spawnSync` options so a repo-local `opencode` shim cannot shadow the real CLI for discovery purposes).
  3. For `runSelfUpdate`, add an allowlist of command names `{ pnpm, npm, /opt/homebrew/bin/npm, forge-ai }` and reject any resolved command outside that set; resolve each to an absolute path before `spawnSync` so a malicious `pnpm`/`npm` earlier on `PATH` cannot be substituted.
  4. Document the trust boundary (a comment in both files): spawned commands are developer-facing package managers, resolved by absolute path, never via a repo-local shadow.
- **Benefit:** eliminates arbitrary-code-execution via `PATH`/`cwd` shadowing when running Forge against an untrusted checkout.
- **Validation:** unit tests injecting a `runner`/`spawner` that asserts the received `command` is an absolute path (not a bare name), plus an integration test asserting a repo-local `opencode` shim is *not* executed during `discoverOpenCodeModels`. Run `pnpm test`.

---

## C. Validate the OpenCode permission block (and reconcile the `permission` key)

- **Severity:** Low–Medium
- **Files:**
  - `src/adapters/opencode.ts` — `renderOpenCodeAgent`.
  - `src/adapters/shared.ts` — optionally a small `openCodePermissions` validator.
  - `src/model.ts` — narrow `ProductConfig.permissions` typing or document the OpenCode shape.
  - New `tests/forge-cli.test.ts` cases.
- **Steps:**
  1. Define the expected OpenCode `permissions` shape (a plain object of `toolName -> "allow"|"deny"|boolean` or a documented OpenCode schema) and validate it in `renderOpenCodeAgent`; emit an `OPENCODE_INVALID_PERMISSIONS` error/warning diagnostic on mismatch instead of silently passing through.
  2. Add a size/type bound (reject non-scalar or non-object values) to prevent oversized/nonsensical YAML emission.
  3. Reconcile the key naming: either emit `permission` intentionally (with a code comment explaining OpenCode's singular key) or switch the canonical field; at minimum record why `permissions` → `permission`.
- **Benefit:** parity with the other three adapters' validation; invalid permission blocks are caught at `validate`/`install` time rather than installed silently.
- **Validation:** unit tests for valid, invalid-type, and oversized `opencode.permissions` values asserting the correct diagnostic and emitted YAML; existing `opencode` renderer/golden tests still pass. Run `pnpm test`.

---

## M1. Validate `--to <version>`

- **Files:** `src/self-update.ts:35-48`, `src/cli.ts:240-243`.
- **Steps:** accept only a semver token or the literal `latest`; reject anything else with the same style as the other `parseArgs` errors. Optionally use the existing `compareSemver` helpers or a `^\d+\.\d+\.\d+([-+].*)?$` pattern.
- **Benefit:** prevents an arbitrary spec (git URL, flag-bearing string) from reaching `npm/pnpm install -g`.
- **Validation:** CLI test that `forge-ai self-update --to 'github:user/repo'` exits 1 with an error, and `--to 0.4.0` is accepted.

---

## M2. Graceful handling of corrupt state files

- **Files:** `src/manifest.ts:136-145`, `src/model-preferences.ts:20-27`.
- **Steps:** catch JSON `SyntaxError` (and shape mismatch) separately from `ENOENT`; return `undefined`/`{}` and emit a `console.error` "state file corrupt; re-run `forge-ai install`" (or surface a diagnostic) instead of throwing. Keep re-throwing genuinely unexpected errors (e.g. EACCES) so real failures still surface.
- **Benefit:** a truncated write (no atomic rename — see M12) no longer crashes the whole CLI with a stack trace.
- **Validation:** tests writing malformed JSON to each path and asserting `loadManifest`/`loadModelPreferences` recover gracefully.

---

## M3. Harden `parseModelMap`

- **Files:** `src/cli.ts:436-444`, `src/cli.ts:446-464`.
- **Steps:** split on the *first* `=` only; validate each `name` against the kebab-case `namePattern`; reject empty segments with a clear error instead of silently dropping; consider supporting model ids containing `=` (OpenCode) via an explicit delimiter rule or documented limitation.
- **Benefit:** correct parsing for model ids containing `=`; no silent data loss on malformed maps.
- **Validation:** unit tests for `name=model=a=b`, `name=`, and `=model` inputs.

---

## M4. Deterministic `forge-ai list` ordering

- **Files:** `src/manifest.ts:108-128`.
- **Steps:** sort `projectHashes` (or the resulting summaries) before returning — e.g. by `projectPath` with localeCompare.
- **Benefit:** reproducible output; testable and scriptable.
- **Validation:** test asserting stable ordering across two `readdir` orders (or assert sorted-by-projectPath).

---

## M5. Parallelize sequential I/O in hot loops

- **Files:** `src/processor.ts:214-229`, `src/discovery.ts:17-28`, `src/manifest.ts:122-126`.
- **Steps:** convert `classifyDestinations`, `discoverArtifacts`, and `listInstalls`' per-item `await` loops to `Promise.all` (matching `buildManifest`'s existing pattern). Preserve deterministic ordering by mapping results back to the input order.
- **Benefit:** lower wall-clock latency on large installs/list runs.
- **Validation:** existing tests still pass; no behavioral change (diagnostics ordering preserved).

---

## M6. Replace `JSON.stringify`-as-TOML with explicit TOML string escaping

- **Files:** `src/adapters/shared.ts:18-20`, `src/adapters/codex.ts:11-25`.
- **Steps:** write a small `tomlBasicString(value)` that escapes only TOML basic-string metacharacters (`\`, `"`, control chars via `\b \t \n \f \r`, `\uXXXX`) and leaves `\/` and Unicode untouched; use it for `name`/`description`/`developer_instructions`/`model`. Add golden/unit tests with multi-line, quote, backslash, newline, and non-ASCII bodies.
- **Benefit:** correct Codex TOML for arbitrary body content; removes the undocumented JSON/TOML equivalence assumption.
- **Validation:** new tests asserting exact escaped output for the tricky cases; existing Codex golden fixtures still pass.

---

## M7. Decouple `user-invocable` from Grok/OpenCode skill rendering

- **Files:** `src/adapters/grok.ts:41`, `src/adapters/opencode.ts:24`, `src/model.ts` (optional).
- **Steps:** either (a) add an explicit per-platform `discoverable`/`background` field to `ProductConfig` and have Grok/OpenCode read that, or (b) keep the Claude field but route it through a documented helper (`isBackgroundOnly(artifact)`) with a comment stating the cross-platform intent. Do not silently read a sibling platform's config.
- **Benefit:** eliminates a cross-platform coupling trap; behavior stays explicit and grep-able.
- **Validation:** existing `GROK_SKILL_DISCOVERABLE_UNENFORCED` / `OPENCODE_SKILL_DISCOVERABLE_UNENFORCED` tests still pass.

---

## M8. Remove or fix the vestigial self-run guard

- **Files:** `src/cli.ts:833-835`.
- **Steps:** drop the `import.meta.url === 'file://' + process.argv[1]` block (the `bin/forge-ai.mjs` shim is the only entrypoint and calls `main()` directly), or replace it with a robust `require.main`-equivalent using `pathToFileURL`. Ensure `node bin/forge-ai.mjs --help` still works.
- **Benefit:** removes a fragile, symlink/path-sensitive branch that risks a double-run or a never-run.
- **Validation:** `tests/forge-cli.test.ts:1037-1040` (`npm bin shim runs the built CLI`) plus a direct `node bin/forge-ai.mjs install --dry-run` smoke test.

---

## M9. Add machine-readable output / document the CLI contract

- **Files:** `src/cli.ts` (`showUsage:802-813`, `printPlan:815-822`), `README.md`.
- **Steps:** add a `--json` flag (or `FORGE_OUTPUT=json`) that emits plan/list/diagnostics as one JSON object to stdout while keeping human output on stderr or behind the flag; document the `i`/`upgrade`/`ls` aliases in `showUsage`; define exit codes (0 success, 1 user/validation error, 2 unexpected error) if scripting is a goal.
- **Benefit:** makes the CLI safely scriptable and its contract explicit.
- **Validation:** CLI test asserting valid JSON on `--json --dry-run` for `install` and `list`; `--help` text updated.

---

## M10. Add observability to the version-check network path

- **Files:** `src/version-check.ts:58-71`, `src/cli.ts:101-103`.
- **Steps:** accept an optional `log`/`warn` callback in `VersionCheckOptions`; log (at debug/warn) when fetch fails, returns non-200, or yields a non-string version. Gate on an env var (e.g. `FORGE_DEBUG`) to avoid noisy output. Preserve the silent, non-fatal contract for normal runs.
- **Benefit:** network failures are diagnosable instead of invisible.
- **Validation:** tests that a failing fetcher invokes the warn callback and that normal runs are unaffected.

---

## M11. Don't abort prune/uninstall on a single unreadable entry

- **Files:** `src/manifest.ts:204-207`.
- **Steps:** catch non-`ENOENT` read errors in `classifyPruneEntries` and push the entry to `skipped` with a new reason `unreadable` (plus a warning diagnostic), rather than re-throwing. Only propagate truly unexpected errors if the whole state dir is unreadable.
- **Benefit:** one permission-denied managed file no longer blocks the entire `update --prune`/`uninstall`.
- **Validation:** test with an unreadable file (chmod 000 in a temp dir) asserting the entry is skipped and the operation completes.

---

## M12. Reduce TOCTOU / make manifest writes atomic

- **Files:** `src/writer.ts:6-20`, `src/manifest.ts:182-185`, `src/processor.ts:231-241`.
- **Steps:** (a) write manifests and model-preferences via temp-file + `rename` (atomic on the same filesystem) so an interrupted write can't leave a corrupt JSON file (which M2 then recovers from gracefully); (b) re-check the destination checksum inside `writeOutputs` immediately before overwrite (read the current file, compare to the classification checksum, and re-classify/abort if changed) to narrow the classify→write window.
- **Benefit:** reduces the window for a changed-file race and eliminates half-written state files.
- **Validation:** existing overwrite/backup tests still pass; a new test asserting a swapped file between classification and write is detected (via a fault-injected read).

---

## Cross-cutting validation

- `pnpm typecheck` and `pnpm test` must pass after all changes.
- Run `pnpm run generate-fixtures` and confirm golden fixtures are unchanged **except** where a fix intentionally alters rendered output (C, M6) — in which case the diff must be reviewed and re-committed deliberately.
- No change may weaken the existing conformance tests (`tests/forge-cli.test.ts:1122-1217`) that lock the orchestrator's least-privilege posture.
