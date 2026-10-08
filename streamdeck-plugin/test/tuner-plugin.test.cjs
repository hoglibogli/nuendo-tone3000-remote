/**
 * Eigener Tuner im Plugin: Eingangsnamen (Listenmodus), Abbildung einer Messung auf die
 * Stimmanzeige (auch „gehalten"), Quellen-Verwaltung des Audio-Kindprozesses mit
 * Attrappe (Start, Stopp, Absturz, Neustart, fehlender Eingang, Lebenszeichen),
 * Kanal-Mute-Regeln samt Merker nach Neustart, Tuner-Taste (Settings, Datenquelle,
 * Bilder), Bilder „gehalten" und „Eingang fehlt" nach test-output, und der echte
 * Worker als Kindprozess mit einer WAV-Datei statt Audiogerät.
 *
 * Kein Audiogerät, kein MIDI-Port: Der Worker läuft im WAV-Modus (Ersatzquelle), die
 * Session sendet in eine Liste.
 */
"use strict";

const path = require("node:path");
const { fork } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { section, check, ok, hex } = require("./harness.cjs");
const sd = require("./fake-streamdeck.cjs");
const S = require("./tuner-synth.cjs");

const root = path.join(__dirname, "..");
const build = path.join(root, "test-output", "build");
const outputDir = path.join(root, "test-output");
const P = require(path.join(build, "midi", "protocol.js"));
const I = require(path.join(build, "tuner", "inputs.js"));
const W = require(path.join(build, "tuner", "wire.js"));
const { TunerSource } = require(path.join(build, "tuner", "source.js"));
const { Session } = require(path.join(build, "state", "session.js"));
const RECORDING = path.join(root, "..", "aufnahmen", "saiten-1.wav");
const WORKER = path.join(build, "tuner", "worker.js");

const status = (s) => (s.kind === "error" ? s.text : s.kind);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Uhr und Wecker von Hand. */
function fakeClock() {
	let now = 0;
	let seq = 0;
	const timers = new Map();
	return {
		now: () => now,
		timers: {
			setTimeout: (fn, ms) => {
				const id = ++seq;
				timers.set(id, { at: now + ms, fn });
				return id;
			},
			clearTimeout: (id) => timers.delete(id),
		},
		advance(ms) {
			const until = now + ms;
			for (;;) {
				let next = null;
				for (const [id, t] of timers) if (t.at <= until && (next === null || t.at < next[1].at)) next = [id, t];
				if (next === null) break;
				timers.delete(next[0]);
				now = next[1].at;
				next[1].fn();
			}
			now = until;
		},
		pending: () => timers.size,
	};
}

/** Kindprozess-Attrappe: merkt sich Auftrag, gesendete Nachrichten, kill. */
function fakeSpawner() {
	const children = [];
	const spawn = (config) => {
		const handlers = { message: [], exit: [], error: [] };
		const c = {
			config,
			sent: [],
			killed: 0,
			exited: false,
			send: (m) => c.sent.push(m),
			kill: () => {
				c.killed++;
				c.exit(null, "SIGTERM");
			},
			on: (ev, fn) => handlers[ev].push(fn),
			/** Nachricht des Workers ans Plugin. */
			emit: (m) => handlers.message.forEach((fn) => fn(m)),
			exit: (code = 0, signal = null) => {
				if (c.exited) return;
				c.exited = true;
				handlers.exit.forEach((fn) => fn(code, signal));
			},
		};
		children.push(c);
		return c;
	};
	return { spawn, children, last: () => children[children.length - 1] };
}

/** Port-Attrappe für die Session (statt TunerSource). */
function fakePort() {
	const p = { starts: [], stops: 0, listeners: [] };
	p.start = (config) => p.starts.push({ ...config });
	p.stop = () => p.stops++;
	p.listen = (fn) => p.listeners.push(fn);
	p.emit = (ev) => p.listeners.forEach((fn) => fn(ev));
	return p;
}

const N = {
	flags: (f) => [0xf0, 0x7d, 0x22, f, 0xf7],
	tuner: (flags, cent, oct, note) => [0xf0, 0x7d, 0x24, flags, cent + 64, oct + 64, ...P.encodeText(note), 0xf7],
};
const OWN = { source: "own", muteChannel: true, input: { device: "MADI (5+6)", channel: 1 }, a4: 440 };
const MUTE_ON = "92 00 7F";
const MUTE_OFF = "92 00 00";
/** Kette sicherstellen (Protokoll 5): geht beim Verlassen des Modus mit, wenn Verbindung und bit5 da sind. */
const CHAIN = "F0 7D 14 F7";

/** Session mit Uhr von Hand, Port-Attrappe und Merker-Protokoll. */
function env(tuner = OWN, sessionOptions = {}) {
	let t = 0;
	const sent = [];
	const tasks = [];
	const markers = [];
	let pongDue = false;
	const port = fakePort();
	const e = { sent, markers, port, alive: true };
	e.s = new Session({
		send: (b) => {
			sent.push(b);
			if (b.length === 4 && b[2] === P.MSG_PING) pongDue = true;
		},
		now: () => t,
		useTimers: false,
		defer: (fn) => tasks.push(fn),
		ownTuner: port,
		onChannelMuteMarker: (on) => markers.push(on),
		...sessionOptions,
	});
	e.flush = () => {
		while (tasks.length) tasks.shift()();
	};
	e.s.configureTuner(tuner);
	e.flush();
	e.step = (ms) => {
		t = ms;
		e.s.tick();
		if (pongDue && e.alive) e.s.receive([0xf0, 0x7d, 0x01, 0xf7]);
		pongDue = false;
		e.flush();
	};
	e.feed = (frames) => {
		for (const f of frames) e.s.receive(f);
		e.flush();
	};
	/** Gesendetes seit Index i, ohne Pings, als Hex. */
	e.since = (i) => sent.slice(i).filter((b) => !(b.length === 4 && b[2] === P.MSG_PING)).map(hex);
	e.press = () => {
		const i = sent.length;
		const done = e.s.pressTuner(false);
		e.flush();
		return done ? e.since(i) : null;
	};
	return e;
}

/** Verbunden, 0x22 mit flags. */
function connected(flags = 0x64, tuner = OWN) {
	const e = env(tuner);
	e.step(0);
	e.feed([N.flags(flags)]);
	return e;
}

module.exports = async function run() {
	//==========================================================================
	section("Eigener Tuner: Eingänge als Mono-Kanäle (Listenmodus)");
	{
		check("MADI (5+6) (RME MADIface Pro)", I.channelLabels("MADI (5+6) (RME MADIface Pro)", 2), ["MADI 5", "MADI 6"]);
		check("Analog (1+2) (RME MADIface Pro)", I.channelLabels("Analog (1+2) (RME MADIface Pro)", 2), ["Analog 1", "Analog 2"]);
		check("MADI (61+62) zweistellig", I.channelLabels("MADI (61+62) (RME MADIface Pro)", 2), ["MADI 61", "MADI 62"]);
		check("ohne Paar: Gerätename – Kanal n", I.channelLabels("Mikrofon (Realtek High Definition Audio)", 2), ["Mikrofon (Realtek High Definition Audio) – Kanal 1", "Mikrofon (Realtek High Definition Audio) – Kanal 2"]);
		check("„Eingang (RME MADIface Pro)“ hat kein Paar", I.channelLabels("Eingang (RME MADIface Pro)", 1), ["Eingang (RME MADIface Pro) – Kanal 1"]);
		check("mehr Kanäle als das Paar: der Rest nummeriert", I.channelLabels("ADAT (3+4) (X)", 3), ["ADAT 3", "ADAT 4", "ADAT (3+4) (X) – Kanal 3"]);
		check("Vorgabe MADI (5+6), Kanal 2 = MADI 6", [I.DEFAULT_INPUT, I.inputLabel(I.DEFAULT_INPUT)], [{ device: "MADI (5+6)", channel: 1 }, "MADI 6"]);
		const devices = [
			{ name: "Lautsprecher (Realtek)", inputChannels: 0 },
			{ name: "MADI (61+62) (RME MADIface Pro)", inputChannels: 2 },
			{ name: "MADI (5+6) (RME MADIface Pro)", inputChannels: 2 },
		];
		check("Liste: nur Geräte mit Eingängen, Kennung = Gerätename + Kanalindex", I.listChannels(devices).map((x) => `${x.device}|${x.channel}|${x.label}`), [
			"MADI (61+62) (RME MADIface Pro)|0|MADI 61",
			"MADI (61+62) (RME MADIface Pro)|1|MADI 62",
			"MADI (5+6) (RME MADIface Pro)|0|MADI 5",
			"MADI (5+6) (RME MADIface Pro)|1|MADI 6",
		]);
		check("Gerät per Namen: exakt", I.findDevice(devices, "MADI (5+6) (RME MADIface Pro)")?.name, "MADI (5+6) (RME MADIface Pro)");
		check("Gerät per Namen: Teil ohne Groß/klein (Vorgabe trifft nicht MADI (61+62))", I.findDevice(devices, "madi (5+6)")?.name, "MADI (5+6) (RME MADIface Pro)");
		check("fehlt / nur Ausgang: keins", [I.findDevice(devices, "Analog (1+2)"), I.findDevice(devices, "Lautsprecher")], [null, null]);
		const v = I.inputValue({ device: "MADI (5+6) (RME MADIface Pro)", channel: 1 });
		check("Setting als JSON-Text (Auswahl im Property Inspector) und als Objekt", [I.parseInputSetting(v), I.parseInputSetting({ device: "Analog (1+2)", channel: 0 })], [{ device: "MADI (5+6) (RME MADIface Pro)", channel: 1 }, { device: "Analog (1+2)", channel: 0 }]);
		check("kaputt oder leer: Vorgabe", [I.parseInputSetting(undefined), I.parseInputSetting("{"), I.parseInputSetting({ device: "", channel: 1 }), I.parseInputSetting({ device: "X", channel: -1 })], [I.DEFAULT_INPUT, I.DEFAULT_INPUT, I.DEFAULT_INPUT, I.DEFAULT_INPUT]);
	}

	//==========================================================================
	section("Eigener Tuner: Messung → Stimmanzeige");
	{
		const r = (note, octave, cents, state) => ({ note, octave, cents, state, level: -40, t: 1 });
		check("Stille", W.ownTunerState(r("--", 0, 0, "silent")), { note: "--", octave: 0, cent: 0, locked: false, inTune: false, found: true, held: false });
		check("E2 -16,4: Cent gerundet, nicht gestimmt", W.ownTunerState(r("E", 2, -16.4, "tracking")), { note: "E", octave: 2, cent: -16, locked: true, inTune: false, found: true, held: false });
		check("+2,4 → 2: gestimmt (|Cent| ≤ IN_TUNE_CENTS = 2)", [W.ownTunerState(r("B", 3, 2.4, "tracking")).inTune, W.ownTunerState(r("B", 3, -2.4, "tracking")).cent], [true, -2]);
		check("+2,6 → 3: nicht gestimmt", W.ownTunerState(r("B", 3, 2.6, "tracking")).inTune, false);
		check("gehalten: held, Note bleibt", W.ownTunerState(r("G", 3, -4.2, "held")), { note: "G", octave: 3, cent: -4, locked: true, inTune: false, found: true, held: true });
		check("Cent begrenzt", W.ownTunerState(r("A", 2, 61, "tracking")).cent, 50);
		check("Notennamen englisch (B, nicht H)", W.ownTunerState(r("B", 1, 0, "tracking")).note, "B");
	}

	//==========================================================================
	section("Quellen-Verwaltung: Start, Stopp, Neustart (Attrappe)");
	{
		const clock = fakeClock();
		const sp = fakeSpawner();
		const events = [];
		const logs = [];
		const src = new TunerSource({ spawn: sp.spawn, timers: clock.timers, now: clock.now, log: (l) => logs.push(l) });
		src.listen((ev) => events.push(ev));
		const lastStatus = () => [...events].reverse().find((e) => e.type === "status")?.status;
		const cfg = { device: "MADI (5+6)", channel: 1, a4: 440 };
		src.start(cfg);
		check("Start: ein Worker mit Auftrag audio, Gerät per Namen, Kanal 1 (MADI 6)", [sp.children.length, sp.last().config], [1, { mode: "audio", device: "MADI (5+6)", channel: 1, a4: 440 }]);
		check("Zustand: startet", lastStatus(), { kind: "starting" });
		sp.last().emit({ type: "ready", device: "MADI (5+6) (RME MADIface Pro)", channel: 1, rate: 48000 });
		check("ready: läuft", lastStatus(), { kind: "running", rate: 48000 });
		sp.last().emit({ type: "reading", reading: { note: "E", octave: 2, cents: -1.2, state: "tracking", level: -40, t: 1 } });
		check("Messung wird weitergereicht", events[events.length - 1], { type: "reading", reading: { note: "E", octave: 2, cents: -1.2, state: "tracking", level: -40, t: 1 } });
		src.start({ ...cfg });
		check("derselbe Auftrag noch einmal: kein neuer Worker", sp.children.length, 1);
		for (let k = 0; k < 8; k++) {
			clock.advance(1000);
			sp.last().emit({ type: "alive" });
		}
		check("Lebenszeichen halten ihn am Leben", [sp.children[0].killed, sp.children.length], [0, 1]);

		src.start({ ...cfg, a4: 442 });
		check("anderer Auftrag (Kammerton): alter bekommt „stop“, neuer startet", [sp.children[0].sent, sp.children.length, sp.last().config.a4], [[{ type: "stop" }], 2, 442]);
		clock.advance(1000);
		check("alter nach 1 s hart beendet", sp.children[0].killed, 1);

		// Absturz: unerwartetes Ende -> nach 1 s neu, höchstens 3-mal in 60 s
		sp.last().emit({ type: "ready", device: "MADI", channel: 1, rate: 48000 });
		sp.last().exit(3);
		check("Absturz: startet nach 1 s neu", [lastStatus().kind, sp.children.length], ["starting", 2]);
		clock.advance(1000);
		check("neuer Worker", sp.children.length, 3);
		sp.last().exit(1);
		clock.advance(1000);
		sp.last().exit(1);
		clock.advance(1000);
		check("dritter Neustart", sp.children.length, 5);
		sp.last().exit(1);
		clock.advance(5000);
		check("vierter Absturz in 60 s: kein Neustart mehr, Fehler", [sp.children.length, lastStatus()], [5, { kind: "error", code: "failed", text: "Eigener Tuner: Tuner-Fehler", key: "Fehler" }]);
		src.start({ ...cfg, a4: 442 });
		check("erneutes start() (Taste aus und an): neuer Versuch", sp.children.length, 6);

		// Lebenszeichen bleiben aus
		sp.last().emit({ type: "ready", device: "MADI", channel: 1, rate: 48000 });
		clock.advance(5000);
		check("5 s ohne Nachricht: Worker wird beendet und neu gestartet", [sp.children[5].killed, lastStatus().kind], [1, "starting"]);
		clock.advance(1000);
		check("…neu gestartet", sp.children.length, 7);

		src.stop();
		check("Stopp: „stop“ an den Worker", sp.last().sent, [{ type: "stop" }]);
		sp.last().exit(0);
		clock.advance(10000);
		check("gewolltes Ende: kein Neustart", sp.children.length, 7);
		ok("Protokoll nennt Absturz und Neustart", logs.some((l) => /Worker beendet/.test(l)), logs.slice(-3).join(" | "));
	}

	//==========================================================================
	section("Quellen-Verwaltung: Eingang fehlt, Start scheitert, Liste");
	{
		const clock = fakeClock();
		const sp = fakeSpawner();
		const events = [];
		const src = new TunerSource({ spawn: sp.spawn, timers: clock.timers, now: clock.now });
		src.listen((ev) => events.push(ev));
		const lastStatus = () => [...events].reverse().find((e) => e.type === "status")?.status;
		src.start({ device: "MADI (5+6)", channel: 1, a4: 440 });
		sp.last().emit({ type: "error", code: "missing-input", text: "Eingang MADI 6 fehlt (kein Gerät „MADI (5+6)“)" });
		sp.last().exit(2);
		check("fehlender Eingang: Leiste „Eingang MADI 6 fehlt“, Taste „Eingang?“", lastStatus(), { kind: "error", code: "missing-input", text: "Eingang MADI 6 fehlt", key: "Eingang?" });
		clock.advance(4900);
		check("vor 5 s kein neuer Versuch", sp.children.length, 1);
		clock.advance(100);
		check("nach 5 s neuer Versuch, Fehler bleibt sichtbar", [sp.children.length, lastStatus().kind], [2, "error"]);
		for (let k = 0; k < 6; k++) {
			sp.last().emit({ type: "error", code: "missing-input", text: "fehlt" });
			sp.last().exit(2);
			clock.advance(5000);
		}
		check("fehlender Eingang zählt nicht als Absturz: es wird weiter versucht", sp.children.length, 8);
		sp.last().emit({ type: "ready", device: "MADI (5+6) (RME MADIface Pro)", channel: 1, rate: 44100 });
		check("RME wieder an: läuft", lastStatus().kind, "running");
		src.stop();

		const bad = new TunerSource({
			spawn: () => {
				throw new Error("spawn EINVAL");
			},
			timers: clock.timers,
			now: clock.now,
		});
		let st = null;
		bad.listen((ev) => ev.type === "status" && (st = ev.status));
		let threw = false;
		try {
			bad.start({ device: "X", channel: 0, a4: 440 });
			for (let k = 0; k < 5; k++) clock.advance(1000);
		} catch {
			threw = true;
		}
		check("Start scheitert: keine Ausnahme ins Plugin, nach Versuchen Fehler", [threw, st && st.kind], [false, "error"]);

		const sp2 = fakeSpawner();
		const lister = new TunerSource({ spawn: sp2.spawn, timers: clock.timers, now: clock.now });
		const pending = lister.listInputs();
		check("Liste: eigener Worker im Listenmodus", sp2.last().config, { mode: "list" });
		const items = [{ device: "MADI (5+6) (RME MADIface Pro)", channel: 1, label: "MADI 6" }];
		sp2.last().emit({ type: "inputs", items });
		check("Liste kommt an", await pending, items);
		const silent = lister.listInputs();
		clock.advance(8000);
		check("Liste ohne Antwort: nach 8 s leer, Worker beendet", [await silent, sp2.last().killed], [[], 1]);
	}

	//==========================================================================
	section("Eigener Tuner in der Session: Modus, Anzeige, kein 0x13 01");
	{
		const e = connected(0x64);
		const i = e.sent.length;
		check("Druck: kein 0x13, Input 6 nicht stumm → Note 0 Vel 127", e.press(), [MUTE_ON]);
		check("Kindprozess gestartet mit Eingang und Kammerton", e.port.starts, [{ device: "MADI (5+6)", channel: 1, a4: 440 }]);
		check("Merker gesetzt und gemeldet", [e.s.store.channelMuted, e.markers], [true, [true]]);
		let v = e.s.tuner();
		check("sofort im Modus, Leiste und Taste warten", [v.active, v.reading, status(v.status), status(v.keyStatus)], [true, null, "waiting", "waiting"]);
		ok("nie 0x13 01", !e.sent.slice(i).some((b) => b[0] === 0xf0 && b[2] === P.MSG_TUNER_MODE && b[3] === 1));
		e.port.emit({ type: "status", status: { kind: "running", rate: 48000 } });
		e.port.emit({ type: "reading", reading: { note: "E", octave: 2, cents: -16.2, state: "tracking", level: -40, t: 1 } });
		e.flush();
		v = e.s.tuner();
		check("Messung: E2 -16, läuft", [v.reading, status(v.status)], [{ note: "E", octave: 2, cent: -16, locked: true, inTune: false, found: true, held: false }, "ok"]);
		e.port.emit({ type: "reading", reading: { note: "E", octave: 2, cents: -15.6, state: "held", level: -90, t: 9 } });
		e.flush();
		check("gehalten", [e.s.tuner().reading.held, e.s.tuner().reading.cent], [true, -16]);
		check("Regler im Modus gesperrt", [e.s.turn(1, 1), e.s.center(0)], [false, false]);
		e.port.emit({ type: "status", status: { kind: "error", code: "missing-input", text: "Eingang MADI 6 fehlt", key: "Eingang?" } });
		e.flush();
		v = e.s.tuner();
		check("Eingang fehlt: Leiste und Taste verschieden", [status(v.status), status(v.keyStatus)], ["Eingang MADI 6 fehlt", "Eingang?"]);
		e.feed([N.tuner(0x08, -49, 0, "--")]);
		check("0x24 der Abfrage ändert den Modus des Decks nicht", e.s.tunerActive(), true);
		check("zweiter Druck: Note 0 Vel 0, Kindprozess gestoppt, Merker weg", [e.press(), e.port.stops, e.s.store.channelMuted, e.markers], [[MUTE_OFF, CHAIN], 1, false, [true, false]]);
		e.port.emit({ type: "reading", reading: { note: "A", octave: 2, cents: 0, state: "tracking", level: -40, t: 2 } });
		e.flush();
		check("Nachzügler nach dem Stopp: kein Einfluss", e.s.tuner().active, false);
	}
	{
		const e = env();
		check("ohne Nuendo: Modus geht trotzdem an, nichts gesendet", [e.press(), e.s.tunerActive(), e.port.starts.length], [[], true, 1]);
		e.step(0);
		check("Pong im eigenen Modus: 0x13 00 (Steinbergs Modus bleibt aus), dann Abfrage", e.since(0), ["F0 7D 13 00 F7", "F0 7D 10 F7"]);
		const i = e.sent.length;
		e.feed([N.flags(0x64)]);
		check("erstes 0x22 (Input 6 nicht stumm): Mute nachgeholt", e.since(i), [MUTE_ON]);
		e.feed([N.flags(0x65)]);
		check("0x22 bestätigt: nichts weiter", e.since(i), [MUTE_ON]);
		e.press();
		check("aus: Mute aufgehoben, Kette", e.since(i), [MUTE_ON, MUTE_OFF, CHAIN]);
	}
	{
		const e = connected(0x65); // Input 6 schon stumm (etwa: Projekt mit laufendem Tuner gespeichert)
		check("Input 6 schon stumm: Einschalten sendet nichts, kein Merker", [e.press(), e.s.store.channelMuted], [[], false]);
		check("Ausschalten entmutet IMMER, auch eine Mute, die die Taste nicht gesetzt hat", e.press(), [MUTE_OFF, CHAIN]);
	}
	{
		const e = connected(0x64); // Input 6 nicht stumm
		e.press();
		e.press();
		const n = e.sent.length;
		e.press();
		e.feed([N.flags(0x64)]);
		check("an, aus, an: wieder gemutet", e.since(n).includes(MUTE_ON), true);
		const m = e.sent.length;
		e.press();
		check("aus: entmutet", e.since(m), [MUTE_OFF, CHAIN]);
	}
	{
		// Ohne Option fasst die Taste den Mute nie an, auch beim Ausschalten nicht.
		const e = connected(0x65);
		e.s.store.muteChannel = false;
		check("Option aus, Input 6 stumm: an und aus senden keine Note (aus nur die Kette)", [e.press(), e.press()], [[], [CHAIN]]);
	}
	{
		const e = connected(0x44); // bit5 = 0: Platz 6 heißt anders
		check("bit5 = 0: keine Note (wirkte auf einen fremden Kanal)", e.press(), []);
		const i = e.sent.length;
		e.feed([N.flags(0x64)]);
		check("bit5 wieder da, noch im Modus: Mute nachgeholt (dazu die Abfrage wegen bit5)", e.since(i), [MUTE_ON, "F0 7D 10 F7"]);
		check("aus", e.press(), [MUTE_OFF, CHAIN]);
	}
	{
		const e = connected(0x64, { ...OWN, muteChannel: false });
		check("ohne „Input 6 stummschalten“: keine Note (aus nur die Kette)", [e.press(), e.press()], [[], [CHAIN]]);
		const f = connected(0x64);
		f.press();
		const i = f.sent.length;
		f.s.configureTuner({ ...OWN, muteChannel: false });
		f.flush();
		check("Haken im Modus entfernt: Mute sofort aufgehoben", [f.since(i), f.s.tunerActive()], [[MUTE_OFF], true]);
		const j = f.sent.length;
		f.s.configureTuner(OWN);
		f.flush();
		check("Haken im Modus wieder gesetzt: jetzt stumm", f.since(j), [MUTE_ON]);
		check("aus: aufgehoben", f.press(), [MUTE_OFF, CHAIN]);
	}
	{
		// Schnell an und aus, bevor das 0x22 die Mute bestätigt
		const e = connected(0x64);
		check("an und sofort aus (0x22 noch alt): trotzdem aufgehoben", [e.press(), e.press()], [[MUTE_ON], [MUTE_OFF, CHAIN]]);
	}

	//==========================================================================
	section("Kanal-Mute: Verbindung weg, Merker nach Neustart");
	{
		const e = connected(0x64);
		e.press();
		e.alive = false;
		for (let t = 250; t <= 9000 && e.s.connected; t += 250) e.step(t);
		check("Verbindung weg", e.s.connected, false);
		const i = e.sent.length;
		check("aus ohne Verbindung: nichts gesendet, Merker bleibt", [e.press(), e.s.store.channelMuted], [[], true]);
		e.alive = true;
		e.step(10000);
		e.feed([N.flags(0x65)]);
		check("wieder verbunden, Input 6 noch stumm: einmal aufgehoben, Merker weg", [e.since(i), e.s.store.channelMuted, e.markers], [["F0 7D 13 00 F7", "F0 7D 10 F7", MUTE_OFF], false, [true, false]]);
		const j = e.sent.length;
		e.feed([N.flags(0x65)]);
		check("weiteres 0x22: nichts mehr", e.since(j), []);
	}
	{
		// Plugin neu gestartet, während die Taste gemutet hatte: Merker aus den globalen Einstellungen
		const e = env();
		e.s.restoreChannelMute(true);
		check("Merker geladen (meldet ihn wieder)", [e.s.store.channelMuted, e.markers], [true, [true]]);
		e.step(0);
		const i = e.sent.length;
		e.feed([N.flags(0x65)]);
		check("erstes 0x22, Input 6 stumm: genau einmal Note 0 Vel 0", e.since(i), [MUTE_OFF]);
		e.feed([N.flags(0x64), N.flags(0x65)]);
		check("danach nie wieder (auch wenn jemand von Hand mutet)", e.since(i), [MUTE_OFF]);
		check("Merker gelöscht", [e.s.store.channelMuted, e.markers], [false, [true, false]]);

		const f = env();
		f.s.restoreChannelMute(true);
		f.step(0);
		const j = f.sent.length;
		f.feed([N.flags(0x64)]);
		check("Merker, aber Input 6 nicht mehr stumm: nichts senden, Merker löschen", [f.since(j), f.s.store.channelMuted], [[], false]);

		const g = connected(0x64);
		g.press();
		g.s.restoreChannelMute(true); // spätes Laden: in diesem Lauf schon selbst gemutet
		check("Merker zählt nicht, wenn die Taste in diesem Lauf schon gemutet hat", g.press(), [MUTE_OFF, CHAIN]);
	}

	//==========================================================================
	section("Quelle wechseln, Steinbergs Tuner beim eigenen aus");
	{
		const e = connected(0x64);
		e.press();
		const i = e.sent.length;
		e.s.configureTuner({ ...OWN, source: "steinberg" });
		e.flush();
		check("Wechsel zu Steinberg im Modus: Modus endet, Mute aufgehoben, Kindprozess gestoppt", [e.s.tunerActive(), e.since(i), e.port.stops], [false, [MUTE_OFF], 1]);
		check("Steinberg-Druck: 0x13 01, keine Kanal-Mute", e.press(), ["F0 7D 13 01 F7"]);
		e.feed([N.tuner(0x0c, 0, 0, "--")]);
		const j = e.sent.length;
		e.s.configureTuner(OWN);
		e.flush();
		check("zurück zum eigenen im Modus: 0x13 00, Modus aus", [e.since(j), e.s.tunerActive()], [["F0 7D 13 00 F7"], false]);
		const k = e.sent.length;
		e.feed([N.tuner(0x1c, 0, 0, "--")]);
		check("0x24 meldet Steinbergs Modus noch an: schon mit dem Wechsel aufgehoben, keine Schleife", e.since(k), []);
		e.feed([N.tuner(0x1c, 1, 0, "--")]);
		check("hält an: nichts weiter", e.since(k), []);
		e.feed([N.tuner(0x08, 0, 0, "--"), N.tuner(0x18, 0, 0, "--")]);
		check("Steinbergs Tuner neu stumm ohne Modus: einmal 0x13 00", e.since(k), ["F0 7D 13 00 F7"]);
		const m = e.sent.length;
		e.feed([N.tuner(0x1c, 0, 0, "--")]);
		check("Steinbergs Modus an (beim eigenen Tuner): das ist schon derselbe Zustand, keine Schleife", e.since(m), []);
		check("Taste außerhalb des Modus beim eigenen: kein Hinweis", status(e.s.toggleView("tuner").status), "ok");
	}

	//==========================================================================
	section("Kette (Protokoll 5): Delay und TONE3000 beim Verlassen des Modus sicherstellen");
	{
		check("0x14 kodieren", hex(P.buildChain()), CHAIN);
		check("0x25 lesen", P.parseFrame([0xf0, 0x7d, 0x25, 1, 0, 0xf7]), { type: "chain", delay: 1, amp: 0 });
		check("0x25 kaputt: falsche Länge, Code über 7", [P.parseFrame([0xf0, 0x7d, 0x25, 1, 0xf7]), P.parseFrame([0xf0, 0x7d, 0x25, 1, 0, 0, 0xf7]), P.parseFrame([0xf0, 0x7d, 0x25, 8, 0, 0xf7])], [null, null, null]);
		check("Log: beide Richtungen", [P.describeMessage(P.buildChain()), P.describeMessage([0xf0, 0x7d, 0x25, 1, 2, 0xf7])], ["KETTE", "KETTE Delay geladen, TONE3000 nicht in der Plugin-Liste"]);

		const saved = [];
		const results = [];
		const e = env(OWN, { onLastPreset: (name) => saved.push(name) });
		e.s.onChainResult((r) => results.push(r));
		e.step(0);
		e.feed([N.flags(0x64)]);
		const preset = (name) => [0xf0, 0x7d, 0x21, ...P.encodeText(name), 0xf7];
		const chain = (d, a) => [0xf0, 0x7d, 0x25, d, a, 0xf7];
		e.feed([preset("HMT"), preset("HMT")]);
		check("0x21: zuletzt aktives Preset gemerkt und einmal gemeldet", [e.s.store.lastPreset, saved], ["HMT", ["HMT"]]);
		check("Modus an: keine Kette", e.press(), [MUTE_ON]);
		check("Modus aus: Mute auf, dann die Kette", e.press(), [MUTE_OFF, CHAIN]);
		e.step(1000);
		e.feed([preset("Calfinornia")]);
		check("frisches TONE3000 meldet Programm 0 vor dem 0x25: nicht gemerkt", [e.s.store.lastPreset, saved], ["HMT", ["HMT"]]);
		let i = e.sent.length;
		e.feed([chain(1, 1)]);
		check("0x25 geladen/geladen: zuletzt aktives Preset zurückholen, dann abfragen", e.since(i), ["F0 7D 12 " + hex(P.encodeText("HMT")) + " F7", "F0 7D 10 F7"]);
		check("Ergebnis an die Tuner-Taste", results, [{ type: "chain", delay: 1, amp: 1 }]);
		e.step(2000);
		e.feed([preset("Calfinornia")]);
		check("späte Meldung des frischen Plugins (binnen 3 s): nicht gemerkt", e.s.store.lastPreset, "HMT");
		e.feed([preset("HMT")]);
		e.step(4500);
		e.feed([preset("Kalt")]);
		check("nach der Sperre zählt jedes 0x21 wieder", [e.s.store.lastPreset, saved], ["Kalt", ["HMT", "Kalt"]]);

		e.press();
		e.press();
		e.step(5000);
		i = e.sent.length;
		e.feed([chain(0, 0)]);
		check("0x25 war da/war da: kein 0x12, nur abfragen", e.since(i), ["F0 7D 10 F7"]);
		e.feed([preset("Clean")]);
		check("Sperre endet mit dem 0x25", e.s.store.lastPreset, "Clean");

		e.press();
		e.press();
		e.step(6000);
		e.feed([preset("Calfinornia")]);
		check("kein 0x25 (Script ohne Protokoll 5): gesperrt …", e.s.store.lastPreset, "Clean");
		e.step(6000 + 15100);
		e.feed([preset("Calfinornia")]);
		check("… aber höchstens 15 s", e.s.store.lastPreset, "Calfinornia");

		const f = env(OWN);
		check("ohne Verbindung: Modus an und aus ohne Kette", [f.press(), f.press()], [[], []]);
		const g = connected(0x44);
		check("bit5 = 0 (Deck-Kanal heißt anders): keine Kette", [g.press(), g.press()], [[], []]);
		const h = connected(0x64, { ...OWN, source: "steinberg" });
		h.press();
		check("Steinberg-Quelle: 0x13 00, dann die Kette", h.press(), ["F0 7D 13 00 F7", CHAIN]);

		const r = env(OWN);
		r.s.restoreLastPreset("Plexi");
		r.step(0);
		r.feed([N.flags(0x64)]);
		r.press();
		r.press();
		i = r.sent.length;
		r.feed([chain(1, 1)]);
		check("Preset aus den globalen Einstellungen: nach dem Neustart zurückgeholt", r.since(i)[0], "F0 7D 12 " + hex(P.encodeText("Plexi")) + " F7");
		const q = connected(0x64);
		q.press();
		q.press();
		i = q.sent.length;
		q.feed([chain(1, 1)]);
		check("nie ein Preset bekannt: kein 0x12", q.since(i), ["F0 7D 10 F7"]);
		i = r.sent.length;
		r.feed([chain(2, 1)]);
		check("0x25 ohne vorheriges 0x14: kein Preset zurückholen (Auftrag schon beantwortet)", r.since(i).filter((x) => x.startsWith("F0 7D 12")), []);
	}

	//==========================================================================
	section("Tuner-Taste: Settings, Datenquelle, Bilder");
	{
		const render = require(path.join(build, "render", "index.js"));
		render.initRenderer(path.join(root, "com.sorg.tone3000.sdPlugin"));
		const A = require(path.join(build, "actions", "tuner.js"));
		check("Vorgaben: eigener Tuner, Mute an, MADI 6, 440 Hz", A.tunerSettingsOf({}), { source: "own", muteChannel: true, input: { device: "MADI (5+6)", channel: 1 }, a4: 440 });
		check("Settings aus dem Property Inspector", A.tunerSettingsOf({ source: "steinberg", muteChannel: false, input: '{"device":"Analog (1+2) (RME MADIface Pro)","channel":0}', a4: "442" }), { source: "steinberg", muteChannel: false, input: { device: "Analog (1+2) (RME MADIface Pro)", channel: 0 }, a4: 442 });
		check("Kammerton: Komma, 415 (Barock), außerhalb 400 … 480 und Unsinn → 440", [A.a4Of("441,5"), A.a4Of(415), A.a4Of(380), A.a4Of("abc"), A.a4Of(444)], [441.5, 415, 440, 440, 444]);
		check("openWindow nur echtes true", [A.openWindowOf({ openWindow: true }), A.openWindowOf({ openWindow: "true" })], [true, false]);
		const items = [
			{ device: "MADI (5+6) (RME MADIface Pro)", channel: 0, label: "MADI 5" },
			{ device: "MADI (5+6) (RME MADIface Pro)", channel: 1, label: "MADI 6" },
			{ device: "Analog (1+2) (RME MADIface Pro)", channel: 0, label: "Analog 1" },
		];
		check("Auswahl: je Gerät eine Gruppe", A.inputItems(items), [
			{ label: "MADI (5+6) (RME MADIface Pro)", children: [{ label: "MADI 5", value: '{"device":"MADI (5+6) (RME MADIface Pro)","channel":0}' }, { label: "MADI 6", value: '{"device":"MADI (5+6) (RME MADIface Pro)","channel":1}' }] },
			{ label: "Analog (1+2) (RME MADIface Pro)", children: [{ label: "Analog 1", value: '{"device":"Analog (1+2) (RME MADIface Pro)","channel":0}' }] },
		]);
		check("leere Liste: Hinweis", A.inputItems([]), [{ label: "Keine Eingänge gefunden", value: "", disabled: true }]);

		const e = connected(0x64);
		const action = new A.TunerAction(e.s, async () => items);
		const before = sd.toPropertyInspector.length;
		await action.onSendToPlugin({ payload: { event: "getInputs" }, action: { id: "x" } });
		check("Datenquelle getInputs → sendToPropertyInspector", sd.toPropertyInspector.slice(before), [{ event: "getInputs", items: A.inputItems(items) }]);
		await action.onSendToPlugin({ payload: { event: "anderes" }, action: { id: "x" } });
		check("andere Ereignisse: nichts", sd.toPropertyInspector.length, before + 1);

		const key = { id: "k", images: [], alerts: 0, isKey: () => true, isDial: () => false, setImage: async (img) => key.images.push(img), showAlert: async () => key.alerts++ };
		action.onWillAppear({ action: key, payload: { settings: {} } });
		// Kurzer Druck: Drücken und loslassen (die Tuner-Taste wirkt beim Loslassen).
		action.onKeyDown({ action: key, payload: { settings: {} } });
		action.onKeyUp({ action: key, payload: { settings: {} } });
		e.flush();
		e.port.emit({ type: "status", status: { kind: "error", code: "missing-input", text: "Eingang MADI 6 fehlt", key: "Eingang?" } });
		e.flush();
		await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
		const last = () => key.images[key.images.length - 1];
		check("Taste im Modus, Eingang fehlt: „Eingang?“", last() === render.renderTunerKey(null, { kind: "error", text: "Eingang?" }, true), true); // Vorgabe: Stummschaltung an = roter Rahmen
		e.port.emit({ type: "status", status: { kind: "running", rate: 48000 } });
		e.port.emit({ type: "reading", reading: { note: "A", octave: 2, cents: 0.4, state: "held", level: -80, t: 3 } });
		e.flush();
		await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
		check("gehalten: gedimmtes Bild", last() === render.renderTunerKey({ note: "A", octave: 2, cent: 0, locked: true, inTune: true, found: true, held: true }, { kind: "ok" }, true), true);
		check("kein Warnzeichen", key.alerts, 0);
		action.onWillDisappear({ action: key });

		// Langer Druck: automatische Stummschaltung umschalten, roter Rahmen = an
		// (Wunsch des Users 2026-10-07). Kurz wirkt beim Loslassen, lang schon beim Halten.
		{
			const g = connected(0x64);
			const act = new A.TunerAction(g.s, async () => []);
			const saved = [];
			const lk = {
				id: "lk",
				images: [],
				alerts: 0,
				isKey: () => true,
				isDial: () => false,
				setImage: async (img) => lk.images.push(img),
				showAlert: async () => lk.alerts++,
				setSettings: async (s) => saved.push(s),
			};
			const shown = () => lk.images[lk.images.length - 1];
			const OKS = { kind: "ok" };
			const notes = (from) => g.sent.slice(from).filter((b) => b[0] === 0x92).map(hex);
			check("muteArmed: Vorgabe an, Haken aus, Steinberg-Quelle nie", [A.muteArmed({}), A.muteArmed({ muteChannel: false }), A.muteArmed({ source: "steinberg" })], [true, false, false]);

			act.onWillAppear({ action: lk, payload: { settings: {} } });
			g.port.emit({ type: "status", status: { kind: "running", rate: 48000 } });
			g.port.emit({ type: "reading", reading: { note: "--", octave: 0, cents: 0, state: "silent", level: -100, t: 1 } });
			g.flush();
			const quiet = { note: "--", octave: 0, cent: 0, locked: false, inTune: false, found: true, held: false };
			await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
			check("Vorgabe (Stummschaltung an): roter Rahmen", shown() === render.renderTunerKey(quiet, OKS, true, false), true);
			ok("roter und goldener Rahmen sind verschieden", render.renderTunerKey(quiet, OKS, true, false) !== render.renderTunerKey(quiet, OKS, false, false));

			const n0 = g.sent.length;
			act.onKeyDown({ action: lk, payload: { settings: {} } });
			await sleep(A.LONG_PRESS_MS / 2);
			check("halb so lang gehalten: noch nichts passiert", [saved.length, g.s.tunerActive()], [0, false]);
			await sleep(A.LONG_PRESS_MS / 2 + 60);
			check("lang gehalten: Setting gespeichert, Stummschaltung aus — noch während des Haltens", saved, [{ muteChannel: false }]);
			act.onKeyUp({ action: lk, payload: { settings: {} } });
			g.flush();
			check("Loslassen nach langem Druck: Tuner bleibt aus, keine Note", [g.s.tunerActive(), notes(n0)], [false, []]);
			await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
			check("jetzt goldener Rahmen", shown() === render.renderTunerKey(quiet, OKS, false, false), true);

			const off = { muteChannel: false };
			const n1 = g.sent.length;
			act.onKeyDown({ action: lk, payload: { settings: off } });
			act.onKeyUp({ action: lk, payload: { settings: off } });
			g.flush();
			check("kurzer Druck: Tuner an, ohne Stummschaltung kein Mute", [g.s.tunerActive(), notes(n1)], [true, []]);

			const n2 = g.sent.length;
			act.onKeyDown({ action: lk, payload: { settings: off } });
			await sleep(A.LONG_PRESS_MS + 60);
			act.onKeyUp({ action: lk, payload: { settings: off } });
			g.flush();
			check("langer Druck im Modus: Stummschaltung an, Input 6 sofort stumm, Tuner bleibt an", [saved[saved.length - 1], notes(n2), g.s.tunerActive()], [{ muteChannel: true }, [MUTE_ON], true]);
			await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
			ok("im Modus: heller roter Rahmen (Tasten-Bild mit roter Kante)", shown() !== render.renderTunerKey(g.s.tuner().reading, g.s.tuner().keyStatus, false) && shown() === render.renderTunerKey(g.s.tuner().reading, g.s.tuner().keyStatus, true));

			const n3 = g.sent.length;
			const on = { muteChannel: true };
			act.onKeyDown({ action: lk, payload: { settings: on } });
			act.onKeyUp({ action: lk, payload: { settings: on } });
			g.flush();
			check("kurzer Druck: Tuner aus, Input 6 entmutet", [g.s.tunerActive(), notes(n3)], [false, [MUTE_OFF]]);
			check("kein Warnzeichen", lk.alerts, 0);

			act.onKeyDown({ action: lk, payload: { settings: on } });
			act.onWillDisappear({ action: lk });
			await sleep(A.LONG_PRESS_MS + 60);
			check("Taste verschwindet während des Haltens: kein langer Druck mehr", saved.length, 2);
		}

		// Die Taste stimmt immer mit; der kurze Druck schaltet nur die große Anzeige in der
		// Leiste und die Mute (Wunsch des Users 2026-10-07).
		{
			const g = connected(0x64);
			const act = new A.TunerAction(g.s, async () => []);
			const mk = (id) => {
				const k = { id, images: [], alerts: 0, isKey: () => true, isDial: () => false, setImage: async (img) => k.images.push(img), showAlert: async () => k.alerts++, setSettings: async () => undefined };
				return k;
			};
			const k1 = mk("a1");
			const k2 = mk("a2");
			const OKS = { kind: "ok" };
			const shown = (k) => k.images[k.images.length - 1];
			const tap = (k, settings = {}) => {
				act.onKeyDown({ action: k, payload: { settings } });
				act.onKeyUp({ action: k, payload: { settings } });
				g.flush();
			};
			check("vor der Taste: kein Kindprozess", g.port.starts.length, 0);
			act.onWillAppear({ action: k1, payload: { settings: {} } });
			g.flush();
			check("Taste erscheint: Kindprozess läuft, Modus aus", [g.port.starts, g.s.tunerActive()], [[{ device: "MADI (5+6)", channel: 1, a4: 440 }], false]);
			await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
			check("vor der ersten Meldung: Taste „Warte…“, schlichter roter Rahmen", shown(k1) === render.renderTunerKey(null, { kind: "waiting" }, true, false), true);

			g.port.emit({ type: "status", status: { kind: "running", rate: 48000 } });
			g.port.emit({ type: "reading", reading: { note: "E", octave: 2, cents: -16.2, state: "tracking", level: -40, t: 1 } });
			g.flush();
			const e16 = { note: "E", octave: 2, cent: -16, locked: true, inTune: false, found: true, held: false };
			await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
			check("ohne Modus: Taste zeigt E2 -16, schlichter Rahmen; Leiste bleibt bei den Reglern", [shown(k1) === render.renderTunerKey(e16, OKS, true, false), g.s.tunerActive()], [true, false]);
			ok("schlichter und heller Rahmen sind verschieden", render.renderTunerKey(e16, OKS, true, false) !== render.renderTunerKey(e16, OKS, true, true));

			const n1 = g.sent.length;
			tap(k1);
			await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
			check("kurzer Druck: große Anzeige an, Input 6 stumm, Messung bleibt, kein Stopp", [g.s.tunerActive(), g.sent.slice(n1).filter((b) => b[0] === 0x92).map(hex), g.s.tuner().reading, g.port.stops], [true, [MUTE_ON], e16, 0]);
			check("im Modus: heller roter Rahmen", shown(k1) === render.renderTunerKey(e16, OKS, true, true), true);

			const n2 = g.sent.length;
			tap(k1);
			await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
			check("zweiter kurzer Druck: Anzeige aus, Input 6 offen, Tuner misst weiter", [g.s.tunerActive(), g.sent.slice(n2).filter((b) => b[0] === 0x92).map(hex), g.port.stops, shown(k1) === render.renderTunerKey(e16, OKS, true, false)], [false, [MUTE_OFF], 0, true]);

			act.onWillAppear({ action: k2, payload: { settings: {} } });
			act.onWillDisappear({ action: k1 });
			check("eine von zwei Tasten verschwindet: läuft weiter", g.port.stops, 0);
			act.onWillDisappear({ action: k2 });
			check("letzte Taste weg, Modus aus: Kindprozess gestoppt", g.port.stops, 1);

			const s0 = g.port.starts.length;
			tap(k1); // Druck ohne sichtbare Taste (Stream Deck stellt ihn trotzdem zu)
			check("Modus ohne Taste: läuft wieder (frisch, „Warte…“)", [g.s.tunerActive(), g.port.starts.length > s0, g.s.tuner().reading], [true, true, null]);
			act.onWillAppear({ action: k1, payload: { settings: {} } });
			tap(k1);
			check("Taste wieder da, Modus aus: läuft weiter", [g.s.tunerActive(), g.port.stops], [false, 1]);
			act.onWillDisappear({ action: k1 });

			const h = connected(0x64);
			const sb = new A.TunerAction(h.s, async () => []);
			const k3 = mk("s1");
			sb.onWillAppear({ action: k3, payload: { settings: { source: "steinberg" } } });
			h.flush();
			await sleep(A.TUNER_KEY_INTERVAL_MS + 40);
			check("Steinberg-Quelle: kein Kindprozess, Taste wie bisher (Messwerte nur im Modus)", [h.port.starts.length, shown(k3) === render.renderToggleKey("tuner", false, OKS, false)], [0, true]);
			sb.onDidReceiveSettings({ action: k3, payload: { settings: {} } });
			h.flush();
			check("Wechsel zum eigenen Tuner bei sichtbarer Taste: startet", h.port.starts.length, 1);
			sb.onDidReceiveSettings({ action: k3, payload: { settings: { source: "steinberg" } } });
			h.flush();
			check("zurück zu Steinberg: gestoppt", h.port.stops, 1);
			sb.onWillDisappear({ action: k3 });
		}

		// Kette: Häkchen, wenn etwas geladen wurde, Warndreieck, wenn ein Slot nicht stimmt.
		{
			const g = connected(0x64);
			const act = new A.TunerAction(g.s, async () => []);
			const k = { id: "c1", images: [], alerts: 0, oks: 0, isKey: () => true, isDial: () => false, setImage: async () => undefined, showAlert: async () => k.alerts++, showOk: async () => k.oks++, setSettings: async () => undefined };
			act.onWillAppear({ action: k, payload: { settings: {} } });
			g.flush();
			const result = (d, a) => {
				g.feed([[0xf0, 0x7d, 0x25, d, a, 0xf7]]);
				return [k.oks, k.alerts];
			};
			check("beide waren da: weder Häkchen noch Warndreieck", result(0, 0), [0, 0]);
			check("eins geladen: Häkchen", result(1, 0), [1, 0]);
			check("eins nicht in der Plugin-Liste: Warndreieck", result(0, 2), [1, 1]);
			check("geladen, aber Bypass nicht übernommen: Warndreieck", result(5, 1), [1, 2]);
			check("Kanal fehlt: Warndreieck", result(6, 6), [1, 3]);
			act.onWillDisappear({ action: k });
			check("ohne Taste: nichts", result(1, 1), [1, 3]);
		}

		// Bilder: gehalten und Eingang fehlt (zum Ansehen in test-output)
		mkdirSync(outputDir, { recursive: true });
		const pngOf = (url) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
		const { Resvg } = require(path.join(root, "com.sorg.tone3000.sdPlugin", "node_modules", "@resvg", "resvg-js"));
		const sheet = (w, h, body) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`).render().asPng();
		const strip = (state, st) => sheet(800, 100, [0, 1, 2, 3].map((i) => `<image href="${render.renderTunerSegment(i, state, st)}" x="${i * 200}" y="0" width="200" height="100"/>`).join(""));
		const live = { note: "G", octave: 3, cent: -4, locked: true, inTune: false, found: true };
		const tuned = { note: "E", octave: 2, cent: 1, locked: true, inTune: true, found: true };
		const cases = [
			["verfolgt", live, { kind: "ok" }, { kind: "ok" }],
			["gehalten", { ...live, held: true }, { kind: "ok" }, { kind: "ok" }],
			["gestimmt", tuned, { kind: "ok" }, { kind: "ok" }],
			["gestimmt-gehalten", { ...tuned, held: true }, { kind: "ok" }, { kind: "ok" }],
			["eingang-fehlt", null, { kind: "error", text: "Eingang MADI 6 fehlt" }, { kind: "error", text: "Eingang?" }],
		];
		const strips = {};
		for (const [label, state, st, keySt] of cases) {
			strips[label] = strip(state, st);
			writeFileSync(path.join(outputDir, `own-tuner-strip-${label}.png`), strips[label]);
			writeFileSync(path.join(outputDir, `own-tuner-key-${label}.png`), pngOf(render.renderTunerKey(state, keySt)));
		}
		let body = `<rect width="1100" height="${cases.length * 152}" fill="#5a5a5a"/>`;
		cases.forEach(([label, state, , keySt], r) => {
			body += `<image href="data:image/png;base64,${strips[label].toString("base64")}" x="0" y="${r * 152 + 22}" width="800" height="100"/>`;
			body += `<image href="${render.renderTunerKey(state, keySt)}" x="820" y="${r * 152}" width="144" height="144"/>`;
		});
		writeFileSync(path.join(outputDir, "own-tuner-overview.png"), sheet(1100, cases.length * 152, body));
		console.log("      own-tuner-strip-*.png, own-tuner-key-*.png, own-tuner-overview.png");

		// Pixel: gehalten dunkler als verfolgt (Nadel), Lampen aus auch bei gestimmt
		const pixelsOf = (png, w, h) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image href="data:image/png;base64,${png.toString("base64")}" width="${w}" height="${h}"/></svg>`).render().pixels;
		const lum = (px, w, x, y) => {
			const i = (y * w + x) * 4;
			return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
		};
		const maxLum = (px, w, x0, x1, y0, y1) => {
			let m = 0;
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m = Math.max(m, lum(px, w, x, y));
			return m;
		};
		const px = Object.fromEntries(cases.map(([label]) => [label, pixelsOf(strips[label], 800, 100)]));
		const needleX = Math.round(400 + -4 * 5.6);
		const needle = (label) => maxLum(px[label], 800, needleX - 2, needleX + 2, 63, 80);
		const note = (label) => maxLum(px[label], 800, 360, 440, 14, 56);
		const lamp = (label) => maxLum(px[label], 800, 305, 315, 31, 41);
		console.log(`      Nadel hell: verfolgt ${Math.round(needle("verfolgt"))}, gehalten ${Math.round(needle("gehalten"))}; Note: ${Math.round(note("verfolgt"))} / ${Math.round(note("gehalten"))}; Lampe gestimmt ${Math.round(lamp("gestimmt"))} / gehalten ${Math.round(lamp("gestimmt-gehalten"))}`);
		ok("gehalten: Nadel und Note deutlich gedimmt", needle("gehalten") < needle("verfolgt") * 0.75 && note("gehalten") < note("verfolgt") * 0.75);
		ok("gehalten: Lampen aus, auch wenn der letzte Wert gestimmt war", lamp("gestimmt-gehalten") < lamp("gestimmt") * 0.6);
		ok("Eingang fehlt: Hinweis statt Skala", strips["eingang-fehlt"].length > 0 && maxLum(px["eingang-fehlt"], 800, 130, 670, 85, 87) < 110);
	}

	//==========================================================================
	section("Worker als Kindprozess: WAV statt Audiogerät");
	{
		ok("Worker kompiliert", existsSync(WORKER), WORKER);
		/** Worker starten, alle Nachrichten sammeln, bis er endet. */
		const runWorker = (config, { stopAfterMs } = {}) =>
			new Promise((resolve) => {
				const messages = [];
				const child = fork(WORKER, [JSON.stringify(config)], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
				let stderr = "";
				child.stderr.on("data", (d) => (stderr += d));
				child.on("message", (m) => messages.push(m));
				const started = Date.now();
				if (stopAfterMs) setTimeout(() => child.send({ type: "stop" }), stopAfterMs);
				const guard = setTimeout(() => child.kill(), 120000);
				child.on("exit", (code) => {
					clearTimeout(guard);
					resolve({ code, messages, stderr, ms: Date.now() - started });
				});
			});

		// Synthetische Saite als WAV: E2 -16 Cent, dann B3 +7 Cent
		const rate = 48000;
		const sig = S.sequence(rate, 8, [
			{ midi: 40, cents: -16, t60: 8, fundamentalDb: -8, B: 3e-5, startSec: 0.5, peakDb: -24, seed: 1 },
			{ midi: 59, cents: 7, t60: 4.5, B: 8e-5, startSec: 4.5, peakDb: -20, seed: 2 },
		], -100);
		const wavFile = path.join(outputDir, "tuner-worker-test.wav");
		writeFileSync(wavFile, wav16(sig.signal, rate));
		const r = await runWorker({ mode: "wav", file: wavFile, a4: 440, speed: 0 });
		const readings = r.messages.filter((m) => m.type === "reading").map((m) => m.reading);
		check("WAV: ready, Messungen, end, Code 0", [r.messages[0].type, readings.length > 10, r.messages[r.messages.length - 1].type, r.code], ["ready", true, "end", 0]);
		const e2 = shown(readings, "E", 2, 1, 4.5);
		const b3 = shown(readings, "B", 3, 5, 8);
		console.log(`      E2: ${e2.seconds.toFixed(2)} s angezeigt, Ø ${e2.mean.toFixed(2)} Cent; B3: ${b3.seconds.toFixed(2)} s, Ø ${b3.mean.toFixed(2)} Cent`);
		ok("E2 -16 Cent erkannt (verfolgt über 3 s, Ø auf 1 Cent)", e2.seconds > 3 && Math.abs(e2.mean + 16) < 1);
		ok("B3 +7 Cent erkannt (Notenname B, nicht H)", b3.seconds > 2.5 && Math.abs(b3.mean - 7) < 1);
		ok("nur bei Änderung gemeldet: nie zweimal dasselbe hintereinander", readings.every((x, k) => k === 0 || !W.sameReading(x, readings[k - 1])));
		ok("Abstand ≥ 50 ms Audiozeit", readings.every((x, k) => k === 0 || x.t - readings[k - 1].t >= 0.049));

		const missing = await runWorker({ mode: "wav", file: path.join(outputDir, "gibt-es-nicht.wav"), a4: 440, speed: 0 });
		check("Datei fehlt: Fehler missing-input, Code 2", [missing.messages.map((m) => m.type + (m.code ? ":" + m.code : "")), missing.code], [["error:missing-input"], 2]);
		const broken = await runWorker({ mode: "weiß nicht" });
		check("kaputter Auftrag: Fehler failed, Code 1", [broken.messages.map((m) => m.type + (m.code ? ":" + m.code : "")), broken.code], [["error:failed"], 1]);
		const stopped = await runWorker({ mode: "wav", file: wavFile, a4: 440, speed: 1 }, { stopAfterMs: 1500 });
		check("Echtzeit, „stop“ nach 1,5 s: endet sofort (Code 0, ohne end)", [stopped.code, stopped.ms < 4000, stopped.messages.some((m) => m.type === "end")], [0, true, false]);

		if (!existsSync(RECORDING)) {
			console.log(`      aufnahmen/saiten-1.wav fehlt — Integrationstest mit echten Saiten übersprungen`);
		} else {
			const real = await runWorker({ mode: "wav", file: RECORDING, a4: 440, speed: 0 });
			const rs = real.messages.filter((m) => m.type === "reading").map((m) => m.reading);
			const strings = [["E", 2], ["A", 2], ["D", 3], ["G", 3], ["B", 3], ["E", 4]];
			const per = strings.map(([n, o]) => ({ name: n + o, ...shown(rs, n, o, 0, 1e9) }));
			console.log(`      saiten-1.wav (${real.ms} ms): ${per.map((p) => `${p.name} ${p.seconds.toFixed(1)} s, Ø ${p.mean.toFixed(1)} Cent`).join("; ")}`);
			ok("echte Aufnahme: alle sechs Saiten E2 A2 D3 G3 B3 E4 je mindestens 5 s verfolgt", per.every((p) => p.seconds >= 5), JSON.stringify(per.map((p) => p.seconds.toFixed(1))));
			ok("echte Aufnahme: Cent plausibel (Mittel je Saite innerhalb ±10)", per.every((p) => Math.abs(p.mean) < 10));
			check("echte Aufnahme: Ende ohne Fehler", [real.code, real.messages.some((m) => m.type === "error")], [0, false]);
		}
	}
};

/**
 * Wie lange eine Note als „tracking" angezeigt war (zwischen from und to) und ihr
 * zeitgewichtetes Cent-Mittel: Der Worker meldet nur Änderungen, ein Wert gilt bis zur
 * nächsten Meldung.
 */
function shown(readings, note, octave, from, to) {
	let seconds = 0;
	let sum = 0;
	for (let k = 0; k < readings.length; k++) {
		const x = readings[k];
		if (x.state !== "tracking" || x.note !== note || x.octave !== octave) continue;
		const start = Math.max(from, x.t);
		const end = Math.min(to, k + 1 < readings.length ? readings[k + 1].t : x.t + 0.05);
		if (end <= start) continue;
		seconds += end - start;
		sum += (end - start) * x.cents;
	}
	return { seconds, mean: seconds > 0 ? sum / seconds : NaN };
}

/** 16-Bit-PCM-WAV, mono. */
function wav16(samples, rate) {
	const data = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + data.length, 4);
	h.write("WAVE", 8);
	h.write("fmt ", 12);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(1, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * 2, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(data.length, 40);
	return Buffer.concat([h, data]);
}
