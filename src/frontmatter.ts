type Parsed = { data: Record<string, unknown>; body: string };

export function parseFrontmatter(content: string): Parsed {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized.trim() };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) throw new Error('Missing closing frontmatter delimiter');
  const rawYaml = normalized.slice(4, end);
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1).trim();
  return { data: parseSimpleYaml(rawYaml), body };
}

export function parseSimpleYaml(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; object: Record<string, unknown> }> = [{ indent: -1, object: root }];
  const lines = input.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    const trimmed = raw.trim();
    const match = trimmed.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) throw new Error(`Invalid YAML at line ${index + 1}`);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].object;
    const key = match[1];
    const value = match[2] ?? '';
    if (value === '') {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, object: child });
    } else {
      parent[key] = parseScalar(value);
    }
  }
  return root;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => String(parseScalar(item.trim())));
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function stringifyYaml(data: Record<string, unknown>): string {
  const lines = Object.entries(data).flatMap(([key, value]) => stringifyYamlValue(key, value, 0));
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function stringifyYamlValue(key: string, value: unknown, indent: number): string[] {
  const prefix = ' '.repeat(indent);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return [`${prefix}${key}:`, ...Object.entries(value as Record<string, unknown>).flatMap(([childKey, childValue]) => stringifyYamlValue(childKey, childValue, indent + 2))];
  }
  if (Array.isArray(value)) return [`${prefix}${key}: [${value.map(formatScalar).join(', ')}]`];
  return [`${prefix}${key}: ${formatScalar(value)}`];
}

function formatScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const text = String(value ?? '');
  return /^[A-Za-z0-9_./,@* -]+$/.test(text) && text !== '' ? text : JSON.stringify(text);
}
