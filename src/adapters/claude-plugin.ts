import { discoverArtifacts } from '../processor.js';
import type { Diagnostic, PluginFile } from '../model.js';
import { renderClaudeAgent, renderClaudeSkill } from './claude.js';

// Namespaces both agent-dispatch (subagent_type) and skill-load (Skill tool) cross-references to
// their plugin-qualified form. Agent dispatch is NAMESPACE-REQUIRED and skill load is BARE-WORKS
// only in the absence of a same-named collision from another installed source (see f0's spike and
// the f1 adversarial verify finding in verification.md: a pre-existing CLI-push install of
// using-forge/forge-grill under the same bare names silently wins a same-named Skill-tool
// resolution on the affected machine). Namespacing both categories the same way keeps one uniform
// mechanism instead of a second special case.
//
// Longest-alternative-first ordering (forge-worker-leaf before forge-worker) is required so the
// regex engine matches the full literal `forge-worker-leaf` token before it could fall through to
// the shorter `forge-worker` alternative — this avoids double-tagging embedded occurrences. The
// two skill-load tokens (using-forge, forge-grill) do not share a prefix with any other token in
// the list (nor with each other), so their position in the alternation does not affect matching;
// they are listed after the agent-dispatch tokens for readability only.
const PLUGIN_CROSS_REFERENCE_TOKENS = /(?<!forge:)\b(forge-worker-leaf|forge-worker|forge-adversary|using-forge|forge-grill)\b/g;

export function rewritePluginCrossReferences(body: string): string {
  return body.replace(PLUGIN_CROSS_REFERENCE_TOKENS, (match) => `forge:${match}`);
}

export async function buildClaudePluginPackage(source: string, version: string, license: string): Promise<{ files: PluginFile[]; diagnostics: Diagnostic[] }> {
  const { artifacts, diagnostics } = await discoverArtifacts(source);
  const files: PluginFile[] = [];
  for (const artifact of artifacts) {
    const effectiveKind = artifact.claude?.kind ?? artifact.kind;
    const rewritten = { ...artifact, body: rewritePluginCrossReferences(artifact.body) };
    const rendered = effectiveKind === 'agent' ? renderClaudeAgent(rewritten) : renderClaudeSkill(rewritten);
    diagnostics.push(...rendered.diagnostics);
    const relativePath = effectiveKind === 'agent' ? `agents/${artifact.name}.md` : `skills/${artifact.name}/SKILL.md`;
    files.push({ relativePath, content: rendered.content });
  }
  files.push({
    relativePath: '.claude-plugin/plugin.json',
    content: `${JSON.stringify(
      {
        name: 'forge',
        version,
        description: 'Forge: a thin orchestrator with delegated workers, plans, and adversarial verification.',
        author: { name: 'Guido Caffa' },
        license
      },
      null,
      2
    )}\n`
  });
  return { files, diagnostics };
}
