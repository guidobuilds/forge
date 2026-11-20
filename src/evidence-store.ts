import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256, writeFileAtomic } from './manifest.js';
import { sameCandidate, type CandidateIdentity } from './evidence-identity.js';
import type { ExecutionResult } from './evidence-runner.js';

// Atomic, append-only receipt store. Receipts live under `<root>/.forge/evidence/<slug>/<check>/`
// and are never rewritten or pruned. The newest filename wins: a later failed/error run therefore
// supersedes an older pass instead of leaving it silently current. A corrupt or incompatible
// newest receipt is an error, never a fallback to an older success.
//
// Concurrency: the CLI serializes runs per check with an owner lock, and the reader additionally
// rejects any two receipts that share a millisecond prefix as ambiguous. A concurrent run therefore
// cannot hide a later failure behind an earlier pass, even if the store contains old race artifacts.
// The lock is an ordering/containment mechanism, not tamper-proofness: same-permission writers can
// still edit receipts.

export const EVIDENCE_SCHEMA_VERSION = 3;

export type EvidenceState = 'passed' | 'failed' | 'stale' | 'missing' | 'error';

export type EvidenceEnvironment = {
  platform: string;
  arch: string;
  node: string;
};

export type EvidenceContract = {
  schemaVersion: 1;
  requirement: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  requires: string[];
  environment: EvidenceEnvironment;
};

export type DependencySnapshot = {
  checkId: string;
  state: EvidenceState;
  receiptId: string | null;
  candidateDigest: string | null;
  contractDigest: string | null;
};

export type EvidenceReceipt = {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  kind: 'forge-evidence-receipt';
  receiptId: string;
  attemptId: string;
  slug: string;
  checkId: string;
  contract: EvidenceContract;
  contractDigest: string;
  candidate: CandidateIdentity;
  candidateAfter: CandidateIdentity | null;
  identityStable: boolean;
  execution: ExecutionResult;
  dependencies: DependencySnapshot[];
  outcome: 'passed' | 'failed' | 'error';
  reason: string | null;
};

export type LatestReceipt =
  | { state: 'missing'; reason: string }
  | { state: 'error'; reason: string; file: string }
  | { state: 'ok'; receipt: EvidenceReceipt; file: string };

export type Evaluation = {
  state: EvidenceState;
  slug: string;
  checkId: string;
  reason: string | null;
  receiptId: string | null;
  receiptPath: string | null;
};

export type EvidenceLockResult =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; message: string };

const RECEIPT_FILE = /^\d{15}-[a-z0-9]{8}\.json$/;
const ATTEMPT_FILE = /^\d{15}-[a-z0-9]{8}\.json$/;
const LOCK_DIRECTORY = '.lock';
const LOCK_OWNER_FILE = 'owner.json';
const ATTEMPTS_DIRECTORY = '.attempts';
const ATTEMPT_SCHEMA_VERSION = 1;
const LOCK_WAIT_MS = 60_000;
const ADMISSION_LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;
const LOCK_STALE_DEAD_OWNER_MS = 1_000;
const LOCK_STALE_MISSING_OWNER_MS = 5_000;

export type EvidenceAttempt = {
  schemaVersion: typeof ATTEMPT_SCHEMA_VERSION;
  kind: 'forge-evidence-attempt';
  attemptId: string;
  slug: string;
  checkId: string;
  contractDigest: string;
  admittedAt: string;
  pid: number;
};

export type LatestAttempt =
  | { state: 'none' }
  | { state: 'error'; reason: string; file?: string }
  | { state: 'ok'; attempt: EvidenceAttempt; file: string };

export function evidenceRoot(root: string): string {
  return path.join(root, '.forge', 'evidence');
}

export function checkReceiptDirectory(root: string, slug: string, checkId: string): string {
  return path.join(evidenceRoot(root), slug, checkId);
}

function attemptsDirectory(root: string, slug: string): string {
  return path.join(evidenceRoot(root), slug, ATTEMPTS_DIRECTORY);
}

function attemptMarkersDirectory(root: string, slug: string, checkId: string): string {
  return path.join(attemptsDirectory(root, slug), checkId);
}

function admissionLockDirectory(root: string, slug: string, checkId: string): string {
  return path.join(attemptsDirectory(root, slug), '.locks', `${checkId}.lock`);
}

function admissionLocksDirectory(root: string, slug: string): string {
  return path.join(attemptsDirectory(root, slug), '.locks');
}

function evidenceLockDirectory(root: string, slug: string, checkId: string): string {
  return path.join(checkReceiptDirectory(root, slug, checkId), LOCK_DIRECTORY);
}

export function currentEnvironment(): EvidenceEnvironment {
  return { platform: process.platform, arch: process.arch, node: process.version };
}

export function buildEvidenceContract(input: {
  requirement: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  requires: string[];
  environment?: EvidenceEnvironment;
}): { contract: EvidenceContract; contractDigest: string } {
  const contract: EvidenceContract = {
    schemaVersion: 1,
    requirement: input.requirement,
    argv: [...input.argv],
    cwd: path.resolve(input.cwd),
    timeoutMs: input.timeoutMs,
    requires: [...new Set(input.requires)].sort(),
    environment: input.environment ?? currentEnvironment()
  };
  return { contract, contractDigest: sha256(JSON.stringify(contract)) };
}

// Walk every existing component of the store path under the real worktree root. A symlinked
// ancestor (including `.forge`, `.forge/evidence`, the slug, or the check) is rejected before any
// read or write, so a pre-existing symlink cannot redirect receipts outside the repository. A
// missing suffix is allowed: write paths create it after this check.
export async function ensureEvidencePathSafe(root: string, target: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, message: `Evidence path escapes the worktree: ${target}` };
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
      return { ok: false, message: `Could not inspect evidence path ${current}: ${(error as Error).message}` };
    }
    if (stat.isSymbolicLink()) return { ok: false, message: `Evidence path component ${current} is a symlink; refusing to follow it` };
    if (!stat.isDirectory()) return { ok: false, message: `Evidence path component ${current} is not a directory` };
  }
  return { ok: true };
}

// Shared read-path check for metadata: every ancestor must be a real directory, and the final
// component is rejected if it is a symlink unless the caller explicitly owns a documented
// same-permission boundary (the final receipt file today). This is deliberately the same
// containment used by writes; TOCTOU/same-permission swaps remain outside the security boundary.
export async function ensureEvidenceReadPathSafe(
  root: string,
  target: string,
  options: { finalKind?: 'file' | 'directory'; allowFinalSymlink?: boolean } = {}
): Promise<{ ok: true } | { ok: false; message: string }> {
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, message: `Evidence read path escapes the worktree: ${target}` };
  }
  const parts = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const isFinal = index === parts.length - 1;
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
      return { ok: false, message: `Could not inspect evidence read path ${current}: ${(error as Error).message}` };
    }
    if (stat.isSymbolicLink()) {
      if (isFinal && options.allowFinalSymlink) return { ok: true };
      return { ok: false, message: `Evidence read path component ${current} is a symlink; refusing to follow it` };
    }
    if (isFinal) {
      if (options.finalKind === 'directory' && !stat.isDirectory()) {
        return { ok: false, message: `Evidence read path ${current} is not a directory` };
      }
      if (options.finalKind === 'file' && !stat.isFile()) {
        return { ok: false, message: `Evidence read path ${current} is not a regular file` };
      }
      return { ok: true };
    }
    if (!stat.isDirectory()) return { ok: false, message: `Evidence read path component ${current} is not a directory` };
  }
  return { ok: true };
}

export async function listReceiptFiles(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => RECEIPT_FILE.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

// Sequential runs in the same millisecond still sort later than the receipt they supersede. Runs
// are serialized per check by `acquireEvidenceLock`, so a new prefix cannot collide with another
// live run; the reader separately rejects old same-prefix artifacts as ambiguous.
export async function nextReceiptId(root: string, slug: string, checkId: string, nowMs = Date.now()): Promise<string> {
  const directory = checkReceiptDirectory(root, slug, checkId);
  const safety = await ensureEvidencePathSafe(root, directory);
  if (!safety.ok) throw new Error(safety.message);
  const files = await listReceiptFiles(directory);
  const lastPrefix = files.length > 0 ? Number(path.basename(files[files.length - 1]).slice(0, 15)) : 0;
  const prefix = Number.isFinite(lastPrefix) ? Math.max(nowMs, lastPrefix + 1) : nowMs;
  return `${String(prefix).padStart(15, '0')}-${randomUUID().slice(0, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type LockOwner = { pid: number; hostname: string; startedAt: string };

type LockOwnerRead =
  | { state: 'ok'; owner: LockOwner }
  | { state: 'missing' }
  | { state: 'invalid' }
  | { state: 'error'; reason: string };

type LockActivity =
  | { state: 'inactive' }
  | { state: 'active' }
  | { state: 'error'; reason: string };

async function readLockOwner(root: string, lockDir: string): Promise<LockOwnerRead> {
  const ownerPath = path.join(lockDir, LOCK_OWNER_FILE);
  const safety = await ensureEvidenceReadPathSafe(root, ownerPath, { finalKind: 'file' });
  if (!safety.ok) return { state: 'error', reason: safety.message };
  let text: string;
  try {
    text = await readFile(ownerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'error', reason: `Could not read the evidence lock owner: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'invalid' };
  const record = parsed as Record<string, unknown>;
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) return { state: 'invalid' };
  if (typeof record.hostname !== 'string' || typeof record.startedAt !== 'string') return { state: 'invalid' };
  return { state: 'ok', owner: { pid: record.pid, hostname: record.hostname, startedAt: record.startedAt } };
}

async function isStaleLock(root: string, lockDir: string): Promise<boolean> {
  const safety = await ensureEvidenceReadPathSafe(root, lockDir, { finalKind: 'directory' });
  if (!safety.ok) return false;
  let stat;
  try {
    stat = await lstat(lockDir);
  } catch {
    return true;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (!stat.isDirectory()) return ageMs > LOCK_STALE_MISSING_OWNER_MS;
  const owner = await readLockOwner(root, lockDir);
  if (owner.state === 'error') return false;
  if (owner.state === 'missing' || owner.state === 'invalid') return ageMs > LOCK_STALE_MISSING_OWNER_MS;
  if (owner.owner.hostname !== hostname()) return false;
  return !isPidAlive(owner.owner.pid) && ageMs > LOCK_STALE_DEAD_OWNER_MS;
}

// Serialize run publication per check. A second run waits for the owner, then proceeds; a dead
// owner is reclaimed after a short grace. If the wait bound is exceeded, the run fails closed with
// an explicit ambiguity error rather than writing an unordered receipt.
async function acquireOwnedDirectoryLock(
  root: string,
  parentDir: string,
  lockDir: string,
  waitMs: number,
  pollMs: number,
  busyLabel: string
): Promise<EvidenceLockResult> {
  const deadline = Date.now() + waitMs;

  for (;;) {
    const safety = await ensureEvidencePathSafe(root, lockDir);
    if (!safety.ok) return { ok: false, message: safety.message };
    const parentSafety = await ensureEvidencePathSafe(root, parentDir);
    if (!parentSafety.ok) return { ok: false, message: parentSafety.message };
    try {
      await mkdir(parentDir, { recursive: true });
    } catch (error) {
      return { ok: false, message: `Could not create the locking directory: ${(error as Error).message}` };
    }
    const afterMkdir = await ensureEvidencePathSafe(root, lockDir);
    if (!afterMkdir.ok) return { ok: false, message: afterMkdir.message };

    try {
      await mkdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, message: `Could not acquire the evidence lock: ${(error as Error).message}` };
      }
      if (await isStaleLock(root, lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        return { ok: false, message: `${busyLabel} (lock wait timed out)` };
      }
      await sleep(pollMs);
      continue;
    }

    try {
      await writeFile(
        path.join(lockDir, LOCK_OWNER_FILE),
        `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })}\n`,
        { flag: 'wx' }
      );
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, message: `Could not write the evidence lock owner: ${(error as Error).message}` };
    }

    let released = false;
    return {
      ok: true,
      release: async () => {
        if (released) return;
        released = true;
        const owner = await readLockOwner(root, lockDir);
        if (owner.state === 'ok' && owner.owner.pid === process.pid) await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      }
    };
  }
}

export async function acquireEvidenceLock(
  root: string,
  slug: string,
  checkId: string,
  options: { waitMs?: number; pollMs?: number } = {}
): Promise<EvidenceLockResult> {
  return acquireOwnedDirectoryLock(
    root,
    checkReceiptDirectory(root, slug, checkId),
    evidenceLockDirectory(root, slug, checkId),
    options.waitMs ?? LOCK_WAIT_MS,
    options.pollMs ?? LOCK_POLL_MS,
    `Another evidence run is in progress for ${slug}/${checkId}`
  );
}

async function listAttemptFiles(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => ATTEMPT_FILE.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function validateAttempt(value: unknown, slug: string, checkId: string, file: string): EvidenceAttempt | string {
  if (!isObject(value)) return 'attempt is not a JSON object';
  if (value.schemaVersion !== ATTEMPT_SCHEMA_VERSION || value.kind !== 'forge-evidence-attempt') return 'attempt schema is incompatible';
  if (value.slug !== slug || value.checkId !== checkId) return 'attempt belongs to a different slug/check';
  if (typeof value.attemptId !== 'string' || value.attemptId !== path.basename(file, '.json')) return 'attempt id does not match its filename';
  if (typeof value.contractDigest !== 'string' || value.contractDigest.length === 0) return 'attempt contract digest is invalid';
  if (typeof value.admittedAt !== 'string') return 'attempt admittedAt is invalid';
  if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return 'attempt pid is invalid';
  return value as EvidenceAttempt;
}

async function lockDirectoryActive(root: string, lockDir: string): Promise<LockActivity> {
  const safety = await ensureEvidenceReadPathSafe(root, lockDir, { finalKind: 'directory' });
  if (!safety.ok) return { state: 'error', reason: safety.message };
  let stat;
  try {
    stat = await lstat(lockDir);
  } catch {
    return { state: 'inactive' };
  }
  if (!stat.isDirectory()) return { state: 'error', reason: `Evidence lock path ${lockDir} is not a directory` };
  const owner = await readLockOwner(root, lockDir);
  if (owner.state === 'error') return { state: 'error', reason: owner.reason };
  if (owner.state === 'invalid') return { state: 'error', reason: `Evidence lock owner in ${lockDir} is invalid` };
  if (owner.state === 'missing') {
    return Date.now() - stat.mtimeMs <= LOCK_STALE_MISSING_OWNER_MS ? { state: 'active' } : { state: 'inactive' };
  }
  if (owner.owner.hostname !== hostname()) return { state: 'active' };
  return isPidAlive(owner.owner.pid) ? { state: 'active' } : { state: 'inactive' };
}

async function evidenceLockActive(root: string, slug: string, checkId: string): Promise<LockActivity> {
  return lockDirectoryActive(root, evidenceLockDirectory(root, slug, checkId));
}

async function admissionLockActive(root: string, slug: string, checkId: string): Promise<LockActivity> {
  return lockDirectoryActive(root, admissionLockDirectory(root, slug, checkId));
}

export async function readLatestAttempt(root: string, slug: string, checkId: string): Promise<LatestAttempt> {
  const directory = attemptMarkersDirectory(root, slug, checkId);
  const safety = await ensureEvidencePathSafe(root, directory);
  if (!safety.ok) return { state: 'error', reason: safety.message, file: directory };
  const admissionLock = await admissionLockActive(root, slug, checkId);
  if (admissionLock.state === 'error') {
    return { state: 'error', reason: admissionLock.reason, file: directory };
  }
  if (admissionLock.state === 'active') {
    return { state: 'error', reason: 'evidence admission is in progress for this check', file: directory };
  }
  let files: string[];
  try {
    files = await listAttemptFiles(directory);
  } catch (error) {
    return { state: 'error', reason: `could not list evidence attempts: ${(error as Error).message}`, file: directory };
  }
  const prefixes = new Set<string>();
  for (const file of files) {
    const prefix = path.basename(file).slice(0, 15);
    if (prefixes.has(prefix)) {
      return { state: 'error', reason: `ambiguous evidence attempts share the millisecond prefix ${prefix}; refusing to choose one`, file };
    }
    prefixes.add(prefix);
  }
  if (files.length === 0) return { state: 'none' };
  const file = files[files.length - 1];
  const fileSafety = await ensureEvidenceReadPathSafe(root, file, { finalKind: 'file' });
  if (!fileSafety.ok) return { state: 'error', reason: fileSafety.message, file };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    return { state: 'error', reason: `newest evidence attempt is unreadable or corrupt: ${(error as Error).message}`, file };
  }
  const validated = validateAttempt(parsed, slug, checkId, file);
  if (typeof validated === 'string') return { state: 'error', reason: `newest evidence attempt is invalid: ${validated}`, file };
  return { state: 'ok', attempt: validated, file };
}

// Durable admission: write an ordered attempt marker under the receipt store BEFORE the per-check
// lock or command can fail. The marker lives beside the check directory, so a read-only check
// directory (the F4 lock-failure repro) still records admission in the writable slug store. If
// admission itself cannot be written, the run is not admitted and refuses to execute.
export async function admitEvidenceAttempt(
  root: string,
  slug: string,
  checkId: string,
  contractDigest: string
): Promise<{ ok: true; attempt: EvidenceAttempt; file: string } | { ok: false; message: string }> {
  const markersDir = attemptMarkersDirectory(root, slug, checkId);
  const lockDir = admissionLockDirectory(root, slug, checkId);
  const lock = await acquireOwnedDirectoryLock(
    root,
    admissionLocksDirectory(root, slug),
    lockDir,
    ADMISSION_LOCK_WAIT_MS,
    LOCK_POLL_MS,
    `Another evidence admission is in progress for ${slug}/${checkId}`
  );
  if (!lock.ok) return { ok: false, message: lock.message };

  try {
    const safety = await ensureEvidencePathSafe(root, markersDir);
    if (!safety.ok) return { ok: false, message: safety.message };
    await mkdir(markersDir, { recursive: true });
    const afterMkdir = await ensureEvidencePathSafe(root, markersDir);
    if (!afterMkdir.ok) return { ok: false, message: afterMkdir.message };

    const files = await listAttemptFiles(markersDir);
    const lastPrefix = files.length > 0 ? Number(path.basename(files[files.length - 1]).slice(0, 15)) : 0;
    const prefix = Number.isFinite(lastPrefix) ? Math.max(Date.now(), lastPrefix + 1) : Date.now();
    const attemptId = `${String(prefix).padStart(15, '0')}-${randomUUID().slice(0, 8)}`;
    const attempt: EvidenceAttempt = {
      schemaVersion: ATTEMPT_SCHEMA_VERSION,
      kind: 'forge-evidence-attempt',
      attemptId,
      slug,
      checkId,
      contractDigest,
      admittedAt: new Date().toISOString(),
      pid: process.pid
    };
    const file = path.join(markersDir, `${attemptId}.json`);
    await writeFileAtomic(file, `${JSON.stringify(attempt, null, 2)}\n`);
    return { ok: true, attempt, file };
  } catch (error) {
    return { ok: false, message: `Could not record evidence admission: ${(error as Error).message}` };
  } finally {
    await lock.release();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isState(value: unknown): value is EvidenceState {
  return value === 'passed' || value === 'failed' || value === 'stale' || value === 'missing' || value === 'error';
}

function validateContract(value: unknown): value is EvidenceContract {
  if (!isObject(value)) return false;
  const environment = value.environment;
  return value.schemaVersion === 1
    && typeof value.requirement === 'string'
    && Array.isArray(value.argv) && value.argv.length > 0 && value.argv.every((item) => typeof item === 'string')
    && typeof value.cwd === 'string'
    && typeof value.timeoutMs === 'number' && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0
    && Array.isArray(value.requires) && value.requires.every((item) => typeof item === 'string')
    && isObject(environment)
    && typeof environment.platform === 'string'
    && typeof environment.arch === 'string'
    && typeof environment.node === 'string';
}

function validateCandidate(value: unknown): value is CandidateIdentity {
  return isObject(value)
    && value.schemaVersion === 1
    && value.vcs === 'git'
    && typeof value.root === 'string'
    && (value.head === null || typeof value.head === 'string')
    && typeof value.worktreeDigest === 'string'
    && typeof value.indexDigest === 'string'
    && typeof value.digest === 'string'
    && typeof value.fileCount === 'number'
    && Array.isArray(value.exclusions) && value.exclusions.every((item) => typeof item === 'string')
    && Array.isArray(value.operationalExclusions) && value.operationalExclusions.every((item) => typeof item === 'string')
    && Array.isArray(value.normalizations) && value.normalizations.every((item) => typeof item === 'string');
}

function validateExecution(value: unknown): value is ExecutionResult {
  if (!isObject(value)) return false;
  const stdout = value.stdout;
  const stderr = value.stderr;
  const streamOk = (stream: unknown) => isObject(stream)
    && typeof stream.bytes === 'number'
    && typeof stream.digest === 'string'
    && typeof stream.truncated === 'boolean'
    && typeof stream.excerpt === 'string';
  return typeof value.startedAt === 'string'
    && typeof value.finishedAt === 'string'
    && typeof value.durationMs === 'number'
    && (value.exitCode === null || typeof value.exitCode === 'number')
    && (value.signal === null || typeof value.signal === 'string')
    && typeof value.timedOut === 'boolean'
    && typeof value.streamsClosed === 'boolean'
    && (value.spawnError === null || typeof value.spawnError === 'string')
    && streamOk(stdout)
    && streamOk(stderr);
}

function validateReceipt(value: unknown, slug: string, checkId: string, file: string): EvidenceReceipt | string {
  if (!isObject(value)) return 'receipt is not a JSON object';
  if (value.schemaVersion !== EVIDENCE_SCHEMA_VERSION || value.kind !== 'forge-evidence-receipt') return 'receipt schema is incompatible';
  if (value.slug !== slug || value.checkId !== checkId) return 'receipt belongs to a different slug/check';
  if (typeof value.receiptId !== 'string' || value.receiptId !== path.basename(file, '.json')) return 'receipt id does not match its filename';
  if (typeof value.attemptId !== 'string' || !RECEIPT_FILE.test(`${value.attemptId}.json`)) return 'receipt attempt id is invalid';
  if (!validateContract(value.contract)) return 'receipt contract is invalid';
  if (typeof value.contractDigest !== 'string' || value.contractDigest !== sha256(JSON.stringify(value.contract))) return 'receipt contract digest does not match its contract';
  if (!validateCandidate(value.candidate)) return 'receipt candidate is invalid';
  if (value.candidateAfter !== null && !validateCandidate(value.candidateAfter)) return 'receipt candidateAfter is invalid';
  if (typeof value.identityStable !== 'boolean') return 'receipt identityStable is invalid';
  if (!validateExecution(value.execution)) return 'receipt execution is invalid';
  if (!Array.isArray(value.dependencies)) return 'receipt dependencies are invalid';
  for (const dependency of value.dependencies) {
    if (!isObject(dependency)
      || typeof dependency.checkId !== 'string'
      || !isState(dependency.state)
      || (dependency.receiptId !== null && typeof dependency.receiptId !== 'string')
      || (dependency.candidateDigest !== null && typeof dependency.candidateDigest !== 'string')
      || (dependency.contractDigest !== null && typeof dependency.contractDigest !== 'string')) {
      return 'receipt dependency entry is invalid';
    }
  }
  if (value.outcome !== 'passed' && value.outcome !== 'failed' && value.outcome !== 'error') return 'receipt outcome is invalid';
  if (value.reason !== null && typeof value.reason !== 'string') return 'receipt reason is invalid';

  const candidate = value.candidate as Record<string, unknown>;
  const recomputed = sha256(JSON.stringify({
    version: candidate.schemaVersion,
    exclusions: candidate.exclusions,
    operationalExclusions: candidate.operationalExclusions,
    normalizations: candidate.normalizations,
    worktreeDigest: candidate.worktreeDigest,
    indexDigest: candidate.indexDigest
  }));
  if (recomputed !== candidate.digest) return 'receipt candidate digest is inconsistent';

  if (value.outcome === 'passed') {
    const execution = value.execution as Record<string, unknown>;
    if (execution.exitCode !== 0 || execution.timedOut !== false || execution.spawnError !== null || execution.signal !== null || execution.streamsClosed !== true) {
      return 'passing receipt records an unsuccessful execution';
    }
    if (value.identityStable !== true || value.candidateAfter === null) return 'passing receipt has an unstable candidate';
    if (!sameCandidate(value.candidate as CandidateIdentity, value.candidateAfter as CandidateIdentity)) return 'passing receipt candidate does not match its recapture';
    if ((value.dependencies as Array<Record<string, unknown>>).some((dependency) => dependency.state !== 'passed'
      || dependency.receiptId === null
      || dependency.candidateDigest === null
      || dependency.contractDigest === null)) {
      return 'passing receipt relied on an unbound dependency';
    }
  }

  return value as EvidenceReceipt;
}

async function findValidReceiptForAttempt(input: {
  root: string;
  slug: string;
  checkId: string;
  attemptId: string;
  contractDigest: string;
  files: string[];
  skipFile: string;
}): Promise<{ state: 'found'; receipt: EvidenceReceipt } | { state: 'none' } | { state: 'error'; reason: string }> {
  let found: EvidenceReceipt | undefined;
  for (const file of input.files) {
    if (file === input.skipFile) continue;
    const safety = await ensureEvidenceReadPathSafe(input.root, file, { finalKind: 'file' });
    if (!safety.ok) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!isObject(parsed) || parsed.attemptId !== input.attemptId) continue;
    const validated = validateReceipt(parsed, input.slug, input.checkId, file);
    if (typeof validated === 'string') continue;
    if (validated.contractDigest !== input.contractDigest) {
      return { state: 'error', reason: 'evidence attempt and receipt contract digests disagree' };
    }
    if (found) return { state: 'error', reason: `multiple receipts claim attempt ${input.attemptId}` };
    found = validated;
  }
  return found ? { state: 'found', receipt: found } : { state: 'none' };
}

export async function readLatestReceipt(root: string, slug: string, checkId: string): Promise<LatestReceipt> {
  const directory = checkReceiptDirectory(root, slug, checkId);
  const safety = await ensureEvidencePathSafe(root, directory);
  if (!safety.ok) return { state: 'error', reason: safety.message, file: directory };
  const evidenceLock = await evidenceLockActive(root, slug, checkId);
  if (evidenceLock.state === 'error') {
    return { state: 'error', reason: evidenceLock.reason, file: directory };
  }
  if (evidenceLock.state === 'active') {
    return { state: 'error', reason: 'an evidence run is in progress for this check', file: directory };
  }
  const latestAttempt = await readLatestAttempt(root, slug, checkId);
  if (latestAttempt.state === 'error') {
    return { state: 'error', reason: latestAttempt.reason, file: latestAttempt.file ?? directory };
  }
  let files: string[];
  try {
    files = await listReceiptFiles(directory);
  } catch (error) {
    return { state: 'error', reason: `could not list receipts: ${(error as Error).message}`, file: directory };
  }
  const prefixes = new Set<string>();
  for (const file of files) {
    const prefix = path.basename(file).slice(0, 15);
    if (prefixes.has(prefix)) {
      return { state: 'error', reason: `ambiguous receipts share the millisecond prefix ${prefix}; refusing to choose one`, file };
    }
    prefixes.add(prefix);
  }
  if (files.length === 0) {
    if (latestAttempt.state === 'ok') {
      return { state: 'error', reason: 'an evidence attempt was admitted but no receipt was published; run the check again', file: latestAttempt.file };
    }
    return { state: 'missing', reason: 'no receipt recorded for this candidate/check' };
  }
  const file = files[files.length - 1];
  const receiptSafety = await ensureEvidenceReadPathSafe(root, file, { finalKind: 'file', allowFinalSymlink: true });
  if (!receiptSafety.ok) return { state: 'error', reason: receiptSafety.message, file };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    return { state: 'error', reason: `newest receipt is unreadable or corrupt: ${(error as Error).message}`, file };
  }
  const validated = validateReceipt(parsed, slug, checkId, file);
  if (typeof validated === 'string') return { state: 'error', reason: `newest receipt is invalid: ${validated}`, file };

  if (latestAttempt.state === 'ok') {
    const latestId = latestAttempt.attempt.attemptId;
    if (validated.attemptId === latestId) {
      if (latestAttempt.attempt.contractDigest !== validated.contractDigest) {
        return { state: 'error', reason: 'evidence attempt and receipt contract digests disagree', file: latestAttempt.file };
      }
    } else if (validated.attemptId < latestId) {
      // Completeness is "a valid receipt exists for the latest admitted attempt", not "the latest
      // receipt filename is that attempt". Completion order can differ from admission order when
      // several same-check runs wait on the publication lock.
      const matching = await findValidReceiptForAttempt({
        root,
        slug,
        checkId,
        attemptId: latestId,
        contractDigest: latestAttempt.attempt.contractDigest,
        files,
        skipFile: file
      });
      if (matching.state === 'error') return { state: 'error', reason: matching.reason, file: latestAttempt.file };
      if (matching.state === 'none') {
        return { state: 'error', reason: `a newer evidence attempt (${latestId}) is incomplete or abandoned; run the check again`, file: latestAttempt.file };
      }
    }
    // If the newest receipt belongs to an attempt newer than the latest marker, a complete receipt
    // exists beyond the retained marker history; the receipt remains the result of record.
  }
  return { state: 'ok', receipt: validated, file };
}

export async function writeEvidenceReceipt(root: string, receipt: EvidenceReceipt): Promise<string> {
  const directory = checkReceiptDirectory(root, receipt.slug, receipt.checkId);
  const safety = await ensureEvidencePathSafe(root, directory);
  if (!safety.ok) throw new Error(safety.message);
  await mkdir(directory, { recursive: true });
  const afterMkdir = await ensureEvidencePathSafe(root, directory);
  if (!afterMkdir.ok) throw new Error(afterMkdir.message);
  const file = path.join(directory, `${receipt.receiptId}.json`);
  await writeFileAtomic(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

function describeContractChange(previous: EvidenceContract, current: EvidenceContract): string {
  if (previous.requirement !== current.requirement) return 'requirement changed';
  if (JSON.stringify(previous.argv) !== JSON.stringify(current.argv)) return 'command changed';
  if (previous.cwd !== current.cwd) return 'working directory changed';
  if (previous.timeoutMs !== current.timeoutMs) return 'timeout changed';
  if (JSON.stringify(previous.requires) !== JSON.stringify(current.requires)) return 'declared dependencies changed';
  if (JSON.stringify(previous.environment) !== JSON.stringify(current.environment)) return 'runner environment changed';
  return 'check contract changed';
}

export type DependencyState = {
  state: EvidenceState;
  receiptId: string | null;
  candidateDigest: string | null;
  contractDigest: string | null;
  reason: string | null;
};

async function inspectDependency(
  root: string,
  slug: string,
  checkId: string,
  candidate: CandidateIdentity,
  visited: Set<string>
): Promise<DependencyState> {
  if (visited.has(checkId)) {
    return { state: 'error', receiptId: null, candidateDigest: null, contractDigest: null, reason: `dependency cycle includes ${checkId}` };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(checkId);

  const latest = await readLatestReceipt(root, slug, checkId);
  if (latest.state === 'missing') {
    return { state: 'missing', receiptId: null, candidateDigest: null, contractDigest: null, reason: latest.reason };
  }
  if (latest.state === 'error') {
    return { state: 'error', receiptId: null, candidateDigest: null, contractDigest: null, reason: latest.reason };
  }
  const receipt = latest.receipt;
  const base = {
    receiptId: receipt.receiptId,
    candidateDigest: receipt.candidate.digest,
    contractDigest: receipt.contractDigest
  };
  if (!sameCandidate(receipt.candidate, candidate)) {
    return { ...base, state: 'stale', reason: `dependency ${checkId} was verified against a different candidate` };
  }
  if (receipt.outcome === 'failed') {
    return { ...base, state: 'failed', reason: `dependency ${checkId} last run failed` };
  }
  if (receipt.outcome === 'error') {
    return { ...base, state: 'error', reason: `dependency ${checkId} last run errored: ${receipt.reason ?? 'unknown'}` };
  }
  if (!receipt.identityStable || !receipt.candidateAfter || !sameCandidate(receipt.candidate, receipt.candidateAfter)) {
    return { ...base, state: 'error', reason: `dependency ${checkId} did not keep a stable candidate` };
  }
  for (const dependency of receipt.dependencies) {
    if (dependency.state !== 'passed') {
      return { ...base, state: 'stale', reason: `dependency ${checkId} relied on non-passing ${dependency.checkId}` };
    }
    if (dependency.candidateDigest !== null && dependency.candidateDigest !== candidate.digest) {
      return { ...base, state: 'stale', reason: `dependency ${checkId} recorded a different candidate for ${dependency.checkId}` };
    }
    const nested = await inspectDependency(root, slug, dependency.checkId, candidate, nextVisited);
    if (nested.state !== 'passed') {
      return { ...base, state: 'stale', reason: `dependency ${checkId} is not current because ${dependency.checkId} is ${nested.state}${nested.reason ? ` (${nested.reason})` : ''}` };
    }
    if (dependency.contractDigest !== nested.contractDigest) {
      return { ...base, state: 'stale', reason: `dependency ${checkId} changed its contract for ${dependency.checkId}` };
    }
  }
  return { ...base, state: 'passed', reason: null };
}

export async function snapshotDependencyState(root: string, slug: string, checkId: string, candidate: CandidateIdentity): Promise<DependencySnapshot> {
  const current = await inspectDependency(root, slug, checkId, candidate, new Set<string>());
  return {
    checkId,
    state: current.state,
    receiptId: current.receiptId,
    candidateDigest: current.candidateDigest,
    contractDigest: current.contractDigest
  };
}

export async function evaluateEvidence(input: {
  root: string;
  slug: string;
  checkId: string;
  contract: EvidenceContract;
  contractDigest: string;
  candidate: CandidateIdentity;
}): Promise<Evaluation> {
  const { root, slug, checkId, contract, contractDigest, candidate } = input;
  const latest = await readLatestReceipt(root, slug, checkId);
  if (latest.state === 'missing') {
    return { state: 'missing', slug, checkId, reason: latest.reason, receiptId: null, receiptPath: null };
  }
  if (latest.state === 'error') {
    return { state: 'error', slug, checkId, reason: latest.reason, receiptId: null, receiptPath: path.relative(root, latest.file) };
  }
  const receipt = latest.receipt;
  const receiptPath = path.relative(root, latest.file);
  const base = { slug, checkId, receiptId: receipt.receiptId, receiptPath };

  if (!sameCandidate(receipt.candidate, candidate)) {
    return { ...base, state: 'stale', reason: 'candidate or worktree changed since the receipt' };
  }
  if (receipt.contractDigest !== contractDigest) {
    return { ...base, state: 'stale', reason: describeContractChange(receipt.contract, contract) };
  }
  if (receipt.outcome === 'failed') {
    return { ...base, state: 'failed', reason: receipt.reason ?? 'command failed' };
  }
  if (receipt.outcome === 'error') {
    return { ...base, state: 'error', reason: receipt.reason ?? 'run errored' };
  }
  if (!receipt.identityStable || !receipt.candidateAfter || !sameCandidate(receipt.candidate, receipt.candidateAfter)) {
    return { ...base, state: 'error', reason: 'candidate changed while the check was running' };
  }
  for (const dependency of receipt.dependencies) {
    if (dependency.state !== 'passed') {
      return { ...base, state: 'stale', reason: `receipt relied on non-passing dependency ${dependency.checkId}` };
    }
    const current = await inspectDependency(root, slug, dependency.checkId, candidate, new Set([checkId]));
    if (current.state !== 'passed') {
      return { ...base, state: 'stale', reason: `dependency ${dependency.checkId} is ${current.state}${current.reason ? ` (${current.reason})` : ''}` };
    }
    if (dependency.contractDigest !== current.contractDigest) {
      return { ...base, state: 'stale', reason: `dependency ${dependency.checkId} changed its contract` };
    }
    if (dependency.candidateDigest !== null && dependency.candidateDigest !== candidate.digest) {
      return { ...base, state: 'stale', reason: `dependency ${dependency.checkId} recorded a different candidate` };
    }
  }
  return { ...base, state: 'passed', reason: null };
}
