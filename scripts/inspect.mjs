import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyze, extractPages, buildPlan, targetKeyLabel } from '../src/core/pipeline.js';

const file = process.argv[2];
const semitones = Number(process.argv[3] ?? 0);
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, verbosity: 0 }).promise;
const analysis = analyze(await extractPages(doc));
const plan = buildPlan(analysis, { semitones, style: 'auto' });
console.log('key:', analysis.keyLabel, '->', targetKeyLabel(analysis, semitones, plan.style), `(${plan.style})`, 'chords:', analysis.chordCount);
for (const p of analysis.pages) {
  console.log(`-- page ${p.index + 1}: ${p.chords.length}`);
}
console.log(plan.edits.map((e) => `${e.sourceText}>${e.newText}`).join('  '));
