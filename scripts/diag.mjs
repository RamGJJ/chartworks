import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPages } from '../src/core/pipeline.js';
import { clusterRuns, normalize, runToToken } from '../src/core/detect.js';
import { parseChord } from '../src/core/chord.js';

const file = process.argv[2];
const pageNo = Number(process.argv[3] ?? 1);
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, verbosity: 0 }).promise;
const pages = await extractPages(doc);
const page = pages[pageNo - 1];
const tokens = clusterRuns(normalize(page.items)).map(runToToken);
const want = process.argv.slice(4);
for (const t of tokens) {
  const label = parseChord(t.text) ? 'CHORD' : '     ';
  if (want.length === 3 && want[0] === 'box') { if (t.x > Number(want[1]) + 40 || t.right < Number(want[1]) - 40 || Math.abs(t.y - Number(want[2])) > 15) continue; } else if (want.length && !want.some((w) => t.text.includes(w))) continue;
  console.log(label, JSON.stringify(t.text).padEnd(16), `x=${t.x.toFixed(1)}-${t.right.toFixed(1)} y=${t.y.toFixed(1)} size=${t.size.toFixed(1)} fonts=${t.fonts.join(',')}`);
}
