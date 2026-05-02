import { stringifyYaml } from '../frontmatter.js';
import type { CanonicalAgent, CanonicalSkill, Diagnostic } from '../model.js';
import { diagnostic } from '../diagnostics.js';

export function renderOpenCodeAgent(agent: CanonicalAgent): { content: string; diagnostics: Diagnostic[] } {
  const fm: Record<string, unknown> = { description: agent.description };
  if (agent.opencode?.mode) fm.mode = agent.opencode.mode;
  if (agent.opencode?.model) fm.model = agent.opencode.model;
  if (agent.opencode?.permissions) fm.permission = agent.opencode.permissions;
  return { content: `${stringifyYaml(fm)}${agent.definition}\n`, diagnostics: [] };
}

export function renderOpenCodeSkill(skill: CanonicalSkill): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (skill.opencode?.permissions) diagnostics.push(diagnostic('info', 'OPENCODE_SKILL_PERMISSIONS_IGNORED', `OpenCode skill permissions are not emitted for ${skill.name}`, { platform: 'opencode' }));
  if (skill.opencode?.model) diagnostics.push(diagnostic('info', 'OPENCODE_SKILL_MODEL_IGNORED', `OpenCode skill model is not emitted for ${skill.name}`, { platform: 'opencode' }));
  return { content: `${stringifyYaml({ name: skill.name, description: skill.description })}${skill.instructions}\n`, diagnostics };
}
