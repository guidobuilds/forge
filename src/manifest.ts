import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { access, cp, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OutputFile, Platform, Scope, SourceKind } from './model.js';

export type ManifestEntry = {
  platform: Platform;
  kind: SourceKind;
  name: string;
  path: string;
  sourcePath: string;
  checksum: string;
  forgeVersion: string;
};

export type AssetManifest = {
  schemaVersion: 2;
  scope: Scope;
  projectPath?: string;
  projectPathHash?: string;
  forgeVersion: string;
  updatedAt: string;
  entries: ManifestEntry[];
};

type ManifestEntryV1 = Omit<ManifestEntry, 'forgeVersion'>;
type AssetManifestV1 = Omit<AssetManifest, 'schemaVersion' | 'forgeVersion' | 'entries'> & { schemaVersion: 1; entries: ManifestEntryV1[] };

export type ManifestLocation = {
  stateRoot: string;
  manifestPath: string;
  scope: Scope;
  projectPath?: string;
  projectPathHash?: string;
};

export type PrunePlanItem = ManifestEntry & { reason?: 'checksum-mismatch' | 'missing' | 'unsafe-path'; backupPath?: string };

export function legacyStateRoot(home: string): string {
  return path.join(home, '.forge-ai');
}

export function stateRoot(home: string): string {
  return path.join(home, '.forge', 'state');
}

// `~/.forge/state/` is a path nested under Forge's own namespace that nothing else creates, so its
// mere existence is a safe migration marker — unlike bare `~/.forge/`, which a dogfooded Forge run
// can create as a project feature ledger (index.md, <slug>/feature-list.json, ...) with no relation
// to install state. Nesting under `state/` means the two can never collide, migrated or not.
export async function migrateStateDirectory(home: string): Promise<boolean> {
  const newRoot = stateRoot(home);
  const oldRoot = legacyStateRoot(home);
  if (await pathExists(newRoot)) return false;
  if (!(await pathExists(oldRoot))) return false;
  await cp(oldRoot, newRoot, { recursive: true });
  await writeFile(
    path.join(oldRoot, 'MIGRATED'),
    `Forge migrated its install state to ${newRoot} on ${new Date().toISOString()}.\nThis directory (${oldRoot}) is no longer read by Forge and can be deleted once you've confirmed the new location works.\n`,
    'utf8'
  );
  return true;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function resolveManifestLocation(scope: Scope, cwd = process.cwd(), home: string): Promise<ManifestLocation> {
  const migrated = await migrateStateDirectory(home);
  if (migrated) console.log(`Migrated Forge install state from ${legacyStateRoot(home)} to ${stateRoot(home)}.`);
  const root = stateRoot(home);
  if (scope === 'user') return { stateRoot: root, manifestPath: path.join(root, 'user-manifest.json'), scope };
  const projectPath = await canonicalProjectPath(cwd);
  const projectPathHash = hashProjectPath(projectPath);
  return { stateRoot: root, manifestPath: path.join(root, 'projects', projectPathHash, 'manifest.json'), scope, projectPath, projectPathHash };
}

// A cached old CLI (npx resolves versions independently per invocation) can keep writing to
// ~/.forge-ai/ after migration while a newer CLI writes to ~/.forge/state/, producing two live
// checksum ledgers over the same installed files. Detect it by timestamp rather than silently
// trusting whichever manifest happens to load — the fix is telling the user, not auto-merging.
export async function detectLegacyStateDrift(location: ManifestLocation, home: string): Promise<string | undefined> {
  const legacyPath = location.manifestPath.replace(stateRoot(home), legacyStateRoot(home));
  if (legacyPath === location.manifestPath) return undefined;
  const [legacy, current] = await Promise.all([loadManifest(legacyPath), loadManifest(location.manifestPath)]);
  if (!legacy || !current) return undefined;
  if (new Date(legacy.updatedAt).getTime() <= new Date(current.updatedAt).getTime()) return undefined;
  return `An older Forge install at ${legacyPath} was updated more recently (${legacy.updatedAt}) than ${location.manifestPath} (${current.updatedAt}). An old cached CLI may still be writing there — re-run install/update with this CLI to resync, or remove ${legacyStateRoot(home)} once you've confirmed it's no longer used.`;
}

export type InstallSummary = {
  scope: Scope;
  projectPath?: string;
  forgeVersion: string;
  updatedAt: string;
  platforms: Platform[];
  fileCount: number;
  driftWarning?: string;
};

export async function listInstalls(home: string): Promise<InstallSummary[]> {
  await migrateStateDirectory(home);
  const root = stateRoot(home);
  const summaries: InstallSummary[] = [];
  const userManifestPath = path.join(root, 'user-manifest.json');
  const userManifest = await loadManifest(userManifestPath);
  if (userManifest) summaries.push(await summarize(userManifest, { stateRoot: root, manifestPath: userManifestPath, scope: 'user' }, home));

  let projectHashes: string[] = [];
  try {
    projectHashes = await readdir(path.join(root, 'projects'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const hash of projectHashes) {
    const manifestPath = path.join(root, 'projects', hash, 'manifest.json');
    const manifest = await loadManifest(manifestPath);
    if (manifest) summaries.push(await summarize(manifest, { stateRoot: root, manifestPath, scope: 'project', projectPathHash: hash }, home));
  }
  return summaries;
}

async function summarize(manifest: AssetManifest, location: ManifestLocation, home: string): Promise<InstallSummary> {
  const platforms = [...new Set(manifest.entries.map((entry) => entry.platform))].sort();
  const driftWarning = await detectLegacyStateDrift(location, home);
  return { scope: manifest.scope, projectPath: manifest.projectPath, forgeVersion: manifest.forgeVersion, updatedAt: manifest.updatedAt, platforms, fileCount: manifest.entries.length, driftWarning };
}

export async function loadManifest(manifestPath: string): Promise<AssetManifest | undefined> {
  let raw: AssetManifestV1 | AssetManifest;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifestV1 | AssetManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) {
      console.error(`state file corrupt at ${manifestPath}; re-run \`forge-ai install\` to regenerate it.`);
      return undefined;
    }
    throw error;
  }
  // Validate shape BEFORE accessing fields — parseable non-objects ("hi", [1,2], 42, null) throw
  // TypeError (not SyntaxError) on `raw.schemaVersion`, so shape-mismatch must be caught here.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Array.isArray(raw.entries)) {
    console.error(`state file corrupt at ${manifestPath}; re-run \`forge-ai install\` to regenerate it.`);
    return undefined;
  }
  if (raw.schemaVersion === 1) return upgradeManifestV1(raw);
  return raw;
}

function upgradeManifestV1(manifest: AssetManifestV1): AssetManifest {
  return {
    ...manifest,
    schemaVersion: 2,
    forgeVersion: 'unknown',
    entries: manifest.entries.map((entry) => ({ ...entry, forgeVersion: 'unknown' }))
  };
}

export async function buildManifest(location: ManifestLocation, files: OutputFile[], forgeVersion: string, now = new Date(), oldManifest?: AssetManifest): Promise<AssetManifest> {
  const entries = await Promise.all(files.map(async (file) => ({
    platform: file.platform,
    kind: file.kind,
    name: file.name,
    path: file.path,
    sourcePath: file.sourcePath,
    checksum: sha256(await readFile(file.path, 'utf8')),
    forgeVersion
  })));
  // Entries for platforms this run didn't touch (e.g. a prior `install --platform claude` run,
  // followed by `install --platform opencode`) are carried forward rather than dropped, so
  // previously-installed files never silently reclassify as foreign on a later run.
  const touchedPlatforms = new Set(files.map((file) => file.platform));
  const carriedForward = (oldManifest?.entries ?? []).filter((entry) => !touchedPlatforms.has(entry.platform));
  return {
    schemaVersion: 2,
    scope: location.scope,
    projectPath: location.projectPath,
    projectPathHash: location.projectPathHash,
    forgeVersion,
    updatedAt: now.toISOString(),
    entries: [...carriedForward, ...entries]
  };
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${randomUUID()}`);
  try {
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function saveManifest(manifestPath: string, manifest: AssetManifest): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function lookupEntryByPath(manifest: AssetManifest | undefined, filePath: string): ManifestEntry | undefined {
  return manifest?.entries.find((entry) => entry.path === filePath);
}

export function staleEntries(oldManifest: AssetManifest | undefined, files: OutputFile[]): ManifestEntry[] {
  if (!oldManifest) return [];
  const currentPaths = new Set(files.map((file) => file.path));
  return oldManifest.entries.filter((entry) => !currentPaths.has(entry.path));
}

export async function classifyPruneEntries(entries: ManifestEntry[], roots: string[]): Promise<{ deletable: PrunePlanItem[]; skipped: PrunePlanItem[] }> {
  const deletable: PrunePlanItem[] = [];
  const skipped: PrunePlanItem[] = [];
  for (const entry of entries) {
    if (!isSafeManifestEntry(entry, roots)) {
      skipped.push({ ...entry, reason: 'unsafe-path' });
      continue;
    }
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

export async function pruneEntries(entries: PrunePlanItem[], roots: string[]): Promise<void> {
  for (const entry of entries) {
    if (!isSafeManifestEntry(entry, roots)) continue; // defense in depth: never rm an out-of-scope path
    if (entry.backupPath) {
      try {
        const content = await readFile(entry.path, 'utf8');
        await backupFile(entry.backupPath, content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Source file is already gone; nothing to back up.
      }
    }
    await rm(entry.path, { force: true });
    if (entry.kind === 'skill') await removeEmptyParent(path.dirname(entry.path));
  }
}

export function resolveBackupRoot(location: ManifestLocation, now: Date): string {
  const scopeKey = location.scope === 'user' ? 'user' : path.join('projects', location.projectPathHash ?? 'unknown');
  return path.join(location.stateRoot, 'backups', scopeKey, isoTimestamp(now));
}

export function resolveBackupPath(backupRoot: string, originalAbsolutePath: string, anchor: string): string {
  const rel = path.relative(anchor, originalAbsolutePath);
  const safe = rel.startsWith('..') || path.isAbsolute(rel)
    ? originalAbsolutePath.replace(/^[\/\\]+/, '')
    : rel;
  return path.join(backupRoot, safe);
}

export async function backupFile(backupPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(backupPath, content, 'utf8');
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// True when `p` is absolute and canonicalizes (realpath) to inside one of the already-canonical
// `roots` (canonical→canonical comparison; path.relative resolves `..` internally).
export function isSafeManifestPath(p: string, roots: string[]): boolean {
  if (!path.isAbsolute(p)) return false;
  const resolved = canonicalizePath(p);
  return roots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

function hasValidEntrySchema(entry: unknown): entry is ManifestEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.platform === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.name === 'string' &&
    typeof e.path === 'string' &&
    typeof e.sourcePath === 'string' &&
    typeof e.checksum === 'string' &&
    CHECKSUM_PATTERN.test(e.checksum)
  );
}

export function isSafeManifestEntry(entry: ManifestEntry, roots: string[]): boolean {
  return hasValidEntrySchema(entry) && isSafeManifestPath(entry.path, roots);
}

export function hashProjectPath(projectPath: string): string {
  return sha256(projectPath).slice(0, 32);
}

function isoTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
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
