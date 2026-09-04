// Shared compiler for box-and-line model diagrams: `domain` (DDD domain model)
// and `erd` (database entity relationship). Both draw entities as sectioned
// boxes (header, member rows), relationships with end notation, and optional
// grouping frames. The authored detail level decides which member rows exist
// in the canonical geometry, so an "entities only" artifact and a "full"
// artifact are two deliveries of one source, never a viewer toggle.
import { esc, renderDefinitions, renderSemanticSigil, textUnits } from '../shared/utils.mjs';
import { animateAttr, focusEdgeAttrs, focusNodeAttrs, focusNodeTitle, svgAccessibleText, svgRootAttrs } from '../shared/cli.mjs';
import { renderDiagramLogo } from '../shared/diagram-logo.mjs';
import { throwDiagnosticProblems } from '../shared/diagnostics.mjs';
import { legendFootprint, relationshipLegendObstacles, resolveLegend, renderLegend as renderResolvedLegend } from '../shared/legend.mjs';
import { translateMessage as i18nText } from '../shared/i18n.mjs';
import { minimumReadableSourceTextPx } from '../shared/desktop-readability.mjs';
import {
  asArray,
  isFinitePoint,
  rectsOverlap,
  cleanEndpointSideProblems,
  cleanFlowProblems,
  cleanCrossingProblems,
  cleanAmbiguousCorridorProblems,
  cleanBorderRunProblems,
  cleanRouteRhythmProblems,
  cleanLabelRouteClearanceProblems,
  suggestLabelObstacleFix,
  suggestComponentSeparation,
  routePointsValue,
} from '../shared/geometry.mjs';
import { createModelRouter } from './model-router.mjs';

// ---- Type configuration -------------------------------------------------------
// tone: which of the seven palette slots colors the box, so presets, the
// Semantic Lens, and exports keep working without a new color vocabulary.
export const MODEL_TYPES = {
  domain: {
    collection: 'entities',
    frames: 'contexts',
    relationships: 'relationships',
    detailLevels: ['entities', 'properties', 'full'],
    detailAliases: { tables: 'entities', keys: 'properties' },
    defaultKind: 'entity',
    kinds: ['aggregate-root', 'entity', 'value-object', 'enum', 'domain-event', 'domain-service'],
    tones: {
      'aggregate-root': 'backend',
      entity: 'frontend',
      'value-object': 'database',
      enum: 'cloud',
      'domain-event': 'messagebus',
      'domain-service': 'external',
    },
    frameClass: { 'bounded-context': 'c-region', aggregate: 'c-lane', module: 'c-lane' },
    frameText: { 'bounded-context': 't-cloud', aggregate: 't-dim', module: 't-dim' },
    defaultFrameKind: 'bounded-context',
    showStereotype: () => true,
  },
  erd: {
    collection: 'tables',
    frames: 'groups',
    relationships: 'relationships',
    detailLevels: ['tables', 'keys', 'full'],
    detailAliases: { entities: 'tables', properties: 'keys' },
    defaultKind: 'table',
    kinds: ['table', 'view', 'junction'],
    tones: { table: 'backend', view: 'cloud', junction: 'external' },
    frameClass: { schema: 'c-region', module: 'c-lane', service: 'c-lane' },
    frameText: { schema: 't-cloud', module: 't-dim', service: 't-dim' },
    defaultFrameKind: 'schema',
    showStereotype: (node) => node.kind && node.kind !== 'table',
  },
  'http-call': {
    collection: 'components',
    frames: 'zones',
    relationships: 'calls',
    detailLevels: ['components', 'endpoints', 'full'],
    detailAliases: { entities: 'components', tables: 'components', properties: 'endpoints', keys: 'endpoints' },
    defaultKind: 'service',
    kinds: ['frontend', 'gateway', 'service', 'worker', 'external'],
    tones: { frontend: 'frontend', gateway: 'cloud', service: 'backend', worker: 'messagebus', external: 'external' },
    frameClass: { client: 'c-lane', platform: 'c-region', partner: 'c-lane', network: 'c-region' },
    frameText: { client: 't-dim', platform: 't-cloud', partner: 't-dim', network: 't-cloud' },
    defaultFrameKind: 'platform',
    showStereotype: () => true,
  },
};

const NODE_NOUN = { domain: 'Entity', erd: 'Table', 'http-call': 'Component' };
const NODE_NOUN_PLURAL = { domain: 'Entities', erd: 'Tables', 'http-call': 'Components' };
const FRAME_NOUN = { domain: 'Context', erd: 'Group', 'http-call': 'Zone' };
const HTTP_METHOD_STYLE = {
  GET: { className: 'a-default', end: 'arrowhead' },
  HEAD: { className: 'a-default', end: 'arrowhead' },
  OPTIONS: { className: 'a-default', end: 'arrowhead' },
  POST: { className: 'a-emphasis', end: 'arrowhead-emphasis' },
  PUT: { className: 'a-emphasis', end: 'arrowhead-emphasis' },
  PATCH: { className: 'a-emphasis', end: 'arrowhead-emphasis' },
  DELETE: { className: 'a-security', end: 'arrowhead-security' },
};

// Every relationship reads as text somewhere: edge label, passport, report.
export function relationshipLabelFor(diagramType, relationship, { bundled = false } = {}) {
  if (relationship.label) return relationship.label;
  // Bundled HTTP calls (several between one pair) keep only the verb on the
  // arrow; the served box already lists every path with its status.
  if (diagramType === 'http-call') return bundled ? relationship.method : `${relationship.method} ${relationship.path}`;
  return '';
}

function payloadSummary(payload) {
  if (!payload) return '';
  if (payload.schema) return payload.schema;
  if (payload.body) return payload.body;
  if (Array.isArray(payload.fields) && payload.fields.length) return `{ ${payload.fields.join(', ')} }`;
  return payload.content_type || '';
}

const LAYOUT = {
  defaultGrid: { origin: [40, 80], cols: 4, gapX: 56, gapY: 48 },
  margin: 40,
  legendH: 28,
  minWidth: 120,
  maxWidth: 320,
  headerH: 24,
  stereotypeH: 9,
  rowH: 12,
  sectionPad: 3,
  labelFont: 10.5,
  stereotypeFont: 6.5,
  rowFont: 7.5,
  noteFont: 6.5,
  framePad: 28,
  frameTitleH: 22,
  frameTitleFont: 8,
};

const VISIBILITY_SYMBOL = { public: '+', private: '-', protected: '#', package: '~' };

// A relationship whose two ends are the same node is drawn as an
// "auto-relationship" tag on that node instead of an arrow. The tag keeps the
// authored facts (label, cardinalities, kind or verb) in words, and the node
// still carries the relationship for the viewer's passport and reports.
const SELF_TAG_H = 14;
const SELF_TAG_FONT = 6.5;

export function selfRelationshipTag(diagramType, relationship) {
  const parts = ['auto-relationship'];
  if (diagramType === 'http-call') parts.push(`${relationship.method} ${relationship.path}`);
  else if (relationship.label) parts.push(relationship.label);
  else if (relationship.kind && relationship.kind !== 'association') parts.push(relationship.kind);
  return parts.join(' · ');
}

// The passport label keeps every authored fact the short tag leaves out.
export function selfRelationshipLabel(diagramType, relationship) {
  const parts = [relationshipLabelFor(diagramType, relationship) || selfRelationshipTag(diagramType, relationship)];
  if (diagramType !== 'http-call' && relationship.kind && relationship.kind !== 'association' && !parts[0].includes(relationship.kind)) parts.push(relationship.kind);
  if (diagramType === 'domain' && (relationship.from_cardinality || relationship.to_cardinality)) {
    parts.push(`${relationship.from_cardinality || '1'} → ${relationship.to_cardinality || '1'}`);
  }
  return parts.join(' · ');
}

// Member and stereotype text must stay legible once the viewer projects a
// wide viewBox onto a 1440px desktop. Fonts scale up from these bases until
// the smallest one clears the desktop-readability floor for the final viewBox.
function fontSet(scale = 1) {
  return {
    label: LAYOUT.labelFont,
    stereotype: Math.round(LAYOUT.stereotypeFont * scale * 100) / 100,
    row: Math.round(LAYOUT.rowFont * scale * 100) / 100,
    note: Math.round(LAYOUT.noteFont * scale * 100) / 100,
    rowH: Math.round(LAYOUT.rowH * Math.max(1, scale) * 100) / 100,
    stereotypeH: Math.round(LAYOUT.stereotypeH * Math.max(1, scale) * 100) / 100,
  };
}

function textWidth(text, fontSize) {
  return textUnits(text) * fontSize * 0.6;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

// Relationship labels sit on the chosen segment's midpoint. Horizontal
// segments lift the label above the line like every other renderer; vertical
// segments keep it centered on the line under its mask, because "above the
// start point" would land inside the source box.
export function modelLabelPoint(item, points) {
  if (item.labelAt) return item.labelAt;
  let segmentIndex = 0;
  if (Number.isInteger(item.labelSegment)) segmentIndex = Math.min(points.length - 2, Math.max(0, item.labelSegment));
  else {
    // Default to the longest segment: on stub-bridge-stub routes the middle
    // segment can be a 16px jog that no label fits beside.
    let longest = -1;
    for (let index = 0; index < points.length - 1; index += 1) {
      const length = Math.hypot(points[index + 1][0] - points[index][0], points[index + 1][1] - points[index][1]);
      if (length > longest + 1e-9) { longest = length; segmentIndex = index; }
    }
  }
  const a = points[segmentIndex];
  const b = points[segmentIndex + 1];
  const vertical = Math.abs(a[0] - b[0]) < 1;
  const labelWidth = Math.max(30, textUnits(item.label || '') * 4.8 + 10);
  return [
    (a[0] + b[0]) / 2 - (vertical ? labelWidth / 2 + 6 : 0) + (item.labelDx || 0),
    (a[1] + b[1]) / 2 + (vertical ? 3 : -10) + (item.labelDy || 0),
  ];
}

// ---- Detail level -------------------------------------------------------------
export function resolveDetail(diagramType, meta, requested) {
  const config = MODEL_TYPES[diagramType];
  const candidate = requested || meta?.detail || 'full';
  const normalized = config.detailLevels.includes(candidate) ? candidate : (config.detailAliases[candidate] || candidate);
  if (!config.detailLevels.includes(normalized)) {
    throwDiagnosticProblems(`${diagramType} detail level is invalid`, [
      `[model/detail-invalid] Detail level "${candidate}" is not one of ${config.detailLevels.join(', ')} — pass --detail <level> or set meta.detail.`,
    ], { subject: { diagramType, path: '/meta/detail' } });
  }
  return normalized;
}

// ---- Member rows -------------------------------------------------------------
function visibilitySymbol(member) {
  return VISIBILITY_SYMBOL[member.visibility || 'public'];
}

function domainRows(node, detail) {
  if (detail === 'entities') return [];
  const attributes = asArray(node.attributes).map((attribute) => ({
    section: 'attributes',
    text: `${visibilitySymbol(attribute)}${attribute.name}${attribute.type ? `: ${attribute.type}` : ''}`,
    trailing: attribute.note || '',
    underline: Boolean(attribute.static),
    key: attribute.name,
  }));
  if (detail === 'properties') return attributes;
  const methods = asArray(node.methods).map((method) => ({
    section: 'methods',
    text: `${visibilitySymbol(method)}${method.name}(${method.params || ''})${method.returns ? `: ${method.returns}` : ''}`,
    trailing: '',
    underline: Boolean(method.static),
    key: method.name,
  }));
  return [...attributes, ...methods];
}

function erdRows(node, detail) {
  if (detail === 'tables') return [];
  const columns = asArray(node.columns).filter((column) => detail === 'full' || column.pk || column.fk);
  return columns.map((column) => {
    const badge = [column.pk ? 'PK' : '', column.fk ? 'FK' : '', column.unique && !column.pk ? 'U' : ''].filter(Boolean).join(' ');
    return {
      section: column.pk ? 'keys' : 'columns',
      badge,
      text: column.name,
      trailing: column.type ? `${column.type}${column.nullable ? '?' : ''}` : (column.nullable ? 'null' : ''),
      underline: false,
      key: column.name,
    };
  });
}

function httpRows(node, detail, diagram) {
  if (detail === 'components') return [];
  const served = asArray(diagram.calls).filter((call) => call.to === node.id);
  const seen = new Set();
  const rows = [];
  for (const call of served) {
    const key = `${call.method} ${call.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const status = call.response?.status ? String(call.response.status) : '';
    rows.push({ section: 'endpoints', badge: call.method, text: call.path, trailing: status, underline: false, key });
    if (detail !== 'full') continue;
    const request = payloadSummary(call.request);
    const response = payloadSummary(call.response);
    if (request) rows.push({ section: 'endpoints', sub: true, text: `req ${request}`, trailing: '', underline: false, key: `${key} request` });
    if (response) rows.push({ section: 'endpoints', sub: true, text: `res ${response}`, trailing: '', underline: false, key: `${key} response` });
  }
  return rows;
}

function memberRows(diagramType, node, detail, diagram) {
  if (diagramType === 'domain') return domainRows(node, detail);
  if (diagramType === 'erd') return erdRows(node, detail);
  return httpRows(node, detail, diagram);
}

// ---- Measurement -------------------------------------------------------------
function stereotypeFor(diagramType, node, locale) {
  const config = MODEL_TYPES[diagramType];
  if (!config.showStereotype(node)) return '';
  if (node.stereotype) return `«${node.stereotype}»`;
  if (diagramType === 'http-call' && node.base_url) return node.base_url;
  const kind = node.kind || config.defaultKind;
  return `«${i18nText(locale, `legend.${diagramType}.${kind}`)}»`;
}

function measureNode(diagramType, node, detail, locale, fonts, diagram) {
  const config = MODEL_TYPES[diagramType];
  const kind = node.kind || config.defaultKind;
  const selfRelationships = asArray(diagram[config.relationships]).filter((relationship) => relationship.from === node.id && relationship.to === node.id);
  const selfTags = selfRelationships.map((relationship) => ({ relationship, text: selfRelationshipTag(diagramType, relationship) }));
  const stereotype = stereotypeFor(diagramType, node, locale);
  const rows = memberRows(diagramType, node, detail, diagram);
  const headerH = LAYOUT.headerH + (stereotype ? fonts.stereotypeH : 0);
  const sections = [];
  for (const row of rows) {
    const last = sections[sections.length - 1];
    if (last && last.name === row.section) last.rows.push(row);
    else sections.push({ name: row.section, rows: [row] });
  }
  const bodyH = sections.reduce((sum, section) => sum + section.rows.length * fonts.rowH + LAYOUT.sectionPad * 2, 0);
  const noteH = node.note && detail !== config.detailLevels[0] ? fonts.rowH : 0;
  const tagsH = selfTags.length * SELF_TAG_H;
  const height = Math.round(headerH + bodyH + noteH + tagsH + (rows.length || noteH || tagsH ? 2 : 6));
  const widest = Math.max(
    textWidth(node.label, fonts.label) + 40,
    stereotype ? textWidth(stereotype, fonts.stereotype) + 28 : 0,
    node.note ? textWidth(node.note, fonts.note) + 20 : 0,
    ...selfTags.map((tag) => textWidth(tag.text, SELF_TAG_FONT) + 30),
    ...rows.map((row) => textWidth(`${row.badge ? `${row.badge} ` : ''}${row.text}`, fonts.row)
      + (row.trailing ? textWidth(row.trailing, fonts.row) + 14 : 0) + (row.sub ? 30 : 20)),
  );
  const width = Math.round(node.width || Math.min(LAYOUT.maxWidth, Math.max(LAYOUT.minWidth, widest)));
  return {
    ...node,
    kind,
    tone: config.tones[kind] || 'external',
    stereotype,
    rows,
    sections,
    selfTags,
    headerH,
    width,
    height,
    memberCount: rows.length,
  };
}

// ---- Grid placement ------------------------------------------------------------
function placeNodes(diagram, measured) {
  const grid = { ...LAYOUT.defaultGrid, ...(diagram.layout || {}) };
  const colWidths = [];
  const rowHeights = [];
  for (const node of measured) {
    if (Array.isArray(node.pos)) continue;
    if (!Number.isInteger(node.row) || !Number.isInteger(node.col)) continue;
    colWidths[node.col] = Math.max(colWidths[node.col] || 0, node.width);
    rowHeights[node.row] = Math.max(rowHeights[node.row] || 0, node.height);
  }
  const colX = [];
  let cursor = grid.origin[0];
  for (let col = 0; col < colWidths.length; col += 1) {
    colX[col] = cursor;
    cursor += (colWidths[col] || 0) + grid.gapX;
  }
  const rowY = [];
  cursor = grid.origin[1];
  for (let row = 0; row < rowHeights.length; row += 1) {
    rowY[row] = cursor;
    cursor += (rowHeights[row] || 0) + grid.gapY;
  }
  return {
    grid,
    nodes: measured.map((node) => {
      let x = NaN;
      let y = NaN;
      if (Array.isArray(node.pos) && node.pos.length === 2) [x, y] = node.pos;
      else if (Number.isInteger(node.row) && Number.isInteger(node.col)) {
        // Center inside the cell so boxes in one column share a center line
        // and boxes in one row share a center height; automatic routes then
        // leave stacked or side-by-side boxes as straight lines.
        x = Math.round(colX[node.col] + ((colWidths[node.col] || node.width) - node.width) / 2);
        y = Math.round(rowY[node.row] + ((rowHeights[node.row] || node.height) - node.height) / 2);
      }
      return { ...node, x, y, cx: x + node.width / 2, cy: y + node.height / 2 };
    }),
  };
}

// ---- Frames ------------------------------------------------------------------
function measureFrame(diagramType, frame, index, nodesById) {
  const config = MODEL_TYPES[diagramType];
  const members = asArray(frame.wraps).map((id) => nodesById.get(id)).filter(Boolean);
  if (!members.length) return null;
  const pad = frame.pad ?? LAYOUT.framePad;
  const topPad = Math.max(pad, LAYOUT.frameTitleH + 6);
  const minX = Math.min(...members.map((m) => m.x));
  const minY = Math.min(...members.map((m) => m.y));
  const maxX = Math.max(...members.map((m) => m.x + m.width));
  const maxY = Math.max(...members.map((m) => m.y + m.height));
  const kind = frame.kind || config.defaultFrameKind;
  const width = maxX - minX + pad * 2;
  const titleWidth = Math.min(width - 16, textWidth(frame.label, LAYOUT.frameTitleFont) + 12);
  return {
    ...frame,
    index,
    kind,
    x: minX - pad,
    y: minY - topPad,
    width,
    height: maxY - minY + topPad + pad,
    title: { x: minX - pad + 8, y: minY - topPad + 5, width: titleWidth, height: LAYOUT.frameTitleH - 8 },
    className: config.frameClass[kind] || 'c-lane',
    textClass: config.frameText[kind] || 't-dim',
    radius: kind === 'bounded-context' || kind === 'schema' ? 12 : 9,
  };
}

function rectContains(outer, inner) {
  const epsilon = 1e-9;
  return outer.x <= inner.x + epsilon && outer.y <= inner.y + epsilon
    && outer.x + outer.width + epsilon >= inner.x + inner.width
    && outer.y + outer.height + epsilon >= inner.y + inner.height;
}

// ---- Relationship notation ------------------------------------------------------
const DOMAIN_NOTATION = {
  association: { className: 'a-default', start: '', end: 'model-arrow-open' },
  composition: { className: 'a-default', start: 'model-diamond-filled', end: '' },
  aggregation: { className: 'a-default', start: 'model-diamond-hollow', end: '' },
  inheritance: { className: 'a-default', start: '', end: 'model-triangle-hollow' },
  dependency: { className: 'a-model-dashed', start: '', end: 'model-arrow-open' },
};

function erdMarker(side, optional) {
  return `model-crow-${side}${optional ? '-optional' : ''}`;
}

function relationshipNotation(diagramType, relationship) {
  if (diagramType === 'domain') return DOMAIN_NOTATION[relationship.kind] || DOMAIN_NOTATION.association;
  if (diagramType === 'http-call') {
    if (relationship.async) return { className: 'a-model-dashed', start: '', end: 'model-arrow-open' };
    const style = HTTP_METHOD_STYLE[relationship.method] || HTTP_METHOD_STYLE.GET;
    return { className: style.className, start: '', end: style.end };
  }
  const [fromSide, toSide] = relationship.kind.split('-to-');
  return {
    className: 'a-default',
    start: erdMarker(fromSide, Boolean(relationship.from_optional)),
    end: erdMarker(toSide, Boolean(relationship.to_optional)),
  };
}

export function renderModelDefinitions() {
  return `        <defs>
          <marker id="model-arrow-open" markerWidth="11" markerHeight="11" refX="10" refY="5.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0 L10 5.5 L0 11" class="m-line"/>
          </marker>
          <marker id="model-triangle-hollow" markerWidth="13" markerHeight="13" refX="12" refY="6.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0 L12 6.5 L0 13 Z" class="m-hollow"/>
          </marker>
          <marker id="model-diamond-filled" markerWidth="15" markerHeight="11" refX="14" refY="5.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M0 5.5 L7 0 L14 5.5 L7 11 Z" class="m-default"/>
          </marker>
          <marker id="model-diamond-hollow" markerWidth="15" markerHeight="11" refX="14" refY="5.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M0 5.5 L7 0 L14 5.5 L7 11 Z" class="m-hollow"/>
          </marker>
          <marker id="model-crow-one" markerWidth="13" markerHeight="13" refX="12" refY="6.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M7 0.5 L7 12.5" class="m-line"/>
          </marker>
          <marker id="model-crow-one-optional" markerWidth="19" markerHeight="13" refX="18" refY="6.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <circle cx="4" cy="6.5" r="3" class="m-hollow"/>
            <path d="M13 0.5 L13 12.5" class="m-line"/>
          </marker>
          <marker id="model-crow-many" markerWidth="13" markerHeight="13" refX="12" refY="6.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M0 6.5 L12 0.5 M0 6.5 L12 6.5 M0 6.5 L12 12.5" class="m-line"/>
          </marker>
          <marker id="model-crow-many-optional" markerWidth="19" markerHeight="13" refX="18" refY="6.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <circle cx="4" cy="6.5" r="3" class="m-hollow"/>
            <path d="M7 6.5 L18 0.5 M7 6.5 L18 6.5 M7 6.5 L18 12.5" class="m-line"/>
          </marker>
        </defs>`;
}

// ---- Compile -------------------------------------------------------------------
export function compileModel({ diagramType, diagram, detail: requestedDetail, qualityProfile } = {}) {
  const config = MODEL_TYPES[diagramType];
  if (!config) throw new Error(`compileModel: unknown diagram type ${JSON.stringify(diagramType)}`);
  const meta = diagram.meta || {};
  const locale = meta.locale;
  const profile = qualityProfile || meta.quality_profile;
  const detail = resolveDetail(diagramType, meta, requestedDetail);
  const rawNodes = asArray(diagram[config.collection]);
  const rawFrames = asArray(diagram[config.frames]);
  const relationships = asArray(diagram[config.relationships]);

  const legendCatalog = config.kinds.map((kind) => ({ kind, label: i18nText(locale, `legend.${diagramType}.${kind}`) }));
  const legendEntries = resolveLegend(meta.legend, legendCatalog, new Set(rawNodes.map((node) => node.kind || config.defaultKind)));

  function autoViewBoxFor(nodeMap, frameList) {
    const maxX = Math.max(0, ...[...nodeMap.values()].map((n) => n.x + n.width), ...frameList.map((f) => f.x + f.width));
    const maxY = Math.max(0, ...[...nodeMap.values()].map((n) => n.y + n.height), ...frameList.map((f) => f.y + f.height));
    let width = Math.ceil(maxX + LAYOUT.margin);
    let footprint = legendFootprint(legendEntries, { width: Math.max(1, width - LAYOUT.margin * 2) });
    if (footprint.minWidth > width - LAYOUT.margin * 2) {
      width = Math.ceil(footprint.minWidth + LAYOUT.margin * 2);
      footprint = legendFootprint(legendEntries, { width: width - LAYOUT.margin * 2 });
    }
    const height = Math.max(280, Math.ceil(maxY + LAYOUT.margin + LAYOUT.legendH + footprint.extraHeight));
    // The desktop viewer projects the viewBox onto the reader width, so a
    // square model becomes a tall page. Keep a landscape floor; extra width
    // is empty margin and never moves authored geometry.
    return [Math.max(420, width, Math.ceil(height * 2)), height];
  }

  // Measure, place, and size the viewBox; then grow the small fonts until the
  // smallest one survives desktop projection of that viewBox. Wider fonts widen
  // boxes and the viewBox, so iterate to a fixed point.
  let fonts = fontSet(1);
  let measured;
  let placed;
  let nodes;
  let frames;
  let viewBox;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    measured = rawNodes.map((node) => measureNode(diagramType, node, detail, locale, fonts, diagram));
    placed = placeNodes(diagram, measured);
    nodes = new Map(placed.nodes.map((node) => [node.id, node]));
    frames = rawFrames.map((frame, index) => measureFrame(diagramType, frame, index, nodes)).filter(Boolean);
    viewBox = Array.isArray(meta.viewBox) ? meta.viewBox : autoViewBoxFor(nodes, frames);
    const floor = minimumReadableSourceTextPx(viewBox[0]);
    const smallest = Math.min(fonts.stereotype, fonts.row, fonts.note);
    if (!Number.isFinite(floor) || smallest >= floor - 1e-9) break;
    fonts = fontSet((floor + 0.05) / Math.min(LAYOUT.stereotypeFont, LAYOUT.rowFont, LAYOUT.noteFont));
  }
  // Self relationships never route, so they must not reserve ports either.
  const router = createModelRouter({ relations: relationships.filter((r) => r.from !== r.to), boxes: nodes });

  const nodeSteps = new Map();
  for (const [index, relationship] of relationships.entries()) {
    if (!nodeSteps.has(relationship.from)) nodeSteps.set(relationship.from, index);
    if (!nodeSteps.has(relationship.to)) nodeSteps.set(relationship.to, index + 1);
  }
  for (const [index, node] of rawNodes.entries()) if (!nodeSteps.has(node.id)) nodeSteps.set(node.id, index);

  // Parallel relationships between one pair (several HTTP calls to the same
  // service, a pair of associations) stack their labels instead of piling
  // them on the same midpoint. Explicit labelAt/labelDy always wins.
  const parallelGroups = new Map();
  for (const relationship of relationships) {
    const key = [relationship.from, relationship.to].sort().join('~');
    const group = parallelGroups.get(key) || [];
    group.push(relationship);
    parallelGroups.set(key, group);
  }
  function labelFor(relationship) {
    const group = parallelGroups.get([relationship.from, relationship.to].sort().join('~')) || [];
    return relationshipLabelFor(diagramType, relationship, { bundled: group.length > 1 });
  }
  function longestSegment(points) {
    let best = 0;
    let longest = -1;
    for (let index = 0; index < points.length - 1; index += 1) {
      const length = Math.hypot(points[index + 1][0] - points[index][0], points[index + 1][1] - points[index][1]);
      if (length > longest + 1e-9) { longest = length; best = index; }
    }
    return [points[best], points[best + 1]];
  }
  // Bundled labels stack outward from the outermost route of the bundle
  // (above a horizontal bundle, left of a vertical one), so no label ever
  // sits on a sibling call's line. Explicit labelAt/labelDy/labelDx opt out.
  function bundleLabelPoint(relationship, label) {
    if (relationship.labelAt || relationship.labelDy !== undefined || relationship.labelDx !== undefined) return null;
    const group = parallelGroups.get([relationship.from, relationship.to].sort().join('~')) || [];
    if (group.length < 2) return null;
    const members = group.filter((member) => nodes.has(member.from) && nodes.has(member.to) && member.from !== member.to);
    const index = members.indexOf(relationship);
    if (index < 0) return null;
    const segments = members.map((member) => longestSegment(router.pathFor(member).points));
    const horizontal = segments.every(([a, b]) => Math.abs(a[1] - b[1]) < 1);
    const vertical = segments.every(([a, b]) => Math.abs(a[0] - b[0]) < 1);
    const [a, b] = segments[index];
    if (horizontal) {
      const top = Math.min(...segments.map(([p]) => p[1]));
      return [(a[0] + b[0]) / 2, top - 10 - index * 18];
    }
    if (vertical) {
      const left = Math.min(...segments.map(([p]) => p[0]));
      const widest = Math.max(...members.map((member) => Math.max(30, textUnits(labelFor(member)) * 4.8 + 10)));
      return [left - 6 - widest / 2 - index * (widest + 6), (a[1] + b[1]) / 2 + 3];
    }
    return null;
  }

  function relationshipLabelRect(relationship) {
    const label = labelFor(relationship);
    if (!label) return null;
    const points = router.pathFor(relationship).points;
    const [x, y] = bundleLabelPoint(relationship, label) || modelLabelPoint({ ...relationship, label }, points);
    const width = Math.max(30, textUnits(label) * 4.8 + 10);
    return { x: x - width / 2, y: y - 10, width, height: 14, lx: x, ly: y, label };
  }

  // ---- Validation ------------------------------------------------------------
  function validate() {
    const problems = [];
    const nodeLabel = NODE_NOUN[diagramType];
    const frameLabel = FRAME_NOUN[diagramType];
    if (nodes.size !== rawNodes.length) problems.push(`[model/duplicate-id] ${nodeLabel} ids must be unique.`);
    const grid = placed.grid;
    const cells = new Map();
    for (const node of nodes.values()) {
      if (!isFinitePoint(node.x, node.y, node.width, node.height)) {
        problems.push(`[model/placement-required] ${nodeLabel} "${node.id}" needs grid row/col or pos [x, y].`);
        continue;
      }
      if (Number.isInteger(node.col) && node.col >= grid.cols && !Array.isArray(node.pos)) {
        problems.push(`[model/grid-overflow] ${nodeLabel} "${node.id}" col ${node.col} exceeds layout.cols ${grid.cols} (valid: 0..${grid.cols - 1}).`);
      }
      if (!Array.isArray(node.pos) && Number.isInteger(node.row) && Number.isInteger(node.col)) {
        const key = `${node.row},${node.col}`;
        if (cells.has(key)) problems.push(`[model/grid-collision] ${NODE_NOUN_PLURAL[diagramType]} "${cells.get(key)}" and "${node.id}" share grid cell row ${node.row} col ${node.col}.`);
        else cells.set(key, node.id);
      }
      if (node.x < 0 || node.y < 0 || node.x + node.width > viewBox[0] || node.y + node.height > viewBox[1]) {
        problems.push(`[model/outside-viewbox] ${nodeLabel} "${node.id}" falls outside the viewBox ${viewBox[0]}x${viewBox[1]} — adjust placement or set a larger meta.viewBox.`);
      }
      const labelWidth = textWidth(node.label, fonts.label) + 40;
      if (labelWidth > node.width + 4) {
        problems.push(`[model/label-too-wide] Label "${node.label}" (~${Math.round(labelWidth)}px) is wider than ${nodeLabel.toLowerCase()} "${node.id}" (${node.width}px) — shorten the label or widen width.`);
      }
      for (const row of node.rows) {
        const rowWidth = textWidth(`${row.badge ? `${row.badge} ` : ''}${row.text}`, fonts.row) + (row.trailing ? textWidth(row.trailing, fonts.row) + 14 : 0) + 20;
        if (rowWidth > node.width + 4) {
          problems.push(`[model/member-too-wide] Member "${row.key}" of "${node.id}" needs ~${Math.round(rowWidth)}px but the box provides ${node.width}px — shorten the member text or widen width.`);
        }
      }
    }
    const list = [...nodes.values()].filter((node) => isFinitePoint(node.x, node.y, node.width, node.height));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (rectsOverlap(list[i], list[j], 8)) {
          problems.push(`[model/overlap] ${NODE_NOUN_PLURAL[diagramType]} "${list[i].id}" and "${list[j].id}" are less than 8px apart — move one or shrink its width.\n${suggestComponentSeparation(list[i], list[j], 8)}`);
        }
      }
    }
    for (const frame of rawFrames) {
      for (const id of asArray(frame.wraps)) {
        if (!nodes.has(id)) problems.push(`[model/frame-unknown-member] ${frameLabel} "${frame.label}" wraps unknown id "${id}".`);
      }
    }
    for (const frame of frames) {
      if (frame.x < 0 || frame.y < 0 || frame.x + frame.width > viewBox[0] || frame.y + frame.height > viewBox[1]) {
        problems.push(`[model/frame-outside-viewbox] ${frameLabel} "${frame.label}" extends outside the viewBox — add margin or enlarge meta.viewBox.`);
      }
      const members = new Set(asArray(frame.wraps));
      for (const node of list) {
        if (members.has(node.id)) continue;
        if (rectsOverlap(frame, node, -2)) {
          problems.push(`[model/frame-intrusion] ${frameLabel} "${frame.label}" overlaps "${node.id}", which it does not wrap — move the ${nodeLabel.toLowerCase()} or add it to wraps.`);
        }
      }
    }
    for (let i = 0; i < frames.length; i += 1) {
      for (let j = i + 1; j < frames.length; j += 1) {
        const left = frames[i];
        const right = frames[j];
        if (!rectsOverlap(left, right)) continue;
        if (!rectContains(left, right) && !rectContains(right, left)) {
          problems.push(`[model/frame-overlap] ${frameLabel} frames "${left.label}" and "${right.label}" partially overlap — adjust wraps, pad, or placement so frames are disjoint or nested.`);
        }
      }
    }
    for (const relationship of relationships) {
      const name = labelFor(relationship) || `${relationship.from}->${relationship.to}`;
      if (!nodes.has(relationship.from)) problems.push(`[model/unknown-endpoint] Relationship "${name}" references unknown source "${relationship.from}".`);
      if (!nodes.has(relationship.to)) problems.push(`[model/unknown-endpoint] Relationship "${name}" references unknown target "${relationship.to}".`);
      if (nodes.has(relationship.from) && nodes.has(relationship.to) && relationship.from !== relationship.to) {
        const routed = router.pathFor(relationship);
        const [start, end] = [routed.points[0], routed.points[routed.points.length - 1]];
        const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (distance < 24) problems.push(`[model/relationship-too-short] Relationship "${name}" is too short (${Math.round(distance)}px; minimum 24px) — place its endpoints farther apart.`);
      }
    }
    const routable = relationships.filter((r) => nodes.has(r.from) && nodes.has(r.to) && r.from !== r.to);
    const endpointIds = new Set(nodes.keys());
    const shared = { relations: routable, endpointIds, pathFor: router.pathFor, diagramType, relationCollection: config.relationships };
    problems.push(...cleanEndpointSideProblems({
      ...shared,
      fromSideFor: (relationship) => router.endpointSide(relationship, 'source'),
      toSideFor: (relationship) => router.endpointSide(relationship, 'target'),
      routeHint: 'keep automatic routing or set truthful fromSide/toSide with perpendicular via segments',
    }));
    problems.push(...cleanFlowProblems({
      ...shared,
      obstacles: nodes.values(),
      obstacleKind: NODE_NOUN[diagramType].toLowerCase(),
      routeHint: 'adjust fromSide/toSide, set route/via, or move the box',
    }));
    problems.push(...cleanCrossingProblems({ ...shared, profile, routeHint: 'adjust route/via or fromSide/toSide so the relationships use separate corridors' }));
    problems.push(...cleanAmbiguousCorridorProblems({ ...shared, profile, routeHint: 'adjust route/via or fromSide/toSide so unrelated relationships do not visually merge' }));
    problems.push(...cleanBorderRunProblems({ ...shared, frames: frames.map((frame) => ({ ...frame, id: frame.id, kind: frame.kind })), profile, routeHint: 'adjust route/via or fromSide/toSide so the relationship crosses the frame perpendicularly' }));
    problems.push(...cleanRouteRhythmProblems({ ...shared, profile, routeHint: 'move route/via points into a wider corridor or move the box so every turn has room to read' }));
    const labelRects = [];
    for (const [index, relationship] of routable.entries()) {
      const rect = relationshipLabelRect(relationship);
      if (!rect) continue;
      labelRects.push({ relation: relationship, relationIndex: index, label: rect.label, ...rect });
      for (const node of nodes.values()) {
        if (rectsOverlap(rect, node, -2)) {
          problems.push(`[model/label-overlap] Label "${rect.label}" overlaps "${node.id}" — adjust labelDx/labelDy/labelSegment or set labelAt.\n${suggestLabelObstacleFix(rect, rect.lx, rect.ly, node)}`);
        }
      }
    }
    problems.push(...cleanLabelRouteClearanceProblems({ ...shared, labels: labelRects, profile }));
    if (problems.length) {
      throwDiagnosticProblems(`${diagramType} layout validation failed`, problems, { subject: { diagramType } });
    }
  }

  // ---- Rendering ---------------------------------------------------------------
  function nodeContext(node) {
    const scopes = frames.filter((frame) => asArray(frame.wraps).includes(node.id))
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))
      .map((frame) => frame.label);
    return scopes.length ? scopes.join(' › ') : i18nText(locale, `node.context.${diagramType}`);
  }

  function renderFrame(frame) {
    return `        <rect data-graph-role="structural-frame" data-composition-frame-kind="${esc(frame.kind)}" data-composition-frame-id="${esc(String(frame.id))}" data-composition-frame-label="${esc(frame.label)}" x="${round(frame.x)}" y="${round(frame.y)}" width="${round(frame.width)}" height="${round(frame.height)}" rx="${frame.radius}" class="${frame.className}" stroke-width="1"/>`;
  }

  function renderFrameLabel(frame) {
    return `        <g data-graph-role="structural-frame-label" data-composition-frame-id="${esc(String(frame.id))}" data-composition-frame-kind="${esc(frame.kind)}" data-composition-frame-label="${esc(frame.label)}">
          <rect data-graph-role="structural-frame-label-mask" x="${round(frame.title.x)}" y="${round(frame.title.y)}" width="${round(frame.title.width)}" height="${frame.title.height}" rx="3" class="c-mask"/>
          <text data-boundary-label="" x="${round(frame.title.x + 4)}" y="${round(frame.title.y + 10)}" class="${frame.textClass}" font-size="${LAYOUT.frameTitleFont}" font-weight="600">${esc(frame.label)}</text>
        </g>`;
  }

  function renderRow(node, row, y) {
    const left = node.x + (row.sub ? 18 : 8);
    const parts = [];
    if (row.badge) {
      parts.push(`<tspan class="t-${node.tone}" font-weight="700">${esc(row.badge)}</tspan><tspan> </tspan>`);
    }
    parts.push(`<tspan${row.underline ? ' text-decoration="underline"' : ''}>${esc(row.text)}</tspan>`);
    const trailing = row.trailing
      ? `\n          <text data-detail="context" x="${round(node.x + node.width - 8)}" y="${round(y)}" class="t-dim" font-size="${fonts.row}" text-anchor="end">${esc(row.trailing)}</text>`
      : '';
    return `          <text data-detail="context" data-model-member="${esc(row.section)}" x="${round(left)}" y="${round(y)}" class="${row.sub ? 't-dim' : 't-muted'}" font-size="${fonts.row}">${parts.join('')}</text>${trailing}`;
  }

  function renderNode(node) {
    const passport = {
      kind: node.kind,
      sublabel: node.stereotype ? node.stereotype.replace(/[«»]/g, '') : (node.note || ''),
      context: nodeContext(node),
      tag: node.memberCount ? `${node.memberCount} ${diagramType === 'domain' ? 'members' : diagramType === 'erd' ? 'columns' : 'rows'}` : '',
    };
    const fill = `c-${node.tone}`;
    const labelY = node.y + (node.stereotype ? fonts.stereotypeH + 15 : 15);
    const stereotype = node.stereotype
      ? `\n          <text data-detail="context" x="${round(node.cx)}" y="${round(node.y + fonts.stereotypeH)}" class="t-dim" font-size="${fonts.stereotype}" text-anchor="middle">${esc(node.stereotype)}</text>`
      : '';
    const body = [];
    let cursor = node.y + node.headerH;
    if (node.sections.length) {
      body.push(`          <line x1="${round(node.x)}" y1="${round(cursor)}" x2="${round(node.x + node.width)}" y2="${round(cursor)}" class="a-default" stroke-width="0.8"/>`);
    }
    for (const [sectionIndex, section] of node.sections.entries()) {
      if (sectionIndex > 0) {
        body.push(`          <line x1="${round(node.x)}" y1="${round(cursor)}" x2="${round(node.x + node.width)}" y2="${round(cursor)}" class="a-default" stroke-width="0.6" stroke-dasharray="2,2"/>`);
      }
      cursor += LAYOUT.sectionPad;
      for (const row of section.rows) {
        cursor += fonts.rowH;
        body.push(renderRow(node, row, cursor - 3.5));
      }
      cursor += LAYOUT.sectionPad;
    }
    const tags = node.selfTags.map((tag, tagIndex) => {
      const index = relationships.indexOf(tag.relationship);
      const y = node.y + node.height - 4 - (node.selfTags.length - 1 - tagIndex) * SELF_TAG_H - (node.note && detail !== config.detailLevels[0] ? fonts.rowH : 0);
      const width = Math.min(node.width - 12, Math.round(textWidth(tag.text, SELF_TAG_FONT) + 14));
      const label = selfRelationshipLabel(diagramType, tag.relationship);
      return `
          <g data-detail="context" data-model-self-relationship="${esc(tag.relationship.kind || tag.relationship.method || 'association')}" ${focusEdgeAttrs(node.id, node.id, label, index, tag.relationship.id)}>
            <rect x="${round(node.cx - width / 2)}" y="${round(y - SELF_TAG_H + 2)}" width="${width}" height="${SELF_TAG_H - 3}" rx="5" class="a-default" stroke-width="0.8"/>
            <text x="${round(node.cx)}" y="${round(y - 3.5)}" class="t-muted" font-size="${SELF_TAG_FONT}" text-anchor="middle">⟲ ${esc(tag.text)}</text>
          </g>`;
    }).join('');
    const note = node.note && detail !== config.detailLevels[0]
      ? `\n          <text data-detail="fine" x="${round(node.cx)}" y="${round(node.y + node.height - 5)}" class="t-dim" font-size="${fonts.note}" text-anchor="middle" font-style="italic">${esc(node.note)}</text>`
      : '';
    return `        <g ${focusNodeAttrs(node.id, node.label, passport, locale)}>
          ${focusNodeTitle(node.label, passport)}
          <rect x="${round(node.x)}" y="${round(node.y)}" width="${node.width}" height="${node.height}" rx="6" class="c-mask"/>
          <rect x="${round(node.x)}" y="${round(node.y)}" width="${node.width}" height="${node.height}" rx="6" class="${fill}"${animateAttr(meta, 'node', nodeSteps.get(node.id))} stroke-width="1.5"/>
          ${renderSemanticSigil(node.tone, { x: node.x + 6, y: node.y + 6 })}${stereotype}
          <text data-node-label="" x="${round(node.cx)}" y="${round(labelY)}" class="t-primary" font-size="${fonts.label}" font-weight="600" text-anchor="middle">${esc(node.label)}</text>
${body.join('\n')}${note}${tags}
        </g>`;
  }

  function endpointAnnotation(points, atStart, text) {
    if (!text) return '';
    const anchorPoint = atStart ? points[0] : points[points.length - 1];
    const next = atStart ? points[1] : points[points.length - 2];
    const dx = next[0] - anchorPoint[0];
    const dy = next[1] - anchorPoint[1];
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const horizontal = Math.abs(ux) >= Math.abs(uy);
    const width = Math.max(14, textUnits(text) * 4.4 + 6);
    const along = 14;
    const x = anchorPoint[0] + ux * along + (horizontal ? 0 : 6 + width / 2);
    const y = anchorPoint[1] + uy * along + (horizontal ? 10 : 0);
    return `
          <rect x="${round(x - width / 2)}" y="${round(y - 5)}" width="${round(width)}" height="10" rx="2" class="c-mask"/>
          <text x="${round(x)}" y="${round(y + 2.5)}" class="t-muted" font-size="7" font-weight="600" text-anchor="middle">${esc(text)}</text>`;
  }

  function renderRelationshipPath(relationship, index) {
    const notation = relationshipNotation(diagramType, relationship);
    const routed = router.pathFor(relationship);
    const start = notation.start ? ` marker-start="url(#${notation.start})"` : '';
    const end = notation.end ? ` marker-end="url(#${notation.end})"` : '';
    const label = relationshipLabelFor(diagramType, relationship);
    return `        <path ${focusEdgeAttrs(relationship.from, relationship.to, label, index, relationship.id)} data-model-relationship="${esc(relationship.kind || relationship.method)}" data-composition-points="${routePointsValue(routed.points)}" d="${routed.d}" class="${notation.className}"${animateAttr(meta, 'edge', index)} stroke-width="1.4"${start}${end}/>`;
  }

  function renderRelationshipLabel(relationship, index) {
    const routed = router.pathFor(relationship);
    const cardinalities = diagramType === 'domain'
      ? endpointAnnotation(routed.points, true, relationship.from_cardinality) + endpointAnnotation(routed.points, false, relationship.to_cardinality)
      : '';
    const rect = relationshipLabelRect(relationship);
    const labelClass = diagramType === 'http-call' ? (relationship.method === 'DELETE' ? 't-security' : (['POST', 'PUT', 'PATCH'].includes(relationship.method) ? 't-backend' : 't-muted')) : 't-muted';
    const label = rect
      ? `
          <rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.width)}" height="14" rx="3" class="c-mask"/>
          <text x="${round(rect.lx)}" y="${round(rect.ly)}" class="${labelClass}" font-size="8" text-anchor="middle">${esc(rect.label)}</text>`
      : '';
    if (!label && !cardinalities) return '';
    return `        <g data-detail="context" ${focusEdgeAttrs(relationship.from, relationship.to, rect ? rect.label : '', index, relationship.id)}>${label}${cardinalities}
        </g>`;
  }

  function renderLegend() {
    const obstacles = relationshipLegendObstacles(relationships, {
      pointsFor: (relationship) => router.pathFor(relationship).points,
      labelRectFor: (relationship) => relationshipLabelRect(relationship),
    });
    const contentBottom = Math.max(0, ...[...nodes.values()].map((n) => n.y + n.height), ...frames.map((f) => f.y + f.height));
    return renderResolvedLegend({
      entries: legendEntries,
      locale,
      layout: {
        x: LAYOUT.margin,
        baselineY: viewBox[1] - 16,
        width: viewBox[0] - LAYOUT.margin * 2,
        minTitleY: contentBottom + 8,
        obstacles,
        unfit: meta.legend === undefined ? 'hide' : 'error',
        diagramType,
      },
      renderSwatch: (entry) => `<rect x="${entry.x}" y="${entry.baseline - 9}" width="16" height="10" rx="2.5" class="c-${config.tones[entry.kind] || 'external'}" stroke-width="1"/>`,
    });
  }

  function renderSvg() {
    const routable = relationships.filter((r) => nodes.has(r.from) && nodes.has(r.to) && r.from !== r.to);
    return `      <svg viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" ${svgRootAttrs(meta)} data-model-detail="${esc(detail)}">
${svgAccessibleText(meta, diagramType)}
${renderDefinitions()}
${renderModelDefinitions()}

        <!-- Background Grid -->
        <rect width="100%" height="100%" fill="url(#grid)" />

        <!-- Frames (behind everything) -->
${frames.map(renderFrame).join('\n')}

        <!-- Relationship paths (before boxes for correct z-order) -->
${routable.map(renderRelationshipPath).join('\n')}

        <!-- ${NODE_NOUN[diagramType]} boxes -->
${[...nodes.values()].map(renderNode).join('\n\n')}

        <!-- Relationship labels and cardinalities -->
${routable.map(renderRelationshipLabel).filter(Boolean).join('\n')}

        <!-- Frame labels -->
${frames.map(renderFrameLabel).join('\n')}

        <!-- Legend -->
${renderLegend()}${renderDiagramLogo(meta, viewBox)}
      </svg>`;
  }

  function layoutReport() {
    return {
      ok: true,
      diagram_type: diagramType,
      detail,
      fonts,
      layout: { mode: 'grid', ...placed.grid },
      viewBox,
      nodes: [...nodes.values()].map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        x: Math.round(node.x),
        y: Math.round(node.y),
        width: node.width,
        height: node.height,
        members: node.memberCount,
        ...(Number.isInteger(node.row) ? { row: node.row } : {}),
        ...(Number.isInteger(node.col) ? { col: node.col } : {}),
      })),
      frames: frames.map((frame) => ({ id: frame.id, kind: frame.kind, label: frame.label, x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height), wraps: frame.wraps })),
      relationships: relationships.filter((r) => nodes.has(r.from) && nodes.has(r.to)).map((relationship) => ({
        from: relationship.from,
        to: relationship.to,
        kind: relationship.kind || relationship.method,
        label: relationshipLabelFor(diagramType, relationship) || null,
        ...(relationship.from === relationship.to
          ? { self: true, tag: selfRelationshipTag(diagramType, relationship) }
          : { points: router.pathFor(relationship).points.map(([x, y]) => [Math.round(x), Math.round(y)]) }),
      })),
    };
  }

  validate();
  return { ok: true, detail, viewBox, svg: renderSvg(), receipt: layoutReport() };
}
