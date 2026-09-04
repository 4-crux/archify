import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDiagram, writeDiagram } from '../shared/cli.mjs';
import { compileModel } from '../model/model-compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutJsonMode = process.argv.includes('--layout-json');
const cliArgs = process.argv.filter((arg) => arg !== '--layout-json');
const { diagram, template, outPath, sourceEvidence } = loadDiagram({
  rendererDir: __dirname,
  diagramType: 'http-call',
  defaultExample: 'storefront.http-call.json',
  argv: cliArgs,
});

const compiled = compileModel({
  diagramType: 'http-call',
  diagram,
  detail: process.env.ARCHIFY_MODEL_DETAIL,
  qualityProfile: process.env.ARCHIFY_QUALITY_PROFILE || diagram.meta?.quality_profile,
});

if (layoutJsonMode) {
  console.log(JSON.stringify(compiled.receipt, null, 2));
  process.exit(0);
}
writeDiagram({
  outPath,
  template,
  diagramType: 'http-call',
  meta: diagram.meta,
  svg: compiled.svg,
  cards: diagram.cards,
  sourceEvidence,
});
