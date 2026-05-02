import { stringifyYaml } from '../frontmatter.js';
import type { CanonicalAgent, CanonicalSkill, Diagnostic } from '../model.js';
import { diagnostic } from '../diagnostics.js';
import { isRecord, stringList } from './shared.js';

export function renderClaudeAgent(agent: CanonicalAgent): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fm: Record<string, unknown> = { name: agent.name, description: agent.description };
  if (agent.claude?.model) fm.model = agent.claude.model;
  const permissions = agent.claude?.permissions;
  const tools = isRecord(permissions) ? stringList(permissions.tools) : stringList(permissions);
  if (tools) fm.tools = tools;
  else if (permissions !== undefined) diagnostics.push(diagnostic('info', 'CLAUDE_AGENT_TOOLS_IGNORED', `Claude agent permissions must be a tools string list for ${agent.name}`, { platform: 'claude' }));
  return { content: `${stringifyYaml(fm)}${agent.definition}\n`, diagnostics };
}

export function renderClaudeSkill(skill: CanonicalSkill): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fm: Record<string, unknown> = { name: skill.name, description: skill.description };
  const permissions = skill.claude?.permissions;
  const allowedTools = isRecord(permissions) ? stringList(permissions['allowed-tools']) : undefined;
  if (allowedTools) {
    fm['allowed-tools'] = allowedTools;
    diagnostics.push(diagnostic('warning', 'CLAUDE_SKILL_ALLOWED_TOOLS', `Claude skill allowed-tools preapproves tools but does not universally restrict them for ${skill.name}`, { platform: 'claude' }));
  } else if (permissions !== undefined) {
    diagnostics.push(diagnostic('info', 'CLAUDE_SKILL_PERMISSIONS_IGNORED', `Claude skill permissions are not emitted for ${skill.name}`, { platform: 'claude' }));
  }
  if (skill.claude?.model) diagnostics.push(diagnostic('info', 'CLAUDE_SKILL_MODEL_IGNORED', `Claude skill model is not emitted for ${skill.name}`, { platform: 'claude' }));
  return { content: `${stringifyYaml(fm)}${skill.instructions}\n`, diagnostics };
}
