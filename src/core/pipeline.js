import { detectChordsOnPage, collectChordFonts } from './detect.js';
import {
	accidentalStyleForKey,
	detectKey,
	formatChord,
	keyName,
	letterShiftFor,
	notePitchClass,
	parseChord,
	transposeChord,
} from './chord.js';

export async function extractPages(doc) {
	const pages = [];
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const viewport = page.getViewport({ scale: 1 });
		const content = await page.getTextContent();
		pages.push({
			index: i - 1,
			width: viewport.width,
			height: viewport.height,
			viewBox: viewport.viewBox,
			rotation: viewport.rotation,
			items: content.items.filter((it) => typeof it.str === 'string'),
		});
	}
	return pages;
}

export function analyze(pages) {
	const chordFonts = collectChordFonts(pages.map((p) => p.items));
	const analyzed = pages.map((page) => {
		const { chords } = detectChordsOnPage(page.items, {
			pageIndex: page.index,
			chordFonts,
		});
		return { ...page, items: undefined, chords };
	});

	const all = analyzed.flatMap((p) => p.chords.map((c) => c.chord));
	const key = detectKey(all);

	return {
		pages: analyzed,
		notes: [],
		chordFonts,
		key,
		keyLabel: key ? keyName(key.pc, key.minor) : null,
		chordCount: all.length,
	};
}

let noteCounter = 0;

// Free text written onto the sheet: a reminder, a part name, a cue. Unlike a
// chord it is never transposed, and it does not cover what is underneath.
export function addNote(analysis, { pageIndex, text, x, baseline, size }) {
	const body = String(text ?? '').trim();
	if (!body || !analysis.pages[pageIndex]) return null;

	const note = {
		id: `note-${++noteCounter}`,
		pageIndex,
		text: body,
		x,
		baseline,
		size,
	};
	analysis.notes.push(note);
	return note;
}

export function updateNote(analysis, id, patch) {
	const note = analysis.notes.find((one) => one.id === id);
	if (!note) return null;
	if (patch.text !== undefined) {
		const body = String(patch.text).trim();
		if (!body) return null;
		note.text = body;
	}
	for (const key of ['x', 'baseline', 'size', 'pageIndex']) {
		if (patch[key] !== undefined) note[key] = patch[key];
	}
	return note;
}

export function removeNote(analysis, id) {
	const before = analysis.notes.length;
	analysis.notes = analysis.notes.filter((one) => one.id !== id);
	return analysis.notes.length !== before;
}

export function recomputeKey(analysis) {
	const all = analysis.pages.flatMap((page) => page.chords.map((hit) => hit.chord));
	const key = detectKey(all);
	analysis.key = key;
	analysis.keyLabel = key ? keyName(key.pc, key.minor) : null;
	analysis.chordCount = all.length;
	return analysis;
}

// A chord the reader marked by hand, either because the detector missed it or
// because the page is a scan with no text to read at all.
export function addManualChord(analysis, { pageIndex, text, x, right, baseline, size, bottom, top }) {
	const chord = parseChord(text);
	const page = analysis.pages[pageIndex];
	if (!chord || !page) return null;

	const hit = {
		text,
		x,
		right,
		y: baseline,
		bottom: bottom ?? baseline,
		top: top ?? baseline + size,
		size,
		fonts: [],
		pageIndex,
		chord,
		manual: true,
	};

	page.chords = page.chords.filter((other) => !overlaps(other, hit));
	page.chords.push(hit);
	page.chords.sort((a, b) => b.y - a.y || a.x - b.x);
	recomputeKey(analysis);
	return hit;
}

export function removeManualChord(analysis, id) {
	for (const page of analysis.pages) {
		const before = page.chords.length;
		page.chords = page.chords.filter((hit) => !hit.manual || chordId(hit) !== id);
		if (page.chords.length !== before) {
			recomputeKey(analysis);
			return true;
		}
	}
	return false;
}

function overlaps(a, b) {
	if (Math.abs(a.y - b.y) > Math.max(a.size, b.size)) return false;
	const shared = Math.min(a.right, b.right) - Math.max(a.x, b.x);
	return shared > Math.min(a.right - a.x, b.right - b.x) * 0.4;
}

export function chordId(hit) {
	return `${hit.pageIndex}:${Math.round(hit.x * 10)}:${Math.round(hit.y * 10)}`;
}

export function resolveStyle(analysis, semitones, requested) {
	if (requested && requested !== 'auto') return requested;
	if (!analysis.key) return 'sharp';
	const targetPc = (((analysis.key.pc + semitones) % 12) + 12) % 12;
	return accidentalStyleForKey(targetPc, analysis.key.minor);
}

export function targetKeyLabel(analysis, semitones, style) {
	if (!analysis.key) return null;
	const targetPc = (((analysis.key.pc + semitones) % 12) + 12) % 12;
	return keyName(targetPc, analysis.key.minor, style);
}

export function semitonesBetween(fromLabel, toLabel) {
	const from = notePitchClass(fromLabel.replace(/m$/, ''));
	const to = notePitchClass(toLabel.replace(/m$/, ''));
	if (from === null || to === null) return 0;
	return (((to - from) % 12) + 12) % 12;
}

export function letterShiftFromKey(analysis, semitones, style) {
	if (!analysis.key) {
		const from = keyName(0, false, style);
		const to = keyName(semitones, false, style);
		return letterShiftFor(from, to);
	}
	const from = keyName(analysis.key.pc, analysis.key.minor, accidentalStyleForKey(analysis.key.pc, analysis.key.minor));
	const to = targetKeyLabel(analysis, semitones, style);
	return to ? letterShiftFor(from, to) : null;
}

export function buildPlan(analysis, { semitones, style = 'auto', accidentalGlyph = 'ascii', skip = new Set() } = {}) {
	const resolved = resolveStyle(analysis, semitones, style);
	// A forced sharp/flat choice means the player wants one accidental throughout,
	// so only spell by letter steps when we picked the key ourselves.
	const letterShift = style === 'auto' ? letterShiftFromKey(analysis, semitones, resolved) : null;
	const edits = [];

	for (const page of analysis.pages) {
		for (const hit of page.chords) {
			const id = chordId(hit);
			const skipped = skip.has(id);
			const next = transposeChord(hit.chord, semitones, resolved, letterShift);
			const newText = formatChord(next, { accidentalGlyph });
			const oldText = formatChord(hit.chord, { accidentalGlyph: 'ascii' });
			edits.push({
				id,
				pageIndex: hit.pageIndex,
				x: hit.x,
				y: hit.y,
				right: hit.right,
				bottom: hit.bottom,
				top: hit.top,
				size: hit.size,
				sourceText: hit.text,
				manual: Boolean(hit.manual),
				oldText,
				newText,
				skipped,
				changed: !skipped && newText !== hit.text,
			});
		}
	}

	return { edits, notes: analysis.notes ?? [], style: resolved, semitones };
}
