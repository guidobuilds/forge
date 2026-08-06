import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backupFile } from './manifest.js';
import type { OutputFile, PluginFile } from './model.js';

export async function writeOutputs(files: OutputFile[]): Promise<void> {
  for (const file of files) {
    if (file.backupPath) {
      try {
        const existing = await readFile(file.path, 'utf8');
        await backupFile(file.backupPath, existing);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Original file disappeared between classification and write; no backup needed.
      }
    }
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf8');
  }
}

export async function writePluginFiles(outDir: string, files: PluginFile[]): Promise<void> {
  for (const file of files) {
    const target = path.join(outDir, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
}
