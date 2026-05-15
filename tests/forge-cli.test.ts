import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import { renderClaudeAgent, renderClaudeSkill } from '../src/adapters/claude.js';
import { renderCodexAgent, renderCodexSkill } from '../src/adapters/codex.js';
import { renderOpenCodeAgent, renderOpenCodeSkill } from '../src/adapters/opencode.js';
import { main } from '../src/cli.js';
import { discoverSources } from '../src/discovery.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { buildManifest, hashProjectPath, resolveManifestLocation, saveManifest, sha256, type AssetManifest } from '../src/manifest.js';
import { buildWritePlan } from '../src/processor.js';
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
  codex: { permissions: { sandbox_mode: 'workspace-write' }, model: 'gpt-5.1' }
};

const skill: CanonicalArtifact = {
  name: 'test-skill',
  description: 'Test skill',
  kind: 'skill',
  body: 'Follow instructions.',
  sourcePath: 'artifacts/test-skill/test-skill.md',
  claude: { permissions: { 'allowed-tools': ['Read'] } },
  opencode: { model: 'ignored' },
  codex: { permissions: { any: true } }
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

test('claude skill drops model and emits ignored diagnostic', () => {
  const withModel: CanonicalArtifact = { name: 's', description: 'd', kind: 'skill', body: 'i', sourcePath: 'artifacts/s/s.md', claude: { model: 'opus' } };
  const rendered = renderClaudeSkill(withModel);
  assert.doesNotMatch(rendered.content, /model:/);
  assert.ok(rendered.diagnostics.some((item) => item.code === 'CLAUDE_SKILL_MODEL_IGNORED'));
});

test('processor validates sources and generates dry-run plan paths', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'user', home, cwd: root });
  assert.equal(plan.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.equal(plan.files.length, 6);
  assert.ok(plan.files.some((file) => file.path.endsWith('.config/opencode/agents/test-agent.md')));
  assert.ok(plan.files.some((file) => file.path.endsWith('.codex/agents/test-agent.toml')));
  assert.ok(plan.files.some((file) => file.path.endsWith('.agents/skills/test-skill/SKILL.md')));
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

test('per-platform kind override renders the alternate artifact kind', async () => {
  const root = await tempDir('forge-fixture-');
  const home = await tempHome();
  await writeArtifact(root, 'dual', 'name: dual\ndescription: Dual artifact\nkind: agent\nclaude:\n  kind: skill');
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'user', home, cwd: root });
  assert.equal(plan.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.ok(plan.files.some((file) => file.platform === 'claude' && file.kind === 'skill' && file.path.endsWith('.claude/skills/dual/SKILL.md')));
  assert.ok(plan.files.some((file) => file.platform === 'opencode' && file.kind === 'agent' && file.path.endsWith('.config/opencode/agents/dual.md')));
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
    assert.match(output.stdout, /\[overwrite, backup -> .+\.forge-ai\/backups\/projects\//);
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
    const stateRoot = path.join(home, '.forge-ai', 'backups');
    await assert.rejects(access(stateRoot));
  });
});

test('install keeps non-interactive defaults when no flags are provided', async () => {
  const root = await fixtureRoot();
  const output = await captureConsole(() => main(['install', '--source', root, '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 2 source\(s\), 6 output\(s\)/);
  assert.match(output.stdout, /\.config\/opencode\/agents\/test-agent\.md/);
  assert.match(output.stdout, /\.agents\/skills\/test-skill\/SKILL\.md/);
});

test('install uses bundled Forge sources when --source is omitted', async () => {
  const output = await captureConsole(() => main(['install', '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 4 source\(s\), 4 output\(s\)/);
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
    assert.equal(path.dirname(path.dirname(path.dirname(location.manifestPath))), path.join(home, '.forge-ai'));
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
    assert.equal(path.dirname(path.dirname(path.dirname(location.manifestPath))), path.join(home, '.forge-ai'));
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
  assert.equal(location.manifestPath, path.join(home, '.forge-ai', 'projects', location.projectPathHash!, 'manifest.json'));
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
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.scope, 'project');
    assert.equal(manifest.projectPath, canonicalRoot);
    assert.equal(manifest.projectPathHash, location.projectPathHash);
    assert.equal(manifest.entries.length, 2);
    assert.ok(manifest.entries.some((entry) => entry.sourcePath === path.join('artifacts', 'test-agent', 'test-agent.md')));
  });
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
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'artifacts/stale-agent/stale-agent.md', checksum: sha256('stale') }]);

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
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'artifacts/stale-agent/stale-agent.md', checksum: sha256('stale') }]);

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
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'artifacts/stale-agent/stale-agent.md', checksum: sha256('stale') }]);

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
    const location = await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'artifacts/stale-agent/stale-agent.md', checksum: sha256('stale') }]);
    const before = await readFile(location.manifestPath, 'utf8');

    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /delete stale opencode agent stale-agent/);
    assert.equal(await readFile(stalePath, 'utf8'), 'stale');
    assert.equal(await readFile(location.manifestPath, 'utf8'), before);
    await assert.rejects(access(path.join(root, '.opencode', 'agents', 'test-agent.md')));
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
  const manifest = await buildManifest(location, [{ platform: 'opencode', kind: 'agent', name: 'demo', scope: 'project', path: target, sourcePath: 'artifacts/demo/demo.md', content: 'pre-write-content' }]);
  assert.equal(manifest.entries[0].checksum, sha256('on-disk-content'));
  assert.notEqual(manifest.entries[0].checksum, sha256('pre-write-content'));
});

test('discovers and dry-runs all bundled Forge artifacts', async () => {
  const root = process.cwd();
  const expected = ['forge', 'forge-worker', 'using-forge', 'forge-grill'];
  const discovered = await discoverSources(root);
  assert.equal(discovered.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.deepEqual(new Set(discovered.sources.map((source) => source.expectedName)), new Set(expected));

  const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 4 source\(s\), 4 output\(s\)/);
  assert.match(output.stdout, /\.opencode\/agents\/forge\.md/);
  assert.match(output.stdout, /\.opencode\/agents\/forge-worker\.md/);
  assert.match(output.stdout, /\.opencode\/skills\/using-forge\/SKILL\.md/);
  assert.match(output.stdout, /\.opencode\/skills\/forge-grill\/SKILL\.md/);
});

test('bundled forge artifact installs as a Claude skill, not a subagent', async () => {
  const root = process.cwd();
  const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'claude', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 4 source\(s\), 4 output\(s\)/);
  assert.match(output.stdout, /claude skill forge -> .*\.claude\/skills\/forge\/SKILL\.md/);
  assert.doesNotMatch(output.stdout, /\.claude\/agents\/forge\.md/);
  assert.match(output.stdout, /claude agent forge-worker -> .*\.claude\/agents\/forge-worker\.md/);
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
    schemaVersion: 1,
    scope: 'project',
    projectPath: root,
    projectPathHash: location.projectPathHash,
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
