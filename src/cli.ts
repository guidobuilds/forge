#!/usr/bin/env node
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { formatDiagnostic, hasErrors } from './diagnostics.js';
import { buildManifest, classifyPruneEntries, loadManifest, pruneEntries, resolveBackupPath, resolveBackupRoot, resolveManifestLocation, saveManifest, staleEntries, type PrunePlanItem } from './manifest.js';
import { buildWritePlan, parsePlatform, parseScope } from './processor.js';
import { writeOutputs } from './writer.js';
import { hasPendingDecisions, type Diagnostic, type OutputFile, type PlatformArg, type Scope, type WritePlan } from './model.js';

type Command = 'validate' | 'install' | 'update';
type CliOptions = {
  command?: string;
  platform: PlatformArg;
  scope: Scope;
  source: string;
  dryRun: boolean;
  force: boolean;
  prune: boolean;
  yes: boolean;
  platformExplicit: boolean;
  scopeExplicit: boolean;
  sourceExplicit: boolean;
};
type PromptIO = { input?: Readable; output?: Writable; isInteractive?: boolean; env?: NodeJS.ProcessEnv };

type PrunePlan = {
  deletable: PrunePlanItem[];
  modifiedWithConsent: PrunePlanItem[];
  skippedMissing: PrunePlanItem[];
};

const emptyPrunePlan: PrunePlan = { deletable: [], modifiedWithConsent: [], skippedMissing: [] };

export async function main(argv = process.argv.slice(2), promptIO: PromptIO = {}): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    showUsage();
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(readPackageVersion());
    return 0;
  }

  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(parsed.error);
    return 1;
  }

  const options = parsed.options;
  const command = normalizeCommand(options.command);
  if (!command) {
    console.error(`Unknown command ${options.command ?? ''}`);
    showUsage();
    return 1;
  }

  const install = command === 'install' || command === 'update';
  if (install && !options.sourceExplicit) options.source = bundledSourceRoot();
  if (command === 'update' || options.yes) options.force = true;
  const interactive = install && isInteractivePrompt(promptIO);
  if (interactive) p.intro(`${pc.bold('Forge AI')} ${pc.dim(command === 'update' ? 'updater' : 'installer')}`, clackIO(promptIO));
  if (install) {
    const prompted = await promptForMissingInstallOptions(options, promptIO);
    if (!prompted) {
      if (interactive) p.cancel('Cancelled', clackIO(promptIO));
      return 1;
    }
  }

  const cwd = process.cwd();
  const home = resolveHome(promptIO);
  const now = new Date();

  let manifestLocation: Awaited<ReturnType<typeof resolveManifestLocation>> | undefined;
  let oldManifest;
  let backupRoot: string | undefined;
  if (install) {
    manifestLocation = await resolveManifestLocation(options.scope, cwd, home);
    oldManifest = await loadManifest(manifestLocation.manifestPath);
    backupRoot = resolveBackupRoot(manifestLocation, now);
  }

  const plan = await buildWritePlan({
    source: options.source,
    platform: options.platform,
    scope: options.scope,
    cwd,
    home,
    manifest: oldManifest,
    backupRoot,
    checkCollisions: install,
  });

  let prunePlan: PrunePlan = emptyPrunePlan;
  if (install && command === 'update' && options.prune) {
    prunePlan = await classifyPrune(oldManifest, plan.files, backupRoot!, options.scope, cwd, home);
  }

  const needsConfirm = install && !options.force && (hasPendingDecisions(plan.pending) || prunePlan.modifiedWithConsent.length > 0);
  if (install && !options.dryRun && needsConfirm) {
    if (!interactive) {
      printPlan(command, plan.sourceCount, plan.files, plan.diagnostics, prunePlan);
      console.error('Forge needs your decision on edited or untracked files; re-run with --yes or --force to accept overwrites + backups.');
      return 1;
    }
    const accepted = await promptForUpdate(plan, prunePlan, backupRoot, promptIO);
    if (accepted === undefined) {
      p.cancel('Cancelled', clackIO(promptIO));
      return 1;
    }
    if (!accepted) {
      p.outro(pc.yellow('Forge was not installed.'), clackIO(promptIO));
      return 1;
    }
  }

  printPlan(command, plan.sourceCount, plan.files, plan.diagnostics, prunePlan);
  if (hasErrors(plan.diagnostics)) {
    if (interactive) p.outro(pc.red('Forge was not installed.'), clackIO(promptIO));
    return 1;
  }
  if (install && !options.dryRun) {
    if (interactive) {
      const spinner = p.spinner(clackIO(promptIO));
      spinner.start(options.force ? 'Updating Forge files' : 'Installing Forge files');
      try {
        await writeOutputs(plan.files);
        if (command === 'update' && options.prune) await pruneEntries([...prunePlan.deletable, ...prunePlan.modifiedWithConsent]);
        await saveManifest(manifestLocation!.manifestPath, await buildManifest(manifestLocation!, plan.files));
        spinner.stop(`Wrote ${plan.files.length} file(s).`);
      } catch (error) {
        spinner.error('Failed to write Forge files');
        throw error;
      }
    } else {
      await writeOutputs(plan.files);
      if (command === 'update' && options.prune) await pruneEntries([...prunePlan.deletable, ...prunePlan.modifiedWithConsent]);
      await saveManifest(manifestLocation!.manifestPath, await buildManifest(manifestLocation!, plan.files));
      console.log(`Wrote ${plan.files.length} file(s).`);
      const totalDeleted = prunePlan.deletable.length + prunePlan.modifiedWithConsent.length;
      if (command === 'update' && options.prune && totalDeleted > 0) console.log(`Deleted ${totalDeleted} stale file(s).`);
      console.log(`Updated manifest ${manifestLocation!.manifestPath}.`);
    }
  } else if (install && interactive) {
    p.log.info(`Dry run only. ${plan.files.length} file(s) would be written.`, clackIO(promptIO));
  }
  if (install && interactive) {
    p.outro(options.dryRun ? pc.cyan('Dry run complete.') : pc.green('Forge is ready.'), clackIO(promptIO));
  }
  return 0;
}

function parseArgs(argv: string[]): { options: CliOptions } | { error: string } {
  const options: CliOptions = { command: argv[0], platform: 'all', scope: 'user', source: '.', dryRun: false, force: false, prune: true, yes: false, platformExplicit: false, scopeExplicit: false, sourceExplicit: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--no-prune') options.prune = false;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--platform') {
      const value = argv[++index];
      const platform = value ? parsePlatform(value) : undefined;
      if (!platform) return { error: `Invalid --platform ${value ?? ''}` };
      options.platform = platform;
      options.platformExplicit = true;
    } else if (arg === '--scope') {
      const value = argv[++index];
      const scope = value ? parseScope(value) : undefined;
      if (!scope) return { error: `Invalid --scope ${value ?? ''}` };
      options.scope = scope;
      options.scopeExplicit = true;
    } else if (arg === '--source') {
      const value = argv[++index];
      if (!value) return { error: 'Missing --source value' };
      options.source = value;
      options.sourceExplicit = true;
    } else {
      return { error: `Unknown argument ${arg}` };
    }
  }

  const command = normalizeCommand(options.command);
  if (command !== 'update' && !options.prune) return { error: '--no-prune is only accepted for update' };
  if (command === 'validate' && (options.dryRun || options.force || options.yes || options.scopeExplicit)) return { error: 'validate only accepts --platform and --source' };
  return { options };
}

async function classifyPrune(oldManifest: Awaited<ReturnType<typeof loadManifest>>, files: OutputFile[], backupRoot: string, scope: Scope, cwd: string, home: string): Promise<PrunePlan> {
  const stale = staleEntries(oldManifest, files);
  const classified = await classifyPruneEntries(stale);
  const anchor = scope === 'user' ? home : cwd;
  const modifiedWithConsent: PrunePlanItem[] = [];
  const skippedMissing: PrunePlanItem[] = [];
  for (const item of classified.skipped) {
    if (item.reason === 'checksum-mismatch') modifiedWithConsent.push({ ...item, backupPath: resolveBackupPath(backupRoot, item.path, anchor) });
    else skippedMissing.push(item);
  }
  return { deletable: classified.deletable, modifiedWithConsent, skippedMissing };
}

async function promptForMissingInstallOptions(options: CliOptions, promptIO: PromptIO): Promise<boolean> {
  if (options.yes) return true;
  if (options.platformExplicit && options.scopeExplicit) return true;
  if (!isInteractivePrompt(promptIO)) return true;

  const io = clackIO(promptIO);
  if (!options.platformExplicit) {
    const platform = await p.select<PlatformArg>({
      message: 'Install Forge for which coding agent?',
      initialValue: 'all',
      options: [
        { value: 'all', label: 'All supported agents', hint: 'OpenCode, Codex, and Claude Code' },
        { value: 'opencode', label: 'OpenCode' },
        { value: 'codex', label: 'Codex' },
        { value: 'claude', label: 'Claude Code' }
      ],
      ...io
    });
    if (p.isCancel(platform)) return false;
    options.platform = platform;
  }
  if (!options.scopeExplicit) {
    const scope = await p.select<Scope>({
      message: 'Where should Forge be installed?',
      initialValue: 'user',
      options: [
        { value: 'user', label: 'User', hint: 'Available in every project' },
        { value: 'project', label: 'Project', hint: 'Only this repository' }
      ],
      ...io
    });
    if (p.isCancel(scope)) return false;
    options.scope = scope;
  }
  return true;
}

async function promptForUpdate(plan: WritePlan & { sourceCount: number }, prunePlan: PrunePlan, backupRoot: string | undefined, promptIO: PromptIO): Promise<boolean | undefined> {
  if (!isInteractivePrompt(promptIO)) return false;
  const io = clackIO(promptIO);
  const sections: string[] = [];
  if (plan.pending.modifiedOverwrites.length > 0) {
    sections.push(`${pc.yellow('Edited by you, will be overwritten (backup):')}\n${plan.pending.modifiedOverwrites.map((file) => `  - ${file.path}`).join('\n')}`);
  }
  if (prunePlan.modifiedWithConsent.length > 0) {
    sections.push(`${pc.yellow('Edited by you, will be deleted (backup):')}\n${prunePlan.modifiedWithConsent.map((entry) => `  - ${entry.path}`).join('\n')}`);
  }
  if (plan.pending.foreignOverwrites.length > 0) {
    sections.push(`${pc.yellow('Untracked files in Forge install paths, will be overwritten:')}\n${plan.pending.foreignOverwrites.map((file) => `  - ${file.path}`).join('\n')}`);
  }
  p.log.warn(`The following actions need your confirmation:\n\n${sections.join('\n\n')}\n\nBackups → ${backupRoot ?? '(none)'}`, io);
  const accepted = await p.confirm({
    message: 'Continue with overwrites + backups?',
    active: 'Continue',
    inactive: 'Cancel',
    initialValue: false,
    ...io
  });
  if (p.isCancel(accepted)) return undefined;
  return accepted;
}

function normalizeCommand(command?: string): Command | undefined {
  if (command === 'install' || command === 'i') return 'install';
  if (command === 'update' || command === 'upgrade') return 'update';
  if (command === 'validate') return 'validate';
  return undefined;
}

function isInteractivePrompt(promptIO: PromptIO): boolean {
  const env = promptIO.env ?? process.env;
  const interactive = promptIO.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return interactive && env.CI !== 'true';
}

function clackIO(promptIO: PromptIO): { input?: Readable; output?: Writable } {
  return { input: promptIO.input, output: promptIO.output };
}

function resolveHome(promptIO: PromptIO): string {
  return promptIO.env?.HOME || os.homedir();
}

function bundledSourceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(bundledSourceRoot(), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function showUsage(): void {
  console.log('Usage: forge-ai install [--platform opencode|claude|codex|all] [--scope user|project] [--source <dir>] [--dry-run] [--force] [--yes]');
  console.log('       forge-ai update [--platform opencode|claude|codex|all] [--scope user|project] [--source <dir>] [--dry-run] [--no-prune] [--yes]');
  console.log('       forge-ai validate [--platform opencode|claude|codex|all] [--source <dir>]');
}

function printPlan(command: string, sourceCount: number, files: OutputFile[], diagnostics: Diagnostic[], prunePlan: PrunePlan): void {
  console.log(`${command}: ${sourceCount} source(s), ${files.length} output(s)`);
  for (const file of files) console.log(`- ${file.platform} ${file.kind} ${file.name} -> ${file.path}${statusSuffix(file)}`);
  for (const item of prunePlan.deletable) console.log(`- delete stale ${item.platform} ${item.kind} ${item.name} -> ${item.path}`);
  for (const item of prunePlan.modifiedWithConsent) console.log(`- delete stale ${item.platform} ${item.kind} ${item.name} -> ${item.path} [backup -> ${item.backupPath}]`);
  for (const item of prunePlan.skippedMissing) console.log(`- skip missing ${item.platform} ${item.kind} ${item.name} -> ${item.path}`);
  for (const item of diagnostics) console.log(formatDiagnostic(item));
}

function statusSuffix(file: OutputFile): string {
  if (file.status === 'managed-modified' && file.backupPath) return ` [overwrite, backup -> ${file.backupPath}]`;
  if (file.status === 'managed-modified') return ' [overwrite]';
  if (file.status === 'foreign') return ' [foreign overwrite]';
  if (file.status === 'managed-unmodified') return ' [refresh]';
  if (file.status === 'new') return ' [new]';
  return '';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
}
