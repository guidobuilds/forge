import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudePluginPackage, rewritePluginCrossReferences } from '../src/adapters/claude-plugin.js';

test('rewritePluginCrossReferences namespaces bare agent-dispatch and skill-load tokens alike', () => {
  const body = 'Route to forge-worker. Spawn forge-worker-leaf. Escalate to forge-adversary. Load using-forge and forge-grill.';
  const rewritten = rewritePluginCrossReferences(body);
  assert.match(rewritten, /forge:forge-worker\. /);
  assert.match(rewritten, /forge:forge-worker-leaf\./);
  assert.match(rewritten, /forge:forge-adversary\./);
  assert.match(rewritten, /Load forge:using-forge and forge:forge-grill\./);
});

test('forge-worker-leaf is rewritten exactly once with no double-tagging and no bare forge-worker leftover', () => {
  const body = 'Spawn forge-worker-leaf sub-agents for bounded shards.';
  const rewritten = rewritePluginCrossReferences(body);
  assert.equal(rewritten, 'Spawn forge:forge-worker-leaf sub-agents for bounded shards.');
  assert.doesNotMatch(rewritten, /forge:forge:/);
  assert.doesNotMatch(rewritten, /forge:forge-worker forge:forge-worker-leaf/);
  const bareWorkerLeftover = rewritten.match(/(?<!forge:)\bforge-worker\b(?!-leaf)/);
  assert.equal(bareWorkerLeftover, null, 'no bare forge-worker leftover should remain inside the rewritten forge-worker-leaf token');
});

test('rewritePluginCrossReferences is idempotent and does not double-tag already-namespaced references', () => {
  const alreadyNamespaced = 'Dispatch forge:forge-worker-leaf for the bounded shard. Load forge:using-forge and forge:forge-grill.';
  assert.equal(rewritePluginCrossReferences(alreadyNamespaced), alreadyNamespaced);
});

test('buildClaudePluginPackage renders the real bundled artifacts into a Claude plugin package', async () => {
  const root = process.cwd();
  const { files, diagnostics } = await buildClaudePluginPackage(root, '9.9.9', 'MIT');

  assert.equal(diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.equal(files.length, 7);

  const byPath = new Map(files.map((file) => [file.relativePath, file.content]));
  assert.ok(byPath.has('skills/forge/SKILL.md'), 'forge.md should land at skills/forge/SKILL.md per the claude.kind override');
  assert.ok(!byPath.has('agents/forge.md'), 'forge.md must not be mis-emitted as an agent');
  assert.ok(byPath.has('agents/forge-worker.md'));
  assert.ok(byPath.has('agents/forge-worker-leaf.md'));
  assert.ok(byPath.has('agents/forge-adversary.md'));
  assert.ok(byPath.has('skills/using-forge/SKILL.md'));
  assert.ok(byPath.has('skills/forge-grill/SKILL.md'));
  assert.ok(byPath.has('.claude-plugin/plugin.json'));

  assert.match(byPath.get('agents/forge-worker.md')!, /forge:(forge-worker-leaf|forge-adversary)/);
  assert.match(byPath.get('agents/forge-worker-leaf.md')!, /forge:forge-worker\b/);
  assert.match(byPath.get('agents/forge-adversary.md')!, /forge:forge-worker\b/);

  // forge.md is the only artifact that issues genuine Skill-tool load instructions for
  // using-forge/forge-grill; per the corrected design (design.md #2/#5), those bare mentions must
  // now be namespaced in the plugin target too, to avoid silently resolving to a pre-existing
  // non-plugin (e.g. CLI-push) install of a same-named skill.
  const forgeSkill = byPath.get('skills/forge/SKILL.md')!;
  assert.match(forgeSkill, /forge:using-forge/);
  assert.match(forgeSkill, /forge:forge-grill/);
  assert.doesNotMatch(forgeSkill, /forge:forge:/);

  const pluginJson = JSON.parse(byPath.get('.claude-plugin/plugin.json')!);
  assert.equal(pluginJson.name, 'forge');
  assert.equal(pluginJson.version, '9.9.9');
  assert.equal(pluginJson.license, 'MIT');
  assert.equal(pluginJson.author.name, 'Guido Caffa');
  assert.equal(pluginJson.keywords, undefined);
});
