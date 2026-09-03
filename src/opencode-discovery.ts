import { spawnSync } from 'node:child_process';
import { resolveExecutable } from './executable-resolution.js';

// `opencode models` prints exactly the models this user can actually pick — filtered to whichever
// providers have credentials (env var, stored auth, or a config/plugin-declared provider), not the
// full models.dev catalog. This is deliberately NOT config-file parsing: OpenCode's config schema
// differs between v1 (`provider`, singular) and the v2 preview (`providers`, plural), env-var- and
// credential-connected providers appear in neither file, and OPENCODE_CONFIG_DIR can relocate the
// whole config tree — the CLI itself is the only thing that resolves all of that correctly.
// See .forge/harness-agnostic-adapters/decisions.md for the research this is based on.
//
// Tries `opencode` (v1) then `opencode2` (v2 preview). v2 gained a real `models` command in
// `anomalyco/opencode` commit 30d14000 (2026-08-06, "feat(cli): add models command") — it queries
// the running background service via `client.model.list()` and prints sorted `provider/model`
// lines, same shape as v1. Any v2 build older than that commit has no such subcommand, and its CLI
// parser (effect/unstable/cli `Spec`) treats the unrecognized `models` token as the root command's
// positional `<directory>` argument instead of erroring — so it tries to chdir into a `models/`
// folder and crashes. That failure is caught cleanly here regardless (stderr piped and discarded,
// non-zero/`null` exit status falls through to `undefined` below) — it only becomes visible if
// someone runs `opencode2 models` directly in their own shell, not through this function.
export type ModelDiscoveryRunner = (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => { status: number | null; stdout: string };

const defaultRunner: ModelDiscoveryRunner = (command, args, options) => {
  const resolved = resolveExecutable(command, { cwd: options.cwd });
  if (!resolved) return { status: null, stdout: '' };
  try {
    const result = spawnSync(resolved, args, { timeout: options.timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
};

const modelLinePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/;

// Returns undefined (not an empty array) on any failure — binary absent, non-zero exit, or no
// parseable lines — so callers can fall back to a free-text prompt instead of showing an empty
// choice list.
export function discoverOpenCodeModels(cwd: string, timeoutMs = 5000, runner: ModelDiscoveryRunner = defaultRunner): string[] | undefined {
  for (const command of ['opencode', 'opencode2']) {
    const result = runner(command, ['models'], { cwd, timeoutMs });
    if (result.status !== 0) continue;
    const lines = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => modelLinePattern.test(line));
    if (lines.length > 0) return lines;
  }
  return undefined;
}
