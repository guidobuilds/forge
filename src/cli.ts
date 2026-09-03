#!/usr/bin/env node
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { rm } from 'node:fs/promises';
import { knownClaudeModels } from './adapters/claude-known.js';
import { knownGrokModels } from './adapters/grok-known.js';
import { formatDiagnostic, hasErrors } from './diagnostics.js';
import { buildManifest, classifyPruneEntries, detectLegacyStateDrift, listInstalls, loadManifest, pruneEntries, resolveBackupPath, resolveBackupRoot, resolveManifestLocation, saveManifest, stateRoot, staleEntries, type InstallSummary, type ManifestEntry, type PrunePlanItem } from './manifest.js';
import { getModelPreference, loadModelPreferences, modelPreferencesPath, saveModelPreferences, setModelPreference, type ModelPreferences } from './model-preferences.js';
import { discoverOpenCodeModels } from './opencode-discovery.js';
import { allowedInstallRoots } from './paths.js';
import { supportsModel } from './platform-capabilities.js';
import { buildWritePlan, discoverArtifacts, parsePlatform, parseScope, resolvePlatforms } from './processor.js';
import { isValidVersionSpec, normalizeVersionSpec, runSelfUpdate } from './self-update.js';
import { checkLatestVersion, formatVersionNotice } from './version-check.js';
import { writeOutputs } from './writer.js';
import { hasPendingDecisions, type CanonicalArtifact, type Diagnostic, type OutputFile, type Platform, type PlatformArg, type Scope, type WritePlan } from './model.js';

type Command = 'validate' | 'install' | 'update' | 'uninstall' | 'list' | 'configure' | 'self-update';
type CliOptions = {
  command?: string;
  platform: PlatformArg;
  scope: Scope;
  source: string;
  dryRun: boolean;
  force: boolean;
  prune: boolean;
  yes: boolean;
  noUpdateCheck: boolean;
  skipSpecUpdate: boolean;
  targetVersion?: string;
  model?: string;
  modelMap?: Record<string, string>;
  platformExplicit: boolean;
  scopeExplicit: boolean;
  sourceExplicit: boolean;
  modelExplicit: boolean;
  modelMapExplicit: boolean;
  // Filled in by the interactive model-selection prompt (promptForModelSelection), not a flag.
  pendingModelPreferences?: ModelPreferences;
};
type PromptIO = { input?: Readable; output?: Writable; isInteractive?: boolean; env?: NodeJS.ProcessEnv };

type PrunePlan = {
  deletable: PrunePlanItem[];
  modifiedWithConsent: PrunePlanItem[];
  skippedMissing: PrunePlanItem[];
  skippedUnsafe: PrunePlanItem[];
};

const emptyPrunePlan: PrunePlan = { deletable: [], modifiedWithConsent: [], skippedMissing: [], skippedUnsafe: [] };

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

  if (command === 'self-update') {
    return runSelfUpdate({
      binaryPath: process.argv[1] ?? bundledSourceRoot(),
      version: options.targetVersion,
      dryRun: options.dryRun,
      skipSpecUpdate: options.skipSpecUpdate,
    });
  }

  if (command === 'uninstall') {
    return runUninstall(options, promptIO);
  }

  if (command === 'list') {
    return runList(promptIO);
  }

  if (command === 'configure') {
    return runConfigure(options, promptIO);
  }

  const versionCheckPromise = shouldCheckForUpdates(options, promptIO)
    ? checkLatestVersion({ current: readPackageVersion(), cachePath: path.join(stateRoot(resolveHome(promptIO)), 'version-check.json') }).catch(() => undefined)
    : Promise.resolve(undefined);

  try {
    const install = command === 'install' || command === 'update';
    if (install && !options.sourceExplicit) options.source = bundledSourceRoot();
    if (command === 'update' || options.yes) options.force = true;
    const interactive = install && isInteractivePrompt(promptIO);
    if (interactive) p.intro(`${pc.bold('Forge AI')} ${pc.dim(command === 'update' ? 'updater' : 'installer')}`, clackIO(promptIO));

    const cwd = process.cwd();
    const home = resolveHome(promptIO);
    const now = new Date();

    if (install) {
      const prompted = await promptForMissingInstallOptions(options, promptIO, cwd, home);
      if (!prompted) {
        if (interactive) p.cancel('Cancelled', clackIO(promptIO));
        return 1;
      }
    }

    let manifestLocation: Awaited<ReturnType<typeof resolveManifestLocation>> | undefined;
    let oldManifest;
    let backupRoot: string | undefined;
    let modelPreferences: ModelPreferences | undefined;
    if (install) {
      manifestLocation = await resolveManifestLocation(options.scope, cwd, home);
      oldManifest = await loadManifest(manifestLocation.manifestPath);
      backupRoot = resolveBackupRoot(manifestLocation, now);
      const drift = await detectLegacyStateDrift(manifestLocation, home);
      if (drift) console.error(`Warning: ${drift}`);

      const prefsPath = modelPreferencesPath(manifestLocation);
      modelPreferences = await loadModelPreferences(prefsPath);
      if (options.modelExplicit || options.modelMapExplicit) {
        const { artifacts } = await discoverArtifacts(options.source);
        const applied = applyModelFlags(modelPreferences, options, artifacts);
        if ('error' in applied) {
          console.error(applied.error);
          return 1;
        }
        modelPreferences = applied.preferences;
        await saveModelPreferences(prefsPath, modelPreferences);
      } else if (options.pendingModelPreferences) {
        modelPreferences = options.pendingModelPreferences;
        await saveModelPreferences(prefsPath, modelPreferences);
      }
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
      modelPreferences,
    });

    let prunePlan: PrunePlan = emptyPrunePlan;
    let pruneRoots: string[] = [];
    if (install && command === 'update' && options.prune) {
      pruneRoots = allowedInstallRoots(options.scope, home, cwd, oldManifest?.projectPath);
      prunePlan = await classifyPrune(oldManifest, plan.files, backupRoot!, options.scope, cwd, home, pruneRoots);
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
          if (command === 'update' && options.prune) await pruneEntries([...prunePlan.deletable, ...prunePlan.modifiedWithConsent], pruneRoots);
          await saveManifest(manifestLocation!.manifestPath, await buildManifest(manifestLocation!, plan.files, readPackageVersion(), now, oldManifest));
          spinner.stop(`Wrote ${plan.files.length} file(s).`);
        } catch (error) {
          spinner.error('Failed to write Forge files');
          throw error;
        }
      } else {
        await writeOutputs(plan.files);
        if (command === 'update' && options.prune) await pruneEntries([...prunePlan.deletable, ...prunePlan.modifiedWithConsent], pruneRoots);
        await saveManifest(manifestLocation!.manifestPath, await buildManifest(manifestLocation!, plan.files, readPackageVersion(), now, oldManifest));
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
  } finally {
    const result = await versionCheckPromise;
    if (result) {
      const notice = formatVersionNotice(result);
      if (notice) console.log(notice);
    }
  }
}

function parseArgs(argv: string[]): { options: CliOptions } | { error: string } {
  const options: CliOptions = { command: argv[0], platform: 'all', scope: 'user', source: '.', dryRun: false, force: false, prune: true, yes: false, noUpdateCheck: false, skipSpecUpdate: false, platformExplicit: false, scopeExplicit: false, sourceExplicit: false, modelExplicit: false, modelMapExplicit: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--no-prune') options.prune = false;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-update-check') options.noUpdateCheck = true;
    else if (arg === '--skip-spec-update') options.skipSpecUpdate = true;
    else if (arg === '--to') {
      const value = argv[++index];
      if (!value) return { error: 'Missing --to value' };
      if (!isValidVersionSpec(value)) return { error: `Invalid --to ${value}; expected a semver or "latest"` };
      options.targetVersion = normalizeVersionSpec(value);
    } else if (arg === '--platform') {
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
    } else if (arg === '--model') {
      const value = argv[++index];
      if (!value) return { error: 'Missing --model value' };
      options.model = value;
      options.modelExplicit = true;
    } else if (arg === '--model-map') {
      const value = argv[++index];
      if (!value) return { error: 'Missing --model-map value' };
      const modelMap = parseModelMap(value);
      if (!modelMap) return { error: `Invalid --model-map ${value}; expected name=model,name2=model2` };
      options.modelMap = modelMap;
      options.modelMapExplicit = true;
    } else {
      return { error: `Unknown argument ${arg}` };
    }
  }

  const command = normalizeCommand(options.command);
  if (command !== 'update' && !options.prune) return { error: '--no-prune is only accepted for update' };
  if (command === 'validate' && (options.dryRun || options.force || options.yes || options.scopeExplicit)) return { error: 'validate only accepts --platform and --source' };
  if (command !== 'self-update' && (options.targetVersion !== undefined || options.skipSpecUpdate)) return { error: '--to and --skip-spec-update are only accepted for self-update' };
  if ((options.modelExplicit || options.modelMapExplicit) && (command !== 'install' && command !== 'update' && command !== 'configure')) return { error: '--model and --model-map are only accepted for install, update, and configure' };
  if ((options.modelExplicit || options.modelMapExplicit) && (!options.platformExplicit || options.platform === 'all')) return { error: '--model and --model-map require an explicit single --platform (model ids are not portable across platforms)' };
  if (command === 'self-update' && (options.platformExplicit || options.scopeExplicit || options.sourceExplicit || options.force || options.yes)) return { error: 'self-update only accepts --to, --dry-run, --skip-spec-update' };
  if (command === 'uninstall' && options.sourceExplicit) return { error: 'uninstall does not accept --source' };
  if (command === 'list' && (options.platformExplicit || options.scopeExplicit || options.sourceExplicit || options.dryRun || options.force || options.yes)) return { error: 'list does not accept any flags' };
  if (command === 'configure' && (options.force || options.yes)) return { error: 'configure does not accept --force or --yes; use --model/--model-map for non-interactive use' };
  return { options };
}

async function classifyPrune(oldManifest: Awaited<ReturnType<typeof loadManifest>>, files: OutputFile[], backupRoot: string, scope: Scope, cwd: string, home: string, roots: string[]): Promise<PrunePlan> {
  const stale = staleEntries(oldManifest, files);
  const classified = await classifyPruneEntries(stale, roots);
  const anchor = scope === 'user' ? home : cwd;
  const modifiedWithConsent: PrunePlanItem[] = [];
  const skippedMissing: PrunePlanItem[] = [];
  const skippedUnsafe: PrunePlanItem[] = [];
  for (const item of classified.skipped) {
    if (item.reason === 'checksum-mismatch') modifiedWithConsent.push({ ...item, backupPath: resolveBackupPath(backupRoot, item.path, anchor) });
    else if (item.reason === 'unsafe-path') skippedUnsafe.push(item);
    else skippedMissing.push(item);
  }
  return { deletable: classified.deletable, modifiedWithConsent, skippedMissing, skippedUnsafe };
}

async function promptForMissingInstallOptions(options: CliOptions, promptIO: PromptIO, cwd: string, home: string): Promise<boolean> {
  if (options.yes) return true;
  if (!isInteractivePrompt(promptIO)) return true;
  const modelFlagsGiven = options.modelExplicit || options.modelMapExplicit;
  if (options.platformExplicit && options.scopeExplicit && modelFlagsGiven) return true;

  const io = clackIO(promptIO);
  if (!options.platformExplicit) {
    const platform = await p.select<PlatformArg>({
      message: 'Install Forge for which coding agent?',
      initialValue: 'all',
      options: [
        { value: 'all', label: 'All supported agents', hint: 'OpenCode, Codex, Claude Code, and Grok Build' },
        { value: 'opencode', label: 'OpenCode' },
        { value: 'codex', label: 'Codex' },
        { value: 'claude', label: 'Claude Code' },
        { value: 'grok', label: 'Grok Build' }
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
  if (!modelFlagsGiven) {
    return promptForModelSelection(options, promptIO, cwd, home);
  }
  return true;
}

type ModelablePair = { platform: Platform; artifact: CanonicalArtifact };

function modelablePairs(artifacts: CanonicalArtifact[], targetPlatforms: Platform[]): ModelablePair[] {
  const pairs: ModelablePair[] = [];
  for (const platform of targetPlatforms) {
    for (const artifact of artifacts) {
      const effectiveKind = artifact[platform]?.kind ?? artifact.kind;
      if (supportsModel(platform, effectiveKind)) pairs.push({ platform, artifact });
    }
  }
  return pairs;
}

const CONFIRM_PROMPT_COUNT_ABOVE = 6;

// Returns false only on user cancellation (Ctrl+C mid-prompt) — declining the "choose per agent"
// path, or there being nothing to choose, both return true (proceed with defaults).
async function promptForModelSelection(options: CliOptions, promptIO: PromptIO, cwd: string, home: string): Promise<boolean> {
  const io = clackIO(promptIO);
  const { artifacts } = await discoverArtifacts(options.source);
  const targetPlatforms = resolvePlatforms(options.platform);
  const pairs = modelablePairs(artifacts, targetPlatforms);
  if (pairs.length === 0) return true;

  const mode = await p.select<'default' | 'per-agent'>({
    message: 'Model selection',
    initialValue: 'default',
    options: [
      { value: 'default', label: "Use each agent's recommended default" },
      { value: 'per-agent', label: 'Choose per agent' }
    ],
    ...io
  });
  if (p.isCancel(mode)) return false;
  if (mode === 'default') return true;

  if (pairs.length > CONFIRM_PROMPT_COUNT_ABOVE) {
    const proceed = await p.confirm({
      message: `This will ask ${pairs.length} questions (one per agent per platform). Continue?`,
      active: 'Continue',
      inactive: 'Use defaults instead',
      initialValue: true,
      ...io
    });
    if (p.isCancel(proceed)) return false;
    if (!proceed) return true;
  }

  const manifestLocation = await resolveManifestLocation(options.scope, cwd, home);
  let preferences = await loadModelPreferences(modelPreferencesPath(manifestLocation));
  const discoveredOpenCodeModels = targetPlatforms.includes('opencode') ? discoverOpenCodeModels(cwd) : undefined;
  for (const { platform, artifact } of pairs) {
    const current = getModelPreference(preferences, platform, artifact.name) ?? artifact[platform]?.model;
    const chosen = await promptForModelValue(platform, artifact.name, current, discoveredOpenCodeModels, promptIO);
    if (chosen === undefined) return false;
    preferences = setModelPreference(preferences, platform, artifact.name, chosen);
  }
  options.pendingModelPreferences = preferences;
  return true;
}

const CUSTOM_MODEL_VALUE = '__custom__';

async function promptForModelValue(platform: Platform, artifactName: string, current: string | undefined, discoveredOpenCodeModels: string[] | undefined, promptIO: PromptIO): Promise<string | undefined> {
  const io = clackIO(promptIO);
  const knownChoices = platform === 'opencode' && discoveredOpenCodeModels ? discoveredOpenCodeModels
    : platform === 'claude' ? [...knownClaudeModels]
    : platform === 'grok' ? [...knownGrokModels]
    : undefined;
  if (knownChoices && knownChoices.length > 0) {
    const initialValue = current && knownChoices.includes(current) ? current : knownChoices[0];
    const choice = await p.select<string>({
      message: `Model for \`${artifactName}\` (${platform})`,
      initialValue,
      options: [...knownChoices.map((value) => ({ value, label: value })), { value: CUSTOM_MODEL_VALUE, label: 'Custom…' }],
      ...io
    });
    if (p.isCancel(choice)) return undefined;
    if (choice !== CUSTOM_MODEL_VALUE) return choice;
  }
  const text = await p.text({
    message: `Model for \`${artifactName}\` (${platform})`,
    initialValue: current,
    validate: (value) => (value && value.trim().length > 0 ? undefined : 'A model id is required'),
    ...io
  });
  if (p.isCancel(text)) return undefined;
  return text;
}

function parseModelMap(value: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const [name, model] = pair.split('=').map((part) => part?.trim());
    if (!name || !model) return undefined;
    result[name] = model;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function applyModelFlags(preferences: ModelPreferences, options: CliOptions, artifacts: CanonicalArtifact[]): { preferences: ModelPreferences } | { error: string } {
  const targetPlatforms = resolvePlatforms(options.platform);
  const platform = targetPlatforms[0];
  let next = preferences;
  if (options.model) {
    for (const artifact of artifacts) {
      const effectiveKind = artifact[platform]?.kind ?? artifact.kind;
      if (supportsModel(platform, effectiveKind)) next = setModelPreference(next, platform, artifact.name, options.model!);
    }
  }
  if (options.modelMap) {
    const knownNames = new Set(artifacts.map((artifact) => artifact.name));
    for (const [name, model] of Object.entries(options.modelMap)) {
      if (!knownNames.has(name)) return { error: `--model-map references unknown artifact "${name}"` };
      next = setModelPreference(next, platform, name, model);
    }
  }
  return { preferences: next };
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

async function runUninstall(options: CliOptions, promptIO: PromptIO): Promise<number> {
  if (options.yes) options.force = true;
  const interactive = isInteractivePrompt(promptIO);
  if (interactive) p.intro(`${pc.bold('Forge AI')} ${pc.dim('uninstaller')}`, clackIO(promptIO));
  const prompted = await promptForMissingUninstallOptions(options, promptIO);
  if (!prompted) {
    if (interactive) p.cancel('Cancelled', clackIO(promptIO));
    return 1;
  }

  const cwd = process.cwd();
  const home = resolveHome(promptIO);
  const now = new Date();
  const manifestLocation = await resolveManifestLocation(options.scope, cwd, home);
  const manifest = await loadManifest(manifestLocation.manifestPath);
  const drift = await detectLegacyStateDrift(manifestLocation, home);
  if (drift) console.error(`Warning: ${drift}`);
  if (!manifest || manifest.entries.length === 0) {
    console.log(`Nothing to uninstall for ${options.scope} scope.`);
    return 0;
  }

  const targeted = options.platform === 'all' ? manifest.entries : manifest.entries.filter((entry) => entry.platform === options.platform);
  if (targeted.length === 0) {
    console.log(`No ${options.platform} files recorded for this ${options.scope} install.`);
    return 0;
  }

  const backupRoot = resolveBackupRoot(manifestLocation, now);
  const anchor = options.scope === 'user' ? home : cwd;
  const roots = allowedInstallRoots(options.scope, home, cwd, manifest.projectPath);
  const classified = await classifyPruneEntries(targeted, roots);
  const modifiedWithConsent: PrunePlanItem[] = classified.skipped
    .filter((item) => item.reason === 'checksum-mismatch')
    .map((item) => ({ ...item, backupPath: resolveBackupPath(backupRoot, item.path, anchor) }));
  const skippedMissing = classified.skipped.filter((item) => item.reason === 'missing');
  const skippedUnsafe = classified.skipped.filter((item) => item.reason === 'unsafe-path');

  const needsConfirm = !options.force && modifiedWithConsent.length > 0;
  if (!options.dryRun && needsConfirm) {
    if (!interactive) {
      printUninstallPlan(classified.deletable, modifiedWithConsent, skippedMissing, skippedUnsafe);
      console.error('Forge needs your decision on edited files; re-run with --yes or --force to accept deletion + backup.');
      return 1;
    }
    const accepted = await promptForUninstall(classified.deletable, modifiedWithConsent, backupRoot, promptIO);
    if (accepted === undefined) {
      p.cancel('Cancelled', clackIO(promptIO));
      return 1;
    }
    if (!accepted) {
      p.outro(pc.yellow('Forge was not uninstalled.'), clackIO(promptIO));
      return 1;
    }
  }

  printUninstallPlan(classified.deletable, modifiedWithConsent, skippedMissing, skippedUnsafe);
  if (options.dryRun) {
    if (interactive) p.outro(pc.cyan('Dry run complete.'), clackIO(promptIO));
    return 0;
  }

  const toRemove = [...classified.deletable, ...modifiedWithConsent];
  await pruneEntries(toRemove, roots);
  const targetedPaths = new Set(targeted.map((entry) => entry.path));
  const remaining = manifest.entries.filter((entry) => !targetedPaths.has(entry.path));
  if (remaining.length === 0) {
    await rm(manifestLocation.manifestPath, { force: true });
  } else {
    await saveManifest(manifestLocation.manifestPath, { ...manifest, entries: remaining, updatedAt: now.toISOString() });
  }

  console.log(`Removed ${toRemove.length} file(s).`);
  if (skippedMissing.length > 0) console.log(`${skippedMissing.length} file(s) were already missing.`);
  if (skippedUnsafe.length > 0) console.error(`Warning: skipped ${skippedUnsafe.length} file(s) outside Forge's install roots (unsafe path); they were NOT removed.`);
  if (interactive) p.outro(pc.green('Forge was uninstalled.'), clackIO(promptIO));
  return 0;
}

async function promptForMissingUninstallOptions(options: CliOptions, promptIO: PromptIO): Promise<boolean> {
  if (options.yes) return true;
  if (options.platformExplicit && options.scopeExplicit) return true;
  if (!isInteractivePrompt(promptIO)) return true;

  const io = clackIO(promptIO);
  if (!options.platformExplicit) {
    const platform = await p.select<PlatformArg>({
      message: 'Uninstall Forge for which coding agent?',
      initialValue: 'all',
      options: [
        { value: 'all', label: 'All supported agents', hint: 'OpenCode, Codex, Claude Code, and Grok Build' },
        { value: 'opencode', label: 'OpenCode' },
        { value: 'codex', label: 'Codex' },
        { value: 'claude', label: 'Claude Code' },
        { value: 'grok', label: 'Grok Build' }
      ],
      ...io
    });
    if (p.isCancel(platform)) return false;
    options.platform = platform;
  }
  if (!options.scopeExplicit) {
    const scope = await p.select<Scope>({
      message: 'Uninstall Forge from which scope?',
      initialValue: 'user',
      options: [
        { value: 'user', label: 'User', hint: 'Installed for every project' },
        { value: 'project', label: 'Project', hint: 'Only this repository' }
      ],
      ...io
    });
    if (p.isCancel(scope)) return false;
    options.scope = scope;
  }
  return true;
}

async function promptForUninstall(deletable: ManifestEntry[], modifiedWithConsent: PrunePlanItem[], backupRoot: string, promptIO: PromptIO): Promise<boolean | undefined> {
  if (!isInteractivePrompt(promptIO)) return false;
  const io = clackIO(promptIO);
  p.log.warn(`${pc.yellow('Edited by you, will be deleted (backup):')}\n${modifiedWithConsent.map((entry) => `  - ${entry.path}`).join('\n')}\n\nBackups → ${backupRoot}`, io);
  const accepted = await p.confirm({
    message: 'Continue with deletion + backup?',
    active: 'Continue',
    inactive: 'Cancel',
    initialValue: false,
    ...io
  });
  if (p.isCancel(accepted)) return undefined;
  return accepted;
}

function printUninstallPlan(deletable: ManifestEntry[], modifiedWithConsent: PrunePlanItem[], skippedMissing: PrunePlanItem[], skippedUnsafe: PrunePlanItem[]): void {
  console.log(`uninstall: ${deletable.length + modifiedWithConsent.length} file(s) to remove`);
  for (const entry of deletable) console.log(`- delete ${entry.platform} ${entry.kind} ${entry.name} -> ${entry.path}`);
  for (const entry of modifiedWithConsent) console.log(`- delete ${entry.platform} ${entry.kind} ${entry.name} -> ${entry.path} [backup -> ${entry.backupPath}]`);
  for (const entry of skippedMissing) console.log(`- skip missing ${entry.platform} ${entry.kind} ${entry.name} -> ${entry.path}`);
  for (const entry of skippedUnsafe) console.log(`- skip unsafe ${entry.platform} ${entry.kind} ${entry.name} -> ${entry.path}`);
}

async function runList(promptIO: PromptIO): Promise<number> {
  const home = resolveHome(promptIO);
  const summaries = await listInstalls(home);
  if (summaries.length === 0) {
    console.log('No Forge installs recorded.');
    return 0;
  }
  for (const summary of summaries) {
    console.log(formatInstallSummary(summary));
    if (summary.driftWarning) console.error(`Warning: ${summary.driftWarning}`);
  }
  return 0;
}

function formatInstallSummary(summary: InstallSummary): string {
  const target = summary.scope === 'user' ? 'user' : `project ${summary.projectPath ?? '(unknown path)'}`;
  const platforms = summary.platforms.length > 0 ? summary.platforms.join(', ') : 'none';
  return `${target}: forge ${summary.forgeVersion}, ${summary.fileCount} file(s), platforms: ${platforms}, updated ${summary.updatedAt}`;
}

async function runConfigure(options: CliOptions, promptIO: PromptIO): Promise<number> {
  const interactive = isInteractivePrompt(promptIO);
  if (interactive) p.intro(`${pc.bold('Forge AI')} ${pc.dim('configure')}`, clackIO(promptIO));

  if (!options.scopeExplicit) {
    if (!interactive) {
      console.error('forge-ai configure needs --scope when not run interactively.');
      return 1;
    }
    const scope = await p.select<Scope>({
      message: 'Configure which scope?',
      initialValue: 'user',
      options: [
        { value: 'user', label: 'User', hint: 'Available in every project' },
        { value: 'project', label: 'Project', hint: 'Only this repository' }
      ],
      ...clackIO(promptIO)
    });
    if (p.isCancel(scope)) {
      p.cancel('Cancelled', clackIO(promptIO));
      return 1;
    }
    options.scope = scope;
  }

  const cwd = process.cwd();
  const home = resolveHome(promptIO);
  const now = new Date();
  const manifestLocation = await resolveManifestLocation(options.scope, cwd, home);
  const manifest = await loadManifest(manifestLocation.manifestPath);
  const drift = await detectLegacyStateDrift(manifestLocation, home);
  if (drift) console.error(`Warning: ${drift}`);
  if (!manifest || manifest.entries.length === 0) {
    console.log(`Nothing installed for ${options.scope} scope — run \`forge-ai install\` first.`);
    return 0;
  }

  const installedPlatforms = [...new Set(manifest.entries.map((entry) => entry.platform))];
  const targetPlatforms = options.platformExplicit ? installedPlatforms.filter((platform) => platform === options.platform) : installedPlatforms;
  if (targetPlatforms.length === 0) {
    console.log(`${options.platform} is not installed for ${options.scope} scope.`);
    return 0;
  }

  const source = options.sourceExplicit ? options.source : bundledSourceRoot();
  const { artifacts } = await discoverArtifacts(source);
  const prefsPath = modelPreferencesPath(manifestLocation);
  let preferences = await loadModelPreferences(prefsPath);

  if (options.modelExplicit || options.modelMapExplicit) {
    const applied = applyModelFlags(preferences, options, artifacts);
    if ('error' in applied) {
      console.error(applied.error);
      return 1;
    }
    preferences = applied.preferences;
  } else {
    if (!interactive) {
      console.error('forge-ai configure needs --model or --model-map when not run interactively.');
      return 1;
    }
    const pairs = modelablePairs(artifacts, targetPlatforms);
    if (pairs.length === 0) {
      console.log('No installed agent on the selected scope supports a configurable model.');
      return 0;
    }
    const discoveredOpenCodeModels = targetPlatforms.includes('opencode') ? discoverOpenCodeModels(cwd) : undefined;
    for (const { platform, artifact } of pairs) {
      const current = getModelPreference(preferences, platform, artifact.name) ?? artifact[platform]?.model;
      const chosen = await promptForModelValue(platform, artifact.name, current, discoveredOpenCodeModels, promptIO);
      if (chosen === undefined) {
        p.cancel('Cancelled', clackIO(promptIO));
        return 1;
      }
      preferences = setModelPreference(preferences, platform, artifact.name, chosen);
    }
  }

  await saveModelPreferences(prefsPath, preferences);

  const backupRoot = resolveBackupRoot(manifestLocation, now);
  let files: OutputFile[] = [];
  let diagnostics: Diagnostic[] = [];
  for (const platform of targetPlatforms) {
    const result = await buildWritePlan({ source, platform, scope: options.scope, cwd, home, manifest, backupRoot, checkCollisions: true, modelPreferences: preferences });
    files = files.concat(result.files);
    diagnostics = diagnostics.concat(result.diagnostics);
  }
  console.log(`configure: ${files.length} file(s) to update`);
  for (const file of files) console.log(`- ${file.platform} ${file.kind} ${file.name} -> ${file.path}${statusSuffix(file)}`);
  for (const item of diagnostics) console.log(formatDiagnostic(item));
  if (hasErrors(diagnostics)) {
    if (interactive) p.outro(pc.red('Forge was not reconfigured.'), clackIO(promptIO));
    return 1;
  }
  if (options.dryRun) {
    if (interactive) p.outro(pc.cyan('Dry run complete. Model preferences were saved; files were not written.'), clackIO(promptIO));
    return 0;
  }

  await writeOutputs(files);
  await saveManifest(manifestLocation.manifestPath, await buildManifest(manifestLocation, files, readPackageVersion(), now, manifest));
  console.log(`Updated ${files.length} file(s) with new model preferences.`);
  if (interactive) p.outro(pc.green('Forge is reconfigured.'), clackIO(promptIO));
  return 0;
}

function normalizeCommand(command?: string): Command | undefined {
  if (command === 'install' || command === 'i') return 'install';
  if (command === 'update' || command === 'upgrade') return 'update';
  if (command === 'validate') return 'validate';
  if (command === 'uninstall') return 'uninstall';
  if (command === 'list' || command === 'ls') return 'list';
  if (command === 'configure') return 'configure';
  if (command === 'self-update') return 'self-update';
  return undefined;
}

function shouldCheckForUpdates(options: CliOptions, promptIO: PromptIO): boolean {
  if (options.noUpdateCheck) return false;
  const env = promptIO.env ?? process.env;
  if (env.CI === 'true') return false;
  if (env.FORGE_NO_UPDATE_CHECK === '1' || env.FORGE_NO_UPDATE_CHECK === 'true') return false;
  // Skip in non-interactive runs (pipes, CI, scripts): the notice is a UX nudge for terminal users.
  if (!isInteractivePrompt(promptIO)) return false;
  return true;
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
  console.log('Usage: forge-ai install [--platform opencode|claude|codex|grok|all] [--scope user|project] [--source <dir>] [--dry-run] [--force] [--yes] [--model <id>] [--model-map name=model,...]');
  console.log('       forge-ai update [--platform opencode|claude|codex|grok|all] [--scope user|project] [--source <dir>] [--dry-run] [--no-prune] [--yes] [--model <id>] [--model-map name=model,...]');
  console.log('       forge-ai uninstall [--platform opencode|claude|codex|grok|all] [--scope user|project] [--dry-run] [--force] [--yes]');
  console.log('       forge-ai list');
  console.log('       forge-ai configure [--platform opencode|claude|codex|grok] [--scope user|project] [--source <dir>] [--dry-run] [--model <id>] [--model-map name=model,...]');
  console.log('       forge-ai validate [--platform opencode|claude|codex|grok|all] [--source <dir>]');
  console.log('       forge-ai self-update [--to <version>] [--dry-run] [--skip-spec-update]');
  console.log('');
  console.log('--model and --model-map require an explicit single --platform (model ids are not portable across platforms).');
  console.log('Global flags: --no-update-check (also FORGE_NO_UPDATE_CHECK=1 or CI=true)');
}

function printPlan(command: string, sourceCount: number, files: OutputFile[], diagnostics: Diagnostic[], prunePlan: PrunePlan): void {
  console.log(`${command}: ${sourceCount} source(s), ${files.length} output(s)`);
  for (const file of files) console.log(`- ${file.platform} ${file.kind} ${file.name} -> ${file.path}${statusSuffix(file)}`);
  for (const item of prunePlan.deletable) console.log(`- delete stale ${item.platform} ${item.kind} ${item.name} -> ${item.path}`);
  for (const item of prunePlan.modifiedWithConsent) console.log(`- delete stale ${item.platform} ${item.kind} ${item.name} -> ${item.path} [backup -> ${item.backupPath}]`);
  for (const item of prunePlan.skippedMissing) console.log(`- skip missing ${item.platform} ${item.kind} ${item.name} -> ${item.path}`);
  for (const item of prunePlan.skippedUnsafe) console.log(`- skip unsafe ${item.platform} ${item.kind} ${item.name} -> ${item.path}`);
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
