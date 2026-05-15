import { stringifyYaml } from '../frontmatter.js';
import type { CanonicalArtifact, Diagnostic } from '../model.js';
import { diagnostic } from '../diagnostics.js';
import { isRecord, tomlString } from './shared.js';

const safeSandboxModes = new Set(['read-only', 'workspace-write']);

export function renderCodexAgent(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [diagnostic('info', 'CODEX_PARTIAL_AGENT_SUPPORT', `Codex agent output is partial and does not generate AGENTS.md or profiles for ${artifact.name}`, { platform: 'codex' })];
  const lines = [`name = ${tomlString(artifact.name)}`, `description = ${tomlString(artifact.description)}`, `developer_instructions = ${tomlString(artifact.body)}`];
  if (artifact.codex?.model) lines.push(`model = ${tomlString(artifact.codex.model)}`);
  const permissions = artifact.codex?.permissions;
  if (isRecord(permissions) && typeof permissions.sandbox_mode === 'string') {
    if (safeSandboxModes.has(permissions.sandbox_mode)) lines.push(`sandbox_mode = ${tomlString(permissions.sandbox_mode)}`);
    else diagnostics.push(diagnostic('warning', 'CODEX_UNSAFE_SANDBOX_IGNORED', `Unsafe Codex sandbox_mode ignored for ${artifact.name}`, { platform: 'codex' }));
  } else if (permissions !== undefined) {
    diagnostics.push(diagnostic('info', 'CODEX_AGENT_PERMISSIONS_IGNORED', `Codex agent permissions are not emitted for ${artifact.name}`, { platform: 'codex' }));
  }
  return { content: `${lines.join('\n')}\n`, diagnostics };
}

export function renderCodexSkill(artifact: CanonicalArtifact): { content: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (artifact.codex?.permissions) diagnostics.push(diagnostic('info', 'CODEX_SKILL_PERMISSIONS_IGNORED', `Codex skill permissions are not emitted for ${artifact.name}`, { platform: 'codex' }));
  if (artifact.codex?.model) diagnostics.push(diagnostic('info', 'CODEX_SKILL_MODEL_IGNORED', `Codex skill model is not emitted for ${artifact.name}`, { platform: 'codex' }));
  return { content: `${stringifyYaml({ name: artifact.name, description: artifact.description })}${artifact.body}\n`, diagnostics };
}
