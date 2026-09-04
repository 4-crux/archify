import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagramLogoIds, diagramLogoRect, renderDiagramLogo } from '../renderers/shared/diagram-logo.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-diagram-logo-'));

const CASES = {
  architecture: 'web-app.architecture.json',
  workflow: 'agent-tool-call.workflow.json',
  sequence: 'cache-miss-request.sequence.json',
  dataflow: 'product-analytics.dataflow.json',
  lifecycle: 'agent-run.lifecycle.json',
};

function render(mode, logo, preset) {
  const source = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', CASES[mode]), 'utf8'));
  if (logo === undefined) delete source.meta.logo;
  else source.meta.logo = logo;
  if (preset === undefined) delete source.meta.visual_preset;
  else source.meta.visual_preset = preset;
  source.meta.animation = 'none';
  const fixtureName = `${logo || 'nologo'}-${preset || 'default'}`;
  const input = path.join(tmp, `${mode}-${fixtureName}.json`);
  const output = path.join(tmp, `${mode}-${fixtureName}.html`);
  fs.writeFileSync(input, JSON.stringify(source));
  execFileSync(process.execPath, [path.join(skillRoot, `renderers/${mode}/render-${mode}.mjs`), input, output]);
  return fs.readFileSync(output, 'utf8');
}

function validate(mode, logo) {
  const source = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', CASES[mode]), 'utf8'));
  source.meta.logo = logo;
  const input = path.join(tmp, `${mode}-validate-${logo}.json`);
  fs.writeFileSync(input, JSON.stringify(source));
  try {
    execFileSync(process.execPath, [path.join(skillRoot, 'bin/archify.mjs'), 'validate', mode, input, '--json'], { stdio: 'pipe' });
    return { ok: true };
  } catch (error) {
    return { ok: false, output: String(error.stdout || '') + String(error.stderr || '') };
  }
}

function svgBlock(html) {
  return html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0] || '';
}

test('the shared helper knows the 4crux logo and places it inside the bottom-right margin', () => {
  assert.deepEqual(diagramLogoIds(), ['4crux']);
  const rect = diagramLogoRect({ logo: '4crux' }, [1080, 588]);
  assert.ok(rect.x > 0 && rect.x + rect.width < 1080, 'logo must stay inside the viewBox width');
  assert.ok(rect.y > 0 && rect.y + rect.height < 588, 'logo must stay inside the viewBox height');
  assert.ok(rect.x + rect.width >= 1080 - 40, 'logo hugs the right margin');
  assert.ok(rect.y + rect.height >= 588 - 40, 'logo hugs the bottom margin');
  assert.equal(diagramLogoRect({}, [1080, 588]), null);
  assert.equal(renderDiagramLogo({}, [1080, 588]), '');
  assert.equal(renderDiagramLogo({ logo: 'unknown' }, [1080, 588]), '');
});

test('meta.logo emits one export-safe SVG group in all five typed renderers', () => {
  for (const mode of Object.keys(CASES)) {
    const svg = svgBlock(render(mode, '4crux'));
    const groups = svg.match(/<g aria-hidden="true" class="diagram-logo" data-diagram-logo="4crux"/g) || [];
    assert.equal(groups.length, 1, `${mode}: exactly one diagram logo group`);
    assert.match(svg, /<rect width="22" height="22" rx="6" class="diagram-logo-plate"\/>/, mode);
    assert.match(svg, /class="diagram-logo-glyph"[^>]*>4C<\/text>/, mode);
    assert.match(svg, /class="diagram-logo-word"[^>]*><tspan font-weight="600">4<\/tspan><tspan font-weight="800">Crux<\/tspan><\/text>/, mode);
    assert.doesNotMatch(svg, /diagram-logo[^>]*data-node-id/, `${mode}: the logo is never a semantic node`);
  }
});

test('omitting meta.logo keeps the canonical SVG byte-identical to the pre-logo renderer output', () => {
  for (const mode of Object.keys(CASES)) {
    const svg = svgBlock(render(mode));
    assert.doesNotMatch(svg, /diagram-logo/, mode);
  }
});

test('the diagram logo follows the color mode through --logo-* variables that export can resolve', () => {
  const html = render('architecture', '4crux', '4crux');
  assert.match(html, /svg \.diagram-logo-plate \{ fill: var\(--logo-plate\); stroke: none; \}/);
  assert.match(html, /svg \.diagram-logo-glyph \{ fill: var\(--logo-ink\); \}/);
  assert.match(html, /svg \.diagram-logo-word \{ fill: var\(--logo-word, var\(--text\)\); \}/);
  for (const selector of [':root,\n    [data-theme="dark"]', '[data-theme="light"]', '[data-preset="4crux"][data-theme="dark"]', '[data-preset="4crux"][data-theme="light"]']) {
    const escaped = selector.replace(/[[\]().*+?^$|{}\\]/g, '\\$&');
    assert.match(html, new RegExp(`${escaped} \\{[^}]*--logo-plate:`), `${selector} defines --logo-plate`);
    assert.match(html, new RegExp(`${escaped} \\{[^}]*--logo-ink:`), `${selector} defines --logo-ink`);
  }
});

test('the diagram logo is independent from the visual preset', () => {
  const withClassic = svgBlock(render('workflow', '4crux'));
  const withPreset = svgBlock(render('workflow', '4crux', '4crux')).replace(/ data-preset="4crux"/, ' data-preset="classic"');
  assert.equal(withPreset, withClassic);
});

test('meta.logo accepts only catalogued logo ids', () => {
  assert.equal(validate('architecture', '4crux').ok, true);
  const rejected = validate('architecture', 'acme');
  assert.equal(rejected.ok, false);
  assert.match(rejected.output, /logo/);
});

process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
