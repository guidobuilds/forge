---
name: forge-change-report
description: Produce a self-contained interactive HTML change report for a non-trivial feature build — added/modified/removed architecture, first-level connections, and impacted functionalities — so agent modifications preserve developer architectural knowledge.
kind: skill
claude:
  when_to_use: Loaded by forge-worker at the closure of a non-trivial build that modified project source files (required even on partial/blocked), to write .forge/<feature-slug>/change-report.html.
  user-invocable: false
---

# Forge Change Report Skill

## Role

Produce the human-facing change report for a feature build: one self-contained interactive HTML file at `.forge/<feature-slug>/change-report.html` that shows what changed architecturally, how the changed pieces connect, and which important functionalities were affected. It exists so a developer does not have to reconstruct architectural knowledge from a diff after an agent modifies the code.

## Trigger policy

- Mandatory whenever a build under a feature slug modified project source files.
- Required even when the build returns `partial` or `blocked`: the report reflects the actual working tree and separates implemented work from planned-but-unimplemented work.
- Exempt for read-only work (`inspect`/`verify` with no changes), `operate`, and trivial/surgical changes (see `using-forge` state model).

## Output convention

- Write exactly one file: `.forge/<feature-slug>/change-report.html`.
- Present it to the user as a local file path/link — it is a local artifact, not a hosted UI or a host capability.

## Not this

This is not `session-handoff.md` (operational continuation state) and not a CHANGELOG entry. It is an architectural diff explainer for a human.

## Report spec

- Honest header: feature slug, date, repo, and build status (`success` / `partial` / `blocked`).
- Architecture graph: `added`, `modified`, and `removed` nodes, plus first-level `context`.
- Important functionalities: each with the impact the change had on it.
- Key files / entry points touched.
- Removed-behavior notes: what no longer happens and what replaced it, or "nothing removed".

## Graph data model

- `nodes[]`: `{ id, kind, label, path, summary }`. `kind` is one of `added | modified | removed | context | functionality`.
- `edges[]`: `{ from, to, level, relation }`. `level` is `1` (a real first-level connection between changed pieces) or `2` (a second-level connection).
- `context` nodes are first-level only and rendered muted; `removed` nodes are struck through; `functionality` nodes describe impacted important functionality.
- Second-level (`level: 2`) edges stay hidden by default and are promoted to visible (click-to-expand) only when the change is truly complex: more than 12 first-level nodes, or 3+ distinct subsystems.
- Derive the graph from the actual `git status` / `git diff` and the build log — the real working tree, never the plan.

## Constraints

- A single file with zero network requests: inline CSS and JS, no external references, vanilla JS only.
- System font stack; `prefers-reduced-motion` respected.
- Accessibility: shape + label + legend redundancy, keyboard-focusable nodes, `aria-label`s; all repo-derived strings escaped through the template's `escapeHtml`.
- Keep the `forge-report-core` function block verbatim; replace only the JSON in the `report-data` island, serialized via `serializeReportData` so a repo-derived label containing `</script>` cannot terminate the island early.

## Procedure

1. Read `git status` / `git diff` and `.forge/<feature-slug>/build-log.md`; list the changed entities and integrations.
2. For each changed entity, record its kind, label, path, summary, and its first-level connections.
3. Record the important functionalities the change impacts.
4. Replace the `report-data` JSON island with `serializeReportData(data)`; leave the core block unchanged.
5. Write the result to `.forge/<feature-slug>/change-report.html` and report that path in `SUMMARY` / `ARTIFACTS`.
6. Update the report on every build run of the slug.

## Template

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge change report</title>
<style>
:root{--bg:#0f1117;--panel:#171a22;--ink:#e6e8ee;--muted:#9aa3b2;--line:#2a2f3a;--added:#3fb950;--modified:#d29922;--removed:#f85149;--context:#6e7681;--functionality:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{padding:20px 24px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0 0 6px}
.meta{color:var(--muted);font-size:13px;display:flex;gap:16px;flex-wrap:wrap}
.status{font-weight:600}
.status-success{color:var(--added)}.status-partial{color:var(--modified)}.status-blocked{color:var(--removed)}
main{padding:20px 24px;display:grid;gap:20px;grid-template-columns:minmax(0,1fr) 300px}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.filter{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.filter[aria-pressed="true"]{border-color:var(--functionality);color:var(--functionality)}
.filter:focus-visible,.node:focus-visible{outline:2px solid var(--functionality);outline-offset:2px}
#expand{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.graph{width:100%;height:auto;display:block}
.edge{stroke:var(--context);stroke-width:1.5;opacity:.75}
.edge-level-2{stroke-dasharray:5 4;stroke:var(--muted)}
.shape{fill:none;stroke-width:2;stroke:var(--context)}
.shape-added{stroke:var(--added)}.shape-modified{stroke:var(--modified)}.shape-removed{stroke:var(--removed)}.shape-context{stroke:var(--context);stroke-dasharray:5 4}
.shape-functionality{stroke:var(--functionality);fill:rgba(88,166,255,.12)}
.node{cursor:pointer}
.node text{fill:var(--ink);font-size:12px}
.node .node-kind{fill:var(--muted);font-size:10px}
.node-removed .node-label{text-decoration:line-through}
.node-context{opacity:.6}
#detail h2,#functionalities h2{font-size:14px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
#detail .detail-label{font-weight:600}
#detail .detail-path{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
.legend{list-style:none;margin:12px 0 0;padding:0;display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.legend li{display:flex;align-items:center;gap:6px}
.legend .swatch{width:12px;height:12px;border:2px solid var(--context);display:inline-block}
.swatch-added{border-color:var(--added)}.swatch-modified{border-color:var(--modified);transform:rotate(45deg)}.swatch-removed{border-color:var(--removed);border-radius:2px}.swatch-context{border-style:dashed}.swatch-functionality{border-color:var(--functionality);border-radius:50%}
#functionalities ul{list-style:none;margin:0;padding:0}
#functionalities li{border-top:1px solid var(--line);padding:8px 0;font-size:13px}
#functionalities li:first-child{border-top:0}
.impact{color:var(--added)}.impact-modified{color:var(--modified)}.impact-removed{color:var(--removed)}
@media (max-width:760px){main{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<header>
  <h1>Change report — <span id="feature-name"></span></h1>
  <div class="meta">
    <span id="report-status" class="status"></span>
    <span id="report-date"></span>
    <span id="report-repo"></span>
  </div>
</header>
<main>
  <section>
    <div class="toolbar">
      <div id="filters" role="group" aria-label="Filter nodes by kind"></div>
      <button id="expand" type="button" aria-pressed="false" hidden>Show second-level connections</button>
    </div>
    <div class="card"><svg id="graph" class="graph" viewBox="0 0 960 160" role="img" aria-label="Architecture change graph"></svg></div>
    <ul class="legend" aria-label="Legend">
      <li><span class="swatch swatch-added"></span>added</li>
      <li><span class="swatch swatch-modified"></span>modified</li>
      <li><span class="swatch swatch-removed"></span>removed</li>
      <li><span class="swatch swatch-context"></span>context (first-level)</li>
      <li><span class="swatch swatch-functionality"></span>functionality</li>
    </ul>
  </section>
  <aside id="detail" class="card" aria-live="polite"><h2>Node detail</h2><p>Select a node to see its summary.</p></aside>
</main>
<section id="functionalities" class="card" aria-labelledby="functionalities-heading" style="margin:0 24px 24px">
  <h2 id="functionalities-heading">Impacts on important functionalities</h2>
  <ul></ul>
</section>
<script type="application/json" id="report-data">{
  "feature": "example-feature",
  "date": "2026-01-01",
  "repo": "owner/repo",
  "status": "success",
  "nodes": [
    { "id": "n-new-thing", "kind": "added", "label": "NewThing", "path": "src/new-thing.ts", "summary": "The added entity and why it exists." },
    { "id": "n-existing", "kind": "modified", "label": "ExistingThing", "path": "src/existing.ts", "summary": "How it changed and what behavior shifted." },
    { "id": "n-old-thing", "kind": "removed", "label": "OldThing", "path": "src/old.ts", "summary": "Removed; replaced by NewThing." },
    { "id": "n-callers", "kind": "context", "label": "Callers", "path": "src/callers.ts", "summary": "First-level connection; unchanged." },
    { "id": "n-feature-x", "kind": "functionality", "label": "Feature X works", "path": "src/feature-x.ts", "summary": "Important functionality the change impacts." }
  ],
  "edges": [
    { "from": "n-new-thing", "to": "n-existing", "level": 1, "relation": "calls" },
    { "from": "n-callers", "to": "n-new-thing", "level": 1, "relation": "calls" },
    { "from": "n-new-thing", "to": "n-feature-x", "level": 1, "relation": "implements" },
    { "from": "n-old-thing", "to": "n-existing", "level": 2, "relation": "previously-called" }
  ],
  "functionalities": [
    { "name": "Feature X works", "impact": "modified", "detail": "Now routed through NewThing." }
  ]
}</script>
<script>
/* forge-report-core:start */
var NODE_KINDS = ['added', 'modified', 'removed', 'context', 'functionality'];

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Serialize the data island safely: JSON.stringify then neutralize the characters that could
// otherwise terminate the surrounding <script> element early (a repo-derived label containing
// `<\/script>`). The output is still valid JSON that parses back to the original values.
function serializeReportData(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function normalizeKind(kind) {
  return NODE_KINDS.indexOf(kind) >= 0 ? kind : 'context';
}

function validateAndLink(data) {
  var rawNodes = data && Array.isArray(data.nodes) ? data.nodes : [];
  var nodes = rawNodes.map(function (node) {
    var source = node || {};
    return {
      id: source.id == null ? '' : String(source.id),
      kind: normalizeKind(source.kind),
      label: source.label == null ? '' : String(source.label),
      path: source.path == null ? '' : String(source.path),
      summary: source.summary == null ? '' : String(source.summary)
    };
  });
  var known = {};
  nodes.forEach(function (node) { if (node.id) known[node.id] = true; });
  var rawEdges = data && Array.isArray(data.edges) ? data.edges : [];
  var edges = [];
  rawEdges.forEach(function (edge) {
    if (!edge) return;
    var from = String(edge.from);
    var to = String(edge.to);
    if (!known[from] || !known[to] || from === to) return;
    edges.push({ from: from, to: to, level: edge.level === 2 ? 2 : 1, relation: edge.relation == null ? '' : String(edge.relation) });
  });
  return { nodes: nodes, edges: edges };
}

function filterByKind(nodes, kind) {
  var list = Array.isArray(nodes) ? nodes : [];
  return list.filter(function (node) { return node && node.kind === kind; });
}

function nodeShape(kind, x, y, label) {
  var shape;
  if (kind === 'functionality') {
    shape = '<circle class="shape shape-functionality" cx="' + x + '" cy="' + y + '" r="30"></circle>';
  } else if (kind === 'removed') {
    shape = '<polygon class="shape shape-removed" points="' + (x - 32) + ',' + y + ' ' + (x - 16) + ',' + (y - 26) + ' ' + (x + 16) + ',' + (y - 26) + ' ' + (x + 32) + ',' + y + ' ' + (x + 16) + ',' + (y + 26) + ' ' + (x - 16) + ',' + (y + 26) + '"></polygon>';
  } else if (kind === 'modified') {
    shape = '<polygon class="shape shape-modified" points="' + x + ',' + (y - 28) + ' ' + (x + 32) + ',' + y + ' ' + x + ',' + (y + 28) + ' ' + (x - 32) + ',' + y + '"></polygon>';
  } else if (kind === 'context') {
    shape = '<rect class="shape shape-context" x="' + (x - 36) + '" y="' + (y - 22) + '" width="72" height="44" rx="6"></rect>';
  } else {
    shape = '<rect class="shape shape-added" x="' + (x - 36) + '" y="' + (y - 22) + '" width="72" height="44" rx="6"></rect>';
  }
  var labelText = '<text class="node-label" x="' + x + '" y="' + (y - 1) + '" text-anchor="middle">' + escapeHtml(label) + '</text>';
  var kindText = '<text class="node-kind" x="' + x + '" y="' + (y + 14) + '" text-anchor="middle">' + escapeHtml(kind) + '</text>';
  return shape + labelText + kindText;
}

function renderGraphToSvgString(nodes, edges, options) {
  var opts = options || {};
  var list = Array.isArray(nodes) ? nodes : [];
  var relations = Array.isArray(edges) ? edges : [];
  var width = 960;
  var columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(list.length || 1))));
  var cellWidth = Math.floor(width / columns);
  var cellHeight = 128;
  var rows = Math.max(1, Math.ceil(list.length / columns));
  var height = rows * cellHeight + 40;
  var positions = {};
  list.forEach(function (node, index) {
    positions[node.id] = { x: (index % columns) * cellWidth + cellWidth / 2, y: Math.floor(index / columns) * cellHeight + 64 };
  });
  var parts = [];
  parts.push('<svg class="graph" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMin meet" role="img" aria-label="Architecture change graph">');
  relations.forEach(function (edge) {
    if (!edge) return;
    var level = edge.level === 2 ? 2 : 1;
    if (level === 2 && !opts.expanded) return;
    var a = positions[edge.from];
    var b = positions[edge.to];
    if (!a || !b) return;
    parts.push('<line class="edge edge-level-' + level + '" data-from="' + escapeHtml(edge.from) + '" data-to="' + escapeHtml(edge.to) + '" x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '"></line>');
  });
  list.forEach(function (node) {
    var position = positions[node.id];
    var aria = node.kind + ': ' + node.label + (node.path ? ' (' + node.path + ')' : '');
    parts.push('<g class="node node-' + escapeHtml(node.kind) + '" data-node-id="' + escapeHtml(node.id) + '" tabindex="0" role="listitem" aria-label="' + escapeHtml(aria) + '">' + nodeShape(node.kind, position.x, position.y, node.label) + '</g>');
  });
  parts.push('</svg>');
  return parts.join('');
}
/* forge-report-core:end */

(function () {
  var data;
  try { data = JSON.parse(document.getElementById('report-data').textContent); } catch (error) { data = { nodes: [], edges: [] }; }
  var linked = validateAndLink(data);
  var state = { kind: 'all', expanded: false };
  var subsystems = {};
  linked.nodes.forEach(function (node) { var top = (node.path || '').split('/')[0]; if (top) subsystems[top] = true; });
  var promote = linked.nodes.length > 12 || Object.keys(subsystems).length >= 3;

  function setText(id, value) { if (value) document.getElementById(id).textContent = value; }
  setText('feature-name', data.feature);
  setText('report-date', data.date);
  setText('report-repo', data.repo);
  var status = document.getElementById('report-status');
  if (data.status) { status.textContent = 'status: ' + data.status; status.className = 'status status-' + escapeHtml(data.status); }

  var filters = document.getElementById('filters');
  ['all'].concat(NODE_KINDS).forEach(function (kind) {
    var count = kind === 'all' ? linked.nodes.length : filterByKind(linked.nodes, kind).length;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter';
    button.setAttribute('aria-pressed', String(kind === state.kind));
    button.textContent = kind + ' (' + count + ')';
    button.addEventListener('click', function () {
      state.kind = kind;
      Array.prototype.forEach.call(filters.children, function (child) { child.setAttribute('aria-pressed', String(child === button)); });
      draw();
    });
    filters.appendChild(button);
  });

  var graph = document.getElementById('graph');
  var detail = document.getElementById('detail');
  var expand = document.getElementById('expand');
  if (promote) expand.hidden = false;
  expand.addEventListener('click', function () { state.expanded = !state.expanded; expand.setAttribute('aria-pressed', String(state.expanded)); draw(); });

  function showNode(id) {
    var node = linked.nodes.filter(function (item) { return item.id === id; })[0];
    if (!node) return;
    detail.innerHTML = '';
    var heading = document.createElement('h2');
    heading.textContent = 'Node detail';
    var label = document.createElement('p');
    label.className = 'detail-label';
    label.textContent = node.label + ' (' + node.kind + ')';
    var filePath = document.createElement('p');
    filePath.className = 'detail-path';
    filePath.textContent = node.path;
    var summary = document.createElement('p');
    summary.textContent = node.summary;
    [heading, label, filePath, summary].forEach(function (element) { detail.appendChild(element); });
  }

  function draw() {
    var nodes = state.kind === 'all' ? linked.nodes : filterByKind(linked.nodes, state.kind);
    graph.innerHTML = renderGraphToSvgString(nodes, linked.edges, { expanded: state.expanded });
    Array.prototype.forEach.call(graph.querySelectorAll('.node'), function (element) {
      var id = element.getAttribute('data-node-id');
      element.addEventListener('click', function () { showNode(id); });
      element.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showNode(id); } });
    });
  }

  var list = document.querySelector('#functionalities ul');
  (Array.isArray(data.functionalities) ? data.functionalities : []).forEach(function (item) {
    var entry = document.createElement('li');
    var impact = document.createElement('span');
    impact.className = 'impact' + (item.impact && item.impact !== 'added' ? ' impact-' + escapeHtml(item.impact) : '');
    impact.textContent = '[' + (item.impact || 'modified') + '] ';
    var text = document.createTextNode(item.name + ' — ' + item.detail);
    entry.appendChild(impact);
    entry.appendChild(text);
    list.appendChild(entry);
  });

  draw();
})();
</script>
</body>
</html>
```
