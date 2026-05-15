import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { renderClaudeAgent, renderClaudeSkill } from './adapters/claude.js';
import { renderCodexAgent, renderCodexSkill } from './adapters/codex.js';
import { renderOpenCodeAgent, renderOpenCodeSkill } from './adapters/opencode.js';
import { diagnostic } from './diagnostics.js';
import { discoverSources } from './discovery.js';
import { lookupEntryByPath, resolveBackupPath, sha256, type AssetManifest } from './manifest.js';
import { resolveOutputPath } from './paths.js';
import { isPlatform, platforms, type CanonicalArtifact, type Diagnostic, type FileStatus, type OpenCodeMode, type OutputFile, type PendingDecisions, type Platform, type PlatformArg, type Scope, type SourceItem, type SourceKind, type WritePlan } from './model.js';

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const platformKeys = new Set(['claude', 'opencode', 'codex']);
const allowedTopLevel = new Set(['name', 'description', 'kind', 'claude', 'opencode', 'codex']);
const allowedProductKeys = new Set(['permissions', 'model', 'kind']);
const allowedOpenCodeKeys = new Set([...allowedProductKeys, 'mode']);
const openCodeModes = new Set<OpenCodeMode>(['primary', 'subagent', 'all']);
const artifactKinds = new Set<SourceKind>(['agent', 'skill']);

export type ProcessOptions = {
  source: string;
  platform: PlatformArg;
  scope: Scope;
  cwd?: string;
  home?: string;
  checkCollisions?: boolean;
  manifest?: AssetManifest;
  backupRoot?: string;
};

export function resolvePlatforms(platform: PlatformArg): Platform[] {
  return platform === 'all' ? platforms : [platform];
}

export function parsePlatform(value: string): PlatformArg | undefined {
  return value === 'all' || isPlatform(value) ? value : undefined;
}

export function parseScope(value: string): Scope | undefined {
  return value === 'user' || value === 'project' ? value : undefined;
}

export async function buildWritePlan(options: ProcessOptions): Promise<WritePlan & { sourceCount: number }> {
  const { sources, diagnostics } = await discoverSources(options.source);
  const artifacts: CanonicalArtifact[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const converted = convertSource(source, options.source);
    diagnostics.push(...converted.diagnostics);
    if (!converted.item) continue;
    if (seen.has(converted.item.name)) {
      diagnostics.push(diagnostic('error', 'DUPLICATE_NAME', `Duplicate artifact name ${converted.item.name}`, { sourcePath: source.sourcePath }));
      continue;
    }
    seen.add(converted.item.name);
    artifacts.push(converted.item);
  }
  const files: OutputFile[] = [];
  const pending: PendingDecisions = { modifiedOverwrites: [], foreignOverwrites: [] };
  if (!diagnostics.some((item) => item.severity === 'error')) {
    for (const platform of resolvePlatforms(options.platform)) {
      for (const artifact of artifacts) {
        const effectiveKind = artifact[platform]?.kind ?? artifact.kind;
        files.push(renderFile(platform, effectiveKind, artifact, options, diagnostics));
      }
    }
    files.sort((a, b) => `${a.platform}:${a.kind}:${a.name}`.localeCompare(`${b.platform}:${b.kind}:${b.name}`));
    if (options.checkCollisions) {
      const anchor = options.scope === 'user' ? (options.home ?? '') : (options.cwd ?? '');
      diagnostics.push(...await classifyDestinations(files, options.manifest, options.backupRoot, anchor, pending));
    }
  }
  return { files, diagnostics, pending, sourceCount: sources.length };
}

function convertSource(source: SourceItem, sourceRoot: string): { item?: CanonicalArtifact; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const data = source.data;
  const name = typeof data.name === 'string' ? data.name : undefined;
  const description = typeof data.description === 'string' ? data.description : undefined;
  const kind = data.kind;
  for (const key of Object.keys(data)) {
    if (!allowedTopLevel.has(key)) diagnostics.push(diagnostic('error', 'UNSUPPORTED_FIELD', `Unsupported canonical field ${key}`, { sourcePath: source.sourcePath }));
  }
  for (const platform of platformKeys) {
    const config = data[platform];
    if (config === undefined) continue;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      diagnostics.push(diagnostic('error', 'INVALID_PLATFORM_BLOCK', `${platform} must be an object`, { sourcePath: source.sourcePath, platform: platform as Platform }));
      continue;
    }
    const record = config as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const allowedKeys = platform === 'opencode' ? allowedOpenCodeKeys : allowedProductKeys;
      if (!allowedKeys.has(key)) diagnostics.push(diagnostic('error', 'UNSUPPORTED_PLATFORM_FIELD', `${platform}.${key} is not supported in the MVP`, { sourcePath: source.sourcePath, platform: platform as Platform }));
    }
    if ('model' in record && typeof record.model !== 'string') {
      diagnostics.push(diagnostic('error', 'INVALID_PLATFORM_MODEL', `${platform}.model must be a string`, { sourcePath: source.sourcePath, platform: platform as Platform }));
    }
    if ('kind' in record && !artifactKinds.has(record.kind as SourceKind)) {
      diagnostics.push(diagnostic('error', 'INVALID_PLATFORM_KIND', `${platform}.kind must be one of agent, skill`, { sourcePath: source.sourcePath, platform: platform as Platform }));
    }
    if (platform === 'opencode' && 'mode' in record) {
      if (!openCodeModes.has(record.mode as OpenCodeMode)) {
        diagnostics.push(diagnostic('error', 'INVALID_OPENCODE_MODE', 'opencode.mode must be one of primary, subagent, all', { sourcePath: source.sourcePath, platform: 'opencode' }));
      }
      const effectiveKind = (record.kind as SourceKind) ?? kind;
      if (effectiveKind !== 'agent') {
        diagnostics.push(diagnostic('error', 'OPENCODE_MODE_ON_SKILL', 'opencode.mode is only valid when the OpenCode artifact kind is agent', { sourcePath: source.sourcePath, platform: 'opencode' }));
      }
    }
  }
  if (!name) diagnostics.push(diagnostic('error', 'MISSING_NAME', 'artifact name is required', { sourcePath: source.sourcePath }));
  if (name && !namePattern.test(name)) diagnostics.push(diagnostic('error', 'INVALID_NAME', 'artifact name must be kebab-case', { sourcePath: source.sourcePath }));
  if (name && name !== source.expectedName) diagnostics.push(diagnostic('error', 'NAME_MISMATCH', `artifact name must match ${source.expectedName}`, { sourcePath: source.sourcePath }));
  if (!description) diagnostics.push(diagnostic('error', 'MISSING_DESCRIPTION', 'artifact description is required', { sourcePath: source.sourcePath }));
  if (kind === undefined) diagnostics.push(diagnostic('error', 'MISSING_KIND', 'artifact kind is required (agent or skill)', { sourcePath: source.sourcePath }));
  else if (!artifactKinds.has(kind as SourceKind)) diagnostics.push(diagnostic('error', 'INVALID_KIND', 'artifact kind must be one of agent, skill', { sourcePath: source.sourcePath }));
  if (!source.body.trim()) diagnostics.push(diagnostic('error', 'EMPTY_BODY', 'artifact body is required', { sourcePath: source.sourcePath }));
  if (!name || !description || !artifactKinds.has(kind as SourceKind) || !source.body.trim() || diagnostics.some((item) => item.severity === 'error')) return { diagnostics };
  return {
    diagnostics,
    item: {
      name,
      description,
      kind: kind as SourceKind,
      body: source.body,
      sourcePath: path.relative(path.resolve(sourceRoot), source.sourcePath),
      claude: productConfig(data.claude),
      opencode: productConfig(data.opencode),
      codex: productConfig(data.codex)
    }
  };
}

function productConfig(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as { permissions?: unknown; model?: string; kind?: SourceKind; mode?: OpenCodeMode } : undefined;
}

function renderFile(platform: Platform, kind: SourceKind, artifact: CanonicalArtifact, options: ProcessOptions, diagnostics: Diagnostic[]): OutputFile {
  const rendered = kind === 'agent'
    ? platform === 'opencode' ? renderOpenCodeAgent(artifact) : platform === 'claude' ? renderClaudeAgent(artifact) : renderCodexAgent(artifact)
    : platform === 'opencode' ? renderOpenCodeSkill(artifact) : platform === 'claude' ? renderClaudeSkill(artifact) : renderCodexSkill(artifact);
  diagnostics.push(...rendered.diagnostics);
  return { platform, kind, scope: options.scope, name: artifact.name, sourcePath: artifact.sourcePath, path: resolveOutputPath(platform, kind, options.scope, artifact.name, options.cwd, options.home), content: rendered.content };
}

async function classifyDestinations(files: OutputFile[], manifest: AssetManifest | undefined, backupRoot: string | undefined, anchor: string, pending: PendingDecisions): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    const status = await classifyFile(file.path, manifest);
    file.status = status;
    if (status === 'managed-modified' && backupRoot) {
      file.backupPath = resolveBackupPath(backupRoot, file.path, anchor);
      pending.modifiedOverwrites.push(file);
      diagnostics.push(diagnostic('warning', 'MANAGED_FILE_OVERWRITE', `Will overwrite locally edited Forge file ${file.path}; backup → ${file.backupPath}`, { platform: file.platform }));
    } else if (status === 'foreign') {
      pending.foreignOverwrites.push(file);
      diagnostics.push(diagnostic('warning', 'FOREIGN_FILE_OVERWRITE', `Will overwrite untracked file at ${file.path}`, { platform: file.platform }));
    }
  }
  return diagnostics;
}

async function classifyFile(filePath: string, manifest: AssetManifest | undefined): Promise<FileStatus> {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    return 'new';
  }
  const entry = lookupEntryByPath(manifest, filePath);
  if (!entry) return 'foreign';
  const content = await readFile(filePath, 'utf8');
  return sha256(content) === entry.checksum ? 'managed-unmodified' : 'managed-modified';
}
