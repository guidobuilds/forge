import { spawnSync } from 'node:child_process';
import { resolveExecutable } from './executable-resolution.js';
import { isKnownCodexModel } from './adapters/codex-known.js';
import { isKnownGrokModel } from './adapters/grok-known.js';
import type { Platform } from './model.js';

// ============================================================================
// Shared model discovery.
//
// One runner abstraction, one set of shared caps, and four per-platform parsers,
// all funneled through `discoverModels(platform, cwd)`. Every parser collapses
// ANY failure to `undefined` (never throws) so the caller falls back to a curated
// set or free text — never an empty list, never a raw stack trace. Discovery
// queries the *installed CLI* so results reflect the user's actual binary,
// config and credentials; curated `known*Models` sets are offline fallback only.
// ============================================================================

export type ModelDiscoveryRunner = (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => { status: number | null; stdout: string };

export const MODEL_DISCOVERY_TIMEOUT_MS = 5000;
export const MODEL_DISCOVERY_MAX_STDOUT_BYTES = 1024 * 1024; // Codex live is ~327 KB — 1 MB headroom.
export const MODEL_DISCOVERY_MAX_MODELS = 500;

// defaultRunner: spawnSync + resolveExecutable (moved here from opencode-discovery so the module graph
// stays acyclic and the runner/caps live in one place). Binaries are resolved to absolute paths and
// any candidate inside cwd (a repo-local shim) is rejected by resolveExecutable. On Windows there is
// no PATHEXT, so `.cmd`/`.bat`/`.exe` wrappers won't resolve and discovery degrades to the curated
// fallback — fail-closed, documented, not fixed here.
export const defaultRunner: ModelDiscoveryRunner = (command, args, options) => {
  const resolved = resolveExecutable(command, { cwd: options.cwd });
  if (!resolved) return { status: null, stdout: '' };
  try {
    const result = spawnSync(resolved, args, { timeout: options.timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
};

function exceedsStdoutCap(stdout: string): boolean {
  // Byte-accurate: compare Buffer.byteLength (UTF-8 bytes), not `.length` (UTF-16 code units).
  return Buffer.byteLength(stdout, 'utf8') > MODEL_DISCOVERY_MAX_STDOUT_BYTES;
}

function dedupeStable(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) { seen.add(value); out.push(value); }
  }
  return out;
}

// ============================================================================
// OpenCode — `opencode` / `opencode2 models` (preserved behavior, caps added)
// ============================================================================
// `opencode models` prints exactly the models this user can actually pick — filtered to whichever
// providers have credentials (env var, stored auth, or a config/plugin-declared provider), not the
// full models.dev catalog. This is deliberately NOT config-file parsing: OpenCode's config schema
// differs between v1 (`provider`, singular) and the v2 preview (`providers`, plural), env-var- and
// credential-connected providers appear in neither file, and OPENCODE_CONFIG_DIR can relocate the
// whole config tree — the CLI itself is the only thing that resolves all of that correctly.
// Tries `opencode` (v1) then `opencode2` (v2 preview). v2 gained a real `models` command in
// `anomalyco/opencode` commit 30d14000 (2026-08-06); any v2 build older than that has no such
// subcommand and treats `models` as a positional `<directory>` (crash) — caught here regardless.
const modelLinePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/;

export function discoverOpenCodeModels(cwd: string, timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS, runner: ModelDiscoveryRunner = defaultRunner): string[] | undefined {
  for (const command of ['opencode', 'opencode2']) {
    const result = runner(command, ['models'], { cwd, timeoutMs });
    if (result.status !== 0) continue;
    if (exceedsStdoutCap(result.stdout)) return undefined;
    const lines = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => modelLinePattern.test(line));
    if (lines.length > 0) return lines.slice(0, MODEL_DISCOVERY_MAX_MODELS);
  }
  return undefined;
}

// ============================================================================
// Codex — `codex debug models` (merged catalog; `--bundled` deferred, documented)
// ============================================================================
// Codex has no stable offline model enum. `codex debug models` prints the *merged* catalog (the
// remote-refreshed set Codex sees, ~327 KB) as JSON `{ "models": [...] }`; each entry has `slug`,
// `display_name`, `visibility` (`list` | `hide`), `context_window`, `priority`, `description`, and
// `supported_reasoning_levels`. User-selectable ids are `visibility === 'list'`; each slug is then
// trimmed and re-validated through `isKnownCodexModel` so empty/whitespace ids can never leak through.
//
// Bundled-vs-merged decision: we default to the MERGED catalog (remote refresh) under the shared
// timeout because it is closer to what the user can actually select. `--bundled` (offline-deterministic,
// skips the remote refresh) is a documented follow-up, NOT built: a `--bundled` re-run on timeout would
// double latency, and the curated `knownCodexModels` offline fallback already covers the deterministic
// case. Caveat (openai/codex issue 33146): the merged catalog can diverge from the TUI `/model` picker
// (stale `~/.codex/models_cache.json`) — mitigated by suggestions-only UX + the `Custom…` free-text
// escape. `supported_reasoning_levels` is deliberately discarded (model-id-only selection).
export function discoverCodexModels(cwd: string, timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS, runner: ModelDiscoveryRunner = defaultRunner): string[] | undefined {
  const result = runner('codex', ['debug', 'models'], { cwd, timeoutMs });
  if (result.status !== 0) return undefined;
  if (exceedsStdoutCap(result.stdout)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  const slugs: string[] = [];
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { slug?: unknown; visibility?: unknown };
    if (candidate.visibility !== 'list') continue;
    if (typeof candidate.slug !== 'string') continue;
    // Trim and re-validate each slug through the permissive per-platform validator, mirroring the grok
    // parser's discipline (explore.md §4): an empty/whitespace-only id must never leak into the choices.
    const id = candidate.slug.trim();
    if (!isKnownCodexModel(id)) continue;
    slugs.push(id);
  }
  const deduped = dedupeStable(slugs);
  if (deduped.length === 0) return undefined;
  return deduped.slice(0, MODEL_DISCOVERY_MAX_MODELS);
}

// ============================================================================
// Grok — `grok models` (banner-ignoring, `isKnownGrokModel`-validated)
// ============================================================================
// `grok models` output can carry a `You are not authenticated.` banner before the model list; the list
// uses `* <model> (default)` for the default and `- <model>` for available. The banner is noise and
// never a model line.
//
// Fusion policy: `grok models` advertises the binary's known catalog (e.g. `grok-4.6`, `grok-4.5`) but
// does NOT advertise the Forge-specific aliases the curated set carries (`grok-build`, `grok-build-plan`,
// `grok-composer-2.5-fast`, `inherit`). Those are valid config values today, so on a successful live
// query they are merged in as extras (live-first, deduped, stable order via `mergeLiveWithCurated`); on
// failure the curated set is the whole fallback. We must not silently drop them on a live query.
const grokModelLinePattern = /^[*\-]\s+(\S+)/;

export function discoverGrokModels(cwd: string, timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS, runner: ModelDiscoveryRunner = defaultRunner): string[] | undefined {
  const result = runner('grok', ['models'], { cwd, timeoutMs });
  if (result.status !== 0) return undefined;
  if (exceedsStdoutCap(result.stdout)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const match = grokModelLinePattern.exec(line.trim());
    if (!match) continue;
    const id = match[1];
    if (!isKnownGrokModel(id)) continue;
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  if (out.length === 0) return undefined;
  return out.slice(0, MODEL_DISCOVERY_MAX_MODELS);
}

// ============================================================================
// Claude — no dynamic source (honest undefined)
// ============================================================================
// Claude Code has NO CLI model-enumeration command: `claude --help` exposes only `--model` /
// `--fallback-model` flags and a non-scriptable in-TUI `/model`. There is no `claude models` /
// `claude list`. So this always returns undefined by design — the curated `knownClaudeModels` set plus
// the free-text `Custom…` escape is the honest fallback. Do NOT add a fake dynamic source here; the
// `discoverModels` dispatch keeps a `claude` branch so a real source could be added later without
// touching the caller.
export function discoverClaudeModels(cwd: string, timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS, runner: ModelDiscoveryRunner = defaultRunner): string[] | undefined {
  return undefined;
}

// ============================================================================
// Dispatcher — one call per platform. Returns undefined on ANY failure → caller falls back.
// ============================================================================
export function discoverModels(platform: Platform, cwd: string, runner: ModelDiscoveryRunner = defaultRunner, timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS): string[] | undefined {
  switch (platform) {
    case 'opencode': return discoverOpenCodeModels(cwd, timeoutMs, runner);
    case 'codex': return discoverCodexModels(cwd, timeoutMs, runner);
    case 'grok': return discoverGrokModels(cwd, timeoutMs, runner);
    case 'claude': return discoverClaudeModels(cwd, timeoutMs, runner);
    default: return undefined;
  }
}

// ============================================================================
// Fusion helper — live-first, then curated extras not already present, deduped,
// order preserved. Generic over the curated iterable so this module does not
// depend on any particular curated set.
// ============================================================================
export function mergeLiveWithCurated(live: string[], curated: Iterable<string>): string[] {
  const seen = new Set(live);
  const out = [...live];
  for (const item of curated) {
    if (!seen.has(item)) { seen.add(item); out.push(item); }
  }
  return out;
}
