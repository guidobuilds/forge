import { stringifyYaml } from '../frontmatter.js';
import { discoverArtifacts } from '../processor.js';
import type { CanonicalArtifact, Diagnostic, PluginFile } from '../model.js';

const referenceNames = new Map([
  ['using-forge', 'using-forge'],
  ['forge-worker', 'worker'],
  ['forge-worker-leaf', 'worker-leaf'],
  ['forge-adversary', 'adversary'],
  ['forge-grill', 'grill']
]);

function requiredArtifact(artifacts: CanonicalArtifact[], name: string, diagnostics: Diagnostic[]): CanonicalArtifact | undefined {
  const artifact = artifacts.find((candidate) => candidate.name === name);
  if (!artifact) {
    diagnostics.push({ severity: 'error', code: 'CODEX_PLUGIN_ARTIFACT_MISSING', message: `Codex plugin requires canonical artifact ${name}`, platform: 'codex' });
  }
  return artifact;
}

export function renderCodexPluginReference(artifact: CanonicalArtifact): string {
  let body = artifact.body.trim();
  if (artifact.name === 'forge-worker') {
    body = body
      .replace(/spawn `forge-worker-leaf` sub-agents/g, 'request root fan-out of worker-leaf sub-agents')
      .replace(/Spawn `forge-worker-leaf`/g, 'Request root fan-out of a worker-leaf')
      .replace(/Spawn forge-worker-leaf/g, 'Request root fan-out of worker-leaf')
      .replace(/spawn forge-worker-leaf/g, 'request root fan-out of worker-leaf')
      .replace('On harnesses without spawn tools (Codex), return `DELEGATION_REQUESTS` for the orchestrator to fan out `forge-worker-leaf` dispatches. Omit `DELEGATION_REQUESTS` when you self-spawn.', 'On Codex, always return `DELEGATION_REQUESTS` for the root orchestrator to fan out worker-leaf dispatches. Never self-spawn from this coordinator contract.');
    body = `## Codex standalone subdelegation override

This contract is injected into a standard/default Codex child. Never spawn a named Forge agent and never set \`agent_type\` or \`subagent_type\`. When any coordinator subdelegation trigger fires, return structured \`DELEGATION_REQUESTS\` to the root orchestrator. The root alone fans those requests out as standard/default agents after injecting the complete worker-leaf contract.

${body}`;
  }
  if (artifact.name === 'using-forge') {
    body = body
      .replace(/- Never do worker work inline\./g, '- When sub-agent spawning is available, never do worker work inline; otherwise execute the route sequentially inline under the applicable role contract.')
      .replace(/- Delegate all development and operational execution to `forge-worker`\./g, '- When sub-agent spawning is available, delegate development and operational execution to standard/default agents with the complete worker contract injected.')
      .replace(/`forge-worker` \*\*must\*\* spawn leaves \(or return `DELEGATION_REQUESTS` on Codex\)/g, '`references/worker.md` must return `DELEGATION_REQUESTS` to the root on Codex')
      .replace(/Codex: parse `DELEGATION_REQUESTS` and fan out `forge-worker-leaf` yourself/g, 'Codex: parse `DELEGATION_REQUESTS` and fan out standard/default agents with the complete worker-leaf contract yourself');
  }
  return `# ${artifact.name}\n\n${body}\n`;
}

export function renderCodexForgeSkill(artifact: CanonicalArtifact): string {
  const body = artifact.body
    .replace('Load and follow the `using-forge` skill before routing work.', 'Read and follow `references/using-forge.md` before routing work.')
    .replace(/`forge-worker-leaf`/g, '`references/worker-leaf.md`')
    .replace(/`forge-worker`/g, '`references/worker.md`')
    .replace(/`forge-adversary`/g, '`references/adversary.md`')
    .replace(/`forge-grill`/g, '`references/grill.md`')
    .replace(/see `using-forge`/g, 'see `references/using-forge.md`')
    .replace('- Never do worker work inline.', '- When sub-agent spawning is available, never do worker work inline; when unavailable, execute sequentially inline using the applicable role contract.')
    .replace('- Never do non-development execution work inline.', '- When sub-agent spawning is available, never do non-development execution work inline; when unavailable, execute it sequentially inline using the applicable role contract.')
    .replace('- Delegate all technical and operational work to Forge workers.', '- When sub-agent spawning is available, delegate all technical and operational work to standard/default agents with injected Forge role contracts.');

  const codexRuntime = `## Codex plugin runtime

This plugin is skills-only. The files under \`references/\` are private role contracts, not discoverable custom agent types.

- When delegating, call Codex's available sub-agent spawning tool with a standard/default agent. Do not set \`agent_type\`, \`subagent_type\`, or depend on a named Forge agent being installed.
- Before spawning, read the complete applicable role contract and include it verbatim in the task: \`references/worker.md\`, \`references/worker-leaf.md\`, or \`references/adversary.md\`.
- Child agents must not rely on plugin skill discovery. Their prompt must contain every instruction and reference needed for the bounded task.
- If a coordinator returns \`DELEGATION_REQUESTS\`, the root agent fans those requests out as standard/default agents using the complete \`references/worker-leaf.md\` contract.
- If no sub-agent spawning tool is available, execute the same route sequentially in the main agent, preserve approval and independent-verification boundaries as far as the runtime permits, and explicitly report that Forge is running in inline fallback mode.

`;
  return `${stringifyYaml({ name: 'forge', description: artifact.description })}${codexRuntime}${body.trim()}\n`;
}

export async function buildCodexPluginPackage(source: string, version: string, license: string): Promise<{ files: PluginFile[]; diagnostics: Diagnostic[] }> {
  const { artifacts, diagnostics } = await discoverArtifacts(source);
  const forge = requiredArtifact(artifacts, 'forge', diagnostics);
  const files: PluginFile[] = [];

  if (forge) files.push({ relativePath: 'skills/forge/SKILL.md', content: renderCodexForgeSkill(forge) });
  for (const [canonicalName, outputName] of referenceNames) {
    const artifact = requiredArtifact(artifacts, canonicalName, diagnostics);
    if (artifact) files.push({ relativePath: `skills/forge/references/${outputName}.md`, content: renderCodexPluginReference(artifact) });
  }
  files.push({
    relativePath: '.codex-plugin/plugin.json',
    content: `${JSON.stringify({
      name: 'forge',
      version,
      description: 'Forge: a thin orchestrator with delegated workers, plans, and adversarial verification.',
      author: { name: 'Guido Caffa' },
      license,
      repository: 'https://github.com/guidobuilds/forge',
      skills: './skills/',
      interface: {
        displayName: 'Forge',
        shortDescription: 'Orchestrate development work with delegated verification.',
        longDescription: 'Forge routes development work through scoped workers, approval gates, durable plans, and independent adversarial verification.',
        developerName: 'Guido Caffa',
        category: 'Productivity',
        capabilities: ['Orchestration', 'Delegation', 'Verification'],
        defaultPrompt: ['Use Forge to implement this task with the lightest safe workflow.']
      }
    }, null, 2)}\n`
  });
  return { files, diagnostics };
}
