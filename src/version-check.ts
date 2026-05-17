import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REGISTRY_URL = 'https://registry.npmjs.org/@guidobuilds/forge-ai/latest';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 1500;

export type VersionCheckResult = {
  current: string;
  latest: string;
  isOutdated: boolean;
};

export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export type VersionCheckOptions = {
  current: string;
  cachePath: string;
  ttlMs?: number;
  now?: Date;
  fetcher?: Fetcher;
  registryUrl?: string;
  timeoutMs?: number;
};

export async function checkLatestVersion(options: VersionCheckOptions): Promise<VersionCheckResult | undefined> {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? new Date();
  const cached = await readCache(options.cachePath);
  if (cached && now.getTime() - new Date(cached.checkedAt).getTime() < ttl) {
    return makeResult(options.current, cached.latest);
  }
  const fetched = await fetchLatest(options.registryUrl ?? REGISTRY_URL, options.fetcher ?? fetch, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  if (fetched === undefined) return cached ? makeResult(options.current, cached.latest) : undefined;
  await writeCache(options.cachePath, { checkedAt: now.toISOString(), latest: fetched });
  return makeResult(options.current, fetched);
}

export function formatVersionNotice(result: VersionCheckResult): string {
  if (!result.isOutdated) return '';
  return `forge-ai v${result.current} (v${result.latest} available — run \`forge-ai self-update\` to upgrade)`;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((part) => parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function makeResult(current: string, latest: string): VersionCheckResult {
  return { current, latest, isOutdated: compareSemver(current, latest) < 0 };
}

async function fetchLatest(url: string, fetcher: Fetcher, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    const json = await response.json() as { version?: unknown };
    return typeof json.version === 'string' ? json.version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(cachePath: string): Promise<{ checkedAt: string; latest: string } | undefined> {
  try {
    const content = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.checkedAt === 'string' && typeof parsed.latest === 'string') {
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    }
  } catch {
    // Cache missing or malformed; treat as no cache.
  }
  return undefined;
}

async function writeCache(cachePath: string, data: { checkedAt: string; latest: string }): Promise<void> {
  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(data)}\n`, 'utf8');
  } catch {
    // Cache write failures are non-fatal.
  }
}
