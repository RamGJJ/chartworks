import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { analyze, buildPlan, extractPages, targetKeyLabel } from '../src/core/pipeline.js';
import { planFretShift, readTabPage, summarise } from '../src/core/tab.js';
import { applyPlan } from '../src/core/render.js';

function parseArgs(argv) {
	const args = {
		in: null,
		out: path.resolve('output'),
		semitones: 0,
		frets: 0,
		maxFret: 24,
		style: 'auto',
		font: 'auto',
		glyph: 'ascii',
		debug: false,
		dryRun: false,
		limit: Infinity,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--in' || a === '-i') args.in = next();
		else if (a === '--out' || a === '-o') args.out = path.resolve(next());
		else if (a === '--semitones' || a === '-s') args.semitones = Number(next());
		else if (a === '--frets') args.frets = Number(next());
		else if (a === '--max-fret') args.maxFret = Number(next());
		else if (a === '--style') args.style = next();
		else if (a === '--font') args.font = next();
		else if (a === '--glyph') args.glyph = next();
		else if (a === '--limit') args.limit = Number(next());
		else if (a === '--debug') args.debug = true;
		else if (a === '--dry-run') args.dryRun = true;
		else if (!args.in) args.in = a;
	}
	return args;
}

function listPdfs(target) {
	const stat = fs.statSync(target);
	if (stat.isFile()) return [target];
	const out = [];
	(function walk(dir) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.pdf$/i.test(entry.name)) out.push(full);
		}
	})(target);
	return out.sort();
}

async function run() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.in || !Number.isFinite(args.semitones)) {
		console.error('usage: npm run transpose -- --in <pdf|dir> --out <dir> --semitones <n> [--frets <n>] [--max-fret 24] [--style auto|sharp|flat] [--glyph ascii|unicode] [--font auto|times-bold|...] [--debug] [--dry-run]');
		process.exit(1);
	}

	const inputRoot = path.resolve(args.in);
	const baseDir = fs.statSync(inputRoot).isFile() ? path.dirname(inputRoot) : inputRoot;
	const outRoot = args.out;

	if (!args.dryRun && (outRoot === baseDir || outRoot.startsWith(baseDir + path.sep))) {
		console.error(`refusing to write inside the input folder:\n  in : ${baseDir}\n  out: ${outRoot}`);
		process.exit(1);
	}

	const files = listPdfs(inputRoot).slice(0, args.limit);
	console.log(`${files.length} pdf(s)  ${args.semitones >= 0 ? '+' : ''}${args.semitones} semitone(s)  ->  ${args.dryRun ? '(dry run)' : outRoot}`);

	const summary = { ok: 0, nochord: 0, failed: 0, edits: 0 };

	for (const file of files) {
		const rel = path.relative(baseDir, file);
		try {
			const data = new Uint8Array(fs.readFileSync(file));
			const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
			const pages = await extractPages(doc);
			const analysis = analyze(pages);

			let shift = { moves: [], total: 0, feasible: true, blocked: [], alreadyShifted: false };
			if (args.frets) {
				const tab = [];
				for (const p of pages) {
					const page = await doc.getPage(p.index + 1);
					tab.push({ index: p.index, ...(await readTabPage(page, p.items, pdfjs.OPS)) });
				}
				shift = planFretShift(tab, args.frets, { maxFret: args.maxFret });
				if (shift.total && !shift.feasible) {
					summary.failed++;
					const shape = summarise(tab.flatMap((t) => t.frets));
					const why = shift.alreadyShifted
						? '이미 한 번 옮긴 악보'
						: `프렛 ${shape.min}~${shape.max} 라 ${args.frets > 0 ? '+' : ''}${args.frets} 불가`;
					console.log(`  !!  ${rel}  ${why}`);
					continue;
				}
			}

			if (!analysis.chordCount && !shift.moves.length) {
				summary.nochord++;
				console.log(`  --  ${rel}  (no chord symbols found)`);
				continue;
			}

			const plan = buildPlan(analysis, {
				semitones: args.semitones,
				style: args.style,
				accidentalGlyph: args.glyph,
			});
			const target = targetKeyLabel(analysis, args.semitones, plan.style);
			const changed = plan.edits.filter((e) => e.changed).length;

			if (args.dryRun) {
				const tabNote = shift.moves.length ? `, tab ${args.frets > 0 ? '+' : ''}${args.frets} on ${shift.moves.length}` : '';
				console.log(`  ok  ${rel}  ${analysis.keyLabel ?? '?'} -> ${target ?? '?'}  (${changed}/${plan.edits.length} chords${tabNote})`);
				summary.ok++;
				summary.edits += changed;
				continue;
			}

			const result = await applyPlan(fs.readFileSync(file), plan, {
				fontChoice: args.font,
				debug: args.debug,
				fretMoves: shift.moves,
			});

			const dest = path.join(outRoot, rel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, result.bytes);

			summary.ok++;
			summary.edits += result.written;
			const tabNote = shift.moves.length ? `, ${shift.moves.length} frets` : '';
			console.log(`  ok  ${rel}  ${analysis.keyLabel ?? '?'} -> ${target ?? '?'}  (${result.written} edits${tabNote}, font=${result.font})`);
		} catch (err) {
			summary.failed++;
			const why = err.message === 'ENCRYPTED' ? '암호가 걸린 PDF라 고칠 수 없음' : err.message;
			console.log(`  !!  ${rel}  ${why}`);
		}
	}

	console.log(`\ndone: ${summary.ok} converted, ${summary.nochord} without chords, ${summary.failed} failed, ${summary.edits} chord symbols rewritten`);
}

run();
