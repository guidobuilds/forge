import { stringifyYaml } from '../frontmatter.js';
import type { CanonicalAgent, CanonicalSkill, Diagnostic } from '../model.js';
import { diagnostic } from '../diagnostics.js';
import { isRecord, tomlString } from './shared.js';

const safeSandboxModes = new Set(['read-only', 'workspace-write']);

export function renderCodexAgent(agent: CanonicalAgent): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [diagnostic('info', 'CODEX_PARTIAL_AGENT_SUPPORT', `Codex agent output is partial and does not generate AGENTS.md or profiles for ${agent.name}`, { platform: 'codex' })];
  const lines = [`name = ${tomlString(agent.name)}`, `description = ${tomlString(agent.description)}`, `developer_instructions = ${tomlString(agent.definition)}`];
  if (agent.codex?.model) lines.push(`model = ${tomlString(agent.codex.model)}`);
  const permissions = agent.codex?.permissions;
  if (isRecord(permissions) && typeof permissions.sandbox_mode === 'string') {
    if (safeSandboxModes.has(permissions.sandbox_mode)) lines.push(`sandbox_mode = ${tomlString(permissions.sandbox_mode)}`);
    else diagnostics.push(diagnostic('warning', 'CODEX_UNSAFE_SANDBOX_IGNORED', `Unsafe Codex sandbox_mode ignored for ${agent.name}`, { platform: 'codex' }));
  } else if (permissions !== undefined) {
    diagnostics.push(diagnostic('info', 'CODEX_AGENT_PERMISSIONS_IGNORED', `Codex agent permissions are not emitted for ${agent.name}`, { platform: 'codex' }));
  }
  return { content: `${lines.join('\n')}\n`, diagnostics };
}

export function renderCodexSkill(skill: CanonicalSkill): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (skill.codex?.permissions) diagnostics.push(diagnostic('info', 'CODEX_SKILL_PERMISSIONS_IGNORED', `Codex skill permissions are not emitted for ${skill.name}`, { platform: 'codex' }));
  if (skill.codex?.model) diagnostics.push(diagnostic('info', 'CODEX_SKILL_MODEL_IGNORED', `Codex skill model is not emitted for ${skill.name}`, { platform: 'codex' }));
  return { content: `${stringifyYaml({ name: skill.name, description: skill.description })}${skill.instructions}\n`, diagnostics };
}
