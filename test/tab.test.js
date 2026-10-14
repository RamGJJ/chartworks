import test from 'node:test';
import assert from 'node:assert/strict';

import { groupIntoStaves, planFretShift, readFrets, summarise } from '../src/core/tab.js';

const rule = (y, x0 = 50, x1 = 500, width = 0.5) => ({ y, x0, x1, width });

// Six lines 4.6pt apart, the spacing a Finale guitar tab uses.
const guitar = [545, 549.6, 554.2, 558.8, 563.4, 568].map((y) => rule(y));
const bass = [300, 306, 312, 318].map((y) => rule(y));

function digit(str, x, baseline, width, font = 'fret') {
	return { str, width, height: 5.4, fontName: font, transform: [5.4, 0, 0, 5.4, x, baseline] };
}
const patch = (x, y, w, h = 3.5) => ({ x, y, w, h, order: 0 });

test('six evenly spaced rules are a guitar tab staff', () => {
	const staves = groupIntoStaves(guitar);
	assert.equal(staves.length, 1);
	assert.equal(staves[0].lines.length, 6);
	assert.ok(Math.abs(staves[0].step - 4.6) < 0.01);
});

test('a four line staff is bass tab', () => {
	const staves = groupIntoStaves(bass);
	assert.equal(staves.length, 1);
	assert.equal(staves[0].lines.length, 4);
});

test('reads a fret and pins it to its string', () => {
	const staves = groupIntoStaves(guitar);
	const items = [digit('7', 100, 552.1, 3.84)];
	const frets = readFrets(items, staves, [patch(100, 552.2, 3.8)], 'fret');
	assert.equal(frets.length, 1);
	assert.equal(frets[0].value, 7);
	assert.equal(frets[0].digits, 1);
	assert.ok(Math.abs(frets[0].lineY - 554.2) < 0.1);
});

test('splits a run that pdf.js handed over as one string', () => {
	const staves = groupIntoStaves(guitar);
	// "11 11 911" is really 11, 11, 9, 11 with the last gap too small to show.
	const items = [digit('11 11 911', 100, 552.1, 29.22), digit('5', 300, 552.1, 3.8)];
	const patches = [
		patch(100, 552.2, 7.6),
		patch(108.9, 552.2, 7.6),
		patch(118.2, 552.2, 3.8),
		patch(122, 552.2, 7.6),
		patch(300, 552.2, 3.8),
	];
	const frets = readFrets(items, staves, patches, 'fret');
	assert.deepEqual(frets.map((f) => f.value), [11, 11, 9, 11, 5]);
});

test('keeps only the newest patch where several are stacked', () => {
	const staves = groupIntoStaves(guitar);
	const items = [digit('9', 100, 552.1, 3.84)];
	const stacked = [
		{ ...patch(99, 552.2, 6), order: 0 },
		{ ...patch(100, 552.2, 3.8), order: 5 },
	];
	const frets = readFrets(items, staves, stacked, 'fret');
	assert.equal(frets.length, 1);
	assert.equal(frets[0].value, 9);
});

test('notices a sheet that was already shifted once', () => {
	const staves = groupIntoStaves(guitar);
	const items = [digit('7', 100, 552.1, 3.84, 'fret'), digit('9', 100, 552.1, 3.84, 'helvetica')];
	const frets = readFrets(items, staves, [patch(100, 552.2, 3.8)], 'fret');
	assert.equal(frets.restacked, true);
});

test('shifts every fret and reports the range it needs', () => {
	const pages = [{ index: 0, frets: [{ value: 0 }, { value: 5 }, { value: 12 }] }];
	const up = planFretShift(pages, 2, { maxFret: 24 });
	assert.equal(up.feasible, true);
	assert.deepEqual(up.moves.map((m) => m.to), [2, 7, 14]);

	const down = planFretShift(pages, -1, { maxFret: 24 });
	assert.equal(down.feasible, false);
	assert.equal(down.moves.length, 0);
	assert.deepEqual(down.blocked.map((m) => m.from), [0]);

	const tooHigh = planFretShift([{ index: 0, frets: [{ value: 22 }] }], 4, { maxFret: 24 });
	assert.equal(tooHigh.feasible, false);
});

test('refuses a sheet that carries two layers of digits', () => {
	const pages = [{ index: 0, alreadyShifted: true, frets: [{ value: 5 }] }];
	const plan = planFretShift(pages, 2, { maxFret: 24 });
	assert.equal(plan.feasible, false);
	assert.equal(plan.alreadyShifted, true);
});

test('summarises what is on the staff', () => {
	assert.equal(summarise([]), null);
	const s = summarise([{ value: 0 }, { value: 3 }, { value: 12 }, { value: 0 }]);
	assert.deepEqual([s.count, s.min, s.max, s.open], [4, 0, 12, 2]);
});
