import test from 'node:test';
import assert from 'node:assert/strict';

import { detectChordsOnPage } from '../src/core/detect.js';

// Mimics what pdf.js hands back: transform is [a, b, c, d, x, y].
function item(str, x, y, width, font, size = 8.3) {
	return { str, width, height: size, fontName: font, transform: [size, 0, 0, size, x, y] };
}

const CHORD = 'chordFont';
const MUSIC = 'musicFont';
const CLEF = 'clefFont';

function page(extra = []) {
	return [
		item('A', 227.1, 634, 5.5, CHORD),
		item('B', 343.9, 634, 5.5, CHORD),
		item('C', 455.5, 634, 6.0, CHORD),
		item('#', 462.2, 637.9, 2.9, MUSIC, 12.5),
		item('m', 465.5, 634.5, 6.3, CHORD, 7.6),
		item('G', 80.1, 456, 6.4, CHORD),
		item('#', 87.4, 459.9, 2.9, MUSIC, 12.5),
		item('m', 90.7, 456.4, 6.3, CHORD, 7.6),
		item('E', 120.0, 456, 5.9, CHORD),
		item('/', 126.0, 456, 2.3, CHORD),
		item('B', 128.3, 456, 5.5, CHORD),
		...extra,
	];
}

test('joins the accidental glyph from the music font onto the chord letter', () => {
	const { chords } = detectChordsOnPage(page());
	const texts = chords.map((c) => c.text).sort();
	assert.deepEqual(texts, ['A', 'B', 'C#m', 'E/B', 'G#m'].sort());
});

test('does not swallow a notehead that sits next to a chord', () => {
	const { chords } = detectChordsOnPage(page([item('œ', 233.8, 634, 5.3, MUSIC, 16.6)]));
	assert.ok(chords.some((c) => c.text === 'A'), 'the A should survive the neighbouring notehead');
});

test('leaves the A and B of a TAB clef alone', () => {
	const clef = [
		item('T', 51.7, 560.5, 5.3, CLEF, 8.6),
		item('A', 51.2, 553.3, 6.2, CLEF, 8.6),
		item('B', 51.4, 546.1, 6.2, CLEF, 8.6),
	];
	const { chords } = detectChordsOnPage(page(clef));
	assert.ok(!chords.some((c) => c.x < 60), 'nothing from the clef column should be read as a chord');
});

test('ignores an accidental that belongs to a note on the staff', () => {
	// A flat sitting just below the chord baseline is the staff's, not the chord's.
	const staffFlat = item('b', 234.0, 629.2, 3.5, MUSIC, 16.6);
	const { chords } = detectChordsOnPage(page([staffFlat]));
	assert.ok(chords.some((c) => c.text === 'A'), 'the chord should stay an A, not become Ab');
	assert.ok(!chords.some((c) => c.text.startsWith('Ab')));
});

test('keeps only the visible chord when one is painted over another', () => {
	const overdrawn = [...page(), item('Bb', 227.1, 634, 9.2, CHORD)];
	const { chords } = detectChordsOnPage(overdrawn);
	const atA = chords.filter((c) => Math.abs(c.x - 227.1) < 1);
	assert.equal(atA.length, 1);
	assert.equal(atA[0].text, 'Bb');
});

test('splits two chord symbols printed with no gap between them', () => {
	const pair = [
		item('A', 182.2, 200.1, 6.2, CHORD, 9.2),
		item('7sus4', 189.2, 200.6, 22.6, CHORD, 9.2),
		item('A', 211.3, 200.1, 6.2, CHORD, 9.2),
		item('7', 218.6, 200.6, 4.7, CHORD, 9.2),
	];
	const { chords } = detectChordsOnPage([...page(), ...pair]);
	const texts = chords.filter((c) => c.y === 200.1 || c.y === 200.6).map((c) => c.text);
	assert.deepEqual(texts.sort(), ['A7', 'A7sus4']);
});

test('does not shatter prose into single letters', () => {
	const prose = [
		item('G', 300, 100, 6.4, CHORD),
		item('uitar 1', 306.4, 100, 24.0, CHORD),
	];
	const { chords } = detectChordsOnPage([...page(), ...prose]);
	assert.ok(!chords.some((c) => c.y === 100), 'nothing on that line should read as a chord');
});

test('finds a bass-only marking standing on its own', () => {
	const { chords } = detectChordsOnPage([...page(), item('/E', 529.8, 213.4, 7.8, CHORD)]);
	assert.ok(chords.some((c) => c.text === '/E'));
});
