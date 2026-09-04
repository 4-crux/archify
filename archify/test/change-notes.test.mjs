import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-change-notes-'));

const CASES = {
  architecture: 'web-app.architecture.json',
  workflow: 'agent-tool-call.workflow.json',
  sequence: 'cache-miss-request.sequence.json',
  dataflow: 'product-analytics.dataflow.json',
  lifecycle: 'agent-run.lifecycle.json',
};

function render(mode, example) {
  const output = path.join(tmp, `${mode}.html`);
  execFileSync(process.execPath, [
    path.join(skillRoot, `renderers/${mode}/render-${mode}.mjs`),
    path.join(skillRoot, 'examples', example),
    output,
  ]);
  return fs.readFileSync(output, 'utf8');
}

function canonicalSvg(html) {
  return html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0] || '';
}

function notesRuntime(html) {
  return html.match(/Archify\.changeNotes = \(function \(\) \{[\s\S]*?\n    \}\)\(\);/)?.[0] || '';
}

test('all typed renderers inherit one viewer-only Change Notes surface', () => {
  for (const [mode, example] of Object.entries(CASES)) {
    const html = render(mode, example);
    assert.match(html, /<meta name="archify-diagram-type" content="[a-z]+">/, mode);
    assert.match(html, new RegExp(`<meta name="archify-diagram-type" content="${mode}">`), mode);
    assert.match(html, /id="change-notes" hidden role="dialog" aria-modal="false" aria-labelledby="change-notes-title"/, mode);
    assert.match(html, /id="btn-change-notes"[^>]+aria-label="Suggest changes"[^>]+aria-pressed="false"[^>]+aria-controls="change-notes"/, mode);
    assert.match(html, /data-change-notes-count hidden>0</, mode);
    assert.match(html, /<textarea id="change-notes-text"[^>]+maxlength="4000"/, mode);
    assert.match(html, /id="change-notes-copy" type="button" disabled>Copy changes</, mode);
    assert.match(html, /data-action="copy-change-notes"[^>]+hidden disabled/, mode);
    assert.match(html, /<kbd>A<\/kbd> Change notes/, mode);
    assert.match(html, /Archify\.changeNotes = \(function \(\)/, mode);
    assert.doesNotMatch(canonicalSvg(html), /data-annotation-overlay|data-annotation-marker|change-note-marker|change-notes-overlay/, mode);
  }
});

test('structural frames expose a label so lanes, stages, segments, and boundaries can be annotated by name', () => {
  const expectations = {
    architecture: /data-composition-frame-kind="(?:region|security-group|boundary)"[^>]*data-composition-frame-label="[^"]+"/,
    workflow: /data-composition-frame-kind="lane" data-composition-frame-id="lane-0" data-composition-frame-label="[^"]+"/,
    sequence: /data-composition-frame-kind="segment" data-composition-frame-id="0" data-composition-frame-label="[^"]+"/,
    dataflow: /data-composition-frame-kind="stage" data-composition-frame-id="0" data-composition-frame-label="[^"]+"/,
  };
  for (const [mode, pattern] of Object.entries(expectations)) {
    assert.match(canonicalSvg(render(mode, CASES[mode])), pattern, mode);
  }
});

test('Change Notes resolve nodes, relationships, and frames from the compiled DOM only', () => {
  const runtime = notesRuntime(render('architecture', CASES.architecture));
  assert.ok(runtime.length > 0, 'runtime block found');
  assert.match(runtime, /element\.closest\('\[data-node-id\]'\)/);
  assert.match(runtime, /element\.closest\('\[data-relationship-hit-key\]'\)/);
  assert.match(runtime, /element\.closest\('\[data-edge-from\]\[data-edge-to\]'\)/);
  assert.match(runtime, /element\.closest\('\[data-composition-frame-id\]'\)/);
  assert.match(runtime, /svg\.addEventListener\('click', function \(event\) \{\n\s+if \(!enabled\) return;\n\s+if \(container\.getAttribute\('data-just-panned'\) === 'true'\) return;/);
  assert.match(runtime, /event\.stopPropagation\(\);\n\s+openEditor\(target\);\n\s+\}, true\);/, 'capture-phase click keeps the passport closed while annotating');
  assert.doesNotMatch(runtime, /fetch\(|XMLHttpRequest|WebSocket|history\.|location\./);
});

test('Change Notes persist per topology digest in localStorage and fail safe when storage is unavailable', () => {
  const runtime = notesRuntime(render('workflow', CASES.workflow));
  assert.match(runtime, /var STORAGE_PREFIX = 'archify-change-notes:'/);
  assert.match(runtime, /function topologyDigest\(\)/);
  assert.match(runtime, /return fnv1a\(\[diagramType\(\), diagramTitle\(\)\]\.concat\(ids, keys\)\.join\('\\u0001'\)\);/);
  assert.match(runtime, /try \{\n\s+var raw = localStorage\.getItem\(storageKey\);/);
  assert.match(runtime, /catch \(_\) \{ return \[\]; \}/);
  assert.match(runtime, /try \{\n\s+if \(!notes\.length\) localStorage\.removeItem\(storageKey\);/);
});

test('Change Notes markers are an overlay that every canonical export strips', () => {
  const html = render('dataflow', CASES.dataflow);
  const runtime = notesRuntime(html);
  assert.match(runtime, /overlay\.setAttribute\('data-annotation-overlay', ''\)/);
  assert.match(runtime, /marker\.setAttribute\('data-annotation-marker', targetKeyOf\(note\.target\)\)/);
  assert.match(html, /clone\.querySelectorAll\('\[data-annotation-overlay\]'\), function \(el\) \{\n\s+el\.remove\(\);/);
  assert.match(html, /\[data-annotation-overlay\], \[data-annotation-marker\], \[data-annotation-editing\]'\)\.length === 0;/);
  assert.match(html, /\.diagram-nav, \.focus-chip, \.node-finder, \.diagram-guide, \.overview-map, \.route-probe, \.semantic-lens, \.change-notes'/);
  assert.match(html, /html\[data-embed="true"\] \.change-notes,/);
});

test('Copy changes writes one structured Markdown report through the clipboard with a fallback', () => {
  const runtime = notesRuntime(render('lifecycle', CASES.lifecycle));
  assert.match(runtime, /lines\.push\('# Change requests — ' \+ title\)/);
  assert.match(runtime, /lines\.push\('- Diagram type: ' \+ type\)/);
  assert.match(runtime, /lines\.push\('- Incoming: '/);
  assert.match(runtime, /lines\.push\('- Outgoing: '/);
  assert.match(runtime, /lines\.push\('- Contains: '/);
  assert.match(runtime, /lines\.push\('\*\*Request:\*\*'\)/);
  assert.match(runtime, /lines\.push\('```json'\)/);
  assert.match(runtime, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(runtime, /document\.execCommand\('copy'\)/);
});

test('the export menu exposes Copy change notes only when notes exist and the keyboard registry owns A and Escape', () => {
  const html = render('sequence', CASES.sequence);
  assert.match(html, /function syncChangeNotesItem\(\)/);
  assert.match(html, /changeNotesItem\.hidden = !count;/);
  assert.match(html, /syncReachShareItem\(\);\n\s+syncChangeNotesItem\(\);/);
  assert.match(html, /button\[data-action="copy-change-notes"\]'\);\n\s+if \(changeNotesBtn && !changeNotesBtn\.disabled && !changeNotesBtn\.hidden\) \{ runCopyChangeNotes\(\); return; \}/);
  assert.match(html, /e\.key === 'a' \|\| e\.key === 'A'\) \{\n\s+e\.preventDefault\(\);\n\s+Archify\.changeNotes\.toggle\(\);/);
  assert.match(html, /e\.key === 'Escape' && Archify\.changeNotes\.editing\(\)/);
  assert.match(html, /e\.key === 'Escape' && Archify\.changeNotes\.isOpen\(\)/);
});

process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
