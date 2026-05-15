import { parse, stringify } from 'yaml';

type Parsed = { data: Record<string, unknown>; body: string };

export function parseFrontmatter(content: string): Parsed {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized.trim() };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) throw new Error('Missing closing frontmatter delimiter');
  const rawYaml = normalized.slice(4, end);
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1).trim();
  const parsed = rawYaml.trim() === '' ? {} : parse(rawYaml);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Frontmatter must be a YAML mapping');
  }
  return { data: parsed as Record<string, unknown>, body };
}

export function stringifyYaml(data: Record<string, unknown>): string {
  const yaml = stringify(data, { lineWidth: 0, defaultKeyType: 'PLAIN' });
  return `---\n${yaml}---\n\n`;
}
