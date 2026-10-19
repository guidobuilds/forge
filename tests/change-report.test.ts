import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Mechanical + behavioral validation of the `forge-change-report` skill's embedded HTML template.
// The template is a string inside the skill markdown, so these tests extract it the same way a
// consumer would (fenced ```html block) and then exercise the DOM-free `forge-report-core` slice.

const reportPath = path.join('artifacts', 'forge-change-report', 'forge-change-report.md');
const allowedKinds = ['added', 'modified', 'removed', 'context', 'functionality'];

type ReportNode = { id: string; kind: string; label: string; path: string; summary: string };
type ReportEdge = { from: string; to: string; level: number; relation: string };
type ReportData = { nodes: ReportNode[]; edges: ReportEdge[] };
type Core = {
  escapeHtml: (value: unknown) => string;
  validateAndLink: (data: unknown) => ReportData;
  filterByKind: (nodes: ReportNode[], kind: string) => ReportNode[];
  renderGraphToSvgString: (nodes: ReportNode[], edges: ReportEdge[], options?: { expanded?: boolean }) => string;
  serializeReportData: (data: unknown) => string;
};

async function loadTemplate(): Promise<string> {
  const raw = await readFile(reportPath, 'utf8');
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---', 4);
  assert.notEqual(end, -1, 'change-report artifact must have frontmatter');
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1).trim();
  const match = body.match(/```html\n([\s\S]*?)\n```/);
  assert.ok(match, 'change-report body must contain a fenced ```html template');
  return match[1];
}

function loadData(template: string): unknown {
  const match = template.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/);
  assert.ok(match, 'template must contain the report-data JSON island');
  return JSON.parse(match[1]);
}

function loadCore(template: string): Core {
  const match = template.match(/\/\* forge-report-core:start \*\/([\s\S]*?)\/\* forge-report-core:end \*\//);
  assert.ok(match, 'template must contain the forge-report-core block');
  const factory = new Function(`${match[1]}\nreturn { escapeHtml, validateAndLink, filterByKind, renderGraphToSvgString, serializeReportData };`);
  return factory() as Core;
}

test('change-report: template is a single self-contained file with no external references', async () => {
  const template = await loadTemplate();
  assert.doesNotMatch(template, /https?:\/\//, 'template must not reference any absolute URL');
  assert.doesNotMatch(template, /<link\b/i, 'template must not link external stylesheets');
  assert.doesNotMatch(template, /\bsrc\s*=/i, 'template must not load external scripts/images via src=');
  assert.doesNotMatch(template, /@import/, 'template must not @import a stylesheet');
  assert.doesNotMatch(template, /url\(\s*["']?https?:/i, 'template CSS must not fetch a remote resource');
  assert.match(template, /forge-report-core:start/);
  assert.match(template, /forge-report-core:end/);
  const island = template.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/);
  assert.ok(island, 'template must contain the report-data JSON island');
  assert.ok(!island[1].includes('<'), 'the JSON island must not contain a raw < that could break out of the script element');
});

test('change-report: the embedded data island is structurally integral', async () => {
  const template = await loadTemplate();
  const data = loadData(template) as ReportData;
  assert.ok(Array.isArray(data.nodes) && data.nodes.length > 0, 'data island must contain nodes');
  const ids = new Set(data.nodes.map((node) => node.id));
  for (const node of data.nodes) {
    assert.ok(allowedKinds.includes(node.kind), `node ${node.id} has out-of-vocabulary kind ${node.kind}`);
  }
  for (const edge of data.edges) {
    assert.ok(ids.has(edge.from), `edge references unknown source node ${edge.from}`);
    assert.ok(ids.has(edge.to), `edge references unknown target node ${edge.to}`);
    assert.ok(edge.level === 1 || edge.level === 2, `edge ${edge.from}->${edge.to} must have level 1 or 2`);
  }
});

test('change-report: core escapes hostile labels, filters by kind, and tolerates unknown kinds', async () => {
  const template = await loadTemplate();
  const core = loadCore(template);

  const escapedScript = core.escapeHtml('<script>x</script>');
  assert.ok(!escapedScript.includes('<'), 'escapeHtml must not leave raw < in its output');
  assert.ok(escapedScript.includes('&lt;script&gt;'), 'escapeHtml must encode angle brackets');

  const data = loadData(template) as ReportData;
  const linked = core.validateAndLink(data);
  for (const kind of allowedKinds) {
    const expected = data.nodes.filter((node) => node.kind === kind).length;
    assert.equal(core.filterByKind(linked.nodes, kind).length, expected, `filterByKind(${kind}) must return exactly the matching nodes`);
    assert.ok(core.filterByKind(linked.nodes, kind).every((node) => node.kind === kind));
  }

  let unknown: ReportData | undefined;
  assert.doesNotThrow(() => { unknown = core.validateAndLink({ nodes: [{ id: 'x', kind: 'nonsense', label: 'X' }], edges: [] }); });
  assert.equal(unknown?.nodes[0]?.kind, 'context', 'an unknown kind must degrade to context, not throw');
});

test('change-report: core renders one node per node and one line per visible level-1 edge', async () => {
  const template = await loadTemplate();
  const core = loadCore(template);
  const data: ReportData = {
    nodes: [
      { id: 'a', kind: 'added', label: 'A', path: 'a.ts', summary: '' },
      { id: 'b', kind: 'modified', label: 'B', path: 'b.ts', summary: '' },
      { id: 'c', kind: 'removed', label: 'C', path: 'c.ts', summary: '' },
      { id: 'd', kind: 'context', label: 'D', path: 'd.ts', summary: '' },
      { id: 'e', kind: 'functionality', label: 'E', path: 'e.ts', summary: '' }
    ],
    edges: [
      { from: 'a', to: 'b', level: 1, relation: 'calls' },
      { from: 'd', to: 'a', level: 1, relation: 'calls' },
      { from: 'c', to: 'b', level: 2, relation: 'previously-called' }
    ]
  };
  const linked = core.validateAndLink(data);

  const collapsed = core.renderGraphToSvgString(linked.nodes, linked.edges);
  assert.equal((collapsed.match(/data-node-id=/g) ?? []).length, 5, 'one graph node element per node');
  assert.equal((collapsed.match(/<line /g) ?? []).length, 2, 'one line per level-1 edge, level-2 hidden by default');

  const expanded = core.renderGraphToSvgString(linked.nodes, linked.edges, { expanded: true });
  assert.equal((expanded.match(/<line /g) ?? []).length, 3, 'level-2 edge becomes visible when expanded');
});

test('change-report: a hostile label injected into the data island renders escaped in the produced graph', async () => {
  const template = await loadTemplate();
  const core = loadCore(template);
  const hostile = '<img src=x onerror=alert(1)>';
  const linked = core.validateAndLink({
    nodes: [{ id: 'evil', kind: 'added', label: hostile, path: 'evil.ts', summary: hostile }],
    edges: []
  });
  const svg = core.renderGraphToSvgString(linked.nodes, linked.edges);
  assert.ok(!svg.includes('<img'), 'hostile markup must not survive as executable/raw markup');
  assert.ok(!svg.includes(hostile), 'the raw hostile label must not appear verbatim in the graph output');
  assert.ok(svg.includes('&lt;img'), 'hostile label must be HTML-escaped');
});

test('change-report: hostile script-breakout and attribute payloads cannot escape the island or SVG attributes', async () => {
  const template = await loadTemplate();
  const core = loadCore(template);

  const breakout = '</script><script>alert(1)</script>';
  const serialized = core.serializeReportData({ nodes: [{ id: 'evil', kind: 'added', label: breakout, path: '', summary: '' }] });
  assert.ok(!serialized.includes('</script>'), 'serialized island must not contain a raw script terminator');
  assert.ok(!serialized.includes('<'), 'serialized island must not contain any raw <');
  assert.equal(JSON.parse(serialized).nodes[0].label, breakout, 'serialized data must round-trip the original string unchanged');

  const attrHostile = 'x" onmouseover="alert(1)';
  const linked = core.validateAndLink({ nodes: [{ id: attrHostile, kind: 'added', label: attrHostile, path: 'p', summary: '' }], edges: [] });
  const svg = core.renderGraphToSvgString(linked.nodes, linked.edges);
  assert.ok(!svg.includes('onmouseover="alert(1)'), 'a hostile id must not produce a live event attribute');
  assert.ok(svg.includes('&quot;'), 'attribute-breaking quotes must be escaped');
});

// Parser-level guard. The tests above regex-extract the forge-report-core slice and execute it via
// `new Function(...)`, which runs the text as JavaScript and structurally bypasses HTML script-element
// parsing. Per the HTML script-data tokenizer the first `</script` sequence ends the `<script>` element
// — comments are not exempt — so a literal terminator inside the core script's own text makes the
// browser drop everything after it. These tests assert what the parser actually sees.

function parsedScriptBodies(template: string): string[] {
  const bodies: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) bodies.push(match[1]);
  return bodies;
}

test('change-report: the HTML parser sees exactly two complete script elements (no early </script> break)', async () => {
  const template = await loadTemplate();

  const terminators = template.match(/<\/script/gi) ?? [];
  assert.equal(
    terminators.length,
    2,
    'the template must contain exactly two </script terminators (data island + core); any extra one inside the core script terminates it early',
  );

  const bodies = parsedScriptBodies(template);
  assert.equal(bodies.length, 2, 'the HTML parser must see exactly two <script> elements');

  const island = bodies[0].trim();
  assert.ok(island.startsWith('{') && island.endsWith('}'), 'the first script body must be the JSON data island');
  JSON.parse(island); // the parsed island must be complete, well-formed JSON

  const core = bodies[1];
  assert.match(core, /forge-report-core:start/, 'the parsed core script must contain the core start marker');
  assert.match(
    core,
    /forge-report-core:end/,
    'the parsed core script must reach the core end marker — a premature </script> truncates it before this',
  );
  assert.match(core, /function serializeReportData/, 'the parsed core must define serializeReportData');
  assert.match(core, /function validateAndLink/, 'the parsed core must define validateAndLink');
  assert.match(core, /function filterByKind/, 'the parsed core must define filterByKind');
  assert.match(core, /function renderGraphToSvgString/, 'the parsed core must define renderGraphToSvgString');
  assert.match(core, /document\.getElementById\('report-data'\)/, 'the parsed core must contain the wiring IIFE');
  assert.match(core, /\bdraw\(\);/, 'the parsed core must invoke the wiring (draw) at load');
});

// Browser smoke guard. A regex/`new Function` test can never prove the template is a valid, executable
// HTML document; only a real HTML parser + JS engine can. Uses a pre-installed headless Chrome/Chromium
// with a local file:// URL, no network, and no new dependency — skipped cleanly when none is present.
const chromeCandidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const chromePath = chromeCandidates.find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate));
const execFileAsync = promisify(execFile);

test(
  'change-report: the template executes in a real browser and the graph/filters/header populate',
  { skip: chromePath ? false : 'no headless Chrome/Chromium found' },
  async () => {
    const template = await loadTemplate();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'forge-change-report-'));
    const file = path.join(dir, 'report.html');
    try {
      await writeFile(file, template, 'utf8');
      const { stdout } = await execFileAsync(
        chromePath as string,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${path.join(dir, 'profile')}`,
          '--virtual-time-budget=4000',
          '--dump-dom',
          pathToFileURL(file).href,
        ],
        { maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
      );
      const dom = String(stdout);
      // Only a parsed-and-executed script populates the DOM this way; inert script text cannot:
      // the island ids (n-*) exist nowhere in the script source, and the wiring builds the buttons/header.
      const renderedNodes = (dom.match(/data-node-id="n-/g) ?? []).length;
      assert.equal(renderedNodes, 5, `the browser must render one graph node per island node (saw ${renderedNodes})`);
      assert.match(dom, /status:\s*success/, 'the wiring must populate the status line');
      assert.match(dom, /class="filter"/, 'the wiring must create the per-kind filter buttons');
      assert.match(dom, />example-feature</, 'the wiring must populate the feature-name header');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
