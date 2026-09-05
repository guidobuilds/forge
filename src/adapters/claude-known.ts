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
  'Agent',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'ExitPlanMode',
  'Skill'
]);

const mcpToolPattern = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_*-]+$/;
// `Agent(name, name2)` restricts which subagent types an agent running as the main
// session (via --agent/settings.json) is allowed to spawn — see sub-agents.md.
export const agentAllowlistPattern = /^Agent\([A-Za-z0-9_-]+(?:,\s*[A-Za-z0-9_-]+)*\)$/;

export function isKnownClaudeTool(name: string): boolean {
  return knownClaudeTools.has(name) || mcpToolPattern.test(name) || agentAllowlistPattern.test(name);
}

// Claude Code has NO CLI model-enumeration command: `claude --help` exposes only `--model` /
// `--fallback-model` flags and a non-scriptable in-TUI `/model`. There is no `claude models` /
// `claude list`. So `discoverClaudeModels` always returns undefined (see src/model-discovery.ts) and
// the model-choice funnel always falls back to this curated set plus the free-text `Custom…` escape —
// never an empty/spurious list. Do NOT add a fake dynamic source here; the `discoverModels` dispatch
// keeps a `claude` branch so a real source could be added later without touching callers.
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
