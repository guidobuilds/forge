import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClaudePluginPackage } from './adapters/claude-plugin.js';
import { buildCodexPluginPackage } from './adapters/codex-plugin.js';
import { formatDiagnostic, hasErrors } from './diagnostics.js';
import { writePluginFiles } from './writer.js';

export type RunBuildPluginOptions = {
  target: 'claude' | 'codex';
  source: string;
  outDir: string;
  dryRun: boolean;
  force: boolean;
  log?: (message: string) => void;
  logError?: (message: string) => void;
};

export async function runBuildPlugin(options: RunBuildPluginOptions): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string) => console.error(message));

  const identityPath = options.target === 'claude' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json';
  if (!options.force && (await isUnsafeOutDir(options.outDir, identityPath))) {
    logError(`Refusing to write into non-empty directory ${options.outDir} that does not look like a prior Forge ${options.target} plugin build (${identityPath} must identify plugin "forge"); re-run with --force to overwrite.`);
    return 1;
  }

  const { version, license } = await readPackageMeta();
  const { files, diagnostics } = options.target === 'claude'
    ? await buildClaudePluginPackage(options.source, version, license)
    : await buildCodexPluginPackage(options.source, version, license);

  if (options.dryRun) {
    log(`build-plugin: ${files.length} file(s) would be written to ${options.outDir}`);
    for (const file of files) log(`- ${file.relativePath}`);
    for (const item of diagnostics) log(formatDiagnostic(item));
    return 0;
  }

  await writePluginFiles(options.outDir, files);
  log(`Wrote ${files.length} file(s) to ${options.outDir}.`);
  for (const item of diagnostics) log(formatDiagnostic(item));
  return hasErrors(diagnostics) ? 1 : 0;
}

async function isUnsafeOutDir(outDir: string, identityPath: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(outDir);
  } catch {
    return false; // missing directory is safe: writePluginFiles will create it.
  }
  if (entries.length === 0) return false; // empty directory is safe.
  try {
    const manifestPath = path.join(outDir, identityPath);
    await access(manifestPath, constants.F_OK);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown };
    return manifest.name !== 'forge';
  } catch {
    return true;
  }
}

async function readPackageMeta(): Promise<{ version: string; license: string }> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown; license?: unknown };
    return {
      version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
      license: typeof packageJson.license === 'string' ? packageJson.license : 'UNLICENSED'
    };
  } catch {
    return { version: '0.0.0', license: 'UNLICENSED' };
  }
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}
