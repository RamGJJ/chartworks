import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPages } from '../src/core/pipeline.js';
import { fretTemplate, placeFret, planFretShift, readTabPage } from '../src/core/tab.js';
import { applyPlan } from '../src/core/render.js';

const file = process.argv[2];
const out = process.argv[3] ?? 'output/handcheck.pdf';
if (!file) {
	console.error('사용법: node scripts/handcheck.mjs <탭 악보.pdf> [나온 파일.pdf]');
	process.exit(1);
}

async function read(bytes) {
	const doc = await pdfjs.getDocument({
		data: new Uint8Array(bytes),
		useSystemFonts: true,
		verbosity: 0,
	}).promise;
	const pages = await extractPages(doc);
	const tab = [];
	for (const p of pages) {
		const page = await doc.getPage(p.index + 1);
		tab.push({ index: p.index, ...(await readTabPage(page, p.items, pdfjs.OPS)) });
	}
	return tab;
}

const original = fs.readFileSync(file);
const tab = await read(original);
const first = tab.find((p) => p.frets.length);
if (!first) {
	console.error('탭 보표를 찾지 못했습니다.');
	process.exit(1);
}

const staff = first.allStaves.find((s) => first.frets.some((f) => s.lines.includes(f.lineY)));
const over = first.frets.find((f) => s4(staff, f) && f.digits === 1);
function s4(staffOne, fret) {
	return staffOne.lines.includes(fret.lineY);
}
const template = fretTemplate(staff, first.frets);

const written = [
	{ ...placeFret({ staff, string: over.string, value: 9, centre: 0, template, over }), pageIndex: first.index },
	{
		...placeFret({ staff, string: staff.lines.length - 1, value: 13, centre: over.x + 40, template }),
		pageIndex: first.index,
	},
];

const plan = planFretShift(tab, 0, { maxFret: 24, manual: written });
const saved = await applyPlan(new Uint8Array(original), { edits: [], notes: [] }, {
	fretMoves: plan.moves,
	fretStuck: [],
});
fs.mkdirSync(out.replace(/[^/\\]+$/, '') || '.', { recursive: true });
fs.writeFileSync(out, Buffer.from(saved.bytes));

const doc = await pdfjs.getDocument({
	data: new Uint8Array(saved.bytes),
	useSystemFonts: true,
	verbosity: 0,
}).promise;
const content = await (await doc.getPage(first.index + 1)).getTextContent();

const glyphsAt = (one) =>
	content.items
		.filter((item) => {
			const x = item.transform[4];
			const y = item.transform[5];
			return x > one.x - 2 && x < one.x + one.width + 2 && Math.abs(y - one.baseline) < 1.2;
		})
		.map((item) => item.str.trim())
		.filter(Boolean)
		.join('');

console.log(`원본 ${first.frets.length}개 · 덮어쓸 자리 ${over.value}프렛 (${over.string}번 인덱스 줄)`);
console.log(`쓴 값: 덮어쓰기 9, 빈 자리 13`);
console.log(`저장본에서 읽은 글자: 덮어쓴 자리 "${glyphsAt(written[0])}", 새 자리 "${glyphsAt(written[1])}"`);
console.log(`저장: ${out}`);
