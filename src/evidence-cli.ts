import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { captureCandidateIdentity, resolveGitRoot, sameCandidate } from './evidence-identity.js';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runEvidenceCommand, validateTimeoutMs } from './evidence-runner.js';
import {
  acquireEvidenceLock,
  admitEvidenceAttempt,
  buildEvidenceContract,
  EVIDENCE_SCHEMA_VERSION,
  evaluateEvidence,
  nextReceiptId,
  snapshotDependencyState,
  writeEvidenceReceipt,
  type DependencySnapshot,
  type EvidenceReceipt,
  type EvidenceState
} from './evidence-store.js';

// Explicit, opt-in verification receipts. `run` executes exactly the argv after `--` (no shell, no
// implicit command from Markdown/JSON); `check` only re-identifies the candidate and reads receipts.
// Both commands require Git for the MVP: without a worktree identity there is no honest mechanical
// freshness claim. A receipt is necessary evidence, never proof of semantic correctness.

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type EvidenceSubcommand = 'run' | 'check';

type EvidenceOptions = {
  subcommand: EvidenceSubcommand;
  slug: string;
  checkId: string;
  requirement: string;
  requires: string[];
  timeoutMs: number;
  cwd: string;
  argv: string[];
};

type ParseResult = { ok: true; options: EvidenceOptions } | { ok: false; message: string };

function validCheckId(value: string): boolean {
  return CHECK_ID_PATTERN.test(value) && !value.includes('..');
}

function usage(): string {
  return [
    'Usage:',
    '  forge-ai evidence run   --slug <slug> --check <id> --requirement <text> [--requires <id>]... [--timeout <ms>] [--cwd <dir>] -- <command> [args...]',
    '  forge-ai evidence check --slug <slug> --check <id> --requirement <text> [--requires <id>]... [--timeout <ms>] [--cwd <dir>] -- <command> [args...]',
    '',
    '`run` executes only the explicit argv after `--` (no shell, no interpolation) and writes a receipt.',
    '`check` never executes the command; it exits 0 only when the receipt is current for this same',
    'candidate, command, cwd, timeout, requirement, declared dependencies and runner environment.',
    'Receipts live under .forge/evidence/ and require a Git worktree. Under Forge Check, a pass is evidence,',
    'not semantic proof or merge authorization.'
  ].join('\n');
}

function takeValue(argv: string[], index: number, flag: string): { value: string; next: number } | { error: string } {
  const value = argv[index + 1];
  if (value === undefined) return { error: `Missing ${flag} value` };
  return { value, next: index + 1 };
}

function parseEvidenceArgs(argv: string[]): ParseResult {
  const subcommand = argv[0];
  if (subcommand !== 'run' && subcommand !== 'check') {
    return { ok: false, message: `Expected "run" or "check", got ${subcommand ?? '(nothing)'}` };
  }

  let slug: string | undefined;
  let checkId: string | undefined;
  let requirement: string | undefined;
  const requires: string[] = [];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let cwd = process.cwd();
  let command: string[] | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      command = argv.slice(index + 1);
      break;
    }
    if (arg === '--slug') {
      const taken = takeValue(argv, index, '--slug');
      if ('error' in taken) return { ok: false, message: taken.error };
      slug = taken.value;
      index = taken.next;
      continue;
    }
    if (arg === '--check') {
      const taken = takeValue(argv, index, '--check');
      if ('error' in taken) return { ok: false, message: taken.error };
      checkId = taken.value;
      index = taken.next;
      continue;
    }
    if (arg === '--requirement') {
      const taken = takeValue(argv, index, '--requirement');
      if ('error' in taken) return { ok: false, message: taken.error };
      requirement = taken.value;
      index = taken.next;
      continue;
    }
    if (arg === '--requires') {
      const taken = takeValue(argv, index, '--requires');
      if ('error' in taken) return { ok: false, message: taken.error };
      requires.push(taken.value);
      index = taken.next;
      continue;
    }
    if (arg === '--timeout') {
      const taken = takeValue(argv, index, '--timeout');
      if ('error' in taken) return { ok: false, message: taken.error };
      if (!/^\d+$/.test(taken.value)) return { ok: false, message: `Invalid --timeout ${taken.value}; expected milliseconds` };
      timeoutMs = Number(taken.value);
      index = taken.next;
      continue;
    }
    if (arg === '--cwd') {
      const taken = takeValue(argv, index, '--cwd');
      if ('error' in taken) return { ok: false, message: taken.error };
      cwd = taken.value;
      index = taken.next;
      continue;
    }
    return { ok: false, message: `Unknown argument ${arg} before --` };
  }

  if (!command) return { ok: false, message: 'Missing `-- <command> [args...]`' };
  if (command.length === 0) return { ok: false, message: 'Missing command after --' };
  if (command.some((item) => item.includes('\0'))) return { ok: false, message: 'Command arguments must not contain NUL bytes' };
  if (command[0].length === 0) return { ok: false, message: 'Command program must not be empty' };
  if (!slug) return { ok: false, message: 'Missing --slug' };
  if (!SLUG_PATTERN.test(slug)) return { ok: false, message: `Invalid --slug ${slug}; expected kebab-case` };
  if (!checkId) return { ok: false, message: 'Missing --check' };
  if (!validCheckId(checkId)) return { ok: false, message: `Invalid --check ${checkId}` };
  if (!requirement || requirement.trim().length === 0) return { ok: false, message: 'Missing or empty --requirement' };
  if (!validateTimeoutMs(timeoutMs)) return { ok: false, message: `Invalid --timeout; expected 1..${MAX_TIMEOUT_MS} milliseconds` };
  for (const dependency of requires) {
    if (!validCheckId(dependency)) return { ok: false, message: `Invalid --requires ${dependency}` };
    if (dependency === checkId) return { ok: false, message: `--requires cannot reference the check itself (${checkId})` };
  }

  return {
    ok: true,
    options: {
      subcommand,
      slug,
      checkId,
      requirement: requirement.trim(),
      requires,
      timeoutMs,
      cwd,
      argv: command
    }
  };
}

async function canonicalDirectory(directory: string): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const absolute = path.resolve(directory);
  try {
    const resolved = await realpath(absolute);
    const info = await stat(resolved);
    if (!info.isDirectory()) return { ok: false, message: `${absolute} is not a directory` };
    return { ok: true, path: resolved };
  } catch (error) {
    return { ok: false, message: `Cannot use --cwd ${absolute}: ${(error as Error).message}` };
  }
}

function printEvaluation(subcommand: EvidenceSubcommand, state: EvidenceState, slug: string, checkId: string, receiptPath: string | null, reason: string | null): void {
  const suffix = receiptPath ? ` receipt=${receiptPath.split(path.sep).join('/')}` : '';
  console.log(`evidence ${subcommand}: ${state} check=${checkId} slug=${slug}${suffix}`);
  if (reason) console.log(`evidence ${subcommand}: reason=${reason}`);
}

async function runCommand(options: EvidenceOptions): Promise<number> {
  const directory = await canonicalDirectory(options.cwd);
  if (!directory.ok) {
    console.error(`evidence run: error ${directory.message}`);
    return 1;
  }
  const rootResult = await resolveGitRoot(directory.path);
  if (!rootResult.ok) {
    console.error(`evidence run: error ${rootResult.message}`);
    return 1;
  }
  const { contract, contractDigest } = buildEvidenceContract({
    requirement: options.requirement,
    argv: options.argv,
    cwd: directory.path,
    timeoutMs: options.timeoutMs,
    requires: options.requires
  });

  // Admission is durable and precedes the per-check lock, command execution, identity capture and
  // receipt publication. If this write fails, the attempt is not admitted and must not execute.
  const admitted = await admitEvidenceAttempt(rootResult.root, options.slug, options.checkId, contractDigest);
  if (!admitted.ok) {
    console.error(`evidence run: error could not admit attempt: ${admitted.message}`);
    return 1;
  }

  const lock = await acquireEvidenceLock(rootResult.root, options.slug, options.checkId);
  if (!lock.ok) {
    console.error(`evidence run: error ${lock.message}`);
    return 1;
  }

  try {
    const before = await captureCandidateIdentity(directory.path);
    if (!before.ok) {
      console.error(`evidence run: error ${before.message}`);
      return 1;
    }
    if (before.identity.root !== rootResult.root) {
      console.error('evidence run: error the worktree root changed while acquiring the evidence lock');
      return 1;
    }
    const dependencies: DependencySnapshot[] = [];
    for (const dependency of contract.requires) {
      dependencies.push(await snapshotDependencyState(before.identity.root, options.slug, dependency, before.identity));
    }

    const execution = await runEvidenceCommand(options.argv, directory.path, options.timeoutMs);
    const after = await captureCandidateIdentity(directory.path);
    const identityStable = after.ok && sameCandidate(before.identity, after.identity);

    let outcome: EvidenceReceipt['outcome'];
    let reason: string | null = null;
    if (execution.spawnError) {
      outcome = 'error';
      reason = `could not start command: ${execution.spawnError}`;
    } else if (execution.timedOut) {
      outcome = 'error';
      reason = `timed out after ${options.timeoutMs}ms`;
    } else if (execution.signal) {
      outcome = 'error';
      reason = `terminated by ${execution.signal}`;
    } else if (execution.exitCode !== 0) {
      outcome = 'failed';
      reason = `exit code ${execution.exitCode}`;
    } else if (!after.ok) {
      outcome = 'error';
      reason = `could not recapture the candidate: ${after.message}`;
    } else if (!identityStable) {
      outcome = 'error';
      reason = 'candidate changed while the check was running';
    } else if (!execution.streamsClosed) {
      outcome = 'error';
      reason = 'output streams stayed open after the command exited; a descendant may still be running';
    } else {
      const badDependency = dependencies.find((dependency) => dependency.state !== 'passed');
      if (badDependency) {
        outcome = 'error';
        reason = `declared dependency ${badDependency.checkId} is ${badDependency.state}`;
      } else {
        outcome = 'passed';
      }
    }

    let receiptId: string;
    try {
      receiptId = await nextReceiptId(before.identity.root, options.slug, options.checkId);
    } catch (error) {
      console.error(`evidence run: error could not allocate a receipt: ${(error as Error).message}`);
      return 1;
    }

    const receipt: EvidenceReceipt = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      kind: 'forge-evidence-receipt',
      receiptId,
      attemptId: admitted.attempt.attemptId,
      slug: options.slug,
      checkId: options.checkId,
      contract,
      contractDigest,
      candidate: before.identity,
      candidateAfter: after.ok ? after.identity : null,
      identityStable,
      execution,
      dependencies,
      outcome,
      reason
    };

    let receiptPath: string;
    try {
      receiptPath = await writeEvidenceReceipt(before.identity.root, receipt);
    } catch (error) {
      console.error(`evidence run: error could not write receipt: ${(error as Error).message}`);
      return 1;
    }
    printEvaluation('run', outcome, options.slug, options.checkId, path.relative(before.identity.root, receiptPath), reason);
    return outcome === 'passed' ? 0 : 1;
  } finally {
    await lock.release();
  }
}

async function checkEvidence(options: EvidenceOptions): Promise<number> {
  const directory = await canonicalDirectory(options.cwd);
  if (!directory.ok) {
    console.error(`evidence check: error ${directory.message}`);
    return 1;
  }
  const before = await captureCandidateIdentity(directory.path);
  if (!before.ok) {
    console.error(`evidence check: error ${before.message}`);
    return 1;
  }
  const { contract, contractDigest } = buildEvidenceContract({
    requirement: options.requirement,
    argv: options.argv,
    cwd: directory.path,
    timeoutMs: options.timeoutMs,
    requires: options.requires
  });

  const evaluation = await evaluateEvidence({
    root: before.identity.root,
    slug: options.slug,
    checkId: options.checkId,
    contract,
    contractDigest,
    candidate: before.identity
  });

  const after = await captureCandidateIdentity(directory.path);
  let finalEvaluation = evaluation;
  if (!after.ok) {
    finalEvaluation = { ...evaluation, state: 'error', reason: `could not recapture the candidate: ${after.message}` };
  } else if (!sameCandidate(before.identity, after.identity)) {
    finalEvaluation = { ...evaluation, state: 'error', reason: 'candidate changed while checking evidence' };
  }

  printEvaluation('check', finalEvaluation.state, options.slug, options.checkId, finalEvaluation.receiptPath, finalEvaluation.reason);
  return finalEvaluation.state === 'passed' ? 0 : 1;
}

export async function runEvidenceCli(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.error(usage());
    return 1;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(usage());
    return 0;
  }
  if ((argv[0] === 'run' || argv[0] === 'check') && (argv[1] === '--help' || argv[1] === '-h')) {
    console.log(usage());
    return 0;
  }
  const parsed = parseEvidenceArgs(argv);
  if (!parsed.ok) {
    console.error(`evidence: ${parsed.message}`);
    console.error(usage());
    return 1;
  }
  return parsed.options.subcommand === 'run' ? runCommand(parsed.options) : checkEvidence(parsed.options);
}
