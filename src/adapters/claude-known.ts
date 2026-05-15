export const knownClaudeTools = new Set<string>([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'Glob',
  'Grep',
  'LS',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'ExitPlanMode'
]);

const mcpToolPattern = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_*-]+$/;

export function isKnownClaudeTool(name: string): boolean {
  return knownClaudeTools.has(name) || mcpToolPattern.test(name);
}

export const knownClaudeModels = new Set<string>([
  'sonnet',
  'opus',
  'haiku',
  'inherit'
]);

const versionedModelPattern = /^claude-(?:sonnet|opus|haiku)-[A-Za-z0-9.-]+$/;

export function isKnownClaudeModel(value: string): boolean {
  return knownClaudeModels.has(value) || versionedModelPattern.test(value);
}
