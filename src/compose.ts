import type { Platform } from './model.js';
import { resolveSnippet } from './dispatch-snippets.js';

// A `{{snippet:id}}` that is the entire content of its line is removed as a whole line when it
// resolves to '' (e.g. a Codex-only bullet in a shared list), instead of leaving a blank line.
const wholeLineSnippet = /^[ \t]*\{\{snippet:([a-z0-9-]+)\}\}[ \t]*\n?/gm;
const inlineSnippet = /\{\{snippet:([a-z0-9-]+)\}\}/g;

export function composeBody(body: string, platform: Platform): string {
  const withWholeLines = body.replace(wholeLineSnippet, (_match, id: string) => {
    const text = resolveSnippet(id, platform);
    return text === '' ? '' : `${text}\n`;
  });
  return withWholeLines.replace(inlineSnippet, (_match, id: string) => resolveSnippet(id, platform));
}
