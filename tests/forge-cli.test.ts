import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import { renderClaudeAgent } from '../src/adapters/claude.js';
import { renderCodexAgent, renderCodexSkill } from '../src/adapters/codex.js';
import { renderOpenCodeAgent, renderOpenCodeSkill } from '../src/adapters/opencode.js';
import { main } from '../src/cli.js';
import { discoverSources } from '../src/discovery.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { hashProjectPath, resolveManifestLocation, saveManifest, sha256, type AssetManifest } from '../src/manifest.js';
import { buildWritePlan } from '../src/processor.js';
import { writeOutputs } from '../src/writer.js';
import type { CanonicalAgent, CanonicalSkill } from '../src/model.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

const agent: CanonicalAgent = {
  name: 'test-agent',
  description: 'Test agent',
  definition: 'Do useful work.',
  claude: { permissions: { tools: ['Read', 'Write'] }, model: 'sonnet' },
  opencode: { permissions: { read: true }, model: 'opencode-model', mode: 'subagent' },
  codex: { permissions: { sandbox_mode: 'workspace-write' }, model: 'gpt-5.1' }
};

const skill: CanonicalSkill = {
  name: 'test-skill',
  description: 'Test skill',
  instructions: 'Follow instructions.',
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

test('adapters emit platform-specific outputs', () => {
  assert.match(renderOpenCodeAgent(agent).content, /mode: subagent/);
  assert.match(renderOpenCodeAgent(agent).content, /permission:/);
  assert.doesNotMatch(renderOpenCodeAgent(agent).content, /tools:/);
  assert.match(renderOpenCodeSkill(skill).content, /name: test-skill/);
  assert.match(renderOpenCodeSkill(skill).diagnostics[0].code, /OPENCODE_SKILL_MODEL_IGNORED/);
  assert.match(renderClaudeAgent(agent).content, /tools: \[Read, Write\]/);
  assert.match(renderCodexAgent(agent).content, /developer_instructions =/);
  assert.match(renderCodexAgent(agent).content, /sandbox_mode = "workspace-write"/);
  assert.match(renderCodexSkill(skill).content, /name: test-skill/);
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
  await mkdir(path.join(root, 'agents'), { recursive: true });
  await writeFile(path.join(root, 'agents', 'other.md'), '---\nname: bad_name\ndescription: Bad\nmode: subagent\nclaude:\n  model: true\nopencode:\n  mode: invalid\n---\n\nBody\n');
  const plan = await buildWritePlan({ source: root, platform: 'opencode', scope: 'project', cwd: root });
  assert.ok(plan.diagnostics.some((item) => item.code === 'UNSUPPORTED_FIELD'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'INVALID_NAME'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'INVALID_PLATFORM_MODEL'));
  assert.ok(plan.diagnostics.some((item) => item.code === 'INVALID_OPENCODE_MODE'));
});

test('overwrite safety blocks without force and writes with force', async () => {
  const root = await fixtureRoot();
  const target = path.join(root, '.opencode', 'agents', 'test-agent.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'existing');
  const blocked = await buildWritePlan({ source: root, platform: 'opencode', scope: 'project', cwd: root, checkCollisions: true });
  assert.ok(blocked.diagnostics.some((item) => item.code === 'DESTINATION_EXISTS'));
  const forced = await buildWritePlan({ source: root, platform: 'opencode', scope: 'project', cwd: root, checkCollisions: true, force: true });
  assert.equal(forced.diagnostics.some((item) => item.severity === 'error'), false);
  await writeOutputs(forced.files);
  assert.match(await readFile(target, 'utf8'), /Do useful work/);
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
  assert.match(output.stdout, /install: 5 source\(s\), 5 output\(s\)/);
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
    assert.match(output.stdout, /OVERWRITE_FORCED/);
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
    assert.match(output.stdout, /OVERWRITE_FORCED/);
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
    assert.ok(manifest.entries.some((entry) => entry.sourcePath === path.join('agents', 'test-agent.md')));
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
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'agents/stale-agent.md', checksum: sha256('stale') }]);

    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /delete stale opencode agent stale-agent/);
    await assert.rejects(access(stalePath));
    assert.equal(await readFile(customPath, 'utf8'), 'custom');
  });
});

test('update skips stale manifest entry when checksum differs', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const stalePath = path.join(root, '.opencode', 'agents', 'stale-agent.md');
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, 'local edit');
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'agents/stale-agent.md', checksum: sha256('stale') }]);

    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: { HOME: home } as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /CHECKSUM_MISMATCH/);
    assert.equal(await readFile(stalePath, 'utf8'), 'local edit');
  });
});

test('update --no-prune preserves stale managed files', async () => {
  const root = await fixtureRoot();
  const home = await tempHome();
  await withCwd(root, async () => {
    const stalePath = path.join(root, '.opencode', 'agents', 'stale-agent.md');
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, 'stale');
    await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'agents/stale-agent.md', checksum: sha256('stale') }]);

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
    const location = await writeTestManifest(root, home, [{ platform: 'opencode', kind: 'agent', name: 'stale-agent', path: stalePath, sourcePath: 'agents/stale-agent.md', checksum: sha256('stale') }]);
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

test('discovers and dry-runs all bundled Forge skills', async () => {
  const root = process.cwd();
  const expected = ['using-forge', 'forge-worker', 'forge-grill'];
  const discovered = await discoverSources(root);
  assert.equal(discovered.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.deepEqual(new Set(discovered.sources.filter((source) => source.kind === 'skill').map((source) => source.expectedName)), new Set(expected));

  const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 5 source\(s\), 5 output\(s\)/);
  for (const name of expected) assert.match(output.stdout, new RegExp(`\\.opencode/skills/${name}/SKILL\\.md`));
});

async function fixtureRoot(): Promise<string> {
  const root = await tempDir('forge-fixture-');
  await mkdir(path.join(root, 'agents'), { recursive: true });
  await mkdir(path.join(root, 'skills', 'test-skill'), { recursive: true });
  await writeFile(path.join(root, 'agents', 'test-agent.md'), '---\nname: test-agent\ndescription: Test agent\n---\n\nDo useful work.\n');
  await writeFile(path.join(root, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: Test skill\n---\n\nFollow instructions.\n');
  return root;
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
