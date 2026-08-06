import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexPluginPackage } from '../src/adapters/codex-plugin.js';

test('buildCodexPluginPackage emits the exact skills-only package', async () => {
  const { files, diagnostics } = await buildCodexPluginPackage(process.cwd(), '9.9.9', 'MIT');
  assert.equal(diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.deepEqual(files.map((file) => file.relativePath).sort(), [
    '.codex-plugin/plugin.json',
    'skills/forge/SKILL.md',
    'skills/forge/references/adversary.md',
    'skills/forge/references/grill.md',
    'skills/forge/references/using-forge.md',
    'skills/forge/references/worker-leaf.md',
    'skills/forge/references/worker.md'
  ]);

  const byPath = new Map(files.map((file) => [file.relativePath, file.content]));
  const manifest = JSON.parse(byPath.get('.codex-plugin/plugin.json')!);
  assert.deepEqual(manifest, {
    name: 'forge',
    version: '9.9.9',
    description: 'Forge: a thin orchestrator with delegated workers, plans, and adversarial verification.',
    author: { name: 'Guido Caffa' },
    license: 'MIT',
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
  });

  const forge = byPath.get('skills/forge/SKILL.md')!;
  assert.match(forge, /standard\/default agent/);
  assert.match(forge, /DELEGATION_REQUESTS/);
  assert.match(forge, /inline fallback mode/);
  assert.match(forge, /references\/worker\.md/);
  assert.doesNotMatch(forge, /subagent_type:/);
  for (const content of byPath.values()) assert.doesNotMatch(content, /\.codex\/agents|agents\/.*\.toml/);
});

test('Codex private role references retain complete canonical contracts', async () => {
  const { files } = await buildCodexPluginPackage(process.cwd(), '1.0.0', 'MIT');
  const byPath = new Map(files.map((file) => [file.relativePath, file.content]));
  assert.match(byPath.get('skills/forge/references/worker.md')!, /## Contract \(strict\)/);
  assert.match(byPath.get('skills/forge/references/worker.md')!, /DELEGATION_REQUESTS/);
  assert.match(byPath.get('skills/forge/references/worker.md')!, /root alone fans those requests out/);
  assert.doesNotMatch(byPath.get('skills/forge/references/worker.md')!, /Spawn `forge-worker-leaf`|spawn `forge-worker-leaf` sub-agents/);
  assert.match(byPath.get('skills/forge/references/worker-leaf.md')!, /WORKER_ROLE: leaf/);
  assert.match(byPath.get('skills/forge/references/adversary.md')!, /Definition-of-Done gate/);
  assert.match(byPath.get('skills/forge/references/using-forge.md')!, /Dynamic routing model/);
  assert.match(byPath.get('skills/forge/references/grill.md')!, /decision tree/i);
});
