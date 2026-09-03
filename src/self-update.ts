import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolveExecutable } from './executable-resolution.js';

export type InstallMethod = 'pnpm-global' | 'npm-global' | 'npm-global-homebrew' | 'npx' | 'unknown';

export type UpdateCommand = {
  command: string;
  args: string[];
  description: string;
  instructions?: string;
};

export type Spawner = (command: string, args: string[]) => { status: number | null };

export type SelfUpdateOptions = {
  binaryPath: string;
  version?: string;
  dryRun?: boolean;
  skipSpecUpdate?: boolean;
  spawner?: Spawner;
  realPathResolver?: (path: string) => string;
  resolveCommand?: (command: string) => string | undefined;
  log?: (message: string) => void;
};

const PACKAGE = '@guidobuilds/forge-ai';

const TRUSTED_COMMANDS = new Set(['pnpm', 'npm', 'forge-ai']);

// --to allowlist: the literal 'latest' or a semver X.Y.Z (optional -prerelease / +build), optionally
// 'v'-prefixed. Rejects ranges (^1.0.0, ~1.0.0), git URLs, and any other dist-tag, so no arbitrary
// spec ever reaches `npm/pnpm install -g`.
export function isValidVersionSpec(value: string): boolean {
  return value === 'latest' || /^v?\d+\.\d+\.\d+([-+].*)?$/.test(value);
}

// 'v0.4.0' -> '0.4.0'; leaves 'latest' and bare semvers untouched.
export function normalizeVersionSpec(value: string): string {
  return value.replace(/^v(?=\d)/, '');
}

function resolveAndValidate(command: string, resolver: (c: string) => string | undefined, log: (m: string) => void): { ok: true; resolved: string } | { ok: false } {
  const resolved = resolver(command);
  if (!resolved) {
    log(`Could not resolve a trusted ${command} binary; refusing to run.`);
    return { ok: false };
  }
  if (!TRUSTED_COMMANDS.has(path.basename(resolved))) {
    log(`Refusing to run ${resolved}: unexpected binary name (expected ${[...TRUSTED_COMMANDS].join(', ')}).`);
    return { ok: false };
  }
  return { ok: true, resolved };
}

export function detectInstallMethod(realPath: string): InstallMethod {
  if (/[/\\]\.npm[/\\]_npx[/\\]/.test(realPath)) return 'npx';
  if (/[/\\]pnpm[/\\]/.test(realPath)) return 'pnpm-global';
  if (/[/\\]homebrew[/\\]/i.test(realPath) && /[/\\]node_modules[/\\]/.test(realPath)) return 'npm-global-homebrew';
  if (/[/\\]node_modules[/\\]/.test(realPath)) return 'npm-global';
  return 'unknown';
}

export function buildUpdateCommand(method: InstallMethod, version = 'latest'): UpdateCommand {
  const target = `${PACKAGE}@${version}`;
  switch (method) {
    case 'pnpm-global':
      return { command: 'pnpm', args: ['add', '-g', target, '--prefer-online'], description: 'pnpm global' };
    case 'npm-global':
      return { command: 'npm', args: ['install', '-g', target], description: 'npm global' };
    case 'npm-global-homebrew':
      return { command: '/opt/homebrew/bin/npm', args: ['install', '-g', target], description: 'npm global (Homebrew)' };
    case 'npx':
      return { command: '', args: [], description: 'npx (no global install)', instructions: `No global install to update. Re-run with: npx ${target} update` };
    case 'unknown':
      return { command: '', args: [], description: 'unknown install method', instructions: `Could not detect install method. Update manually: pnpm add -g ${target} --prefer-online` };
  }
}

export async function runSelfUpdate(options: SelfUpdateOptions): Promise<number> {
  const log = options.log ?? ((message) => console.log(message));
  const resolver = options.realPathResolver ?? ((p) => realpathSync(p));
  const spawner = options.spawner ?? defaultSpawner;
  const resolveCommand = options.resolveCommand ?? ((command) => resolveExecutable(command, { cwd: process.cwd() }));

  let realPath: string;
  try {
    realPath = resolver(options.binaryPath);
  } catch {
    realPath = options.binaryPath;
  }
  // Try the symlink path first (catches `pnpm link --global` and similar dev setups);
  // fall back to the resolved real path (catches standard global installs whose bin dir is generic).
  const symlinkMethod = detectInstallMethod(options.binaryPath);
  const method = symlinkMethod !== 'unknown' ? symlinkMethod : detectInstallMethod(realPath);
  const version = normalizeVersionSpec(options.version ?? 'latest');
  if (!isValidVersionSpec(version)) {
    log(`Invalid --to ${options.version}; expected a semver or "latest".`);
    return 1;
  }
  const cmd = buildUpdateCommand(method, version);

  log(`Detected install: ${cmd.description} at ${realPath}`);

  if (cmd.instructions) {
    log(cmd.instructions);
    return 1;
  }

  log(`Running: ${cmd.command} ${cmd.args.join(' ')}`);
  if (options.dryRun) {
    log('(dry-run, not executing)');
    return 0;
  }

  const spawn = (command: string, args: string[]): { status: number | null } => {
    if (options.resolveCommand) {
      const checked = resolveAndValidate(command, resolveCommand, log);
      if (!checked.ok) return { status: 1 };
      return spawner(checked.resolved, args);
    }
    return spawner(command, args);
  };

  const updateResult = spawn(cmd.command, cmd.args);
  if (updateResult.status !== 0) {
    log(`CLI update failed with exit code ${updateResult.status}`);
    return updateResult.status ?? 1;
  }

  if (options.skipSpecUpdate) return 0;

  log('\nApplying spec kit with the updated CLI...');
  const specResult = spawn('forge-ai', ['update']);
  return specResult.status ?? 1;
}

// Trust boundary: package managers are developer-facing binaries resolved to an absolute path via
// resolveExecutable (which rejects candidates inside the current working tree) and checked against
// the { pnpm, npm, forge-ai } basename allowlist — never a bare name that PATH/cwd could shadow.
function defaultSpawner(command: string, args: string[]): { status: number | null } {
  const checked = resolveAndValidate(command, (c) => resolveExecutable(c, { cwd: process.cwd() }), (m) => console.error(m));
  if (!checked.ok) return { status: 1 };
  const result = spawnSync(checked.resolved, args, { stdio: 'inherit' });
  return { status: result.status };
}
