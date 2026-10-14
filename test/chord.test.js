import test from 'node:test';
import assert from 'node:assert/strict';

import {
	accidentalStyleForKey,
	detectKey,
	formatChord,
	keyName,
	parseChord,
	transposeChord,
	transposeText,
} from '../src/core/chord.js';

test('reads plain triads', () => {
	assert.deepEqual(parseChord('C'), { root: 'C', quality: '', bass: null, source: 'C' });
	assert.equal(parseChord('Gm7').root, 'G');
	assert.equal(parseChord('Gm7').quality, 'm7');
	assert.equal(parseChord('F#m7-5').quality, 'm7-5');
	assert.equal(parseChord('Bbsus4').root, 'Bb');
	assert.equal(parseChord('Amaj7').quality, 'maj7');
	assert.equal(parseChord('C7(b9)').quality, '7(b9)');
});

test('reads slash chords', () => {
	assert.equal(parseChord('E/G#').bass, 'G#');
	assert.equal(parseChord('D/F#').root, 'D');
	assert.equal(parseChord('Am7/G').bass, 'G');
});

test('rejects things that merely start with a note letter', () => {
	for (const text of ['N.C.', '( N.C.)', 'Gt. 2', 'Dog', 'Bad', 'E-Gt', 'D.S. al Coda', 'Coda', '', 'Gliss.', 'Guitar']) {
		assert.equal(parseChord(text), null, `${text} should not parse`);
	}
});

test('transposes the examples from the brief', () => {
	assert.equal(transposeText('C', 1, { style: 'sharp' }), 'C#');
	assert.equal(transposeText('Gm7', -1, { style: 'sharp' }), 'F#m7');
	assert.equal(transposeText('Gm7', -1, { style: 'flat' }), 'Gbm7');
});

test('keeps the quality and moves the bass note too', () => {
	const chord = parseChord('E/G#');
	assert.equal(formatChord(transposeChord(chord, 1, 'flat')), 'F/A');
	assert.equal(formatChord(transposeChord(parseChord('Am7'), 3, 'sharp')), 'Cm7');
	assert.equal(formatChord(transposeChord(parseChord('C7(b9)'), 2, 'sharp')), 'D7(b9)');
});

test('wraps around the octave in both directions', () => {
	assert.equal(transposeText('B', 1, { style: 'sharp' }), 'C');
	assert.equal(transposeText('C', -1, { style: 'flat' }), 'B');
	assert.equal(transposeText('C', 12, { style: 'sharp' }), 'C');
	assert.equal(transposeText('A', -11, { style: 'sharp' }), 'A#');
});

test('writes accidentals as ♯ and ♭ when asked', () => {
	assert.equal(transposeText('C', 1, { style: 'sharp', accidentalGlyph: 'unicode' }), 'C♯');
	assert.equal(transposeText('A', 1, { style: 'flat', accidentalGlyph: 'unicode' }), 'B♭');
});

test('picks sharps or flats from the key signature', () => {
	assert.equal(accidentalStyleForKey(5, false), 'flat');   // F major, 1 flat
	assert.equal(accidentalStyleForKey(7, false), 'sharp');  // G major, 1 sharp
	assert.equal(accidentalStyleForKey(2, true), 'flat');    // D minor, 1 flat
	assert.equal(keyName(10, false), 'Bb');
	assert.equal(keyName(1, true), 'C#m');
});

test('finds the key by harmonic fit, not by counting', () => {
	const chords = ['A', 'B', 'C#m', 'G#m', 'E', 'A', 'B', 'C#m', 'A', 'E'].map(parseChord);
	const key = detectKey(chords);
	assert.ok(key.pc === 4 || (key.pc === 1 && key.minor), `expected E major or C# minor, got ${keyName(key.pc, key.minor)}`);

	const flatSong = ['F', 'Bb', 'C', 'Dm', 'F', 'Bb', 'C', 'F'].map(parseChord);
	const flatKey = detectKey(flatSong);
	assert.equal(keyName(flatKey.pc, flatKey.minor), 'F');
});
