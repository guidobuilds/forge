import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import type { Diagnostic, SourceItem } from './model.js';
import { diagnostic } from './diagnostics.js';

export async function discoverSources(source: string): Promise<{ sources: SourceItem[]; diagnostics: Diagnostic[] }> {
  const root = path.resolve(source);
  const sources: SourceItem[] = [];
  const diagnostics: Diagnostic[] = [];
  await discoverAgents(root, sources, diagnostics);
  await discoverSkills(root, sources, diagnostics);
  if (sources.length === 0) diagnostics.push(diagnostic('error', 'NO_SOURCES', 'No canonical agents or skills found', { sourcePath: root }));
  sources.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return { sources, diagnostics };
}

async function discoverAgents(root: string, sources: SourceItem[], diagnostics: Diagnostic[]): Promise<void> {
  const dir = path.join(root, 'agents');
  for (const entry of await safeReaddir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const sourcePath = path.join(dir, entry.name);
    await readSource('agent', sourcePath, path.basename(entry.name, '.md'), sources, diagnostics);
  }
}

async function discoverSkills(root: string, sources: SourceItem[], diagnostics: Diagnostic[]): Promise<void> {
  const dir = path.join(root, 'skills');
  for (const entry of await safeReaddir(dir)) {
    if (!entry.isDirectory()) continue;
    const sourcePath = path.join(dir, entry.name, 'SKILL.md');
    await readSource('skill', sourcePath, entry.name, sources, diagnostics);
  }
}

async function readSource(kind: SourceItem['kind'], sourcePath: string, expectedName: string, sources: SourceItem[], diagnostics: Diagnostic[]): Promise<void> {
  try {
    const parsed = parseFrontmatter(await readFile(sourcePath, 'utf8'));
    sources.push({ kind, sourcePath, expectedName, data: parsed.data, body: parsed.body });
  } catch (error) {
    diagnostics.push(diagnostic('error', 'PARSE_ERROR', error instanceof Error ? error.message : String(error), { sourcePath }));
  }
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
