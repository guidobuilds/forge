// Regenerates tests/fixtures/<platform>/<name>.golden from the current canonical artifacts/
// source. Run after reviewing the diff (`git diff tests/fixtures`) — a change here means installed
// prose changed, which needs a CHANGELOG entry (see CHANGELOG.md's Unreleased section).
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverArtifacts } from '../dist/src/processor.js';
import { composeBody } from '../dist/src/compose.js';
import { renderClaudeAgent, renderClaudeSkill } from '../dist/src/adapters/claude.js';
import { renderCodexAgent, renderCodexSkill } from '../dist/src/adapters/codex.js';
import { renderGrokAgent, renderGrokSkill } from '../dist/src/adapters/grok.js';
import { renderOpenCodeAgent, renderOpenCodeSkill } from '../dist/src/adapters/opencode.js';

const RENDERERS = {
  claude: { agent: renderClaudeAgent, skill: renderClaudeSkill },
  codex: { agent: renderCodexAgent, skill: renderCodexSkill },
  grok: { agent: renderGrokAgent, skill: renderGrokSkill },
  opencode: { agent: renderOpenCodeAgent, skill: renderOpenCodeSkill }
};

const fixturesRoot = path.join('tests', 'fixtures');
const { artifacts } = await discoverArtifacts(path.resolve('.'));

for (const platform of Object.keys(RENDERERS)) {
  const dir = path.join(fixturesRoot, platform);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const artifact of artifacts) {
    const effectiveKind = artifact[platform]?.kind ?? artifact.kind;
    const composed = { ...artifact, body: composeBody(artifact.body, platform) };
    const { content } = RENDERERS[platform][effectiveKind](composed);
    await writeFile(path.join(dir, `${artifact.name}.golden`), content, 'utf8');
  }
}

const platformCount = Object.keys(RENDERERS).length;
console.log(`Regenerated ${platformCount * artifacts.length} fixtures (${artifacts.length} artifacts x ${platformCount} platforms) under ${fixturesRoot}.`);
