export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const toolNamePattern = /^[A-Za-z0-9_*-]+$/;
const patternBodyPattern = /^[^,\n]+$/;

export function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && toolNamePattern.test(item)) ? value : undefined;
}

export function patternList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0 && patternBodyPattern.test(item)) ? value : undefined;
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}
