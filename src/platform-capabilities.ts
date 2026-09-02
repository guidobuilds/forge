import type { Platform, SourceKind } from './model.js';

export type PlatformCapabilities = {
  supportsAgentSpawn: boolean;
  spawnToolName?: string;
};

// Verified per-platform dispatch capability (see .forge/harness-agnostic-adapters/decisions.md).
// Codex's CLI-installed agents have no spawn tool wired; the coordinator returns DELEGATION_REQUESTS
// for the orchestrator to fan out instead of self-spawning.
export const PLATFORM_CAPABILITIES: Record<Platform, PlatformCapabilities> = {
  claude: { supportsAgentSpawn: true, spawnToolName: 'Agent' },
  grok: { supportsAgentSpawn: true, spawnToolName: 'task' },
  opencode: { supportsAgentSpawn: true, spawnToolName: 'task' },
  codex: { supportsAgentSpawn: false }
};

// Every platform's agent-kind renderer emits `model`. Only Claude's skill renderer does
// (renderClaudeSkill) — Grok/OpenCode/Codex skills silently discard it
// (GROK_SKILL_MODEL_IGNORED / OPENCODE_SKILL_MODEL_IGNORED / CODEX_SKILL_MODEL_IGNORED). Keyed on
// *effective* kind, not canonical kind, since effective kind is already per-platform
// (e.g. `forge` is kind: agent on Claude/OpenCode/Codex but kind: skill on Grok).
export function supportsModel(platform: Platform, effectiveKind: SourceKind): boolean {
  return effectiveKind === 'agent' || platform === 'claude';
}
