import test from 'node:test';
import assert from 'node:assert/strict';

import {
	addManualChord,
	addNote,
	buildPlan,
	chordId,
	removeManualChord,
	removeNote,
	updateNote,
} from '../src/core/pipeline.js';
import { parseChord } from '../src/core/chord.js';

function sheet(chords = []) {
	return {
		notes: [],
		pages: [{ index: 0, width: 595, height: 842, chords: chords.map(detected) }],
		chordFonts: new Set(),
		key: null,
		keyLabel: null,
		chordCount: chords.length,
	};
}

function detected([text, x, y]) {
	return {
		text, x, right: x + 12, y, bottom: y, top: y + 9, size: 9,
		fonts: ['f1'], pageIndex: 0, chord: parseChord(text),
	};
}

const spot = { pageIndex: 0, x: 200, right: 220, baseline: 600, size: 9 };

test('a hand-marked chord transposes like any other', () => {
	const analysis = sheet();
	assert.ok(addManualChord(analysis, { ...spot, text: 'Am7' }));
	assert.equal(analysis.chordCount, 1);
	assert.equal(analysis.keyLabel, 'Am');

	const plan = buildPlan(analysis, { semitones: 2, style: 'sharp' });
	assert.equal(plan.edits.length, 1);
	assert.equal(plan.edits[0].newText, 'Bm7');
	assert.equal(plan.edits[0].manual, true);
	assert.equal(plan.edits[0].changed, true);
});

test('text that is not a chord is refused', () => {
	const analysis = sheet();
	assert.equal(addManualChord(analysis, { ...spot, text: 'Guitar 1' }), null);
	assert.equal(analysis.chordCount, 0);
});

test('marking over a chord that was read wrong replaces it', () => {
	const analysis = sheet([['C', 198, 600]]);
	addManualChord(analysis, { ...spot, text: 'C#m' });
	assert.equal(analysis.chordCount, 1);
	assert.equal(analysis.pages[0].chords[0].text, 'C#m');
});

test('a chord far from the mark is left alone', () => {
	const analysis = sheet([['C', 400, 600]]);
	addManualChord(analysis, { ...spot, text: 'F' });
	assert.equal(analysis.chordCount, 2);
});

test('a hand-marked chord can be taken back', () => {
	const analysis = sheet();
	const hit = addManualChord(analysis, { ...spot, text: 'Am7' });
	assert.equal(removeManualChord(analysis, chordId(hit)), true);
	assert.equal(analysis.chordCount, 0);
	assert.equal(removeManualChord(analysis, chordId(hit)), false);
});

test('a detected chord cannot be deleted as if it were hand-marked', () => {
	const analysis = sheet([['C', 198, 600]]);
	assert.equal(removeManualChord(analysis, chordId(analysis.pages[0].chords[0])), false);
	assert.equal(analysis.pages[0].chords.length, 1);
});

test('a note is written as typed and never transposed', () => {
	const analysis = sheet([['C', 100, 600]]);
	analysis.notes = [];
	const note = addNote(analysis, { pageIndex: 0, text: '2번만 반복', x: 80, baseline: 300, size: 11 });
	assert.ok(note);

	const plan = buildPlan(analysis, { semitones: 5, style: 'sharp' });
	assert.equal(plan.notes.length, 1);
	assert.equal(plan.notes[0].text, '2번만 반복');
	assert.equal(plan.edits[0].newText, 'F');
});

test('blank text is not a note', () => {
	const analysis = sheet();
	analysis.notes = [];
	assert.equal(addNote(analysis, { pageIndex: 0, text: '   ', x: 0, baseline: 0, size: 9 }), null);
	assert.equal(addNote(analysis, { pageIndex: 7, text: 'hi', x: 0, baseline: 0, size: 9 }), null);
	assert.equal(analysis.notes.length, 0);
});

test('a note can be moved, retyped and taken back', () => {
	const analysis = sheet();
	analysis.notes = [];
	const note = addNote(analysis, { pageIndex: 0, text: 'Solo', x: 80, baseline: 300, size: 11 });

	updateNote(analysis, note.id, { x: 120, baseline: 280 });
	assert.equal(analysis.notes[0].x, 120);
	assert.equal(analysis.notes[0].baseline, 280);

	updateNote(analysis, note.id, { text: 'Gt.2 쉬어감', size: 14 });
	assert.equal(analysis.notes[0].text, 'Gt.2 쉬어감');
	assert.equal(analysis.notes[0].size, 14);

	assert.equal(updateNote(analysis, note.id, { text: '  ' }), null);
	assert.equal(analysis.notes[0].text, 'Gt.2 쉬어감', 'blank text must not wipe the note');

	assert.equal(removeNote(analysis, note.id), true);
	assert.equal(analysis.notes.length, 0);
});
