import { stringifyYaml } from '../frontmatter.js';
import type { CanonicalArtifact, Diagnostic } from '../model.js';
import { diagnostic } from '../diagnostics.js';
import { isKnownOpenCodeModel } from './opencode-known.js';
import { isOpenCodePermissions } from './shared.js';

export function renderOpenCodeAgent(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fm: Record<string, unknown> = { description: artifact.description };
  if (artifact.opencode?.mode) fm.mode = artifact.opencode.mode;
  if (artifact.opencode?.model) {
    fm.model = artifact.opencode.model;
    if (!isKnownOpenCodeModel(artifact.opencode.model)) {
      diagnostics.push(diagnostic('warning', 'OPENCODE_UNKNOWN_MODEL', `Unknown OpenCode model "${artifact.opencode.model}" for ${artifact.name}`, { platform: 'opencode' }));
    }
  }
  if (artifact.opencode?.permissions) {
    if (isOpenCodePermissions(artifact.opencode.permissions)) {
      fm.permission = artifact.opencode.permissions;
    } else {
      diagnostics.push(diagnostic('warning', 'OPENCODE_INVALID_PERMISSIONS', `opencode.permissions for ${artifact.name} is not a flat allow/deny/ask object (≤ 64 scalar-valued keys); the block was not emitted`, { platform: 'opencode' }));
    }
  }
  return { content: `${stringifyYaml(fm)}${artifact.body}\n`, diagnostics };
}

export function renderOpenCodeSkill(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (artifact.opencode?.permissions) diagnostics.push(diagnostic('info', 'OPENCODE_SKILL_PERMISSIONS_IGNORED', `OpenCode skill permissions are not emitted for ${artifact.name}`, { platform: 'opencode' }));
  if (artifact.opencode?.model) diagnostics.push(diagnostic('info', 'OPENCODE_SKILL_MODEL_IGNORED', `OpenCode skill model is not emitted for ${artifact.name}`, { platform: 'opencode' }));
  if (artifact.claude?.['user-invocable'] === false) {
    diagnostics.push(diagnostic('warning', 'OPENCODE_SKILL_DISCOVERABLE_UNENFORCED', `${artifact.name} is meant to be background-only, but OpenCode has no mechanism to hide a skill from direct invocation — it will be directly invocable here`, { platform: 'opencode' }));
  }
  return { content: `${stringifyYaml({ name: artifact.name, description: artifact.description })}${artifact.body}\n`, diagnostics };
}
