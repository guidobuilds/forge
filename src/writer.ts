import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OutputFile } from './model.js';

export async function writeOutputs(files: OutputFile[]): Promise<void> {
  for (const file of files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf8');
  }
}
