import { parseChord } from './chord.js';

const BASELINE_TOLERANCE = 0.85;
const GAP_TOLERANCE = 0.45;
const MIN_CHORD_FONT_HITS = 3;
const MIN_CHORD_FONT_RATIO = 0.4;
const DOMINANT_FONT_SHARE = 0.2;

function itemSize(item) {
	const t = item.transform;
	return Math.hypot(t[2], t[3]) || item.height || 1;
}

function normalize(items) {
	return items
		.map((item, order) => {
			const t = item.transform;
			const size = itemSize(item);
			return {
				str: item.str,
				x: t[4],
				y: t[5],
				width: item.width,
				size,
				order,
				font: item.fontName,
			};
		})
		.filter((it) => it.str && it.str.trim());
}

function dropTabClefs(items) {
	const letters = new Map();
	for (const it of items) {
		const s = it.str.trim();
		if (s !== 'T' && s !== 'A' && s !== 'B') continue;
		const key = `${it.font}|${Math.round(it.x / 2)}`;
		if (!letters.has(key)) letters.set(key, []);
		letters.get(key).push(it);
	}

	const banned = new Set();
	for (const column of letters.values()) {
		column.sort((a, b) => b.y - a.y);
		for (let i = 0; i + 2 < column.length; i++) {
			const [t, a, b] = column.slice(i, i + 3);
			if (t.str.trim() !== 'T' || a.str.trim() !== 'A' || b.str.trim() !== 'B') continue;
			const step = Math.max(t.size, a.size, b.size) * 1.4;
			if (t.y - a.y > step || a.y - b.y > step) continue;
			banned.add(a).add(b);
		}
	}
	return banned.size ? items.filter((it) => !banned.has(it)) : items;
}

const BUCKET_HEIGHT = 6;
const JOINABLE_FOREIGN = /^[#b♯♭°øΔ+\-()0-9]+$/;

// An accidental belonging to a chord is set at or above the root's baseline.
// One that sits below it belongs to a note on the staff, however close it is.
function canJoinForeign(run, item) {
	if (!run.chordish) return false;
	if (!JOINABLE_FOREIGN.test(item.str.trim())) return false;
	if (item.y < run.y - run.size * 0.25) return false;
	return item.size <= run.size * 2.2;
}

function clusterRuns(items) {
	const sorted = [...items].sort((a, b) => a.x - b.x || b.y - a.y);
	const open = new Map();
	const runs = [];

	const bucketOf = (y) => Math.round(y / BUCKET_HEIGHT);
	const register = (run) => {
		const key = bucketOf(run.y);
		if (!open.has(key)) open.set(key, []);
		open.get(key).push(run);
	};

	for (const item of sorted) {
		// Take the nearest run that will have it, not the first one found: a
		// chord's accidental can overlap a notehead drawn in the same music
		// font, and handing it to the notehead breaks the chord in two.
		let target = null;
		let best = Infinity;
		const home = bucketOf(item.y);
		for (let k = home - 1; k <= home + 1; k++) {
			for (const run of open.get(k) || []) {
				if (item.font !== run.font && !canJoinForeign(run, item)) continue;
				const scale = Math.max(run.size, item.size);
				const drop = Math.abs(item.y - run.y);
				if (drop > scale * BASELINE_TOLERANCE) continue;
				const gap = item.x - run.right;
				if (gap < -scale * 0.3 || gap > scale * GAP_TOLERANCE) continue;
				const score = Math.abs(gap) + drop;
				if (score < best) {
					best = score;
					target = run;
				}
			}
		}

		if (target) {
			target.members.push(item);
			target.right = Math.max(target.right, item.x + item.width);
			continue;
		}

		const run = {
			members: [item],
			y: item.y,
			size: item.size,
			font: item.font,
			chordish: /^[A-G]/.test(item.str.trim()),
			right: item.x + item.width,
		};
		runs.push(run);
		register(run);
	}

	return runs.map((run) => run.members.sort((a, b) => a.x - b.x));
}

function runToToken(members) {
	const text = members.map((m) => m.str).join('');
	const xs = members.map((m) => m.x);
	const rights = members.map((m) => m.x + m.width);
	const baseline = members[0];
	const bottom = Math.min(...members.map((m) => m.y));
	const top = Math.max(...members.map((m) => m.y + m.size));

	return {
		text,
		x: Math.min(...xs),
		right: Math.max(...rights),
		y: baseline.y,
		bottom,
		top,
		size: baseline.size,
		order: Math.min(...members.map((m) => m.order)),
		font: baseline.font,
		fonts: [...new Set(members.map((m) => m.font))],
	};
}

function chordFontsOf(tokens) {
	const stats = new Map();
	for (const token of tokens) {
		const hit = parseChord(token.text) !== null;
		for (const font of token.fonts) {
			if (!stats.has(font)) stats.set(font, { total: 0, chords: 0 });
			const s = stats.get(font);
			s.total++;
			if (hit) s.chords++;
		}
	}
	let bestHits = 0;
	for (const s of stats.values()) bestHits = Math.max(bestHits, s.chords);
	const floor = Math.max(MIN_CHORD_FONT_HITS, bestHits * DOMINANT_FONT_SHARE);

	const fonts = new Set();
	for (const [font, s] of stats) {
		if (s.chords >= floor && s.chords / s.total >= MIN_CHORD_FONT_RATIO) {
			fonts.add(font);
		}
	}
	return fonts;
}

const MAX_CHORDS_PER_RUN = 3;

// Two chord symbols printed back to back ("A7sus4A7") land in one run because
// there is no gap between them. Split at glyph boundaries, but only when every
// piece reads as a chord — otherwise a run of prose would shatter into letters.
function readAsChords(members, budget = MAX_CHORDS_PER_RUN) {
	if (!members.length) return null;

	const token = runToToken(members);
	const chord = parseChord(token.text);
	if (chord) return [{ token, chord }];
	if (budget <= 1 || members.length < 2) return null;

	for (let cut = members.length - 1; cut >= 1; cut--) {
		const head = runToToken(members.slice(0, cut));
		const headChord = parseChord(head.text);
		if (!headChord) continue;
		const tail = readAsChords(members.slice(cut), budget - 1);
		if (tail) return [{ token: head, chord: headChord }, ...tail];
	}
	return null;
}

// A sheet that this tool has already transposed still carries the original
// glyphs underneath the white patch, so the same spot yields two chord tokens.
// The later one in content order is the one actually visible.
function dropOverdrawn(found) {
	const doomed = new Set();
	for (let i = 0; i < found.length; i++) {
		for (let j = i + 1; j < found.length; j++) {
			const a = found[i];
			const b = found[j];
			if (Math.abs(a.y - b.y) > Math.max(a.size, b.size) * 0.5) continue;
			const overlap = Math.min(a.right, b.right) - Math.max(a.x, b.x);
			if (overlap <= 0) continue;
			const shorter = Math.min(a.right - a.x, b.right - b.x);
			if (overlap < shorter * 0.5) continue;
			doomed.add(a.order <= b.order ? a : b);
		}
	}
	return doomed.size ? found.filter((t) => !doomed.has(t)) : found;
}

export function detectChordsOnPage(textItems, { pageIndex = 0, chordFonts = null } = {}) {
	const runs = clusterRuns(dropTabClefs(normalize(textItems)));
	const fonts = chordFonts ?? chordFontsOf(runs.map(runToToken));
	const found = [];

	for (const members of runs) {
		const parts = readAsChords(members);
		if (!parts) continue;
		for (const { token, chord } of parts) {
			if (fonts.size && !token.fonts.some((f) => fonts.has(f))) continue;
			found.push({ ...token, pageIndex, chord });
		}
	}

	const kept = dropOverdrawn(found);
	kept.sort((a, b) => b.y - a.y || a.x - b.x);
	return { chords: kept, chordFonts: fonts };
}

export function collectChordFonts(pages) {
	const all = [];
	for (const items of pages) all.push(...clusterRuns(dropTabClefs(normalize(items))).map(runToToken));
	return chordFontsOf(all);
}

export { clusterRuns, normalize, runToToken };
