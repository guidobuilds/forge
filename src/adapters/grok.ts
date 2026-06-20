import { stringifyYaml } from '../frontmatter.js';
import type { CanonicalArtifact, Diagnostic } from '../model.js';
import { diagnostic } from '../diagnostics.js';
import { isKnownGrokModel, isKnownGrokTool } from './grok-known.js';
import { isRecord, patternList, stringList } from './shared.js';

export function renderGrokAgent(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fm: Record<string, unknown> = { name: artifact.name, description: artifact.description };
  if (artifact.grok?.model) {
    fm.model = artifact.grok.model;
    if (!isKnownGrokModel(artifact.grok.model)) {
      diagnostics.push(diagnostic('warning', 'GROK_UNKNOWN_MODEL', `Unknown Grok model "${artifact.grok.model}" for ${artifact.name}`, { platform: 'grok' }));
    }
  }
  const permissions = artifact.grok?.permissions;
  const tools = isRecord(permissions) ? stringList(permissions.tools) : stringList(permissions);
  if (tools) {
    fm.tools = tools; // YAML sequence — Grok expects tools as a list, not comma-joined
    for (const tool of tools) {
      if (!isKnownGrokTool(tool)) {
        diagnostics.push(diagnostic('warning', 'GROK_UNKNOWN_TOOL', `Unknown Grok tool "${tool}" for ${artifact.name}`, { platform: 'grok' }));
      }
    }
  } else if (permissions !== undefined) {
    diagnostics.push(diagnostic('info', 'GROK_AGENT_TOOLS_IGNORED', `Grok agent permissions must be a tools string list for ${artifact.name}`, { platform: 'grok' }));
  }
  const disallowedTools = isRecord(permissions) ? patternList(permissions['disallowedTools']) : undefined;
  if (disallowedTools) fm.disallowedTools = disallowedTools;
  return { content: `${stringifyYaml(fm)}${artifact.body}\n`, diagnostics };
}

export function renderGrokSkill(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (artifact.grok?.permissions !== undefined) {
    diagnostics.push(diagnostic('info', 'GROK_SKILL_PERMISSIONS_IGNORED', `Grok skill permissions are not emitted for ${artifact.name}`, { platform: 'grok' }));
  }
  if (artifact.grok?.model) {
    diagnostics.push(diagnostic('info', 'GROK_SKILL_MODEL_IGNORED', `Grok skill model is not emitted for ${artifact.name}`, { platform: 'grok' }));
  }
  return { content: `${stringifyYaml({ name: artifact.name, description: artifact.description })}${artifact.body}\n`, diagnostics };
}
