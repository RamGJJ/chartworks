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
