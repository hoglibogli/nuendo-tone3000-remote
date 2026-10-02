/**
 * Auswertung der Tonhöhenerkennung (streamdeck-plugin/src/tuner) ohne Audiogerät.
 *
 *   node tools/tuner-eval.cjs aufnahmen/saiten-1.wav
 *        Zeitleiste der Anzeige (alle 50 ms) und je Anschlag eine Zusammenfassung,
 *        daneben die Breitband-Basislinie (TONE3000-Verfahren, feste Schwelle -55 dBFS).
 *        Optionen:
 *          --schritt 0.05      Abstand der Zeilen der Zeitleiste in s
 *          --von 12 --bis 40   nur dieser Ausschnitt der Zeitleiste (s)
 *          --kanal 1           Kanal einer Mehrkanal-WAV (genau einer, nie gemischt)
 *          --a4 442 --h        Kammerton; „H" statt „B"
 *          --nur-anschlaege    ohne Zeitleiste
 *          --csv datei.csv     Zeitleiste zusätzlich als CSV (alle 10 ms)
 *
 *   node tools/tuner-eval.cjs --synth [--schnell]
 *        Synthetische Messreihe: Gitarre E2 … E4, Bass B0 … G2, Bariton B1, 8-Saiter
 *        F#1, je fünf Verstimmungen, 44,1 und 48 kHz, Start -12 dBFS / Rauschen
 *        -94 dBFS und Start -30 dBFS / Rauschen -106 dBFS; Engine gegen Basislinie,
 *        dazu die Rechenzeit. --schnell: nur 48 kHz und zwei Verstimmungen.
 *
 * WAV: 16/24/32-Bit-PCM oder 32-Bit-Float; die Datei wird nur gelesen.
 * Die Engine kommt aus streamdeck-plugin/test-output/build/tuner (von npm test), wenn
 * sie neuer als die Quellen ist; sonst kompiliert das Werkzeug src/tuner nach
 * streamdeck-plugin/test-output/tuner-build. Keine Audiogeräte, keine Ports.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

const PLUGIN = path.join(__dirname, "..", "streamdeck-plugin");
const SYNTH = path.join(PLUGIN, "test", "tuner-synth.cjs");

// --- Engine laden -------------------------------------------------------------

function newestSource() {
	const dir = path.join(PLUGIN, "src", "tuner");
	return Math.max(...fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
}

function upToDate(dir) {
	const files = ["engine.js", "baseline.js", "heterodyne.js", "yin.js", "filters.js", "notes.js"].map((f) => path.join(dir, "tuner", f));
	if (!files.every((f) => fs.existsSync(f))) return false;
	if (!fs.existsSync(path.join(dir, "package.json"))) return false;
	return Math.min(...files.map((f) => fs.statSync(f).mtimeMs)) >= newestSource();
}

/** Verzeichnis mit der kompilierten Engine (…/tuner/engine.js darunter). */
function buildDir() {
	const testBuild = path.join(PLUGIN, "test-output", "build");
	if (upToDate(testBuild)) return testBuild;
	const own = path.join(PLUGIN, "test-output", "tuner-build");
	if (upToDate(own)) return own;
	process.stderr.write("Kompiliere src/tuner nach test-output/tuner-build …\n");
	fs.rmSync(own, { recursive: true, force: true });
	execFileSync(
		process.execPath,
		[
			path.join(PLUGIN, "node_modules", "typescript", "bin", "tsc"),
			"src/tuner/engine.ts",
			"src/tuner/baseline.ts",
			"--outDir", own,
			"--rootDir", "src",
			"--module", "commonjs",
			"--target", "ES2022",
			"--moduleResolution", "node",
			"--esModuleInterop",
			"--strict",
			"--skipLibCheck",
		],
		{ cwd: PLUGIN, stdio: "inherit" },
	);
	fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ type: "commonjs" }));
	return own;
}

function loadTuner(dir) {
	return {
		TunerEngine: require(path.join(dir, "tuner", "engine.js")).TunerEngine,
		BaselineTuner: require(path.join(dir, "tuner", "baseline.js")).BaselineTuner,
	};
}

// --- Hilfen -------------------------------------------------------------------

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
const pad = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s).padEnd(n);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function std(xs) {
	if (xs.length < 2) return NaN;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/** WAV lesen: ein Kanal als Float32Array, nie eine Summe. */
function readWav(file, channel) {
	const buf = fs.readFileSync(file);
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file}: keine WAV-Datei`);
	let off = 12;
	let fmtChunk = null;
	let data = null;
	while (off + 8 <= buf.length) {
		const id = buf.toString("ascii", off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		if (id === "fmt ") {
			let tag = buf.readUInt16LE(off + 8);
			if (tag === 0xfffe && size >= 40) tag = buf.readUInt16LE(off + 8 + 24); // WAVE_FORMAT_EXTENSIBLE: Unterformat
			fmtChunk = { tag, channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
		} else if (id === "data") {
			data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
		}
		off += 8 + size + (size & 1);
	}
	if (!fmtChunk || !data) throw new Error(`${file}: fmt- oder data-Block fehlt`);
	const { tag, channels, rate, bits } = fmtChunk;
	if (channel < 1 || channel > channels) throw new Error(`${file}: Kanal ${channel} gibt es nicht (1 … ${channels})`);
	const bytes = bits / 8;
	const frame = bytes * channels;
	const n = Math.floor(data.length / frame);
	const out = new Float32Array(n);
	const at = (i) => i * frame + (channel - 1) * bytes;
	if (tag === 3 && bits === 32) for (let i = 0; i < n; i++) out[i] = data.readFloatLE(at(i));
	else if (tag === 1 && bits === 16) for (let i = 0; i < n; i++) out[i] = data.readInt16LE(at(i)) / 32768;
	else if (tag === 1 && bits === 24) for (let i = 0; i < n; i++) out[i] = data.readIntLE(at(i), 3) / 8388608;
	else if (tag === 1 && bits === 32) for (let i = 0; i < n; i++) out[i] = data.readInt32LE(at(i)) / 2147483648;
	else throw new Error(`${file}: Format ${tag}/${bits} Bit wird nicht unterstützt (PCM 16/24/32 oder Float 32)`);
	return { samples: out, rate, channels, bits, float: tag === 3 };
}

// --- Echte Aufnahme ------------------------------------------------------------

function evalWav(file) {
	const channel = Number(arg("--kanal", "1"));
	const wav = readWav(file, channel);
	const { TunerEngine, BaselineTuner } = loadTuner(buildDir());
	const opts = { a4: Number(arg("--a4", "440")), germanH: flag("--h") };
	const fs_ = wav.rate;
	const engine = new TunerEngine(fs_, opts);
	const base = new BaselineTuner(fs_, opts);
	const step = Number(arg("--schritt", "0.05"));
	const from = Number(arg("--von", "0"));
	const to = Number(arg("--bis", "1e9"));
	const csvFile = arg("--csv", "");
	const showTimeline = !flag("--nur-anschlaege");

	console.log(
		`${file}: ${(wav.samples.length / fs_).toFixed(1)} s, ${fs_} Hz, Kanal ${channel} von ${wav.channels}, ${wav.float ? "Float" : "PCM"} ${wav.bits} Bit`,
	);
	// 10-ms-Blöcke wie später aus WASAPI; Abfrage alle 10 ms (Kennzahlen), Ausgabe im Schritt.
	const block = Math.round(fs_ / 100);
	const timeline = [];
	const onsets = [];
	let lastOnsets = 0;
	const t0 = process.hrtime.bigint();
	let engineNs = 0n;
	for (let i = 0; i < wav.samples.length; i += block) {
		const b = wav.samples.subarray(i, Math.min(wav.samples.length, i + block));
		const a = process.hrtime.bigint();
		engine.push(b);
		engineNs += process.hrtime.bigint() - a;
		base.push(b);
		const t = Math.min(wav.samples.length, i + block) / fs_;
		const r = engine.reading();
		const d = engine.debug();
		if (d.onsets !== lastOnsets) {
			onsets.push({ t: t - 0.01, level: r.level });
			lastOnsets = d.onsets;
		}
		timeline.push({ t, r, d, b: base.reading() });
	}
	const totalS = Number(process.hrtime.bigint() - t0) / 1e9;
	const audioS = wav.samples.length / fs_;

	if (csvFile) {
		const lines = ["t;zustand;note;oktave;cent;frequenz;gestimmt;klarheit;pegel_dbfs;unsicherheit_cent;basis_zustand;basis_note;basis_cent"];
		for (const e of timeline) {
			lines.push(
				[e.t.toFixed(2), e.r.state, e.r.noteName, e.r.octave, e.r.cents.toFixed(2), e.r.frequency.toFixed(3), e.r.inTune ? 1 : 0, e.r.clarity.toFixed(3), fmt(e.r.level, 1), fmt(e.d.errorCents, 3), e.b.state, e.b.noteName + (e.b.state === "silent" ? "" : e.b.octave), e.b.cents.toFixed(2)].join(";"),
			);
		}
		fs.writeFileSync(csvFile, lines.join("\n") + "\n");
		console.log(`CSV: ${csvFile}`);
	}

	if (showTimeline) {
		console.log("\nZeitleiste (Engine | Basislinie):");
		console.log("     t  Zustand   Note   Cent   Pegel  Unsich. | Basis     Note   Cent");
		const every = Math.max(1, Math.round(step / 0.01));
		let lastKey = "";
		timeline.forEach((e, k) => {
			if (e.t < from || e.t > to) return;
			const key = e.r.state + e.r.noteName + e.r.octave + "|" + e.b.state + e.b.noteName;
			// Stille ohne Änderung nicht wiederholen.
			const quiet = e.r.state === "silent" && e.b.state === "silent" && key === lastKey;
			lastKey = key;
			if (k % every !== every - 1 || quiet) return;
			const note = (r) => (r.state === "silent" ? "--" : r.noteName + r.octave);
			const cents = (r) => (r.state === "silent" ? "" : r.cents.toFixed(1));
			console.log(
				`${pad(e.t.toFixed(2), 6)}  ${padR(e.r.state, 8)}  ${padR(note(e.r), 4)} ${pad(cents(e.r), 6)}  ${pad(fmt(e.r.level, 0), 5)}  ${pad(e.r.state === "tracking" ? fmt(e.d.errorCents, 2) : "", 6)} | ${padR(e.b.state, 8)}  ${padR(note(e.b), 4)} ${pad(cents(e.b), 6)}`,
			);
		});
	}

	// Abschnitte: zusammenhängend dieselbe Note angezeigt (verfolgt oder gehalten).
	const segments = [];
	let cur = null;
	for (const e of timeline) {
		const shown = e.r.state !== "silent";
		const key = shown ? e.r.midi : null;
		if (cur && (key !== cur.midi || !shown)) {
			segments.push(cur);
			cur = null;
		}
		if (shown && !cur && e.r.state === "tracking") cur = { midi: key, name: e.r.noteName + e.r.octave, start: e.t, polls: [] };
		if (cur) cur.polls.push(e);
	}
	if (cur) segments.push(cur);

	console.log("\nJe Anschlag (Abschnitte mit derselben Note; Basislinie im selben Zeitraum):");
	console.log(
		"  Anschlag  Note  ab  Pegel  | Cent Mittel  Streuung  (≥0,3 s) | verfolgt  Pegel am Ende  Ende durch | gehalten bis | Basislinie: Note  verfolgt  Pegel am Ende",
	);
	const rows = [];
	// Anschlag je Abschnitt: der letzte erkannte Anschlag bis 0,6 s vor der ersten Anzeige.
	const starts = segments.map((s) => {
		const onset = [...onsets].reverse().find((o) => o.t <= s.start + 1e-9 && o.t >= s.start - 0.6);
		return onset ? onset.t : s.start;
	});
	segments.forEach((s, k) => {
		const tracking = s.polls.filter((e) => e.r.state === "tracking");
		if (!tracking.length) return;
		const t0s = starts[k];
		const lastTrack = tracking[tracking.length - 1];
		const settled = tracking.filter((e) => e.t - t0s >= 0.3).map((e) => e.r.cents);
		const startLevel = Math.max(...timeline.filter((e) => e.t >= t0s && e.t <= t0s + 0.2).map((e) => e.r.level));
		const nextStart = k + 1 < segments.length ? starts[k + 1] : Infinity;
		const baseTrack = timeline.filter((e) => e.t >= t0s && e.t < nextStart && e.b.state === "tracking" && e.b.midi === s.midi);
		const baseEnd = baseTrack.length ? baseTrack[baseTrack.length - 1] : null;
		const after = s.polls.find((e) => e.t > lastTrack.t && e.r.state === "held");
		const why = after
			? after.d.lostBy === "damped"
				? "abgedämpft"
				: "unsicher"
			: s.polls[s.polls.length - 1].t >= timeline[timeline.length - 1].t - 0.02
				? "Dateiende"
				: "neue Note";
		const row = {
			onset: t0s,
			note: s.name,
			delay: s.start - t0s,
			startLevel,
			mean: mean(settled),
			std: std(settled),
			tracked: lastTrack.t - t0s,
			endLevel: lastTrack.r.level,
			heldUntil: s.polls[s.polls.length - 1].t,
			baseNote: baseEnd ? baseEnd.b.noteName + baseEnd.b.octave : "--",
			baseTracked: baseEnd ? baseEnd.t - t0s : 0,
			baseEndLevel: baseEnd ? baseEnd.r.level : NaN,
			short: lastTrack.t - s.start < 0.3,
			why,
		};
		rows.push(row);
	});
	for (const r of rows.filter((x) => !x.short)) {
		console.log(
			`  ${pad(r.onset.toFixed(2), 7)} s  ${padR(r.note, 4)} ${pad(Math.round(r.delay * 1000), 3)} ms ${pad(fmt(r.startLevel, 0), 4)} | ${pad(fmt(r.mean, 2), 9)}  ${pad(fmt(r.std, 2), 8)}           | ${pad(fmt(r.tracked, 1), 6)} s  ${pad(fmt(r.endLevel, 0), 6)} dBFS  ${padR(r.why, 10)} | ${pad(fmt(r.heldUntil, 1), 8)} s   | ${padR(r.baseNote, 4)}  ${pad(fmt(r.baseTracked, 1), 6)} s  ${pad(fmt(r.baseEndLevel, 0), 6)} dBFS`,
		);
	}
	const shorts = rows.filter((x) => x.short);
	if (shorts.length) {
		console.log(`  kurze Abschnitte (< 0,3 s verfolgt, meist Griff-/Dämpfgeräusche): ${shorts.map((r) => `${r.onset.toFixed(2)} s ${r.note}`).join(", ")}`);
	}
	console.log(
		`\nRechenzeit Engine: ${((Number(engineNs) / 1e9 / audioS) * 100).toFixed(2)} % eines Kerns (${(Number(engineNs) / 1e6).toFixed(0)} ms für ${audioS.toFixed(1)} s Audio); gesamt mit Basislinie ${totalS.toFixed(1)} s.`,
	);
}

// --- Synthetische Messreihe -------------------------------------------------------

/** Ein Fall im Worker: Signal erzeugen, Engine und Basislinie messen. */
function runCase(c, dir) {
	const S = require(SYNTH);
	const { TunerEngine, BaselineTuner } = loadTuner(dir);
	const st = [...S.STRINGS, ...S.LOW_STRINGS].find((x) => x.name === c.name);
	const dur = 1 + 2 * st.t60 + 1;
	const sig = S.pluck({ sampleRate: c.rate, midi: st.midi, cents: c.cents, durationSec: dur, t60: st.t60, fundamentalDb: st.fundamentalDb, B: st.B, peakDb: c.peakDb, noiseDb: c.noiseDb, seed: 11 + Math.round(c.cents) * 7 + st.midi });
	const truth = { onset: sig.onset, midi: st.midi, cents: c.cents };
	const a = process.hrtime.bigint();
	const te = S.runTuner(new TunerEngine(c.rate), sig.signal, c.rate, { everySeconds: 0.01 });
	const engineS = Number(process.hrtime.bigint() - a) / 1e9;
	const tb = S.runTuner(new BaselineTuner(c.rate), sig.signal, c.rate, { everySeconds: 0.01 });
	const e = S.score(te, truth);
	const b = S.score(tb, truth);
	e.endDb = S.levelBelowStart(sig.clean, c.rate, sig.onset, sig.onset + e.trackEnd);
	b.endDb = S.levelBelowStart(sig.clean, c.rate, sig.onset, sig.onset + b.trackEnd);
	return { ...c, group: st.group ?? "Gitarre", e, b, cpu: engineS / dur };
}

async function synth() {
	const dir = buildDir();
	const S = require(SYNTH);
	const quick = flag("--schnell");
	const notes = [...S.STRINGS, ...S.LOW_STRINGS];
	const cents = quick ? [-16, 7] : [-16, -3, 0, 7, 30];
	const rates = quick ? [48000] : [44100, 48000];
	const levels = [
		{ peakDb: -12, noiseDb: -94 },
		{ peakDb: -30, noiseDb: -106 },
	];
	const cases = [];
	for (const lv of levels) for (const n of notes) for (const c of cents) for (const r of rates) cases.push({ name: n.name, cents: c, rate: r, ...lv });
	const threads = Math.max(1, Math.min(8, os.cpus().length - 1));
	console.log(`Synthetische Messreihe: ${cases.length} Fälle, ${threads} Threads …`);
	const results = [];
	let next = 0;
	await new Promise((resolve, reject) => {
		let running = 0;
		const start = () => {
			if (next >= cases.length && running === 0) return resolve();
			while (running < threads && next < cases.length) {
				const c = cases[next++];
				running++;
				const w = new Worker(__filename, { workerData: { case: c, dir } });
				w.once("message", (m) => results.push(m));
				w.once("error", reject);
				w.once("exit", () => {
					running--;
					start();
				});
			}
		};
		start();
	});

	const order = notes.map((n) => n.name);
	for (const lv of levels) {
		console.log(`\n=== Start ${lv.peakDb} dBFS, Rauschen ${lv.noiseDb} dBFS RMS (Mittel über ${cents.length} Verstimmungen × ${rates.length} Raten; Fehler = Anzeige − wahre Verstimmung)`);
		console.log(
			"Note  Gruppe    | Anzeige ab ms  | verfolgt s       | Ende dB unter Start | Fehler Ø/max Cent       | Streuung Cent | Oktave/falsch",
		);
		console.log(
			"                |  Eng.   Basis  |  Eng.    Basis   |   Eng.    Basis     |  Engine      Basis      |  Eng.  Basis  | Eng.   Basis",
		);
		for (const name of order) {
			const rs = results.filter((r) => r.name === name && r.peakDb === lv.peakDb);
			if (!rs.length) continue;
			const m = (f) => mean(rs.map(f).filter(Number.isFinite));
			const mx = (f) => Math.max(...rs.map(f).filter(Number.isFinite));
			console.log(
				`${padR(name, 4)}  ${padR(rs[0].group, 8)}  | ${pad(fmt(m((r) => r.e.first * 1000), 0), 5)}  ${pad(fmt(m((r) => r.b.first * 1000), 0), 5)}  | ${pad(fmt(m((r) => r.e.trackEnd), 1), 5)}  ${pad(fmt(m((r) => r.b.trackEnd), 1), 5)}     | ${pad(fmt(m((r) => r.e.endDb), 0), 5)}  ${pad(fmt(m((r) => r.b.endDb), 0), 6)}       | ${pad(fmt(m((r) => r.e.meanErr), 2), 5)}/${pad(fmt(mx((r) => r.e.maxErr), 2), 5)}  ${pad(fmt(m((r) => r.b.meanErr), 2), 5)}/${pad(fmt(mx((r) => r.b.maxErr), 2), 5)} | ${pad(fmt(m((r) => r.e.jitter), 2), 5)} ${pad(fmt(m((r) => r.b.jitter), 2), 5)}  | ${pad(rs.reduce((a, r) => a + r.e.octave, 0) + "/" + rs.reduce((a, r) => a + r.e.wrong, 0), 5)}  ${pad(rs.reduce((a, r) => a + r.b.octave, 0) + "/" + rs.reduce((a, r) => a + r.b.wrong, 0), 5)}`,
			);
		}
		const rs = results.filter((r) => r.peakDb === lv.peakDb);
		const ratio = mean(rs.map((r) => r.e.trackEnd / Math.max(r.b.trackEnd, 0.01)));
		console.log(
			`Summe: Engine verfolgt im Mittel ${fmt(mean(rs.map((r) => r.e.trackEnd)), 1)} s, Basislinie ${fmt(mean(rs.map((r) => r.b.trackEnd)), 1)} s (Faktor ${fmt(ratio, 1)}); ` +
				`Engine-Fehler Ø ${fmt(mean(rs.map((r) => r.e.meanErr)), 2)} / max ${fmt(Math.max(...rs.map((r) => r.e.maxErr)), 2)} Cent; ` +
				`Lücken ${rs.reduce((a, r) => a + r.e.gaps, 0)}; Oktavfehler Engine ${rs.reduce((a, r) => a + r.e.octave, 0)}, Basislinie ${rs.reduce((a, r) => a + r.b.octave, 0)} Abfragen.`,
		);
	}
	for (const g of ["Gitarre", "Bass", "Bariton", "8-Saiter"]) {
		const rs = results.filter((r) => r.group === g);
		if (!rs.length) continue;
		console.log(
			`Zeit bis zur ersten Anzeige ${padR(g, 8)}: Engine Ø ${fmt(mean(rs.map((r) => r.e.first * 1000)), 0)} ms (max ${fmt(Math.max(...rs.map((r) => r.e.first * 1000)), 0)}), Basislinie Ø ${fmt(mean(rs.map((r) => r.b.first * 1000)), 0)} ms`,
		);
	}

	// Rechenzeit: allein, ohne Worker, 48 kHz.
	const { TunerEngine } = loadTuner(dir);
	let audio = 0;
	let ns = 0n;
	for (const name of ["E2", "E4", "B0"]) {
		const st = notes.find((n) => n.name === name);
		const sig = S.pluck({ sampleRate: 48000, midi: st.midi, cents: 7, durationSec: 10, t60: st.t60, fundamentalDb: st.fundamentalDb, B: st.B, peakDb: -20, noiseDb: -100, seed: 5 });
		const eng = new TunerEngine(48000);
		const blk = 480;
		const a = process.hrtime.bigint();
		for (let i = 0; i < sig.signal.length; i += blk) {
			eng.push(sig.signal.subarray(i, i + blk));
			if ((i / blk) % 5 === 4) eng.reading();
		}
		ns += process.hrtime.bigint() - a;
		audio += 10;
	}
	console.log(`\nRechenzeit bei 48 kHz (E2, E4, B0 je 10 s, Blöcke 10 ms, Abfrage alle 50 ms): ${((Number(ns) / 1e9 / audio) * 100).toFixed(2)} % eines Kerns.`);
}

// --- Start ------------------------------------------------------------------------

if (!isMainThread) {
	parentPort.postMessage(runCase(workerData.case, workerData.dir));
} else if (flag("--synth")) {
	synth().catch((e) => {
		console.error(e);
		process.exit(1);
	});
} else {
	const file = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--") && !["--h", "--nur-anschlaege", "--schnell"].includes(all[i - 1])));
	if (!file) {
		console.log("Aufruf: node tools/tuner-eval.cjs <datei.wav> [--schritt 0.05] [--von s] [--bis s] [--kanal n] [--a4 Hz] [--h] [--nur-anschlaege] [--csv datei]\n        node tools/tuner-eval.cjs --synth [--schnell]");
		process.exit(1);
	}
	evalWav(file);
}
