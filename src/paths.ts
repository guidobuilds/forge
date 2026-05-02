import os from 'node:os';
import path from 'node:path';
import type { Platform, Scope, SourceKind } from './model.js';

export function resolveOutputPath(platform: Platform, kind: SourceKind, scope: Scope, name: string, cwd = process.cwd(), home = os.homedir()): string {
  const base = scope === 'user' ? userBase(platform, kind, home) : projectBase(platform, kind, cwd);
  return kind === 'agent' && platform === 'codex'
    ? path.join(base, `${name}.toml`)
    : kind === 'agent'
      ? path.join(base, `${name}.md`)
      : path.join(base, name, 'SKILL.md');
}

function userBase(platform: Platform, kind: SourceKind, home: string): string {
  if (platform === 'opencode') return path.join(home, '.config', 'opencode', kind === 'agent' ? 'agents' : 'skills');
  if (platform === 'claude') return path.join(home, '.claude', kind === 'agent' ? 'agents' : 'skills');
  return kind === 'agent' ? path.join(home, '.codex', 'agents') : path.join(home, '.agents', 'skills');
}

function projectBase(platform: Platform, kind: SourceKind, cwd: string): string {
  if (platform === 'opencode') return path.join(cwd, '.opencode', kind === 'agent' ? 'agents' : 'skills');
  if (platform === 'claude') return path.join(cwd, '.claude', kind === 'agent' ? 'agents' : 'skills');
  return kind === 'agent' ? path.join(cwd, '.codex', 'agents') : path.join(cwd, '.agents', 'skills');
}
