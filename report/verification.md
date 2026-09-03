# Verification — Application Audit (adversarial gate)

- **Verifier:** forge-adversary (independent; different instance than the audit worker)
- **Task:** `verify-application-audit` · **Slug:** `application-audit`
- **Date (UTC):** 2026-09-02T16:55:28Z
- **Targets:** `report/web-report.md`, `report/web-fix.md`, `report/mobile-report.md`, `report/mobile-fix.md`, `report/api-report.md`, `report/api-fix.md`, `report/summary.md`
- **Gate scope:** This audit intentionally carries **no `.forge` feature-list**, so no feature-state transitions are claimed here. Verdict is a per-report trust judgment, not a `passing` flip.

---

## 1. Method

Independent re-derivation of every substantive claim against repository source, plus safe isolated proof-of-mechanism for the two headline security findings. No application code was modified, no packages installed, no secrets or external systems touched, no user data altered (all repros ran under the approved temp base `/private/var/folders/zc/pshcd16j095b30q66lzghpxr0000gn/T/opencode`).

Lenses applied: (1) artifact integrity/coverage, (2) evidence accuracy/scope, (3) security breaker, (4) practical quality of fixes.

---

## 2. Lens 1 — Artifact integrity / coverage

Checks and evidence:

```
$ wc -l report/*.md            # all seven files non-empty
$ grep -c "" report/*.md       # (all files have content; none is a stub)
$ ls report/                   # web-report, web-fix, mobile-report, mobile-fix, api-report, api-fix, summary (+ verification.md after this run)
```

- All seven deliverables are non-empty and carry their required headings (`Verdict`/`Executive Summary`, `Major Issues`, `Minor Issues & Smells`, `Positive Observations`, and per-finding fix sections + `Cross-cutting validation`).
- **Finding↔fix mapping is 1:1.** `api-report.md` defines A, B, C, M1–M12 (15 findings). `api-fix.md` defines fixes for A, B, C, M1–M12 (15 fixes). `summary.md` §5 roadmap ranks all 15 (A, B, M2, M12, M1, C, M3, M4, M9, M10, M11, M5, M6, M7, M8). No orphan finding, no orphan fix.
- **Summary ↔ detail agreement.** §4 P0–P4 buckets map cleanly onto the §5 roadmap ordering and onto the per-finding severities. Severity labels agree across `api-report.md` and `summary.md` (A=High, B=Medium, C=Low–Medium, M*=Low/Low–Medium).
- **Scope containment.** All outputs live under `report/`; `git status` shows only `report/` as untracked, no application files modified (see §6).

Verdict: **PASS** (with two trivial cross-document test-count/line-reference corrections applied — see §5).

---

## 3. Lens 2 — Evidence accuracy / scope

Spot-checked every cited path, line range, and snippet against source. Results:

| Claim | Citation | Source check | Verdict |
|---|---|---|---|
| `loadManifest` trusts any parseable JSON, no validation | `manifest.ts:136-145` | matches exactly (returns `raw` unvalidated) | ✓ accurate |
| `staleEntries` computes stale purely from manifest | `manifest.ts:191-195` | matches | ✓ |
| `classifyPruneEntries` gates delete on `sha256(content)===checksum` | `manifest.ts:197-213` | matches; also confirmed checksum-mismatch → skipped | ✓ |
| `pruneEntries` calls `rm(entry.path,{force:true})`, no scope guard | `manifest.ts:215-229` | matches (`rm` at :226) | ✓ |
| `buildManifest` carries forward `oldManifest.entries` untouched | `manifest.ts:169-179` | matches (:169-170 carried-forward filter) | ✓ |
| backup-path traversal guard `resolveBackupPath` | `manifest.ts:236-242` | matches (`..`/absolute rel rejected) | ✓ |
| `ProductConfig.permissions` is `unknown` | `model.ts:8-12` | matches exactly | ✓ |
| OpenCode `permission` (singular) passthrough | `adapters/opencode.ts:16` | matches exactly | ✓ |
| Claude/Grok validate via `stringList`/`patternList`; Codex via `safeSandboxModes` | `shared.ts:10-16`, `codex.ts:7` | matches | ✓ |
| `defaultRunner`/`discoverOpenCodeModels` spawn bare `opencode`/`opencode2` with `cwd` | `opencode-discovery.ts:22-47` | matches | ✓ |
| `runSelfUpdate`/`defaultSpawner` spawn bare `pnpm`/`npm`/`forge-ai`, inherited stdio | `self-update.ts:81,90,94-97` | matches (only `npm-global-homebrew` uses absolute `/opt/homebrew/bin/npm`) | ✓ |
| model discovery invoked with `cwd=process.cwd()` during install/configure | `cli.ts:396`, `cli.ts:713` | matches | ✓ |
| `--to <version>` unvalidated → `${PACKAGE}@${version}` | `self-update.ts:35-48`, `cli.ts:240-243` | matches | ✓ |
| `parseModelMap` splitting | `cli.ts:436-444` | **see correction below** | ⚠ corrected |
| `tomlString` = `JSON.stringify` | `shared.ts:18-20` | matches | ✓ |
| Claude-only `user-invocable` read by Grok/OpenCode | `grok.ts:41`, `opencode.ts:24` | matches | ✓ |
| vestigial `import.meta.url` guard | `cli.ts:833` | matches | ✓ |
| aliases `i`/`upgrade`/`ls` undocumented in `showUsage` | `cli.ts:754-763`, `802-813` | matches | ✓ |
| `fetchLatest` swallows failures; `.catch(()=>undefined)` at callsite | `version-check.ts:58-71`, `cli.ts:101-103` | matches | ✓ |
| `classifyPruneEntries` re-throws non-ENOENT | `manifest.ts:204-207` | matches | ✓ |
| TOCTOU classify→write | `processor.ts:231-241`, `writer.ts:6-20` | matches | ✓ |
| **Web N/A**: 3 CLI-only deps; `#files` ships no static assets; no `listen(`/`createServer` in `src/` | `package.json` + grep | confirmed (only `fetch` is the version-check registry call; no HTTP server) | ✓ |
| **Mobile N/A**: no Swift/Kotlin/Flutter/RN/Expo in `src/`; Node `>=20` target | grep + `package.json` | confirmed (only `export`-substring false positives for "expo") | ✓ |
| **`workdir/` out of scope**: untracked, excluded from `#files` | `git ls-files workdir` | returns 0 tracked entries | ✓ |

### Corrections made to source reports (all minor)

1. **Manifest filename** (api-report A, summary §2): user-scope manifest is `user-manifest.json`, not `manifest.json`. Corrected to name both scopes' files.
2. **M3 description** (api-report): code splits on *every* `=`, not "the first `=`"; extra segments beyond the first two are silently dropped, while fully-empty name/model segments are *rejected* (error), not silently dropped. Corrected.
3. **Test count** (api-report +5, summary §8): "~90" → "~101" (actual `test(` count in `tests/forge-cli.test.ts`).
4. **Fix B resolution hint** (api-fix): "Node's `findExecutable`" → clarified there is no built-in `node:findExecutable`; use `which`/`where`/PATH scan.

All cited test line ranges in `api-report.md` (1037-1040, 1042-1051, 1105-1120, 1122-1173, 1125-1156, 1175-1195, 1210-1217) were verified against `tests/forge-cli.test.ts` and match the described tests.

Verdict: **PASS** (after corrections). No overstated finding found.

---

## 4. Lens 3 — Security breaker (A, B, C re-derived)

### A — unauthenticated manifest drives arbitrary deletion/overwrite — **CONFIRMED (mechanism proven)**

- **Mechanism (source):** `loadManifest` returns parsed JSON with no schema/path/checksum validation; `staleEntries`→`classifyPruneEntries`→`pruneEntries` compute deletion purely from manifest `path` + `sha256`, and `pruneEntries` calls `rm(entry.path, {force:true})`. No scope guard anywhere.
- **Prerequisite:** an actor with user-level write access to `~/.forge/state/` (a local attacker, a malicious process running as the user, or a compromised agent process that Forge grants file tools to) AND the user runs `forge-ai update --prune` or `uninstall` under `--yes`/`--force` (or consents interactively). This precondition is a genuine trust boundary — the report and summary correctly call it out.
- **Blast radius:** deletion/overwrite of any file the `forge-ai` process can read. Note the checksum is *not* a true gate for the `--force` path: a wrong checksum routes the entry to the `checksum-mismatch`→`modifiedWithConsent` branch, which still deletes (with backup) under `--yes`/`--force`. The report's sentence 4 already documents this.
- **Proof (isolated, no user data):** wrote a poisoned `user-manifest.json` whose single entry pointed at a file *outside* any Forge-managed dir with a matching self-computed sha256, then ran the real compiled pipeline:

```
$ node .../forge-adv-a/run.mjs
loaded manifest entries[0].path = .../victimdir/important.txt
deletable: [ '.../victimdir/important.txt' ]  skipped: []
RESULT: victim file WAS DELETED by pruneEntries (no scope check)
```

`loadManifest → staleEntries → classifyPruneEntries → pruneEntries` deleted an arbitrary out-of-scope file with no scope validation.

- **Severity:** High (integrity/data-loss) is well-founded. The report's "mechanism-confirmed, exploitability not yet demonstrated" framing was appropriately conservative; this gate has now supplied the missing end-to-end evidence.

### B — subprocess resolved from PATH over attacker-influenced cwd — **CONFIRMED (mechanism proven)**

- **Mechanism (source):** `defaultRunner` (`opencode-discovery.ts:22-29`) `spawnSync(command, args, {cwd})` with bare names `opencode`/`opencode2`; `defaultSpawner` (`self-update.ts:94-97`) `spawnSync(command, args, {stdio:'inherit'})` for `pnpm`/`npm`/`forge-ai` — no absolute resolution, no allowlist.
- **Prerequisite:** run forge-ai (interactive install/configure for discovery; `self-update` for package managers) in a directory where a malicious `opencode`/`pnpm`/`npm` is earlier on `PATH` (e.g. `node_modules/.bin` via an npm/pnpm script, or a relative PATH entry). The docs' `forge-ai install --source .` pattern makes this practically relevant.
- **Proof (isolated):** placed a fake `opencode` shim first on `PATH`, ran the real compiled `discoverOpenCodeModels`:

```
$ node .../forge-adv-b/run.mjs
discovered models: ["anthropic/claude-sonnet-4"]
--- marker file? ---
PWNED   <<< marker present -> malicious 'opencode' WAS executed
```

The PATH-local `opencode` shim executed with the user's privileges (side-effect marker written) and its stdout was parsed as model list. Confirms a repo/PATH-local `opencode` shadow is actually executed.

- **Severity:** Medium (arbitrary code execution in a dev tool) is well-founded.

### C — OpenCode permission passthrough (`permissions` typed `unknown`) — **CONFIRMED as a validation/contract gap, not an exploit**

- `model.ts:8-12` types `permissions?: unknown`; `opencode.ts:16` emits `artifact.opencode.permissions` verbatim to `fm.permission` with no shape/type/size validation, serialized by `stringifyYaml`. Diverges from Claude/Grok (`stringList`/`patternList`) and Codex (`safeSandboxModes`).
- Correctly rated Low–Medium and framed as a robustness/contract gap; no exploitability is claimed, and none exists (it is a silent-install-of-malformed-config issue, not a code-execution or data-loss path).

Verdict: **PASS — all three findings survive adversarial re-derivation; A and B were additionally proven end-to-end in isolation.** No false positive; if anything, A's delete path is marginally wider than "gated by a checksum" implies (the checksum-mismatch branch also deletes under `--force`), which the report already notes.

---

## 5. Lens 4 — Practical quality of fix specifications

- Every fix (A, B, C, M1–M12) names concrete files, concrete steps, a benefit, and a concrete validation (test cases + `pnpm test`). None prescribe a needless abstraction.
- `summary.md` §6 "architecture suggestions" are correctly labeled as optional and non-blocking, and §5 sequencing is actionable (A/B first + adversarial validation; M2/M12 as one change).
- Two minor portability notes (not blockers): (a) Fix B's allowlist inherits the existing macOS-specific `/opt/homebrew/bin/npm`; (b) Fix A's per-scope root allowlist must be derived from `src/paths.ts` `userBase`/`projectBase` so it can't drift from the real install roots. Both are flagged in §7 as suggestions for the build dispatch, not corrections to the report.

Verdict: **PASS.**

---

## 6. Git status / scope confirmation

```
$ git status --short report/
?? report/

$ git status --short        # whole repo
?? report/
```

- `report/` is entirely untracked; **no tracked application files (`src/`, `bin/`, `tests/`, `package.json`, etc.) were modified** by the audit or by this verification. The only edits this gate made are the four corrections inside `report/*.md` (documented in §3) and this new `report/verification.md`.

---

## 7. Refuted / uncertain candidates

- **Uncertain (external fact, not resolvable from repo):** whether OpenCode's frontmatter key is canonically `permission` (singular). The report already hedges this as a "contract smell" and instructs reconciliation during the fix, so it does not undermine trust. Marked **uncertain, low impact**.
- **Refuted:** the original "~90 tests" figure (actual 101) and the "splits on the first `=`" M3 wording — corrected, not substantive.
- **Refuted:** no evidence of any additional un-reported subprocess/network boundary — grep confirmed `spawnSync` exists only in `self-update.ts` and `opencode-discovery.ts`, and the only outbound HTTP is `version-check.ts` (fetcher abstraction). Finding B's scope is complete.
- **Refuted:** mobile/web markers in `src/` — the only "expo" hits are the substring in `export`; no actual mobile/web code exists. N/A determinations stand.

---

## 8. Per-report verdicts

| Report | Verdict | Notes |
|---|---|---|
| `web-report.md` | **PASS** | N/A determination accurate |
| `web-fix.md` | **PASS** | no findings → no fixes, by construction |
| `mobile-report.md` | **PASS** | N/A determination accurate |
| `mobile-fix.md` | **PASS** | no findings → no fixes, by construction |
| `api-report.md` | **PASS** (corrected) | A/B/C + M1–M12 accurate; A & B proven; M3 wording + test count corrected |
| `api-fix.md` | **PASS** (corrected) | concrete fixes; `findExecutable` hint corrected |
| `summary.md` | **PASS** (corrected) | priorities/links consistent; manifest path + test count corrected |

## 9. Final gate verdict

**The audit deliverables are trustworthy.** All three headline findings (A, B, C) survive independent adversarial re-derivation; A and B were additionally proven end-to-end in isolated temp directories (no user data, no external systems). The web/mobile N/A determinations are accurate, the finding→fix mapping is complete and 1:1, severities are honest (inference vs. proven correctly distinguished — and now backed by proof for A/B), and the fix specs are concrete and actionable. Four minor factual corrections were applied directly to `report/*.md`; no application code was modified.

No feature-state transition is claimed (this audit has no `.forge` feature-list). Recommended next step: a build dispatch to implement `api-fix.md` §A and §B (highest severity, now proven), followed by the P2/P3/P4 items per `summary.md` §5.
