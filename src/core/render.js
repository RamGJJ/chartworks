import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const FONT_CHOICES = {
	'times-bold': StandardFonts.TimesRomanBold,
	'times': StandardFonts.TimesRoman,
	'helvetica-bold': StandardFonts.HelveticaBold,
	'helvetica': StandardFonts.Helvetica,
};

const PAD_X = 0.6;
const PAD_Y = 0.6;
const NON_LATIN1 = /[^ -ÿ]/;

function pickFontByWidth(fonts, edits) {
	// A hand-marked chord's width is the box someone dragged, which says nothing
	// about the type on the page.
	const samples = edits
		.filter((e) => !e.manual && e.sourceText.length <= 4 && e.right > e.x)
		.slice(0, 60);
	if (!samples.length) return 'times-bold';

	let best = 'times-bold';
	let bestError = Infinity;
	for (const [name, font] of Object.entries(fonts)) {
		let error = 0;
		for (const s of samples) {
			const observed = s.right - s.x;
			let measured;
			try {
				measured = font.widthOfTextAtSize(s.sourceText, s.size);
			} catch {
				measured = observed;
			}
			error += Math.abs(measured - observed) / Math.max(observed, 1);
		}
		error /= samples.length;
		if (error < bestError) {
			bestError = error;
			best = name;
		}
	}
	return best;
}

const NEEDS_FULL_FONT = /[^ -~]/;

// The standard fonts stop at Latin-1, so a Korean note needs a real font file.
// Loading it costs a couple of megabytes, so only reach for it when a note
// actually asks for something the built-in fonts cannot write.
async function unicodeFont(pdf, notes, loadFontBytes) {
	if (!loadFontBytes) return null;
	if (!notes.some((note) => NEEDS_FULL_FONT.test(note.text))) return null;

	const bytes = await loadFontBytes();
	if (!bytes) return null;

	const { default: fontkit } = await import('@pdf-lib/fontkit');
	pdf.registerFontkit(fontkit);

	// Subsetting drops glyphs from this font — Latin ones too — so the whole
	// file goes in. It adds a few hundred kilobytes, and only to sheets that
	// carry a note the built-in fonts cannot write.
	return pdf.embedFont(bytes, { subset: false });
}

function pickFretFont(fonts, moves) {
	const samples = moves.filter((m) => m.digits === 1).slice(0, 40);
	if (!samples.length) return 'helvetica';

	let best = 'helvetica';
	let bestError = Infinity;
	for (const [name, font] of Object.entries(fonts)) {
		let error = 0;
		for (const m of samples) {
			const measured = font.widthOfTextAtSize(String(m.from), m.size);
			error += Math.abs(measured - m.width) / Math.max(m.width, 1);
		}
		error /= samples.length;
		if (error < bestError) {
			bestError = error;
			best = name;
		}
	}
	return best;
}

// Finale lays a tab number down in three passes: the string line runs straight
// through, a white patch opens a hole in it, then the digits go in. Redoing all
// three keeps a widened number from striking the line, and closes the hole back
// up when the number gets shorter.
function drawFret(page, move, font, debug) {
	const box = page.getMediaBox();
	const unit = move.width / move.digits;
	const text = String(move.to);
	const cell = unit;
	const span = text.length * cell;

	const centre = move.x + move.width / 2 + box.x;
	const left = centre - span / 2;
	const oldLeft = move.x + box.x;
	const oldRight = oldLeft + move.width;

	const clearFrom = Math.min(left, oldLeft) - 0.3;
	const clearTo = Math.max(left + span, oldRight) + 0.3;
	const patchY = move.patchY + box.y;

	page.drawRectangle({
		x: clearFrom,
		y: patchY,
		width: clearTo - clearFrom,
		height: move.patchH,
		color: debug ? rgb(1, 0.92, 0.6) : rgb(1, 1, 1),
		borderWidth: 0,
	});

	const thickness = move.lineWidth || 0.5;
	page.drawRectangle({
		x: clearFrom,
		y: move.lineY + box.y - thickness / 2,
		width: clearTo - clearFrom,
		height: thickness,
		color: rgb(0, 0, 0),
		borderWidth: 0,
	});

	page.drawRectangle({
		x: left - 0.2,
		y: patchY,
		width: span + 0.4,
		height: move.patchH,
		color: rgb(1, 1, 1),
		borderWidth: 0,
	});

	// Digits sit on a fixed pitch in tab, so each one is centred in its own cell
	// rather than typeset as a word.
	for (let i = 0; i < text.length; i++) {
		const glyph = text[i];
		const width = font.widthOfTextAtSize(glyph, move.size);
		page.drawText(glyph, {
			x: left + cell * i + (cell - width) / 2,
			y: move.baseline + box.y,
			size: move.size,
			font,
			color: rgb(0, 0, 0),
		});
	}
}

export async function applyPlan(originalBytes, plan, options = {}) {
	const {
		fontChoice = 'auto',
		eraseColor = rgb(1, 1, 1),
		debug = false,
		loadFontBytes = null,
	} = options;

	const pdf = await PDFDocument.load(originalBytes, {
		updateMetadata: false,
		ignoreEncryption: true,
	});
	if (pdf.isEncrypted) throw new Error('ENCRYPTED');

	const pages = pdf.getPages();

	const fonts = {};
	for (const [name, standard] of Object.entries(FONT_CHOICES)) {
		fonts[name] = await pdf.embedFont(standard);
	}

	const changed = plan.edits.filter((e) => e.changed);
	const chosen = fontChoice === 'auto' ? pickFontByWidth(fonts, changed) : fontChoice;
	const font = fonts[chosen] ?? fonts['times-bold'];

	let written = 0;
	const skipped = [];

	for (const edit of changed) {
		const page = pages[edit.pageIndex];
		if (!page) continue;

		if (page.getRotation().angle % 360 !== 0) {
			skipped.push({ ...edit, reason: 'rotated-page' });
			continue;
		}

		const box = page.getMediaBox();
		const ox = box.x;
		const oy = box.y;

		const x = edit.x + ox;
		const bottom = Math.min(edit.bottom, edit.y) - edit.size * 0.25 + oy;
		const top = edit.top + oy;

		page.drawRectangle({
			x: x - PAD_X,
			y: bottom - PAD_Y,
			width: edit.right - edit.x + PAD_X * 2,
			height: top - bottom + PAD_Y * 2,
			color: debug ? rgb(1, 0.92, 0.6) : eraseColor,
			borderWidth: 0,
		});

		const text = NON_LATIN1.test(edit.newText)
			? edit.newText.replace(/♯/g, '#').replace(/♭/g, 'b')
			: edit.newText;

		page.drawText(text, {
			x,
			y: edit.y + oy,
			size: edit.size,
			font,
			color: rgb(0, 0, 0),
		});
		written++;
	}

	const fretMoves = options.fretMoves ?? [];
	if (fretMoves.length) {
		const fretFont = fonts[pickFretFont(fonts, fretMoves)];
		for (const move of fretMoves) {
			const page = pages[move.pageIndex];
			if (!page) continue;
			if (page.getRotation().angle % 360 !== 0) {
				skipped.push({ ...move, reason: 'rotated-page' });
				continue;
			}
			drawFret(page, move, fretFont, debug);
			written++;
		}
	}

	const notes = plan.notes ?? [];
	const wide = await unicodeFont(pdf, notes, loadFontBytes);

	for (const note of notes) {
		const page = pages[note.pageIndex];
		if (!page) continue;

		if (!wide && NEEDS_FULL_FONT.test(note.text)) {
			skipped.push({ ...note, reason: 'no-unicode-font' });
			continue;
		}
		if (page.getRotation().angle % 360 !== 0) {
			skipped.push({ ...note, reason: 'rotated-page' });
			continue;
		}

		const box = page.getMediaBox();
		page.drawText(note.text, {
			x: note.x + box.x,
			y: note.baseline + box.y,
			size: note.size,
			font: wide ?? font,
			color: rgb(0, 0, 0),
		});
		written++;
	}

	return {
		bytes: await pdf.save({ useObjectStreams: false }),
		written,
		notes: notes.length,
		skipped,
		font: chosen,
	};
}

export { FONT_CHOICES };
