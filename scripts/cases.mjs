import fs from 'node:fs'; import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyze, extractPages } from '../src/core/pipeline.js';

const root = process.argv[2] ?? 'D:/medit_band/악보';
const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p = path.join(d,e.name); if (e.isDirectory()) walk(p); else if (/\.pdf$/i.test(e.name)) files.push(p); } })(root);

const rows = [];
for (const f of files) {
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(f)), useSystemFonts: true, verbosity: 0 }).promise;
    const pages = await extractPages(doc);
    const items = pages.reduce((n, p) => n + p.items.filter((i) => i.str.trim()).length, 0);
    const a = analyze(pages);
    if (a.chordCount > 0) continue;
    rows.push({ rel: path.relative(root, f), pages: doc.numPages, items, kind: items < 20 ? 'SCAN' : 'TEXT-NO-CHORD' });
  } catch (e) { rows.push({ rel: path.relative(root, f), pages: 0, items: 0, kind: 'ERROR' }); }
}
for (const r of rows.filter((r) => r.kind === 'SCAN')) console.log('SCAN         ', String(r.pages).padStart(2) + 'p', r.rel);
console.log('---');
for (const r of rows.filter((r) => r.kind !== 'SCAN' && !/드럼|drum/i.test(r.rel))) console.log(r.kind.padEnd(14), String(r.pages).padStart(2) + 'p', `items=${r.items}`, r.rel);
