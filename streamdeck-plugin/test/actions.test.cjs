/**
 * Aktionen mit echter Grafik und echter Session, das SDK als Attrappe
 * (fake-streamdeck.cjs): Bilder nur bei Änderung, gedrosselte Regler-Anzeige,
 * Spalte → Regler, Preset-Rahmen erst mit 0x21, Datenquelle für den Property
 * Inspector, Warnzeichen bei gesperrten Tasten, Stimmanzeige (Protokoll 4): Segmente,
 * Tuner-Taste, höchstens 10 Bilder je Sekunde, nur geänderte Segmente.
 *
 * Die Drossel läuft hier mit echter Uhr; die Tests warten dafür kurz.
 */
"use strict";

const path = require("node:path");
const { section, check, ok, hex } = require("./harness.cjs");
const sd = require("./fake-streamdeck.cjs");

const root = path.join(__dirname, "..");
const build = path.join(root, "test-output", "build");
const P = require(path.join(build, "midi", "protocol.js"));
const { Session } = require(path.join(build, "state", "session.js"));
const render = require(path.join(build, "render", "index.js"));
const { KnobAction, DISPLAY_INTERVAL_MS, TUNER_INTERVAL_MS } = require(path.join(build, "actions", "knob.js"));
const { PresetAction } = require(path.join(build, "actions", "preset.js"));
const { AmpAction } = require(path.join(build, "actions", "amp.js"));
const { TunerAction, TUNER_KEY_INTERVAL_MS } = require(path.join(build, "actions", "tuner.js"));
const { DelayAction } = require(path.join(build, "actions", "delay.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OK = { kind: "ok" };
/** Tuner-Taste mit der Steinberg-Quelle (Protokoll 4); der eigene Tuner hat eigene Tests. */
const SB = { source: "steinberg" };
const WAITING = { kind: "waiting" };

function fakeDial(id, column) {
	const d = {
		id,
		feedback: [],
		/** Zeitpunkt jedes setFeedback (Bildrate). */
		times: [],
		alerts: 0,
		coordinates: { column, row: 0 },
		isDial: () => true,
		isKey: () => false,
		setFeedback: async (payload) => {
			d.feedback.push(payload);
			d.times.push(Date.now());
		},
		showAlert: async () => {
			d.alerts++;
		},
	};
	return d;
}

function fakeKey(id) {
	const k = {
		id,
		images: [],
		times: [],
		alerts: 0,
		isDial: () => false,
		isKey: () => true,
		setImage: async (img) => {
			k.images.push(img);
			k.times.push(Date.now());
		},
		showAlert: async () => {
			k.alerts++;
		},
	};
	return k;
}

const N = {
	param: (p, v) => [0xf0, 0x7d, 0x20, p, v >> 7, v & 0x7f, ...P.encodeText(P.hostText(p, v)), 0xf7],
	preset: (name) => [0xf0, 0x7d, 0x21, ...P.encodeText(name), 0xf7],
	flags: (f) => [0xf0, 0x7d, 0x22, f, 0xf7],
};

module.exports = async function run() {
	render.initRenderer(path.join(root, "com.sorg.tone3000.sdPlugin"));

	let t = 0;
	const sent = [];
	const tasks = [];
	const s = new Session({ send: (b) => sent.push(b), now: () => t, useTimers: false, defer: (fn) => tasks.push(fn) });
	const flush = () => {
		while (tasks.length) tasks.shift()();
	};
	const feed = (frames) => {
		for (const f of frames) s.receive(f);
		flush();
	};
	const settle = async () => {
		flush();
		await sleep(DISPLAY_INTERVAL_MS + 20);
	};

	//==========================================================================
	section("Regler: Bild je Spalte, nur bei Änderung, gedrosselt");
	const knob = new KnobAction(s);
	const dials = [0, 1, 2, 3, 4].map((c) => fakeDial(`dial${c}`, c));
	for (const d of dials) knob.onWillAppear({ action: d, payload: { settings: {} } });
	check("beim Erscheinen sofort je ein Bild", dials.map((d) => d.feedback.length), [1, 1, 1, 1, 1]);
	ok("Bild über das ganze Segment: Feld canvas, PNG", dials.every((d) => typeof d.feedback[0].canvas === "string" && d.feedback[0].canvas.startsWith("data:image/png;base64,")));
	check("Spalte -> Regler, ohne Verbindung Warte", dials.slice(0, 4).map((d, i) => d.feedback[0].canvas === render.renderDial(P.PARAM_NAMES[i], 0.5, WAITING)), [true, true, true, true]);
	check("Spalte 4 nimmt Gain", dials[4].feedback[0].canvas === render.renderDial("gain", 0.5, WAITING), true);
	knob.onWillDisappear({ action: dials[4] });
	const n0 = sent.length;
	knob.onDialDown({ action: dials[0], payload: { settings: {} } });
	check("Druck ohne Verbindung: Warnzeichen, nichts gesendet", [dials[0].alerts, sent.length], [1, n0]);

	s.receive(P.buildPing()); // Pong: verbunden, Abfrage
	feed([N.param(0, 8192), N.param(1, 8192), N.param(2, 8192), N.param(3, 8192), N.flags(0x64)]);
	await settle();
	check("Antwort da: jedes Segment einmal neu gezeichnet", dials.slice(0, 4).map((d) => d.feedback.length), [2, 2, 2, 2]);
	check("Bild zeigt den Wert, Status ok", dials[1].feedback[1].canvas === render.renderDial("bass", 8192 / 16383, OK), true);
	check("verschwundener Regler bekommt nichts mehr", dials[4].feedback.length, 1);
	feed([N.param(0, 8192), N.flags(0x64)]);
	await settle();
	check("dieselben Werte noch einmal: kein neues Bild", dials.slice(0, 4).map((d) => d.feedback.length), [2, 2, 2, 2]);

	const before = sent.length;
	knob.onDialRotate({ action: dials[1], payload: { settings: {}, ticks: 3 } });
	check("Drehen an Spalte 1 (3 Rasten, schnell): 0x11 für Bass sofort", hex(sent[before]), hex(P.buildSetParam(1, P.to14(8192 / 16383 + 0.12))));
	await settle();
	check("nur das Bass-Segment neu", dials.slice(0, 4).map((d) => d.feedback.length), [2, 3, 2, 2]);
	for (let i = 0; i < 20; i++) {
		knob.onDialRotate({ action: dials[2], payload: { settings: {}, ticks: 1 } });
		flush();
	}
	const during = dials[2].feedback.length;
	await settle();
	ok("20 schnelle Schritte: höchstens ein Bild sofort, eins am Ende des Intervalls", during <= 3 && dials[2].feedback.length - 2 <= 2, `während ${during - 2}, gesamt ${dials[2].feedback.length - 2}`);
	check("letztes Bild zeigt den letzten Stand", dials[2].feedback[dials[2].feedback.length - 1].canvas === render.renderDial("mid", s.knob(2).value01, OK), true);
	check("20 Schritte = 20 × 0x11", sent.slice(before + 1).filter((b) => b[2] === P.MSG_SET_PARAM && b[3] === 2).length, 20);

	const treble = fakeDial("dialT", 5);
	knob.onWillAppear({ action: treble, payload: { settings: { param: "treble" } } });
	const n = sent.length;
	knob.onDialDown({ action: treble, payload: { settings: { param: "treble" } } });
	check("Setting treble (Spalte 5): Druck setzt Treble auf Mitte", hex(sent[n]), "F0 7D 11 03 40 00 F7");
	knob.onDidReceiveSettings({ action: treble, payload: { settings: { param: "" } } });
	const m = sent.length;
	knob.onDialDown({ action: treble, payload: { settings: { param: "" } } });
	check("Setting geleert: nach Position, fünfter Regler von links -> Gain", hex(sent[m]), "F0 7D 11 00 40 00 F7");
	await settle();
	check("die anderen Regler behalten ihren Platz", dials.slice(0, 4).map((d) => d.feedback[d.feedback.length - 1].canvas === render.renderDial(P.PARAM_NAMES[dials.indexOf(d)], s.knob(dials.indexOf(d)).value01, s.knob(dials.indexOf(d)).status)), [true, true, true, true]);

	//==========================================================================
	section("Regler auf den Spalten 1–4 (wie am Gerät: Micstacy links und rechts)");
	{
		const knob2 = new KnobAction(s);
		const row = [1, 2, 3, 4].map((c) => fakeDial(`dev${c}`, c));
		// Absichtlich von rechts nach links erscheinen lassen: Die Zuordnung darf
		// weder an der Spalte noch an der Reihenfolge des Erscheinens hängen.
		for (const d of row.slice().reverse()) knob2.onWillAppear({ action: d, payload: { settings: {} } });
		await settle();
		const last = (d) => d.feedback[d.feedback.length - 1].canvas;
		check("ohne Setting: von links Gain, Bass, Mid, Treble", row.map((d, i) => last(d) === render.renderDial(P.PARAM_NAMES[i], s.knob(i).value01, s.knob(i).status)), [true, true, true, true]);
		const nd = sent.length;
		knob2.onDialDown({ action: row[0], payload: { settings: {} } });
		check("Druck auf den linken (Spalte 1): Gain auf Mitte, nicht Bass", hex(sent[nd]), "F0 7D 11 00 40 00 F7");
		knob2.onDidReceiveSettings({ action: row[3], payload: { settings: { param: "gain" } } });
		const ne = sent.length;
		knob2.onDialDown({ action: row[3], payload: { settings: { param: "gain" } } });
		check("Setting schlägt die Position: rechter Regler mit Setting gain", hex(sent[ne]), "F0 7D 11 00 40 00 F7");
		for (const d of row) knob2.onWillDisappear({ action: d });
	}

	//==========================================================================
	section("Preset-Taste");
	const presetAction = new PresetAction(s);
	const k = fakeKey("preset1");
	presetAction.onWillAppear({ action: k, payload: { settings: { preset: "HMT" } } });
	flush();
	check("erscheint mit Bild (nicht aktiv)", k.images, [render.renderPresetKey("HMT", false, OK)]);
	const i = sent.length;
	presetAction.onKeyDown({ action: k, payload: { settings: { preset: "HMT" } } });
	flush();
	check("Druck: 0x12 HMT", hex(sent[i]), "F0 7D 12 34 38 34 44 35 34 F7");
	check("Rahmen nicht vorab", k.images.length, 1);
	feed([N.preset("HMT")]);
	check("0x21 HMT: Rahmen", k.images[k.images.length - 1], render.renderPresetKey("HMT", true, OK));
	const empty = fakeKey("preset2");
	presetAction.onWillAppear({ action: empty, payload: { settings: {} } });
	presetAction.onKeyDown({ action: empty, payload: { settings: {} } });
	check("ohne gewähltes Preset: Warnzeichen, nichts gesendet", [empty.alerts, sent.length], [1, i + 1]);
	check("ohne gewähltes Preset: abgedunkelter Platzhalter der Grafik", empty.images[empty.images.length - 1], render.renderPresetKey("", false, OK));
	ok("Platzhalter sieht nicht aus wie ein echtes Preset", empty.images[empty.images.length - 1] !== render.renderPresetKey("Preset wählen", false, OK));
	await presetAction.onSendToPlugin({ action: k, payload: { event: "getPresets" } });
	const pi = sd.toPropertyInspector[sd.toPropertyInspector.length - 1];
	ok("Datenquelle beantwortet: event getPresets, Gruppen mit label/value", pi && pi.event === "getPresets" && Array.isArray(pi.items) && pi.items.every((g) => typeof g.label === "string" && Array.isArray(g.children) && g.children.every((c) => typeof c.value === "string" && c.label === c.value)), JSON.stringify(pi).slice(0, 200));
	if (pi && pi.items.length > 0) console.log(`      Presets dieses Rechners: ${pi.items.map((g) => `${g.label}: ${g.children.map((c) => c.value).join(", ")}`).join(" | ")}`);
	await presetAction.onSendToPlugin({ action: k, payload: { event: "getSomethingElse" } });
	check("andere Anfragen bleiben unbeantwortet", sd.toPropertyInspector[sd.toPropertyInspector.length - 1], pi);

	//==========================================================================
	section("Umschalt-Tasten");
	const amp = new AmpAction(s);
	const tuner = new TunerAction(s);
	/** Kurzer Druck: Drücken und gleich wieder loslassen (die Tuner-Taste wirkt beim Loslassen). */
	const tap = (act, ev) => {
		act.onKeyDown(ev);
		act.onKeyUp(ev);
	};
	const delay = new DelayAction(s);
	const ka = fakeKey("amp");
	const kt = fakeKey("tuner");
	const kd = fakeKey("delay");
	const lastImage = (k) => k.images[k.images.length - 1];
	amp.onWillAppear({ action: ka, payload: { settings: {} } });
	tuner.onWillAppear({ action: kt, payload: { settings: SB } });
	delay.onWillAppear({ action: kd, payload: { settings: {} } });
	check("Bilder nach 0x22 0x64: alle aus", [ka.images[0], kt.images[0], kd.images[0]], [render.renderToggleKey("amp", false, OK), render.renderToggleKey("tuner", false, OK), render.renderToggleKey("delay", false, OK)]);
	let j = sent.length;
	amp.onKeyDown({ action: ka, payload: { settings: {} } });
	delay.onKeyDown({ action: kd, payload: { settings: {} } });
	check("Drücke: amp, delay", sent.slice(j).map(hex), ["92 04 7F", "92 02 00", "92 03 7F"]);
	feed([N.flags(0x7b)]); // amp, Tuner-Fenster, Mute, Delay aktiv und Fenster offen
	check("0x22: amp und delay leuchten", [lastImage(ka), lastImage(kd)], [render.renderToggleKey("amp", true, OK), render.renderToggleKey("delay", true, OK)]);
	await sleep(TUNER_KEY_INTERVAL_MS + 30);
	check("Tuner-Taste: Fenster-Bit und Kanal-Mute zählen nicht mehr (Lampe = Tuner-Modus)", lastImage(kt), render.renderToggleKey("tuner", false, OK));
	feed([N.flags(0x1b)]); // bit5 und bit6 weg
	j = sent.length;
	amp.onKeyDown({ action: ka, payload: { settings: {} } });
	tap(tuner, { action: kt, payload: { settings: SB } });
	check("bit5 = 0: gesperrt (Tuner: Einschalten), Warnzeichen, nichts gesendet", [ka.alerts, kt.alerts, sent.length - j], [1, 1, 0]);
	await sleep(TUNER_KEY_INTERVAL_MS + 30);
	check("Bild zeigt Kanal?", lastImage(kt), render.renderToggleKey("tuner", false, { kind: "error", text: "Kanal?" }));
	await settle();
	check("Regler-Bild mit Kanal?", dials[0].feedback[dials[0].feedback.length - 1].canvas, render.renderDial("gain", s.knob(0).value01, { kind: "error", text: "Kanal?" }));

	//==========================================================================
	section("Stimmanzeige: Leiste und Tuner-Taste (Protokoll 4)");
	const T = (flags, cent, oct, note) => [0xf0, 0x7d, 0x24, flags, cent + 64, oct + 64, ...P.encodeText(note), 0xf7];
	const lastCanvas = (d) => d.feedback[d.feedback.length - 1].canvas;
	const strip = dials.slice(0, 4);
	const wait = () => sleep(TUNER_INTERVAL_MS + 30);
	feed([N.flags(0x64)]);
	await wait();
	let n1 = sent.length;
	tap(tuner, { action: kt, payload: { settings: SB } });
	check("Tuner-Taste ohne openWindow: nur 0x13 01, kein Kanal-Mute", sent.slice(n1).map(hex), ["F0 7D 13 01 F7"]);
	flush();
	await wait();
	check("sofort im Modus, vor dem 0x24: Leiste und Taste „Warte…“", [strip.map((d, i) => lastCanvas(d) === render.renderTunerSegment(i, null, WAITING)), lastImage(kt) === render.renderTunerKey(null, WAITING)], [[true, true, true, true], true]);
	feed([T(0x1d, -16, 1, "E")]);
	await wait();
	let reading = s.tuner().reading;
	check("0x24 E1 -16: jedes Segment zeigt seinen Ausschnitt", strip.map((d, i) => lastCanvas(d) === render.renderTunerSegment(i, reading, OK)), [true, true, true, true]);
	check("Taste: Note in klarer Schrift", lastImage(kt) === render.renderTunerKey(reading, OK), true);
	n1 = sent.length;
	knob.onDialRotate({ action: dials[1], payload: { settings: {}, ticks: 2 } });
	knob.onDialDown({ action: dials[1], payload: { settings: {} } });
	check("Regler im Modus: Drehen und Drücken ohne Wirkung, kein Warnzeichen", [sent.length - n1, dials[1].alerts], [0, 0]);

	feed([T(0x1d, 5, 1, "E")]); // Nadel nach Mid (x = 428)
	await wait();
	const counts = () => strip.map((d) => d.feedback.length);
	const segBefore = counts();
	for (const c of [10, 15, 20, 25]) {
		feed([T(0x1d, c, 1, "E")]);
		await wait();
	}
	const segAfter = counts();
	check("Nadel wandert nur in Mid: Gain und Bass bekommen kein neues Bild", [segAfter[0] - segBefore[0], segAfter[1] - segBefore[1]], [0, 0]);
	check("Mid (Nadel) und Treble (Cent-Zahl) je Messung neu", [segAfter[2] - segBefore[2], segAfter[3] - segBefore[3]], [4, 4]);
	feed([T(0x1d, 25, 1, "E")]);
	await wait();
	check("dasselbe 0x24 noch einmal: kein Bild", counts(), segAfter);

	// Bildrate: eine Sekunde lang alle 10 ms ein 0x24, die Nadel quer über die Leiste
	const t0 = Date.now();
	const from = strip.map((d) => d.times.length);
	const keyFrom = kt.times.length;
	let cent = -50;
	while (Date.now() - t0 < 1000) {
		feed([T(cent === 0 ? 0x1f : 0x1d, cent, 1, cent > 0 ? "F" : "E")]);
		cent = cent >= 46 ? -50 : cent + 7;
		await sleep(10);
	}
	await wait();
	const rate = (times) => {
		const gaps = times.slice(1).map((x, i) => x - times[i]);
		return { n: times.length, minGap: gaps.length ? Math.min(...gaps) : Infinity };
	};
	const rates = strip.map((d, i) => rate(d.times.slice(from[i])));
	const keyRate = rate(kt.times.slice(keyFrom));
	console.log(`      Bilder je Segment in ${Date.now() - t0} ms: ${rates.map((r) => `${r.n} (Abstand ≥ ${r.minGap} ms)`).join(", ")}; Taste ${keyRate.n} (≥ ${keyRate.minGap} ms)`);
	ok("je Segment höchstens 10 Bilder je Sekunde (Abstand ≥ 95 ms, höchstens 12 in 1,13 s)", rates.every((r) => r.minGap >= 95 && r.n <= 12), JSON.stringify(rates));
	ok("Taste ebenso", keyRate.minGap >= 95 && keyRate.n <= 12, JSON.stringify(keyRate));
	ok("die Anzeige folgt trotzdem (jedes Segment mehrmals neu)", rates.every((r) => r.n >= 3), JSON.stringify(rates));
	reading = s.tuner().reading;
	check("am Ende zeigt die Leiste den letzten Stand", strip.map((d, i) => lastCanvas(d) === render.renderTunerSegment(i, reading, OK)), [true, true, true, true]);

	feed([T(0x04, 0, 0, "")]); // Tuner aus Slot 1 entfernt, Modus an
	await wait();
	reading = s.tuner().reading;
	check("bit3 = 0: Leiste mit Hinweis, Taste „Tuner?“", [strip.map((d, i) => lastCanvas(d) === render.renderTunerSegment(i, reading, OK)), lastImage(kt) === render.renderTunerKey(reading, OK), reading.found], [[true, true, true, true], true, false]);

	n1 = sent.length;
	tap(tuner, { action: kt, payload: { settings: { ...SB, openWindow: true } } });
	check("mit openWindow aus: 0x13 00 und Note 1 Vel 0, dann die Kette", sent.slice(n1).map(hex), ["F0 7D 13 00 F7", "92 01 00", "F0 7D 14 F7"]);
	flush();
	await sleep(DISPLAY_INTERVAL_MS + 20);
	check("Modus aus: Regler-Bilder sofort zurück", strip.map((d, i) => lastCanvas(d) === render.renderDial(P.PARAM_NAMES[i], s.knob(i).value01, s.knob(i).status)), [true, true, true, true]);
	feed([T(0x00, 0, 0, "")]);
	await wait();
	check("außerhalb des Modus ohne Tuner: Taste wie bisher, klein „Tuner?“", lastImage(kt), render.renderToggleKey("tuner", false, { kind: "error", text: "Tuner?" }));
	n1 = sent.length;
	tap(tuner, { action: kt, payload: { settings: { ...SB, openWindow: true } } });
	check("mit openWindow an: 0x13 01 und Note 1 Vel 127", sent.slice(n1).map(hex), ["F0 7D 13 01 F7", "92 01 7F"]);
	tap(tuner, { action: kt, payload: { settings: { ...SB, openWindow: "ja" } } });
	check("openWindow nur bei echtem true", sent.slice(n1 + 2).map(hex), ["F0 7D 13 00 F7", "F0 7D 14 F7"]);
	// Modus aus, aber die Mute des Tuners steht an (etwa im Projekt gespeichert, 5.5)
	n1 = sent.length;
	feed([T(0x18, -49, 0, "--")]);
	await wait();
	check("Mute ohne Modus: einmal 0x13 00, Taste „stumm“ in klarer Schrift", [sent.slice(n1).map(hex), lastImage(kt) === render.renderToggleKey("tuner", false, { kind: "error", text: "stumm" })], [["F0 7D 13 00 F7"], true]);
	feed([T(0x08, -49, 0, "--")]);
	await wait();
	check("Mute aufgehoben: Taste wie bisher, nichts weiter gesendet", [sent.slice(n1).map(hex), lastImage(kt) === render.renderToggleKey("tuner", false, OK)], [["F0 7D 13 00 F7"], true]);
	ok("nie Note 0 (Kanal-Mute) von der Tuner-Taste", !sent.some((b) => b[0] === 0x92 && b[1] === 0), sent.filter((b) => b[0] === 0x92).map(hex).join(" "));
	tuner.onWillDisappear({ action: kt });
	ok("keine Fehler im Log", !sd.logged.some((l) => l.startsWith("E ")), sd.logged.filter((l) => l.startsWith("E ")).join(" | "));
};
