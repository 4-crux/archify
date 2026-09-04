// --only-diff support: project a diagram onto the nodes whose verified source
// references intersect a Git diff, so a reviewer can look at exactly the
// elements a change touched. The projection is a pure transform of the
// authored JSON (nodes, relationships, frames, views) and never invents
// topology: every kept element existed in the source, with its authored
// placement. Types without node-level `sources` cannot be projected.
import { spawnSync } from 'node:child_process';
import { EVIDENCE_COLLECTIONS } from './repository-evidence.mjs';

// Which collections hang off each evidence-capable diagram type.
const PROJECTION_SHAPES = {
  architecture: { nodes: 'components', relationships: 'connections', frames: 'boundaries' },
  domain: { nodes: 'entities', relationships: 'relationships', frames: 'contexts' },
  erd: { nodes: 'tables', relationships: 'relationships', frames: 'groups' },
  'http-call': { nodes: 'components', relationships: 'calls', frames: 'zones' },
};

export function diffProjectionSupported(diagramType) {
  return Boolean(EVIDENCE_COLLECTIONS[diagramType] && PROJECTION_SHAPES[diagramType]);
}

function runGit(repoRoot, args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`Could not run Git for --only-diff: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed for --only-diff: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

// Parse `git diff -U0` into per-file old/new line ranges. Hunk headers look
// like `@@ -12,3 +12,4 @@`; a count of 0 marks a pure insertion/deletion.
export function parseUnifiedDiff(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') { current = null; continue; }
      const cleaned = target.replace(/^b\//, '');
      current = files.get(cleaned) || { path: cleaned, oldRanges: [], newRanges: [] };
      files.set(cleaned, current);
      continue;
    }
    if (line.startsWith('--- ')) {
      const source = line.slice(4).trim();
      if (source !== '/dev/null') {
        const cleaned = source.replace(/^a\//, '');
        if (!files.has(cleaned)) files.set(cleaned, { path: cleaned, oldRanges: [], newRanges: [] });
        current = files.get(cleaned);
      }
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      current.oldRanges.push([oldStart, oldStart + Math.max(oldCount, 1) - 1]);
      current.newRanges.push([newStart, newStart + Math.max(newCount, 1) - 1]);
    }
  }
  return files;
}

// Collect the change set for a range. With no range the working tree and
// index are compared against HEAD, and untracked files count as changed.
export function collectGitChanges(repoRoot, range) {
  const args = ['diff', '--no-color', '--unified=0', '--no-ext-diff', '--no-renames'];
  if (range) args.push(range);
  else args.push('HEAD');
  const files = parseUnifiedDiff(runGit(repoRoot, [...args, '--']));
  if (!range) {
    const untracked = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard']);
    for (const file of untracked.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      if (!files.has(file)) files.set(file, { path: file, oldRanges: [], newRanges: [[1, Number.MAX_SAFE_INTEGER]] });
    }
  }
  return { range: range || 'HEAD..working-tree', files };
}

function rangesOverlap(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

export function sourceTouchedBy(source, change) {
  if (!change) return false;
  if (!source.line) return true;
  const span = [source.line, source.end_line || source.line];
  const ranges = [...change.oldRanges, ...change.newRanges];
  if (!ranges.length) return true;
  return ranges.some((range) => rangesOverlap(span, range));
}

// Decide which nodes the change touches. Returns ids plus the matching
// evidence so the receipt can say why each node stayed.
export function matchNodesToChanges(diagramType, diagram, changes) {
  const shape = PROJECTION_SHAPES[diagramType];
  const nodes = Array.isArray(diagram?.[shape.nodes]) ? diagram[shape.nodes] : [];
  const matches = new Map();
  for (const node of nodes) {
    const sources = Array.isArray(node.sources) ? node.sources : [];
    const hits = sources.filter((source) => sourceTouchedBy(source, changes.files.get(String(source.path || '').replace(/\\/g, '/'))));
    if (hits.length) matches.set(node.id, hits.map((hit) => hit.path));
  }
  return matches;
}

// Removing nodes leaves empty grid rows and columns. Renumber row/col so the
// projection stays dense while every kept node keeps its relative order.
// Free-placed nodes (pos) are left untouched.
export function compactGrid(nodes) {
  const gridded = nodes.filter((node) => !Array.isArray(node.pos) && Number.isInteger(node.row) && Number.isInteger(node.col));
  if (!gridded.length) return nodes;
  const rows = [...new Set(gridded.map((node) => node.row))].sort((a, b) => a - b);
  const cols = [...new Set(gridded.map((node) => node.col))].sort((a, b) => a - b);
  const rowIndex = new Map(rows.map((row, index) => [row, index]));
  const colIndex = new Map(cols.map((col, index) => [col, index]));
  return nodes.map((node) => (
    !Array.isArray(node.pos) && Number.isInteger(node.row) && Number.isInteger(node.col)
      ? { ...node, row: rowIndex.get(node.row), col: colIndex.get(node.col) }
      : node
  ));
}

export function projectDiagram(diagramType, diagram, keptIds, { neighbors = false, subtitle } = {}) {
  const shape = PROJECTION_SHAPES[diagramType];
  const nodes = Array.isArray(diagram[shape.nodes]) ? diagram[shape.nodes] : [];
  const relationships = Array.isArray(diagram[shape.relationships]) ? diagram[shape.relationships] : [];
  const keep = new Set(keptIds);
  if (neighbors) {
    // One hop only: neighbors of the touched nodes, never neighbors of neighbors.
    const touched = new Set(keptIds);
    for (const relationship of relationships) {
      if (touched.has(relationship.from)) keep.add(relationship.to);
      if (touched.has(relationship.to)) keep.add(relationship.from);
    }
  }
  const projected = { ...diagram };
  projected[shape.nodes] = compactGrid(nodes.filter((node) => keep.has(node.id)));
  projected[shape.relationships] = relationships.filter((relationship) => keep.has(relationship.from) && keep.has(relationship.to));
  if (Array.isArray(diagram[shape.frames])) {
    projected[shape.frames] = diagram[shape.frames]
      .map((frame) => ({ ...frame, wraps: (frame.wraps || []).filter((id) => keep.has(id)) }))
      .filter((frame) => frame.wraps.length);
    if (!projected[shape.frames].length) delete projected[shape.frames];
  }
  const meta = { ...diagram.meta };
  if (Array.isArray(meta.views)) {
    const views = meta.views
      .map((view) => ({ ...view, focus: (view.focus || []).filter((id) => keep.has(id)) }))
      .filter((view) => view.focus.length);
    if (views.length) meta.views = views;
    else delete meta.views;
  }
  if (subtitle) meta.subtitle = subtitle;
  projected.meta = meta;
  // Cards describe the whole system; a diff projection is a focused review
  // artifact, so it drops them and keeps the first screen on the diagram.
  delete projected.cards;
  return {
    diagram: projected,
    kept: projected[shape.nodes].map((node) => node.id),
    removed: nodes.filter((node) => !keep.has(node.id)).map((node) => node.id),
    relationshipsKept: projected[shape.relationships].length,
    relationshipsRemoved: relationships.length - projected[shape.relationships].length,
  };
}

// End-to-end helper used by the CLI.
export function projectDiagramToGitDiff({ diagramType, diagram, repoRoot, range, neighbors = false }) {
  if (!diffProjectionSupported(diagramType)) {
    throw new Error(`--only-diff needs node-level source evidence; it supports ${Object.keys(PROJECTION_SHAPES).join(', ')} diagrams, not ${diagramType}.`);
  }
  const changes = collectGitChanges(repoRoot, range);
  const matches = matchNodesToChanges(diagramType, diagram, changes);
  const shape = PROJECTION_SHAPES[diagramType];
  const total = Array.isArray(diagram[shape.nodes]) ? diagram[shape.nodes].length : 0;
  if (!matches.size) {
    throw new Error(`--only-diff found no ${shape.nodes} whose sources intersect ${changes.range} (${changes.files.size} changed file(s)). Add sources to the touched elements or widen the range.`);
  }
  const subtitle = `Only elements touched by ${changes.range} · ${matches.size} of ${total} ${shape.nodes}`;
  const projection = projectDiagram(diagramType, diagram, [...matches.keys()], { neighbors, subtitle });
  return {
    ...projection,
    range: changes.range,
    changedFiles: [...changes.files.keys()].sort(),
    matches: Object.fromEntries([...matches.entries()].map(([id, paths]) => [id, [...new Set(paths)]])),
  };
}
