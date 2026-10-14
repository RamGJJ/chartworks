import fs from 'node:fs'; import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPages } from '../src/core/pipeline.js';
import { readTabPage, summarise, planFretShift } from '../src/core/tab.js';

const root = process.argv[2] ?? 'D:/medit_band/악보';
const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p = path.join(d,e.name); if (e.isDirectory()) walk(p); else if (/\.pdf$/i.test(e.name)) files.push(p); } })(root);

let tabFiles = 0, noTab = 0, totalFrets = 0;
const rows = [];
const odd = [];
for (const f of files) {
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(f)), useSystemFonts: true, verbosity: 0 }).promise;
    const pages = await extractPages(doc);
    const read = [];
    for (const p of pages) {
      const page = await doc.getPage(p.index + 1);
      read.push({ index: p.index, ...(await readTabPage(page, p.items, pdfjs.OPS)) });
    }
    const frets = read.flatMap((r) => r.frets);
    const staves = read.reduce((n, r) => n + r.staves.length, 0);
    if (!frets.length) { noTab++; continue; }
    tabFiles++; totalFrets += frets.length;
    const s = summarise(frets);
    rows.push({ rel: path.relative(root, f), staves, ...s });
    if (s.max > 24) odd.push(`${path.relative(root, f)} max=${s.max}`);
  } catch (e) { odd.push(`${path.relative(root, f)} ERR ${e.message}`); }
}
console.log(`tab detected in ${tabFiles} files (${noTab} without), ${totalFrets} fret numbers`);
for (const N of [-3, -2, -1, 1, 2, 3, 5]) {
  const ok = rows.filter((r) => r.min + N >= 0 && r.max + N <= 24).length;
  console.log(`  ${N > 0 ? '+' : ''}${N}: ${ok}/${rows.length} files fit frets 0-24`);
}
console.log('\nsuspicious:', odd.length);
for (const o of odd.slice(0, 10)) console.log('  ' + o);
console.log('\nsample:');
for (const r of rows.slice(0, 6)) console.log(`  ${r.rel}  staves=${r.staves} frets=${r.count} range=${r.min}-${r.max} open=${r.open}`);
