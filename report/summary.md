# Application Audit — Synthesis Summary

- **Repository:** `/Users/guido/dev/forge`
- **Slug:** `application-audit`
- **Date:** 2026-09-02
- **Auditor:** forge-worker (coordinator, `mixed`, task `synthesize-audit`)
- **Scope:** Web · Mobile · API/Backend (as defined below)
- **Companion documents:** `report/api-report.md` + `report/api-fix.md` (audited), `report/web-report.md` + `report/web-fix.md` (N/A), `report/mobile-report.md` + `report/mobile-fix.md` (N/A)

---

## 1. Audit scope / applicability

The application under audit is `@guidobuilds/forge-ai` v0.8.0 — a **Node.js (TypeScript) command-line tool** that installs an "operating model" (agent + skill definitions) into four AI-coding-agent homes (OpenCode, Claude Code, Codex, Grok Build). Three layers were requested. Two are **Not Applicable** by construction, not unaudited:

| Layer | Status | Basis |
|-------|--------|-------|
| **Web / Frontend** | **N/A** | No browser frontend, framework, bundler, or HTTP server. `package.json` has 3 CLI-only runtime deps; `package.json#files` ships no static assets; `src/*.ts` has no `listen(`/`createServer`/routing. See `report/web-report.md`. |
| **Mobile** | **N/A** | No mobile app. No Swift/Kotlin/Java/Flutter/RN/Expo/Capacitor anywhere in `src/`; `package.json` targets Node `>=20`. See `report/mobile-report.md`. |
| **API / Backend** | **Audited** | Interpreted as the project's actual backend surface: **CLI contract** (`src/cli.ts`), **public TS API** (`src/index.ts`), **filesystem + JSON state layer** (`src/manifest.ts`, `src/model-preferences.ts`), **network clients** (`src/version-check.ts`, `src/self-update.ts`), and **subprocess boundary** (`src/opencode-discovery.ts`, `src/self-update.ts`). There is no HTTP/REST/GraphQL/RPC/serverless endpoint. See `report/api-report.md`. |

`workdir/` is gitignored, untracked third-party content and is excluded from scope (it is not part of `package.json#files` and is not this repository's application code).

---

## 2. Executive summary

Forge's codebase is **disciplined**: strong name/path-traversal defense, checksum-gated overwrite with backup-before-overwrite, a structurally-enforced least-privilege orchestrator, and an unusually thorough conformance + golden-fixture test suite (see §8). The substantive findings concentrate in the **state/persistence backend and the subprocess boundary** — the two places where Forge acts on the outside world.

Two findings carry the highest weight, and **both are static-analysis inferences that require adversarial validation before being treated as proven exploitable** (see §4):

- **A — install-manifest path trust.** The install manifest under `~/.forge/state/` (`user-manifest.json` for user scope, `projects/<projectPathHash>/manifest.json` for project scope) is read as authoritative and drives `rm`/overwrite, yet its `entry.path`/`checksum` fields are neither authenticated nor scope-validated (`src/manifest.ts:136-145`, `:191-229`).
- **B — subprocess resolution from `PATH`.** Model discovery and self-update `spawnSync` bare command names (`opencode`, `pnpm`, `npm`, `forge-ai`) resolved from the ambient `PATH` over a user-supplied working directory (`src/opencode-discovery.ts:22-47`, `src/self-update.ts:81-97`).

A third finding (C) is a validation/contract gap (unvalidated OpenCode `permissions` passthrough), and twelve minor issues (M1–M12) round out the list. Every finding A/B/C/M1–M12 has a concrete, low-effort fix in `report/api-fix.md`.

---

## 3. Cross-layer findings

No finding spans Web or Mobile (both N/A). Within the audited API/backend layer, the findings cluster into two cross-cutting themes:

1. **Trust in the persistence ledger outpaces trust in the inputs that build it.** Findings A, M2, and M12 all stem from the same root: the install manifest (and model-preferences) are treated as a trusted source of truth, but (a) they are loaded with no schema/path validation (A), (b) a corrupt file crashes the whole CLI (M2), and (c) they are written non-atomically, so an interrupted write can produce exactly the corrupt state M2 then fails on (M12). The common fix is one thing: validate-on-load + atomic-write + graceful-degrade.

2. **The CLI/subprocess boundary trusts ambient environment more than necessary.** Findings B, M1, and M8 share a root: commands and specs flow from user-supplied strings or the ambient `PATH` to `spawnSync`/package-manager installs without absolute-path resolution or an allowlist. B is the exploitation-shaped instance (repo-local binary shadowing); M1 (`--to` reaches `npm install -g` as a spec) and M8 (a fragile `import.meta.url` self-run guard) are lower-severity symptoms of the same "validate what crosses the process boundary" theme.

No cross-layer issue with the web/mobile layers exists, because those layers do not exist.

---

## 4. High-priority recommendations

### P0 — Validate before treating as proven: adversarial validation of A and B

Both headline findings are **mechanism-confirmed in source but not demonstrated as exploitation**. This audit verified the code paths exist and behave as described, but did not execute an end-to-end exploit. Presenting them as proven would overstate the evidence.

- **A (manifest path trust).** *Confirmed:* `loadManifest` trusts any parseable JSON; `staleEntries`/`classifyPruneEntries`/`pruneEntries` compute deletion purely from manifest `path` + a self-computable `sha256`, with no scope check, and `pruneEntries` calls `rm(entry.path, { force: true })` (`src/manifest.ts:136-145`, `:191-229`). *Unproven:* that this is reachable in practice. The precondition is that an attacker already has **user-level write access to `~/.forge/state/`** (or a compromised agent process with file tools — the very class of process Forge spawns) *and* the user runs `update --prune`/`uninstall` under `--yes`/`--force` or consents interactively. That precondition is itself a significant trust boundary. **Recommendation:** route through `forge-adversary` — attempt to actually cause out-of-scope deletion with a poisoned manifest in an isolated environment, and record the result. Do not mark `passing`/resolved on static inference alone.

- **B (subprocess/PATH).** *Confirmed:* `discoverOpenCodeModels` `spawnSync`s `opencode`/`opencode2` with `cwd = process.cwd()`, resolving via `PATH`; `runSelfUpdate`/`defaultSpawner` do the same for `pnpm`/`npm`/`forge-ai` with inherited stdio (`src/opencode-discovery.ts:22-47`, `src/self-update.ts:81-97`). *Unproven:* that a checkout actually ships a malicious `opencode`/`pnpm`/`npm` earlier on `PATH` (e.g. via `node_modules/.bin`) and that `forge-ai install`/`configure`/`self-update` executes it with the user's privileges. **Recommendation:** adversarial validation with an isolated fixture placing a malicious `opencode` shim on `PATH` (and a `.`/relative `PATH` entry) to confirm whether it is executed. Note the docs' own `forge-ai install --source .` pattern raises the practical relevance of this check.

### P1 — Close the two findings regardless of exploitability

Even if adversarial validation finds the preconditions hard to reach, the *defenses* are cheap, correct, and worth shipping (full specs in `report/api-fix.md` §A/§B):

- **A fix:** scope-validate every `entry.path` against a per-scope allowlist of Forge-managed roots and reject schema-invalid manifests before any destructive operation.
- **B fix:** resolve spawned binaries to absolute paths (or an allowlist) at the subprocess boundary; drop `cwd` from model-discovery `spawnSync` so a repo-local shim cannot shadow the real CLI.

### P2 — Harden state robustness (low effort, high user-facing value)

- **M2** (corrupt state files crash with a raw stack trace) + **M12** (non-atomic manifest writes) — together they turn "an interrupted write" into "a broken CLI". Fix together: atomic temp-file + `rename` writes and graceful `SyntaxError` recovery.
- **M1** — validate `--to <version>` to a semver/`latest` allowlist before it reaches `npm/pnpm install -g`.

### P3 — Correctness and contract polish

- **C** (validate OpenCode `permissions`, reconcile `permission` key) — restores parity with the other three adapters.
- **M3** (`parseModelMap` splits on every `=`), **M4** (non-deterministic `forge-ai list` ordering), **M9** (no machine-readable output / undocumented aliases), **M10** (silent version-check network failures).

### P4 — Performance / hygiene (optional)

- **M5** (parallelize sequential I/O), **M6** (explicit TOML escaping instead of `JSON.stringify`), **M7** (decouple Claude-only `user-invocable` from Grok/OpenCode rendering), **M8** (remove the vestigial self-run guard), **M11** (don't abort prune on a single unreadable entry).

---

## 5. Prioritized remediation roadmap (API/CLI findings)

Ordered by severity × effort × user impact. IDs link to the detailed spec in `report/api-fix.md`.

| Rank | ID | Finding (one line) | Severity | Effort | Depends on |
|------|----|--------------------|----------|--------|-----------|
| 0 | A | Manifest path/checksum trusted without scope validation → drives arbitrary `rm`/overwrite | High (inference) | Low–Med | — |
| 1 | B | Subprocess/PATH resolution over attacker-influenced `cwd` | Medium (inference) | Low | — |
| 2 | M2 | Corrupt state files crash CLI with raw stack trace | Low–Med | Low | M12 (for root-cause) |
| 3 | M12 | Non-atomic manifest/preferences writes; classify→write TOCTOU | Low–Med | Med | — |
| 4 | M1 | `--to <version>` unvalidated → reaches package-manager install | Low–Med | Low | — |
| 5 | C | OpenCode `permissions` passed through unvalidated (`unknown`) | Low–Med | Low | — |
| 6 | M3 | `parseModelMap` mis-parses `=` in model ids; drops empty segments | Low | Low | — |
| 7 | M4 | `forge-ai list` ordering non-deterministic | Low | Low | — |
| 8 | M9 | Free-text-only CLI; no `--json`; undocumented `i`/`upgrade`/`ls` | Low | Med | — |
| 9 | M10 | Version-check network failures invisible | Low | Low | — |
| 10 | M11 | `classifyPruneEntries` aborts on one unreadable entry | Low | Low | — |
| 11 | M5 | Sequential I/O in hot loops (N+1) | Low | Low | — |
| 12 | M6 | `JSON.stringify`-as-TOML escaping assumption (Codex) | Low | Med | — |
| 13 | M7 | Claude-only `user-invocable` leaks into Grok/OpenCode logic | Low | Low | — |
| 14 | M8 | Vestigial `import.meta.url` self-run guard (symlink-fragile) | Low | Low | — |

**Sequencing note:** A and B should be fixed first *and* adversarial-validated before being reported as resolved (see §4). M2/M12 are best done as one change (graceful recovery + atomic writes are two halves of the same robustness story). The rest are independently schedulable.

---

## 6. Overall architecture suggestions

Evidence-driven; not required for the fixes above, but they address the root causes that made A/B/M1/M2/M12 possible:

1. **Introduce one validate-on-load choke point for all persisted state.** Today `loadManifest` and `loadModelPreferences` parse-then-trust (`src/manifest.ts:136-145`, `src/model-preferences.ts`). A single `assertManifestSafe`/`assertPreferencesSafe` called immediately after parse — shared by `load`, `prune`, `uninstall`, `list`, and `detectLegacyStateDrift` — would close A and M2 at their root and make the class of "untrusted ledger drives destructive ops" a non-issue going forward, rather than a per-callsite check.

2. **Define and enforce a subprocess boundary policy in one place.** Both `defaultRunner` (`opencode-discovery.ts`) and `defaultSpawner` (`self-update.ts`) are thin `spawnSync` wrappers that resolve commands from `PATH`. Centralizing "resolve-to-absolute-path + allowlist + `cwd` policy" in one helper would fix B once and prevent the next spawn site from reintroducing the same trust gap.

3. **Make all writes atomic (temp-file + `rename`).** `saveManifest` and `saveModelPreferences` write directly (`src/manifest.ts:182-185`). Atomic writes are a single-line change per site and structurally eliminate the corrupt-state failure mode M2 reports and M12 hardens against.

4. **Decide and document whether the CLI is a scripting target.** If `--json`/exit-code semantics (M9) are wanted, define them once (exit codes 0/1/2, diagnostics-to-stderr) and hold the contract in a machine-readable form; if not, state that the contract is human-only and drop the undocumented aliases' ambiguity. Either way, remove the ambiguity that currently sits in `showUsage`.

5. **Keep the existing least-privilege and conformance posture as a regression gate.** The strongest assets found (§8) are the golden/conformance suites that assert on *rendered output*. Any fix touching adapters (C, M6, M7) must re-run `generate-fixtures` and treat fixture diffs as intentional-only (already codified in `report/api-fix.md` "Cross-cutting validation").

---

## 7. Evidence and confidence

- **Mechanism-confirmed (verified against source during synthesis):** A (`src/manifest.ts:136-145`, `:191-229`), B (`src/opencode-discovery.ts:22-47`, `src/self-update.ts:81-97`), C (`src/model.ts:8-12`, `src/adapters/opencode.ts:16`), and the M1–M12 minor issues. Line numbers in `api-report.md` were spot-checked and match.
- **Not independently executed:** the actual exploits (out-of-scope deletion; malicious-binary execution). These remain inference and are gated for adversarial validation (§4).
- **Scope evidence (Web/Mobile N/A):** `package.json` (deps, `bin`, `files`, `engines`), `src/*.ts` tree, and `git ls-files workdir` (0 entries) — see `report/web-report.md` / `report/mobile-report.md`.

---

## 8. Positive observations

- **Name/path-traversal is well defended at the source** — artifact `name` is constrained to a strict slug pattern and must match its directory; `../` traversal via `name` is structurally impossible (`src/processor.ts:18`, `:140-141`; `src/paths.ts`).
- **Backup-path traversal is explicitly guarded** (`resolveBackupPath`, `src/manifest.ts:236-242`).
- **Checksum-gated overwrite with backup-before-overwrite**, with locally-edited managed files backed up before overwrite and destructive actions gated on `--yes`/`--force`/interactive consent (`src/writer.ts`, `src/processor.ts:231-241`).
- **Structurally-enforced least privilege** for the orchestrator — dispatch-only tool allowlist on Claude, explicit denies on OpenCode, `read-only` sandbox on Codex, role-split `task` allow/deny for workers (locked by conformance tests).
- **Excellent verification posture** — golden-file snapshots per platform/artifact, a conformance suite asserting on *rendered output* rather than declared frontmatter, and a "no policy-class snippet diverges" invariant test (~101 tests).
- **Resilient version-check design** — 1.5s timeout, 1h TTL cache, stale-cache fallback on failure (`src/version-check.ts`).
- **Safe, reversible state migration** — copy-not-move, `MIGRATED` breadcrumb, no deletion of the old directory (`src/manifest.ts:52-64`).
- **Model-id portability enforced at the CLI boundary** — `--model`/`--model-map` require an explicit single `--platform` (`src/cli.ts`).
- **Non-interactive safety by default** — interactive detection gates prompting and update-checks; `CI=true`/`FORGE_NO_UPDATE_CHECK` honored.

---

## 9. Links / IDs

- Detailed backend findings: [`report/api-report.md`](./api-report.md) — §A, §B, §C, §M1–M12, Positive Observations.
- Concrete fixes for every finding: [`report/api-fix.md`](./api-fix.md) — §A, §B, §C, §M1–M12, Cross-cutting validation.
- Web N/A determination: [`report/web-report.md`](./web-report.md) and [`report/web-fix.md`](./web-fix.md).
- Mobile N/A determination: [`report/mobile-report.md`](./mobile-report.md) and [`report/mobile-fix.md`](./mobile-fix.md).
