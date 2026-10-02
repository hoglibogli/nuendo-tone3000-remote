/**
 * Tonhöhenerkennung (src/tuner) an synthetischen Saiten: Notennamen, Stille, Genauigkeit,
 * Zeit bis zur Anzeige, Haltezeit gegen die Breitband-Basislinie, Oktavfehler beim
 * Bass, Notenwechsel, Sprungantwort, Abdämpfen, Blockgrößen, Rechenzeit.
 *
 * Kein Audiogerät: Die Signale erzeugt tuner-synth.cjs (fester Startwert). Die volle
 * Messreihe mit Tabelle liefert tools/tuner-eval.cjs --synth.
 */
"use strict";

const path = require("node:path");
const { section, check, ok } = require("./harness.cjs");
const S = require("./tuner-synth.cjs");

const build = path.join(__dirname, "..", "test-output", "build", "tuner");
const N = require(path.join(build, "notes.js"));
const { TunerEngine, IN_TUNE_CENTS, harmonicRelation } = require(path.join(build, "engine.js"));
const { BaselineTuner } = require(path.join(build, "baseline.js"));

const string = (name) => [...S.STRINGS, ...S.LOW_STRINGS].find((s) => s.name === name);
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

/** Eine Saite erzeugen und durch Engine (und auf Wunsch Basislinie) schicken. */
function measure(name, cents, rate, peakDb, noiseDb, withBaseline = false, extra = {}) {
	const st = string(name);
	const sig = S.pluck({ sampleRate: rate, midi: st.midi, cents, durationSec: extra.durationSec ?? 1 + 2 * st.t60 + 1, t60: st.t60, fundamentalDb: st.fundamentalDb, B: st.B, peakDb, noiseDb, seed: 3, ...extra });
	const truth = { onset: sig.onset, midi: st.midi, cents };
	const tl = S.runTuner(new TunerEngine(rate, extra.options), sig.signal, rate, { everySeconds: 0.01 });
	const e = S.score(tl, truth);
	e.endDb = S.levelBelowStart(sig.clean, rate, sig.onset, sig.onset + e.trackEnd);
	let b = null;
	if (withBaseline) {
		b = S.score(S.runTuner(new BaselineTuner(rate), sig.signal, rate, { everySeconds: 0.01 }), truth);
		b.endDb = S.levelBelowStart(sig.clean, rate, sig.onset, sig.onset + b.trackEnd);
	}
	return { e, b, tl, sig };
}

function describe(label, e, b) {
	const base = b ? ` | Basislinie: ab ${Math.round(b.first * 1000)} ms, verfolgt ${f2(b.trackEnd)} s (${f2(b.endDb)} dB)` : "";
	console.log(
		`      ${label}: ab ${Math.round(e.first * 1000)} ms, verfolgt ${f2(e.trackEnd)} s (${f2(e.endDb)} dB unter Start), Fehler Ø ${f2(e.meanErrSettled)} max ${f2(e.maxErr)} Cent, Streuung ${f2(e.jitter)}, falsch ${e.wrong}${base}`,
	);
}

module.exports = function run() {
	section("Tuner: Noten");
	check("E2 ist MIDI 40", Math.round(N.midiOf(82.4069)), 40);
	check("A4 = 440 Hz", N.frequencyOf(69), 440);
	check("Namen mit Kreuz, B englisch", [N.noteName(40), N.noteName(42), N.noteName(59), N.noteName(70)], ["E", "F#", "B", "A#"]);
	check("Option H statt B", [N.noteName(59, true), N.noteName(70, true)], ["H", "A#"]);
	check("Oktaven E2 E4 B0 C4", [N.octaveOf(40), N.octaveOf(64), N.octaveOf(23), N.octaveOf(60)], [2, 4, 0, 4]);
	ok("Kammerton 442: A4 = 69,0", Math.abs(N.midiOf(442, 442) - 69) < 1e-12);
	ok("Cent: 1 Halbton = 100", Math.abs(N.centsBetween(N.frequencyOf(41), N.frequencyOf(40)) - 100) < 1e-9);
	check("gestimmt heißt |Cent| <= 2", IN_TUNE_CENTS, 2);
	check("Obertonbeziehungen", [harmonicRelation(40, 52), harmonicRelation(40, 59), harmonicRelation(40, 41)], [true, true, false]);

	section("Tuner: Stille und Rauschen");
	for (const [label, db] of [
		["digitale Stille", null],
		["Rauschen -94 dBFS", -94],
		["Rauschen -106 dBFS", -106],
		["Rauschen -40 dBFS", -40],
	]) {
		const x = new Float32Array(48000 * 4);
		if (db !== null) S.addNoise(x, Math.pow(10, db / 20), 17);
		const tl = S.runTuner(new TunerEngine(48000), x, 48000, { everySeconds: 0.01 });
		ok(`${label}: immer „silent“`, tl.every((e) => e.r.state === "silent"), `${tl.filter((e) => e.r.state !== "silent").length} Abfragen nicht still`);
	}
	{
		const x = new Float32Array(48000 * 2);
		S.addNoise(x, Math.pow(10, -94 / 20), 18);
		const r = S.runTuner(new TunerEngine(48000), x, 48000).pop().r;
		check("Stille: Note --, Cent 0, nicht gestimmt", [r.noteName, r.cents, r.inTune, r.frequency], ["--", 0, false, 0]);
		ok("Stille: Pegel ≈ -94 dBFS", Math.abs(r.level + 94) < 1.5, `ist ${f2(r.level)}`);
	}

	section("Tuner: hohe E (E4 +7 Cent, Start -30 dBFS, Rauschen -106 dBFS, 48 kHz)");
	{
		const { e, b, tl, sig } = measure("E4", 7, 48000, -30, -106, true, { durationSec: 11 });
		describe("E4", e, b);
		ok("erste Anzeige nach höchstens 150 ms", e.first <= 0.15, `ist ${f2(e.first)} s`);
		ok("immer die richtige Note E4", e.wrong === 0 && e.polls > 100);
		ok("Fehler im Mittel unter 0,3 Cent", e.meanErrSettled < 0.3, `ist ${f2(e.meanErrSettled)}`);
		ok("Fehler höchstens 1 Cent", e.maxErr <= 1, `ist ${f2(e.maxErr)}`);
		ok("Anzeige ruhig (Streuung unter 0,3 Cent)", e.jitter < 0.3, `ist ${f2(e.jitter)}`);
		ok("verfolgt mindestens 4,5 s", e.trackEnd >= 4.5, `ist ${f2(e.trackEnd)} s`);
		ok("verfolgt bis mehr als 70 dB unter den Startpegel", e.endDb < -70, `ist ${f2(e.endDb)} dB`);
		ok("Basislinie (-55 dBFS) verliert die hohe E nach unter 1,5 s", b.trackEnd < 1.5, `ist ${f2(b.trackEnd)} s`);
		ok("Engine verfolgt mindestens dreimal so lange wie die Basislinie", e.trackEnd >= 3 * b.trackEnd, `${f2(e.trackEnd)} gegen ${f2(b.trackEnd)} s`);
		const after = tl.filter((x) => x.t > sig.onset + e.trackEnd);
		const held = after.filter((x) => x.r.state === "held");
		ok("danach „held“ mit Note und letztem Wert", held.length > 0 && held.every((x) => x.r.noteName === "E" && Math.abs(x.r.cents - 7) < 1.5));
		ok("„held“ etwa 3 s lang, dann „silent“", Math.abs(held.length * 0.01 - 3) < 0.1 && after[after.length - 1].r.state === "silent", `held ${f2(held.length * 0.01)} s`);
		const r = tl.find((x) => x.t > sig.onset + 1).r;
		check("Felder: E 4 tracking nicht gestimmt", [r.noteName, r.octave, r.state, r.inTune, r.midi], ["E", 4, "tracking", false, 64]);
		ok("Frequenz passt zu Note und Cent", Math.abs(r.frequency - N.frequencyOf(64) * Math.pow(2, r.cents / 1200)) < 1e-9);
		ok("Klarheit 0 … 1 und hoch", r.clarity > 0.5 && r.clarity <= 1, `ist ${f2(r.clarity)}`);
	}

	section("Tuner: Gitarre E2 -16 Cent (44,1 kHz, Start -12 dBFS, Rauschen -94 dBFS)");
	{
		const { e, b } = measure("E2", -16, 44100, -12, -94, true);
		describe("E2", e, b);
		ok("richtige Oktave, keine falsche Note", e.wrong === 0 && e.octave === 0);
		ok("erste Anzeige nach höchstens 200 ms", e.first <= 0.2, `ist ${f2(e.first)} s`);
		ok("Fehler höchstens 1 Cent", e.maxErr <= 1, `ist ${f2(e.maxErr)}`);
		ok("verfolgt mindestens doppelt so lange wie die Basislinie", e.trackEnd >= 2 * b.trackEnd, `${f2(e.trackEnd)} gegen ${f2(b.trackEnd)} s`);
	}

	section("Tuner: Bass mit schwachem Grundton (2. Teilton 6 … 10 dB stärker)");
	for (const [name, cents, rate] of [
		["B0", -16, 48000],
		["E1", 30, 44100],
		["F#1", -3, 48000],
		["B1", 7, 44100],
	]) {
		const { e } = measure(name, cents, rate, -30, -106, false, { durationSec: 6 });
		describe(`${name} ${cents > 0 ? "+" : ""}${cents} Cent`, e);
		ok(`${name}: keine Oktav- oder andere Fehlnote`, e.wrong === 0 && e.polls > 100, `falsch ${e.wrong}, Abfragen ${e.polls}`);
		ok(`${name}: erste Anzeige nach höchstens 300 ms`, e.first <= 0.3, `ist ${f2(e.first)} s`);
		ok(`${name}: Fehler höchstens 1 Cent`, e.maxErr <= 1, `ist ${f2(e.maxErr)}`);
	}

	section("Tuner: hohe Lagen (bis 1,4 kHz)");
	for (const [midi, cents, rate] of [
		[84, 30, 44100],
		[88, -16, 44100],
		[88, 7, 48000],
	]) {
		const sig = S.pluck({ sampleRate: rate, midi, cents, durationSec: 3, t60: 1.5, B: 1e-4, peakDb: -30, noiseDb: -106, seed: 2 });
		const tl = S.runTuner(new TunerEngine(rate), sig.signal, rate, { everySeconds: 0.01 });
		const e = S.score(tl, { onset: sig.onset, midi, cents });
		const label = `${N.noteName(midi)}${N.octaveOf(midi)} ${cents > 0 ? "+" : ""}${cents} Cent, ${rate} Hz`;
		ok(`${label}: richtige Oktave, ab höchstens 100 ms, auf 0,5 Cent genau`, e.wrong === 0 && e.polls > 50 && e.first <= 0.1 && e.maxErr <= 0.5, `falsch ${e.wrong}, ab ${f2(e.first)} s, max ${f2(e.maxErr)}`);
	}

	section("Tuner: Optionen");
	{
		const st = string("B3");
		const sig = S.pluck({ sampleRate: 48000, midi: st.midi, cents: 1, durationSec: 2, t60: st.t60, B: st.B, peakDb: -20, noiseDb: -100 });
		const r = S.runTuner(new TunerEngine(48000, { germanH: true }), sig.signal, 48000).pop().r;
		check("H statt B: B3 heißt H3", [r.noteName, r.octave], ["H", 3]);
		ok("1 Cent gilt als gestimmt", r.inTune && Math.abs(r.cents - 1) < 0.5, `Cent ${f2(r.cents)}`);
		const r2 = S.runTuner(new TunerEngine(48000), sig.signal, 48000).pop().r;
		check("ohne Option: B", r2.noteName, "B");
		const sig442 = S.pluck({ sampleRate: 48000, midi: 64, cents: 0, a4: 442, durationSec: 2, t60: 3.5, peakDb: -20, noiseDb: -100 });
		const r3 = S.runTuner(new TunerEngine(48000, { a4: 442 }), sig442.signal, 48000).pop().r;
		ok("Kammerton 442: E4 nach 442 zeigt 0 Cent", r3.noteName === "E" && Math.abs(r3.cents) < 0.3, `${r3.noteName} ${f2(r3.cents)}`);
		const r4 = S.runTuner(new TunerEngine(48000), sig442.signal, 48000).pop().r;
		ok("dieselbe Saite gegen 440: +7,85 Cent", Math.abs(r4.cents - 1200 * Math.log2(442 / 440)) < 0.3, `${f2(r4.cents)}`);
	}

	section("Tuner: Notenwechsel, Wiederanschlag, Sprung, Wandern über die Notengrenze");
	{
		const sig = S.sequence(48000, 7, [
			{ midi: 40, cents: -16, t60: 8, fundamentalDb: -8, B: 3e-5, startSec: 1, peakDb: -20, seed: 1 },
			{ midi: 45, cents: 5, t60: 7, fundamentalDb: -5, B: 3e-5, startSec: 3, peakDb: -20, seed: 2 },
			{ midi: 45, cents: 5, t60: 7, fundamentalDb: -5, B: 3e-5, startSec: 5, peakDb: -20, seed: 3 },
		]);
		const tl = S.runTuner(new TunerEngine(48000), sig.signal, 48000, { everySeconds: 0.01 });
		const firstA = tl.find((e) => e.t > 3 && e.r.noteName === "A");
		ok("E2 → A2: neue Note nach höchstens 200 ms", firstA && firstA.t - 3 <= 0.2, firstA ? `nach ${f2(firstA.t - 3)} s` : "nie");
		const between = tl.filter((e) => e.t > 3.3 && e.t < 7);
		ok("A2 bleibt (auch über den Wiederanschlag bei 5 s) ohne Lücke", between.every((e) => e.r.state === "tracking" && e.r.noteName === "A"));
		const err = Math.max(...tl.filter((e) => e.t > 5.4 && e.t < 7).map((e) => Math.abs(e.r.cents - 5)));
		ok("A2 nach dem Wiederanschlag auf 0,5 Cent genau", err < 0.5, `max ${f2(err)}`);
	}
	{
		const st = string("E4");
		const sig = S.pluck({ sampleRate: 48000, midi: st.midi, cents: 0, durationSec: 3, t60: st.t60, B: st.B, peakDb: -20, noiseDb: -94, pitch: (t) => (t >= 2 ? 10 : 0) });
		const tl = S.runTuner(new TunerEngine(48000), sig.signal, 48000, { everySeconds: 0.01 });
		const reach = tl.find((e) => e.t >= 2 && e.r.cents >= 9);
		ok("Sprung +10 Cent: 90 % nach höchstens 150 ms", reach && reach.t - 2 <= 0.15, reach ? `nach ${Math.round((reach.t - 2) * 1000)} ms` : "nie");
	}
	{
		const st = string("G3");
		const sig = S.pluck({ sampleRate: 44100, midi: st.midi, cents: -40, durationSec: 6.5, t60: 20, B: st.B, peakDb: -20, noiseDb: -94, pitch: (t) => (t < 2 ? 0 : t < 5 ? (t - 2) * 40 : 120) });
		const tl = S.runTuner(new TunerEngine(44100), sig.signal, 44100, { everySeconds: 0.01 });
		const names = [];
		for (const e of tl) if (e.r.state !== "silent" && names[names.length - 1] !== e.r.noteName) names.push(e.r.noteName);
		check("G3 gleitet von -40 auf +80 Cent: G, dann G#, kein Pendeln", names, ["G", "G#"]);
		const last = tl[tl.length - 1].r;
		ok("am Ende G#3 -20 Cent", last.noteName === "G#" && Math.abs(last.cents + 20) < 0.5, `${last.noteName} ${f2(last.cents)}`);
		ok("Anzeige nie jenseits ±56 Cent", tl.every((e) => Math.abs(e.r.cents) <= 56));
	}

	section("Tuner: Abdämpfen mit der Hand");
	{
		// E4 bei +3 Cent; nach 3 s drückt ein Finger auf: +25 Cent und binnen 60 ms -40 dB.
		const rate = 48000;
		const st = string("E4");
		const sig = S.pluck({ sampleRate: rate, midi: st.midi, cents: 3, durationSec: 5, t60: st.t60, B: st.B, peakDb: -20, noiseDb: null, pitch: (t) => (t >= 3 ? Math.min(22, (t - 3) * 600) : 0) });
		const x = Float64Array.from(sig.clean);
		for (let i = Math.round(3 * rate); i < x.length; i++) x[i] *= Math.pow(10, (-40 * Math.min(1, (i / rate - 3) / 0.06)) / 20);
		S.addNoise(x, Math.pow(10, -100 / 20), 4);
		const tl = S.runTuner(new TunerEngine(rate), Float32Array.from(x), rate, { everySeconds: 0.01 });
		const after = tl.filter((e) => e.t > 3.3 && e.t < 5);
		ok("nach dem Abdämpfen „held“", after.length > 0 && after.every((e) => e.r.state === "held"));
		const shown = after.length ? after[0].r.cents : NaN;
		ok("gehalten wird der Wert von vor dem Abdämpfen (+3 ± 1 Cent)", Math.abs(shown - 3) <= 1, `ist ${f2(shown)}`);
	}

	section("Tuner: Blockgrößen, Abtastraten, Rechenzeit");
	{
		const st = string("D3");
		const sig = S.pluck({ sampleRate: 48000, midi: st.midi, cents: -3, durationSec: 2.5, t60: st.t60, B: st.B, peakDb: -20, noiseDb: -94 });
		const snap = (blockSeconds) => {
			const eng = new TunerEngine(48000);
			const out = [];
			const blk = Math.round(blockSeconds * 48000);
			for (let i = 0; i < sig.signal.length; i += blk) {
				eng.push(sig.signal.subarray(i, Math.min(sig.signal.length, i + blk)));
				if ((i + blk) % 4800 === 0) out.push(JSON.stringify(eng.reading()));
			}
			return out;
		};
		const a = snap(0.1);
		ok("Blöcke 1 Wert, 10 ms, 100 ms: dieselben Anzeigen", JSON.stringify(snap(1 / 48000)) === JSON.stringify(a) && JSON.stringify(snap(0.01)) === JSON.stringify(a) && a.length === 25);
	}
	for (const rate of [44100, 48000, 96000]) {
		const st = string("A2");
		const sig = S.pluck({ sampleRate: rate, midi: st.midi, cents: 7, durationSec: 2.5, t60: st.t60, fundamentalDb: st.fundamentalDb, B: st.B, peakDb: -20, noiseDb: -100 });
		const r = S.runTuner(new TunerEngine(rate), sig.signal, rate).pop().r;
		ok(`${rate} Hz: A2 +7 Cent auf 0,3 Cent genau`, r.noteName === "A" && r.octave === 2 && Math.abs(r.cents - 7) < 0.3, `${r.noteName}${r.octave} ${f2(r.cents)}`);
	}
	{
		let audio = 0;
		let ns = 0n;
		for (const name of ["E2", "E4", "B0"]) {
			const st = string(name);
			const sig = S.pluck({ sampleRate: 48000, midi: st.midi, cents: 7, durationSec: 6, t60: st.t60, fundamentalDb: st.fundamentalDb, B: st.B, peakDb: -20, noiseDb: -100, seed: 5 });
			const eng = new TunerEngine(48000);
			const t0 = process.hrtime.bigint();
			for (let i = 0; i < sig.signal.length; i += 480) {
				eng.push(sig.signal.subarray(i, i + 480));
				if ((i / 480) % 5 === 4) eng.reading();
			}
			ns += process.hrtime.bigint() - t0;
			audio += 6;
		}
		const share = Number(ns) / 1e9 / audio;
		console.log(`      Rechenzeit bei 48 kHz: ${(share * 100).toFixed(2)} % eines Kerns`);
		// Großzügig, damit ein voller Rechner den Test nicht kippt; Ziel und Messung: < 3 %.
		ok("Rechenzeit unter 10 % eines Kerns (Ziel 3 %)", share < 0.1, `${(share * 100).toFixed(2)} %`);
	}

	section("Tuner: Basislinie (TONE3000-Verfahren, -55 dBFS)");
	{
		const x = new Float32Array(48000 * 3);
		S.addNoise(x, Math.pow(10, -94 / 20), 21);
		ok("Rauschen: Basislinie still", S.runTuner(new BaselineTuner(48000), x, 48000).every((e) => e.r.state === "silent"));
		const st = string("E4");
		const sig = S.pluck({ sampleRate: 48000, midi: st.midi, cents: 0, durationSec: 4, t60: st.t60, B: st.B, peakDb: -12, noiseDb: -94 });
		const r = S.runTuner(new BaselineTuner(48000), sig.signal, 48000, { everySeconds: 0.01 }).find((e) => e.t > 1.5).r;
		ok("laut: Basislinie zeigt E4 auf 2 Cent", r.noteName === "E" && r.octave === 4 && Math.abs(r.cents) < 2, `${r.noteName}${r.octave} ${f2(r.cents)}`);
	}
};
