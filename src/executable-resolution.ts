import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';

export type ResolveExecutableOptions = {
  cwd?: string;
  path?: string;
};

function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function safeCandidate(candidate: string, cwd: string | undefined): string | undefined {
  try {
    accessSync(candidate, constants.F_OK);
  } catch {
    return undefined;
  }
  if (cwd) {
    const resolvedCandidate = canonicalize(candidate);
    const resolvedCwd = canonicalize(cwd);
    const rel = path.relative(resolvedCwd, resolvedCandidate);
    // At-or-inside cwd → reject, so a repo-local shim (e.g. node_modules/.bin) cannot shadow the
    // real binary. Both sides canonicalized (realpath) to cover symlinked PATH entries/dotdirs.
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return undefined;
  }
  return path.resolve(candidate);
}

// Portable PATH scan (separator path.delimiter: ':' POSIX, ';' Windows). Returns the absolute path
// to the first existing executable named `command` on PATH, or undefined — except any candidate
// that canonicalizes to at-or-inside `cwd`, which is rejected so a repo-local shim cannot shadow
// the real binary. An already-absolute `command` is treated as a direct candidate (existence + cwd
// check, no PATH re-scan).
// Windows note: existence only (access F_OK), NOT PATHEXT (.cmd/.bat/.exe) — by design, fail-closed:
// a Windows `opencode`/`pnpm` invoked via a .cmd wrapper will not resolve and discovery/self-update
// degrade to their safe fallback. Full PATHEXT support is a documented follow-up, not this change.
export function resolveExecutable(command: string, options: ResolveExecutableOptions = {}): string | undefined {
  if (path.isAbsolute(command)) return safeCandidate(command, options.cwd);
  const pathEnv = options.path ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '') continue;
    const resolved = safeCandidate(path.join(dir, command), options.cwd);
    if (resolved) return resolved;
  }
  return undefined;
}
