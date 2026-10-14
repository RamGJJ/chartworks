import fs from 'node:fs'; import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyze, buildPlan, extractPages } from '../src/core/pipeline.js';
const root = process.argv[2] ?? 'D:/medit_band/악보';
const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p = path.join(d,e.name); if (e.isDirectory()) walk(p); else if (/\.pdf$/i.test(e.name)) files.push(p); } })(root);
let total = 0, drift = 0;
for (const f of files) {
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(f)), useSystemFonts: true, verbosity: 0 }).promise;
    const a = analyze(await extractPages(doc));
    total += a.chordCount;
    const bad = buildPlan(a, { semitones: 0, style: 'auto' }).edits.filter(e => e.changed);
    if (bad.length) { drift += bad.length; console.log(path.relative(root, f), bad.map(e => `${e.sourceText}->${e.newText}`).join(' ')); }
  } catch {}
}
console.log(`\n${total} chords, ${drift} drifted at 0 semitones`);
