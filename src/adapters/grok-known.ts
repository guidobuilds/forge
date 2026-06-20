// Canonical tool names used in Grok Build agent-profile frontmatter (tools: / disallowedTools: fields).
// The CLI --tools/--disallowed-tools flags use shorter aliases (e.g. "grep" for grep_search,
// "bash" for run_terminal_cmd). Both forms are accepted here to avoid spurious warnings.
export const knownGrokTools = new Set<string>([
  'read_file',
  'search_replace',
  'grep_search',
  'grep', // CLI alias for grep_search
  'list_dir',
  'run_terminal_cmd',
  'bash', // display alias for run_terminal_cmd
  'web_search',
  'web_fetch',
  'todo_write',
  'task',
  'kill_task',
  'get_task_output',
  'memory_search',
  'memory_get',
  'search_tool',
  'use_tool',
  'lsp'
]);

export function isKnownGrokTool(name: string): boolean {
  return knownGrokTools.has(name);
}

export const knownGrokModels = new Set<string>([
  'inherit',
  'grok-build',
  'grok-build-plan',
  'grok-composer-2.5-fast'
]);

const grokVersionedModelPattern = /^grok-[a-z0-9.-]+$/;
const gatewayModelPattern = /^[a-z0-9-]+\/[a-z0-9.-]+$/;

export function isKnownGrokModel(value: string): boolean {
  return knownGrokModels.has(value) || grokVersionedModelPattern.test(value) || gatewayModelPattern.test(value);
}
