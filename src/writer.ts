import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backupFile, sha256 } from './manifest.js';
import type { OutputFile } from './model.js';

export async function writeOutputs(files: OutputFile[]): Promise<void> {
  for (const file of files) {
    let existing: string | undefined;
    if (file.expectedChecksum || file.backupPath) {
      try {
        existing = await readFile(file.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (file.expectedChecksum && existing !== undefined && sha256(existing) !== file.expectedChecksum) {
      throw new Error(`File ${file.path} changed after classification; aborting to avoid overwriting recent edits.`);
    }
    if (file.backupPath && existing !== undefined) {
      await backupFile(file.backupPath, existing);
    }
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf8');
  }
}
