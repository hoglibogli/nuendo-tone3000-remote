/**
 * Synthetische Gitarrensaiten und Messhilfen für die Tuner-Tests und
 * tools/tuner-eval.cjs.
 *
 * Saite: Summe gedämpfter Teiltöne k·f1·√((1+Bk²)/(1+B)) (leichte Inharmonizität,
 * der Grundton liegt genau auf der Sollverstimmung), Stärke nach Zupfposition
 * |sin(πkp)|/k, höhere Teiltöne klingen schneller ab. Bei tiefen Saiten ist der
 * Grundton schwächer als der 2. Teilton (Steg-Tonabnehmer). Dazu weißes Rauschen
 * (Gauß, fester Startwert, also reproduzierbar).
 */
"use strict";

/** Die sechs Saiten in Standardstimmung: Abklingzeit (60 dB) des Grundtons, Grundton relativ, Inharmonizität. */
const STRINGS = [
	{ name: "E2", midi: 40, t60: 8.0, fundamentalDb: -8, B: 3e-5 },
	{ name: "A2", midi: 45, t60: 7.0, fundamentalDb: -5, B: 3e-5 },
	{ name: "D3", midi: 50, t60: 6.0, fundamentalDb: -2, B: 4e-5 },
	{ name: "G3", midi: 55, t60: 5.0, fundamentalDb: 0, B: 1e-4 },
	{ name: "B3", midi: 59, t60: 4.5, fundamentalDb: 0, B: 8e-5 },
	{ name: "E4", midi: 64, t60: 3.5, fundamentalDb: 0, B: 5e-5 },
];

/**
 * Bass (5-Saiter mit tiefer H-Saite), Bariton und 8-Saiter: langsames Abklingen,
 * Grundton 6 … 10 dB schwächer als der 2. Teilton (typisch für Bass-DI), steifere Saiten.
 */
const LOW_STRINGS = [
	{ name: "B0", midi: 23, t60: 15, fundamentalDb: -10, B: 3e-4, group: "Bass" },
	{ name: "E1", midi: 28, t60: 14, fundamentalDb: -9, B: 2.5e-4, group: "Bass" },
	{ name: "A1", midi: 33, t60: 13, fundamentalDb: -8, B: 2e-4, group: "Bass" },
	{ name: "D2", midi: 38, t60: 12, fundamentalDb: -7, B: 1.5e-4, group: "Bass" },
	{ name: "G2", midi: 43, t60: 11, fundamentalDb: -6, B: 1.2e-4, group: "Bass" },
	{ name: "B1", midi: 35, t60: 9, fundamentalDb: -8, B: 6e-5, group: "Bariton" },
	{ name: "F#1", midi: 30, t60: 10, fundamentalDb: -9, B: 8e-5, group: "8-Saiter" },
];

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Weißes Gaußrauschen mit Effektivwert sigma. */
function addNoise(out, sigma, seed) {
	const rand = mulberry32(seed);
	for (let i = 0; i < out.length; i += 2) {
		const u = Math.max(rand(), 1e-12);
		const v = rand();
		const r = sigma * Math.sqrt(-2 * Math.log(u));
		out[i] += r * Math.cos(2 * Math.PI * v);
		if (i + 1 < out.length) out[i + 1] += r * Math.sin(2 * Math.PI * v);
	}
}

/**
 * Eine gezupfte Saite. Rückgabe: signal (Float32Array, mit Rauschen), clean (ohne),
 * f1 (Hz), onset (s).
 *
 * opts: sampleRate, midi, cents, durationSec, startSec (1), peakDb (-12: Spitze der
 * ersten 50 ms), t60, fundamentalDb, B, pluckPos (0,18), noiseDb (-94 dBFS RMS),
 * seed, a4 (440), pitch: t => Cent (zusätzliche Verstimmung über der Zeit seit
 * Signalbeginn in s, phasenstetig; für Sprungantwort und Gleiten),
 * modes: [{ cents, gain, t60Scale }] (Grundton als mehrere Schwingungen, etwa zwei
 * Schwingungsebenen mit leicht verschiedener Frequenz und Abklingzeit: Schwebung).
 */
function pluck(opts) {
	const fs = opts.sampleRate;
	const a4 = opts.a4 ?? 440;
	const n = Math.round(opts.durationSec * fs);
	const s0 = Math.round((opts.startSec ?? 1) * fs);
	const B = opts.B ?? 5e-5;
	const p = opts.pluckPos ?? 0.18;
	const rand = mulberry32((opts.seed ?? 1) * 7919 + 13);
	const f1 = a4 * Math.pow(2, (opts.midi - 69) / 12) * Math.pow(2, (opts.cents ?? 0) / 1200);
	const pitch = opts.pitch;
	const clean = new Float64Array(n);
	const ramp = Math.round(0.001 * fs);
	for (let k = 1; k <= 30; k++) {
		const fk = k * f1 * Math.sqrt((1 + B * k * k) / (1 + B));
		if (fk > 0.42 * fs || fk > 8000 || k > (opts.maxPartials ?? 30)) break;
		let amp = Math.abs(Math.sin(Math.PI * k * p)) / k;
		if (k === 1) amp *= Math.pow(10, (opts.fundamentalDb ?? 0) / 20);
		const t60k = opts.t60 / (1 + 0.15 * (k - 1));
		const modes = k === 1 && opts.modes ? opts.modes : [{ cents: 0, gain: 1, t60Scale: 1 }];
		for (const m of modes) partial(fk * Math.pow(2, (m.cents ?? 0) / 1200), amp * (m.gain ?? 1), t60k * (m.t60Scale ?? 1));
	}
	function partial(fk, amp, t60k) {
		const decay = Math.exp(Math.log(1e-3) / (t60k * fs));
		let w = (2 * Math.PI * fk) / fs;
		let cd = Math.cos(w);
		let sd = Math.sin(w);
		const ph = rand() * 2 * Math.PI;
		let c = Math.cos(ph);
		let s = Math.sin(ph);
		let a = amp;
		for (let i = s0; i < n; i++) {
			if (pitch && (i & 15) === 0) {
				w = (2 * Math.PI * fk * Math.pow(2, pitch(i / fs) / 1200)) / fs;
				cd = Math.cos(w);
				sd = Math.sin(w);
			}
			const env = i - s0 < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (i - s0)) / ramp) : 1;
			clean[i] += a * s * env;
			const c2 = c * cd - s * sd;
			s = s * cd + c * sd;
			c = c2;
			a *= decay;
			if ((i & 1023) === 0) {
				const g = 1 / Math.hypot(c, s);
				c *= g;
				s *= g;
			}
		}
	}
	let peak = 0;
	for (let i = s0; i < Math.min(n, s0 + Math.round(0.05 * fs)); i++) peak = Math.max(peak, Math.abs(clean[i]));
	const gain = peak > 0 ? Math.pow(10, (opts.peakDb ?? -12) / 20) / peak : 0;
	for (let i = 0; i < n; i++) clean[i] *= gain;
	const noisy = Float64Array.from(clean);
	if (opts.noiseDb !== null) addNoise(noisy, Math.pow(10, (opts.noiseDb ?? -94) / 20), (opts.seed ?? 1) * 104729 + 7);
	return { signal: Float32Array.from(noisy), clean, f1, onset: s0 / fs, sampleRate: fs };
}

/**
 * Mehrere Anschläge in einem Signal: parts sind pluck-Optionen (ohne Rauschen erzeugt),
 * dazu einmal Rauschen. Rückgabe wie pluck, onsets je Teil.
 */
function sequence(fs, durationSec, parts, noiseDb = -94, seed = 1) {
	const n = Math.round(durationSec * fs);
	const clean = new Float64Array(n);
	const onsets = [];
	for (const part of parts) {
		const p = pluck({ ...part, sampleRate: fs, durationSec, noiseDb: null });
		for (let i = 0; i < n; i++) clean[i] += p.clean[i];
		onsets.push(p.onset);
	}
	const noisy = Float64Array.from(clean);
	if (noiseDb !== null) addNoise(noisy, Math.pow(10, noiseDb / 20), seed * 104729 + 7);
	return { signal: Float32Array.from(noisy), clean, onsets, sampleRate: fs };
}

/** Pegel des sauberen Signals (RMS über 50 ms um t) relativ zu den ersten 50 ms nach dem Anschlag, in dB. */
function levelBelowStart(clean, fs, onset, t) {
	const rms = (from, to) => {
		let sum = 0;
		let n = 0;
		for (let i = Math.max(0, Math.round(from * fs)); i < Math.min(clean.length, Math.round(to * fs)); i++, n++) sum += clean[i] * clean[i];
		return n ? Math.sqrt(sum / n) : 0;
	};
	const ref = rms(onset, onset + 0.05);
	const now = rms(t - 0.025, t + 0.025);
	return now > 0 && ref > 0 ? 20 * Math.log10(now / ref) : -Infinity;
}

/**
 * Signal in Blöcken (Standard 10 ms) durch einen Tuner schicken und alle 50 ms den
 * Stand abfragen. Rückgabe: [{ t, r }] mit t in s (Ende des Abfrageintervalls).
 */
function runTuner(tuner, signal, fs, opts = {}) {
	const block = Math.max(1, Math.round((opts.blockSeconds ?? 0.01) * fs));
	const every = Math.round((opts.everySeconds ?? 0.05) * fs);
	const out = [];
	let nextPoll = every;
	for (let i = 0; i < signal.length; i += block) {
		const end = Math.min(signal.length, i + block);
		tuner.push(signal.subarray(i, end));
		while (end >= nextPoll) {
			out.push({ t: nextPoll / fs, r: tuner.reading(), d: typeof tuner.debug === "function" ? tuner.debug() : undefined });
			nextPoll += every;
		}
	}
	return out;
}

function mean(xs) {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function std(xs) {
	if (xs.length < 2) return NaN;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/**
 * Kennzahlen eines Durchlaufs gegen die Wahrheit.
 *   first      s vom Anschlag bis zur ersten Anzeige „tracking" (beliebige Note)
 *   firstOk    … bis zur ersten mit richtiger Note und Oktave
 *   trackEnd   s vom Anschlag bis zur letzten Anzeige „tracking"
 *   shownEnd   … bis zur letzten Anzeige außer „silent" (mit Haltezeit)
 *   gaps       Abfragen ohne „tracking" zwischen erster und letzter
 *   wrong      Abfragen „tracking" mit falscher Note; octave davon Oktav-/Oberton-Fehler
 *   meanErr, maxErr   |Cent − Wahrheit| über alle Abfragen „tracking" mit richtiger Note
 *   meanErrSettled, maxErrSettled   ab 0,3 s nach dem Anschlag
 *   jitter     Standardabweichung der Cent-Anzeige ab 0,3 s
 */
function score(timeline, truth) {
	const after = timeline.filter((e) => e.t >= truth.onset);
	const tracking = after.filter((e) => e.r.state === "tracking");
	const firstE = tracking[0];
	const ok = tracking.filter((e) => e.r.midi === truth.midi);
	const wrong = tracking.filter((e) => e.r.midi !== truth.midi);
	const octave = wrong.filter((e) => Math.abs(e.r.midi - truth.midi) % 12 === 0 || [19, 28, 31].includes(Math.abs(e.r.midi - truth.midi)));
	const errs = ok.map((e) => Math.abs(e.r.cents - truth.cents));
	const settled = ok.filter((e) => e.t - truth.onset >= 0.3);
	const errsS = settled.map((e) => Math.abs(e.r.cents - truth.cents));
	const shown = after.filter((e) => e.r.state !== "silent");
	const last = tracking.length ? tracking[tracking.length - 1] : undefined;
	let gaps = 0;
	if (firstE && last) gaps = after.filter((e) => e.t > firstE.t && e.t < last.t && e.r.state !== "tracking").length;
	return {
		first: firstE ? firstE.t - truth.onset : NaN,
		firstOk: ok.length ? ok[0].t - truth.onset : NaN,
		trackEnd: last ? last.t - truth.onset : 0,
		shownEnd: shown.length ? shown[shown.length - 1].t - truth.onset : 0,
		gaps,
		polls: tracking.length,
		wrong: wrong.length,
		octave: octave.length,
		meanErr: mean(errs),
		maxErr: errs.length ? Math.max(...errs) : NaN,
		meanErrSettled: mean(errsS),
		maxErrSettled: errsS.length ? Math.max(...errsS) : NaN,
		bias: mean(settled.map((e) => e.r.cents - truth.cents)),
		jitter: std(settled.map((e) => e.r.cents)),
	};
}

module.exports = { STRINGS, LOW_STRINGS, pluck, sequence, addNoise, levelBelowStart, runTuner, score, mean, std, mulberry32 };
