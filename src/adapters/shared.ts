export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && /^[A-Za-z0-9_*.,:-]+$/.test(item)) ? value : undefined;
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}
