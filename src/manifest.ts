import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OutputFile, Platform, Scope, SourceKind } from './model.js';

export type ManifestEntry = {
  platform: Platform;
  kind: SourceKind;
  name: string;
  path: string;
  sourcePath: string;
  checksum: string;
};

export type AssetManifest = {
  schemaVersion: 1;
  scope: Scope;
  projectPath?: string;
  projectPathHash?: string;
  updatedAt: string;
  entries: ManifestEntry[];
};

export type ManifestLocation = {
  stateRoot: string;
  manifestPath: string;
  scope: Scope;
  projectPath?: string;
  projectPathHash?: string;
};

export type PrunePlanItem = ManifestEntry & { reason?: 'checksum-mismatch' | 'missing' };

export async function resolveManifestLocation(scope: Scope, cwd = process.cwd(), home: string): Promise<ManifestLocation> {
  const stateRoot = path.join(home, '.forge-ai');
  if (scope === 'user') return { stateRoot, manifestPath: path.join(stateRoot, 'user-manifest.json'), scope };
  const projectPath = await canonicalProjectPath(cwd);
  const projectPathHash = hashProjectPath(projectPath);
  return { stateRoot, manifestPath: path.join(stateRoot, 'projects', projectPathHash, 'manifest.json'), scope, projectPath, projectPathHash };
}

export async function loadManifest(manifestPath: string): Promise<AssetManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function buildManifest(location: ManifestLocation, files: OutputFile[], now = new Date()): AssetManifest {
  return {
    schemaVersion: 1,
    scope: location.scope,
    projectPath: location.projectPath,
    projectPathHash: location.projectPathHash,
    updatedAt: now.toISOString(),
    entries: files.map((file) => ({
      platform: file.platform,
      kind: file.kind,
      name: file.name,
      path: file.path,
      sourcePath: file.sourcePath,
      checksum: sha256(file.content)
    }))
  };
}

export async function saveManifest(manifestPath: string, manifest: AssetManifest): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function staleEntries(oldManifest: AssetManifest | undefined, files: OutputFile[]): ManifestEntry[] {
  if (!oldManifest) return [];
  const currentPaths = new Set(files.map((file) => file.path));
  return oldManifest.entries.filter((entry) => !currentPaths.has(entry.path));
}

export async function classifyPruneEntries(entries: ManifestEntry[]): Promise<{ deletable: PrunePlanItem[]; skipped: PrunePlanItem[] }> {
  const deletable: PrunePlanItem[] = [];
  const skipped: PrunePlanItem[] = [];
  for (const entry of entries) {
    let content: string;
    try {
      content = await readFile(entry.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') skipped.push({ ...entry, reason: 'missing' });
      else throw error;
      continue;
    }
    if (sha256(content) === entry.checksum) deletable.push(entry);
    else skipped.push({ ...entry, reason: 'checksum-mismatch' });
  }
  return { deletable, skipped };
}

export async function pruneEntries(entries: ManifestEntry[]): Promise<void> {
  for (const entry of entries) {
    await rm(entry.path, { force: true });
    if (entry.kind === 'skill') await removeEmptyParent(path.dirname(entry.path));
  }
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function hashProjectPath(projectPath: string): string {
  return sha256(projectPath).slice(0, 32);
}

async function canonicalProjectPath(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

async function removeEmptyParent(directory: string): Promise<void> {
  try {
    await access(directory, constants.F_OK);
    await rm(directory);
  } catch {
    // Directory does not exist or is not empty; both are safe to ignore.
  }
}
