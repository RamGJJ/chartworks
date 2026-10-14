import fs from 'node:fs'; import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPages } from '../src/core/pipeline.js';
import { normalize, collectChordFonts, detectChordsOnPage } from '../src/core/detect.js';
import { clusterRuns, runToToken } from '../src/core/detect.js';
import { parseChord } from '../src/core/chord.js';

const root = process.argv[2] ?? 'D:/medit_band/악보';
const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p = path.join(d,e.name); if (e.isDirectory()) walk(p); else if (/\.pdf$/i.test(e.name)) files.push(p); } })(root);

const miss = new Map();
for (const f of files) {
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(f)), useSystemFonts: true, verbosity: 0 }).promise;
    const pages = await extractPages(doc);
    const fonts = collectChordFonts(pages.map((p) => p.items));
    if (!fonts.size) continue;
    for (const page of pages) {
      const taken = new Set(detectChordsOnPage(page.items, { chordFonts: fonts }).chords.map((c) => Math.round(c.x * 10)));
      for (const t of clusterRuns(normalize(page.items)).map(runToToken)) {
        if (taken.has(Math.round(t.x * 10))) continue;
        const s = t.text.trim();
        if (!s || parseChord(s)) continue;
        if (!t.fonts.some((x) => fonts.has(x))) continue;
        if (!miss.has(s)) miss.set(s, { n: 0, where: `${path.relative(root, f)} p${page.index + 1}` });
        miss.get(s).n++;
      }
    }
  } catch {}
}
for (const [s, v] of [...miss].sort((a,b)=>b[1].n-a[1].n).slice(0, 45)) {
  console.log(String(v.n).padStart(5), JSON.stringify(s).padEnd(22), v.where);
}
