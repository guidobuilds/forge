import { stringifyYaml } from '../frontmatter.js';
import type { CanonicalArtifact, Diagnostic } from '../model.js';
import { diagnostic } from '../diagnostics.js';

export function renderOpenCodeAgent(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const fm: Record<string, unknown> = { description: artifact.description };
  if (artifact.opencode?.mode) fm.mode = artifact.opencode.mode;
  if (artifact.opencode?.model) fm.model = artifact.opencode.model;
  if (artifact.opencode?.permissions) fm.permission = artifact.opencode.permissions;
  return { content: `${stringifyYaml(fm)}${artifact.body}\n`, diagnostics: [] };
}

export function renderOpenCodeSkill(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (artifact.opencode?.permissions) diagnostics.push(diagnostic('info', 'OPENCODE_SKILL_PERMISSIONS_IGNORED', `OpenCode skill permissions are not emitted for ${artifact.name}`, { platform: 'opencode' }));
  if (artifact.opencode?.model) diagnostics.push(diagnostic('info', 'OPENCODE_SKILL_MODEL_IGNORED', `OpenCode skill model is not emitted for ${artifact.name}`, { platform: 'opencode' }));
  return { content: `${stringifyYaml({ name: artifact.name, description: artifact.description })}${artifact.body}\n`, diagnostics };
}
