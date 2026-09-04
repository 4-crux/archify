import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModel, MODEL_TYPES, resolveDetail, relationshipLabelFor } from '../renderers/model/model-compiler.mjs';
import { dominantFromSide, dominantToSide } from '../renderers/model/model-router.mjs';
import { compactGrid, parseUnifiedDiff, projectDiagram, sourceTouchedBy } from '../renderers/shared/diff-projection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const cli = path.join(skillRoot, 'bin/archify.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-model-diagrams-'));

const EXAMPLES = {
  domain: 'order-management.domain.json',
  erd: 'order-management.erd.json',
  'http-call': 'storefront.http-call.json',
};

function readExample(type) {
  return JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', EXAMPLES[type]), 'utf8'));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: skillRoot, encoding: 'utf8', env: { ...process.env, ...(options.env || {}) } });
}

function render(type, source, name, env = {}) {
  const input = path.join(tmp, `${name}.json`);
  const output = path.join(tmp, `${name}.html`);
  fs.writeFileSync(input, JSON.stringify(source));
  execFileSync(process.execPath, [path.join(skillRoot, `renderers/${type}/render-${type}.mjs`), input, output], { env: { ...process.env, ...env } });
  return fs.readFileSync(output, 'utf8');
}

function svgBlock(html) {
  return html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0] || '';
}

test('domain, erd, and http-call examples validate with every showcase check', () => {
  for (const type of Object.keys(EXAMPLES)) {
    const result = run(['validate', type, path.join(skillRoot, 'examples', EXAMPLES[type]), '--quality', 'showcase', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true, type);
    assert.equal(receipt.checks.length, 9, `${type}: nine artifact checks`);
    assert.ok(receipt.checks.every((check) => check.ok), type);
  }
});

test('each model type renders sectioned boxes, frames, stable ids, and its own legend', () => {
  const expectations = {
    domain: { node: 'order', frame: 'Ordering context', legend: 'aggregate root', member: 'attributes' },
    erd: { node: 'orders', frame: 'sales schema', legend: 'junction table', member: 'keys' },
    'http-call': { node: 'gateway', frame: 'Clients', legend: 'gateway', member: 'endpoints' },
  };
  for (const [type, expected] of Object.entries(expectations)) {
    const html = render(type, readExample(type), `${type}-full`);
    const svg = svgBlock(html);
    assert.match(html, new RegExp(`<meta name="archify-diagram-type" content="${type}">`), type);
    assert.match(svg, /data-model-detail="full"/, type);
    assert.match(svg, new RegExp(`data-node-id="${expected.node}"`), type);
    assert.match(svg, new RegExp(`data-composition-frame-label="${expected.frame}"`), type);
    assert.match(svg, new RegExp(`data-model-member="${expected.member}"`), type);
    assert.match(svg, /data-legend-semantic-kind=/, `${type}: legend entries`);
    assert.match(html, new RegExp(expected.legend), type);
    assert.match(svg, /class="diagram-logo"|<!-- Legend -->/, type);
  }
});

test('detail levels change only the member rows, never the topology', () => {
  const full = compileModel({ diagramType: 'domain', diagram: readExample('domain'), detail: 'full' });
  const properties = compileModel({ diagramType: 'domain', diagram: readExample('domain'), detail: 'properties' });
  const entities = compileModel({ diagramType: 'domain', diagram: readExample('domain'), detail: 'entities' });
  const members = (compiled) => (compiled.svg.match(/data-model-member="/g) || []).length;
  assert.ok(members(full) > members(properties), 'full shows methods too');
  assert.ok(members(properties) > 0, 'properties shows attributes');
  assert.equal(members(entities), 0, 'entities shows no rows');
  assert.doesNotMatch(entities.svg, /data-model-member/);
  assert.match(properties.svg, /data-model-member="attributes"/);
  assert.doesNotMatch(properties.svg, /data-model-member="methods"/);
  assert.match(full.svg, /data-model-member="methods"/);
  for (const compiled of [full, properties, entities]) {
    assert.equal(compiled.receipt.nodes.length, 9);
    assert.equal(compiled.receipt.relationships.length, 8);
  }
  assert.ok(entities.receipt.nodes.every((node) => node.height < 60), 'entity-only boxes are compact');
  const erdKeys = compileModel({ diagramType: 'erd', diagram: readExample('erd'), detail: 'keys' });
  assert.match(erdKeys.svg, /data-model-member="keys"/);
  assert.doesNotMatch(erdKeys.svg, />status<\/tspan>/, 'keys level hides plain columns');
  const httpEndpoints = compileModel({ diagramType: 'http-call', diagram: readExample('http-call'), detail: 'endpoints' });
  assert.match(httpEndpoints.svg, /POST<\/tspan>/);
  assert.doesNotMatch(httpEndpoints.svg, />req /, 'endpoints level hides payload rows');
});

test('detail aliases map across types and unknown levels fail closed', () => {
  assert.equal(resolveDetail('erd', {}, 'entities'), 'tables');
  assert.equal(resolveDetail('domain', {}, 'keys'), 'properties');
  assert.equal(resolveDetail('http-call', {}, 'tables'), 'components');
  assert.equal(resolveDetail('domain', { detail: 'entities' }, undefined), 'entities');
  assert.equal(resolveDetail('domain', {}, undefined), 'full');
  assert.throws(() => resolveDetail('domain', {}, 'everything'), /model\/detail-invalid/);
  const usage = run(['render', 'domain', path.join(skillRoot, 'examples', EXAMPLES.domain), path.join(tmp, 'x.html'), '--detail', 'everything']);
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /Unknown detail level/);
});

test('--detail on the CLI selects the authored detail level for render and validate', () => {
  const output = path.join(tmp, 'domain-entities-cli.html');
  const result = run(['render', 'domain', path.join(skillRoot, 'examples', EXAMPLES.domain), output, '--detail', 'entities']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(svgBlock(fs.readFileSync(output, 'utf8')), /data-model-detail="entities"/);
  const layout = run(['validate', 'erd', path.join(skillRoot, 'examples', EXAMPLES.erd), '--layout-json', '--detail=tables']);
  assert.equal(layout.status, 0, layout.stderr);
  const receipt = JSON.parse(layout.stdout);
  assert.equal(receipt.detail, 'tables');
  assert.ok(receipt.nodes.every((node) => node.members === 0));
});

test('domain notation uses UML markers and ERD notation uses crow feet', () => {
  const domain = compileModel({ diagramType: 'domain', diagram: readExample('domain') }).svg;
  assert.match(domain, /data-model-relationship="composition"[^>]*marker-start="url\(#model-diamond-filled\)"/);
  assert.match(domain, /data-model-relationship="aggregation"[^>]*marker-start="url\(#model-diamond-hollow\)"/);
  assert.match(domain, /data-model-relationship="dependency"[^>]*class="a-model-dashed"[^>]*marker-end="url\(#model-arrow-open\)"/);
  assert.match(domain, /data-model-relationship="association"[^>]*marker-end="url\(#model-arrow-open\)"/);
  assert.match(domain, />1\.\.\*<\/text>/, 'cardinality annotation rendered');
  const erd = compileModel({ diagramType: 'erd', diagram: readExample('erd') }).svg;
  assert.match(erd, /data-model-relationship="one-to-many"[^>]*marker-start="url\(#model-crow-one\)"[^>]*marker-end="url\(#model-crow-many\)"/);
  assert.match(erd, /marker-end="url\(#model-crow-many-optional\)"/, 'to_optional adds the optional circle');
  assert.match(erd, /<tspan class="t-backend" font-weight="700">PK<\/tspan>/);
  assert.match(erd, /<tspan class="t-[a-z]+" font-weight="700">PK FK<\/tspan>/, 'composite junction keys');
  assert.match(erd, />timestamptz\?<\/text>/, 'nullable marker');
  const http = compileModel({ diagramType: 'http-call', diagram: readExample('http-call') }).svg;
  assert.match(http, /data-model-relationship="POST"[^>]*class="a-emphasis"[^>]*marker-end="url\(#arrowhead-emphasis\)"/);
  assert.match(http, /data-model-relationship="DELETE"[^>]*class="a-security"/);
  assert.match(http, /data-edge-label="GET \/v1\/products"/, 'call labels carry verb and path for the passport');
  assert.match(http, />res ProductPage<\/tspan>/, 'payload rows at full detail');
});

test('bundled HTTP calls keep the verb on the arrow and the full path on the served box', () => {
  const diagram = readExample('http-call');
  const compiled = compileModel({ diagramType: 'http-call', diagram });
  assert.match(compiled.svg, />POST<\/text>/, 'bundled label shows the verb only');
  assert.match(compiled.svg, />\/v1\/orders<\/tspan>/, 'gateway box lists the path');
  assert.equal(relationshipLabelFor('http-call', { method: 'GET', path: '/x' }), 'GET /x');
  assert.equal(relationshipLabelFor('http-call', { method: 'GET', path: '/x' }, { bundled: true }), 'GET');
});

test('automatic sides follow the dominant axis so stacked boxes connect vertically', () => {
  const above = { cx: 100, cy: 50 };
  const below = { cx: 104, cy: 260 };
  assert.equal(dominantFromSide(above, below), 'bottom');
  assert.equal(dominantToSide(above, below), 'top');
  const right = { cx: 400, cy: 60 };
  assert.equal(dominantFromSide(above, right), 'right');
  assert.equal(dominantToSide(above, right), 'left');
});

test('model layout validation rejects overlaps, unknown endpoints, and intruding frames, and tags self relationships', () => {
  const base = readExample('domain');
  const overlap = structuredClone(base);
  overlap.entities[1].pos = [40, 80];
  overlap.entities[0].pos = [50, 90];
  assert.throws(() => compileModel({ diagramType: 'domain', diagram: overlap }), /model\/overlap/);
  const unknown = structuredClone(base);
  unknown.relationships.push({ from: 'order', to: 'ghost', kind: 'association' });
  assert.throws(() => compileModel({ diagramType: 'domain', diagram: unknown }), /model\/unknown-endpoint/);
  const loop = structuredClone(base);
  loop.relationships.push({ id: 'order-parent', from: 'order', to: 'order', kind: 'association', label: 'parent of', from_cardinality: '0..1', to_cardinality: '0..*' });
  const compiled = compileModel({ diagramType: 'domain', diagram: loop });
  assert.match(compiled.svg, /data-model-self-relationship="association" data-edge-from="order" data-edge-to="order" data-edge-label="parent of · 0\.\.1 → 0\.\.\*"[^>]*data-edge-id="order-parent"/, 'self relationship keeps passport facts');
  assert.match(compiled.svg, /⟲ auto-relationship · parent of</, 'self relationship renders as a tag on the node');
  assert.doesNotMatch(compiled.svg, /data-edge-from="order" data-edge-to="order"[^>]*data-composition-points/, 'self relationship never routes an arrow');
  const selfReport = compiled.receipt.relationships.find((relationship) => relationship.from === 'order' && relationship.to === 'order');
  assert.equal(selfReport.self, true);
  assert.equal(selfReport.tag, 'auto-relationship · parent of');
  const httpLoop = readExample('http-call');
  httpLoop.calls.push({ from: 'orders', to: 'orders', method: 'POST', path: '/orders/{id}/retry' });
  assert.match(compileModel({ diagramType: 'http-call', diagram: httpLoop }).svg, /⟲ auto-relationship · POST \/orders\/\{id\}\/retry</);
  const intrusion = structuredClone(base);
  intrusion.contexts[1].wraps = ['shipment'];
  const carrier = intrusion.entities.find((entity) => entity.id === 'carrier');
  carrier.row = 1;
  carrier.col = 3;
  assert.throws(() => compileModel({ diagramType: 'domain', diagram: intrusion }), /model\/frame-intrusion/);
});

test('schemas reject unknown kinds, bad cardinalities, and stray properties', () => {
  const bad = readExample('erd');
  bad.relationships[0].kind = 'sometimes';
  const result = run(['validate', 'erd', (() => { const p = path.join(tmp, 'bad.erd.json'); fs.writeFileSync(p, JSON.stringify(bad)); return p; })(), '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /schema\/enum/);
  const badDomain = readExample('domain');
  badDomain.relationships[0].to_cardinality = 'many';
  const domainResult = run(['validate', 'domain', (() => { const p = path.join(tmp, 'bad.domain.json'); fs.writeFileSync(p, JSON.stringify(badDomain)); return p; })(), '--json']);
  assert.notEqual(domainResult.status, 0);
  assert.match(domainResult.stdout, /schema\/pattern/);
  const badHttp = readExample('http-call');
  badHttp.calls[0].method = 'FETCH';
  const httpResult = run(['validate', 'http-call', (() => { const p = path.join(tmp, 'bad.http.json'); fs.writeFileSync(p, JSON.stringify(badHttp)); return p; })(), '--json']);
  assert.notEqual(httpResult.status, 0);
  assert.match(httpResult.stdout, /schema\/enum/);
});

test('every model kind has a legend label, a viewer kind label, and a lens color', () => {
  const i18n = fs.readFileSync(path.join(skillRoot, 'renderers/shared/i18n.mjs'), 'utf8');
  const template = fs.readFileSync(path.join(skillRoot, 'assets/template.html'), 'utf8');
  for (const [type, config] of Object.entries(MODEL_TYPES)) {
    for (const kind of config.kinds) {
      assert.match(i18n, new RegExp(`'legend\\.${type}\\.${kind}'`), `${type}/${kind} legend`);
      assert.match(i18n, new RegExp(`'viewer\\.kind\\.${kind}'`), `${kind} viewer label`);
      const tone = config.tones[kind];
      if (tone !== 'external') {
        assert.match(template, new RegExp(`semantic-lens-kind\\[data-kind="${kind}"\\]`), `${kind} lens color`);
      }
    }
  }
  assert.match(template, /\.m-line\s*\{ fill: none; stroke: var\(--arrow\)/);
  assert.match(template, /\.m-hollow\s*\{ fill: var\(--mask\); stroke: var\(--arrow\)/);
  assert.match(template, /\.a-model-dashed \{ stroke: var\(--arrow\); fill: none; stroke-dasharray: 4,3; \}/);
});

test('diff projection helpers parse hunks, match sources, compact grids, and keep one-hop neighbors', () => {
  const parsed = parseUnifiedDiff([
    'diff --git a/src/Order.cs b/src/Order.cs',
    '--- a/src/Order.cs',
    '+++ b/src/Order.cs',
    '@@ -5 +5,2 @@ class Order',
    '-  void Place() {}',
    '+  void Place() { Validate(); }',
    '+  void Validate() {}',
    'diff --git a/src/New.cs b/src/New.cs',
    '--- /dev/null',
    '+++ b/src/New.cs',
    '@@ -0,0 +1,3 @@',
    '+class New {}',
  ].join('\n'));
  assert.deepEqual(parsed.get('src/Order.cs').oldRanges, [[5, 5]]);
  assert.deepEqual(parsed.get('src/Order.cs').newRanges, [[5, 6]]);
  assert.deepEqual(parsed.get('src/New.cs').newRanges, [[1, 3]]);
  assert.equal(sourceTouchedBy({ path: 'src/Order.cs', line: 1, end_line: 6 }, parsed.get('src/Order.cs')), true);
  assert.equal(sourceTouchedBy({ path: 'src/Order.cs', line: 20 }, parsed.get('src/Order.cs')), false);
  assert.equal(sourceTouchedBy({ path: 'src/Order.cs' }, parsed.get('src/Order.cs')), true);
  assert.equal(sourceTouchedBy({ path: 'src/Other.cs' }, undefined), false);

  const compacted = compactGrid([{ id: 'a', row: 0, col: 1 }, { id: 'b', row: 3, col: 4 }, { id: 'c', pos: [10, 10] }]);
  assert.deepEqual(compacted.map((node) => [node.id, node.row, node.col]), [['a', 0, 0], ['b', 1, 1], ['c', undefined, undefined]]);

  const projection = projectDiagram('domain', readExample('domain'), ['order'], { neighbors: true, subtitle: 'diff' });
  assert.ok(projection.kept.includes('order'));
  assert.ok(projection.kept.includes('orderLine'), 'direct neighbor kept');
  assert.ok(!projection.kept.includes('money'), 'neighbor of a neighbor dropped');
  assert.equal(projection.diagram.meta.subtitle, 'diff');
  assert.equal(projection.diagram.cards, undefined);
  assert.ok(projection.diagram.contexts.every((context) => context.wraps.every((id) => projection.kept.includes(id))));
  const strict = projectDiagram('domain', readExample('domain'), ['order']);
  assert.deepEqual(strict.kept, ['order']);
  assert.equal(strict.relationshipsKept, 0);
});

test('--only-diff renders only the nodes whose verified sources intersect the Git diff', () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'archify@example.com');
  git('config', 'user.name', 'archify');
  git('remote', 'add', 'origin', 'https://github.com/4-crux/demo.git');
  fs.writeFileSync(path.join(repo, 'src/Order.cs'), 'class Order {\n  // a\n  // b\n  void Place() {}\n}\n');
  fs.writeFileSync(path.join(repo, 'src/Customer.cs'), 'class Customer {}\n');
  fs.writeFileSync(path.join(repo, 'src/Money.cs'), 'class Money {}\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const revision = git('rev-parse', 'HEAD');

  const source = readExample('domain');
  delete source.meta.output;
  source.meta.repository = { url: 'https://github.com/4-crux/demo', revision };
  const sources = {
    order: [{ path: 'src/Order.cs', line: 1, end_line: 5 }],
    customer: [{ path: 'src/Customer.cs' }],
    money: [{ path: 'src/Money.cs', line: 1 }],
  };
  for (const entity of source.entities) if (sources[entity.id]) entity.sources = sources[entity.id];
  const input = path.join(tmp, 'evidence.domain.json');
  fs.writeFileSync(input, JSON.stringify(source, null, 2));

  const clean = run(['validate', 'domain', input, '--repo-root', repo, '--only-diff', '--json']);
  assert.notEqual(clean.status, 0);
  assert.match(clean.stderr, /found no entities whose sources intersect/);

  fs.writeFileSync(path.join(repo, 'src/Order.cs'), 'class Order {\n  // a\n  // b\n  void Place() { Validate(); }\n}\n');
  const working = run(['validate', 'domain', input, '--repo-root', repo, '--only-diff', '--json']);
  assert.equal(working.status, 0, working.stderr);
  const receipt = JSON.parse(working.stdout);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.diffProjection.kept, ['order']);
  assert.deepEqual(receipt.diffProjection.changedFiles, ['src/Order.cs']);
  assert.equal(receipt.diffProjection.range, 'HEAD..working-tree');
  assert.ok(receipt.diffProjection.removed.includes('customer'));

  git('commit', '-qam', 'validate before placing');
  const output = path.join(tmp, 'evidence.only-diff.html');
  const delivered = run(['deliver', 'domain', input, output, '--repo-root', repo, '--only-diff=HEAD~1..HEAD', '--diff-neighbors', '--quality', 'showcase', '--json']);
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  const deliverReceipt = JSON.parse(delivered.stdout);
  assert.equal(deliverReceipt.ok, true);
  assert.equal(deliverReceipt.diffProjection.range, 'HEAD~1..HEAD');
  assert.ok(deliverReceipt.diffProjection.kept.includes('order'));
  assert.ok(deliverReceipt.diffProjection.kept.includes('customer'), 'neighbor kept');
  assert.ok(!deliverReceipt.diffProjection.kept.includes('carrier'));
  const html = fs.readFileSync(output, 'utf8');
  assert.match(html, /Only elements touched by HEAD~1\.\.HEAD · 1 of 9 entities/);
  assert.match(html, /archify-source-evidence-data/, 'evidence payload survives projection');
  assert.doesNotMatch(svgBlock(html), /data-node-id="carrier"/);

  const unsupported = run(['validate', 'workflow', path.join(skillRoot, 'examples/agent-tool-call.workflow.json'), '--only-diff', '--json']);
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /--only-diff is supported for architecture, domain, erd, and http-call/);
});

process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
