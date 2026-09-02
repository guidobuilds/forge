import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManifestLocation } from './manifest.js';
import type { Platform } from './model.js';

// Keyed platform -> canonical artifact name -> model id. A flat `Record<name, model>` cannot
// express this: model ids are not portable across platforms (`opus` means nothing to Grok), and
// `--platform all` is the default install, so per-platform is not an edge case.
export type ModelPreferences = Partial<Record<Platform, Record<string, string>>>;

// Lives beside the manifest, not inside it: ManifestEntry is rebuilt from scratch on every
// install/update run (see buildManifest), so a model choice stored there would be silently lost
// on the next run. This file is read-modified-written independently and merged into the render
// pipeline as an override, never derived from the manifest.
export function modelPreferencesPath(location: ManifestLocation): string {
  const filename = location.scope === 'user' ? 'user-model-preferences.json' : 'model-preferences.json';
  return path.join(path.dirname(location.manifestPath), filename);
}

export async function loadModelPreferences(prefsPath: string): Promise<ModelPreferences> {
  try {
    return JSON.parse(await readFile(prefsPath, 'utf8')) as ModelPreferences;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveModelPreferences(prefsPath: string, prefs: ModelPreferences): Promise<void> {
  await mkdir(path.dirname(prefsPath), { recursive: true });
  await writeFile(prefsPath, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
}

export function setModelPreference(prefs: ModelPreferences, platform: Platform, name: string, model: string): ModelPreferences {
  return { ...prefs, [platform]: { ...prefs[platform], [name]: model } };
}

export function getModelPreference(prefs: ModelPreferences, platform: Platform, name: string): string | undefined {
  return prefs[platform]?.[name];
}
