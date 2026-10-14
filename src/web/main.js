import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import {
	addManualChord,
	analyze,
	buildPlan,
	extractPages,
	removeManualChord,
	targetKeyLabel,
} from '../core/pipeline.js';
import { parseChord } from '../core/chord.js';
import { applyPlan } from '../core/render.js';
import { SHARP_NAMES, FLAT_NAMES } from '../core/chord.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const $ = (id) => document.getElementById(id);

const state = {
	docs: [],
	activeId: null,
	pageIndex: 0,
	semitones: 0,
	style: 'auto',
	glyph: 'ascii',
	font: 'auto',
	zoom: 1.25,
	showBoxes: true,
	picking: false,
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
			const analysis = analyze(await extractPages(doc));
			state.docs.push({
				id: `${file.name}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
				name: file.name,
				original,
				doc,
				analysis,
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
			renderPage();
		});

		li.append(name, meta, remove);
		li.addEventListener('click', () => {
			state.activeId = doc.id;
			state.pageIndex = 0;
			renderFileList();
			syncKeyLine();
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
	wrap.className = `page-wrap${state.picking ? ' picking' : ''}`;
	wrap.style.width = canvas.style.width;
	wrap.style.height = canvas.style.height;
	wrap.append(canvas);

	const cssViewport = page.getViewport({ scale: state.zoom });

	const plan = currentPlan(doc);
	const here = plan.edits.filter((edit) => edit.pageIndex === state.pageIndex);
	const manual = here.filter((edit) => edit.manual && edit.changed);
	if (manual.length) wrap.append(ghostLayer(manual, cssViewport, previewFont(doc)));

	if (state.showBoxes) {
		for (const edit of here) wrap.append(markFor(doc, edit, cssViewport));
	}

	if (state.picking) attachPicker(wrap, doc, page, cssViewport);

	stage.innerHTML = '';
	stage.append(wrap);
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
function ghostLayer(edits, viewport, font) {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'ghost-layer');
	const serif = font.startsWith('times');
	const family = serif ? '"Times New Roman", Times, serif' : 'Helvetica, Arial, sans-serif';

	for (const edit of edits) {
		const [left, top] = viewport.convertToViewportPoint(edit.x, edit.top);
		const [right, bottom] = viewport.convertToViewportPoint(edit.right, edit.bottom);
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

async function convert(doc) {
	const plan = currentPlan(doc);
	return applyPlan(doc.original.slice(), plan, { fontChoice: state.font });
}

function outputName(doc) {
	const base = doc.name.replace(/\.pdf$/i, '');
	const sign = state.semitones > 0 ? `+${state.semitones}` : `${state.semitones}`;
	const plan = currentPlan(doc);
	const to = targetKeyLabel(doc.analysis, state.semitones, plan.style);
	return `${base} [${to ?? sign}].pdf`;
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
		if (!doc.analysis.chordCount) {
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
	setStatus(`${done}개 저장 완료${skipped ? `, ${skipped}개는 코드가 없어 건너뜀` : ''}`, 'ok');
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

	$('prev').addEventListener('click', () => {
		state.pageIndex--;
		renderPage();
	});
	$('next').addEventListener('click', () => {
		state.pageIndex++;
		renderPage();
	});
	$('pickRegion').addEventListener('click', (e) => {
		state.picking = !state.picking;
		e.target.setAttribute('aria-pressed', String(state.picking));
		$('pickHint').hidden = !state.picking;
		renderPage();
	});

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
