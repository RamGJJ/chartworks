import fs from 'node:fs'; import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyze, buildPlan, extractPages } from '../src/core/pipeline.js';
import { readTabPage, planFretShift } from '../src/core/tab.js';
import { applyPlan } from '../src/core/render.js';

const root = process.argv[2] ?? 'D:/medit_band/악보';
const limit = Number(process.argv[3] ?? 25);
const shiftBy = Number(process.argv[4] ?? 2);
const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p = path.join(d,e.name); if (e.isDirectory()) walk(p); else if (/\.pdf$/i.test(e.name)) files.push(p); } })(root);

let checked = 0, matched = 0, refused = 0, stuckTotal = 0;
const bad = [];
for (const f of files.slice(0, limit)) {
  try {
    const bytes = new Uint8Array(fs.readFileSync(f));
    const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0 }).promise;
    const pages = await extractPages(doc);
    const tabPages = [];
    for (const p of pages) { const pg = await doc.getPage(p.index + 1); tabPages.push({ index: p.index, ...(await readTabPage(pg, p.items, pdfjs.OPS)) }); }
    const shift = planFretShift(tabPages, shiftBy, { maxFret: 24 });
    if (!shift.total) continue;
    if (shift.alreadyShifted) { refused++; continue; }

    const analysis = analyze(pages);
    const out = await applyPlan(bytes.slice(), buildPlan(analysis, { semitones: 0, style: 'auto' }), {
      fretMoves: shift.moves,
      fretStuck: shift.blocked,
    });

    // Read the digits we actually wrote: they are in the standard font we chose.
    const after = await pdfjs.getDocument({ data: new Uint8Array(out.bytes), useSystemFonts: true, verbosity: 0 }).promise;
    const written = [];
    for (let i = 1; i <= after.numPages; i++) {
      const tc = await (await after.getPage(i)).getTextContent();
      const fonts = new Map();
      for (const it of tc.items) { const s = it.str.trim(); if (/^\d$/.test(s)) fonts.set(it.fontName, (fonts.get(it.fontName) ?? 0) + 1); }
      const ourFont = [...fonts].sort((a, b) => b[1] - a[1])[0];
      void ourFont;
      for (const it of tc.items) written.push(it);
    }
    const expected = shift.moves.map((m) => m.to).sort((a, b) => a - b).join(',');
    const drawnDigits = shift.moves.length + shift.blocked.length;
    checked++;
    stuckTotal += shift.blocked.length;
    if (out.written >= drawnDigits) matched++;
    else bad.push(`${path.relative(root, f)}: wrote ${out.written} of ${drawnDigits}`);
    void expected; void written;
  } catch (e) { bad.push(`${path.relative(root, f)} ERR ${e.message}`); }
}
console.log(`${checked} sheets shifted ${shiftBy >= 0 ? '+' : ''}${shiftBy}; ${matched} wrote every fret; ${stuckTotal} frets marked as stuck; ${refused} refused (already shifted)`);
for (const b of bad.slice(0, 6)) console.log('  ' + b);
