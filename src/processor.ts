import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { renderClaudeAgent, renderClaudeSkill } from './adapters/claude.js';
import { renderCodexAgent, renderCodexSkill } from './adapters/codex.js';
import { renderOpenCodeAgent, renderOpenCodeSkill } from './adapters/opencode.js';
import { diagnostic } from './diagnostics.js';
import { discoverSources } from './discovery.js';
import { resolveOutputPath } from './paths.js';
import { isPlatform, platforms, type CanonicalAgent, type CanonicalSkill, type Diagnostic, type OpenCodeMode, type OutputFile, type Platform, type PlatformArg, type Scope, type SourceItem, type WritePlan } from './model.js';

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const platformKeys = new Set(['claude', 'opencode', 'codex']);
const allowedTopLevel = new Set(['name', 'description', 'claude', 'opencode', 'codex']);
const allowedProductKeys = new Set(['permissions', 'model']);
const allowedOpenCodeKeys = new Set([...allowedProductKeys, 'mode']);
const openCodeModes = new Set<OpenCodeMode>(['primary', 'subagent', 'all']);

export type ProcessOptions = { source: string; platform: PlatformArg; scope: Scope; cwd?: string; home?: string; checkCollisions?: boolean; force?: boolean };

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
  const agents: CanonicalAgent[] = [];
  const skills: CanonicalSkill[] = [];
  const seenAgents = new Set<string>();
  const seenSkills = new Set<string>();
  for (const source of sources) {
    const converted = convertSource(source, options.source);
    diagnostics.push(...converted.diagnostics);
    if (!converted.item) continue;
    const seen = source.kind === 'agent' ? seenAgents : seenSkills;
    if (seen.has(converted.item.name)) {
      diagnostics.push(diagnostic('error', 'DUPLICATE_NAME', `Duplicate ${source.kind} name ${converted.item.name}`, { sourcePath: source.sourcePath }));
      continue;
    }
    seen.add(converted.item.name);
    if (source.kind === 'agent') agents.push(converted.item as CanonicalAgent);
    else skills.push(converted.item as CanonicalSkill);
  }
  const files: OutputFile[] = [];
  if (!diagnostics.some((item) => item.severity === 'error')) {
    for (const platform of resolvePlatforms(options.platform)) {
      for (const agent of agents) files.push(renderFile(platform, 'agent', agent, options, diagnostics));
      for (const skill of skills) files.push(renderFile(platform, 'skill', skill, options, diagnostics));
    }
    files.sort((a, b) => `${a.platform}:${a.kind}:${a.name}`.localeCompare(`${b.platform}:${b.kind}:${b.name}`));
    if (options.checkCollisions) diagnostics.push(...await collisionDiagnostics(files, Boolean(options.force)));
  }
  return { files, diagnostics, sourceCount: sources.length };
}

function convertSource(source: SourceItem, sourceRoot: string): { item?: CanonicalAgent | CanonicalSkill; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const data = source.data;
  const name = typeof data.name === 'string' ? data.name : undefined;
  const description = typeof data.description === 'string' ? data.description : undefined;
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
    for (const key of Object.keys(config as Record<string, unknown>)) {
      const allowedKeys = platform === 'opencode' && source.kind === 'agent' ? allowedOpenCodeKeys : allowedProductKeys;
      if (!allowedKeys.has(key)) diagnostics.push(diagnostic('error', 'UNSUPPORTED_PLATFORM_FIELD', `${platform}.${key} is not supported in the MVP`, { sourcePath: source.sourcePath, platform: platform as Platform }));
    }
    if ('model' in config && typeof (config as Record<string, unknown>).model !== 'string') {
      diagnostics.push(diagnostic('error', 'INVALID_PLATFORM_MODEL', `${platform}.model must be a string`, { sourcePath: source.sourcePath, platform: platform as Platform }));
    }
    if (platform === 'opencode' && source.kind === 'agent' && 'mode' in config && !openCodeModes.has((config as Record<string, unknown>).mode as OpenCodeMode)) {
      diagnostics.push(diagnostic('error', 'INVALID_OPENCODE_MODE', 'opencode.mode must be one of primary, subagent, all', { sourcePath: source.sourcePath, platform: 'opencode' }));
    }
  }
  if (!name) diagnostics.push(diagnostic('error', 'MISSING_NAME', `${source.kind} name is required`, { sourcePath: source.sourcePath }));
  if (name && !namePattern.test(name)) diagnostics.push(diagnostic('error', 'INVALID_NAME', `${source.kind} name must be kebab-case`, { sourcePath: source.sourcePath }));
  if (name && name !== source.expectedName) diagnostics.push(diagnostic('error', 'NAME_MISMATCH', `${source.kind} name must match ${source.expectedName}`, { sourcePath: source.sourcePath }));
  if (!description) diagnostics.push(diagnostic('error', 'MISSING_DESCRIPTION', `${source.kind} description is required`, { sourcePath: source.sourcePath }));
  if (!source.body.trim()) diagnostics.push(diagnostic('error', 'EMPTY_BODY', `${source.kind} body is required`, { sourcePath: source.sourcePath }));
  if (!name || !description || !source.body.trim() || diagnostics.some((item) => item.severity === 'error')) return { diagnostics };
  const base = { name, description, sourcePath: path.relative(path.resolve(sourceRoot), source.sourcePath), claude: productConfig(data.claude), opencode: productConfig(data.opencode), codex: productConfig(data.codex) };
  return { diagnostics, item: source.kind === 'agent' ? { ...base, definition: source.body } : { ...base, instructions: source.body } };
}

function productConfig(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as { permissions?: unknown; model?: string; mode?: OpenCodeMode } : undefined;
}

function renderFile(platform: Platform, kind: 'agent' | 'skill', item: CanonicalAgent | CanonicalSkill, options: ProcessOptions, diagnostics: Diagnostic[]): OutputFile {
  const rendered = kind === 'agent'
    ? platform === 'opencode' ? renderOpenCodeAgent(item as CanonicalAgent) : platform === 'claude' ? renderClaudeAgent(item as CanonicalAgent) : renderCodexAgent(item as CanonicalAgent)
    : platform === 'opencode' ? renderOpenCodeSkill(item as CanonicalSkill) : platform === 'claude' ? renderClaudeSkill(item as CanonicalSkill) : renderCodexSkill(item as CanonicalSkill);
  diagnostics.push(...rendered.diagnostics);
  return { platform, kind, scope: options.scope, name: item.name, sourcePath: (item as { sourcePath?: string }).sourcePath ?? '', path: resolveOutputPath(platform, kind, options.scope, item.name, options.cwd, options.home), content: rendered.content };
}

async function collisionDiagnostics(files: OutputFile[], force: boolean): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    try {
      await access(file.path, constants.F_OK);
      diagnostics.push(diagnostic(force ? 'warning' : 'error', force ? 'OVERWRITE_FORCED' : 'DESTINATION_EXISTS', force ? `--force will overwrite ${file.path}` : `Destination exists; use --force to overwrite ${file.path}`, { platform: file.platform }));
    } catch {
      // Missing destination is safe.
    }
  }
  return diagnostics;
}
