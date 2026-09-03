import { agentAllowlistPattern } from './claude-known.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const toolNamePattern = /^[A-Za-z0-9_*-]+$/;
const patternBodyPattern = /^[^,\n]+$/;

export function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && (toolNamePattern.test(item) || agentAllowlistPattern.test(item))) ? value : undefined;
}

export function patternList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0 && patternBodyPattern.test(item)) ? value : undefined;
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

const OPENCODE_PERMISSION_VALUES = new Set(['allow', 'deny', 'ask']);
const OPENCODE_PERMISSIONS_MAX_KEYS = 64;

export function isOpenCodePermissions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > OPENCODE_PERMISSIONS_MAX_KEYS) return false;
  return keys.every((key) => {
    const v = (value as Record<string, unknown>)[key];
    return v === true || v === false || (typeof v === 'string' && OPENCODE_PERMISSION_VALUES.has(v));
  });
}
