#!/usr/bin/env node
// Repo-internal drift check: confirms forge-plugin/ (committed, generated output) still matches
// what `build-plugin` would generate right now from artifacts/. Not part of the public CLI surface
// (see .forge/claude-code-plugin-distribution/design-f4.md) -- this question only makes sense for
// THIS repo's own artifacts/forge-plugin pair, never for a consumer of @guidobuilds/forge-ai.
//
// Plain Node ESM, never compiled by tsc, never shipped in the npm tarball (not in package.json's
// "files" array). Imports the already-compiled emitter from dist/, mirroring bin/forge-ai.mjs's
// import-from-dist pattern -- run `pnpm run build` first if dist/ is stale.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClaudePluginPackage } from '../dist/src/adapters/claude-plugin.js';
import { buildCodexPluginPackage } from '../dist/src/adapters/codex-plugin.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  { name: 'claude', outDir: path.join(repoRoot, 'forge-plugin'), build: buildClaudePluginPackage },
  { name: 'codex', outDir: path.join(repoRoot, 'plugins', 'forge'), build: buildCodexPluginPackage }
];
const FIX_COMMAND = 'node bin/forge-ai.mjs build-plugin --target claude --source . --out forge-plugin --force && node bin/forge-ai.mjs build-plugin --target codex --source . --out plugins/forge --force';

async function readPackageMeta() {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  return {
    version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
    license: typeof packageJson.license === 'string' ? packageJson.license : 'UNLICENSED'
  };
}

// Recursively lists files actually on disk under `dir`. Skips only the literal `.DS_Store` file --
// not a blanket dotfile skip, since `.claude-plugin/` is itself a required generated directory that
// must be compared like any other.
async function listFilesOnDisk(dir) {
  const results = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

function formatDiagnostic(diagnostic) {
  const location = diagnostic.sourcePath ? ` ${diagnostic.sourcePath}` : '';
  const platform = diagnostic.platform ? ` [${diagnostic.platform}]` : '';
  return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}${platform}${location}: ${diagnostic.message}`;
}

async function main() {
  const { version, license } = await readPackageMeta();
  const missing = [];
  const extra = [];
  const modified = [];
  let checked = 0;
  let hasDiagnosticErrors = false;
  for (const target of targets) {
    const { files, diagnostics } = await target.build(repoRoot, version, license);
    checked += files.length;
    const generatedByPath = new Map(files.map((file) => [file.relativePath, file.content]));
    const onDiskByPath = new Map();
    for (const absolutePath of await listFilesOnDisk(target.outDir)) {
      const relativePath = path.relative(target.outDir, absolutePath).split(path.sep).join('/');
      onDiskByPath.set(relativePath, await readFile(absolutePath, 'utf8'));
    }
    for (const [relativePath, content] of generatedByPath) {
      const labelled = `${target.name}:${relativePath}`;
      if (!onDiskByPath.has(relativePath)) missing.push(labelled);
      else if (onDiskByPath.get(relativePath) !== content) modified.push(labelled);
    }
    for (const relativePath of onDiskByPath.keys()) {
      if (!generatedByPath.has(relativePath)) extra.push(`${target.name}:${relativePath}`);
    }
    for (const item of diagnostics) console.log(formatDiagnostic(item));
    hasDiagnosticErrors ||= diagnostics.some((item) => item.severity === 'error');
  }

  const hasDrift = missing.length > 0 || extra.length > 0 || modified.length > 0;

  if (!hasDrift && !hasDiagnosticErrors) {
    console.log(`Claude and Codex plugin packages are in sync with artifacts/ (${checked} file(s) checked).`);
    return 0;
  }

  for (const relativePath of missing.sort()) {
    console.error(`MISSING (generated, not on disk): ${relativePath}`);
  }
  for (const relativePath of extra.sort()) {
    console.error(`EXTRA (on disk, not generated): ${relativePath}`);
  }
  for (const relativePath of modified.sort()) {
    console.error(`MODIFIED (content differs): ${relativePath}`);
  }
  if (hasDiagnosticErrors) {
    console.error('One or more build-plugin diagnostics reported severity "error" (see above).');
  }

  console.error(`\nPlugin packages are out of sync with artifacts/. Fix with:\n  ${FIX_COMMAND}`);
  return 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
