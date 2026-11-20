import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveExecutable } from './executable-resolution.js';

// Candidate identity for verification receipts.
//
// The identity is deliberately conservative and Git-only for the MVP. It covers every tracked and
// non-ignored untracked path in the worktree (including deletions) plus the Git index, and records
// file type, executable bit, symlink target (never followed), and content digest. Ignored files are
// excluded by Git itself.
//
// Forge-level exclusions are narrow and operational:
// - `.forge/evidence/` (receipt store), so writing receipts cannot invalidate the candidate;
// - named Forge operational outputs under `.forge/` (`lessons.md`, `index.md` at the root and
//   `verification.md`, `progress.md`, `session-handoff.md`, `build-log.md`, `change-report.html`
//   under `.forge/<slug>/`), so recording evidence/continuity/closure does not invalidate the code
//   it describes;
// - `feature-list.json` is NOT excluded: only its volatile progress/evidence fields are normalized
//   away. `behavior`, `verification`, `dependencies`, `archiveWhen`, task `validation` and every
//   other semantic field remain hashed.
//
// Source, tests, checks, reproductions, `explore.md`/`design.md`/`plan.md`, and all semantic
// feature-list fields remain inside the identity. Symlinked ancestors are rejected before reading,
// so a tracked path cannot be read through a directory symlink (including one that escapes the
// worktree). Non-UTF-8 paths fail closed rather than being silently decoded.
//
// This is content identity, not a security boundary: a same-permission writer can alter both the
// worktree and the receipts, and a temporary edit restored between the before/after captures is not
// observable here. It also cannot prove semantic correctness of a check.

export const EVIDENCE_DIR = '.forge/evidence';
const IDENTITY_SCHEMA_VERSION = 1;
const IDENTITY_EXCLUSIONS = [EVIDENCE_DIR] as const;
const IDENTITY_OPERATIONAL_EXCLUSIONS = [
  '.forge/lessons.md',
  '.forge/index.md',
  '.forge/<slug>/verification.md',
  '.forge/<slug>/progress.md',
  '.forge/<slug>/session-handoff.md',
  '.forge/<slug>/build-log.md',
  '.forge/<slug>/change-report.html'
] as const;
const IDENTITY_NORMALIZATIONS = [
  '.forge/<slug>/feature-list.json: updatedAt, features[].state, features[].evidence, tasks[].state, tasks[].notes'
] as const;
const OPERATIONAL_OUTPUTS = new Set(['verification.md', 'progress.md', 'session-handoff.md', 'build-log.md', 'change-report.html']);
const OPERATIONAL_CLOSURE_OUTPUTS = new Set(['lessons.md', 'index.md']);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 128 * 1024 * 1024;

export type CandidateIdentity = {
  schemaVersion: typeof IDENTITY_SCHEMA_VERSION;
  vcs: 'git';
  root: string;
  head: string | null;
  worktreeDigest: string;
  indexDigest: string;
  digest: string;
  fileCount: number;
  exclusions: string[];
  operationalExclusions: string[];
  normalizations: string[];
};

export type IdentityFailureCode = 'not-git' | 'git-missing' | 'git-error' | 'io-error' | 'state-error' | 'unsafe-path';

export type CandidateIdentityResult =
  | { ok: true; identity: CandidateIdentity }
  | { ok: false; code: IdentityFailureCode; message: string };

export type GitRootResult =
  | { ok: true; root: string }
  | { ok: false; code: IdentityFailureCode; message: string };

type GitContext = { gitPath: string; root: string };
type GitContextResult = { ok: true; context: GitContext } | { ok: false; code: IdentityFailureCode; message: string };

type GitResult = { status: number | null; stdout: Buffer; stderr: string; error: string | null };

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runGit(gitPath: string, args: string[], cwd: string): GitResult {
  const result = spawnSync(gitPath, args, {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER
  });
  const stderr = result.stderr ? result.stderr.toString('utf8') : '';
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr,
    error: result.error ? result.error.message : null
  };
}

function gitFailureMessage(result: GitResult): string {
  return result.error ?? (result.stderr.trim() || 'git command failed');
}

function splitNul(buffer: Buffer): Buffer[] {
  const values: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      if (index > start) values.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < buffer.length) values.push(buffer.subarray(start));
  return values;
}

// Exported for the injected unit test: APFS rejected a real non-UTF-8 fixture before this branch
// could run, so the test exercises the byte-level predicate instead of claiming filesystem proof.
export function isUtf8PathBytes(bytes: Buffer): boolean {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes);
}

function decodeUtf8Path(bytes: Buffer): string | undefined {
  return isUtf8PathBytes(bytes) ? bytes.toString('utf8') : undefined;
}

function normalizeRelative(relative: string): string {
  return relative.split(path.sep).join('/');
}

function isEvidenceStore(relative: string): boolean {
  const normalized = normalizeRelative(relative);
  return normalized === EVIDENCE_DIR || normalized.startsWith(`${EVIDENCE_DIR}/`);
}

function isOperationalOutput(relative: string): boolean {
  const parts = normalizeRelative(relative).split('/');
  if (parts[0] !== '.forge') return false;
  if (parts.length === 2) return OPERATIONAL_CLOSURE_OUTPUTS.has(parts[1]);
  if (parts.length === 3) return OPERATIONAL_OUTPUTS.has(parts[2]);
  return false;
}

function isFeatureList(relative: string): boolean {
  const parts = normalizeRelative(relative).split('/');
  return parts.length === 3 && parts[0] === '.forge' && parts[2] === 'feature-list.json';
}

function isExcluded(relative: string): boolean {
  return isEvidenceStore(relative) || isOperationalOutput(relative);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Normalize ONLY volatile progress/evidence fields. Anything that defines the accepted behavior or
// check contract stays in the identity; a malformed ledger fails closed instead of being ignored.
function normalizeFeatureList(text: string, relative: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${relative} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${relative} must be a JSON object to normalize volatile fields`);
  const copy = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  delete copy.updatedAt;
  if (Array.isArray(copy.features)) {
    const normalizedFeatures = copy.features.map((feature) => {
      if (!isPlainObject(feature)) return feature;
      const normalizedFeature = { ...feature };
      delete normalizedFeature.state;
      delete normalizedFeature.evidence;
      if (Array.isArray(normalizedFeature.tasks)) {
        const normalizedTasks = normalizedFeature.tasks.map((task) => {
          if (!isPlainObject(task)) return task;
          const normalizedTask = { ...task };
          delete normalizedTask.state;
          delete normalizedTask.notes;
          return normalizedTask;
        });
        normalizedFeature.tasks = normalizedTasks.filter((task) => !isPlainObject(task) || Object.keys(task).length > 0);
      }
      return normalizedFeature;
    });
    copy.features = normalizedFeatures.filter((feature) => !isPlainObject(feature) || Object.keys(feature).length > 0);
  }
  return JSON.stringify(copy);
}

function resolveInsideRoot(root: string, relative: string): string | undefined {
  if (relative.length === 0 || path.isAbsolute(relative)) return undefined;
  const absolute = path.resolve(root, relative);
  const back = path.relative(root, absolute);
  if (back === '' || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) return undefined;
  return absolute;
}

type AncestorState =
  | { status: 'ok' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

// lstat only the final component would follow a symlinked ancestor. Walk every parent component
// under the real worktree root and fail closed on a symlink (external escape or internal
// misattribution) before reading the candidate bytes.
async function checkAncestors(root: string, relative: string): Promise<AncestorState> {
  const parts = normalizeRelative(relative).split('/');
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part || part === '.' || part === '..') {
      return { status: 'error', message: `Refusing unsafe path segment in ${relative}` };
    }
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'error', message: `Could not inspect ancestor of ${relative}: ${(error as Error).message}` };
    }
    if (stat.isSymbolicLink()) {
      return { status: 'error', message: `Symlinked ancestor ${normalizeRelative(path.relative(root, current))} is not followed for ${relative}` };
    }
    if (!stat.isDirectory()) return { status: 'missing' };
  }
  return { status: 'ok' };
}

async function hashFile(filePath: string): Promise<{ digest: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      hash.update(buffer);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return { digest: hash.digest('hex'), size };
}

type WorktreeRecord = {
  path: string;
  type: 'file' | 'symlink' | 'directory' | 'missing' | 'other';
  executable?: boolean;
  mode?: number;
  size?: number;
  digest?: string;
  target?: string;
};

async function resolveGitContext(cwd: string): Promise<GitContextResult> {
  // executable-resolution.ts intentionally has no PATHEXT support; Windows Git is normally
  // `git.exe`, so name it explicitly there rather than declaring every Windows repo unverifiable.
  const gitPath = resolveExecutable(process.platform === 'win32' ? 'git.exe' : 'git', { cwd });
  if (!gitPath) {
    return {
      ok: false,
      code: 'git-missing',
      message: 'Git is required for mechanically verifiable evidence but was not found on PATH (outside the project tree).'
    };
  }

  const top = runGit(gitPath, ['rev-parse', '--show-toplevel'], cwd);
  if (top.status !== 0) {
    return {
      ok: false,
      code: 'not-git',
      message: `This directory is not a Git worktree, so candidate-bound freshness is not available: ${gitFailureMessage(top)}.`
    };
  }
  const rootRaw = top.stdout.toString('utf8').trim();
  if (!rootRaw) return { ok: false, code: 'git-error', message: 'Git did not return a worktree root.' };
  let root: string;
  try {
    root = await realpath(rootRaw);
  } catch {
    root = path.resolve(rootRaw);
  }
  return { ok: true, context: { gitPath, root } };
}

// Shared with the CLI so it can find the receipt store/lock before doing the expensive hash pass.
export async function resolveGitRoot(cwd: string): Promise<GitRootResult> {
  const resolved = await resolveGitContext(cwd);
  if (!resolved.ok) return resolved;
  return { ok: true, root: resolved.context.root };
}

export async function captureCandidateIdentity(cwd: string): Promise<CandidateIdentityResult> {
  const resolved = await resolveGitContext(cwd);
  if (!resolved.ok) return resolved;
  const { gitPath, root } = resolved.context;

  const headResult = runGit(gitPath, ['rev-parse', '--verify', 'HEAD'], root);
  const head = headResult.status === 0 ? headResult.stdout.toString('utf8').trim() || null : null;

  const indexResult = runGit(gitPath, ['ls-files', '-s', '-z'], root);
  if (indexResult.status !== 0) {
    return { ok: false, code: 'git-error', message: `Could not read the Git index: ${gitFailureMessage(indexResult)}` };
  }
  const indexRecords: Array<{ path: string; mode: string; stage: string; object?: string; digest?: string }> = [];
  for (const entry of splitNul(indexResult.stdout)) {
    const tab = entry.indexOf(0x09);
    if (tab === -1) {
      return { ok: false, code: 'git-error', message: 'Unexpected Git index entry without a path separator.' };
    }
    const meta = entry.subarray(0, tab).toString('utf8').split(' ');
    const relative = decodeUtf8Path(entry.subarray(tab + 1));
    if (relative === undefined) {
      return { ok: false, code: 'unsafe-path', message: 'The Git index contains a non-UTF-8 path; refusing to claim full candidate coverage.' };
    }
    if (meta.length !== 3) {
      return { ok: false, code: 'git-error', message: `Unexpected Git index metadata for ${relative}.` };
    }
    if (isExcluded(relative)) continue;
    if (isFeatureList(relative) && meta[0].startsWith('100')) {
      const blob = runGit(gitPath, ['cat-file', 'blob', meta[1]], root);
      if (blob.status !== 0) {
        return { ok: false, code: 'git-error', message: `Could not read the indexed feature ledger ${relative}: ${gitFailureMessage(blob)}` };
      }
      let normalized: string;
      try {
        normalized = normalizeFeatureList(blob.stdout.toString('utf8'), relative);
      } catch (error) {
        return { ok: false, code: 'state-error', message: (error as Error).message };
      }
      indexRecords.push({ path: relative, mode: meta[0], stage: meta[2], digest: sha256Text(normalized) });
    } else {
      indexRecords.push({ path: relative, mode: meta[0], stage: meta[2], object: meta[1] });
    }
  }
  indexRecords.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : Number(a.stage) - Number(b.stage)));
  const indexDigest = sha256Text(JSON.stringify(indexRecords));

  const worktreeResult = runGit(gitPath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  if (worktreeResult.status !== 0) {
    return { ok: false, code: 'git-error', message: `Could not enumerate the candidate: ${gitFailureMessage(worktreeResult)}` };
  }
  const listed = splitNul(worktreeResult.stdout);
  const uniquePaths = new Map<string, string>();
  for (const bytes of listed) {
    const relative = decodeUtf8Path(bytes);
    if (relative === undefined) {
      return { ok: false, code: 'unsafe-path', message: 'The worktree contains a non-UTF-8 path; refusing to claim full candidate coverage.' };
    }
    uniquePaths.set(bytes.toString('hex'), relative);
  }
  const unsafePaths: string[] = [];
  const records: WorktreeRecord[] = [];

  for (const relative of uniquePaths.values()) {
    if (isExcluded(relative)) continue;
    const absolute = resolveInsideRoot(root, relative);
    if (!absolute) {
      unsafePaths.push(relative);
      continue;
    }
    const ancestor = await checkAncestors(root, relative);
    if (ancestor.status === 'error') {
      return { ok: false, code: 'unsafe-path', message: ancestor.message };
    }
    if (ancestor.status === 'missing') {
      records.push({ path: relative, type: 'missing' });
      continue;
    }
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        records.push({ path: relative, type: 'missing' });
        continue;
      }
      return { ok: false, code: 'io-error', message: `Could not inspect ${relative}: ${(error as Error).message}` };
    }
    if (stat.isSymbolicLink()) {
      let target: string | undefined;
      try {
        target = decodeUtf8Path(await readlink(absolute, { encoding: 'buffer' }));
      } catch (error) {
        return { ok: false, code: 'io-error', message: `Could not read symlink ${relative}: ${(error as Error).message}` };
      }
      if (target === undefined) {
        return { ok: false, code: 'unsafe-path', message: `Symlink ${relative} has a non-UTF-8 target; refusing to claim full candidate coverage.` };
      }
      records.push({ path: relative, type: 'symlink', target });
      continue;
    }
    if (stat.isFile()) {
      try {
        if (isFeatureList(relative)) {
          const normalized = normalizeFeatureList((await readFile(absolute)).toString('utf8'), relative);
          records.push({
            path: relative,
            type: 'file',
            executable: (stat.mode & 0o111) !== 0,
            size: Buffer.byteLength(normalized, 'utf8'),
            digest: sha256Text(normalized)
          });
        } else {
          const hashed = await hashFile(absolute);
          records.push({ path: relative, type: 'file', executable: (stat.mode & 0o111) !== 0, size: hashed.size, digest: hashed.digest });
        }
      } catch (error) {
        if (isFeatureList(relative)) return { ok: false, code: 'state-error', message: (error as Error).message };
        return { ok: false, code: 'io-error', message: `Could not hash ${relative}: ${(error as Error).message}` };
      }
      continue;
    }
    if (stat.isDirectory()) {
      records.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 });
      continue;
    }
    records.push({ path: relative, type: 'other', mode: stat.mode & 0o777 });
  }

  if (unsafePaths.length > 0) {
    return {
      ok: false,
      code: 'unsafe-path',
      message: `Refusing to identify a candidate with unsafe path(s): ${unsafePaths.slice(0, 3).join(', ')}${unsafePaths.length > 3 ? ', …' : ''}`
    };
  }

  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const worktreeDigest = sha256Text(JSON.stringify(records));
  const exclusions = [...IDENTITY_EXCLUSIONS];
  const operationalExclusions = [...IDENTITY_OPERATIONAL_EXCLUSIONS];
  const normalizations = [...IDENTITY_NORMALIZATIONS];
  const digest = sha256Text(JSON.stringify({ version: IDENTITY_SCHEMA_VERSION, exclusions, operationalExclusions, normalizations, worktreeDigest, indexDigest }));

  return {
    ok: true,
    identity: {
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      vcs: 'git',
      root,
      head,
      worktreeDigest,
      indexDigest,
      digest,
      fileCount: records.length,
      exclusions,
      operationalExclusions,
      normalizations
    }
  };
}

export function sameCandidate(a: CandidateIdentity, b: CandidateIdentity): boolean {
  return a.vcs === b.vcs && a.root === b.root && a.digest === b.digest;
}
