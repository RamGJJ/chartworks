import { detectChordsOnPage, collectChordFonts } from './detect.js';
import {
	accidentalStyleForKey,
	detectKey,
	formatChord,
	keyName,
	letterShiftFor,
	notePitchClass,
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
		chordFonts,
		key,
		keyLabel: key ? keyName(key.pc, key.minor) : null,
		chordCount: all.length,
	};
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
			const id = `${hit.pageIndex}:${Math.round(hit.x * 10)}:${Math.round(hit.y * 10)}`;
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
				oldText,
				newText,
				skipped,
				changed: !skipped && newText !== hit.text,
			});
		}
	}

	return { edits, style: resolved, semitones };
}
