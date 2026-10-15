import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import {
	addManualChord,
	addNote,
	analyze,
	buildPlan,
	extractPages,
	removeManualChord,
	removeNote,
	targetKeyLabel,
	updateNote,
} from '../core/pipeline.js';
import koreanFontUrl from '../../assets/fonts/NanumGothic-Regular.ttf?url';
import { parseChord } from '../core/chord.js';
import { describeShift, planFretShift, readTabPage, summarise } from '../core/tab.js';
import { applyPlan } from '../core/render.js';
import { SHARP_NAMES, FLAT_NAMES } from '../core/chord.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const $ = (id) => document.getElementById(id);

const state = {
	docs: [],
	activeId: null,
	pageIndex: 0,
	semitones: 0,
	fretShift: 0,
	maxFret: 24,
	style: 'auto',
	glyph: 'ascii',
	font: 'auto',
	zoom: 1.25,
	fitWidth: true,
	showBoxes: true,
	linked: true,
	showFrets: true,
	picking: false,
	texting: false,
	noteSize: null,
	editing: null,
	viewport: null,
	painted: null,
	renderTask: null,
	outDir: null,
	renderToken: 0,
};

const active = () => state.docs.find((d) => d.id === state.activeId) || null;

function setStatus(message, kind = '') {
	const el = $('status');
	el.textContent = message;
	el.className = `status ${kind}`;
}

async function openFiles(fileList) {
	const files = [...fileList].filter((f) => /\.pdf$/i.test(f.name));
	if (!files.length) return;

	setStatus(`${files.length}개 악보를 분석하는 중…`);
	for (const file of files) {
		try {
			const original = new Uint8Array(await file.arrayBuffer());
			const doc = await pdfjs.getDocument({ data: original.slice(), useSystemFonts: true }).promise;
			const pages = await extractPages(doc);
			const analysis = analyze(pages);

			const tab = [];
			for (const p of pages) {
				const page = await doc.getPage(p.index + 1);
				tab.push({ index: p.index, ...(await readTabPage(page, p.items, pdfjs.OPS)) });
			}
			state.docs.push({
				id: `${file.name}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
				name: file.name,
				original,
				doc,
				analysis,
				tab,
				skip: new Set(),
			});
		} catch (err) {
			setStatus(`${file.name} — 열지 못했습니다 (${err.message})`, 'err');
		}
	}

	if (!state.activeId && state.docs.length) {
		state.activeId = state.docs[0].id;
		state.pageIndex = 0;
	}
	renderFileList();
	syncKeyLine();
	syncTabLine();
	await renderPage();
	$('save').disabled = !state.docs.length;
	setStatus(state.docs.length ? `${state.docs.length}개 악보 준비됨` : '', 'ok');
}

function renderFileList() {
	const ul = $('files');
	ul.innerHTML = '';
	for (const doc of state.docs) {
		const li = document.createElement('li');
		li.className = doc.id === state.activeId ? 'active' : '';

		const name = document.createElement('span');
		name.className = 'name';
		name.textContent = doc.name;

		const meta = document.createElement('span');
		meta.className = 'meta';
		meta.textContent = doc.analysis.chordCount ? `${doc.analysis.chordCount}개` : '코드 없음';

		const remove = document.createElement('button');
		remove.className = 'drop-one';
		remove.type = 'button';
		remove.textContent = '✕';
		remove.addEventListener('click', (e) => {
			e.stopPropagation();
			state.docs = state.docs.filter((d) => d.id !== doc.id);
			if (state.activeId === doc.id) {
				state.activeId = state.docs[0]?.id ?? null;
				state.pageIndex = 0;
			}
			$('save').disabled = !state.docs.length;
			renderFileList();
			syncKeyLine();
			syncTabLine();
			renderPage();
		});

		li.append(name, meta, remove);
		li.addEventListener('click', () => {
			state.activeId = doc.id;
			state.pageIndex = 0;
			renderFileList();
			syncKeyLine();
			syncTabLine();
			renderPage();
		});
		ul.append(li);
	}
}

function currentPlan(doc) {
	return buildPlan(doc.analysis, {
		semitones: state.semitones,
		style: state.style,
		accidentalGlyph: state.glyph,
		skip: doc.skip,
	});
}

function currentShift(doc) {
	return planFretShift(doc.tab, state.fretShift, { maxFret: state.maxFret });
}

function syncTabLine() {
	const el = $('tabline');
	const doc = active();
	el.className = 'keyline';

	if (!doc) {
		el.textContent = '탭 보표가 있으면 프렛 범위를 알려줍니다.';
		return;
	}

	const frets = doc.tab.flatMap((page) => page.frets);
	const shape = summarise(frets);
	if (!shape) {
		el.className = 'keyline none';
		el.textContent = '이 악보에는 탭 보표가 없습니다.';
		return;
	}

	const plan = currentShift(doc);
	const head = `탭 ${shape.count}개 · 프렛 ${shape.min}~${shape.max}`;

	if (plan.alreadyShifted) {
		el.className = 'keyline warn';
		el.textContent = `${head} · 이미 한 번 옮긴 악보라 다시 옮길 수 없습니다. 원본에서 다시 하세요.`;
		return;
	}
	if (!state.fretShift) {
		el.textContent = `${head} · 열린 줄 ${shape.open}개`;
		return;
	}
	if (!plan.feasible) {
		const low = plan.blocked.filter((m) => m.to < 0).length;
		const high = plan.blocked.length - low;
		const why = low && high
			? `${low}개는 0 미만, ${high}개는 ${state.maxFret}번 프렛 초과`
			: low ? `0 미만이라` : `${state.maxFret}번 프렛을 넘어`;
		el.className = 'keyline warn';
		el.innerHTML = `${head} · <b>${plan.moves.length}개 이동</b>, ${plan.blocked.length}개는 ${why} 그대로 두고 빨갛게 표시`;
		return;
	}
	el.innerHTML = `${head} <span class="arrow">→</span> <b>${shape.min + state.fretShift}~${shape.max + state.fretShift}</b> · ${plan.moves.length}개 이동`;
}

function syncKeyLine() {
	const doc = active();
	const el = $('keyline');
	if (!doc) {
		el.textContent = '악보를 열면 현재 키를 추정합니다.';
		return;
	}
	if (!doc.analysis.chordCount) {
		el.textContent = '이 악보에서는 코드 심볼을 찾지 못했습니다 (드럼 보표이거나 스캔본일 수 있습니다).';
		return;
	}

	const plan = currentPlan(doc);
	const to = targetKeyLabel(doc.analysis, state.semitones, plan.style);
	const changed = plan.edits.filter((e) => e.changed).length;
	el.innerHTML = `<b>${doc.analysis.keyLabel ?? '?'}</b><span class="arrow">→</span><b>${to ?? '?'}</b> · 코드 ${plan.edits.length}개 중 ${changed}개 수정`;
	syncTargetKey(doc, plan.style);
}

function syncTargetKey(doc, style) {
	const select = $('targetKey');
	const key = doc?.analysis.key;
	if (!key) {
		select.innerHTML = '<option>—</option>';
		select.disabled = true;
		return;
	}
	select.disabled = false;

	const names = style === 'flat' ? FLAT_NAMES : SHARP_NAMES;
	const options = [];
	for (let s = -11; s <= 11; s++) {
		const pc = (((key.pc + s) % 12) + 12) % 12;
		options.push(`<option value="${s}" ${s === state.semitones ? 'selected' : ''}>${names[pc]}${key.minor ? 'm' : ''} (${s > 0 ? '+' : ''}${s})</option>`);
	}
	select.innerHTML = options.join('');
}

// A sheet is taller than it is wide, so width is what has to fit — on a phone
// above all, where the default zoom would put two thirds of the page off screen.
function fitPageToStage(page, stage) {
	const room = stage.clientWidth - 24;
	const sheet = page.getViewport({ scale: 1 }).width;
	if (room <= 0 || !sheet) return;
	state.zoom = Math.max(0.3, Math.min(3, Math.round((room / sheet) * 100) / 100));
}

// Repainting the page costs seconds on a scanned sheet, and none of the
// overlays need it: the bitmap only changes when the page or the zoom does.
async function paintPage(doc, page, token) {
	const key = `${doc.id}:${state.pageIndex}:${state.zoom}`;
	if (state.painted?.key === key) return state.painted.canvas;

	state.renderTask?.cancel();

	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const viewport = page.getViewport({ scale: state.zoom * dpr });
	const canvas = document.createElement('canvas');
	canvas.width = viewport.width;
	canvas.height = viewport.height;
	canvas.style.width = `${viewport.width / dpr}px`;
	canvas.style.height = `${viewport.height / dpr}px`;

	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const task = page.render({ canvasContext: ctx, viewport });
	state.renderTask = task;
	try {
		await task.promise;
	} catch (err) {
		if (err?.name === 'RenderingCancelledException') return null;
		throw err;
	}
	if (token !== state.renderToken) return null;

	state.painted = { key, canvas };
	return canvas;
}

async function renderPage() {
	const stage = $('stage');
	const doc = active();

	// Redrawing rebuilds the page and everything on it, the open prompt
	// included. Whatever asked for the redraw can wait until it is answered.
	if (doc && stage.querySelector('.chord-input')) return;

	const token = ++state.renderToken;

	if (!doc) {
		const drawer = getComputedStyle($('panelToggle')).display !== 'none';
		stage.innerHTML = `<p class="empty">${drawer ? '⚙ 를 눌러' : '왼쪽에서'} PDF를 열어 주세요.</p>`;
		$('pageLabel').textContent = '— / —';
		return;
	}

	const total = doc.doc.numPages;
	state.pageIndex = Math.min(Math.max(state.pageIndex, 0), total - 1);
	$('pageLabel').textContent = `${state.pageIndex + 1} / ${total}`;

	const page = await doc.doc.getPage(state.pageIndex + 1);
	if (token !== state.renderToken) return;

	if (state.fitWidth) fitPageToStage(page, stage);

	const canvas = await paintPage(doc, page, token);
	if (!canvas || token !== state.renderToken) return;

	const wrap = document.createElement('div');
	wrap.className = `page-wrap${state.picking || state.texting ? ' picking' : ''}${state.picking ? ' boxing' : ''}`;
	wrap.style.width = canvas.style.width;
	wrap.style.height = canvas.style.height;
	wrap.append(canvas);

	const cssViewport = page.getViewport({ scale: state.zoom });
	state.viewport = cssViewport;

	const plan = currentPlan(doc);
	const here = plan.edits.filter((edit) => edit.pageIndex === state.pageIndex);
	const tabPage = doc.tab.find((p) => p.index === state.pageIndex);
	const frets = describeShift(tabPage?.frets ?? [], state.fretShift, { maxFret: state.maxFret });

	// What the saved PDF will carry, drawn where it will sit, so the sheet on
	// screen is the sheet that comes out.
	const ghosts = [
		...(state.showBoxes ? here.filter((edit) => edit.changed) : []),
	];
	const movingFrets = state.showFrets && state.fretShift ? frets.filter((f) => f.ok) : [];
	if (ghosts.length || movingFrets.length) {
		wrap.append(ghostLayer(ghosts, movingFrets, cssViewport, previewFont(doc)));
	}

	if (state.showBoxes) {
		for (const edit of here) wrap.append(markFor(doc, edit, cssViewport));
	}

	if (state.showFrets) {
		for (const fret of frets) wrap.append(fretMark(fret, cssViewport));
	}

	const notes = doc.analysis.notes.filter((note) => note.pageIndex === state.pageIndex);
	if (notes.length) wrap.append(notesLayer(doc, notes, cssViewport));

	if (state.picking) attachPicker(wrap, doc, page, cssViewport);
	else if (state.texting) attachTextPlacer(wrap, doc, cssViewport);
	else attachPeek(wrap);

	attachDeselect(wrap);

	stage.innerHTML = '';
	stage.append(wrap);
	sizeNoteHits(wrap);
	rebindSelection(wrap, cssViewport);
}

function fretMark(fret, viewport) {
	const [left, top] = viewport.convertToViewportPoint(fret.x, fret.patchY + fret.patchH);
	const [right, bottom] = viewport.convertToViewportPoint(fret.x + fret.width, fret.patchY);

	const el = document.createElement('div');
	const moving = state.fretShift !== 0;
	el.className = `fret${moving ? (fret.ok ? ' moved' : ' stuck') : ''}`;
	el.style.left = `${Math.min(left, right) - 1}px`;
	el.style.top = `${Math.min(top, bottom) - 1}px`;
	el.style.width = `${Math.abs(right - left) + 2}px`;
	el.style.height = `${Math.abs(bottom - top) + 2}px`;

	const tip = document.createElement('span');
	tip.className = 'tip';
	tip.textContent = !moving
		? `${fret.string + 1}번 줄 · ${fret.from}프렛`
		: fret.ok
			? `${fret.from} → ${fret.to}프렛`
			: `${fret.from} → ${fret.to} · 칠 수 없는 자리`;
	el.append(tip);
	return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// applyPlan matches the font to the widths of the type already on the page. A
// scan has none, so it lands on the same default the writer uses.
function previewFont(doc) {
	if (state.font !== 'auto') return state.font;
	const printed = doc.analysis.pages.some((page) => page.chords.some((hit) => !hit.manual));
	return printed ? 'helvetica' : 'times-bold';
}

// Shows a hand-marked chord the way the saved PDF will carry it: the patch over
// what was printed, and the new symbol at the size and baseline we will use.
function rect(svg, x, y, width, height, fill) {
	const el = document.createElementNS(SVG_NS, 'rect');
	el.setAttribute('x', x);
	el.setAttribute('y', y);
	el.setAttribute('width', Math.max(width, 0));
	el.setAttribute('height', Math.max(height, 0));
	el.setAttribute('fill', fill);
	svg.append(el);
	return el;
}

// Finale writes a fret as line, patch, digits. The preview repeats that so a
// number that grew does not sit across the string line, and one that shrank
// does not leave a gap in it.
function fretGhost(svg, fret, viewport, family) {
	const text = String(fret.to);
	const unit = fret.width / fret.digits;
	const span = text.length * unit;
	const centre = fret.x + fret.width / 2;
	const left = centre - span / 2;

	const clearFrom = Math.min(left, fret.x) - 0.3;
	const clearTo = Math.max(left + span, fret.x + fret.width) + 0.3;

	const [x0, top] = viewport.convertToViewportPoint(clearFrom, fret.patchY + fret.patchH);
	const [x1, bottom] = viewport.convertToViewportPoint(clearTo, fret.patchY);
	const [, lineY] = viewport.convertToViewportPoint(clearFrom, fret.lineY);
	const [textLeft] = viewport.convertToViewportPoint(left, fret.lineY);
	const [textRight] = viewport.convertToViewportPoint(left + span, fret.lineY);

	const thickness = Math.max((fret.lineWidth || 0.5) * state.zoom, 0.6);
	rect(svg, x0, Math.min(top, bottom), x1 - x0, Math.abs(bottom - top), '#fff');
	rect(svg, x0, lineY - thickness / 2, x1 - x0, thickness, '#000');
	rect(svg, textLeft, Math.min(top, bottom), textRight - textLeft, Math.abs(bottom - top), '#fff');

	const [, baseline] = viewport.convertToViewportPoint(fret.x, fret.baseline);
	const cell = (textRight - textLeft) / text.length;
	for (let i = 0; i < text.length; i++) {
		const glyph = document.createElementNS(SVG_NS, 'text');
		glyph.setAttribute('x', textLeft + cell * (i + 0.5));
		glyph.setAttribute('text-anchor', 'middle');
		glyph.setAttribute('y', baseline);
		glyph.setAttribute('font-size', fret.size * state.zoom);
		glyph.setAttribute('font-family', family);
		glyph.setAttribute('fill', '#000');
		glyph.textContent = text[i];
		svg.append(glyph);
	}
}

function ghostLayer(edits, frets, viewport, font) {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'ghost-layer');
	const serif = font.startsWith('times');
	const family = serif ? '"Times New Roman", Times, serif' : 'Helvetica, Arial, sans-serif';

	for (const fret of frets) fretGhost(svg, fret, viewport, family);

	for (const edit of edits) {
		// Same patch the writer clears, descender room included.
		const [left, top] = viewport.convertToViewportPoint(edit.x, edit.top);
		const [right, bottom] = viewport.convertToViewportPoint(
			edit.right,
			Math.min(edit.bottom, edit.y) - edit.size * 0.25,
		);
		const [textX, baseline] = viewport.convertToViewportPoint(edit.x, edit.y);

		const patch = document.createElementNS(SVG_NS, 'rect');
		patch.setAttribute('x', Math.min(left, right));
		patch.setAttribute('y', Math.min(top, bottom));
		patch.setAttribute('width', Math.abs(right - left));
		patch.setAttribute('height', Math.abs(bottom - top));
		patch.setAttribute('fill', '#fff');

		const label = document.createElementNS(SVG_NS, 'text');
		label.setAttribute('x', textX);
		label.setAttribute('y', baseline);
		label.setAttribute('font-size', edit.size * state.zoom);
		label.setAttribute('font-family', family);
		if (font.endsWith('-bold')) label.setAttribute('font-weight', '700');
		label.setAttribute('fill', '#000');
		label.textContent = edit.newText;

		svg.append(patch, label);
	}
	return svg;
}

function markFor(doc, edit, viewport) {
	const [left, top] = viewport.convertToViewportPoint(edit.x, edit.top);
	const [right, bottom] = viewport.convertToViewportPoint(edit.right, edit.bottom);

	const el = document.createElement('div');
	el.className = `mark${edit.manual ? ' manual' : edit.skipped ? ' off' : edit.changed ? '' : ' same'}`;
	el.style.left = `${Math.min(left, right) - 2}px`;
	el.style.top = `${Math.min(top, bottom) - 2}px`;
	el.style.width = `${Math.abs(right - left) + 4}px`;
	el.style.height = `${Math.abs(bottom - top) + 4}px`;

	const tip = document.createElement('span');
	tip.className = 'tip';
	tip.textContent = edit.manual
		? `직접 잡음: ${edit.oldText} → ${edit.newText} (눌러서 삭제)`
		: edit.skipped
			? `${edit.oldText} (그대로 둠 — 눌러서 되돌리기)`
			: edit.changed
				? `${edit.oldText} → ${edit.newText} (눌러서 제외)`
				: edit.oldText;
	el.append(tip);

	if (edit.manual) {
		const badge = document.createElement('span');
		badge.className = 'badge';
		badge.textContent = edit.newText;
		el.append(badge);
	}

	el.addEventListener('click', () => {
		if (edit.manual) removeManualChord(doc.analysis, edit.id);
		else if (doc.skip.has(edit.id)) doc.skip.delete(edit.id);
		else doc.skip.add(edit.id);
		syncKeyLine();
		renderPage();
	});
	return el;
}

const MIN_DRAG = 6;
const PEEK_HOLD = 180;
const TAP_SLOP = 8;

// The prompt sits inside the page, so without this every tap on its field or
// its buttons reads as a tap on the sheet behind it — which in text mode threw
// the prompt away and opened a new one, and everywhere blocked the focus the
// field needs to take typing at all.
const onPrompt = (event) => Boolean(event.target.closest?.('.chord-input'));

// With the result painted over the sheet there is no way to see what was
// printed. Holding the button lifts everything this tool drew, for as long as
// the button is down.
function attachPeek(wrap) {
	wrap.addEventListener('contextmenu', (e) => {
		if (wrap.classList.contains('peeking')) e.preventDefault();
	});

	wrap.addEventListener('pointerdown', (down) => {
		if (down.button !== 0 || onPrompt(down)) return;

		const startedAt = Date.now();
		wrap.classList.add('peeking');

		const release = () => {
			window.removeEventListener('pointerup', release);
			window.removeEventListener('pointercancel', release);
			window.removeEventListener('blur', release);
			wrap.classList.remove('peeking');

			// A hold is not a click: without this, peeking over a chord would
			// also skip it, and peeking over a note would open its editor.
			if (Date.now() - startedAt < PEEK_HOLD) return;
			const swallow = (click) => {
				click.stopPropagation();
				click.preventDefault();
			};
			wrap.addEventListener('click', swallow, { capture: true, once: true });
			setTimeout(() => wrap.removeEventListener('click', swallow, { capture: true }), 0);
		};

		window.addEventListener('pointerup', release);
		window.addEventListener('pointercancel', release);
		window.addEventListener('blur', release);
	});
}

// Capture keeps a drag alive when the finger leaves the element, but throws if
// the pointer is already gone — which must not take the drag down with it.
function capture(element, pointerId) {
	try {
		element.setPointerCapture(pointerId);
	} catch {
		/* pointer already released */
	}
}

function attachPicker(wrap, doc, page, viewport) {
	wrap.addEventListener('pointerdown', (down) => {
		if (down.button !== 0 || onPrompt(down)) return;
		down.preventDefault();
		capture(wrap, down.pointerId);

		const box = wrap.getBoundingClientRect();
		const start = { x: down.clientX - box.left, y: down.clientY - box.top };
		const band = document.createElement('div');
		band.className = 'band';
		wrap.append(band);

		const draw = (move) => {
			const now = { x: move.clientX - box.left, y: move.clientY - box.top };
			band.style.left = `${Math.min(start.x, now.x)}px`;
			band.style.top = `${Math.min(start.y, now.y)}px`;
			band.style.width = `${Math.abs(now.x - start.x)}px`;
			band.style.height = `${Math.abs(now.y - start.y)}px`;
			return now;
		};

		const finish = async (up) => {
			window.removeEventListener('pointermove', draw);
			window.removeEventListener('pointerup', finish);
			window.removeEventListener('pointercancel', finish);
			const end = draw(up);
			band.remove();

			if (Math.abs(end.x - start.x) < MIN_DRAG || Math.abs(end.y - start.y) < MIN_DRAG) return;
			await pickRegion(wrap, doc, page, viewport, {
				left: Math.min(start.x, end.x),
				right: Math.max(start.x, end.x),
				top: Math.min(start.y, end.y),
				bottom: Math.max(start.y, end.y),
			});
		};

		window.addEventListener('pointermove', draw);
		window.addEventListener('pointerup', finish);
		window.addEventListener('pointercancel', finish);
	});
}

async function pickRegion(wrap, doc, page, viewport, css) {
	const [x0, y1] = viewport.convertToPdfPoint(css.left, css.top);
	const [x1, y0] = viewport.convertToPdfPoint(css.right, css.bottom);
	const area = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };

	const found = await textInside(page, area);
	const geometry = found.length ? boundsOf(found) : boxGeometry(doc, area);

	const guess = found.map((it) => it.str).join('').trim();
	if (guess && parseChord(guess)) {
		commitManual(doc, { ...geometry, text: guess });
		setStatus(`${guess} 을(를) 직접 잡았습니다`, 'ok');
		return;
	}

	askForChord(wrap, css, guess, (text) => commitManual(doc, { ...geometry, text }));
}

// On a scan there is no text to measure, and the box the reader drew says more
// about their aim than about type size. Match whatever the sheet already uses,
// and fall back to the usual chord size for the page format.
function chordSizeFor(doc) {
	const sizes = doc.analysis.pages
		.flatMap((page) => page.chords)
		.filter((hit) => !hit.manual)
		.map((hit) => hit.size)
		.sort((a, b) => a - b);

	if (sizes.length) return sizes[Math.floor(sizes.length / 2)];
	const height = doc.analysis.pages[state.pageIndex]?.height ?? 842;
	return height / 95;
}

function boxGeometry(doc, area) {
	const size = chordSizeFor(doc);
	const slack = (area.y1 - area.y0) - size * 0.72;
	return {
		x: area.x0,
		right: Math.max(area.x1, area.x0 + size),
		baseline: area.y0 + Math.max(slack, 0) / 2,
		size,
		bottom: area.y0,
		top: area.y1,
	};
}

async function textInside(page, area) {
	const content = await page.getTextContent();
	return content.items
		.filter((it) => {
			if (!it.str || !it.str.trim()) return false;
			const t = it.transform;
			const size = Math.hypot(t[2], t[3]) || 1;
			const cx = t[4] + it.width / 2;
			const cy = t[5] + size * 0.35;
			return cx >= area.x0 && cx <= area.x1 && cy >= area.y0 && cy <= area.y1;
		})
		.sort((a, b) => a.transform[4] - b.transform[4]);
}

function boundsOf(items) {
	const sizes = items.map((it) => Math.hypot(it.transform[2], it.transform[3]) || it.height || 1);
	const anchor = items[0];
	const baseline = anchor.transform[5];
	return {
		x: Math.min(...items.map((it) => it.transform[4])),
		right: Math.max(...items.map((it) => it.transform[4] + it.width)),
		baseline,
		size: sizes[0],
		bottom: Math.min(baseline, ...items.map((it) => it.transform[5])),
		top: Math.max(...items.map((it, i) => it.transform[5] + sizes[i])),
	};
}

function commitManual(doc, { text, x, right, baseline, size, bottom, top }) {
	const added = addManualChord(doc.analysis, {
		pageIndex: state.pageIndex,
		text,
		x,
		right,
		baseline,
		size,
		bottom,
		top,
	});
	if (!added) {
		setStatus(`"${text}" 는 코드로 읽을 수 없습니다`, 'err');
		return;
	}
	syncKeyLine();
	renderPage();
}

function askForChord(wrap, css, initial, onDone) {
	wrap.querySelector('.chord-input')?.remove();

	const panel = document.createElement('div');
	panel.className = 'chord-input';

	const input = document.createElement('input');
	input.type = 'text';
	input.enterKeyHint = 'done';
	input.autocapitalize = 'off';
	input.autocomplete = 'off';
	input.placeholder = '예: Am7';
	input.value = initial;

	const close = () => panel.remove();
	const submit = () => {
		const text = input.value.trim();
		if (!parseChord(text)) {
			input.classList.add('bad');
			input.select();
			return;
		}
		close();
		onDone(text);
	};

	input.addEventListener('input', () => input.classList.remove('bad'));
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			submit();
		}
		if (e.key === 'Escape') close();
	});

	panel.append(input, iconButton('✓', '넣기', submit), iconButton('✕', '빼기', close));
	wrap.append(panel);
	placePrompt(panel, wrap, { left: css.left, top: css.bottom });
	input.focus();
	input.select();
}

let koreanFont = null;

async function loadFontBytes() {
	if (!koreanFont) {
		const res = await fetch(koreanFontUrl);
		koreanFont = new Uint8Array(await res.arrayBuffer());
	}
	return koreanFont;
}

function attachTextPlacer(wrap, doc, viewport) {
	wrap.addEventListener('pointerdown', (down) => {
		if (down.button !== 0 || onPrompt(down) || down.target.closest('.notes-layer')) return;

		const from = { x: down.clientX, y: down.clientY };
		const forget = () => {
			window.removeEventListener('pointerup', settle);
			window.removeEventListener('pointercancel', forget);
		};

		function settle(up) {
			forget();
			if (Math.hypot(up.clientX - from.x, up.clientY - from.y) > TAP_SLOP) return;

			const box = wrap.getBoundingClientRect();
			const css = { left: up.clientX - box.left, top: up.clientY - box.top };
			const [x, baseline] = viewport.convertToPdfPoint(css.left, css.top);

			askForText(
				wrap,
				css,
				'',
				async (text) => {
					const note = addNote(doc.analysis, { pageIndex: state.pageIndex, text, x, baseline, size: noteSize(doc) });
					setMode(null);
					await renderPage();
					if (note) selectNoteById(doc, note.id);
				},
				() => {},
			);
		}

		window.addEventListener('pointerup', settle);
		window.addEventListener('pointercancel', forget);
	});
}

let previewFaceLoaded = false;

// Draw notes with the very font the writer embeds, so what is on screen is what
// comes out of the PDF.
function loadPreviewFace() {
	if (previewFaceLoaded || !window.FontFace) return;
	previewFaceLoaded = true;
	const face = new FontFace('chartworksNote', `url(${koreanFontUrl})`);
	face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
}

function notesLayer(doc, notes, viewport) {
	loadPreviewFace();
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'notes-layer');

	for (const note of notes) {
		const group = document.createElementNS(SVG_NS, 'g');
		group.setAttribute('class', 'note');
		group.dataset.id = note.id;

		const hit = document.createElementNS(SVG_NS, 'rect');
		hit.setAttribute('class', 'note-hit');

		const label = document.createElementNS(SVG_NS, 'text');
		label.setAttribute('font-family', 'chartworksNote, "Malgun Gothic", sans-serif');
		label.setAttribute('fill', '#000');
		label.textContent = note.text;

		group.append(hit, label);
		place(group, note, viewport);
		attachNoteDrag(group, doc, note, viewport);
		svg.append(group);
	}
	return svg;
}

function place(group, note, viewport) {
	const [x, y] = viewport.convertToViewportPoint(note.x, note.baseline);
	const label = group.querySelector('text');
	label.setAttribute('x', x);
	label.setAttribute('y', y);
	label.setAttribute('font-size', note.size * state.zoom);
	group.dataset.x = x;
	group.dataset.y = y;
}

// getBBox only answers once the element is on the page.
function sizeNoteHits(wrap) {
	for (const group of wrap.querySelectorAll('.notes-layer .note')) {
		const label = group.querySelector('text');
		const hit = group.querySelector('.note-hit');
		try {
			const box = label.getBBox();
			hit.setAttribute('x', box.x - 3);
			hit.setAttribute('y', box.y - 2);
			hit.setAttribute('width', box.width + 6);
			hit.setAttribute('height', box.height + 4);
		} catch {
			/* not laid out yet */
		}
	}
}

function attachNoteDrag(group, doc, note, viewport) {
	let moved = false;
	group.addEventListener('pointerdown', (down) => {
		if (down.button !== 0) return;
		down.preventDefault();
		down.stopPropagation();
		capture(group, down.pointerId);
		moved = false;

		const start = { x: down.clientX, y: down.clientY };
		const origin = { x: note.x, baseline: note.baseline };

		const drag = (move) => {
			const dx = (move.clientX - start.x) / state.zoom;
			const dy = (move.clientY - start.y) / state.zoom;
			if (Math.abs(move.clientX - start.x) > 2 || Math.abs(move.clientY - start.y) > 2) moved = true;
			updateNote(doc.analysis, note.id, { x: origin.x + dx, baseline: origin.baseline - dy });
			place(group, note, viewport);
			sizeNoteHits(group.closest('.page-wrap'));
		};

		const stop = () => {
			window.removeEventListener('pointermove', drag);
			window.removeEventListener('pointerup', stop);
			window.removeEventListener('pointercancel', stop);
			if (!moved) editNote(doc, note, group, viewport);
		};

		window.addEventListener('pointermove', drag);
		window.addEventListener('pointerup', stop);
		window.addEventListener('pointercancel', stop);
	});
}

function editNote(doc, note, anchor, viewport) {
	selectNote(doc, note, anchor, viewport);
}

function noteSize(doc) {
	if (state.noteSize) return state.noteSize;
	return doc?.analysis ? chordSizeFor(doc) : 9;
}

function selectNote(doc, note, group = null, viewport = null) {
	const bar = $('textBar');
	const was = bar.getBoundingClientRect().height;

	state.editing = note ? { note, group, viewport } : null;
	bar.hidden = !state.texting && !note;
	$('noteTextRow').hidden = !note;
	$('noteDelete').hidden = !note;
	bar.querySelector('.note').hidden = !!note;
	$('noteText').value = note ? note.text : '';
	$('noteSize').value = String(Math.round((note ? note.size : noteSize(doc)) * 10) / 10);

	const stage = $('stage');
	stage.scrollTop = Math.max(0, stage.scrollTop + bar.getBoundingClientRect().height - was);

	for (const marked of document.querySelectorAll('.notes-layer .note.on')) marked.classList.remove('on');
	group?.classList.add('on');
}

function setMode(mode) {
	state.picking = mode === 'pick';
	state.texting = mode === 'text';
	$('pickRegion').setAttribute('aria-pressed', String(state.picking));
	$('addText').setAttribute('aria-pressed', String(state.texting));
	$('pickHint').hidden = !state.picking;
	selectNote(active(), null);
	renderPage();
}

function rebindSelection(wrap, viewport) {
	if (!state.editing) return;
	const group = wrap.querySelector(`.notes-layer .note[data-id="${state.editing.note.id}"]`);
	if (!group) {
		selectNote(active(), null);
		return;
	}
	state.editing.group = group;
	state.editing.viewport = viewport;
	group.classList.add('on');
}

function selectNoteById(doc, id) {
	const note = doc.analysis.notes.find((one) => one.id === id);
	const group = document.querySelector(`.notes-layer .note[data-id="${id}"]`);
	if (note && group) selectNote(doc, note, group, state.viewport);
}

function attachDeselect(wrap) {
	wrap.addEventListener('pointerdown', (down) => {
		if (!state.editing || down.target.closest('.notes-layer') || onPrompt(down)) return;
		selectNote(active(), null);
	});
}

// Redrawing the page would take the focus out of the bar, so the one note being
// edited is restyled where it stands.
function restyleNote({ note, group, viewport }) {
	if (!group || !viewport) return;
	const label = group.querySelector('text');
	if (label) label.textContent = note.text;
	place(group, note, viewport);
	sizeNoteHits(group.closest('.page-wrap'));
}

function askForText(wrap, css, initial, onDone, onRemove) {
	wrap.querySelector('.chord-input')?.remove();

	const panel = document.createElement('div');
	panel.className = 'chord-input';

	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'wide';
	input.enterKeyHint = 'done';
	input.autocomplete = 'off';
	input.placeholder = '예: 2번만 반복';
	input.value = initial;

	const close = () => panel.remove();
	const submit = () => {
		const text = input.value.trim();
		if (!text) {
			input.classList.add('bad');
			return;
		}
		close();
		onDone(text);
	};

	input.addEventListener('input', () => input.classList.remove('bad'));
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			submit();
		}
		if (e.key === 'Escape') {
			close();
			onRemove();
		}
	});

	panel.append(input, iconButton('✓', '넣기', submit), iconButton('✕', '빼기', () => {
		close();
		onRemove();
	}));
	wrap.append(panel);
	placePrompt(panel, wrap, css);
	input.focus();
	input.select();
}

function iconButton(glyph, label, onPress) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'icon';
	button.textContent = glyph;
	button.title = label;
	button.setAttribute('aria-label', label);
	button.addEventListener('click', onPress);
	return button;
}

// Dropped where the finger landed, the prompt runs off the right edge of a
// phone. Pull it back inside the page once its width is known.
function placePrompt(panel, wrap, css) {
	panel.style.left = '0px';
	panel.style.top = `${css.top + 6}px`;

	const room = wrap.getBoundingClientRect();
	const size = panel.getBoundingClientRect();
	const left = Math.max(4, Math.min(css.left, room.width - size.width - 4));
	const top = Math.min(css.top + 6, Math.max(4, room.height - size.height - 4));

	panel.style.left = `${left}px`;
	panel.style.top = `${top}px`;
}

async function convert(doc) {
	const plan = currentPlan(doc);
	const shift = currentShift(doc);
	return applyPlan(doc.original.slice(), plan, {
		fontChoice: state.font,
		loadFontBytes,
		fretMoves: state.fretShift ? shift.moves : [],
		fretStuck: state.fretShift ? shift.blocked : [],
	});
}

function outputName(doc) {
	const base = doc.name.replace(/\.pdf$/i, '');
	const sign = state.semitones > 0 ? `+${state.semitones}` : `${state.semitones}`;
	const plan = currentPlan(doc);
	const to = targetKeyLabel(doc.analysis, state.semitones, plan.style);
	const tag = state.semitones || !state.fretShift ? (to ?? sign) : null;
	const fret = state.fretShift ? `탭${state.fretShift > 0 ? '+' : ''}${state.fretShift}` : null;
	const marks = [tag, fret].filter(Boolean).join(' ');
	return marks ? `${base} [${marks}].pdf` : `${base} [메모].pdf`;
}

// An in-app browser — the one a KakaoTalk link opens in — usually refuses a
// blob download, and the file lands nowhere. The share sheet goes through, and
// on a phone it is the better route anyway: it can hand the sheet straight back
// to a chat, or save it to Files.
async function shareFiles(saved) {
	if (!navigator.canShare || !navigator.share) return false;
	const files = saved.map(({ name, bytes }) => new File([bytes], name, { type: 'application/pdf' }));
	if (!navigator.canShare({ files })) return false;

	try {
		await navigator.share({ files, title: files.length === 1 ? files[0].name : '악보' });
		return true;
	} catch (err) {
		// A cancelled sheet is a decision, not a failure.
		return err?.name === 'AbortError';
	}
}

function download(bytes, name) {
	const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function saveAll() {
	if (!state.docs.length) return;
	$('save').disabled = true;
	let done = 0;
	let skipped = 0;
	const saved = [];
	let stuck = 0;

	for (const doc of state.docs) {
		const shift = currentShift(doc);
		stuck += state.fretShift ? shift.blocked.length : 0;
		if (!doc.analysis.chordCount && !doc.analysis.notes.length && !shift.moves.length && !shift.blocked.length) {
			skipped++;
			continue;
		}
		setStatus(`변환 중… ${doc.name}`);
		try {
			const result = await convert(doc);
			const name = outputName(doc);
			if (state.outDir) {
				const handle = await state.outDir.getFileHandle(name, { create: true });
				const stream = await handle.createWritable();
				await stream.write(result.bytes);
				await stream.close();
			} else {
				saved.push({ name, bytes: result.bytes });
			}
			done++;
		} catch (err) {
			const why = err.message === 'ENCRYPTED' ? '암호가 걸린 PDF라 고칠 수 없습니다' : err.message;
			setStatus(`${doc.name} — 저장 실패 (${why})`, 'err');
		}
	}

	// Hand everything over at once: one sheet beats one per sheet of music.
	let how = '';
	if (saved.length) {
		if (!window.showDirectoryPicker && (await shareFiles(saved))) how = ' (공유)';
		else for (const one of saved) download(one.bytes, one.name);
	}

	$('save').disabled = false;
	const note = stuck ? `, 프렛 ${stuck}개는 범위를 벗어나 빨갛게 표시` : '';
	setStatus(`${done}개 저장 완료${how}${note}${skipped ? `, ${skipped}개는 고칠 것이 없어 건너뜀` : ''}`, 'ok');
}

const steps = (value) => Math.max(-11, Math.min(11, Math.round(value)));
const signed = (value) => (value > 0 ? `+${value}` : `${value}`);

// Showing a value and acting on it are kept apart so the two amounts can feed
// each other when they are linked, without either one calling back.
function showSemitones(value) {
	state.semitones = steps(value);
	$('semis').textContent = signed(state.semitones);
	$('slider').value = String(state.semitones);
}

function showFretShift(value) {
	state.fretShift = steps(value);
	$('frets').textContent = signed(state.fretShift);
	$('fretSlider').value = String(state.fretShift);
}

function refreshShift() {
	syncKeyLine();
	syncTabLine();
	renderPage();
}

function setSemitones(value) {
	showSemitones(value);
	if (state.linked) showFretShift(state.semitones);
	refreshShift();
}

function setFretShift(value) {
	showFretShift(value);
	if (state.linked) showSemitones(state.fretShift);
	refreshShift();
}

// Nothing a page can do will reliably force an external browser; these are the
// escape hatches each app happens to honour, and they change with every OS
// release. Copying the address is the one that always works.
const IN_APP = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\//i;

function offerEscape() {
	if (!IN_APP.test(navigator.userAgent)) return;
	$('inapp').hidden = false;

	$('inappOpen').addEventListener('click', () => {
		const here = location.href;
		if (/android/i.test(navigator.userAgent)) {
			const bare = here.replace(/^https?:\/\//, '');
			location.href = `intent://${bare}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(here)};end`;
			return;
		}
		location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(here)}`;
	});

	$('inappCopy').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(location.href);
			setStatus('주소를 복사했습니다. 브라우저에 붙여넣어 주세요.', 'ok');
		} catch {
			setStatus(location.href, '');
		}
	});

	$('inappHide').addEventListener('click', () => {
		$('inapp').hidden = true;
	});
}

function wire() {
	$('pick').addEventListener('click', () => $('picker').click());
	$('picker').addEventListener('change', (e) => openFiles(e.target.files));

	const drop = $('drop');
	for (const type of ['dragenter', 'dragover']) {
		drop.addEventListener(type, (e) => {
			e.preventDefault();
			drop.classList.add('over');
		});
	}
	for (const type of ['dragleave', 'drop']) {
		drop.addEventListener(type, (e) => {
			e.preventDefault();
			drop.classList.remove('over');
		});
	}
	drop.addEventListener('drop', (e) => openFiles(e.dataTransfer.files));

	$('up').addEventListener('click', () => setSemitones(state.semitones + 1));
	$('down').addEventListener('click', () => setSemitones(state.semitones - 1));
	$('slider').addEventListener('input', (e) => setSemitones(Number(e.target.value)));
	$('targetKey').addEventListener('change', (e) => setSemitones(Number(e.target.value)));

	$('style').addEventListener('change', (e) => {
		state.style = e.target.value;
		syncKeyLine();
		renderPage();
	});
	$('glyph').addEventListener('change', (e) => {
		state.glyph = e.target.value;
		renderPage();
	});
	$('font').addEventListener('change', (e) => {
		state.font = e.target.value;
	});
	$('showBoxes').addEventListener('change', (e) => {
		state.showBoxes = e.target.checked;
		renderPage();
	});
	$('showFrets').addEventListener('change', (e) => {
		state.showFrets = e.target.checked;
		renderPage();
	});

	$('prev').addEventListener('click', () => {
		state.pageIndex--;
		renderPage();
	});
	$('next').addEventListener('click', () => {
		state.pageIndex++;
		renderPage();
	});

	$('noteSize').addEventListener('change', (e) => {
		const value = Math.max(4, Math.min(48, Number(e.target.value) || 9));
		e.target.value = String(value);
		const doc = active();
		if (state.editing && doc) {
			updateNote(doc.analysis, state.editing.note.id, { size: value });
			restyleNote(state.editing);
		} else {
			state.noteSize = value;
		}
	});

	const stepNoteSize = (by) => {
		const field = $('noteSize');
		const now = Number(field.value) || 9;
		field.value = String(Math.max(4, Math.min(48, Math.round((now + by) * 2) / 2)));
		field.dispatchEvent(new Event('change'));
	};
	$('noteSmaller').addEventListener('click', () => stepNoteSize(-0.5));
	$('noteBigger').addEventListener('click', () => stepNoteSize(0.5));

	$('noteText').addEventListener('input', (e) => {
		const doc = active();
		const text = e.target.value.trim();
		if (!state.editing || !doc || !text) return;
		updateNote(doc.analysis, state.editing.note.id, { text });
		restyleNote(state.editing);
	});
	$('noteText').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') e.target.blur();
		if (e.key === 'Escape') selectNote(active(), null);
	});
	$('noteDelete').addEventListener('click', () => {
		const doc = active();
		if (!state.editing || !doc) return;
		removeNote(doc.analysis, state.editing.note.id);
		selectNote(doc, null);
		renderPage();
	});

	$('linked').addEventListener('change', (e) => {
		state.linked = e.target.checked;
		if (state.linked) setFretShift(state.semitones);
	});

	$('fretUp').addEventListener('click', () => setFretShift(state.fretShift + 1));
	$('fretDown').addEventListener('click', () => setFretShift(state.fretShift - 1));
	$('fretSlider').addEventListener('input', (e) => setFretShift(Number(e.target.value)));
	$('maxFret').addEventListener('change', (e) => {
		state.maxFret = Math.max(12, Math.min(30, Number(e.target.value) || 24));
		e.target.value = String(state.maxFret);
		syncTabLine();
		renderPage();
	});
	setFretShift(0);

	const showPanel = (open) => {
		$('panel').classList.toggle('open', open);
		$('backdrop').classList.toggle('open', open);
		$('panelToggle').setAttribute('aria-expanded', String(open));
	};
	$('panelToggle').addEventListener('click', () => showPanel(!$('panel').classList.contains('open')));
	$('backdrop').addEventListener('click', () => showPanel(false));
	$('panelClose').addEventListener('click', () => showPanel(false));

	$('pickRegion').addEventListener('click', () => setMode(state.picking ? null : 'pick'));
	$('addText').addEventListener('click', () => setMode(state.texting ? null : 'text'));

	$('zoomIn').addEventListener('click', () => {
		state.fitWidth = false;
		state.zoom = Math.min(3, state.zoom + 0.25);
		renderPage();
	});
	$('zoomOut').addEventListener('click', () => {
		state.fitWidth = false;
		state.zoom = Math.max(0.3, state.zoom - 0.25);
		renderPage();
	});

	// Only the width decides the fit, and only the width is worth redrawing for.
	// On a phone the on-screen keyboard fires resize on every focus, and
	// redrawing then would wipe out the very prompt that raised it.
	let lastWidth = window.innerWidth;
	let resizing = null;
	window.addEventListener('resize', () => {
		if (window.innerWidth === lastWidth) return;
		lastWidth = window.innerWidth;
		clearTimeout(resizing);
		resizing = setTimeout(() => state.fitWidth && renderPage(), 200);
	});

	const chooseDir = $('chooseDir');
	if (!window.showDirectoryPicker) {
		chooseDir.disabled = true;
		chooseDir.title = '이 브라우저는 폴더 저장을 지원하지 않습니다 (Chrome/Edge 권장)';
		$('outline').textContent = '저장하면 브라우저 다운로드 폴더로 내려받습니다.';
	}
	chooseDir.addEventListener('click', async () => {
		try {
			state.outDir = await window.showDirectoryPicker({ mode: 'readwrite' });
			$('outline').textContent = `저장 위치: ${state.outDir.name}`;
		} catch {
			/* 사용자가 취소 */
		}
	});

	$('save').addEventListener('click', saveAll);
	offerEscape();
	setSemitones(0);
}

wire();
