import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, readdir, symlink } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import { knownClaudeModels } from '../src/adapters/claude-known.js';
import { renderClaudeAgent, renderClaudeSkill } from '../src/adapters/claude.js';
import { knownCodexModels, isKnownCodexModel } from '../src/adapters/codex-known.js';
import { renderCodexAgent, renderCodexSkill } from '../src/adapters/codex.js';
import { knownGrokModels } from '../src/adapters/grok-known.js';
import { renderGrokAgent, renderGrokSkill } from '../src/adapters/grok.js';
import { renderOpenCodeAgent, renderOpenCodeSkill } from '../src/adapters/opencode.js';
import { main, modelChoicesFor, withLiveLabels } from '../src/cli.js';
import { discoverSources } from '../src/discovery.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { buildManifest, hashProjectPath, legacyStateRoot, loadManifest, migrateStateDirectory, resolveManifestLocation, saveManifest, sha256, type AssetManifest } from '../src/manifest.js';
import { composeBody } from '../src/compose.js';
import { DISPATCH_SNIPPETS } from '../src/dispatch-snippets.js';
import { resolveExecutable } from '../src/executable-resolution.js';
import { discoverOpenCodeModels } from '../src/opencode-discovery.js';
import { discoverClaudeModels, discoverCodexModels, discoverGrokModels, discoverModels, mergeLiveWithCurated, MODEL_DISCOVERY_MAX_MODELS, MODEL_DISCOVERY_MAX_STDOUT_BYTES } from '../src/model-discovery.js';
import { getModelPreference, loadModelPreferences, saveModelPreferences, setModelPreference } from '../src/model-preferences.js';
import { supportsModel } from '../src/platform-capabilities.js';
import { buildWritePlan, discoverArtifacts } from '../src/processor.js';
import { buildUpdateCommand, detectInstallMethod, isValidVersionSpec, normalizeVersionSpec, runSelfUpdate } from '../src/self-update.js';
import { checkLatestVersion, compareSemver, formatVersionNotice } from '../src/version-check.js';
import { writeOutputs } from '../src/writer.js';
import type { CanonicalArtifact } from '../src/model.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

const agent: CanonicalArtifact = {
  name: 'test-agent',
  description: 'Test agent',
  kind: 'agent',
  body: 'Do useful work.',
  sourcePath: 'artifacts/test-agent/test-agent.md',
  claude: { permissions: { tools: ['Read', 'Write'] }, model: 'sonnet' },
  opencode: { permissions: { read: true }, model: 'opencode-model', mode: 'subagent' },
  codex: { permissions: { sandbox_mode: 'workspace-write' }, model: 'gpt-5.1' },
  grok: { permissions: { tools: ['read_file', 'search_replace'] }, model: 'grok-build' }
};

const skill: CanonicalArtifact = {
  name: 'test-skill',
  description: 'Test skill',
  kind: 'skill',
  body: 'Follow instructions.',
  sourcePath: 'artifacts/test-skill/test-skill.md',
  claude: { permissions: { 'allowed-tools': ['Read'] } },
  opencode: { model: 'ignored' },
  codex: { permissions: { any: true } },
  grok: { model: 'grok-build' }
};

test('parses frontmatter and body', () => {
  const parsed = parseFrontmatter('---\nname: test-agent\ndescription: Test\nclaude:\n  model: sonnet\n---\n\nBody');
  assert.equal(parsed.data.name, 'test-agent');
  assert.deepEqual(parsed.data.claude, { model: 'sonnet' });
  assert.equal(parsed.body, 'Body');
});

test('parses descriptions containing colons and bodies containing horizontal rules', () => {
  const parsed = parseFrontmatter('---\nname: test\ndescription: "fix: things, with: colons"\nallowed-tools:\n  - Read\n---\n\nIntro\n\n---\n\nMore body\n');
  assert.equal(parsed.data.description, 'fix: things, with: colons');
  assert.deepEqual(parsed.data['allowed-tools'], ['Read']);
  assert.match(parsed.body, /Intro[\s\S]*More body/);
});

test('adapters emit platform-specific outputs', () => {
  assert.match(renderOpenCodeAgent(agent).content, /mode: subagent/);
  assert.match(renderOpenCodeAgent(agent).content, /permission:/);
  assert.doesNotMatch(renderOpenCodeAgent(agent).content, /tools:/);
  assert.match(renderOpenCodeSkill(skill).content, /name: test-skill/);
  assert.match(renderOpenCodeSkill(skill).diagnostics[0].code, /OPENCODE_SKILL_MODEL_IGNORED/);
  assert.match(renderClaudeAgent(agent).content, /tools: Read, Write\n/);
  assert.match(renderCodexAgent(agent).content, /developer_instructions =/);
  assert.match(renderCodexAgent(agent).content, /sandbox_mode = "workspace-write"/);
  assert.match(renderCodexSkill(skill).content, /name: test-skill/);
});

test('opencode agent warns on a model with no provider prefix, accepts provider/model shapes including nested slashes', () => {
  const noSlash: CanonicalArtifact = { ...agent, opencode: { model: 'sonnet' } };
  assert.ok(renderOpenCodeAgent(noSlash).diagnostics.some((item) => item.code === 'OPENCODE_UNKNOWN_MODEL'));
  const simple: CanonicalArtifact = { ...agent, opencode: { model: 'anthropic/claude-sonnet-4-5' } };
  assert.equal(renderOpenCodeAgent(simple).diagnostics.length, 0);
  const nested: CanonicalArtifact = { ...agent, opencode: { model: 'openrouter/openai/gpt-5-chat' } };
  assert.equal(renderOpenCodeAgent(nested).diagnostics.length, 0);
});

test('codex agent accepts any non-whitespace model (format unverified, permissive by design)', () => {
  const withModel: CanonicalArtifact = { ...agent, codex: { model: 'gpt-5.1-codex-max' } };
  assert.equal(renderCodexAgent(withModel).diagnostics.filter((item) => item.code === 'CODEX_UNKNOWN_MODEL').length, 0);
  const withSpace: CanonicalArtifact = { ...agent, codex: { model: 'not a model' } };
  assert.ok(renderCodexAgent(withSpace).diagnostics.some((item) => item.code === 'CODEX_UNKNOWN_MODEL'));
});

// Regression: before this fix, `promptForModelValue` had no `codex` branch, so `knownChoices` was
// undefined for codex and the interactive `Model for \`<name>\` (codex)` prompt fell straight
// through to a blank free-text field with no options/autocomplete. `modelChoicesFor` is that
// platform→choices mapping; for codex it must now return the curated list (never undefined).
test('modelChoicesFor proposes curated codex models (regression: codex previously offered none)', () => {
  const codexChoices = modelChoicesFor('codex', {});
  assert.ok(codexChoices && codexChoices.length > 0, 'codex must offer a curated model list, not fall through to free text');
  assert.deepEqual(codexChoices, [...knownCodexModels]);
  // Every offered codex model id is a value the permissive validator accepts (non-empty, no whitespace).
  for (const model of codexChoices) assert.equal(isKnownCodexModel(model), true);
});

test('knownCodexModels is a non-empty, distinct list of accepted codex model ids', () => {
  assert.ok(knownCodexModels.size > 0);
  assert.equal(knownCodexModels.size, new Set([...knownCodexModels]).size);
  for (const model of knownCodexModels) {
    assert.equal(isKnownCodexModel(model), true, `${model} must satisfy the permissive codex model validator`);
  }
});

// Regression (adversary break 1): the curated `knownCodexModels` FALLBACK must be the list-visible,
// user-selectable catalog observed from a real `codex debug models` run on the reference machine
// (recorded in explore.md §2 / verification.md). A permissive `isKnownCodexModel` check is NOT enough —
// a wholly-disjoint set (e.g. gpt-5-codex/…) passes it yet presents ids the installed codex does not
// recognize after a failed live discovery. This fixture is observed evidence, so the test needs no live
// CLI or network; if the fallback drifts outside this set (a stale/invented id), this test fails.
test('knownCodexModels fallback is the observed codex selectable catalog (no stale/invented ids)', () => {
  const observedSelectable = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini'];
  assert.deepEqual([...knownCodexModels], observedSelectable);
});

test('modelChoicesFor keeps claude/grok/opencode behavior and returns undefined elsewhere', () => {
  assert.deepEqual(modelChoicesFor('claude', {}), [...knownClaudeModels]);
  assert.deepEqual(modelChoicesFor('grok', {}), [...knownGrokModels]);
  // OpenCode without live discovery has no fixed list — free-text fallback.
  assert.equal(modelChoicesFor('opencode', {}), undefined);
  // OpenCode with live discovery returns the discovered models unchanged (highest priority).
  const discovered = ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.2'];
  assert.deepEqual(modelChoicesFor('opencode', { opencode: discovered }), discovered);
});

// ============================================================================
// Dynamic model discovery (src/model-discovery.ts) — runner-injection tests.
// No test depends on a live CLI; every parser is driven with a fake runner.
// ============================================================================

test('discoverModels dispatches each platform to its parser via the injected runner', () => {
  // codex: routes to `codex debug models`, parses JSON, returns list-visible slugs.
  const codexRunner = (command: string) => (command === 'codex'
    ? { status: 0, stdout: JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }] }) }
    : { status: null, stdout: '' });
  assert.deepEqual(discoverModels('codex', '/tmp', codexRunner, 1000), ['gpt-5.6-sol']);

  // grok: routes to `grok models`, ignores the banner, parses `*`/`-` lines.
  const grokRunner = (command: string) => (command === 'grok'
    ? { status: 0, stdout: 'You are not authenticated.\n  * grok-4.6 (default)\n  - grok-4.5\n' }
    : { status: null, stdout: '' });
  assert.deepEqual(discoverModels('grok', '/tmp', grokRunner, 1000), ['grok-4.6', 'grok-4.5']);

  // opencode: routes to `opencode`/`opencode2 models`.
  const opencodeRunner = (command: string) => (command === 'opencode'
    ? { status: 0, stdout: 'anthropic/claude-sonnet-4-5\n' }
    : { status: null, stdout: '' });
  assert.deepEqual(discoverModels('opencode', '/tmp', opencodeRunner, 1000), ['anthropic/claude-sonnet-4-5']);

  // claude: no dynamic source — returns undefined without ever calling the runner.
  let called = false;
  const claudeRunner = () => { called = true; return { status: 0, stdout: '' }; };
  assert.equal(discoverModels('claude', '/tmp', claudeRunner, 1000), undefined);
  assert.equal(called, false);
});

test('discoverClaudeModels always returns undefined (no dynamic source)', () => {
  assert.equal(discoverClaudeModels('/tmp', 1000, () => ({ status: 0, stdout: 'should-not-be-read' })), undefined);
});

test('discoverOpenCodeModels enforces the stdout byte cap (over-cap → undefined)', () => {
  const big = 'x'.repeat(MODEL_DISCOVERY_MAX_STDOUT_BYTES + 1);
  assert.equal(discoverOpenCodeModels('/tmp', 1000, () => ({ status: 0, stdout: big })), undefined);
});

test('discoverOpenCodeModels enforces the model-count cap (truncates to the cap)', () => {
  const many = Array.from({ length: MODEL_DISCOVERY_MAX_MODELS + 1 }, (_, i) => `acme/model-${i}`).join('\n');
  const result = discoverOpenCodeModels('/tmp', 1000, () => ({ status: 0, stdout: many }));
  assert.equal(result?.length, MODEL_DISCOVERY_MAX_MODELS);
  assert.equal(result?.[0], 'acme/model-0');
  assert.equal(result?.[MODEL_DISCOVERY_MAX_MODELS - 1], `acme/model-${MODEL_DISCOVERY_MAX_MODELS - 1}`);
});

test('mergeLiveWithCurated dedupes stable order, live first', () => {
  const live = ['grok-4.6', 'grok-4.5'];
  const curated = ['inherit', 'grok-build', 'grok-4.5', 'grok-composer-2.5-fast'];
  assert.deepEqual(mergeLiveWithCurated(live, curated), ['grok-4.6', 'grok-4.5', 'inherit', 'grok-build', 'grok-composer-2.5-fast']);
});

test('discoverCodexModels parses list-visible slugs from a fixture; undefined on non-JSON / non-zero / over-cap', () => {
  const fixture = JSON.stringify({ models: [
    { slug: 'gpt-5.6-sol', visibility: 'list' },
    { slug: 'gpt-reserve', visibility: 'hide' },
    { slug: 'codex-auto-review', visibility: 'hide' },
    { slug: 'gpt-5.6-terra', visibility: 'list' }
  ] });
  const ok = discoverCodexModels('/tmp', 1000, () => ({ status: 0, stdout: fixture }));
  assert.deepEqual(ok, ['gpt-5.6-sol', 'gpt-5.6-terra']);

  // non-JSON output → undefined
  assert.equal(discoverCodexModels('/tmp', 1000, () => ({ status: 0, stdout: 'not json' })), undefined);
  // non-zero exit → undefined
  assert.equal(discoverCodexModels('/tmp', 1000, () => ({ status: 1, stdout: '{}' })), undefined);
  // over-cap stdout → undefined
  const big = 'x'.repeat(MODEL_DISCOVERY_MAX_STDOUT_BYTES + 1);
  assert.equal(discoverCodexModels('/tmp', 1000, () => ({ status: 0, stdout: big })), undefined);
});

// Regression (adversary break 2): the codex parser must trim and re-validate each slug through
// `isKnownCodexModel` (rejects empty / whitespace-only), mirroring the grok parser (explore.md §4).
// Before the fix an empty/`   `/` gpt-5.6-sol ` slug leaked straight through into the choices.
test('discoverCodexModels trims slugs and discards empty/whitespace (re-validated via isKnownCodexModel)', () => {
  const fixture = JSON.stringify({ models: [
    { slug: '', visibility: 'list' },
    { slug: '   ', visibility: 'list' },
    { slug: ' gpt-5.6-sol ', visibility: 'list' },
    { slug: 'gpt-5.6-terra', visibility: 'list' }
  ] });
  assert.deepEqual(
    discoverCodexModels('/tmp', 1000, () => ({ status: 0, stdout: fixture })),
    ['gpt-5.6-sol', 'gpt-5.6-terra']
  );
});

test('discoverGrokModels parses banner + model lines; undefined on banner-only / junk', () => {
  const bannerList = 'You are not authenticated.\nDefault model: grok-4.6\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n';
  assert.deepEqual(discoverGrokModels('/tmp', 1000, () => ({ status: 0, stdout: bannerList })), ['grok-4.6', 'grok-4.5']);

  // banner-only → no parseable model lines → undefined
  assert.equal(discoverGrokModels('/tmp', 1000, () => ({ status: 0, stdout: 'You are not authenticated.\n' })), undefined);
  // junk lines with no `*`/`-` markers → undefined
  assert.equal(discoverGrokModels('/tmp', 1000, () => ({ status: 0, stdout: 'foo bar\nbaz qux\n' })), undefined);
  // `*`-marked lines that fail isKnownGrokModel are dropped → undefined
  assert.equal(discoverGrokModels('/tmp', 1000, () => ({ status: 0, stdout: '  * not-a-real-grok-model (default)\n' })), undefined);
});

test('modelChoicesFor honors a per-platform discovery map (live-first, curated fallback, never empty)', () => {
  // opencode: live or free-text (undefined when no live).
  assert.deepEqual(modelChoicesFor('opencode', { opencode: ['anthropic/claude-sonnet-4-5'] }), ['anthropic/claude-sonnet-4-5']);
  assert.equal(modelChoicesFor('opencode', {}), undefined);

  // codex: live, NO merge; curated on failure.
  assert.deepEqual(modelChoicesFor('codex', { codex: ['gpt-5.6-sol'] }), ['gpt-5.6-sol']);
  assert.deepEqual(modelChoicesFor('codex', {}), [...knownCodexModels]);

  // grok: live + curated extras merged (deduped, live-first); curated on failure.
  assert.deepEqual(modelChoicesFor('grok', { grok: ['grok-4.6'] }), ['grok-4.6', ...knownGrokModels]);
  assert.deepEqual(modelChoicesFor('grok', {}), [...knownGrokModels]);

  // claude: curated always, ignores discovery, never undefined/empty.
  assert.deepEqual(modelChoicesFor('claude', {}), [...knownClaudeModels]);
  assert.deepEqual(modelChoicesFor('claude', { claude: ['not-a-real-claude-model'] }), [...knownClaudeModels]);
});

test('claude model choices always fall back to the curated set (no dynamic source, never empty)', () => {
  assert.equal(discoverClaudeModels('/tmp', 1000, () => ({ status: 0, stdout: '' })), undefined);
  const choices = modelChoicesFor('claude', {});
  assert.ok(choices && choices.length > 0, 'claude must never offer an empty/undefined choice list');
  assert.deepEqual(choices, [...knownClaudeModels]);
});

test('withLiveLabels suffixes only live-set values on the label, keeping the value bare', () => {
  const liveSet = new Set(['grok-4.6', 'grok-4.5']);
  const labeled = withLiveLabels(['grok-4.6', 'grok-4.5', 'inherit', 'grok-build'], liveSet);
  assert.deepEqual(labeled, [
    { value: 'grok-4.6', label: 'grok-4.6 (live)' },
    { value: 'grok-4.5', label: 'grok-4.5 (live)' },
    { value: 'inherit', label: 'inherit' },
    { value: 'grok-build', label: 'grok-build' }
  ]);
  // Curated extras and the Custom… escape are never suffixed (not in the live set).
  assert.deepEqual(withLiveLabels(['__custom__'], liveSet), [{ value: '__custom__', label: '__custom__' }]);
});

test('claude agent omits tools when no permissions are provided', () => {
  const minimal: CanonicalArtifact = { name: 'a', description: 'b', kind: 'agent', body: 'body', sourcePath: 'artifacts/a/a.md' };
  const rendered = renderClaudeAgent(minimal);
  assert.doesNotMatch(rendered.content, /tools:/);
  assert.equal(rendered.diagnostics.length, 0);
});

test('claude agent reports unknown tools and unknown models as warnings', () => {
  const odd: CanonicalArtifact = {
    name: 'odd',
    description: 'agent',
    kind: 'agent',
    body: 'body',
    sourcePath: 'artifacts/odd/odd.md',
    claude: { model: 'sonet', permissions: { tools: ['Read', 'NotATool', 'mcp__svc__do'] } }
  };
  const rendered = renderClaudeAgent(odd);
  assert.match(rendered.content, /tools: Read, NotATool, mcp__svc__do/);
  assert.match(rendered.content, /model: sonet/);
  assert.ok(rendered.diagnostics.some((item) => item.code === 'CLAUDE_UNKNOWN_TOOL' && item.severity === 'warning'));
  assert.ok(rendered.diagnostics.some((item) => item.code === 'CLAUDE_UNKNOWN_MODEL' && item.severity === 'warning'));
  assert.equal(rendered.diagnostics.filter((item) => item.code === 'CLAUDE_UNKNOWN_TOOL').length, 1);
});

test('claude agent ignores non-tool permissions blocks with diagnostic', () => {
  const odd: CanonicalArtifact = {
    name: 'odd',
    description: 'agent',
    kind: 'agent',
    body: 'body',
    sourcePath: 'artifacts/odd/odd.md',
    claude: { permissions: { read: true, write: false } as unknown as { tools?: unknown } }
  };
  const rendered = renderClaudeAgent(odd);
  assert.doesNotMatch(rendered.content, /tools:/);
  assert.ok(rendered.diagnostics.some((item) => item.code === 'CLAUDE_AGENT_TOOLS_IGNORED'));
});

test('claude skill emits allowed-tools as comma-separated string and warns', () => {
  const rendered = renderClaudeSkill(skill);
  assert.match(rendered.content, /allowed-tools: Read\n/);
  assert.ok(rendered.diagnostics.some((item) => item.code === 'CLAUDE_SKILL_ALLOWED_TOOLS' && item.severity === 'warning'));
});

test('claude skill emits model, when_to_use, and user-invocable', () => {
  const withModel: CanonicalArtifact = {
    name: 's',
    description: 'd',
    kind: 'skill',
    body: 'i',
    sourcePath: 'artifacts/s/s.md',
    claude: { model: 'opus', when_to_use: 'Use when doing s things.', 'user-invocable': false }
  };
  const rendered = renderClaudeSkill(withModel);
  assert.match(rendered.content, /model: opus\n/);
  assert.match(rendered.content, /when_to_use: Use when doing s things\.\n/);
  assert.match(rendered.content, /user-invocable: false\n/);
  assert.equal(rendered.diagnostics.length, 0);
});

test('claude skill reports unknown model as a warning', () => {
  const withModel: CanonicalArtifact = { name: 's', description: 'd', kind: 'skill', body: 'i', sourcePath: 'artifacts/s/s.md', claude: { model: 'sonet' } };
  const rendered = renderClaudeSkill(withModel);
  assert.match(rendered.content, /model: sonet/);
  assert.ok(rendered.diagnostics.some((item) => item.code === 'CLAUDE_UNKNOWN_MODEL' && item.severity === 'warning'));
});

test('grok agent emits tools as a YAML sequence, not a comma-joined string', () => {
  const rendered = renderGrokAgent(agent);
  assert.match(rendered.content, /model: grok-build/);
  // tools must appear as a YAML list (- item), not a comma-joined value
  assert.match(rendered.content, /tools:/);
  assert.match(rendered.content, /- read_file/);
  assert.match(rendered.content, /- search_replace/);
  assert.doesNotMatch(rendered.content, /tools: read_file, search_replace/);
  assert.equal(rendered.diagnostics.length, 0);
});

test('grok agent reports unknown tools and unknown models as warnings', () => {
  const odd: CanonicalArtifact = {
    name: 'odd',
    description: 'agent',
    kind: 'agent',
    body: 'body',
    sourcePath: 'artifacts/odd/odd.md',
    grok: { model: 'gpt-never', permissions: { tools: ['read_file', 'not_a_grok_tool'] } }
  };
  const rendered = renderGrokAgent(odd);
  assert.ok(rendered.diagnostics.some((item) => item.code === 'GROK_UNKNOWN_TOOL' && item.severity === 'warning'));
  assert.ok(rendered.diagnostics.some((item) => item.code === 'GROK_UNKNOWN_MODEL' && item.severity === 'warning'));
});

test('grok agent omits tools when no permissions are provided', () => {
  const minimal: CanonicalArtifact = { name: 'a', description: 'b', kind: 'agent', body: 'body', sourcePath: 'artifacts/a/a.md' };
  const rendered = renderGrokAgent(minimal);
  assert.doesNotMatch(rendered.content, /tools:/);
  assert.equal(rendered.diagnostics.length, 0);
});

test('grok skill emits only name and description, drops model and permissions', () => {
  const rendered = renderGrokSkill(skill);
  assert.match(rendered.content, /name: test-skill/);
  assert.doesNotMatch(rendered.content, /model:/);
  assert.doesNotMatch(rendered.content, /tools:/);
  assert.ok(rendered.diagnostics.some((item) => item.code === 'GROK_SKILL_MODEL_IGNORED'));
});

test('grok skill warns when a background-only skill has no way to be hidden from direct invocation', () => {
  const backgroundOnly: CanonicalArtifact = { ...skill, claude: { 'user-invocable': false } };
  const rendered = renderGrokSkill(backgroundOnly);
  assert.ok(rendered.diagnostics.some((item) => item.code === 'GROK_SKILL_DISCOVERABLE_UNENFORCED'));
});

test('opencode skill warns when a background-only skill has no way to be hidden from direct invocation', () => {
  const backgroundOnly: CanonicalArtifact = { ...skill, claude: { 'user-invocable': false } };
  const rendered = renderOpenCodeSkill(backgroundOnly);
  assert.ok(rendered.diagnostics.some((item) => item.code === 'OPENCODE_SKILL_DISCOVERABLE_UNENFORCED'));
});

test('processor validates sources and generates dry-run plan paths', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'user', home, cwd: root });
  assert.equal(plan.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.equal(plan.files.length, 8);
  assert.ok(plan.files.some((file) => file.path.endsWith('.config/opencode/agents/test-agent.md')));
  assert.ok(plan.files.some((file) => file.path.endsWith('.codex/agents/test-agent.toml')));
  assert.ok(plan.files.some((file) => file.path.endsWith('.agents/skills/test-skill/SKILL.md')));
  assert.ok(plan.files.some((file) => file.path.endsWith('.grok/agents/test-agent.md')));
  assert.ok(plan.files.some((file) => file.path.endsWith('.grok/skills/test-skill/SKILL.md')));
});

test('OpenCode user-scope install targets v1, v2, both, or neither based on which directory actually exists', async () => {
  const root = await fixtureRoot();

  // Neither ~/.config/opencode nor ~/.opencode exists yet — default to v1's path (today's
  // long-standing behavior) rather than silently installing nothing, plus an info diagnostic.
  const neitherHome = await tempHome();
  const neitherPlan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'user', home: neitherHome, cwd: root });
  assert.equal(neitherPlan.files.length, 2);
  assert.ok(neitherPlan.files.every((file) => file.path.includes('/.config/opencode/')));
  assert.ok(neitherPlan.diagnostics.some((item) => item.code === 'OPENCODE_USER_ROOT_NOT_FOUND'));

  // Only v1's directory exists — v1 only, no diagnostic, no v2 file.
  const v1Home = await tempHome();
  await mkdir(path.join(v1Home, '.config', 'opencode'), { recursive: true });
  const v1Plan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'user', home: v1Home, cwd: root });
  assert.equal(v1Plan.files.length, 2);
  assert.ok(v1Plan.files.every((file) => file.path.includes('/.config/opencode/')));
  assert.ok(!v1Plan.diagnostics.some((item) => item.code === 'OPENCODE_USER_ROOT_NOT_FOUND'));

  // Only v2's directory exists (e.g. a v2-only install with no `opencode` v1 binary ever run) —
  // this is the exact scenario that silently produced zero visible OpenCode files before this fix.
  const v2Home = await tempHome();
  await mkdir(path.join(v2Home, '.opencode'), { recursive: true });
  const v2Plan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'user', home: v2Home, cwd: root });
  assert.equal(v2Plan.files.length, 2);
  assert.ok(v2Plan.files.every((file) => file.path.includes('/.opencode/') && !file.path.includes('/.config/opencode/')));

  // Both exist — write both, one file per artifact per generation.
  const bothHome = await tempHome();
  await mkdir(path.join(bothHome, '.config', 'opencode'), { recursive: true });
  await mkdir(path.join(bothHome, '.opencode'), { recursive: true });
  const bothPlan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'user', home: bothHome, cwd: root });
  assert.equal(bothPlan.files.length, 4);
  assert.equal(bothPlan.files.filter((file) => file.path.includes('/.config/opencode/')).length, 2);
  assert.equal(bothPlan.files.filter((file) => file.path.includes('/.opencode/') && !file.path.includes('/.config/opencode/')).length, 2);

  // Project scope is untouched by any of this — v1 and v2 already share `.opencode/` there.
  const projectPlan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'project', cwd: root });
  assert.equal(projectPlan.files.length, 2);
});

test('processor rejects invalid fields and name mismatch', async () => {
  const root = await tempDir('forge-invalid-');
  await mkdir(path.join(root, 'artifacts', 'other'), { recursive: true });
  await writeFile(path.join(root, 'artifacts', 'other', 'other.md'), '---\nname: bad_name\ndescription: Bad\nkind: agent\nmode: subagent\nclaude:\n  model: true\nopencode:\n  mode: invalid\n---\n\nBody\n');
  const plan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'project', cwd: root });
  assert.ok(plan.diagnostics.some((item) => item.code === 'UNSUPPORTED_FIELD'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'INVALID_NAME'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'NAME_MISMATCH'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'INVALID_PLATFORM_MODEL'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'INVALID_OPENCODE_MODE'));
});

test('processor requires a valid artifact kind', async () => {
  const root = await tempDir('forge-invalid-');
  await writeArtifact(root, 'nokind', 'name: nokind\ndescription: No kind');
  await writeArtifact(root, 'badkind', 'name: badkind\ndescription: Bad kind\nkind: workflow');
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'project', cwd: root });
  assert.ok(plan.diagnostics.some((item) => item.code === 'MISSING_KIND'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'INVALID_KIND'));
  assert.equal(plan.files.length, 0);
});

test('processor rejects opencode mode on a skill-kind artifact', async () => {
  const root = await tempDir('forge-invalid-');
  await writeArtifact(root, 'grilled', 'name: grilled\ndescription: Skill with mode\nkind: skill\nopencode:\n  mode: subagent');
  const plan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'project', cwd: root });
  assert.ok(plan.diagnostics.some((item) => item.code === 'OPENCODE_MODE_ON_SKILL'));
});

test('processor flags an artifact body over its line budget as info, not error', async () => {
  const root = await tempDir('forge-invalid-');
  const bigBody = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
  await writeArtifact(root, 'big-artifact', 'name: big-artifact\ndescription: Big artifact\nkind: skill', bigBody);
  const plan = await buildWritePlan({ source: root, platform: 'claude', scope: 'project', cwd: root });
  const budgetInfo = plan.diagnostics.find((item) => item.code === 'BODY_OVER_BUDGET');
  assert.ok(budgetInfo, 'expected BODY_OVER_BUDGET diagnostic');
  assert.equal(budgetInfo!.severity, 'info');
  assert.equal(plan.diagnostics.filter((item) => item.severity === 'error').length, 0);
});

test('processor validates claude.when_to_use and claude.user-invocable types and platform scope', async () => {
  const root = await tempDir('forge-invalid-');
  await writeArtifact(root, 'claude-only', 'name: claude-only\ndescription: Desc\nkind: skill\nclaude:\n  when_to_use: 123\n  user-invocable: not-a-bool\ngrok:\n  when_to_use: nope');
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'project', cwd: root });
  assert.ok(plan.diagnostics.some((item) => item.code === 'INVALID_CLAUDE_WHEN_TO_USE'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'INVALID_CLAUDE_USER_INVOCABLE'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'UNSUPPORTED_PLATFORM_FIELD' && item.platform === 'grok'));
});

test('per-platform kind override renders the alternate artifact kind', async () => {
  const root = await tempDir('forge-fixture-');
  const home = await tempHome();
  await writeArtifact(root, 'dual', 'name: dual\ndescription: Dual artifact\nkind: agent\nclaude:\n  kind: skill');
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'user', home, cwd: root });
  assert.equal(plan.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.ok(plan.files.some((file) => file.platform === 'claude' && file.kind === 'skill' && file.path.endsWith('.claude/skills/dual/SKILL.md')));
  assert.ok(plan.files.some((file) => file.platform === 'opencode' && file.kind === 'agent' && file.path.endsWith('.config/opencode/agents/dual.md')));
});

test('supportsModel is true for agent-kind on every platform, and for skill-kind only on Claude', () => {
  for (const platform of ['claude', 'opencode', 'codex', 'grok'] as const) assert.equal(supportsModel(platform, 'agent'), true);
  assert.equal(supportsModel('claude', 'skill'), true);
  assert.equal(supportsModel('opencode', 'skill'), false);
  assert.equal(supportsModel('codex', 'skill'), false);
  assert.equal(supportsModel('grok', 'skill'), false);
});

test('model preferences round-trip through set/get and save/load', async () => {
  const home = await tempHome();
  const prefsPath = path.join(home, 'model-preferences.json');
  let prefs = await loadModelPreferences(prefsPath);
  assert.deepEqual(prefs, {});
  prefs = setModelPreference(prefs, 'claude', 'forge', 'opus');
  prefs = setModelPreference(prefs, 'opencode', 'forge-worker', 'anthropic/claude-sonnet-4-5');
  await saveModelPreferences(prefsPath, prefs);
  const reloaded = await loadModelPreferences(prefsPath);
  assert.equal(getModelPreference(reloaded, 'claude', 'forge'), 'opus');
  assert.equal(getModelPreference(reloaded, 'opencode', 'forge-worker'), 'anthropic/claude-sonnet-4-5');
  assert.equal(getModelPreference(reloaded, 'grok', 'forge'), undefined);
});

test('buildWritePlan applies a model preference override only where the platform/kind supports model', async () => {
  const root = await tempDir('forge-fixture-');
  const home = await tempHome();
  await writeArtifact(root, 'dual', 'name: dual\ndescription: Dual artifact\nkind: agent\nclaude:\n  kind: skill\n  model: sonnet');
  const modelPreferences = setModelPreference({}, 'claude', 'dual', 'opus');
  const withOverride = setModelPreference(modelPreferences, 'opencode', 'dual', 'anthropic/claude-opus-4-1');
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'user', home, cwd: root, modelPreferences: withOverride });
  const claudeFile = plan.files.find((f) => f.platform === 'claude' && f.name === 'dual')!;
  assert.match(claudeFile.content, /model: opus/);
  const opencodeFile = plan.files.find((f) => f.platform === 'opencode' && f.name === 'dual')!;
  assert.match(opencodeFile.content, /model: anthropic\/claude-opus-4-1/);
});

test('discoverOpenCodeModels returns parsed lines from the first successful runner, undefined if all fail', () => {
  const calls: string[] = [];
  const succeeding = discoverOpenCodeModels('/tmp', 1000, (command) => {
    calls.push(command);
    if (command === 'opencode') return { status: 0, stdout: 'anthropic/claude-sonnet-4-5\nopenai/gpt-5.2\n\nnot-a-model-line\n' };
    return { status: null, stdout: '' };
  });
  assert.deepEqual(succeeding, ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.2']);
  assert.deepEqual(calls, ['opencode']);

  // v1 absent (or fails) falls through to v2's `models` command (real since anomalyco/opencode
  // commit 30d14000, 2026-08-06) — e.g. a v2-only install with no `opencode` binary on PATH.
  const fallback = discoverOpenCodeModels('/tmp', 1000, (command) => (command === 'opencode2' ? { status: 0, stdout: 'acme/qwen3-coder\n' } : { status: 1, stdout: '' }));
  assert.deepEqual(fallback, ['acme/qwen3-coder']);

  // Both absent, or an old pre-30d14000 v2 build where `opencode2 models` has no such subcommand
  // and errors out (see src/opencode-discovery.ts) — either way, undefined for the free-text
  // fallback, never a thrown error.
  const allFail = discoverOpenCodeModels('/tmp', 1000, () => ({ status: null, stdout: '' }));
  assert.equal(allFail, undefined);
});

test('foreign destination classifies as overwrite with warning, never error', async () => {
  const root = await fixtureRoot();
  const target = path.join(root, '.opencode', 'agents', 'test-agent.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'existing');
  const plan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'project', cwd: root, checkCollisions: true });
  assert.equal(plan.diagnostics.some((item) => item.severity === 'error'), false);
  assert.ok(plan.diagnostics.some((item) => item.code === 'FOREIGN_FILE_OVERWRITE'));
  assert.equal(plan.pending.foreignOverwrites.length, 1);
  assert.equal(plan.pending.modifiedOverwrites.length, 0);
  assert.equal(plan.files.find((file) => file.path === target)?.status, 'foreign');
  await writeOutputs(plan.files);
  assert.match(await readFile(target, 'utf8'), /Do useful work/);
});

test('managed-unmodified destination refreshes silently without warnings', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const output1 = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output1.code, 0);
    const output2 = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output2.code, 0);
    assert.doesNotMatch(output2.stdout, /FOREIGN_FILE_OVERWRITE/);
    assert.doesNotMatch(output2.stdout, /MANAGED_FILE_OVERWRITE/);
    assert.match(output2.stdout, /\[refresh\]/);
  });
});

test('managed-modified destination is backed up and overwritten with --yes', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    const target = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await writeFile(target, 'my edits');
    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /MANAGED_FILE_OVERWRITE/);
    assert.match(output.stdout, /\[overwrite, backup -> .+\.forge\/state\/backups\/projects\//);
    assert.match(await readFile(target, 'utf8'), /Do useful work/);
    const backupMatch = output.stdout.match(/backup -> ([^\s\]]+)/);
    assert.ok(backupMatch, 'backup path printed');
    assert.equal(await readFile(backupMatch![1], 'utf8'), 'my edits');
  });
});

test('non-interactive install of managed-modified file rejects without --yes', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    const target = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await writeFile(target, 'my edits');
    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 1);
    assert.match(output.stderr, /needs your decision/);
    assert.equal(await readFile(target, 'utf8'), 'my edits');
  });
});

test('dry-run on managed-modified file reports classification without writing or backing up', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    const target = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await writeFile(target, 'my edits');
    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /MANAGED_FILE_OVERWRITE/);
    assert.equal(await readFile(target, 'utf8'), 'my edits');
    const backupsRoot = path.join(home, '.forge', 'state', 'backups');
    await assert.rejects(access(backupsRoot));
  });
});

test('install keeps non-interactive defaults when no flags are provided', async () => {
  const root = await fixtureRoot();
  // Explicit isolated HOME, not the real machine's — otherwise this varies with whether the
  // developer's own ~/.config/opencode or ~/.opencode happens to exist (see the OpenCode
  // user-scope dual-target expansion in src/processor.ts).
  const home = await tempHome();
  const output = await captureConsole(() => main(['install', '--source', root, '--dry-run'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 2 source\(s\), 8 output\(s\)/);
  assert.match(output.stdout, /\.config\/opencode\/agents\/test-agent\.md/);
  assert.match(output.stdout, /\.agents\/skills\/test-skill\/SKILL\.md/);
  assert.match(output.stdout, /\.grok\/agents\/test-agent\.md/);
  assert.match(output.stdout, /\.grok\/skills\/test-skill\/SKILL\.md/);
});

test('install uses bundled Forge sources when --source is omitted', async () => {
  const output = await captureConsole(() => main(['install', '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 6 source\(s\), 6 output\(s\)/);
  assert.match(output.stdout, /\.opencode\/agents\/forge\.md/);
  assert.match(output.stdout, /\.opencode\/skills\/using-forge\/SKILL\.md/);
});

test('install accepts explicit platform and scope without prompting', async () => {
  const root = await fixtureRoot();
  const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'codex', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 2 source\(s\), 2 output\(s\)/);
  assert.match(output.stdout, /\.codex\/agents\/test-agent\.toml/);
  assert.doesNotMatch(output.stdout, /\.config\/opencode/);
});

test('install force overwrites existing outputs through the CLI', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const target = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'existing');

    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--force'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /FOREIGN_FILE_OVERWRITE/);
    assert.match(await readFile(target, 'utf8'), /Do useful work/);
    const location = await resolveManifestLocation('project', root, home);
    assert.equal(path.dirname(path.dirname(path.dirname(location.manifestPath))), path.join(home, '.forge', 'state'));
    await access(location.manifestPath);
  });
});

test('update overwrites existing outputs without a separate force flag', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const target = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'existing');

    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /update: 2 source\(s\), 2 output\(s\)/);
    assert.match(output.stdout, /FOREIGN_FILE_OVERWRITE/);
    assert.match(await readFile(target, 'utf8'), /Do useful work/);
    const location = await resolveManifestLocation('project', root, home);
    assert.equal(path.dirname(path.dirname(path.dirname(location.manifestPath))), path.join(home, '.forge', 'state'));
    await access(location.manifestPath);
  });
});

test('project manifest path is based on canonical project path hash', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  const location = await resolveManifestLocation('project', root, home);
  const canonicalRoot = await realpath(root);
  assert.equal(location.projectPath, canonicalRoot);
  assert.equal(location.projectPathHash, hashProjectPath(canonicalRoot));
  assert.equal(location.manifestPath, path.join(home, '.forge', 'state', 'projects', location.projectPathHash!, 'manifest.json'));
});

test('install writes a managed asset manifest', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    const location = await resolveManifestLocation('project', root, home);
    const canonicalRoot = await realpath(root);
    const manifest = JSON.parse(await readFile(location.manifestPath, 'utf8')) as AssetManifest;
    assert.equal(manifest.schemaVersion, 2);
    assert.ok(manifest.forgeVersion.length > 0);
    assert.ok(manifest.entries.every((entry) => entry.forgeVersion === manifest.forgeVersion));
    assert.equal(manifest.scope, 'project');
    assert.equal(manifest.projectPath, canonicalRoot);
    assert.equal(manifest.projectPathHash, location.projectPathHash);
    assert.equal(manifest.entries.length, 2);
    assert.ok(manifest.entries.some((entry) => entry.sourcePath === path.join('artifacts', 'test-agent', 'test-agent.md')));
  });
});

test('sequential single-platform installs merge into the manifest instead of replacing it', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const claudeInstall = await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(claudeInstall.code, 0);
    const opencodeInstall = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(opencodeInstall.code, 0);

    const location = await resolveManifestLocation('project', root, home);
    const manifest = JSON.parse(await readFile(location.manifestPath, 'utf8')) as AssetManifest;
    assert.equal(manifest.entries.length, 4);
    assert.equal(manifest.entries.filter((entry) => entry.platform === 'claude').length, 2);
    assert.equal(manifest.entries.filter((entry) => entry.platform === 'opencode').length, 2);

    // The claude files must still be on disk and still classify as managed-unmodified on a
    // subsequent opencode-only run — proving they weren't silently demoted to "foreign" by having
    // fallen out of the manifest.
    const followUp = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.doesNotMatch(followUp.stdout, /foreign overwrite/);
  });
});

test('loadManifest upgrades a v1 manifest on read, defaulting forgeVersion to unknown', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  const location = await resolveManifestLocation('project', root, home);
  await saveManifest(location.manifestPath, {
    schemaVersion: 1,
    scope: 'project',
    projectPath: root,
    projectPathHash: location.projectPathHash,
    updatedAt: new Date(0).toISOString(),
    entries: [{ platform: 'opencode', kind: 'agent', name: 'legacy-agent', path: path.join(root, '.opencode', 'agents', 'legacy-agent.md'), sourcePath: 'artifacts/legacy-agent/legacy-agent.md', checksum: sha256('legacy') }]
  } as unknown as AssetManifest);

  const manifest = await loadManifest(location.manifestPath);
  assert.equal(manifest?.schemaVersion, 2);
  assert.equal(manifest?.forgeVersion, 'unknown');
  assert.equal(manifest?.entries[0].forgeVersion, 'unknown');
});

test('migrates ~/.forge-ai/ to ~/.forge/state/ on first use, leaving a breadcrumb and never deleting the old copy', async () => {
  const home = await tempHome();
  const oldManifestPath = path.join(home, '.forge-ai', 'user-manifest.json');
  await mkdir(path.dirname(oldManifestPath), { recursive: true });
  await writeFile(oldManifestPath, JSON.stringify({ schemaVersion: 1, scope: 'user', updatedAt: new Date(0).toISOString(), entries: [] }));

  const migrated = await migrateStateDirectory(home);
  assert.equal(migrated, true);

  const newManifestPath = path.join(home, '.forge', 'state', 'user-manifest.json');
  await access(newManifestPath); // copied
  await access(oldManifestPath); // old copy left in place, not moved
  const breadcrumb = await readFile(path.join(home, '.forge-ai', 'MIGRATED'), 'utf8');
  assert.match(breadcrumb, /Forge migrated its install state/);
});

test('does not migrate, and does not overwrite, when ~/.forge/state/ already exists', async () => {
  const home = await tempHome();
  await mkdir(path.join(home, '.forge-ai'), { recursive: true });
  await writeFile(path.join(home, '.forge-ai', 'user-manifest.json'), 'old-content');
  await mkdir(path.join(home, '.forge', 'state'), { recursive: true });
  await writeFile(path.join(home, '.forge', 'state', 'user-manifest.json'), 'new-content');

  const migrated = await migrateStateDirectory(home);
  assert.equal(migrated, false);
  assert.equal(await readFile(path.join(home, '.forge', 'state', 'user-manifest.json'), 'utf8'), 'new-content');
  await assert.rejects(access(path.join(home, '.forge-ai', 'MIGRATED')));
});

test('a fresh install with neither directory present takes no migration path', async () => {
  const home = await tempHome();
  const migrated = await migrateStateDirectory(home);
  assert.equal(migrated, false);
  await assert.rejects(access(legacyStateRoot(home)));
  await assert.rejects(access(path.join(home, '.forge')));
});

test('update prunes stale manifest entry when checksum matches', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const stalePath = path.join(root, '.opencode', 'agents', 'stale-agent.md');
    const customPath = path.join(root, '.opencode', 'agents', 'custom-agent.md');
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, 'stale');
    await writeFile(customPath, 'custom');
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'artifacts/stale-agent/stale-agent.md', checksum: sha256('stale'), forgeVersion: 'test' }]);

    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /delete stale opencode agent stale-agent/);
    await assert.rejects(access(stalePath));
    assert.equal(await readFile(customPath, 'utf8'), 'custom');
  });
});

test('update backs up and deletes stale-modified manifest entry', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const stalePath = path.join(root, '.opencode', 'agents', 'stale-agent.md');
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, 'local edit');
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'artifacts/stale-agent/stale-agent.md', checksum: sha256('stale'), forgeVersion: 'test' }]);

    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /delete stale opencode agent stale-agent[^\n]*backup -> /);
    await assert.rejects(access(stalePath));
    const backupMatch = output.stdout.match(/backup -> ([^\s\]]+)/);
    assert.ok(backupMatch, 'backup path printed');
    assert.equal(await readFile(backupMatch![1], 'utf8'), 'local edit');
  });
});

test('update --no-prune preserves stale managed files', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const stalePath = path.join(root, '.opencode', 'agents', 'stale-agent.md');
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, 'stale');
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'artifacts/stale-agent/stale-agent.md', checksum: sha256('stale'), forgeVersion: 'test' }]);

    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project', '--no-prune'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.doesNotMatch(output.stdout, /delete stale/);
    assert.equal(await readFile(stalePath, 'utf8'), 'stale');
  });
});

test('update --dry-run reports deletes without mutating files or manifest', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const stalePath = path.join(root, '.opencode', 'agents', 'stale-agent.md');
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, 'stale');
    const location = await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'artifacts/stale-agent/stale-agent.md', checksum: sha256('stale'), forgeVersion: 'test' }]);
    const before = await readFile(location.manifestPath, 'utf8');

    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /delete stale opencode agent stale-agent/);
    assert.equal(await readFile(stalePath, 'utf8'), 'stale');
    assert.equal(await readFile(location.manifestPath, 'utf8'), before);
    await assert.rejects(access(path.join(root, '.opencode', 'agents', 'test-agent.md')));
  });
});

test('uninstall with no manifest reports nothing to do', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const output = await captureConsole(() => main(['uninstall', '--platform', 'opencode', '--scope', 'project', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /Nothing to uninstall/);
  });
});

test('uninstall removes unmodified manifest-tracked files and clears the manifest', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const filePath = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'installed content');
    const location = await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'test-agent', path: filePath, sourcePath: 'artifacts/test-agent/test-agent.md', checksum: sha256('installed content'), forgeVersion: 'test' }]);

    const output = await captureConsole(() => main(['uninstall', '--platform', 'opencode', '--scope', 'project', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /Removed 1 file\(s\)/);
    await assert.rejects(access(filePath));
    await assert.rejects(access(location.manifestPath));
  });
});

test('uninstall backs up and deletes a locally-edited manifest-tracked file with --yes', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const filePath = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'local edit');
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'test-agent', path: filePath, sourcePath: 'artifacts/test-agent/test-agent.md', checksum: sha256('original content'), forgeVersion: 'test' }]);

    const output = await captureConsole(() => main(['uninstall', '--platform', 'opencode', '--scope', 'project', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /delete opencode agent test-agent[^\n]*backup -> /);
    await assert.rejects(access(filePath));
    const backupMatch = output.stdout.match(/backup -> ([^\s\]]+)/);
    assert.ok(backupMatch, 'backup path printed');
    assert.equal(await readFile(backupMatch![1], 'utf8'), 'local edit');
  });
});

test('non-interactive uninstall of a locally-edited file rejects without --yes', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const filePath = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'local edit');
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'test-agent', path: filePath, sourcePath: 'artifacts/test-agent/test-agent.md', checksum: sha256('original content'), forgeVersion: 'test' }]);

    const output = await captureConsole(() => main(['uninstall', '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 1);
    assert.match(output.stderr, /needs your decision/);
    assert.equal(await readFile(filePath, 'utf8'), 'local edit');
  });
});

test('uninstall --platform only removes that platform, leaving other platforms in the manifest', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const opencodePath = path.join(root, '.opencode', 'agents', 'test-agent.md');
    const claudePath = path.join(root, '.claude', 'agents', 'test-agent.md');
    await mkdir(path.dirname(opencodePath), { recursive: true });
    await mkdir(path.dirname(claudePath), { recursive: true });
    await writeFile(opencodePath, 'opencode content');
    await writeFile(claudePath, 'claude content');
    const location = await writeTestManifest(root, home, [
      { platform: 'opencode', kind: 'agent', name: 'test-agent', path: opencodePath, sourcePath: 'artifacts/test-agent/test-agent.md', checksum: sha256('opencode content'), forgeVersion: 'test' },
      { platform: 'claude', kind: 'agent', name: 'test-agent', path: claudePath, sourcePath: 'artifacts/test-agent/test-agent.md', checksum: sha256('claude content'), forgeVersion: 'test' }
    ]);

    const output = await captureConsole(() => main(['uninstall', '--platform', 'opencode', '--scope', 'project', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    await assert.rejects(access(opencodePath));
    assert.equal(await readFile(claudePath, 'utf8'), 'claude content');
    const manifest = JSON.parse(await readFile(location.manifestPath, 'utf8')) as AssetManifest;
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].platform, 'claude');
  });
});

test('uninstall --dry-run reports the plan without deleting files or the manifest', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const filePath = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'installed content');
    const location = await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'test-agent', path: filePath, sourcePath: 'artifacts/test-agent/test-agent.md', checksum: sha256('installed content'), forgeVersion: 'test' }]);
    const before = await readFile(location.manifestPath, 'utf8');

    const output = await captureConsole(() => main(['uninstall', '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /delete opencode agent test-agent/);
    assert.equal(await readFile(filePath, 'utf8'), 'installed content');
    assert.equal(await readFile(location.manifestPath, 'utf8'), before);
  });
});

test('uninstall rejects --source', async () => {
  const output = await captureConsole(() => main(['uninstall', '--source', '.'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 1);
  assert.match(output.stderr, /uninstall does not accept --source/);
});

test('--model and --model-map require an explicit single --platform', async () => {
  const noPlatform = await captureConsole(() => main(['install', '--model', 'opus', '--yes'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(noPlatform.code, 1);
  assert.match(noPlatform.stderr, /require an explicit single --platform/);

  const allPlatform = await captureConsole(() => main(['install', '--platform', 'all', '--model', 'opus', '--yes'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(allPlatform.code, 1);
  assert.match(allPlatform.stderr, /require an explicit single --platform/);
});

test('--model and --model-map are rejected outside install/update/configure', async () => {
  const output = await captureConsole(() => main(['list', '--model', 'opus'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 1);
  assert.match(output.stderr, /--model and --model-map are only accepted for install, update, and configure/);
});

test('invalid --model-map value is rejected', async () => {
  const output = await captureConsole(() => main(['install', '--platform', 'claude', '--model-map', 'not-a-pair'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 1);
  assert.match(output.stderr, /Invalid --model-map/);
});

test('install --model applies to every supporting artifact on the target platform and persists to model-preferences.json', async () => {
  const root = process.cwd();
  const home = await tempHome();
  await withCwd(root, async () => {
    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--scope', 'user', '--model', 'haiku', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    const forgeContent = await readFile(path.join(home, '.claude', 'agents', 'forge.md'), 'utf8');
    assert.match(forgeContent, /^model: haiku$/m);
    const prefsPath = path.join(home, '.forge', 'state', 'user-model-preferences.json');
    const prefs = JSON.parse(await readFile(prefsPath, 'utf8'));
    assert.equal(prefs.claude.forge, 'haiku');
    assert.equal(prefs.claude['using-forge'], 'haiku');
  });
});

test('install --model-map applies only to the named artifacts', async () => {
  const root = process.cwd();
  const home = await tempHome();
  await withCwd(root, async () => {
    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--scope', 'user', '--model-map', 'forge=haiku,forge-grill=sonnet', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    const forgeContent = await readFile(path.join(home, '.claude', 'agents', 'forge.md'), 'utf8');
    assert.match(forgeContent, /^model: haiku$/m);
    const grillContent = await readFile(path.join(home, '.claude', 'skills', 'forge-grill', 'SKILL.md'), 'utf8');
    assert.match(grillContent, /^model: sonnet$/m);
    const usingForgeContent = await readFile(path.join(home, '.claude', 'skills', 'using-forge', 'SKILL.md'), 'utf8');
    assert.match(usingForgeContent, /^model: sonnet$/m); // untouched, keeps its canonical default
  });
});

test('install --model-map rejects an unknown artifact name', async () => {
  const root = process.cwd();
  const home = await tempHome();
  await withCwd(root, async () => {
    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--model-map', 'bogus=haiku', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 1);
    assert.match(output.stderr, /--model-map references unknown artifact "bogus"/);
  });
});

test('configure rejects --force and --yes', async () => {
  const output = await captureConsole(() => main(['configure', '--platform', 'claude', '--scope', 'user', '--model', 'opus', '--yes'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 1);
  assert.match(output.stderr, /configure does not accept --force or --yes/);
});

test('configure needs --scope non-interactively', async () => {
  const home = await tempHome();
  const output = await captureConsole(() => main(['configure', '--platform', 'claude', '--model', 'opus'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
  assert.equal(output.code, 1);
  assert.match(output.stderr, /configure needs --scope when not run interactively/);
});

test('configure reports nothing installed when the scope has no manifest', async () => {
  const home = await tempHome();
  const output = await captureConsole(() => main(['configure', '--scope', 'user', '--model', 'opus', '--platform', 'claude'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /Nothing installed for user scope/);
});

test('configure needs --model or --model-map non-interactively', async () => {
  const root = process.cwd();
  const home = await tempHome();
  await withCwd(root, async () => {
    assert.equal((await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--scope', 'user', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }))).code, 0);
    const output = await captureConsole(() => main(['configure', '--scope', 'user', '--platform', 'claude'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 1);
    assert.match(output.stderr, /configure needs --model or --model-map when not run interactively/);
  });
});

test('configure changes only the targeted artifact, updates the manifest, and survives a later plain update', async () => {
  const root = process.cwd();
  const home = await tempHome();
  await withCwd(root, async () => {
    assert.equal((await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--scope', 'user', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }))).code, 0);

    const configured = await captureConsole(() => main(['configure', '--scope', 'user', '--platform', 'claude', '--model-map', 'forge=haiku'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(configured.code, 0);
    assert.match(configured.stdout, /Updated 6 file\(s\) with new model preferences/);
    assert.match(await readFile(path.join(home, '.claude', 'agents', 'forge.md'), 'utf8'), /^model: haiku$/m);

    // A later plain `update` must not silently reset the chosen model back to the canonical default.
    const updated = await captureConsole(() => main(['update', '--source', root, '--platform', 'claude', '--scope', 'user'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(updated.code, 0);
    assert.match(await readFile(path.join(home, '.claude', 'agents', 'forge.md'), 'utf8'), /^model: haiku$/m);
  });
});

test('list triggers migration from ~/.forge-ai/ just like install/uninstall do', async () => {
  const home = await tempHome();
  const legacyManifestPath = path.join(home, '.forge-ai', 'user-manifest.json');
  await mkdir(path.dirname(legacyManifestPath), { recursive: true });
  await writeFile(legacyManifestPath, JSON.stringify({ schemaVersion: 1, scope: 'user', updatedAt: new Date(0).toISOString(), entries: [] }));

  const output = await captureConsole(() => main(['list'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  await access(path.join(home, '.forge', 'state', 'user-manifest.json'));
  await access(path.join(home, '.forge-ai', 'MIGRATED'));
});

test('list reports no installs when none exist', async () => {
  const home = await tempHome();
  const output = await captureConsole(() => main(['list'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /No Forge installs recorded/);
});

test('list reports user and project installs with platform, version, and file count', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    assert.equal((await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--scope', 'user'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }))).code, 0);
    assert.equal((await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }))).code, 0);

    const output = await captureConsole(() => main(['list'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    const canonicalRoot = await realpath(root);
    assert.match(output.stdout, /^user: forge \S+, 2 file\(s\), platforms: claude, updated /m);
    assert.match(output.stdout, new RegExp(`^project ${canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: forge \\S+, 2 file\\(s\\), platforms: opencode, updated `, 'm'));
  });
});

test('list rejects flags', async () => {
  const output = await captureConsole(() => main(['list', '--platform', 'claude'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 1);
  assert.match(output.stderr, /list does not accept any flags/);
});

test('warns when a legacy .forge-ai manifest was updated more recently than the current one', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    assert.equal((await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }))).code, 0);

    const location = await resolveManifestLocation('project', root, home);
    const current = JSON.parse(await readFile(location.manifestPath, 'utf8')) as AssetManifest;
    const legacyPath = location.manifestPath.replace(path.join(home, '.forge', 'state'), path.join(home, '.forge-ai'));
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ ...current, updatedAt: new Date(Date.now() + 60_000).toISOString() }));

    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stderr, /An older Forge install at .* was updated more recently/);
  });
});

test('list also warns about legacy state drift, not just install/update/uninstall', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    assert.equal((await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }))).code, 0);

    const location = await resolveManifestLocation('project', root, home);
    const current = JSON.parse(await readFile(location.manifestPath, 'utf8')) as AssetManifest;
    const legacyPath = location.manifestPath.replace(path.join(home, '.forge', 'state'), path.join(home, '.forge-ai'));
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ ...current, updatedAt: new Date(Date.now() + 60_000).toISOString() }));

    const output = await captureConsole(() => main(['list'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stderr, /An older Forge install at .* was updated more recently/);
  });
});

test('configure also warns about legacy state drift', async () => {
  const root = process.cwd();
  const home = await tempHome();
  await withCwd(root, async () => {
    assert.equal((await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--scope', 'user', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }))).code, 0);

    const location = await resolveManifestLocation('user', root, home);
    const current = JSON.parse(await readFile(location.manifestPath, 'utf8')) as AssetManifest;
    const legacyPath = location.manifestPath.replace(path.join(home, '.forge', 'state'), path.join(home, '.forge-ai'));
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ ...current, updatedAt: new Date(Date.now() + 60_000).toISOString() }));

    const output = await captureConsole(() => main(['configure', '--platform', 'claude', '--scope', 'user', '--model', 'haiku'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stderr, /An older Forge install at .* was updated more recently/);
  });
});

test('validate rejects install-only flags', async () => {
  const root = await fixtureRoot();
  const output = await captureConsole(() => main(['validate', '--source', root, '--scope', 'project'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 1);
  assert.match(output.stderr, /validate only accepts --platform and --source/);
});

test('npm bin shim runs the built CLI', async () => {
  const result = await execFile(process.execPath, [path.join(process.cwd(), 'bin', 'forge-ai.mjs'), '--help']);
  assert.match(result.stdout, /Usage: forge-ai install/);
});

test('manifest checksum reflects on-disk content, not pre-write content', async () => {
  const root = await tempDir('forge-fixture-');
  const target = path.join(root, 'artifacts', 'demo', 'demo.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'on-disk-content');
  const location = await resolveManifestLocation('project', root, root);
  const manifest = await buildManifest(location, [{ platform: 'opencode', kind: 'agent', name: 'demo', scope: 'project', path: target, sourcePath: 'artifacts/demo/demo.md', content: 'pre-write-content' }], 'test');
  assert.equal(manifest.entries[0].checksum, sha256('on-disk-content'));
  assert.notEqual(manifest.entries[0].checksum, sha256('pre-write-content'));
});

test('discovers and dry-runs all bundled Forge artifacts', async () => {
  const root = process.cwd();
  const expected = ['forge', 'forge-worker', 'forge-worker-leaf', 'using-forge', 'forge-grill', 'forge-adversary'];
  const discovered = await discoverSources(root);
  assert.equal(discovered.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.deepEqual(new Set(discovered.sources.map((source) => source.expectedName)), new Set(expected));

  const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 6 source\(s\), 6 output\(s\)/);
  assert.match(output.stdout, /\.opencode\/agents\/forge\.md/);
  assert.match(output.stdout, /\.opencode\/agents\/forge-worker\.md/);
  assert.match(output.stdout, /\.opencode\/agents\/forge-worker-leaf\.md/);
  assert.match(output.stdout, /\.opencode\/agents\/forge-adversary\.md/);
  assert.match(output.stdout, /\.opencode\/skills\/using-forge\/SKILL\.md/);
  assert.match(output.stdout, /\.opencode\/skills\/forge-grill\/SKILL\.md/);
});

test('bundled forge artifact installs as a real Claude subagent with a structural dispatch-only allowlist', async () => {
  const root = process.cwd();
  const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 6 source\(s\), 6 output\(s\)/);
  assert.match(output.stdout, /claude agent forge -> .*\.claude\/agents\/forge\.md/);
  assert.doesNotMatch(output.stdout, /\.claude\/skills\/forge\/SKILL\.md/);
  assert.match(output.stdout, /claude agent forge-worker -> .*\.claude\/agents\/forge-worker\.md/);
  assert.match(output.stdout, /claude agent forge-worker-leaf -> .*\.claude\/agents\/forge-worker-leaf\.md/);
  assert.match(output.stdout, /claude agent forge-adversary -> .*\.claude\/agents\/forge-adversary\.md/);
  assert.doesNotMatch(output.stdout, /CLAUDE_UNKNOWN_TOOL/);
  assert.doesNotMatch(output.stdout, /CLAUDE_AGENT_TOOLS_IGNORED/);

  const { artifacts } = await discoverArtifacts(root);
  const forge = artifacts.find((item) => item.name === 'forge')!;
  const rendered = renderClaudeAgent(forge);
  assert.match(rendered.content, /tools: Agent\(forge-worker, forge-adversary\), TodoWrite, Skill, AskUserQuestion/);
  assert.equal(rendered.diagnostics.length, 0);
});

test('bundled Forge direct Codex install includes all six canonical artifacts and diagnostics', async () => {
  const root = process.cwd();
  const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'codex', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 6 source\(s\), 6 output\(s\)/);
  for (const name of ['forge', 'forge-worker', 'forge-worker-leaf', 'forge-adversary']) {
    assert.ok(output.stdout.includes(`codex agent ${name} -> ${path.join(root, '.codex', 'agents', `${name}.toml`)}`));
  }
  for (const name of ['using-forge', 'forge-grill']) {
    assert.ok(output.stdout.includes(`codex skill ${name} -> ${path.join(root, '.agents', 'skills', name, 'SKILL.md')}`));
  }
  assert.match(output.stdout, /CODEX_PARTIAL_AGENT_SUPPORT/);
});

test('bundled worker coordinator grants spawn tools; leaf denies them', async () => {
  const root = process.cwd();
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'project', cwd: root });
  const coordinatorClaude = plan.files.find((f) => f.platform === 'claude' && f.name === 'forge-worker')?.content ?? '';
  const leafClaude = plan.files.find((f) => f.platform === 'claude' && f.name === 'forge-worker-leaf')?.content ?? '';
  const coordinatorGrok = plan.files.find((f) => f.platform === 'grok' && f.name === 'forge-worker')?.content ?? '';
  const leafGrok = plan.files.find((f) => f.platform === 'grok' && f.name === 'forge-worker-leaf')?.content ?? '';
  const coordinatorOpenCode = plan.files.find((f) => f.platform === 'opencode' && f.name === 'forge-worker')?.content ?? '';
  const leafOpenCode = plan.files.find((f) => f.platform === 'opencode' && f.name === 'forge-worker-leaf')?.content ?? '';
  assert.match(coordinatorClaude, /tools:.*Agent/);
  assert.doesNotMatch(leafClaude, /tools:.*Agent/);
  assert.match(coordinatorGrok, /- task\n/);
  assert.doesNotMatch(leafGrok, /- task\n/);
  assert.match(coordinatorOpenCode, /task: allow/);
  assert.match(leafOpenCode, /task: deny/);
});

// Conformance suite (design.md §5.3 / feature-list.json f2-t3): asserts on RENDERED OUTPUT,
// not just frontmatter, so it catches drift in what actually ships, not just what's declared.

test('conformance: forge cannot execute directly on every platform that claims structural enforcement, and Grok stays a known, explicit gap', async () => {
  const root = process.cwd();
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'project', cwd: root });
  const forgeClaude = plan.files.find((f) => f.platform === 'claude' && f.name === 'forge')?.content ?? '';
  const forgeOpenCode = plan.files.find((f) => f.platform === 'opencode' && f.name === 'forge')?.content ?? '';
  const forgeCodex = plan.files.find((f) => f.platform === 'codex' && f.name === 'forge')?.content ?? '';
  const forgeGrok = plan.files.find((f) => f.platform === 'grok' && f.name === 'forge')?.content ?? '';

  // Claude: structural tools allowlist, no direct file/shell tools. Scope the check to the
  // frontmatter's `tools:` line, not the whole body — body prose legitimately says things like
  // "Read .forge/lessons.md" in English, which isn't a tool grant.
  const claudeToolsLine = forgeClaude.split('\n').find((line) => line.startsWith('tools:')) ?? '';
  assert.match(claudeToolsLine, /^tools: Agent\(forge-worker, forge-adversary\), TodoWrite, Skill, AskUserQuestion$/);
  for (const tool of ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'LS', 'WebFetch']) {
    assert.doesNotMatch(claudeToolsLine, new RegExp(`\\b${tool}\\b`), `forge (Claude) must not be granted ${tool}`);
  }

  // OpenCode: structural permission denies.
  for (const tool of ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'list', 'patch', 'webfetch']) {
    assert.match(forgeOpenCode, new RegExp(`${tool}: deny`), `forge (OpenCode) must deny ${tool}`);
  }

  // Codex: explicit read-only sandbox.
  assert.match(forgeCodex, /sandbox_mode = "read-only"/);

  // Grok: KNOWN, DOCUMENTED gap — forge is still a skill here (advisory only), unlike the other
  // three platforms. This test locks in the current, honestly-recorded state (design.md §8's open
  // question) rather than silently passing a check that doesn't verify anything. If this ever
  // flips (Grok gains a real primary-agent mechanism and forge converts), update this assertion
  // alongside the decision record — don't let it drift silently in either direction.
  assert.doesNotMatch(forgeGrok, /disallowedTools|tools:/);
});

test('conformance: every cross-referenced artifact name in every rendered body resolves to a real installed artifact, per platform', async () => {
  const root = process.cwd();
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'project', cwd: root });
  const canonicalNames = new Set(['forge', 'forge-worker', 'forge-worker-leaf', 'forge-adversary', 'using-forge', 'forge-grill']);
  const namePattern = new RegExp(`\\b(${[...canonicalNames].join('|')})\\b`, 'g');

  for (const platform of ['claude', 'opencode', 'codex', 'grok'] as const) {
    const installedNames = new Set(plan.files.filter((f) => f.platform === platform).map((f) => f.name));
    for (const file of plan.files.filter((f) => f.platform === platform)) {
      const referenced = new Set([...file.content.matchAll(namePattern)].map((m) => m[1]));
      for (const name of referenced) {
        assert.ok(installedNames.has(name), `${platform} ${file.name} references "${name}", which is not installed on ${platform}`);
      }
    }
  }
});

const GOLDEN_RENDERERS: Record<string, Record<string, (artifact: CanonicalArtifact) => { content: string }>> = {
  claude: { agent: renderClaudeAgent, skill: renderClaudeSkill },
  codex: { agent: renderCodexAgent, skill: renderCodexSkill },
  grok: { agent: renderGrokAgent, skill: renderGrokSkill },
  opencode: { agent: renderOpenCodeAgent, skill: renderOpenCodeSkill }
};

test('golden fixtures: rendered output per platform matches committed snapshots', async () => {
  const root = process.cwd();
  const { artifacts } = await discoverArtifacts(root);
  for (const platform of ['claude', 'codex', 'grok', 'opencode'] as const) {
    for (const artifact of artifacts) {
      const effectiveKind = artifact[platform]?.kind ?? artifact.kind;
      const composed: CanonicalArtifact = { ...artifact, body: composeBody(artifact.body, platform) };
      const { content } = GOLDEN_RENDERERS[platform][effectiveKind](composed);
      const fixturePath = path.join('tests', 'fixtures', platform, `${artifact.name}.golden`);
      const expected = await readFile(fixturePath, 'utf8');
      assert.equal(content, expected, `${platform}/${artifact.name} drifted from its golden fixture — review the change, then \`npm run generate-fixtures\``);
    }
  }
});

test('conformance: forge-worker names only its own platform\'s spawn tool, never another\'s', async () => {
  const root = process.cwd();
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'project', cwd: root });
  const spawnToolByPlatform: Record<string, string> = { claude: 'Agent', grok: 'task', opencode: 'task' };
  for (const [platform, tool] of Object.entries(spawnToolByPlatform)) {
    const content = plan.files.find((f) => f.platform === platform && f.name === 'forge-worker')!.content;
    assert.match(content, new RegExp(`Spawn \`forge-worker-leaf\` via \`${tool}\``));
  }
  const codexContent = plan.files.find((f) => f.platform === 'codex' && f.name === 'forge-worker')!.content;
  assert.match(codexContent, /Return `DELEGATION_REQUESTS`/);
  assert.doesNotMatch(codexContent, /Spawn `forge-worker-leaf` via `(Agent|task)`/);
});

test('no policy-class dispatch snippet diverges across platforms', () => {
  const platforms = ['claude', 'codex', 'grok', 'opencode'] as const;
  for (const [id, snippet] of Object.entries(DISPATCH_SNIPPETS)) {
    if (snippet.class !== 'policy') continue;
    const resolved = platforms.map((platform) => snippet.text[platform] ?? snippet.text.default);
    assert.ok(resolved.every((text) => text === resolved[0]), `policy-class snippet "${id}" diverges across platforms without a recorded waiver`);
  }
});

test('bundled forge artifact installs as a Grok skill, with worker and adversary as subagents', async () => {
  const root = process.cwd();
  const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'grok', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 6 source\(s\), 6 output\(s\)/);
  assert.match(output.stdout, /grok skill forge -> .*\.grok\/skills\/forge\/SKILL\.md/);
  assert.doesNotMatch(output.stdout, /\.grok\/agents\/forge\.md/);
  assert.match(output.stdout, /grok agent forge-worker -> .*\.grok\/agents\/forge-worker\.md/);
  assert.match(output.stdout, /grok agent forge-worker-leaf -> .*\.grok\/agents\/forge-worker-leaf\.md/);
  assert.match(output.stdout, /grok agent forge-adversary -> .*\.grok\/agents\/forge-adversary\.md/);
  assert.match(output.stdout, /grok skill forge-grill -> .*\.grok\/skills\/forge-grill\/SKILL\.md/);
  assert.match(output.stdout, /grok skill using-forge -> .*\.grok\/skills\/using-forge\/SKILL\.md/);
});

test('compareSemver orders versions numerically', () => {
  assert.equal(compareSemver('0.2.0', '0.3.0') < 0, true);
  assert.equal(compareSemver('0.3.0', '0.3.0'), 0);
  assert.equal(compareSemver('0.10.0', '0.9.0') > 0, true);
  assert.equal(compareSemver('1.0.0', '0.99.99') > 0, true);
});

test('formatVersionNotice is empty for current versions and shows hint when outdated', () => {
  assert.equal(formatVersionNotice({ current: '0.3.0', latest: '0.3.0', isOutdated: false }), '');
  const notice = formatVersionNotice({ current: '0.3.0', latest: '0.4.0', isOutdated: true });
  assert.match(notice, /v0\.3\.0/);
  assert.match(notice, /v0\.4\.0 available/);
  assert.match(notice, /forge-ai self-update/);
});

test('checkLatestVersion uses cache when fresh', async () => {
  const dir = await tempDir('forge-fixture-');
  const cachePath = path.join(dir, 'version-check.json');
  await writeFile(cachePath, JSON.stringify({ checkedAt: '2026-05-17T10:00:00Z', latest: '0.4.0' }));
  let fetchCalls = 0;
  const result = await checkLatestVersion({
    current: '0.3.0',
    cachePath,
    now: new Date('2026-05-17T10:30:00Z'),
    ttlMs: 60 * 60 * 1000,
    fetcher: async () => { fetchCalls += 1; return { ok: true, json: async () => ({ version: '0.5.0' }) }; }
  });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(result, { current: '0.3.0', latest: '0.4.0', isOutdated: true });
});

test('checkLatestVersion refetches when cache is stale and writes new cache', async () => {
  const dir = await tempDir('forge-fixture-');
  const cachePath = path.join(dir, 'version-check.json');
  await writeFile(cachePath, JSON.stringify({ checkedAt: '2026-05-17T08:00:00Z', latest: '0.3.0' }));
  const result = await checkLatestVersion({
    current: '0.3.0',
    cachePath,
    now: new Date('2026-05-17T10:30:00Z'),
    ttlMs: 60 * 60 * 1000,
    fetcher: async () => ({ ok: true, json: async () => ({ version: '0.4.0' }) })
  });
  assert.deepEqual(result, { current: '0.3.0', latest: '0.4.0', isOutdated: true });
  const written = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(written.latest, '0.4.0');
  assert.equal(written.checkedAt, '2026-05-17T10:30:00.000Z');
});

test('checkLatestVersion falls back to stale cache when fetch fails', async () => {
  const dir = await tempDir('forge-fixture-');
  const cachePath = path.join(dir, 'version-check.json');
  await writeFile(cachePath, JSON.stringify({ checkedAt: '2026-05-17T08:00:00Z', latest: '0.3.0' }));
  const result = await checkLatestVersion({
    current: '0.3.0',
    cachePath,
    now: new Date('2026-05-17T10:30:00Z'),
    ttlMs: 60 * 60 * 1000,
    fetcher: async () => { throw new Error('network down'); }
  });
  assert.deepEqual(result, { current: '0.3.0', latest: '0.3.0', isOutdated: false });
});

test('checkLatestVersion returns undefined when there is no cache and fetch fails', async () => {
  const dir = await tempDir('forge-fixture-');
  const cachePath = path.join(dir, 'no-cache.json');
  const result = await checkLatestVersion({
    current: '0.3.0',
    cachePath,
    fetcher: async () => { throw new Error('network down'); }
  });
  assert.equal(result, undefined);
});

test('detectInstallMethod recognizes pnpm, npm, npx, homebrew, unknown', () => {
  assert.equal(detectInstallMethod('/Users/guido/Library/pnpm/global/v11/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs'), 'pnpm-global');
  assert.equal(detectInstallMethod('/Users/guido/.npm/_npx/abc123/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs'), 'npx');
  assert.equal(detectInstallMethod('/opt/homebrew/lib/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs'), 'npm-global-homebrew');
  assert.equal(detectInstallMethod('/usr/local/lib/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs'), 'npm-global');
  assert.equal(detectInstallMethod('/somewhere/odd/forge-ai'), 'unknown');
});

test('buildUpdateCommand produces the right command per install method', () => {
  const pnpm = buildUpdateCommand('pnpm-global');
  assert.equal(pnpm.command, 'pnpm');
  assert.deepEqual(pnpm.args, ['add', '-g', '@guidobuilds/forge-ai@latest', '--prefer-online']);

  const npm = buildUpdateCommand('npm-global', '0.4.0');
  assert.equal(npm.command, 'npm');
  assert.deepEqual(npm.args, ['install', '-g', '@guidobuilds/forge-ai@0.4.0']);

  const brew = buildUpdateCommand('npm-global-homebrew');
  assert.equal(brew.command, '/opt/homebrew/bin/npm');

  const npx = buildUpdateCommand('npx');
  assert.equal(npx.command, '');
  assert.match(npx.instructions ?? '', /No global install/);

  const unknown = buildUpdateCommand('unknown');
  assert.equal(unknown.command, '');
  assert.match(unknown.instructions ?? '', /detect install method/);
});

test('runSelfUpdate dry-run prints command without spawning', async () => {
  const logs: string[] = [];
  let spawnCalls = 0;
  const code = await runSelfUpdate({
    binaryPath: '/Users/guido/Library/pnpm/bin/forge-ai',
    dryRun: true,
    realPathResolver: () => '/Users/guido/Library/pnpm/global/v11/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs',
    spawner: () => { spawnCalls += 1; return { status: 0 }; },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.equal(spawnCalls, 0);
  assert.ok(logs.some((line) => /pnpm global/.test(line)));
  assert.ok(logs.some((line) => /pnpm add -g @guidobuilds\/forge-ai@latest --prefer-online/.test(line)));
  assert.ok(logs.some((line) => /dry-run/.test(line)));
});

test('runSelfUpdate runs the CLI update then the spec update sequentially', async () => {
  const logs: string[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const code = await runSelfUpdate({
    binaryPath: '/Users/guido/Library/pnpm/bin/forge-ai',
    realPathResolver: () => '/Users/guido/Library/pnpm/global/v11/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs',
    spawner: (command, args) => { calls.push({ command, args }); return { status: 0 }; },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'pnpm');
  assert.deepEqual(calls[1], { command: 'forge-ai', args: ['update'] });
});

test('runSelfUpdate skips the spec update with --skip-spec-update', async () => {
  const calls: Array<{ command: string }> = [];
  const code = await runSelfUpdate({
    binaryPath: '/Users/guido/Library/pnpm/bin/forge-ai',
    skipSpecUpdate: true,
    realPathResolver: () => '/Users/guido/Library/pnpm/global/v11/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs',
    spawner: (command) => { calls.push({ command }); return { status: 0 }; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pnpm');
});

test('runSelfUpdate detects install via the symlink path when realpath points elsewhere (pnpm link --global)', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const code = await runSelfUpdate({
    binaryPath: '/Users/guido/Library/pnpm/bin/forge-ai',
    realPathResolver: () => '/Users/guido/dev/forge/bin/forge-ai.mjs',  // local checkout
    spawner: (command, args) => { calls.push({ command, args }); return { status: 0 }; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(calls[0].command, 'pnpm');
});

test('runSelfUpdate surfaces instructions when install method is npx', async () => {
  const logs: string[] = [];
  let spawnCalls = 0;
  const code = await runSelfUpdate({
    binaryPath: '/Users/guido/.npm/_npx/abc/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs',
    realPathResolver: (p) => p,
    spawner: () => { spawnCalls += 1; return { status: 0 }; },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 1);
  assert.equal(spawnCalls, 0);
  assert.ok(logs.some((line) => /No global install/.test(line)));
});

// ---------------------------------------------------------------------------
// Security hardening: A (scope-guard), B (subprocess-guard), M1 (to-version),
// M12 (atomic-write), M2 (corrupt-state), C (opencode-perms).
// ---------------------------------------------------------------------------

test('scope-guard: prune skips out-of-scope manifest entries', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  const victimDir = await tempDir('forge-fixture-');
  const victim = path.join(victimDir, 'victim.txt');
  await writeFile(victim, 'important');
  await withCwd(root, async () => {
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: victim, sourcePath: 'artifacts/stale-agent/stale-agent.md', checksum: sha256('important'), forgeVersion: 'test' }]);
    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /skip unsafe opencode agent stale-agent/);
    assert.equal(await readFile(victim, 'utf8'), 'important'); // victim survives
  });
});

test('scope-guard: uninstall skips out-of-scope manifest entries', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  const victimDir = await tempDir('forge-fixture-');
  const victim = path.join(victimDir, 'victim.txt');
  await writeFile(victim, 'important');
  await withCwd(root, async () => {
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'test-agent', path: victim, sourcePath: 'artifacts/test-agent/test-agent.md', checksum: sha256('important'), forgeVersion: 'test' }]);
    const output = await captureConsole(() => main(['uninstall', '--platform', 'opencode', '--scope', 'project', '--yes'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /skip unsafe opencode agent test-agent/);
    assert.equal(await readFile(victim, 'utf8'), 'important'); // victim survives
  });
});

test('scope-guard: schema-invalid manifest entries are rejected before delete', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const inScope = path.join(root, '.opencode', 'agents', 'victim.md');
    await mkdir(path.dirname(inScope), { recursive: true });
    await writeFile(inScope, 'content');
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'victim', path: inScope, sourcePath: 'artifacts/victim/victim.md', checksum: 'not-a-hex-checksum', forgeVersion: 'test' }]);
    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /skip unsafe opencode agent victim/);
    assert.equal(await readFile(inScope, 'utf8'), 'content'); // survives despite being stale + in-scope
  });
});

test('scope-guard: symlinked out-of-scope path is rejected', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  const victimDir = await tempDir('forge-fixture-');
  const victim = path.join(victimDir, 'victim.txt');
  await writeFile(victim, 'important');
  await withCwd(root, async () => {
    const link = path.join(root, '.opencode', 'agents', 'evil.md');
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(victim, link);
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'evil', path: link, sourcePath: 'artifacts/evil/evil.md', checksum: sha256('important'), forgeVersion: 'test' }]);
    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /skip unsafe opencode agent evil/);
    assert.equal(await readFile(victim, 'utf8'), 'important'); // symlink target survives
  });
});

test('subprocess-guard: resolveExecutable returns absolute path', async () => {
  const binDir = await tempDir('forge-fixture-');
  const tool = path.join(binDir, 'mytool');
  await writeFile(tool, '#!/bin/sh\n');
  await chmod(tool, 0o755);
  const resolved = resolveExecutable('mytool', { path: binDir });
  assert.equal(resolved, tool);
  assert.ok(path.isAbsolute(resolved ?? ''));
  assert.equal(resolveExecutable('does-not-exist', { path: binDir }), undefined);
});

test('subprocess-guard: resolveExecutable rejects binaries inside cwd', async () => {
  const cwd = await tempDir('forge-fixture-');
  const binSubdir = path.join(cwd, 'node_modules', '.bin');
  await mkdir(binSubdir, { recursive: true });
  const shim = path.join(binSubdir, 'opencode');
  await writeFile(shim, '#!/bin/sh\n');
  await chmod(shim, 0o755);
  assert.equal(resolveExecutable('opencode', { cwd, path: binSubdir }), undefined);
  assert.equal(resolveExecutable('opencode', { path: binSubdir }), shim); // resolves when not inside cwd
});

test('subprocess-guard: discovery does not execute a repo-local opencode shim', async () => {
  const shimDir = await tempDir('forge-fixture-');
  const marker = path.join(shimDir, 'PWNED');
  const shim = path.join(shimDir, 'opencode');
  await writeFile(shim, `#!/bin/sh\necho anthropic/claude-sonnet-4\ntouch "${marker}"\n`);
  await chmod(shim, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = shimDir;
  try {
    const models = await discoverOpenCodeModels(shimDir);
    assert.equal(models, undefined);
    await assert.rejects(access(marker)); // marker absent → shim never executed
  } finally {
    process.env.PATH = prevPath;
  }
});

test('subprocess-guard: self-update resolves package managers to absolute paths', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const code = await runSelfUpdate({
    binaryPath: '/Users/guido/Library/pnpm/bin/forge-ai',
    realPathResolver: () => '/Users/guido/Library/pnpm/global/v11/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs',
    resolveCommand: (command) => (command === 'pnpm' ? '/usr/local/bin/pnpm' : command === 'forge-ai' ? '/usr/local/bin/forge-ai' : undefined),
    spawner: (command, args) => { calls.push({ command, args }); return { status: 0 }; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, '/usr/local/bin/pnpm');
  assert.equal(calls[1].command, '/usr/local/bin/forge-ai');
  assert.ok(calls.every((c) => path.isAbsolute(c.command)));
});

test('to-version: isValidVersionSpec accepts semver, v-prefixed semver, and latest', () => {
  assert.equal(isValidVersionSpec('latest'), true);
  assert.equal(isValidVersionSpec('0.4.0'), true);
  assert.equal(isValidVersionSpec('v0.4.0'), true);
  assert.equal(isValidVersionSpec('1.2.3-beta.1+build.5'), true);
  assert.equal(isValidVersionSpec('v1.2.3-rc.1'), true);
  assert.equal(isValidVersionSpec('github:user/repo'), false);
  assert.equal(isValidVersionSpec('^1.0.0'), false);
  assert.equal(isValidVersionSpec('~1.0.0'), false);
  assert.equal(isValidVersionSpec('>=1.0.0 <2.0.0'), false);
  assert.equal(isValidVersionSpec('0.4'), false);
  assert.equal(isValidVersionSpec('beta'), false);
  assert.equal(isValidVersionSpec(''), false);
});

test('to-version: normalizeVersionSpec strips a leading v', () => {
  assert.equal(normalizeVersionSpec('v0.4.0'), '0.4.0');
  assert.equal(normalizeVersionSpec('0.4.0'), '0.4.0');
  assert.equal(normalizeVersionSpec('latest'), 'latest');
});

test('to-version: self-update rejects a non-semver --to value', async () => {
  const output = await captureConsole(() => main(['self-update', '--to', 'github:user/repo'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 1);
  assert.match(output.stderr, /Invalid --to github:user\/repo; expected a semver or "latest"/);
});

test('to-version: self-update accepts semver and latest --to values', async () => {
  for (const spec of ['0.4.0', 'latest', 'v0.4.0']) {
    const output = await captureConsole(() => main(['self-update', '--to', spec], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
    assert.doesNotMatch(output.stderr, /Invalid --to/);
  }
});

test('to-version: v-prefixed --to normalizes to bare semver', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const code = await runSelfUpdate({
    binaryPath: '/Users/guido/Library/pnpm/bin/forge-ai',
    version: 'v0.4.0',
    realPathResolver: () => '/Users/guido/Library/pnpm/global/v11/node_modules/@guidobuilds/forge-ai/bin/forge-ai.mjs',
    spawner: (command, args) => { calls.push({ command, args }); return { status: 0 }; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(calls[0].args, ['add', '-g', '@guidobuilds/forge-ai@0.4.0', '--prefer-online']);
});

test('atomic-write: saveManifest and saveModelPreferences round-trip without temp residue', async () => {
  const dir = await tempDir('forge-home-');
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = { schemaVersion: 2, scope: 'project', forgeVersion: 'test', updatedAt: new Date(0).toISOString(), entries: [] } as AssetManifest;
  await saveManifest(manifestPath, manifest);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);

  const prefsPath = path.join(dir, 'prefs.json');
  await saveModelPreferences(prefsPath, { claude: { forge: 'haiku' } });
  assert.deepEqual(JSON.parse(await readFile(prefsPath, 'utf8')), { claude: { forge: 'haiku' } });

  const entries = await readdir(dir);
  assert.equal(entries.filter((name) => name.includes('.tmp-')).length, 0);
});

test('atomic-write: writeOutputs detects a file changed after classification', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    // main() computes entry paths from process.cwd(), which is the realpath'd cwd (macOS resolves
    // /var → /private/var on chdir) — so use the canonical cwd here to match the manifest entries.
    const cwd = await realpath(root);
    const target = path.join(cwd, '.opencode', 'agents', 'test-agent.md');
    await writeFile(target, 'my edits');
    const location = await resolveManifestLocation('project', cwd, home);
    const manifest = await loadManifest(location.manifestPath);
    const plan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'project', cwd, manifest, checkCollisions: true });
    const file = plan.files.find((f) => f.name === 'test-agent');
    assert.equal(file?.status, 'managed-modified');
    assert.ok(file?.expectedChecksum);
    await writeFile(target, 'changed after classify');
    await assert.rejects(writeOutputs(plan.files), /changed after classification/);
  });
});

test('corrupt-state: loadManifest recovers from malformed JSON without throwing', async () => {
  const home = await tempHome();
  const location = await resolveManifestLocation('user', process.cwd(), home);
  await mkdir(path.dirname(location.manifestPath), { recursive: true });
  await writeFile(location.manifestPath, '{ not valid json');
  const out = await captureConsole(async () => {
    assert.equal(await loadManifest(location.manifestPath), undefined);
    return 0;
  });
  assert.match(out.stderr, /state file corrupt/);
});

test('corrupt-state: loadManifest recovers from non-object JSON shapes without throwing', async () => {
  const home = await tempHome();
  const location = await resolveManifestLocation('user', process.cwd(), home);
  await mkdir(path.dirname(location.manifestPath), { recursive: true });
  for (const junk of ['[1,2,3]', '"hello"', '42', 'null', '{"no":"entries"}']) {
    await writeFile(location.manifestPath, junk);
    assert.equal(await loadManifest(location.manifestPath), undefined);
  }
});

test('corrupt-state: loadModelPreferences recovers from malformed JSON without throwing', async () => {
  const dir = await tempDir('forge-home-');
  const prefsPath = path.join(dir, 'prefs.json');
  await writeFile(prefsPath, '{ bad json');
  const out = await captureConsole(async () => {
    assert.deepEqual(await loadModelPreferences(prefsPath), {});
    return 0;
  });
  assert.match(out.stderr, /state file corrupt/);
  await writeFile(prefsPath, '[1,2,3]');
  assert.deepEqual(await loadModelPreferences(prefsPath), {});
});

test('corrupt-state: bin shim prints a message without a raw stack trace', async () => {
  const home = await tempHome();
  await writeFile(path.join(home, '.forge'), 'not a directory');
  try {
    await execFile(process.execPath, [path.join(process.cwd(), 'bin', 'forge-ai.mjs'), 'install', '--source', path.join(process.cwd(), 'artifacts'), '--platform', 'opencode', '--scope', 'user', '--yes'], { env: { ...process.env, HOME: home } });
    assert.fail('expected the CLI to exit non-zero');
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    assert.ok(stderr.length > 0, 'expected an error message');
    assert.doesNotMatch(stderr, /\n\s+at /); // no raw stack trace frames
  }
});

test('opencode-perms: invalid permission blocks are rejected with a diagnostic', () => {
  const nested: CanonicalArtifact = { ...agent, opencode: { permissions: { bash: { 'git *': 'allow' } } } };
  const rendered = renderOpenCodeAgent(nested);
  assert.doesNotMatch(rendered.content, /permission:/);
  assert.ok(rendered.diagnostics.some((d) => d.code === 'OPENCODE_INVALID_PERMISSIONS'));

  const arrayVal: CanonicalArtifact = { ...agent, opencode: { permissions: ['read'] } };
  assert.ok(renderOpenCodeAgent(arrayVal).diagnostics.some((d) => d.code === 'OPENCODE_INVALID_PERMISSIONS'));
});

test('opencode-perms: oversized permission blocks are rejected', () => {
  const big: Record<string, string> = {};
  for (let i = 0; i < 65; i += 1) big[`tool${i}`] = 'allow';
  const oversized: CanonicalArtifact = { ...agent, opencode: { permissions: big } };
  assert.ok(renderOpenCodeAgent(oversized).diagnostics.some((d) => d.code === 'OPENCODE_INVALID_PERMISSIONS'));
});

test('opencode-perms: allow/deny/boolean permission values are accepted', () => {
  const allowDeny: CanonicalArtifact = { ...agent, opencode: { permissions: { read: 'allow', write: 'deny', edit: 'ask' } } };
  const rendered = renderOpenCodeAgent(allowDeny);
  assert.match(rendered.content, /permission:/);
  assert.equal(rendered.diagnostics.length, 0);

  const boolVal: CanonicalArtifact = { ...agent, opencode: { permissions: { read: true } } };
  assert.match(renderOpenCodeAgent(boolVal).content, /permission:/);
});

async function fixtureRoot(): Promise<string> {
  const root = await tempDir('forge-fixture-');
  await writeArtifact(root, 'test-agent', 'name: test-agent\ndescription: Test agent\nkind: agent', 'Do useful work.');
  await writeArtifact(root, 'test-skill', 'name: test-skill\ndescription: Test skill\nkind: skill', 'Follow instructions.');
  return root;
}

async function writeArtifact(root: string, name: string, frontmatter: string, body = 'Body.'): Promise<void> {
  await mkdir(path.join(root, 'artifacts', name), { recursive: true });
  await writeFile(path.join(root, 'artifacts', name, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function tempHome(): Promise<string> {
  return tempDir('forge-home-');
}

async function tempDir(prefix: 'forge-fixture-' | 'forge-home-' | 'forge-invalid-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map(async (dir) => {
    if (!isTestTempDir(dir)) return;
    await rm(dir, { recursive: true, force: true });
  }));
});

function isTestTempDir(dir: string): boolean {
  const normalized = path.resolve(dir);
  const parent = path.dirname(normalized);
  const name = path.basename(normalized);
  return parent === path.resolve(os.tmpdir()) && /^(forge-fixture-|forge-home-|forge-invalid-)/.test(name);
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

async function writeTestManifest(root: string, home: string, entries: AssetManifest['entries']) {
  const location = await resolveManifestLocation('project', root, home);
  await saveManifest(location.manifestPath, {
    schemaVersion: 2,
    scope: 'project',
    projectPath: root,
    projectPathHash: location.projectPathHash,
    forgeVersion: 'test',
    updatedAt: new Date(0).toISOString(),
    entries
  });
  return location;
}

async function captureConsole(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...args: unknown[]) => { stdout += `${args.join(' ')}\n`; };
  console.error = (...args: unknown[]) => { stderr += `${args.join(' ')}\n`; };
  try {
    const code = await run();
    return { code, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
