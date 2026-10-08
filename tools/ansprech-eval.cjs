/**
 * Ansprechverhalten des Stimmgeräts je Anschlag, an echten Aufnahmen (2026-10-08).
 *
 *   node tools/ansprech-eval.cjs aufnahmen/schnell-gitarre.wav [weitere.wav …]
 *        Je Datei eine Zusammenfassung:
 *          neue Saite: Note sichtbar   Zeit vom Anschlag, bis die neue Note überhaupt steht
 *                                      (auch gedimmt als Vorschau)
 *          Median / 90 % / max         Zeit, bis der gemessene Wert hell steht („tracking")
 *          nie                         Anschläge, deren Note bis zum nächsten nie hell stand
 *          Lücke                       „--" zwischen Anschlag und Anzeige
 *          falsch                      eine andere Note hell vor der richtigen
 *          Nadel wandert               |erster Wert − Wert 0,25 s später| (Einschwingen; beim
 *                                      Drehen am Wirbel ändert sich die Tonhöhe wirklich)
 *        Optionen:
 *          --liste              dazu jede Zeile je Anschlag
 *          --opt '{"…":…}'      Engine-Optionen (TunerOptions), etwa '{"previewSeconds":0}'
 *          --kanal 1            Kanal einer Mehrkanal-WAV
 *
 * Anschläge erkennt die Engine selbst (debug().onsets); als Wahrheit gilt die Note, die die
 * Breitband-Basislinie ab 80 ms nach dem Anschlag am häufigsten zeigt (sie schaltet schnell).
 * Anschläge ohne klaren Ton (Griffgeräusche) zählen nicht.
 */
"use strict";

const path = require("node:path");
const { buildDir, loadTuner, readWav } = require("./tuner-lib.cjs");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
function arg(name, fallback) {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const files = argv.filter((a, i) => a.endsWith(".wav") && !(i > 0 && argv[i - 1].startsWith("--")));
if (files.length === 0) {
	console.error("Aufruf: node tools/ansprech-eval.cjs datei.wav [--liste] [--opt '{…}'] [--kanal n]");
	process.exit(1);
}
const options = arg("--opt") ? JSON.parse(arg("--opt")) : undefined;
const channel = Number(arg("--kanal", "1"));
const { TunerEngine, BaselineTuner } = loadTuner(buildDir());

const quantile = (xs, f) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(f * xs.length))] : NaN);
const ms = (s) => (Number.isFinite(s) ? Math.round(s * 1000) : "–");

for (const file of files) {
	const { samples: x, rate } = readWav(file, channel);
	const engine = new TunerEngine(rate, options);
	const baseline = new BaselineTuner(rate);
	const hop = Math.round(rate * 0.01);
	const timeline = [];
	const onsets = [];
	let seenOnsets = 0;
	for (let i = 0; i + hop <= x.length; i += hop) {
		const block = x.subarray(i, i + hop);
		engine.push(block);
		baseline.push(block);
		const t = (i + hop) / rate;
		const r = engine.reading();
		const d = engine.debug();
		const b = baseline.reading();
		if (d.onsets > seenOnsets) {
			onsets.push(t);
			seenOnsets = d.onsets;
		}
		timeline.push({ t, cents: r.cents, state: r.state, note: r.state === "silent" ? "--" : r.noteName + r.octave, truth: b.state === "tracking" ? b.noteName + b.octave : "" });
	}

	const rows = [];
	for (let k = 0; k < onsets.length; k++) {
		const t0 = onsets[k];
		const t1 = Math.min(k + 1 < onsets.length ? onsets[k + 1] : Infinity, t0 + 2);
		const win = timeline.filter((s) => s.t >= t0 && s.t < t1);
		const count = {};
		for (const s of win) if (s.t >= t0 + 0.08 && s.truth) count[s.truth] = (count[s.truth] || 0) + 1;
		const truth = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0];
		if (!truth || count[truth] < 5) continue;
		const hit = win.find((s) => s.state === "tracking" && s.note === truth);
		const seen = win.find((s) => s.state !== "silent" && s.note === truth);
		const before = hit ? win.filter((s) => s.t < hit.t) : win;
		let jump = null;
		if (hit) {
			const tEnd = Math.min(hit.t + 0.25, t1 - 0.02);
			const later = win.filter((s) => s.t <= tEnd && s.state === "tracking" && s.note === truth);
			if (later.length && tEnd - hit.t >= 0.1) jump = Math.abs(later[later.length - 1].cents - hit.cents);
		}
		rows.push({
			t0,
			truth,
			change: rows.length === 0 || rows[rows.length - 1].truth !== truth,
			lat: hit ? hit.t - t0 : null,
			seen: seen ? seen.t - t0 : null,
			gap: before.some((s) => s.state === "silent"),
			wrong: [...new Set(before.filter((s) => s.state === "tracking" && s.note !== truth).map((s) => s.note))],
			jump,
			next: t1 - t0,
		});
	}

	const name = path.basename(file);
	if (flag("--liste")) {
		console.log(`\n${name}: je Anschlag (Zeit, Note, neue Saite oder gleiche, Note sichtbar, Wert hell)`);
		for (const r of rows) {
			const extra = `${r.gap ? "  Lücke" : ""}${r.wrong.length ? "  falsch " + r.wrong.join(",") : ""}`;
			console.log(`  ${r.t0.toFixed(2).padStart(7)} s  ${r.truth.padEnd(4)} ${r.change ? "neu" : "gl."}  sichtbar ${String(ms(r.seen)).padStart(4)} ms  hell ${r.lat === null ? " nie" : String(ms(r.lat)).padStart(4) + " ms"}${extra}  (nächster nach ${r.next.toFixed(2)} s)`);
		}
	}
	const lats = rows.filter((r) => r.lat !== null).map((r) => r.lat).sort((a, b) => a - b);
	const seenNew = rows.filter((r) => r.change && r.seen !== null).map((r) => r.seen).sort((a, b) => a - b);
	const jumps = rows.filter((r) => r.jump !== null).map((r) => r.jump).sort((a, b) => a - b);
	console.log(`${name}: ${rows.length} Anschläge`);
	console.log(`  neue Saite: Note sichtbar Median ${ms(quantile(seenNew, 0.5))} ms, 90 % ${ms(quantile(seenNew, 0.9))} ms`);
	console.log(`  Wert hell: Median ${ms(quantile(lats, 0.5))} ms, 90 % ${ms(quantile(lats, 0.9))} ms, max ${ms(lats[lats.length - 1])} ms; nie ${rows.filter((r) => r.lat === null).length}`);
	console.log(`  Lücke „--" ${rows.filter((r) => r.gap).length}, falsche Note ${rows.filter((r) => r.wrong.length).length}, Nadel wandert Median ${quantile(jumps, 0.5).toFixed(1)}, 90 % ${quantile(jumps, 0.9).toFixed(1)} Cent`);
}
