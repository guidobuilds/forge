import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

// Bounded execution for a single, explicitly supplied argv. No shell is involved: argv[0] is the
// program and the remaining strings are passed unchanged. Stdout/stderr are hashed in full but only
// a small excerpt is retained, so a hostile or noisy command cannot exhaust memory or the receipt
// store.
//
// Deadline behaviour: the runner settles on the direct child's exit (after a short drain grace for
// its pipes) or on the deadline, not only on `close`. On POSIX the child is its own process group,
// so a timeout can kill the owned group (the child and descendants that stayed in it) and release
// inherited pipes. A descendant that deliberately detaches into another group with inherited pipes
// is outside our cleanup control; if that keeps the pipes open, `streamsClosed` is false and the
// run cannot be accredited. A descendant that detaches with its own/ignored stdio is invisible to
// this bound and is documented as an explicit limitation.

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const OUTPUT_EXCERPT_BYTES = 8 * 1024;
const DRAIN_GRACE_MS = 1000;

export type StreamCapture = {
  bytes: number;
  digest: string;
  truncated: boolean;
  excerpt: string;
};

export type ExecutionResult = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  streamsClosed: boolean;
  stdout: StreamCapture;
  stderr: StreamCapture;
};

type Collector = {
  hash: ReturnType<typeof createHash>;
  bytes: number;
  kept: number;
  chunks: Buffer[];
};

function newCollector(): Collector {
  return { hash: createHash('sha256'), bytes: 0, kept: 0, chunks: [] };
}

function addChunk(collector: Collector, chunk: Buffer, cap: number): void {
  collector.bytes += chunk.length;
  collector.hash.update(chunk);
  if (collector.kept >= cap) return;
  const slice = chunk.subarray(0, Math.min(chunk.length, cap - collector.kept));
  collector.chunks.push(slice);
  collector.kept += slice.length;
}

function finishCollector(collector: Collector): StreamCapture {
  return {
    bytes: collector.bytes,
    digest: collector.hash.digest('hex'),
    truncated: collector.bytes > collector.kept,
    excerpt: Buffer.concat(collector.chunks).toString('utf8')
  };
}

export function validateTimeoutMs(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

function killOwnedProcess(child: ChildProcess | undefined, processGroup: boolean): void {
  if (!child || !child.pid) return;
  if (processGroup) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The group may already be gone.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The direct child may already be gone.
  }
}

export async function runEvidenceCommand(argv: string[], cwd: string, timeoutMs: number): Promise<ExecutionResult> {
  const startedAt = new Date();
  const startedMs = Date.now();
  const stdout = newCollector();
  const stderr = newCollector();
  const processGroup = process.platform !== 'win32';
  let timedOut = false;
  let spawnError: string | null = null;

  const finished = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; streamsClosed: boolean }>((resolve) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let deadline: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;

    const finalize = (exitCode: number | null, signal: NodeJS.Signals | null, streamsClosed: boolean): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      if (!streamsClosed) killOwnedProcess(child, processGroup);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      resolve({ exitCode, signal, streamsClosed });
    };

    const scheduleGrace = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled || grace) return;
      grace = setTimeout(() => {
        // `close` did not arrive within the drain window: inherited pipes are still held by a
        // descendant. Kill our owned group best-effort, then fail closed on streamsClosed=false.
        killOwnedProcess(child, processGroup);
        finalize(exitCode, signal, false);
      }, DRAIN_GRACE_MS);
    };

    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        shell: false,
        detached: processGroup,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      });
    } catch (error) {
      spawnError = (error as Error).message;
      finalize(null, null, true);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      addChunk(stdout, typeof chunk === 'string' ? Buffer.from(chunk) : chunk, OUTPUT_EXCERPT_BYTES);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      addChunk(stderr, typeof chunk === 'string' ? Buffer.from(chunk) : chunk, OUTPUT_EXCERPT_BYTES);
    });
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);

    child.on('error', (error) => {
      spawnError = error.message;
      scheduleGrace(null, null);
    });

    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      if (deadline) clearTimeout(deadline);
      // Do not wait for `close` forever: a descendant may hold inherited stdout/stderr open.
      scheduleGrace(code, signal);
    });

    child.on('close', (code, signal) => {
      finalize(code, signal, true);
    });

    deadline = setTimeout(() => {
      timedOut = true;
      killOwnedProcess(child, processGroup);
      scheduleGrace(exitInfo?.code ?? null, exitInfo?.signal ?? null);
    }, timeoutMs);
  });

  const { exitCode, signal, streamsClosed } = await finished;
  const finishedAt = new Date();

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    exitCode,
    signal,
    timedOut,
    spawnError,
    streamsClosed,
    stdout: finishCollector(stdout),
    stderr: finishCollector(stderr)
  };
}
