import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Platform, Scope, SourceKind } from './model.js';

export function resolveOutputPath(platform: Platform, kind: SourceKind, scope: Scope, name: string, cwd = process.cwd(), home = os.homedir()): string {
  const base = scope === 'user' ? userBase(platform, kind, home) : projectBase(platform, kind, cwd);
  return path.join(base, outputFileName(platform, kind, name));
}

function outputFileName(platform: Platform, kind: SourceKind, name: string): string {
  return kind === 'agent' && platform === 'codex'
    ? `${name}.toml`
    : kind === 'agent'
      ? `${name}.md`
      : path.join(name, 'SKILL.md');
}

// OpenCode v1 (the `opencode` binary) and the v2 preview (`opencode2`) resolve user-scope
// agents/skills from different directories — v1 from `~/.config/opencode/`, v2 from `~/.opencode/`
// (confirmed empirically via `opencode2 debug config`; v2 does not read `~/.config/opencode` at
// all). `userBase` above returns the v1 path, which stays the default single-target path used
// everywhere else; this returns v2's equivalent so callers can additionally target it when it's
// actually present (see `resolveOpenCodeUserV2Path` / `openCodeUserRoots` usage in processor.ts —
// gated on the directory actually existing, not written blindly).
export function openCodeUserRoots(home: string): { v1: string; v2: string } {
  return { v1: path.join(home, '.config', 'opencode'), v2: path.join(home, '.opencode') };
}

export function resolveOpenCodeUserV2Path(kind: SourceKind, name: string, home: string): string {
  const base = path.join(openCodeUserRoots(home).v2, kind === 'agent' ? 'agents' : 'skills');
  return path.join(base, outputFileName('opencode', kind, name));
}

function userBase(platform: Platform, kind: SourceKind, home: string): string {
  if (platform === 'opencode') return path.join(home, '.config', 'opencode', kind === 'agent' ? 'agents' : 'skills');
  if (platform === 'claude') return path.join(home, '.claude', kind === 'agent' ? 'agents' : 'skills');
  if (platform === 'grok') return path.join(home, '.grok', kind === 'agent' ? 'agents' : 'skills');
  return kind === 'agent' ? path.join(home, '.codex', 'agents') : path.join(home, '.agents', 'skills');
}

function projectBase(platform: Platform, kind: SourceKind, cwd: string): string {
  if (platform === 'opencode') return path.join(cwd, '.opencode', kind === 'agent' ? 'agents' : 'skills');
  if (platform === 'claude') return path.join(cwd, '.claude', kind === 'agent' ? 'agents' : 'skills');
  if (platform === 'grok') return path.join(cwd, '.grok', kind === 'agent' ? 'agents' : 'skills');
  return kind === 'agent' ? path.join(cwd, '.codex', 'agents') : path.join(cwd, '.agents', 'skills');
}

const ALL_PLATFORMS: Platform[] = ['opencode', 'claude', 'codex', 'grok'];
const ALL_KINDS: SourceKind[] = ['agent', 'skill'];

function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Single source of truth for the install roots a manifest entry's `path` must live inside.
// Derived from userBase/projectBase/openCodeUserRoots (never hand-enumerated) so it cannot drift
// from the real install locations. home/cwd/projectPath are canonicalized (realpath) so a
// symlinked ~/.claude or project dir does not cause false rejections. Project scope uses the
// manifest's projectPath (the realpath recorded at install), not the caller's current cwd.
export function allowedInstallRoots(scope: Scope, home: string, cwd: string, projectPath?: string): string[] {
  const roots: string[] = [];
  if (scope === 'user') {
    const canonicalHome = canonicalizePath(home);
    for (const platform of ALL_PLATFORMS) {
      for (const kind of ALL_KINDS) roots.push(userBase(platform, kind, canonicalHome));
    }
    roots.push(path.join(openCodeUserRoots(canonicalHome).v2, 'agents'), path.join(openCodeUserRoots(canonicalHome).v2, 'skills'));
  } else {
    const canonicalProject = canonicalizePath(projectPath ?? cwd);
    for (const platform of ALL_PLATFORMS) {
      for (const kind of ALL_KINDS) roots.push(projectBase(platform, kind, canonicalProject));
    }
  }
  return [...new Set(roots)];
}
