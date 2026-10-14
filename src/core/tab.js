export const DEFAULT_MAX_FRET = 24;

const MIN_STRINGS = 4;
const MAX_STRINGS = 7;
const MIN_RULE_LENGTH = 40;
const FLAT = 0.3;

function multiply(m, n) {
	return [
		m[0] * n[0] + m[1] * n[2],
		m[0] * n[1] + m[1] * n[3],
		m[2] * n[0] + m[3] * n[2],
		m[2] * n[1] + m[3] * n[3],
		m[4] * n[0] + m[5] * n[2] + n[4],
		m[4] * n[1] + m[5] * n[3] + n[5],
	];
}

// The string lines are the only thing on the page that says where a tab staff
// is and which string a number sits on, and they are graphics, not text.
export async function readPageGraphics(page, OPS) {
	const ops = await page.getOperatorList();
	const rules = [];
	const patches = [];
	const stack = [];
	let ctm = [1, 0, 0, 1, 0, 0];
	let lineWidth = 1;
	let fill = null;

	for (let i = 0; i < ops.fnArray.length; i++) {
		const fn = ops.fnArray[i];
		const args = ops.argsArray[i];

		if (fn === OPS.save) stack.push({ ctm: ctm.slice(), lineWidth, fill });
		else if (fn === OPS.restore) {
			const prev = stack.pop();
			if (prev) ({ ctm, lineWidth, fill } = prev);
		} else if (fn === OPS.transform) ctm = multiply(args, ctm);
		else if (fn === OPS.setLineWidth) lineWidth = args[0];
		else if (fn === OPS.setFillRGBColor) fill = args.join(',');
		else if (fn === OPS.setFillGray) fill = args[0] === 1 ? '255,255,255' : 'gray';
		else if (fn === OPS.constructPath) {
			const [kinds, coords] = args;
			let k = 0;
			let cursor = null;

			for (const kind of kinds) {
				if (kind === OPS.moveTo) cursor = [coords[k++], coords[k++]];
				else if (kind === OPS.lineTo) {
					const next = [coords[k++], coords[k++]];
					if (cursor && Math.abs(next[1] - cursor[1]) < FLAT) {
						const x0 = cursor[0] * ctm[0] + ctm[4];
						const x1 = next[0] * ctm[0] + ctm[4];
						if (Math.abs(x1 - x0) >= MIN_RULE_LENGTH) {
							rules.push({
								y: cursor[1] * ctm[3] + ctm[5],
								x0: Math.min(x0, x1),
								x1: Math.max(x0, x1),
								width: Math.abs(lineWidth * ctm[3]) || 0.5,
							});
						}
					}
					cursor = next;
				} else if (kind === OPS.curveTo) {
					k += 6;
					cursor = null;
				} else if (kind === OPS.rectangle) {
					const [x, y, w, h] = coords.slice(k, k + 4);
					k += 4;
					cursor = null;
					if (fill !== '255,255,255') continue;
					const width = w * ctm[0];
					const height = h * ctm[3];
					if (width > 1 && width < 40 && height > 1 && height < 15) {
						patches.push({
							x: x * ctm[0] + ctm[4],
							y: y * ctm[3] + ctm[5],
							w: width,
							h: height,
							order: patches.length,
						});
					}
				} else cursor = null;
			}
		}
	}
	return { rules, patches };
}

// Six evenly spaced rules sharing a span are a tab staff. A five line notation
// staff has the wrong count, and the spacings never line up by accident.
export function groupIntoStaves(rules) {
	const byRun = new Map();
	for (const rule of rules) {
		const key = `${Math.round(rule.x0 / 4)}:${Math.round(rule.x1 / 4)}`;
		if (!byRun.has(key)) byRun.set(key, []);
		byRun.get(key).push(rule);
	}

	// Guitar tab has six lines, bass four, and the odd sheet five or seven.
	// Notation staves have five evenly spaced lines too, so they land here as
	// well; they drop out later for carrying no fret numbers.
	const staves = [];
	for (const run of byRun.values()) {
		run.sort((a, b) => a.y - b.y);
		for (let start = 0; start < run.length; ) {
			let best = null;
			for (let count = MAX_STRINGS; count >= MIN_STRINGS; count--) {
				if (start + count > run.length) continue;
				const slice = run.slice(start, start + count);
				const gaps = slice.slice(1).map((r, i) => r.y - slice[i].y);
				const step = gaps[0];
				if (step < 2 || step > 20) continue;
				if (gaps.some((g) => Math.abs(g - step) > step * 0.25)) continue;
				best = { slice, step };
				break;
			}
			if (!best) {
				start++;
				continue;
			}
			staves.push({
				lines: best.slice.map((r) => r.y),
				step: best.step,
				x0: Math.min(...best.slice.map((r) => r.x0)),
				x1: Math.max(...best.slice.map((r) => r.x1)),
				width: best.slice[0].width,
			});
			start += best.slice.length;
		}
	}
	return staves.sort((a, b) => b.lines[0] - a.lines[0]);
}

const PLAIN_NUMBER = /^\d{1,2}$/;

function sizeOf(item) {
	const t = item.transform;
	return Math.hypot(t[2], t[3]) || item.height || 1;
}

const digitsOf = (text) => text.replace(/\D/g, '');

export function fretFontOf(items, staves) {
	const tally = new Map();
	for (const item of items) {
		const text = item.str.trim();
		if (!/\d/.test(text)) continue;
		const y = item.transform[5];
		const x = item.transform[4];
		const inside = staves.some(
			(s) => y > s.lines[0] - s.step && y < s.lines.at(-1) + s.step && x >= s.x0 - 2 && x <= s.x1 + 2,
		);
		if (!inside) continue;

		const plain = PLAIN_NUMBER.test(text) && Number(text) <= DEFAULT_MAX_FRET;
		const entry = tally.get(item.fontName) ?? { total: 0, plain: 0 };
		entry.total++;
		if (plain) entry.plain++;
		tally.set(item.fontName, entry);
	}

	let best = null;
	for (const [font, entry] of tally) {
		if (entry.plain < 6 || entry.plain / entry.total < 0.6) continue;
		if (!best || entry.plain > best.plain) best = { font, plain: entry.plain };
	}
	return best?.font ?? null;
}

function locate(staves, y) {
	for (const staff of staves) {
		if (y < staff.lines[0] - staff.step || y > staff.lines.at(-1) + staff.step) continue;
		let string = 0;
		for (let i = 1; i < staff.lines.length; i++) {
			if (Math.abs(staff.lines[i] - y) < Math.abs(staff.lines[string] - y)) string = i;
		}
		if (Math.abs(staff.lines[string] - y) > staff.step * 0.6) continue;
		return { staff, string };
	}
	return null;
}

// Finale paints a white patch behind every fret number before drawing it, one
// patch per number, exactly its width. That is a far better ruler than the text
// itself: pdf.js hands back "11 11 911" as one item when the gaps are narrow,
// and no amount of regex tells you whether that ends in 9+11 or 91+1.
export function readFrets(items, staves, patches, font) {
	if (!font || !staves.length) return [];

	const rows = new Map();
	const rowKey = (y) => Math.round(y * 2);

	for (const patch of patches) {
		const spot = locate(staves, patch.y + patch.h / 2);
		if (!spot) continue;
		const key = `${rowKey(spot.staff.lines[spot.string])}`;
		if (!rows.has(key)) rows.set(key, { spot, patches: [], chars: [] });
		rows.get(key).patches.push(patch);
	}

	items.forEach((item, order) => {
		const digits = digitsOf(item.str);
		if (!digits) return;
		const size = sizeOf(item);
		const spot = locate(staves, item.transform[5] + size * 0.36);
		if (!spot) return;
		const key = `${rowKey(spot.staff.lines[spot.string])}`;
		const row = rows.get(key);
		if (!row) return;
		row.chars.push({
			x: item.transform[4],
			width: item.width,
			digitsSource: item.str,
			baseline: item.transform[5],
			size,
			order,
			native: item.fontName === font,
		});
	});

	const unit = digitWidth([...rows.values()], patches);
	const frets = [];
	let restacked = false;

	for (const row of rows.values()) {
		row.patches = keepNewest(row.patches);
		row.patches.sort((a, b) => a.x - b.x);
		const stream = row.chars.flatMap((item) => spreadDigits(item, unit));

		for (const patch of row.patches) {
			// The patch width says how many digits belong here. Where the glyph
			// estimate disagrees, trust the patch and keep the nearest digits.
			const expected = Math.min(2, Math.max(1, Math.round(patch.w / unit)));
			// A sheet this tool already shifted still carries the old digits
			// under the patch. Those are in the sheet's own fret font; the ones
			// written over them are not, which is what tells them apart.
			const middle = patch.x + patch.w / 2;
			const candidates = stream.filter(
				(d) => d.centre >= patch.x - unit * 0.25 && d.centre <= patch.x + patch.w + unit * 0.25,
			);
			// Digits from two different fonts stacked on one patch means this
			// sheet has already been shifted once. Reading it would be a guess
			// about which layer is on top, so the caller is told to stop.
			if (candidates.some((d) => d.native) && candidates.some((d) => !d.native)) restacked = true;

			const near = [...candidates].sort(
				(a, b) => Math.abs(a.centre - middle) - Math.abs(b.centre - middle),
			);
			if (near.length < expected) continue;

			const inside = near.slice(0, expected).sort((a, b) => a.centre - b.centre);
			const value = Number(inside.map((d) => d.glyph).join(''));
			if (!Number.isFinite(value) || value > 30) continue;

			frets.push({
				value,
				digits: inside.length,
				x: patch.x,
				width: patch.w,
				patchY: patch.y,
				patchH: patch.h,
				baseline: inside[0].baseline,
				size: inside[0].size,
				lineY: row.spot.staff.lines[row.spot.string],
				lineWidth: row.spot.staff.width,
				string: row.spot.string,
				staffX0: row.spot.staff.x0,
				staffX1: row.spot.staff.x1,
			});
		}
	}
	frets.sort((a, b) => b.lineY - a.lineY || a.x - b.x);
	frets.restacked = restacked;
	return frets;
}

// Shifting a sheet leaves three patches stacked at each number: the original,
// the one this tool cleared, and the one it drew behind the new digits. Only
// the last still describes what is on the page.
function keepNewest(patches) {
	const sorted = [...patches].sort((a, b) => b.order - a.order);
	const kept = [];
	for (const patch of sorted) {
		const covered = kept.some((other) => {
			const overlap = Math.min(other.x + other.w, patch.x + patch.w) - Math.max(other.x, patch.x);
			return overlap > Math.min(other.w, patch.w) * 0.5;
		});
		if (!covered) kept.push(patch);
	}
	return kept;
}

// Everything downstream is measured in digit widths, so the ruler had better be
// right. A text item holding exactly one digit states that width outright;
// guessing it from the patches breaks on a staff that happens to be all
// double-digit frets.
function digitWidth(rows, patches) {
	const singles = [];
	for (const row of rows) {
		for (const item of row.chars) {
			if (/^\d$/.test(item.digitsSource.trim())) singles.push(item.width);
		}
	}
	if (singles.length) {
		singles.sort((a, b) => a - b);
		return singles[Math.floor(singles.length / 2)];
	}
	return patches.length ? Math.min(...patches.map((p) => p.w)) : 3.5;
}

// Digits are fixed width in a tab font; whatever else is in the item shares
// what is left over. That places each glyph closely enough to say which patch
// it belongs to.
function spreadDigits(item, unit) {
	const text = item.digitsSource;
	const count = digitsOf(text).length;
	const others = text.length - count;
	const slack = others > 0 ? Math.max(item.width - count * unit, 0) / others : 0;

	const out = [];
	let x = item.x;
	for (const ch of text) {
		if (/\d/.test(ch)) {
			out.push({
				glyph: ch,
				centre: x + unit / 2,
				baseline: item.baseline,
				size: item.size,
				native: item.native,
			});
			x += unit;
		} else x += slack;
	}
	return out;
}

export async function readTabPage(page, items, OPS) {
	const { rules, patches } = await readPageGraphics(page, OPS);
	const staves = groupIntoStaves(rules);
	const font = fretFontOf(items, staves);
	const frets = readFrets(items, staves, patches, font);
	const used = new Set(frets.map((f) => f.lineY));
	return {
		staves: staves.filter((s) => s.lines.some((y) => used.has(y))),
		font,
		frets,
		alreadyShifted: Boolean(frets.restacked),
	};
}

export function summarise(frets) {
	if (!frets.length) return null;
	const values = frets.map((f) => f.value);
	return {
		count: frets.length,
		min: Math.min(...values),
		max: Math.max(...values),
		open: values.filter((v) => v === 0).length,
	};
}

export function planFretShift(pages, semitones, { maxFret = DEFAULT_MAX_FRET } = {}) {
	const moves = [];
	const blocked = [];

	if (pages.some((page) => page.alreadyShifted)) {
		return {
			semitones,
			maxFret,
			moves: [],
			blocked: [],
			feasible: false,
			alreadyShifted: true,
			total: pages.reduce((n, p) => n + p.frets.length, 0),
		};
	}

	for (const page of pages) {
		for (const fret of page.frets) {
			const to = fret.value + semitones;
			const move = { ...fret, pageIndex: page.index, from: fret.value, to };
			if (to < 0 || to > maxFret) blocked.push(move);
			else moves.push(move);
		}
	}

	return {
		semitones,
		maxFret,
		moves: blocked.length ? [] : moves,
		blocked,
		feasible: blocked.length === 0,
		alreadyShifted: false,
		total: moves.length + blocked.length,
	};
}
