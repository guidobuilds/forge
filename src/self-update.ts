import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
  log?: (message: string) => void;
};

const PACKAGE = '@guidobuilds/forge-ai';

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
  const cmd = buildUpdateCommand(method, options.version ?? 'latest');

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

  const updateResult = spawner(cmd.command, cmd.args);
  if (updateResult.status !== 0) {
    log(`CLI update failed with exit code ${updateResult.status}`);
    return updateResult.status ?? 1;
  }

  if (options.skipSpecUpdate) return 0;

  log('\nApplying spec kit with the updated CLI...');
  const specResult = spawner('forge-ai', ['update']);
  return specResult.status ?? 1;
}

function defaultSpawner(command: string, args: string[]): { status: number | null } {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return { status: result.status };
}
