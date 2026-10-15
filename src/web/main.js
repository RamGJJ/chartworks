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
	showBoxes: true,
	showFrets: true,
	picking: false,
	texting: false,
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
			? `${low}개는 0 미만, ${high}개는 ${state.maxFret}번 프렛을 넘음`
			: low ? `${low}개가 0 미만` : `${high}개가 ${state.maxFret}번 프렛을 넘음`;
		el.className = 'keyline warn';
		el.textContent = `${head} · 옮길 수 없습니다 — ${why}`;
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
	const token = ++state.renderToken;

	if (!doc) {
		stage.innerHTML = '<p class="empty">왼쪽에서 PDF를 열어 주세요.</p>';
		$('pageLabel').textContent = '— / —';
		return;
	}

	const total = doc.doc.numPages;
	state.pageIndex = Math.min(Math.max(state.pageIndex, 0), total - 1);
	$('pageLabel').textContent = `${state.pageIndex + 1} / ${total}`;

	const page = await doc.doc.getPage(state.pageIndex + 1);
	if (token !== state.renderToken) return;

	const canvas = await paintPage(doc, page, token);
	if (!canvas || token !== state.renderToken) return;

	const wrap = document.createElement('div');
	wrap.className = `page-wrap${state.picking || state.texting ? ' picking' : ''}`;
	wrap.style.width = canvas.style.width;
	wrap.style.height = canvas.style.height;
	wrap.append(canvas);

	const cssViewport = page.getViewport({ scale: state.zoom });

	const plan = currentPlan(doc);
	const here = plan.edits.filter((edit) => edit.pageIndex === state.pageIndex);
	const tabPage = doc.tab.find((p) => p.index === state.pageIndex);
	const frets = describeShift(tabPage?.frets ?? [], state.fretShift, { maxFret: state.maxFret });

	// What the saved PDF will carry, drawn where it will sit, so the sheet on
	// screen is the sheet that comes out.
	const ghosts = [
		...(state.showBoxes ? here.filter((edit) => edit.changed) : []),
	];
	// A shift that cannot be made is not made at all, so nothing is previewed.
	const willShift = state.fretShift !== 0 && currentShift(doc).feasible;
	const movingFrets = state.showFrets && willShift ? frets : [];
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

	stage.innerHTML = '';
	stage.append(wrap);
	sizeNoteHits(wrap);
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

// With the result painted over the sheet there is no way to see what was
// printed. Holding the button lifts everything this tool drew, for as long as
// the button is down.
function attachPeek(wrap) {
	wrap.addEventListener('mousedown', (down) => {
		if (down.button !== 0) return;

		const startedAt = Date.now();
		wrap.classList.add('peeking');

		const release = () => {
			window.removeEventListener('mouseup', release);
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

		window.addEventListener('mouseup', release);
		window.addEventListener('blur', release);
	});
}

function attachPicker(wrap, doc, page, viewport) {
	wrap.addEventListener('mousedown', (down) => {
		if (down.button !== 0) return;
		down.preventDefault();

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
			window.removeEventListener('mousemove', draw);
			window.removeEventListener('mouseup', finish);
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

		window.addEventListener('mousemove', draw);
		window.addEventListener('mouseup', finish);
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
	panel.style.left = `${css.left}px`;
	panel.style.top = `${css.bottom + 6}px`;

	const input = document.createElement('input');
	input.type = 'text';
	input.placeholder = '예: Am7';
	input.value = initial;

	const ok = document.createElement('button');
	ok.type = 'button';
	ok.textContent = '넣기';

	const cancel = document.createElement('button');
	cancel.type = 'button';
	cancel.textContent = '취소';

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
		if (e.key === 'Enter') submit();
		if (e.key === 'Escape') close();
	});
	ok.addEventListener('click', submit);
	cancel.addEventListener('click', close);

	panel.append(input, ok, cancel);
	wrap.append(panel);
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
	wrap.addEventListener('mousedown', (down) => {
		if (down.button !== 0 || down.target.closest('.notes-layer')) return;
		down.preventDefault();

		const box = wrap.getBoundingClientRect();
		const css = { left: down.clientX - box.left, top: down.clientY - box.top };
		const [x, baseline] = viewport.convertToPdfPoint(css.left, css.top);

		askForText(wrap, css, '', (text, size) => {
			addNote(doc.analysis, { pageIndex: state.pageIndex, text, x, baseline, size });
			renderPage();
		});
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
	group.addEventListener('mousedown', (down) => {
		if (down.button !== 0) return;
		down.preventDefault();
		down.stopPropagation();
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
			window.removeEventListener('mousemove', drag);
			window.removeEventListener('mouseup', stop);
			if (!moved) editNote(doc, note, group);
		};

		window.addEventListener('mousemove', drag);
		window.addEventListener('mouseup', stop);
	});
}

function editNote(doc, note, anchor) {
	const wrap = anchor.closest('.page-wrap');
	const box = wrap.getBoundingClientRect();
	const spot = anchor.getBoundingClientRect();
	const css = { left: spot.left - box.left, top: spot.bottom - box.top };

	askForText(
		wrap,
		css,
		note.text,
		(text, size) => {
			updateNote(doc.analysis, note.id, { text, size });
			renderPage();
		},
		() => {
			removeNote(doc.analysis, note.id);
			renderPage();
		},
		note.size,
	);
}

function askForText(wrap, css, initial, onDone, onDelete = null, size = null) {
	wrap.querySelector('.chord-input')?.remove();

	const panel = document.createElement('div');
	panel.className = 'chord-input';
	panel.style.left = `${css.left}px`;
	panel.style.top = `${css.top + 6}px`;

	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'wide';
	input.placeholder = '예: 2번만 반복';
	input.value = initial;

	const points = document.createElement('input');
	points.type = 'number';
	points.className = 'pt';
	points.min = '4';
	points.max = '48';
	points.step = '0.5';
	points.title = '글자 크기 (pt)';
	points.value = String(Math.round((size ?? defaultNoteSize()) * 10) / 10);

	const ok = document.createElement('button');
	ok.type = 'button';
	ok.textContent = initial ? '고치기' : '넣기';

	const close = () => panel.remove();
	const submit = () => {
		const text = input.value.trim();
		if (!text) {
			input.classList.add('bad');
			return;
		}
		close();
		onDone(text, Number(points.value) || defaultNoteSize());
	};

	input.addEventListener('input', () => input.classList.remove('bad'));
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') submit();
		if (e.key === 'Escape') close();
	});
	ok.addEventListener('click', submit);

	panel.append(input, points, ok);

	if (onDelete) {
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.textContent = '지우기';
		remove.addEventListener('click', () => {
			close();
			onDelete();
		});
		panel.append(remove);
	} else {
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.textContent = '취소';
		cancel.addEventListener('click', close);
		panel.append(cancel);
	}

	wrap.append(panel);
	input.focus();
	input.select();
}

function defaultNoteSize() {
	const doc = active();
	return doc ? chordSizeFor(doc) : 9;
}

async function convert(doc) {
	const plan = currentPlan(doc);
	const shift = currentShift(doc);
	return applyPlan(doc.original.slice(), plan, {
		fontChoice: state.font,
		loadFontBytes,
		fretMoves: state.fretShift ? shift.moves : [],
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

	for (const doc of state.docs) {
		const shift = currentShift(doc);
		if (state.fretShift && !shift.feasible && shift.total) {
			setStatus(`${doc.name} — 탭을 ${state.fretShift > 0 ? '+' : ''}${state.fretShift}만큼 옮길 수 없어 건너뜀`, 'err');
			skipped++;
			continue;
		}
		if (!doc.analysis.chordCount && !doc.analysis.notes.length && !shift.moves.length) {
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
				download(result.bytes, name);
			}
			done++;
		} catch (err) {
			const why = err.message === 'ENCRYPTED' ? '암호가 걸린 PDF라 고칠 수 없습니다' : err.message;
			setStatus(`${doc.name} — 저장 실패 (${why})`, 'err');
		}
	}

	$('save').disabled = false;
	setStatus(`${done}개 저장 완료${skipped ? `, ${skipped}개는 고칠 것이 없어 건너뜀` : ''}`, 'ok');
}

function setSemitones(value) {
	state.semitones = Math.max(-11, Math.min(11, Math.round(value)));
	$('semis').textContent = state.semitones > 0 ? `+${state.semitones}` : `${state.semitones}`;
	$('slider').value = String(state.semitones);
	syncKeyLine();
	renderPage();
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
	const setMode = (mode) => {
		state.picking = mode === 'pick';
		state.texting = mode === 'text';
		$('pickRegion').setAttribute('aria-pressed', String(state.picking));
		$('addText').setAttribute('aria-pressed', String(state.texting));
		$('pickHint').hidden = !state.picking;
		$('textHint').hidden = !state.texting;
		renderPage();
	};

	const setFretShift = (value) => {
		state.fretShift = Math.max(-11, Math.min(11, Math.round(value)));
		$('frets').textContent = state.fretShift > 0 ? `+${state.fretShift}` : `${state.fretShift}`;
		$('fretSlider').value = String(state.fretShift);
		syncTabLine();
		renderPage();
	};
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

	$('pickRegion').addEventListener('click', () => setMode(state.picking ? null : 'pick'));
	$('addText').addEventListener('click', () => setMode(state.texting ? null : 'text'));

	$('zoomIn').addEventListener('click', () => {
		state.zoom = Math.min(3, state.zoom + 0.25);
		renderPage();
	});
	$('zoomOut').addEventListener('click', () => {
		state.zoom = Math.max(0.5, state.zoom - 0.25);
		renderPage();
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
	setSemitones(0);
}

wire();
