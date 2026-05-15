import { stringifyYaml } from '../frontmatter.js';
import type { CanonicalArtifact, Diagnostic } from '../model.js';
import { diagnostic } from '../diagnostics.js';
import { isKnownClaudeModel, isKnownClaudeTool } from './claude-known.js';
import { isRecord, patternList, stringList } from './shared.js';

export function renderClaudeAgent(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fm: Record<string, unknown> = { name: artifact.name, description: artifact.description };
  if (artifact.claude?.model) {
    fm.model = artifact.claude.model;
    if (!isKnownClaudeModel(artifact.claude.model)) {
      diagnostics.push(diagnostic('warning', 'CLAUDE_UNKNOWN_MODEL', `Unknown Claude model "${artifact.claude.model}" for ${artifact.name}`, { platform: 'claude' }));
    }
  }
  const permissions = artifact.claude?.permissions;
  const tools = isRecord(permissions) ? stringList(permissions.tools) : stringList(permissions);
  if (tools) {
    fm.tools = tools.join(', ');
    for (const tool of tools) {
      if (!isKnownClaudeTool(tool)) {
        diagnostics.push(diagnostic('warning', 'CLAUDE_UNKNOWN_TOOL', `Unknown Claude tool "${tool}" for ${artifact.name}`, { platform: 'claude' }));
      }
    }
  } else if (permissions !== undefined) {
    diagnostics.push(diagnostic('info', 'CLAUDE_AGENT_TOOLS_IGNORED', `Claude agent permissions must be a tools string list for ${artifact.name}`, { platform: 'claude' }));
  }
  return { content: `${stringifyYaml(fm)}${artifact.body}\n`, diagnostics };
}

export function renderClaudeSkill(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fm: Record<string, unknown> = { name: artifact.name, description: artifact.description };
  const permissions = artifact.claude?.permissions;
  const allowedTools = isRecord(permissions) ? patternList(permissions['allowed-tools']) : undefined;
  if (allowedTools) {
    fm['allowed-tools'] = allowedTools.join(', ');
    diagnostics.push(diagnostic('warning', 'CLAUDE_SKILL_ALLOWED_TOOLS', `Claude skill allowed-tools preapproves tools but does not universally restrict them for ${artifact.name}`, { platform: 'claude' }));
  } else if (permissions !== undefined) {
    diagnostics.push(diagnostic('info', 'CLAUDE_SKILL_PERMISSIONS_IGNORED', `Claude skill permissions are not emitted for ${artifact.name}`, { platform: 'claude' }));
  }
  if (artifact.claude?.model) diagnostics.push(diagnostic('info', 'CLAUDE_SKILL_MODEL_IGNORED', `Claude skill model is not emitted for ${artifact.name}`, { platform: 'claude' }));
  return { content: `${stringifyYaml(fm)}${artifact.body}\n`, diagnostics };
}
