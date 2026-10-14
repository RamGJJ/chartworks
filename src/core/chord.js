const NATURAL_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const ACCIDENTAL_OFFSET = {
	''  : 0,
	'#' : 1,
	'♯' : 1,
	'##': 2,
	'♯♯': 2,
	'b' : -1,
	'♭' : -1,
	'bb': -2,
	'♭♭': -2,
};

const QUALITY_TOKEN = '(?:maj|MAJ|Maj|min|Min|MIN|dim|Dim|DIM|aug|Aug|AUG|sus|add|alt|omit|no|M|m|°|ø|Δ|\\+|-|\\d|[#b♯♭]|\\(|\\)|,)';
const NOTE = '[A-G](?:##|bb|♯♯|♭♭|[#b♯♭])?';

const CHORD_RE = new RegExp(
	`^(${NOTE})(${QUALITY_TOKEN}*)(?:/(${NOTE}))?$`
);

const SHARP_KEY_PCS = new Set([0, 7, 2, 9, 4, 11, 6]);

function splitNote(note) {
	return { letter: note[0], accidental: note.slice(1) };
}

export function notePitchClass(note) {
	const { letter, accidental } = splitNote(note);
	const base = NATURAL_PC[letter];
	if (base === undefined) return null;
	const offset = ACCIDENTAL_OFFSET[accidental];
	if (offset === undefined) return null;
	return (((base + offset) % 12) + 12) % 12;
}

export function parseChord(text) {
	if (typeof text !== 'string') return null;
	const raw = text.replace(/\s+/g, '');
	if (!raw || raw.length > 16) return null;
	const m = CHORD_RE.exec(raw);
	if (!m) return null;

	const [, root, quality, bass] = m;
	if (notePitchClass(root) === null) return null;
	if (bass && notePitchClass(bass) === null) return null;

	return { root, quality: quality || '', bass: bass || null, source: text };
}

export function isMinorQuality(quality) {
	return /^(m(?!a)|min|Min|MIN)/.test(quality);
}

function nameForPitchClass(pc, style) {
	return (style === 'flat' ? FLAT_NAMES : SHARP_NAMES)[((pc % 12) + 12) % 12];
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

// Spelling a transposed note by shifting its letter the same number of steps as
// the key moved keeps Db + 2 as Eb instead of D#, which is what a player expects
// to read. Falls back to the plain sharp/flat table when that needs a double
// accidental.
function spellByLetterShift(note, pc, letterShift) {
	const index = LETTERS.indexOf(note[0]);
	if (index === -1) return null;

	const target = (((index + letterShift) % 7) + 7) % 7;
	let delta = (((pc - LETTER_PC[target]) % 12) + 12) % 12;
	if (delta > 6) delta -= 12;
	if (Math.abs(delta) > 1) return null;

	const spelled = LETTERS[target] + (delta > 0 ? '#' : delta < 0 ? 'b' : '');
	return AWKWARD_SPELLINGS.has(spelled) ? null : spelled;
}

// Theoretically right, but nobody wants to read them off a band chart.
const AWKWARD_SPELLINGS = new Set(['E#', 'B#', 'Cb', 'Fb']);

export function letterShiftFor(fromNote, toNote) {
	const from = LETTERS.indexOf(fromNote[0]);
	const to = LETTERS.indexOf(toNote[0]);
	if (from === -1 || to === -1) return null;
	return (((to - from) % 7) + 7) % 7;
}

export function transposeNote(note, semitones, style, letterShift = null) {
	const pc = notePitchClass(note);
	if (pc === null) return note;

	const next = (((pc + semitones) % 12) + 12) % 12;
	if (letterShift !== null) {
		const spelled = spellByLetterShift(note, next, letterShift);
		if (spelled) return spelled;
	}
	return nameForPitchClass(next, style);
}

export function transposeChord(chord, semitones, style = 'sharp', letterShift = null) {
	const root = transposeNote(chord.root, semitones, style, letterShift);
	const bass = chord.bass ? transposeNote(chord.bass, semitones, style, letterShift) : null;
	return { root, quality: chord.quality, bass, source: chord.source };
}

export function formatChord(chord, { accidentalGlyph = 'ascii' } = {}) {
	let text = chord.root + chord.quality + (chord.bass ? `/${chord.bass}` : '');
	if (accidentalGlyph === 'unicode') {
		text = text.replace(/([A-G])#/g, '$1♯').replace(/([A-G])b/g, '$1♭');
	}
	return text;
}

export function transposeText(text, semitones, options = {}) {
	const chord = parseChord(text);
	if (!chord) return null;
	const style = options.style === 'auto' ? 'sharp' : options.style || 'sharp';
	return formatChord(transposeChord(chord, semitones, style), options);
}

const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];
const MAJOR_QUALITIES = ['M', 'm', 'm', 'M', 'M', 'm', 'd'];
const MINOR_DEGREES = [0, 2, 3, 5, 7, 8, 10];
const MINOR_QUALITIES = ['m', 'd', 'M', 'm', 'm', 'M', 'M'];

function qualityClass(quality) {
	if (/^(dim|Dim|DIM|°|o(?![a-z]))/.test(quality)) return 'd';
	if (isMinorQuality(quality)) return 'm';
	return 'M';
}

function scoreKey(counts, tonic, minor) {
	const degrees = minor ? MINOR_DEGREES : MAJOR_DEGREES;
	const qualities = minor ? MINOR_QUALITIES : MAJOR_QUALITIES;
	let score = 0;

	for (const [key, count] of counts) {
		const [pcStr, cls] = key.split(':');
		const interval = (((Number(pcStr) - tonic) % 12) + 12) % 12;
		const degree = degrees.indexOf(interval);

		if (degree === -1) {
			// raised 7th of a minor key: V and vii° of the harmonic scale
			if (minor && interval === 11) score += count * 1.0;
			else score -= count * 1.5;
			continue;
		}

		score += count * (qualities[degree] === cls ? 2 : 0.5);
		if (degree === 0) score += count * 1.0;
		else if (degree === 4) score += count * 0.5;
	}
	return score;
}

export function detectKey(chords) {
	const counts = new Map();
	let first = null;

	for (const chord of chords) {
		const pc = notePitchClass(chord.root);
		if (pc === null) continue;
		const key = `${pc}:${qualityClass(chord.quality)}`;
		counts.set(key, (counts.get(key) || 0) + 1);
		if (!first) first = pc;
	}
	if (!counts.size) return null;

	let best = null;
	for (let tonic = 0; tonic < 12; tonic++) {
		for (const minor of [false, true]) {
			let score = scoreKey(counts, tonic, minor);
			if (first === tonic) score += 1.5;
			if (!best || score > best.score) best = { pc: tonic, minor, score };
		}
	}
	return { pc: best.pc, minor: best.minor, score: best.score };
}

export function accidentalStyleForKey(pc, minor) {
	const relativeMajor = minor ? (((pc + 3) % 12) + 12) % 12 : (((pc % 12) + 12) % 12);
	return SHARP_KEY_PCS.has(relativeMajor) ? 'sharp' : 'flat';
}

export function keyName(pc, minor, style) {
	return nameForPitchClass(pc, style ?? accidentalStyleForKey(pc, minor)) + (minor ? 'm' : '');
}

export { SHARP_NAMES, FLAT_NAMES };
