import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import { main } from '../src/cli.js';
import { captureCandidateIdentity, isUtf8PathBytes } from '../src/evidence-identity.js';
import { acquireEvidenceLock, admitEvidenceAttempt, checkReceiptDirectory, listReceiptFiles, nextReceiptId, writeEvidenceReceipt, type EvidenceReceipt } from '../src/evidence-store.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

type EvidenceOptions = {
  slug?: string;
  check?: string;
  requirement?: string;
  requires?: string[];
  timeoutMs?: number;
  command?: string[];
};

type Captured = { code: number; stdout: string; stderr: string };

async function tempDir(prefix = 'forge-evidence-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gitEnv(base: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.join(base, 'home'),
    XDG_CONFIG_HOME: path.join(base, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  };
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await execFile('git', args, { cwd, env });
}

async function makeRepo(name = 'repo'): Promise<{ base: string; repo: string; env: NodeJS.ProcessEnv }> {
  const base = await tempDir();
  const repo = path.join(base, name);
  await mkdir(repo, { recursive: true });
  const env = gitEnv(base);
  await git(repo, ['init', '-q'], env);
  await writeFile(path.join(repo, 'src.txt'), 'one\n');
  await git(repo, ['add', 'src.txt'], env);
  await git(repo, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge-test@example.invalid', 'commit', '-q', '-m', 'init'], env);
  return { base, repo, env };
}

function argvFor(repo: string, subcommand: 'run' | 'check', options: EvidenceOptions): string[] {
  const args = [
    'evidence', subcommand,
    '--slug', options.slug ?? 'demo',
    '--check', options.check ?? 'unit',
    '--requirement', options.requirement ?? 'unit tests pass',
    '--cwd', repo
  ];
  for (const dependency of options.requires ?? []) args.push('--requires', dependency);
  if (options.timeoutMs !== undefined) args.push('--timeout', String(options.timeoutMs));
  args.push('--', ...(options.command ?? ['node', '-e', 'process.exit(0)']));
  return args;
}

async function captureConsole(run: () => Promise<number>): Promise<Captured> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.map((value) => String(value)).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map((value) => String(value)).join(' ')); };
  try {
    const code = await run();
    return { code, stdout: logs.join('\n'), stderr: errors.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function runEvidence(repo: string, options: EvidenceOptions = {}): Promise<Captured> {
  return captureConsole(() => main(argvFor(repo, 'run', options), { isInteractive: false }));
}

async function checkEvidence(repo: string, options: EvidenceOptions = {}): Promise<Captured> {
  return captureConsole(() => main(argvFor(repo, 'check', options), { isInteractive: false }));
}

async function latestReceipt(repo: string, check = 'unit'): Promise<Record<string, any>> {
  const files = await listReceiptFiles(checkReceiptDirectory(repo, 'demo', check));
  assert.ok(files.length > 0, 'expected at least one receipt');
  return JSON.parse(await readFile(files[files.length - 1], 'utf8')) as Record<string, any>;
}

type CliProbe = {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  pid: number | undefined;
  stdout: string;
  stderr: string;
};

function killExactGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

// Run the real built CLI under an independent outer deadline. This is how the permanent F1
// regression proves the deadline returns even when a descendant holds inherited pipes: the probe
// kills only the exact process group it started (and an optional recorded detached grandchild).
async function runCliWithDeadline(repo: string, args: string[], outerMs: number, pidFile?: string, env: NodeJS.ProcessEnv = process.env): Promise<CliProbe> {
  const cli = path.join(process.cwd(), 'dist', 'src', 'cli.js');
  const started = Date.now();
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repo,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => { if (stdout.length < 200_000) stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer | string) => { if (stderr.length < 200_000) stderr += chunk.toString(); });

  const result = await new Promise<Omit<CliProbe, 'elapsedMs' | 'stdout' | 'stderr'>>((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean, code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ exited, code, signal, pid: child.pid });
    };
    child.on('exit', (code, signal) => finish(true, code, signal));
    child.on('close', (code, signal) => finish(true, code, signal));
    child.on('error', () => finish(true, null, null));
    timer = setTimeout(() => finish(false, null, null), outerMs);
  });

  killExactGroup(result.pid);
  if (pidFile) {
    try {
      const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
      killExactGroup(grandchildPid);
    } catch { /* no pid recorded */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { ...result, stdout, stderr, elapsedMs: Date.now() - started };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function attemptMarkers(repo: string, check = 'unit'): Promise<string[]> {
  const dir = path.join(repo, '.forge', 'evidence', 'demo', '.attempts', check);
  try {
    return (await readdir(dir)).filter((name) => /^\d{15}-[a-z0-9]{8}\.json$/.test(name)).sort();
  } catch {
    return [];
  }
}

test('evidence: a passing run writes a current receipt that check accepts', async () => {
  const { repo } = await makeRepo();
  const run = await runEvidence(repo);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /evidence run: passed/);

  const check = await checkEvidence(repo);
  assert.equal(check.code, 0, check.stderr);
  assert.match(check.stdout, /evidence check: passed/);

  const receipt = await latestReceipt(repo);
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(receipt.kind, 'forge-evidence-receipt');
  assert.equal(receipt.outcome, 'passed');
  assert.deepEqual(receipt.contract.argv, ['node', '-e', 'process.exit(0)']);
  assert.equal(receipt.contract.cwd, await realpath(repo));
  assert.equal(receipt.contract.requirement, 'unit tests pass');
  assert.equal(receipt.execution.exitCode, 0);
  assert.equal(receipt.execution.spawnError, null);
  assert.equal(receipt.execution.timedOut, false);
  assert.equal(receipt.identityStable, true);
  assert.equal(receipt.candidateAfter.digest, receipt.candidate.digest);
  assert.equal(typeof receipt.execution.stdout.digest, 'string');
  assert.equal(receipt.candidate.exclusions.includes('.forge/evidence'), true);
});

test('evidence: a failing command does not accredit a check', async () => {
  const { repo } = await makeRepo();
  const command = ['node', '-e', 'process.exit(3)'];
  const run = await runEvidence(repo, { command });
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stdout, /evidence run: failed/);

  const check = await checkEvidence(repo, { command });
  assert.equal(check.code, 1);
  assert.match(check.stdout, /evidence check: failed/);

  const receipt = await latestReceipt(repo);
  assert.equal(receipt.outcome, 'failed');
  assert.equal(receipt.execution.exitCode, 3);
});

test('evidence: a later failed run supersedes an older success and history is preserved', async () => {
  const { base, repo } = await makeRepo();
  const marker = path.join(base, 'fail-marker');
  const command = ['node', '-e', `process.exit(require('fs').existsSync(${JSON.stringify(marker)}) ? 1 : 0)`];

  const pass = await runEvidence(repo, { command });
  assert.equal(pass.code, 0, pass.stderr);
  await writeFile(marker, 'fail next run');

  const fail = await runEvidence(repo, { command });
  assert.equal(fail.code, 1);
  assert.match(fail.stdout, /evidence run: failed/);

  const files = await listReceiptFiles(checkReceiptDirectory(repo, 'demo', 'unit'));
  assert.equal(files.length, 2, 'both receipts must be preserved');

  const check = await checkEvidence(repo, { command });
  assert.equal(check.code, 1);
  assert.match(check.stdout, /evidence check: failed/);
});

test('evidence: candidate edits make evidence stale and a rerun restores freshness', async () => {
  const { repo } = await makeRepo();
  assert.equal((await runEvidence(repo)).code, 0);

  await writeFile(path.join(repo, 'src.txt'), 'two\n');
  const stale = await checkEvidence(repo);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /evidence check: stale/);
  assert.match(stale.stdout, /candidate or worktree changed/);

  const rerun = await runEvidence(repo);
  assert.equal(rerun.code, 0, rerun.stderr);
  const current = await checkEvidence(repo);
  assert.equal(current.code, 0, current.stderr);
  assert.match(current.stdout, /evidence check: passed/);
});

test('evidence: requirement and command changes invalidate the same candidate', async () => {
  const { repo } = await makeRepo();
  assert.equal((await runEvidence(repo, { requirement: 'requirement A' })).code, 0);

  const changedRequirement = await checkEvidence(repo, { requirement: 'requirement B' });
  assert.equal(changedRequirement.code, 1);
  assert.match(changedRequirement.stdout, /evidence check: stale/);
  assert.match(changedRequirement.stdout, /requirement changed/);

  const changedCommand = await checkEvidence(repo, {
    requirement: 'requirement A',
    command: ['node', '-e', 'process.exit(0) ']
  });
  assert.equal(changedCommand.code, 1);
  assert.match(changedCommand.stdout, /evidence check: stale/);
  assert.match(changedCommand.stdout, /command changed/);
});

test('evidence: untracked additions and tracked deletions change the candidate', async () => {
  const { repo } = await makeRepo();
  assert.equal((await runEvidence(repo)).code, 0);

  await writeFile(path.join(repo, 'untracked.txt'), 'new\n');
  const added = await checkEvidence(repo);
  assert.equal(added.code, 1);
  assert.match(added.stdout, /evidence check: stale/);

  await rm(path.join(repo, 'untracked.txt'));
  assert.equal((await checkEvidence(repo)).code, 0, 'removing the untracked file restores the candidate');

  await rm(path.join(repo, 'src.txt'));
  const deleted = await checkEvidence(repo);
  assert.equal(deleted.code, 1);
  assert.match(deleted.stdout, /evidence check: stale/);

  await writeFile(path.join(repo, 'src.txt'), 'one\n');
  assert.equal((await checkEvidence(repo)).code, 0, 'restoring the tracked content restores the candidate');
});

test('evidence: index-only staged changes are part of the candidate', async () => {
  const { repo, env } = await makeRepo();
  const source = path.join(repo, 'src.txt');
  assert.equal((await runEvidence(repo)).code, 0);

  // Stage a changed blob, then restore the worktree to the committed content: only the index
  // differs from the candidate the receipt was recorded against.
  await writeFile(source, 'staged-change\n');
  await git(repo, ['add', 'src.txt'], env);
  await writeFile(source, 'one\n');

  const indexChanged = await checkEvidence(repo);
  assert.equal(indexChanged.code, 1);
  assert.match(indexChanged.stdout, /evidence check: stale/);

  await git(repo, ['reset', '-q', 'HEAD', 'src.txt'], env);
  assert.equal((await checkEvidence(repo)).code, 0, 'unstaging restores the candidate');
});

test('evidence: mode and symlink-target changes are negative controls that invalidate evidence', async () => {
  const { repo } = await makeRepo();
  const source = path.join(repo, 'src.txt');
  const originalMode = (await stat(source)).mode & 0o777;
  assert.equal((await runEvidence(repo)).code, 0);

  await chmod(source, originalMode & 0o111 ? 0o644 : 0o755);
  const modeChanged = await checkEvidence(repo);
  assert.equal(modeChanged.code, 1);
  assert.match(modeChanged.stdout, /evidence check: stale/);
  await chmod(source, originalMode);

  const link = path.join(repo, 'link.txt');
  await symlink('src.txt', link);
  const env = gitEnv(path.dirname(repo));
  await git(repo, ['add', 'link.txt'], env);
  await git(repo, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge-test@example.invalid', 'commit', '-q', '-m', 'add link'], env);
  assert.equal((await runEvidence(repo)).code, 0);

  await unlink(link);
  await symlink('other.txt', link);
  const targetChanged = await checkEvidence(repo);
  assert.equal(targetChanged.code, 1);
  assert.match(targetChanged.stdout, /evidence check: stale/);

  await unlink(link);
  await symlink('src.txt', link);
  assert.equal((await checkEvidence(repo)).code, 0, 'restoring the symlink target restores the candidate');
});

test('evidence: worktrees are scoped and non-Git directories are rejected honestly', async () => {
  const { base, repo, env } = await makeRepo('repo with spaces-üñï');
  assert.equal((await runEvidence(repo)).code, 0);

  const worktree = path.join(base, 'work tree üñï');
  await git(repo, ['worktree', 'add', '-q', '-b', 'evidence-wt', worktree], env);
  const missing = await checkEvidence(worktree);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /evidence check: missing/);

  // Copy the main worktree's receipt into the worktree store: it must not accredit the worktree.
  const mainDir = checkReceiptDirectory(repo, 'demo', 'unit');
  const otherDir = checkReceiptDirectory(worktree, 'demo', 'unit');
  await mkdir(path.dirname(otherDir), { recursive: true });
  await cp(mainDir, otherDir, { recursive: true });
  const wrongScope = await checkEvidence(worktree);
  assert.equal(wrongScope.code, 1);
  assert.match(wrongScope.stdout, /evidence check: stale/);
  assert.match(wrongScope.stdout, /candidate or worktree changed/);

  const nonGit = await tempDir();
  const rejected = await runEvidence(nonGit);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /Git/);
});

test('evidence: declared dependency receipts are required and changes invalidate dependents', async () => {
  const { repo } = await makeRepo();
  const mainOptions: EvidenceOptions = { check: 'main', requires: ['dep'] };

  assert.equal((await runEvidence(repo, { check: 'dep' })).code, 0);
  const mainRun = await runEvidence(repo, mainOptions);
  assert.equal(mainRun.code, 0, mainRun.stderr);
  assert.equal((await checkEvidence(repo, mainOptions)).code, 0);

  // A missing dependency cannot accredit the dependent run.
  const missingRun = await runEvidence(repo, { check: 'needs-missing', requires: ['absent'] });
  assert.equal(missingRun.code, 1);
  assert.match(missingRun.stdout, /declared dependency absent is missing/);
  const missingCheck = await checkEvidence(repo, { check: 'needs-missing', requires: ['absent'] });
  assert.equal(missingCheck.code, 1);
  assert.match(missingCheck.stdout, /evidence check: error/);

  // A later failing dependency makes the dependent evidence stale.
  assert.equal((await runEvidence(repo, { check: 'dep', command: ['node', '-e', 'process.exit(1)'] })).code, 1);
  const stale = await checkEvidence(repo, mainOptions);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /evidence check: stale/);
  assert.match(stale.stdout, /dependency dep is failed/);

  // A passing dependency rerun with a changed contract still requires a dependent rerun.
  assert.equal((await runEvidence(repo, {
    check: 'dep',
    requirement: 'changed dependency requirement',
    command: ['node', '-e', 'process.exit(0)']
  })).code, 0);
  const contractChanged = await checkEvidence(repo, mainOptions);
  assert.equal(contractChanged.code, 1);
  assert.match(contractChanged.stdout, /changed its contract/);
});

test('evidence: mutation during execution, timeout and spawn failure cannot pass', async () => {
  const { repo } = await makeRepo();
  const mutateCommand = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'src.txt'))}, 'mutated')`];
  const mutated = await runEvidence(repo, { check: 'mutate', command: mutateCommand });
  assert.equal(mutated.code, 1);
  assert.match(mutated.stdout, /evidence run: error/);
  assert.match(mutated.stdout, /candidate changed while the check was running/);
  assert.equal((await latestReceipt(repo, 'mutate')).outcome, 'error');

  const timeout = await runEvidence(repo, {
    check: 'timeout',
    timeoutMs: 150,
    command: ['node', '-e', 'setTimeout(() => {}, 5000)']
  });
  assert.equal(timeout.code, 1);
  assert.match(timeout.stdout, /timed out/);
  assert.equal((await latestReceipt(repo, 'timeout')).execution.timedOut, true);

  const spawn = await runEvidence(repo, { check: 'spawn', command: ['definitely-not-a-real-forge-test-binary'] });
  assert.equal(spawn.code, 1);
  assert.match(spawn.stdout, /could not start command/);
  assert.equal((await latestReceipt(repo, 'spawn')).outcome, 'error');
});

test('evidence: missing and corrupt receipts are rejected instead of falling back', async () => {
  const { repo } = await makeRepo();
  const missing = await checkEvidence(repo);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /evidence check: missing/);

  assert.equal((await runEvidence(repo)).code, 0);
  const files = await listReceiptFiles(checkReceiptDirectory(repo, 'demo', 'unit'));
  assert.equal(files.length, 1);

  await writeFile(files[0], '{ not json');
  const corrupt = await checkEvidence(repo);
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.stdout, /evidence check: error/);
  assert.match(corrupt.stdout, /corrupt/);

  await writeFile(files[0], JSON.stringify({ schemaVersion: 999 }));
  const incompatible = await checkEvidence(repo);
  assert.equal(incompatible.code, 1);
  assert.match(incompatible.stdout, /evidence check: error/);
  assert.match(incompatible.stdout, /incompatible/);

  const wrongSlug = await captureConsole(() => main(argvFor(repo, 'check', { slug: 'other-slug' }), { isInteractive: false }));
  assert.equal(wrongSlug.code, 1);
  assert.match(wrongSlug.stdout, /evidence check: missing/);
});

test('evidence: tampered receipts are rejected as corrupt', async () => {
  const { repo } = await makeRepo();
  assert.equal((await runEvidence(repo)).code, 0);
  const files = await listReceiptFiles(checkReceiptDirectory(repo, 'demo', 'unit'));
  const file = files[files.length - 1];
  const receipt = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;

  receipt.execution.exitCode = 1;
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  const badOutcome = await checkEvidence(repo);
  assert.equal(badOutcome.code, 1);
  assert.match(badOutcome.stdout, /evidence check: error/);
  assert.match(badOutcome.stdout, /unsuccessful execution/);

  assert.equal((await runEvidence(repo)).code, 0);
  const refreshedFiles = await listReceiptFiles(checkReceiptDirectory(repo, 'demo', 'unit'));
  const refreshedFile = refreshedFiles[refreshedFiles.length - 1];
  const refreshed = JSON.parse(await readFile(refreshedFile, 'utf8')) as Record<string, any>;
  refreshed.candidate.worktreeDigest = 'tampered';
  await writeFile(refreshedFile, `${JSON.stringify(refreshed, null, 2)}\n`);
  const badCandidate = await checkEvidence(repo);
  assert.equal(badCandidate.code, 1);
  assert.match(badCandidate.stdout, /evidence check: error/);
  assert.match(badCandidate.stdout, /candidate digest is inconsistent/);
});

test('evidence: symlinked ancestors cannot hide a deleted tracked file or read outside', async () => {
  const { base, repo, env } = await makeRepo();
  const lib = path.join(repo, 'lib');
  await mkdir(lib);
  await writeFile(path.join(lib, 'a.txt'), 'inside\n');
  await git(repo, ['add', 'lib/a.txt'], env);
  await git(repo, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge-test@example.invalid', 'commit', '-q', '-m', 'add lib'], env);
  assert.equal((await runEvidence(repo)).code, 0);

  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'a.txt'), 'inside\n');
  await rm(lib, { recursive: true });
  await symlink(outside, lib);

  const escaped = await runEvidence(repo, { check: 'ancestor' });
  assert.equal(escaped.code, 1);
  assert.match(escaped.stderr, /symlinked ancestor/i);
  assert.equal((await listReceiptFiles(checkReceiptDirectory(repo, 'demo', 'ancestor'))).length, 0);

  const identity = await captureCandidateIdentity(repo);
  assert.equal(identity.ok, false);
  if (!identity.ok) assert.equal(identity.code, 'unsafe-path');

  await writeFile(path.join(outside, 'a.txt'), 'changed outside only\n');
  assert.equal((await runEvidence(repo, { check: 'ancestor' })).code, 1);
});

test('evidence: operational Forge state writes do not invalidate, but semantic ledger changes do', async () => {
  const { repo } = await makeRepo();
  const forgeDir = path.join(repo, '.forge', 'demo');
  const verification = path.join(forgeDir, 'verification.md');
  const featureList = path.join(forgeDir, 'feature-list.json');
  const ledger = {
    schemaVersion: 1,
    slug: 'demo',
    goal: 'converge',
    updatedAt: '2026-01-01T00:00:00.000Z',
    features: [{
      id: 'f1',
      behavior: 'the check passes',
      verification: 'node -e "process.exit(0)"',
      state: 'not_started',
      evidence: null,
      archiveWhen: 'the check is current',
      dependencies: [],
      tasks: [{
        id: 'f1-t1',
        title: 'implement',
        workType: 'build',
        files: ['src.txt'],
        expectedOutcome: 'built',
        validation: 'node -e "process.exit(0)"',
        state: 'not_started',
        notes: null
      }]
    }]
  };
  const writeLedger = async (value: unknown): Promise<void> => {
    await writeFile(featureList, `${JSON.stringify(value, null, 2)}\n`);
  };

  await mkdir(forgeDir, { recursive: true });
  await writeFile(verification, '# Verification\n');
  await writeLedger(ledger);
  assert.equal((await runEvidence(repo)).code, 0);
  const receipt = await latestReceipt(repo);

  // Operational outputs and volatile ledger fields are progress/evidence, not the contract.
  await writeFile(verification, `# Verification\nReceipt: ${receipt.receiptId}\n`);
  await writeFile(path.join(forgeDir, 'progress.md'), 'progress\n');
  await writeFile(path.join(forgeDir, 'build-log.md'), 'build log\n');
  await writeFile(path.join(forgeDir, 'session-handoff.md'), 'handoff\n');
  await writeFile(path.join(forgeDir, 'change-report.html'), '<html></html>');
  const volatile = JSON.parse(JSON.stringify(ledger)) as any;
  volatile.updatedAt = '2026-01-02T00:00:00.000Z';
  volatile.features[0].state = 'passing';
  volatile.features[0].evidence = 'verification.md#f1';
  volatile.features[0].tasks[0].state = 'done';
  volatile.features[0].tasks[0].notes = 'finished';
  await writeLedger(volatile);
  const afterVolatile = await checkEvidence(repo);
  assert.equal(afterVolatile.code, 0, afterVolatile.stdout + afterVolatile.stderr);

  // Repros and checks stay in the identity even though they live under .forge.
  await mkdir(path.join(forgeDir, 'adversary'), { recursive: true });
  await writeFile(path.join(forgeDir, 'adversary', 'repro.mjs'), 'process.exit(0);\n');
  const reproChanged = await checkEvidence(repo);
  assert.equal(reproChanged.code, 1);
  assert.match(reproChanged.stdout, /evidence check: stale/);
  await rm(path.join(forgeDir, 'adversary'), { recursive: true, force: true });

  // The semantic contract is not normalized away.
  const behaviorChanged = JSON.parse(JSON.stringify(volatile)) as any;
  behaviorChanged.features[0].behavior = 'a different behavior';
  await writeLedger(behaviorChanged);
  assert.equal((await checkEvidence(repo)).code, 1, 'behavior changes must invalidate');
  await writeLedger(volatile);

  const verificationChanged = JSON.parse(JSON.stringify(volatile)) as any;
  verificationChanged.features[0].verification = 'node -e "process.exit(7)"';
  await writeLedger(verificationChanged);
  assert.equal((await checkEvidence(repo)).code, 1, 'verification command changes must invalidate');
  await writeLedger(volatile);

  const dependencyChanged = JSON.parse(JSON.stringify(volatile)) as any;
  dependencyChanged.features[0].dependencies = ['f0'];
  await writeLedger(dependencyChanged);
  assert.equal((await checkEvidence(repo)).code, 1, 'dependency changes must invalidate');
  await writeLedger(volatile);

  await writeFile(path.join(forgeDir, 'checks.sh'), 'exit 0\n');
  assert.equal((await checkEvidence(repo)).code, 1, 'check scripts must stay in the identity');
});

test('evidence: tracked operational state and feature-list normalization converge', async () => {
  const { repo, env } = await makeRepo();
  const forgeDir = path.join(repo, '.forge', 'demo');
  const verification = path.join(forgeDir, 'verification.md');
  const featureList = path.join(forgeDir, 'feature-list.json');
  const ledger = {
    schemaVersion: 1,
    slug: 'demo',
    goal: 'tracked convergence',
    updatedAt: '2026-01-01T00:00:00.000Z',
    features: [{
      id: 'f1',
      behavior: 'the check passes',
      verification: 'node -e "process.exit(0)"',
      state: 'not_started',
      evidence: null,
      archiveWhen: 'current',
      dependencies: [],
      tasks: [{ id: 'f1-t1', title: 't', workType: 'build', files: ['src.txt'], expectedOutcome: 'o', validation: 'v', state: 'not_started', notes: null }]
    }]
  };
  await mkdir(forgeDir, { recursive: true });
  await writeFile(verification, '# Verification\n');
  await writeFile(featureList, `${JSON.stringify(ledger, null, 2)}\n`);
  await git(repo, ['add', '.forge/demo/verification.md', '.forge/demo/feature-list.json'], env);
  await git(repo, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge-test@example.invalid', 'commit', '-q', '-m', 'track state'], env);

  assert.equal((await runEvidence(repo)).code, 0);
  const receipt = await latestReceipt(repo);
  await writeFile(verification, `# Verification\nReceipt: ${receipt.receiptId}\n`);
  const volatile = JSON.parse(JSON.stringify(ledger)) as any;
  volatile.updatedAt = '2026-01-02T00:00:00.000Z';
  volatile.features[0].state = 'passing';
  volatile.features[0].evidence = 'verification.md#f1';
  volatile.features[0].tasks[0].state = 'done';
  volatile.features[0].tasks[0].notes = 'done';
  await writeFile(featureList, `${JSON.stringify(volatile, null, 2)}\n`);
  await git(repo, ['add', '.forge/demo/verification.md', '.forge/demo/feature-list.json'], env);
  await git(repo, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge-test@example.invalid', 'commit', '-q', '-m', 'record progress'], env);

  const afterCommit = await checkEvidence(repo);
  assert.equal(afterCommit.code, 0, 'tracked operational/volatile updates must not invalidate');

  const semantic = JSON.parse(JSON.stringify(volatile)) as any;
  semantic.features[0].verification = 'node -e "process.exit(5)"';
  await writeFile(featureList, `${JSON.stringify(semantic, null, 2)}\n`);
  await git(repo, ['add', '.forge/demo/feature-list.json'], env);
  await git(repo, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge-test@example.invalid', 'commit', '-q', '-m', 'change contract'], env);
  const afterSemantic = await checkEvidence(repo);
  assert.equal(afterSemantic.code, 1, 'semantic verification changes must invalidate even when tracked and committed');
});

test('evidence: closure lessons/index writes converge while repo-facts and explore stay covered', async () => {
  const { repo, env } = await makeRepo();
  const forgeDir = path.join(repo, '.forge', 'demo');
  await mkdir(forgeDir, { recursive: true });
  await writeFile(path.join(forgeDir, 'feature-list.json'), `${JSON.stringify({ schemaVersion: 1, slug: 'demo', features: [] }, null, 2)}\n`);
  await writeFile(path.join(forgeDir, 'verification.md'), '# Verification\n');
  assert.equal((await runEvidence(repo)).code, 0);

  await writeFile(path.join(repo, '.forge', 'lessons.md'), '# Lessons\n- durable lesson\n');
  const afterLessons = await checkEvidence(repo);
  assert.equal(afterLessons.code, 0, afterLessons.stdout + afterLessons.stderr);

  await writeFile(path.join(repo, '.forge', 'index.md'), '# Index\n- one line\n');
  const afterIndex = await checkEvidence(repo);
  assert.equal(afterIndex.code, 0, afterIndex.stdout + afterIndex.stderr);

  await git(repo, ['add', '.forge/lessons.md', '.forge/index.md'], env);
  await git(repo, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge-test@example.invalid', 'commit', '-q', '-m', 'closure logs'], env);
  const afterCommit = await checkEvidence(repo);
  assert.equal(afterCommit.code, 0, 'tracked/committed closure logs must not invalidate');

  await writeFile(path.join(repo, '.forge', 'repo-facts.md'), '# Facts\n- commands and constraints\n');
  const afterFacts = await checkEvidence(repo);
  assert.equal(afterFacts.code, 1, 'repo-facts.md can carry commands/constraints and stays covered');
  assert.match(afterFacts.stdout, /evidence check: stale/);

  await writeFile(path.join(forgeDir, 'explore.md'), 'exploration and requirements\n');
  const afterExplore = await checkEvidence(repo);
  assert.equal(afterExplore.code, 1, 'explore.md stays covered');
  assert.match(afterExplore.stdout, /evidence check: stale/);
});

test('evidence: an admitted attempt without a published receipt blocks the old pass', async () => {
  const { repo } = await makeRepo();
  assert.equal((await runEvidence(repo)).code, 0);
  const before = (await attemptMarkers(repo)).length;
  const admitted = await admitEvidenceAttempt(repo, 'demo', 'unit', 'manual-admission-contract');
  assert.equal(admitted.ok, true);
  assert.equal((await attemptMarkers(repo)).length, before + 1);

  const blocked = await checkEvidence(repo);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stdout, /evidence check: error/);
  assert.match(blocked.stdout, /no receipt was published|incomplete|abandoned|newer evidence attempt/);

  const recovered = await runEvidence(repo);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal((await checkEvidence(repo)).code, 0);
  assert.ok((await attemptMarkers(repo)).length >= 2, 'attempt history is preserved');
});

test('evidence: lock failure after admission cannot leave the old pass current', async () => {
  const { repo } = await makeRepo();
  assert.equal((await runEvidence(repo)).code, 0);
  const checkDir = checkReceiptDirectory(repo, 'demo', 'unit');
  let failed;
  try {
    await chmod(checkDir, 0o555);
    failed = await runEvidence(repo);
  } finally {
    await chmod(checkDir, 0o755);
  }
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Could not acquire|EACCES/i);

  const blocked = await checkEvidence(repo);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stdout, /no receipt was published|incomplete|abandoned|newer evidence attempt/);

  const recovered = await runEvidence(repo);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal((await checkEvidence(repo)).code, 0);
});

test('evidence: a killed same-contract attempt blocks the old pass and recovers with a complete run', async () => {
  const { base, repo } = await makeRepo();
  const slowPid = path.join(base, 'slow.pid');
  const script = `require('fs').writeFileSync(${JSON.stringify(slowPid)},String(process.pid));setTimeout(()=>process.exit(process.env.FAIL_FLAG?1:0),Number(process.env.DELAY||0))`;
  const command = ['node', '-e', script];
  const fastEnv = { ...process.env, FAIL_FLAG: '', DELAY: '0' };
  const slowEnv = { ...process.env, FAIL_FLAG: '1', DELAY: '3000' };
  const baseline = await runCliWithDeadline(repo, argvFor(repo, 'run', { check: 'crash', command }), 5_000, undefined, fastEnv);
  assert.equal(baseline.code, 0);

  const cli = path.join(process.cwd(), 'dist', 'src', 'cli.js');
  const crashed = spawn(process.execPath, [cli, ...argvFor(repo, 'run', { check: 'crash', command })], {
    cwd: repo,
    env: slowEnv,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  crashed.stdout?.resume();
  crashed.stderr?.resume();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    crashed.on('close', (code, signal) => resolve({ code, signal }));
  });

  try {
    assert.equal(await waitFor(async () => (await attemptMarkers(repo, 'crash')).length >= 1), true, 'admission marker must exist before the command');
    assert.equal(await waitFor(async () => {
      try {
        await stat(slowPid);
        return true;
      } catch {
        return false;
      }
    }), true, 'command must have started');
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    killExactGroup(crashed.pid);
    try {
      const slow = Number((await readFile(slowPid, 'utf8')).trim());
      killExactGroup(slow);
    } catch { /* no pid recorded */ }
  }
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))]);

  const blocked = await checkEvidence(repo, { check: 'crash', command });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stdout, /in progress|no receipt was published|incomplete|abandoned|newer evidence attempt/);

  const recovered = await runCliWithDeadline(repo, argvFor(repo, 'run', { check: 'crash', command }), 5_000, undefined, fastEnv);
  assert.equal(recovered.code, 0);
  assert.equal((await checkEvidence(repo, { check: 'crash', command })).code, 0);
});

test('evidence: publication failure after the command leaves the attempt incomplete and recoverable', async () => {
  const { repo } = await makeRepo();
  assert.equal((await runEvidence(repo, { check: 'publish' })).code, 0);
  const checkDir = checkReceiptDirectory(repo, 'demo', 'publish');
  const command = ['node', '-e', `require('fs').chmodSync(${JSON.stringify(checkDir)},0o555)`];
  const failed = await runCliWithDeadline(repo, argvFor(repo, 'run', { check: 'publish', command }), 5_000);
  await chmod(checkDir, 0o755);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr ?? '', /Could not write receipt|EACCES/i);

  const blocked = await checkEvidence(repo, { check: 'publish' });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stdout, /no receipt was published|incomplete|abandoned|newer evidence attempt/);

  const recovered = await runEvidence(repo, { check: 'publish' });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal((await checkEvidence(repo, { check: 'publish' })).code, 0);
});

test('evidence: a timeout returns when descendants hold inherited pipes', async () => {
  const { base, repo } = await makeRepo();
  const inheritCommand = [
    'node', '-e',
    "const {spawn}=require('child_process');" +
    "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});" +
    'setInterval(()=>{},1000);'
  ];
  const inherit = await runCliWithDeadline(repo, argvFor(repo, 'run', { check: 'hang-inherit', timeoutMs: 300, command: inheritCommand }), 5_000);
  assert.equal(inherit.exited, true, 'CLI must return before the outer deadline');
  assert.ok(inherit.elapsedMs < 4_500, `CLI took ${inherit.elapsedMs}ms`);
  assert.equal(inherit.code, 1);
  assert.equal((await latestReceipt(repo, 'hang-inherit')).outcome, 'error');

  const pidFile = path.join(base, 'detached.pid');
  const detachedCommand = [
    'node', '-e',
    "const fs=require('fs');const {spawn}=require('child_process');" +
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',detached:true});" +
    `c.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`
  ];
  const detached = await runCliWithDeadline(repo, argvFor(repo, 'run', { check: 'hang-detached', timeoutMs: 300, command: detachedCommand }), 5_000, pidFile);
  assert.equal(detached.exited, true, 'CLI must return even when a detached descendant keeps pipes open');
  assert.ok(detached.elapsedMs < 4_500, `CLI took ${detached.elapsedMs}ms`);
  assert.equal(detached.code, 1);
  const detachedReceipt = await latestReceipt(repo, 'hang-detached');
  assert.equal(detachedReceipt.outcome, 'error');
  assert.equal(detachedReceipt.execution.streamsClosed, false);
});

test('evidence: per-check locking serializes runs and detects an active owner', async () => {
  const { repo } = await makeRepo();
  const first = await acquireEvidenceLock(repo, 'demo', 'lock-check');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const during = await checkEvidence(repo, { check: 'lock-check' });
  assert.equal(during.code, 1);
  assert.match(during.stdout, /evidence check: error/);
  assert.match(during.stdout, /in progress/);
  const second = await acquireEvidenceLock(repo, 'demo', 'lock-check', { waitMs: 150, pollMs: 25 });
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.message, /in progress/);
  await first.release();
  const third = await acquireEvidenceLock(repo, 'demo', 'lock-check', { waitMs: 500, pollMs: 25 });
  assert.equal(third.ok, true);
  if (third.ok) await third.release();
});

test('evidence: same-prefix receipts are ambiguous and never accredit', async () => {
  const { repo } = await makeRepo();
  assert.equal((await runEvidence(repo)).code, 0);
  const directory = checkReceiptDirectory(repo, 'demo', 'unit');
  const files = await listReceiptFiles(directory);
  const passName = path.basename(files[0]);
  const prefix = passName.slice(0, 15);
  const passSuffix = passName.slice(16, 24);
  const failedSuffix = passSuffix === '00000000' ? '00000001' : '00000000';
  const failedName = `${prefix}-${failedSuffix}.json`;
  const receipt = JSON.parse(await readFile(files[0], 'utf8')) as Record<string, any>;
  receipt.receiptId = `${prefix}-${failedSuffix}`;
  receipt.outcome = 'failed';
  receipt.execution.exitCode = 1;
  receipt.reason = 'simulated concurrent failure';
  await writeFile(path.join(directory, failedName), `${JSON.stringify(receipt, null, 2)}\n`);

  const ambiguous = await checkEvidence(repo);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stdout, /evidence check: error/);
  assert.match(ambiguous.stdout, /ambiguous/);
});

test('evidence: non-UTF-8 path predicate fails closed (injected unit)', () => {
  assert.equal(isUtf8PathBytes(Buffer.from('src/üñï.txt', 'utf8')), true);
  assert.equal(isUtf8PathBytes(Buffer.from([0xff, 0xfe, 0x2f])), false);
});

test('evidence: a symlinked receipt store cannot write or read outside the repository', async () => {
  const { base, repo } = await makeRepo();
  assert.equal((await runEvidence(repo)).code, 0);
  const evidenceDir = path.join(repo, '.forge', 'evidence');
  const demoDir = path.join(evidenceDir, 'demo');
  const outside = path.join(base, 'outside-store');
  await mkdir(outside);
  await cp(demoDir, path.join(outside, 'demo'), { recursive: true });
  await rm(demoDir, { recursive: true, force: true });
  await symlink(path.join(outside, 'demo'), demoDir);

  const read = await checkEvidence(repo);
  assert.equal(read.code, 1);
  assert.match(read.stdout, /evidence check: error/);
  const write = await runEvidence(repo);
  assert.equal(write.code, 1);
  assert.match(write.stderr, /symlink/i);
  assert.deepEqual((await readdir(outside)).sort(), ['demo']);

  const { base: base2, repo: repo2 } = await makeRepo();
  const outside2 = path.join(base2, 'outside-root');
  await mkdir(outside2);
  await mkdir(path.join(repo2, '.forge'), { recursive: true });
  await symlink(outside2, path.join(repo2, '.forge', 'evidence'));
  const rootWrite = await runEvidence(repo2);
  assert.equal(rootWrite.code, 1);
  assert.match(rootWrite.stderr, /symlink/i);
  assert.deepEqual(await readdir(outside2), []);
});

test('evidence: admission lock, owner, and marker read paths reject symlinks', async () => {
  const { base, repo } = await makeRepo();
  assert.equal((await runEvidence(repo)).code, 0);
  const attempts = path.join(repo, '.forge', 'evidence', 'demo', '.attempts');
  const locks = path.join(attempts, '.locks');
  const realLocks = path.join(base, 'locks-real');
  await rename(locks, realLocks);
  const outside = path.join(base, 'locks-outside');
  await mkdir(outside);
  await symlink(outside, locks);
  const outsideLock = path.join(outside, 'unit.lock');
  await mkdir(outsideLock);
  await writeFile(path.join(outsideLock, 'owner.json'), `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })}\n`);

  const lockCheck = await checkEvidence(repo);
  assert.equal(lockCheck.code, 1);
  assert.match(lockCheck.stdout + lockCheck.stderr, /symlink/i);
  const lockRun = await runEvidence(repo);
  assert.equal(lockRun.code, 1);
  assert.match(lockRun.stderr + lockRun.stdout, /symlink/i);

  await unlink(locks);
  await rename(realLocks, locks);

  const ownerLock = path.join(locks, 'unit.lock');
  await mkdir(ownerLock);
  const outsideOwner = path.join(base, 'outside-owner.json');
  await writeFile(outsideOwner, `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })}\n`);
  await symlink(outsideOwner, path.join(ownerLock, 'owner.json'));
  const ownerCheck = await checkEvidence(repo);
  assert.equal(ownerCheck.code, 1);
  assert.match(ownerCheck.stdout + ownerCheck.stderr, /symlink/i);
  await rm(ownerLock, { recursive: true, force: true });

  const markerNames = await attemptMarkers(repo);
  assert.ok(markerNames.length > 0);
  const marker = path.join(attempts, 'unit', markerNames[markerNames.length - 1]);
  const outsideMarker = path.join(base, 'outside-marker.json');
  await writeFile(outsideMarker, '{ not json');
  await unlink(marker);
  await symlink(outsideMarker, marker);
  const markerCheck = await checkEvidence(repo);
  assert.equal(markerCheck.code, 1);
  assert.match(markerCheck.stdout + markerCheck.stderr, /symlink/i);
});

test('evidence: completeness uses the latest admitted attempt, result uses the latest completion', async () => {
  const { repo } = await makeRepo();
  assert.equal((await runEvidence(repo)).code, 0);
  const template = await latestReceipt(repo) as unknown as EvidenceReceipt;
  const first = await admitEvidenceAttempt(repo, 'demo', 'unit', template.contractDigest);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = await admitEvidenceAttempt(repo, 'demo', 'unit', template.contractDigest);
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const makeReceipt = async (attemptId: string): Promise<EvidenceReceipt> => ({
    ...template,
    receiptId: await nextReceiptId(repo, 'demo', 'unit'),
    attemptId,
    outcome: 'passed',
    reason: null,
    identityStable: true,
    candidateAfter: template.candidate,
    execution: { ...template.execution, exitCode: 0, signal: null, timedOut: false, spawnError: null, streamsClosed: true }
  });
  // Admission order: first, then second. Completion order: second finishes first, first finishes last.
  await writeEvidenceReceipt(repo, await makeReceipt(second.attempt.attemptId));
  await writeEvidenceReceipt(repo, await makeReceipt(first.attempt.attemptId));

  const markerNames = await attemptMarkers(repo);
  assert.equal(path.basename(markerNames[markerNames.length - 1], '.json'), second.attempt.attemptId);
  const receiptFiles = await listReceiptFiles(checkReceiptDirectory(repo, 'demo', 'unit'));
  const latestReceiptJson = JSON.parse(await readFile(receiptFiles[receiptFiles.length - 1], 'utf8')) as Record<string, any>;
  assert.equal(latestReceiptJson.attemptId, first.attempt.attemptId);

  const check = await checkEvidence(repo);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /evidence check: passed/);
});

test('evidence: three concurrent successful runs remain current', async () => {
  const { repo } = await makeRepo();
  const command = ['node', '-e', 'setTimeout(() => process.exit(0), 35)'];
  const args = argvFor(repo, 'run', { check: 'conc3', command });
  const runs = await Promise.all([
    runCliWithDeadline(repo, args, 10_000),
    runCliWithDeadline(repo, args, 10_000),
    runCliWithDeadline(repo, args, 10_000)
  ]);
  assert.deepEqual(runs.map((run) => run.code), [0, 0, 0]);
  const check = await checkEvidence(repo, { check: 'conc3', command });
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /evidence check: passed/);
});

test('evidence: three concurrent mixed outcomes follow the latest completed receipt', async () => {
  const { repo } = await makeRepo();
  const command = [
    'node', '-e',
    'setTimeout(() => { if (process.env.MODE === "fail") process.exit(1); if (process.env.MODE === "signal") process.kill(process.pid, "SIGTERM"); process.exit(0); }, 35)'
  ];
  const args = argvFor(repo, 'run', { check: 'mixed', command });
  const runs = await Promise.all([
    runCliWithDeadline(repo, args, 10_000, undefined, { ...process.env, MODE: 'pass' }),
    runCliWithDeadline(repo, args, 10_000, undefined, { ...process.env, MODE: 'fail' }),
    runCliWithDeadline(repo, args, 10_000, undefined, { ...process.env, MODE: 'signal' })
  ]);
  assert.ok(runs.every((run) => run.exited));
  const files = await listReceiptFiles(checkReceiptDirectory(repo, 'demo', 'mixed'));
  assert.equal(files.length, 3);
  const latest = JSON.parse(await readFile(files[files.length - 1], 'utf8')) as Record<string, any>;
  const check = await checkEvidence(repo, { check: 'mixed', command });
  assert.equal(check.code, latest.outcome === 'passed' ? 0 : 1, check.stdout + check.stderr);
  assert.match(check.stdout, new RegExp(`evidence check: ${latest.outcome === 'passed' ? 'passed' : latest.outcome}`));
});

test('evidence: a crash among three concurrent runs is handled by attempt completeness', async () => {
  const { base, repo } = await makeRepo();
  const slowPid = path.join(base, 'slow3.pid');
  const fastCommand = ['node', '-e', 'setTimeout(() => process.exit(0), 35)'];
  const slowCommand = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(slowPid)},String(process.pid));setTimeout(() => process.exit(0), 3000)`];
  const slowArgs = argvFor(repo, 'run', { check: 'crash3', command: slowCommand });
  const cli = path.join(process.cwd(), 'dist', 'src', 'cli.js');
  const slow = spawn(process.execPath, [cli, ...slowArgs], {
    cwd: repo,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  slow.stdout?.resume();
  slow.stderr?.resume();
  const slowClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    slow.on('close', (code, signal) => resolve({ code, signal }));
  });
  const fastArgs = argvFor(repo, 'run', { check: 'crash3', command: fastCommand });
  const fast = Promise.all([
    runCliWithDeadline(repo, fastArgs, 10_000),
    runCliWithDeadline(repo, fastArgs, 10_000)
  ]);

  try {
    assert.equal(await waitFor(async () => (await attemptMarkers(repo, 'crash3')).length >= 1), true);
    assert.equal(await waitFor(async () => {
      try {
        await stat(slowPid);
        return true;
      } catch {
        return false;
      }
    }), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    killExactGroup(slow.pid);
    try {
      killExactGroup(Number((await readFile(slowPid, 'utf8')).trim()));
    } catch { /* no pid recorded */ }
  }
  await Promise.race([slowClosed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  const fastRuns = await fast;
  assert.deepEqual(fastRuns.map((run) => run.code), [0, 0]);

  const markerDir = path.join(repo, '.forge', 'evidence', 'demo', '.attempts', 'crash3');
  const markers = await attemptMarkers(repo, 'crash3');
  const latestMarker = JSON.parse(await readFile(path.join(markerDir, markers[markers.length - 1]), 'utf8')) as Record<string, any>;
  const receiptFiles = await listReceiptFiles(checkReceiptDirectory(repo, 'demo', 'crash3'));
  const latestAttemptHasReceipt = (await Promise.all(receiptFiles.map(async (file) => {
    const receipt = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    return receipt.attemptId === latestMarker.attemptId;
  }))).some(Boolean);
  const check = await checkEvidence(repo, { check: 'crash3', command: fastCommand });
  if (latestAttemptHasReceipt) {
    assert.equal(check.code, 0, check.stdout + check.stderr);
  } else {
    assert.notEqual(check.code, 0, 'an incomplete later attempt must block the old pass');
    assert.match(check.stdout, /incomplete|abandoned|newer evidence attempt/);
  }
  assert.equal((await runEvidence(repo, { check: 'crash3', command: fastCommand })).code, 0);
  assert.equal((await checkEvidence(repo, { check: 'crash3', command: fastCommand })).code, 0);
});

test('evidence: receipts do not self-invalidate, and check never executes the command', async () => {
  const { base, repo } = await makeRepo();
  const before = await captureCandidateIdentity(repo);
  assert.equal(before.ok, true);
  if (!before.ok) return;
  assert.equal((await runEvidence(repo)).code, 0);
  const after = await captureCandidateIdentity(repo);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.identity.digest, before.identity.digest, 'writing a receipt must not change the candidate');
  assert.equal((await checkEvidence(repo)).code, 0);

  const marker = path.join(base, 'check-must-not-execute');
  const neverRun = await checkEvidence(repo, {
    check: 'never-run',
    command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`]
  });
  assert.equal(neverRun.code, 1);
  assert.match(neverRun.stdout, /evidence check: missing/);
  await assert.rejects(access(marker), 'check must not execute the command');
});

test('evidence: bad arguments and paths are rejected', async () => {
  const { repo } = await makeRepo();
  const noArgs = await captureConsole(() => main(['evidence'], { isInteractive: false }));
  assert.equal(noArgs.code, 1);
  assert.match(noArgs.stderr, /Usage:/);

  const noSeparator = await captureConsole(() => main(['evidence', 'run', '--slug', 'demo', '--check', 'unit', '--requirement', 'x'], { isInteractive: false }));
  assert.equal(noSeparator.code, 1);
  assert.match(noSeparator.stderr, /Missing `-- <command>/);

  const badTimeout = await captureConsole(() => main(['evidence', 'run', '--slug', 'demo', '--check', 'unit', '--requirement', 'x', '--timeout', 'nope', '--', 'node', '-e', '0'], { isInteractive: false }));
  assert.equal(badTimeout.code, 1);
  assert.match(badTimeout.stderr, /Invalid --timeout/);

  const badSlug = await captureConsole(() => main(['evidence', 'run', '--slug', '../escape', '--check', 'unit', '--requirement', 'x', '--', 'node', '-e', '0'], { isInteractive: false }));
  assert.equal(badSlug.code, 1);
  assert.match(badSlug.stderr, /Invalid --slug/);

  const selfRequirement = await captureConsole(() => main(['evidence', 'run', '--slug', 'demo', '--check', 'unit', '--requirement', 'x', '--requires', 'unit', '--', 'node', '-e', '0'], { isInteractive: false }));
  assert.equal(selfRequirement.code, 1);
  assert.match(selfRequirement.stderr, /cannot reference the check itself/);

  const badCwd = await captureConsole(() => main(['evidence', 'run', '--slug', 'demo', '--check', 'unit', '--requirement', 'x', '--cwd', path.join(repo, 'missing-dir'), '--', 'node', '-e', '0'], { isInteractive: false }));
  assert.equal(badCwd.code, 1);
  assert.match(badCwd.stderr, /Cannot use --cwd/);
});

after(async () => {
  await Promise.all(tempDirs.map(async (dir) => {
    if (!isTestTempDir(dir)) return;
    await rm(dir, { recursive: true, force: true });
  }));
});

function isTestTempDir(dir: string): boolean {
  const normalized = path.resolve(dir);
  return path.dirname(normalized) === path.resolve(os.tmpdir()) && path.basename(normalized).startsWith('forge-evidence-');
}
