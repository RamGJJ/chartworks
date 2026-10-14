import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { analyze, buildPlan, extractPages, targetKeyLabel } from '../core/pipeline.js';
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
	await page.render({ canvasContext: ctx, viewport }).promise;
	if (token !== state.renderToken) return;

	const wrap = document.createElement('div');
	wrap.className = 'page-wrap';
	wrap.style.width = canvas.style.width;
	wrap.style.height = canvas.style.height;
	wrap.append(canvas);

	if (state.showBoxes) {
		const plan = currentPlan(doc);
		const cssViewport = page.getViewport({ scale: state.zoom });
		for (const edit of plan.edits) {
			if (edit.pageIndex !== state.pageIndex) continue;
			wrap.append(markFor(doc, edit, cssViewport));
		}
	}

	stage.innerHTML = '';
	stage.append(wrap);
}

function markFor(doc, edit, viewport) {
	const [left, top] = viewport.convertToViewportPoint(edit.x, edit.top);
	const [right, bottom] = viewport.convertToViewportPoint(edit.right, edit.bottom);

	const el = document.createElement('div');
	el.className = `mark${edit.skipped ? ' off' : edit.changed ? '' : ' same'}`;
	el.style.left = `${Math.min(left, right) - 2}px`;
	el.style.top = `${Math.min(top, bottom) - 2}px`;
	el.style.width = `${Math.abs(right - left) + 4}px`;
	el.style.height = `${Math.abs(bottom - top) + 4}px`;

	const tip = document.createElement('span');
	tip.className = 'tip';
	tip.textContent = edit.skipped
		? `${edit.oldText} (그대로 둠 — 눌러서 되돌리기)`
		: edit.changed
			? `${edit.oldText} → ${edit.newText} (눌러서 제외)`
			: edit.oldText;
	el.append(tip);

	el.addEventListener('click', () => {
		if (doc.skip.has(edit.id)) doc.skip.delete(edit.id);
		else doc.skip.add(edit.id);
		syncKeyLine();
		renderPage();
	});
	return el;
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
