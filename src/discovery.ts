import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import type { Diagnostic, SourceItem } from './model.js';
import { diagnostic } from './diagnostics.js';

export async function discoverSources(source: string): Promise<{ sources: SourceItem[]; diagnostics: Diagnostic[] }> {
  const root = path.resolve(source);
  const sources: SourceItem[] = [];
  const diagnostics: Diagnostic[] = [];
  await discoverArtifacts(root, sources, diagnostics);
  if (sources.length === 0) diagnostics.push(diagnostic('error', 'NO_SOURCES', 'No canonical artifacts found', { sourcePath: root }));
  sources.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return { sources, diagnostics };
}

async function discoverArtifacts(root: string, sources: SourceItem[], diagnostics: Diagnostic[]): Promise<void> {
  const dir = path.join(root, 'artifacts');
  for (const entry of await safeReaddir(dir)) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const artifactDir = path.join(dir, name);
    const mainFile = `${name}.md`;
    const supportFiles = (await safeReaddir(artifactDir))
      .filter((file) => file.isFile() && file.name !== mainFile)
      .map((file) => path.join(artifactDir, file.name));
    await readSource(path.join(artifactDir, mainFile), name, supportFiles, sources, diagnostics);
  }
}

async function readSource(sourcePath: string, expectedName: string, supportFiles: string[], sources: SourceItem[], diagnostics: Diagnostic[]): Promise<void> {
  try {
    const parsed = parseFrontmatter(await readFile(sourcePath, 'utf8'));
    sources.push({ sourcePath, expectedName, data: parsed.data, body: parsed.body, supportFiles: supportFiles.length > 0 ? supportFiles : undefined });
    if (supportFiles.length > 0) {
      diagnostics.push(diagnostic('info', 'SUPPORT_FILES_NOT_COPIED', `Support files alongside ${expectedName} are not copied yet`, { sourcePath }));
    }
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
