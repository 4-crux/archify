import { esc } from './utils.mjs';

// Diagram-level logo marks. Unlike node-level brand marks, a diagram logo is
// an authored identity plate for the whole artifact. It is emitted as real
// SVG so it survives PNG, SVG, WebM, and Share Card export unchanged, and it
// resolves its colors through CSS variables so it follows the active theme.
//
// The mark is authored explicitly through `meta.logo` and never inferred from
// the visual preset, which keeps geometry byte-identical across presets.

const LOGO_INSET = 24;
const PLATE_SIZE = 22;
const PLATE_RADIUS = 6;
const WORD_GAP = 8;

const LOGOS = {
  '4crux': {
    glyph: '4C',
    glyphFont: "'M PLUS U', 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    glyphSize: 10.5,
    word: [{ text: '4', weight: 600 }, { text: 'Crux', weight: 800 }],
    wordFont: "'M PLUS U', 'Instrument Sans', 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    wordSize: 12.5,
    wordWidth: 40,
  },
};

export function diagramLogoIds() {
  return Object.keys(LOGOS);
}

// Bottom-right corner placement keeps the mark clear of the legend, which is
// anchored to the bottom-left margin in every typed renderer.
export function diagramLogoRect(meta, viewBox) {
  const logo = LOGOS[meta?.logo];
  if (!logo) return null;
  const width = PLATE_SIZE + WORD_GAP + logo.wordWidth;
  const height = PLATE_SIZE;
  return {
    x: viewBox[0] - LOGO_INSET - width,
    y: viewBox[1] - LOGO_INSET - height,
    width,
    height,
  };
}

export function renderDiagramLogo(meta, viewBox) {
  const id = meta?.logo;
  const logo = LOGOS[id];
  if (!logo) return '';
  const rect = diagramLogoRect(meta, viewBox);
  const half = PLATE_SIZE / 2;
  const wordX = PLATE_SIZE + WORD_GAP;
  const word = logo.word
    .map((part) => `<tspan font-weight="${part.weight}">${esc(part.text)}</tspan>`)
    .join('');
  return `
        <!-- Diagram logo (authored identity, export-safe) -->
        <g aria-hidden="true" class="diagram-logo" data-diagram-logo="${esc(id)}" transform="translate(${rect.x} ${rect.y})">
          <rect width="${PLATE_SIZE}" height="${PLATE_SIZE}" rx="${PLATE_RADIUS}" class="diagram-logo-plate"/>
          <text x="${half}" y="${half + 0.5}" text-anchor="middle" dominant-baseline="central" class="diagram-logo-glyph" font-family="${esc(logo.glyphFont)}" font-size="${logo.glyphSize}" font-weight="900">${esc(logo.glyph)}</text>
          <text x="${wordX}" y="${half + 0.5}" dominant-baseline="central" class="diagram-logo-word" font-family="${esc(logo.wordFont)}" font-size="${logo.wordSize}">${word}</text>
        </g>`;
}
