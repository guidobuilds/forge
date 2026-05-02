import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { renderClaudeAgent } from '../src/adapters/claude.js';
import { renderCodexAgent, renderCodexSkill } from '../src/adapters/codex.js';
import { renderOpenCodeAgent, renderOpenCodeSkill } from '../src/adapters/opencode.js';
import { main } from '../src/cli.js';
import { discoverSources } from '../src/discovery.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { buildWritePlan } from '../src/processor.js';
import { writeOutputs } from '../src/writer.js';
import type { CanonicalAgent, CanonicalSkill } from '../src/model.js';

const execFile = promisify(execFileCallback);

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
  const home = await mkdtemp(path.join(os.tmpdir(), 'forge-home-'));
  const plan = await buildWritePlan({ source: root, platform: 'all', scope: 'user', home, cwd: root });
  assert.equal(plan.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.equal(plan.files.length, 6);
  assert.ok(plan.files.some((file) => file.path.endsWith('.config/opencode/agents/test-agent.md')));
  assert.ok(plan.files.some((file) => file.path.endsWith('.codex/agents/test-agent.toml')));
  assert.ok(plan.files.some((file) => file.path.endsWith('.agents/skills/test-skill/SKILL.md')));
});

test('processor rejects invalid fields and name mismatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-invalid-'));
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
  assert.match(output.stdout, /install: 9 source\(s\), 9 output\(s\)/);
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
  await withCwd(root, async () => {
    const target = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'existing');

    const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--force'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /OVERWRITE_FORCED/);
    assert.match(await readFile(target, 'utf8'), /Do useful work/);
  });
});

test('update overwrites existing outputs without a separate force flag', async () => {
  const root = await fixtureRoot();
  await withCwd(root, async () => {
    const target = path.join(root, '.opencode', 'agents', 'test-agent.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'existing');

    const output = await captureConsole(() => main(['update', '--source', root, '--platform', 'opencode', '--scope', 'project'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
    assert.equal(output.code, 0);
    assert.match(output.stdout, /update: 2 source\(s\), 2 output\(s\)/);
    assert.match(output.stdout, /OVERWRITE_FORCED/);
    assert.match(await readFile(target, 'utf8'), /Do useful work/);
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
  const expected = ['using-forge', 'forge-worker', 'forge-explore', 'forge-design', 'forge-plan', 'forge-build', 'forge-helper'];
  const discovered = await discoverSources(root);
  assert.equal(discovered.diagnostics.filter((item) => item.severity === 'error').length, 0);
  assert.deepEqual(new Set(discovered.sources.filter((source) => source.kind === 'skill').map((source) => source.expectedName)), new Set(expected));

  const output = await captureConsole(() => main(['install', '--source', root, '--platform', 'opencode', '--scope', 'project', '--dry-run'], { isInteractive: false, env: {} as NodeJS.ProcessEnv }));
  assert.equal(output.code, 0);
  assert.match(output.stdout, /install: 9 source\(s\), 9 output\(s\)/);
  for (const name of expected) assert.match(output.stdout, new RegExp(`\\.opencode/skills/${name}/SKILL\\.md`));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-fixture-'));
  await mkdir(path.join(root, 'agents'), { recursive: true });
  await mkdir(path.join(root, 'skills', 'test-skill'), { recursive: true });
  await writeFile(path.join(root, 'agents', 'test-agent.md'), '---\nname: test-agent\ndescription: Test agent\n---\n\nDo useful work.\n');
  await writeFile(path.join(root, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: Test skill\n---\n\nFollow instructions.\n');
  return root;
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
