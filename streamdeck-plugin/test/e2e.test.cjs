/**
 * Ende zu Ende: das ECHTE Nuendo-Script (nuendo-script/Vincent_Tone3000.js) in der
 * nachgebauten API (test/stub-api.cjs im Projektordner), verbunden über ein
 * MIDI-Portpaar im Speicher mit MidiManager, Session und Store des Plugins.
 *
 *   Plugin  MidiManager ──sd_tone3000──► Script (Stub)
 *           Session     ◄──tone3000_sd── Script
 *
 * Zustellung über eine Warteschlange, nicht verschachtelt: Was eine Seite sendet,
 * kommt bei der anderen an, nachdem die eigene Verarbeitung fertig ist — wie über
 * echte Ports. Die Uhr der Session läuft von Hand.
 *
 * Stimmanzeige (Protokoll 4): läuft gegen Steinbergs Tuner im Stub (tunerInput) und
 * wird nicht übersprungen — fehlt der Tuner im Stub oder das 0x24 im Script, schlägt
 * der Test fehl. Der letzte Teil hängt die echten Aktionen (Regler, Tuner-Taste, SDK
 * als Attrappe) samt Grafik an: 0x13 -> Mute im Stub -> 0x24 -> Bilder auf Leiste und
 * Taste; Modus aus -> Mute 0, Regler zurück; Wiederverbindung -> 0x13 00 hebt die Mute
 * auf. Die Drossel der Aktionen läuft mit echter Uhr; dieser Teil wartet dafür kurz.
 */
"use strict";

const path = require("node:path");
const { section, check, ok, hex } = require("./harness.cjs");
const fake = require("./fake-midi.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ROOT = path.join(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "nuendo-script", "Vincent_Tone3000.js");
const { createHost, TAG } = require(path.join(ROOT, "test", "stub-api.cjs"));

const build = path.join(__dirname, "..", "test-output", "build");
const P = require(path.join(build, "midi", "protocol.js"));
const { MidiManager } = require(path.join(build, "midi", "midi-manager.js"));
const { Session } = require(path.join(build, "state", "session.js"));

const status = (s) => (s.kind === "error" ? s.text : s.kind);
const isQuery = (b) => b.length === 4 && b[0] === 0xf0 && b[2] === P.MSG_QUERY;

/** Ein Host im Normalzustand wie in script.test.cjs: Titel, Slotnamen, Delay im Bypass, aktiviert. */
function readyHost(options = {}) {
	const h = createHost(options);
	h.load(SCRIPT);
	h.setInputTitles();
	h.setSlotTitle(6, 0, "Tuner");
	h.setSlotTitle(6, 1, "H-Delay Mono");
	h.setSlotTitle(6, 2, "TONE3000");
	h.setHostValue("ch6.slot1.bypass", 1);
	h.activate();
	return h;
}

/** Script, Ports, Plugin-Seite. deck.tuner: Einstellung der Tuner-Taste (Vorgabe Steinberg-Quelle), deck.session: weitere Optionen der Session. */
function rig(hostOptions = {}, deck = {}) {
	fake.reset(["Anderer Port", "tone3000_sd 2", "tone3000_sd"], ["sd_tone3000_alt", "sd_tone3000"]);
	const host = readyHost(hostOptions);
	const tasks = [];
	const logs = [];
	const toScript = []; // was beim Script ankommt
	let t = 0;
	const r = {
		host,
		logs,
		toScript,
		/** Nuendo erreichbar? false: Frames zum Script gehen verloren. */
		online: true,
		at(ms) {
			t = ms;
		},
		pump() {
			let n = 0;
			while (tasks.length) {
				tasks.shift()();
				if (++n > 100000) throw new Error("Zustellung hört nicht auf");
			}
		},
		step(ms) {
			t = ms;
			r.session.tick();
			r.pump();
		},
		queries: () => toScript.filter(isQuery).length,
		hostLog: (from = 0) => host.log.slice(from),
	};
	fake.setSink((bytes, name) => {
		if (name !== "sd_tone3000") return;
		tasks.push(() => {
			if (!r.online) return;
			toScript.push(bytes);
			if (bytes[0] === 0xf0) host.sysex(bytes);
			else if ((bytes[0] & 0xf0) === 0x90) host.note(bytes[0] & 0x0f, bytes[1], bytes[2]);
		});
	});
	host.onSend = (frame) => tasks.push(() => fake.deliver("tone3000_sd", frame));

	r.midi = new MidiManager(fake.backend);
	r.midi.maintain();
	// Die Abläufe hier sind die der Steinberg-Quelle (Protokoll 4); der eigene Tuner hat eigene Tests.
	const makeSession = () => {
		const s = new Session({
			send: (b) => {
				r.midi.send(b);
			},
			now: () => t,
			log: (l) => logs.push(l),
			useTimers: false,
			defer: (fn) => tasks.push(fn),
			...deck.session,
		});
		s.configureTuner(deck.tuner ?? { source: "steinberg", muteChannel: true, input: { device: "MADI (5+6)", channel: 1 }, a4: 440 });
		return s;
	};
	r.session = makeSession();
	/** Plugin-Prozess neu gestartet: frische Session (Tuner-Modus aus), dieselben Ports. */
	r.restartPlugin = () => {
		r.session = makeSession();
	};
	r.midi.addListener((m) => r.session.receive(m));
	return r;
}

const setsSince = (r, from) => r.hostLog(from).filter((l) => /^setParameter(Process|Display)Value /.test(l));
/** SysEx-Frames, die beim Script angekommen sind (ohne Pings), als Hex. */
const sysexToScript = (r, from = 0) => r.toScript.slice(from).filter((b) => b[0] === 0xf0 && b[2] !== P.MSG_PING).map(hex);

/** Drehregler wie vom SDK, nur was KnobAction anfasst; merkt sich jedes setFeedback. */
function fakeDial(id, column) {
	const d = {
		id,
		feedback: [],
		alerts: 0,
		coordinates: { column, row: 0 },
		isDial: () => true,
		isKey: () => false,
		setFeedback: async (payload) => {
			d.feedback.push(payload);
		},
		showAlert: async () => {
			d.alerts++;
		},
	};
	return d;
}

/** Taste wie vom SDK; merkt sich jedes setImage. */
function fakeKey(id) {
	const k = {
		id,
		images: [],
		alerts: 0,
		isDial: () => false,
		isKey: () => true,
		setImage: async (img) => {
			k.images.push(img);
		},
		showAlert: async () => {
			k.alerts++;
		},
	};
	return k;
}

module.exports = async function run() {
	// Das Script schreibt mit console.log ins Protokoll von Nuendo; hier nur mitschreiben.
	const scriptConsole = [];
	const realLog = console.log;
	console.log = (...a) => scriptConsole.push(a.join(" "));
	try {
		await runAll(scriptConsole);
	} finally {
		console.log = realLog;
	}
};

async function runAll(scriptConsole) {
	section("E2E: Verbinden und Abfrage");
	const r = rig();
	const st = r.session.store;
	check("Ports exakt: Ausgang sd_tone3000, Eingang tone3000_sd", [r.midi.hasOutput(), r.midi.hasInput(), fake.created.outputs.find((o) => o.openCalls).openName, fake.created.inputs.find((i) => i.openCalls).openName], [true, true, "sd_tone3000", "tone3000_sd"]);
	r.step(0);
	check("Ping -> Pong -> verbunden -> genau eine Abfrage", [r.session.connected, r.queries()], [true, 1]);
	check("Store: vier Werte", st.knobs.map((k) => P.to14(k.value01)), [8178, 8192, 8192, 8192]);
	check("Store: Klartext des Hosts", st.knobs.map((k) => k.text), ["0.4992", "5.00", "5.00", "5.00"]);
	check("Store: Preset, Flags, Slotnamen", [st.preset, st.flags, st.slots], ["Calfinornia", 0x64, ["Tuner", "H-Delay Mono", "TONE3000"]]);
	check("Store: 0x24 aus der Abfrage (Modus aus, Tuner gefunden, Stille, Cent -49 bedeutungslos)", st.tuner, { note: "--", octave: 0, cent: -49, locked: false, inTune: false, mode: false, found: true, muted: false });
	check("Status überall ok", [0, 1, 2, 3].map((p) => status(r.session.knob(p).status)).concat(["amp", "tuner", "delay"].map((k) => status(r.session.toggleView(k).status))), Array(7).fill("ok"));
	check("Lampen: amp aus, Tuner aus, Delay aus (Bypass)", ["amp", "tuner", "delay"].map((k) => r.session.toggleView(k).on), [false, false, false]);
	check("Rahmen auf Calfinornia", [r.session.preset("Calfinornia").active, r.session.preset("HMT").active], [true, false]);

	section("E2E: Drehen setzt den richtigen Tag");
	const tags = [TAG.input, TAG.bass, TAG.mid, TAG.treble];
	const names = ["inputLevel", "toneBass", "toneMid", "toneTreble"];
	r.at(500);
	for (let p = 0; p < 4; p++) {
		const from = r.host.log.length;
		r.session.turn(p, p + 1);
		r.pump();
		const v14 = P.to14(r.session.knob(p).value01);
		const sets = setsSince(r, from);
		check(`p${p} ${names[p]}: +${p + 1} Schritt(e) -> setParameterProcessValue tag ${tags[p]} = ${v14}/16383`, sets, [`setParameterProcessValue id=403 tag=${tags[p]} ${v14 / 16383}`]);
		check(`p${p}: Hostwert = Wert des Decks`, P.to14(r.host.param(403, tags[p]).value), v14);
	}
	const bass14 = P.to14(st.knobs[1].value01);
	check("ohne Echo des Hosts: Deck bleibt mit seinem Wert (8192 + 2 Rasten schnell = 0,08) und eigenem Klartext führend", [bass14, st.knobs[1].text], [9503, "5.80"]);
	let from = r.host.log.length;
	r.session.center(0);
	r.pump();
	check("Druck auf Gain: Mitte 8192", [setsSince(r, from), P.to14(r.host.param(403, TAG.input).value)], [[`setParameterProcessValue id=403 tag=${TAG.input} ${8192 / 16383}`], 8192]);
	check("Anzeige Gain 0,5", r.session.knob(0).value01, 0.5);

	section("E2E: Preset-Taste");
	r.at(1000); // > 300 ms nach dem letzten 0x11
	from = r.host.log.length;
	check("Rahmen noch nicht auf HMT vor dem Druck", r.session.preset("HMT").active, false);
	r.session.selectPreset("HMT");
	r.pump();
	check("Script setzt Program per Namen", setsSince(r, from), [`setParameterDisplayValue id=403 tag=${TAG.program} "HMT"`]);
	ok("TONE3000 lädt HMT", r.hostLog(from).some((l) => /lädt Preset "HMT"/.test(l)));
	check("0x21 HMT -> Rahmen auf HMT, nicht mehr auf Calfinornia", [r.session.preset("HMT").active, r.session.preset("Calfinornia").active], [true, false]);
	check("Presetwechsel: Bass aus dem Preset übernommen (außerhalb 300 ms)", [P.to14(st.knobs[1].value01), st.knobs[1].text], [7372, "4.50"]);
	from = r.host.log.length;
	const logAt = r.logs.length;
	r.session.selectPreset("Gibtsnicht");
	r.pump();
	check("unbekannter Name: Rahmen bleibt auf HMT", r.session.preset("HMT").active, true);
	check("Debugzeile des Scripts im Log des Plugins", r.logs.slice(logAt), ["Nuendo: Preset Gibtsnicht nicht übernommen, aktiv HMT"]);

	section("E2E: Echo-Regel schützt den eigenen Wert, die Abfrage stellt richtig");
	r.at(3000);
	r.session.turn(1, 10); // schnell: Bass 4,50 -> 8,50
	const ownBass = P.to14(st.knobs[1].value01);
	r.at(3100);
	r.session.selectPreset("JCM 2000"); // setzt Bass auf 0,522 = 8552, 100 ms nach dem eigenen 0x11
	r.pump();
	check("0x21 JCM 2000 angekommen", st.preset, "JCM 2000");
	check("0x20 für Bass innerhalb 300 ms verworfen: Deck behält seinen Wert", P.to14(st.knobs[1].value01), ownBass);
	check("Treble aus dem Preset übernommen (nicht selbst gedreht)", P.to14(st.knobs[3].value01), 12582);
	const q = r.queries();
	for (let t = 3250; t <= 5000; t += 250) r.step(t);
	check("innerhalb 2 s nach dem Preset-Druck keine Leerlauf-Abfrage", r.queries(), q);
	for (let t = 5250; t <= 6000; t += 250) r.step(t);
	check("Leerlauf: Abfrage (5 s nach der letzten, 2 s Ruhe)", r.queries(), q + 1);
	check("die Abfrage bringt den Bass des Hosts", P.to14(st.knobs[1].value01), 8552);

	section("E2E: Delay-Taste");
	r.session.toggle("delay");
	r.pump();
	check("Delay im Bypass: Bypass aus, Fenster auf", [r.host.hostValue("ch6.slot1.bypass"), r.host.hostValue("ch6.slot1.edit"), st.flags, r.session.toggleView("delay").on], [0, 1, 0x68, true]);
	r.session.toggle("delay");
	r.pump();
	check("Delay aktiv: Bypass an, Fenster zu", [r.host.hostValue("ch6.slot1.bypass"), r.host.hostValue("ch6.slot1.edit"), st.flags, r.session.toggleView("delay").on], [1, 0, 0x64, false]);

	section("E2E: Amp-Taste");
	r.session.toggle("amp");
	r.pump();
	check("TONE3000-Fenster auf", [r.host.hostValue("ch6.slot2.edit"), st.flags, r.session.toggleView("amp").on], [1, 0x74, true]);
	r.session.toggle("amp");
	r.pump();
	check("TONE3000-Fenster zu", [r.host.hostValue("ch6.slot2.edit"), st.flags, r.session.toggleView("amp").on], [0, 0x64, false]);
	check("Mute blieb dabei unberührt", r.host.hostValue("ch6.mute"), 0);

	section("E2E: TONE3000 verschwindet aus Slot 3 und kommt wieder");
	let q2 = r.queries();
	r.host.replacePlugin(3, 404, { title: null });
	r.host.setSlotTitle(6, 2, "");
	r.pump();
	check("sofort abgefragt (Slot-3-Name, bit6)", r.queries() > q2, true);
	check("bit6 = 0: Werte und Preset unbekannt, Slot 3 leer", [st.knobs.map((k) => k.value01), st.preset, st.slots[2], st.flags & P.FLAG_PLUGIN_FOUND], [[null, null, null, null], null, "", 0]);
	check("Status: Regler, Preset, amp Plugin?; Tuner und Delay ok", [status(r.session.knob(0).status), status(r.session.preset("HMT").status), status(r.session.toggleView("amp").status), status(r.session.toggleView("tuner").status), status(r.session.toggleView("delay").status)], ["Plugin?", "Plugin?", "Plugin?", "ok", "ok"]);
	from = r.host.log.length;
	check("Regler und Preset gesperrt, nichts erreicht den Host", [r.session.center(1), r.session.selectPreset("HMT"), r.session.toggle("amp")], [false, false, false]);
	r.pump();
	check("keine Setzversuche im Host", setsSince(r, from), []);
	q2 = r.queries();
	r.host.replacePlugin(3, 405, {});
	r.host.setSlotTitle(6, 2, "TONE3000");
	r.pump();
	check("TONE3000 wieder da: abgefragt, Werte und Preset neu", [r.queries() > q2, st.knobs.every((k) => k.value01 !== null), st.preset !== null, status(r.session.knob(2).status)], [true, true, true, "ok"]);
	from = r.host.log.length;
	r.at(10000);
	r.session.turn(2, -3);
	r.pump();
	ok("Drehen wirkt auf das neue Objekt (id 405)", setsSince(r, from).some((l) => l.startsWith(`setParameterProcessValue id=405 tag=${TAG.mid}`)), setsSince(r, from).join(" / "));

	section("E2E: falscher Kanal auf Platz 6");
	q2 = r.queries();
	r.host.setInputTitle(6, "Gitarre");
	r.pump();
	check("bit5 fällt: sofort abgefragt, überall Kanal?", [r.queries() > q2, status(r.session.knob(0).status), status(r.session.toggleView("tuner").status)], [true, "Kanal?", "Kanal?"]);
	from = r.host.log.length;
	check("Tasten gesperrt (würden ohne Titelprüfung wirken)", [r.session.toggle("tuner"), r.session.toggle("delay"), r.session.toggle("amp")], [false, false, false]);
	r.pump();
	check("keine Note erreicht den Host", r.hostLog(from).filter((l) => /^Note /.test(l)), []);
	r.host.setInputTitle(6, "Mono In 6");
	r.pump();
	check("Titel zurück: ok", status(r.session.toggleView("tuner").status), "ok");

	section("E2E: Nuendo weg und wieder da");
	r.online = false;
	let t = 11000;
	for (; t <= 30000 && r.session.connected; t += 250) r.step(t);
	check("ohne Pong: Warte", [r.session.connected, status(r.session.knob(0).status), status(r.session.preset("HMT").status)], [false, "waiting", "waiting"]);
	r.online = true;
	q2 = r.queries();
	for (let k = 0; k < 10 && !r.session.connected; k++) r.step((t += 250));
	check("Pong: verbunden, erneut abgefragt, mit der Antwort (0x22) wieder ok", [r.session.connected, r.queries() === q2 + 1, status(r.session.knob(0).status)], [true, true, "ok"]);

	section("E2E: Host mit Echo (ownSetsNotify, am Gerät ungeprüft)");
	const e = rig({ ownSetsNotify: true });
	e.step(0);
	e.at(100);
	e.session.turn(1, 5); // schnell, 5 Rasten doppelt: 0,50003 -> 0,70003
	e.pump();
	const k1 = e.session.store.knobs[1];
	const echoes = e.host.sent.filter((f) => f[0] === 0xf0 && f[2] === 0x20 && f[3] === 1).map((f) => P.parseFrame(f));
	check("Script schickt das Echo 0x20 p1 11469 \"7.00\"", echoes[echoes.length - 1], { type: "param", p: 1, value: 11469, text: "7.00" });
	check("Echo mit gleichem Wert innerhalb 300 ms: Wert bleibt, Klartext gilt", [P.to14(k1.value01), k1.text], [11469, "7.00"]);
	e.at(150);
	e.session.turn(1, 1);
	e.session.turn(1, 1);
	e.pump();
	check("zwei einzelne Rasten kurz hintereinander: Anzeige auf dem letzten eigenen Wert", P.to14(k1.value01), P.to14(0.740031));

	section("E2E: Stimmanzeige (Protokoll 4)");
	const tr = rig();
	const TID = tr.host.IDS.TUNER;
	// Kein Überspringen mehr: Stub und Script müssen den Steinberg-Tuner kennen.
	const stubTuner = typeof tr.host.tunerInput === "function" && !!tr.host.objects[TID] && tr.host.objects[TID].title === "Tuner";
	tr.step(0);
	const toScriptFrames = (from = 0) => sysexToScript(tr, from);
	check("Verbindungsaufbau: erst 0x13 00 (Modus des Decks), dann die Abfrage", toScriptFrames().slice(0, 2), ["F0 7D 13 00 F7", "F0 7D 10 F7"]);
	const scriptTuner = tr.session.store.tuner !== null; // Fassung 4 antwortet darauf mit 0x24
	ok("Stub: Steinbergs Tuner in Slot 1 mit tunerInput (test/stub-api.cjs)", stubTuner);
	ok("Script: Antwort mit 0x24 (Fassung 4)", scriptTuner);
	if (stubTuner && scriptTuner) {
		const muteOf = () => tr.host.param(TID, 4201).value;
		const notesSince = (i) => tr.hostLog(i).filter((l) => /^Note /.test(l)).map((l) => l.replace(/ ->.*/, ""));
		const tunerFramesSince = (i) => tr.host.sent.slice(i).filter((f) => f[0] === 0xf0 && f[2] === P.MSG_TUNER).length;
		let ts = tr.session.store;
		check("nach dem Verbinden: Modus aus, Tuner gefunden, seine Mute aus", [ts.tunerMode, ts.tuner.found, ts.tuner.mode, muteOf()], [false, true, false, 0]);

		tr.at(1000);
		let from = tr.host.log.length;
		check("Tuner-Taste ohne Fenster: gesendet", tr.session.pressTuner(false), true);
		tr.pump();
		check("Modus an: Mute des Tuners an, 0x24 mit bit2 und bit4; Kanal-Mute und Fenster unberührt", [tr.session.tunerActive(), ts.tuner.mode, ts.tuner.muted, muteOf(), tr.host.hostValue("ch6.mute"), tr.host.hostValue("ch6.slot0.edit")], [true, true, true, 1, 0, 0]);
		check("keine Note erreicht den Host", notesSince(from), []);

		tr.host.tunerInput(TID, { midi: 40, cent: -16, inTune: false });
		tr.pump();
		check("Gitarre E2 -16: Note, Oktave, Cent, Ton erkannt", [ts.tuner.note, ts.tuner.octave, ts.tuner.cent, ts.tuner.locked, ts.tuner.inTune], ["E", 2, -16, true, false]);
		check("Regler im Modus gesperrt", [tr.session.turn(1, 1), tr.session.center(2)], [false, false]);
		tr.host.tunerInput(TID, { midi: 40, cent: 2, inTune: true });
		tr.pump();
		check("gestimmt: +2, bit1", [ts.tuner.cent, ts.tuner.inTune], [2, true]);
		tr.host.tunerInput(TID, { midi: 42, cent: 0, inTune: true });
		tr.pump();
		check("F#2 0 Cent", [ts.tuner.note, ts.tuner.octave, ts.tuner.cent], ["F#", 2, 0]);
		tr.host.tunerInput(TID, null);
		tr.pump();
		check("Stille: kein Ton, Note --", [ts.tuner.locked, ts.tuner.note], [false, "--"]);

		from = tr.host.log.length;
		tr.session.pressTuner(true);
		tr.pump();
		check("aus mit openWindow: Mute des Tuners aus, Note 1 Vel 0", [tr.session.tunerActive(), ts.tuner.mode, ts.tuner.muted, muteOf(), notesSince(from)], [false, false, false, 0, ["Note Kanal 3 Nr. 1 Vel 0"]]);
		const sentBefore = tr.host.sent.length;
		tr.host.tunerInput(TID, { midi: 45, cent: 1, inTune: true });
		tr.pump();
		check("Modus aus: der Tuner misst, das Script schickt kein 0x24", tunerFramesSince(sentBefore), 0);
		from = tr.host.log.length;
		tr.session.pressTuner(true);
		tr.pump();
		check("an mit openWindow: Fenster Slot 1 auf, Mute des Tuners an", [notesSince(from), tr.host.hostValue("ch6.slot0.edit"), muteOf(), tr.session.tunerActive()], [["Note Kanal 3 Nr. 1 Vel 127"], 1, 1, true]);

		// Das Plugin stirbt im Modus und startet neu: sein erstes 0x13 00 hebt die Mute auf.
		tr.restartPlugin();
		ts = tr.session.store;
		tr.step(20000);
		check("neuer Plugin-Prozess: 0x13 00 -> Mute des Tuners aus, Modus aus", [tr.session.connected, muteOf(), ts.tuner.mode, tr.session.tunerActive()], [true, 0, false, false]);
		tr.host.setHostValue("ch6.slot0.edit", 0, "Fenster per X");
		tr.pump();

		// Verbindung weg im Modus und wieder da: das Deck schickt seinen Modus erneut.
		tr.session.pressTuner(false);
		tr.pump();
		check("wieder im Modus", [tr.session.tunerActive(), muteOf()], [true, 1]);
		tr.online = false;
		let t = 20250;
		for (; t <= 40000 && tr.session.connected; t += 250) tr.step(t);
		check("ohne Pong: Warte, Modus bleibt", [tr.session.connected, status(tr.session.tuner().status), tr.session.tunerActive()], [false, "waiting", true]);
		tr.online = true;
		const k0 = tr.toScript.length;
		for (let k = 0; k < 10 && !tr.session.connected; k++) tr.step((t += 250));
		check("wieder verbunden: 0x13 01 vor der Abfrage; Modus und Mute bleiben", [toScriptFrames(k0).slice(0, 2), tr.session.tunerActive(), muteOf(), status(tr.session.tuner().status)], [["F0 7D 13 01 F7", "F0 7D 10 F7"], true, 1, "ok"]);

		// Tuner im Modus aus Slot 1 entfernt
		tr.host.replacePlugin(1, 450, { title: null });
		tr.host.setSlotTitle(6, 0, "");
		tr.pump();
		check("Tuner aus Slot 1 entfernt: 0x24 mit bit3 = 0, Leiste zeigt den Hinweis", [ts.tuner.found, ts.tuner.mode, tr.session.tunerActive()], [false, true, true]);
		tr.session.pressTuner(false);
		tr.pump();
		check("Modus aus ohne Tuner: Taste „Tuner?“", [tr.session.tunerActive(), status(tr.session.toggleView("tuner").status)], [false, "Tuner?"]);
		tr.host.replacePlugin(1, 451, { title: "Tuner" });
		tr.host.setSlotTitle(6, 0, "Tuner");
		tr.pump();
		const q3 = tr.queries();
		for (let k = 1; k <= 24 && tr.queries() === q3; k++) tr.step(t + k * 250);
		check("Tuner wieder da: mit der nächsten Abfrage kein Hinweis mehr", [ts.tuner.found, status(tr.session.toggleView("tuner").status)], [true, "ok"]);

		// Projekt mit gespeicherter Tuner-Mute geöffnet, Deck verbunden, Modus aus (5.5): kein
		// Verbindungsaufbau, also kein 0x13 des Pongs. Das Script vergisst außerhalb des Modus
		// nur; die Abfrage meldet bit4 ohne Modus, und das Deck hebt die Mute einmal auf.
		tr.host.replacePlugin(1, 452, { title: "Tuner" });
		tr.host.param(452, 4201).value = 1; // so im Projekt gespeichert
		tr.host.fireObjectChange(6);
		tr.pump();
		const savedMute = () => tr.host.param(452, 4201).value;
		check("Projektwechsel außerhalb des Modus: das Script setzt nichts von sich aus", [savedMute(), tr.session.tunerActive()], [1, false]);
		let t4 = t + 25 * 250;
		const m0 = tr.toScript.length;
		const q4 = tr.queries();
		for (let k = 1; k <= 24 && tr.queries() === q4; k++) tr.step((t4 += 250));
		const modeFrames = () => toScriptFrames(m0).filter((x) => x.startsWith("F0 7D 13"));
		check("nächste Abfrage: 0x24 mit bit4 ohne Modus -> genau ein 0x13 00 -> Mute des Tuners aus, kein Hinweis", [modeFrames(), savedMute(), ts.tuner.muted, ts.tuner.mode, status(tr.session.toggleView("tuner").status)], [["F0 7D 13 00 F7"], 0, false, false, "ok"]);
		const q5 = tr.queries();
		for (let k = 1; k <= 24 && tr.queries() === q5; k++) tr.step((t4 += 250));
		check("die Abfrage danach: kein weiteres 0x13", [tr.queries() > q5, modeFrames().length], [true, 1]);
		ok("keine Ausnahmen im Script (Tuner)", tr.host.callbackErrors.length === 0, tr.host.callbackErrors.join(" | "));
	}

	if (stubTuner && scriptTuner) await tunerOnDeck();
	ownTunerChannelMute();

	ok("keine Ausnahmen im Script", r.host.callbackErrors.length === 0 && e.host.callbackErrors.length === 0, [...r.host.callbackErrors, ...e.host.callbackErrors].join(" | "));
	ok("Script-Konsole mitgeschrieben (Aktivierung)", scriptConsole.some((l) => /TONE3000 Remote aktiv/.test(l)), scriptConsole.join(" / "));
	fake.reset();
}

/**
 * Eigener Tuner am echten Script: Kanal-Mute „wie vorher" über Note 0 auf Kanal 3, nur
 * wenn Input 6 nicht schon stumm ist, aufgehoben nur, was die Taste gesetzt hat; Merker
 * nach einem Neustart; Steinbergs Tuner bleibt unberührt (beim Verbinden 0x13 00).
 * Der Audio-Kindprozess ist eine Attrappe.
 */
function ownTunerChannelMute() {
	section("E2E: eigener Tuner, Kanal-Mute am echten Script");
	const port = { starts: 0, stops: 0, start() { port.starts++; }, stop() { port.stops++; }, listen() {} };
	const markers = [];
	const own = { source: "own", muteChannel: true, input: { device: "MADI (5+6)", channel: 1 }, a4: 440 };
	const o = rig({}, { tuner: own, session: { ownTuner: port, onChannelMuteMarker: (on) => markers.push(on) } });
	const TID = o.host.IDS.TUNER;
	const chMute = () => o.host.hostValue("ch6.mute");
	const tunerMute = () => o.host.param(TID, 4201).value;
	o.step(0);
	check("Verbindungsaufbau: 0x13 00 (Steinbergs Modus aus), dann die Abfrage", sysexToScript(o).slice(0, 2), ["F0 7D 13 00 F7", "F0 7D 10 F7"]);
	o.at(500);
	let from = o.toScript.length;
	check("Taste an: gesendet", o.session.pressTuner(false), true);
	o.pump();
	check("Input 6 im Host stumm, Steinbergs Tuner unberührt, kein 0x13 01", [chMute(), tunerMute(), o.toScript.slice(from).map(hex)], [1, 0, ["92 00 7F"]]);
	check("0x22 meldet bit0, Merker gesetzt, Kindprozess läuft", [(o.session.store.flags & 1) === 1, o.session.store.channelMuted, markers, port.starts], [true, true, [true], 1]);
	from = o.toScript.length;
	o.session.pressTuner(false);
	o.pump();
	check("Taste aus: Input 6 wieder offen, Merker weg, Kindprozess gestoppt", [chMute(), o.toScript.slice(from).map(hex), markers, port.stops], [0, ["92 00 00"], [true, false], 1]);

	// Input 6 schon stumm (z. B. Projekt mit laufendem Tuner gespeichert): Einschalten
	// fasst ihn nicht an, Ausschalten entmutet trotzdem — Wunsch des Users 2026-10-02.
	o.host.setHostValue("ch6.mute", 1, "von Hand");
	o.pump();
	const q = o.queries();
	for (let k = 1; k <= 24 && o.queries() === q; k++) o.step(1000 + k * 250);
	from = o.toScript.length;
	o.session.pressTuner(false);
	o.pump();
	check("schon stumm: Einschalten sendet keine Note", o.toScript.slice(from).filter((b) => b[0] === 0x92).map(hex), []);
	o.session.pressTuner(false);
	o.pump();
	check("Ausschalten entmutet immer: Note 0 aus, Input 6 im Host offen", [o.toScript.slice(from).filter((b) => b[0] === 0x92).map(hex), chMute()], [["92 00 00"], 0]);
	o.host.setHostValue("ch6.mute", 0, "von Hand");
	o.pump();

	// Plugin stirbt mit gemutetem Input 6; der neue Prozess lädt den Merker und hebt auf.
	const q2 = o.queries();
	for (let k = 1; k <= 24 && o.queries() === q2; k++) o.step(8000 + k * 250);
	o.session.pressTuner(false);
	o.pump();
	check("wieder an: Input 6 stumm", chMute(), 1);
	o.restartPlugin();
	o.session.restoreChannelMute(true);
	o.step(20000);
	check("neuer Plugin-Prozess mit Merker: erstes 0x22 hebt die Mute auf", [o.session.connected, chMute(), o.session.store.channelMuted], [true, 0, false]);
	ok("keine Ausnahmen im Script (eigener Tuner)", o.host.callbackErrors.length === 0, o.host.callbackErrors.join(" | "));
}

/**
 * Stimmanzeige bis aufs Bild: die echten Aktionen (vier Regler in den Spalten 0–3, die
 * Tuner-Taste) an einer Session, die mit dem echten Script im Stub verbunden ist. Die
 * erwarteten Bilder entstehen aus Messungen, die hier von Hand stehen — nicht aus dem
 * Store —, und eine Gegenprobe zeigt, dass Note und Cent das Bild wirklich ändern.
 */
async function tunerOnDeck() {
	section("E2E: Stimmanzeige auf Leiste und Taste (Aktionen am echten Script)");
	let render, KnobAction, TunerAction, TUNER_INTERVAL_MS;
	try {
		render = require(path.join(build, "render", "index.js"));
		({ KnobAction, TUNER_INTERVAL_MS } = require(path.join(build, "actions", "knob.js")));
		({ TunerAction } = require(path.join(build, "actions", "tuner.js")));
	} catch (err) {
		ok("Aktionen und Grafik geladen", false, String(err));
		return;
	}
	render.initRenderer(path.join(__dirname, "..", "com.sorg.tone3000.sdPlugin"));

	const OK = { kind: "ok" };
	const WAITING = { kind: "waiting" };
	const v = rig();
	const TID = v.host.IDS.TUNER;
	const muteOf = () => v.host.param(TID, 4201).value;
	const knobAction = new KnobAction(v.session);
	const tunerAction = new TunerAction(v.session);
	const dials = [0, 1, 2, 3].map((c) => fakeDial(`e2e-dial${c}`, c));
	const key = fakeKey("e2e-tuner");
	for (const d of dials) knobAction.onWillAppear({ action: d, payload: { settings: {} } });
	// Steinberg-Quelle (Protokoll 4); der eigene Tuner hat eigene Tests.
	tunerAction.onWillAppear({ action: key, payload: { settings: { source: "steinberg" } } });
	const press = (settings = {}) => tunerAction.onKeyDown({ action: key, payload: { settings: { source: "steinberg", ...settings } } });
	/** Zustellen, die Drossel der Aktionen (höchstens alle 100 ms) auslaufen lassen. */
	const settle = async () => {
		v.pump();
		await sleep(TUNER_INTERVAL_MS + 30);
		v.pump();
	};
	const canvas = (d) => d.feedback[d.feedback.length - 1].canvas;
	const image = () => key.images[key.images.length - 1];
	const all4 = [true, true, true, true];
	const stripShows = (state, st = OK) => dials.map((d, i) => canvas(d) === render.renderTunerSegment(i, state, st));
	const knobsShow = (values14, st = OK) => dials.map((d, i) => canvas(d) === render.renderDial(P.PARAM_NAMES[i], values14[i] / 16383, st));
	const HOST_VALUES = [8178, 8192, 8192, 8192];
	/** Messung, wie sie das 0x24 bringen muss; mode und muted wie im Modus. */
	const reading = (note, octave, cent, locked, inTune) => ({ note, octave, cent, locked, inTune, mode: true, found: true, muted: true });

	v.step(0);
	await settle();
	check("verbunden, Modus aus: die Leiste zeigt die vier Regler mit den Werten des Hosts", knobsShow(HOST_VALUES), all4);
	check("Tuner-Taste wie bisher (Lampe aus)", image() === render.renderToggleKey("tuner", false, OK), true);

	// Modus an: 0x13 01 -> Script setzt "Mute" des Tuners -> 0x24 -> Bilder
	let from = v.toScript.length;
	press();
	await settle();
	check("Druck auf die Tuner-Taste: genau 0x13 01 geht hinaus (ohne openWindow keine Note)", v.toScript.slice(from).filter((b) => !(b[0] === 0xf0 && b[2] === P.MSG_PING)).map(hex), ["F0 7D 13 01 F7"]);
	check("Mute des Tuners im Stub an, Kanal-Mute unberührt", [muteOf(), v.host.hostValue("ch6.mute")], [1, 0]);
	const silent = reading("--", 0, -49, false, false); // Startzustand des Stubs: Stille, Cent zuletzt "-49"
	check("0x24 angekommen: Leiste zeigt die Stimmanzeige (Stille: „--“, keine Nadel, keine Cent-Zahl)", stripShows(silent), all4);
	check("Taste zeigt die Stimmanzeige (Stille)", image() === render.renderTunerKey(silent, OK), true);

	v.host.tunerInput(TID, { midi: 40, cent: -16, inTune: false });
	await settle();
	const e16 = reading("E", 2, -16, true, false);
	check("Gitarre E -16: jedes Segment zeigt seinen Ausschnitt mit Note und Cent", stripShows(e16), all4);
	check("Taste: Note E, Cent-Balken bei -16, rote Lampe", image() === render.renderTunerKey(e16, OK), true);
	ok("Gegenprobe Note: „A“ statt „E“ gäbe andere Bilder in Bass, Mid und auf der Taste", [1, 2].every((i) => render.renderTunerSegment(i, { ...e16, note: "A" }, OK) !== canvas(dials[i])) && render.renderTunerKey({ ...e16, note: "A" }, OK) !== image());
	ok("Gegenprobe Cent: -15 statt -16 gäbe ein anderes Treble-Segment (Cent-Zahl), 0 eine andere Taste (Balken)", render.renderTunerSegment(3, { ...e16, cent: -15 }, OK) !== canvas(dials[3]) && render.renderTunerKey({ ...e16, cent: 0 }, OK) !== image());

	v.host.tunerInput(TID, { midi: 40, cent: 2, inTune: true });
	await settle();
	const tuned = reading("E", 2, 2, true, true);
	check("gestimmt (+2, In Tune): Leiste grün, Nadel nahe der Mitte", stripShows(tuned), all4);
	check("gestimmt: Taste mit grüner Lampe", image() === render.renderTunerKey(tuned, OK), true);

	from = v.host.log.length;
	knobAction.onDialRotate({ action: dials[1], payload: { settings: {}, ticks: 3 } });
	knobAction.onDialDown({ action: dials[2], payload: { settings: {} } });
	v.pump();
	check("Regler im Modus: Drehen und Drücken erreichen den Host nicht, kein Warnzeichen", [setsSince(v, from), dials[1].alerts + dials[2].alerts], [[], 0]);

	// Modus aus: 0x13 00 -> Mute 0 -> Regler zurück
	from = v.toScript.length;
	press();
	await settle();
	check("zweiter Druck: 0x13 00", sysexToScript(v, from), ["F0 7D 13 00 F7"]);
	check("Mute des Tuners im Stub wieder aus; Modus aus", [muteOf(), v.session.tunerActive(), v.session.store.tuner.mode, v.session.store.tuner.muted], [0, false, false, false]);
	check("Regler zurück, mit den Werten von vorher", knobsShow(HOST_VALUES), all4);
	check("Tuner-Taste wieder wie bisher", image() === render.renderToggleKey("tuner", false, OK), true);
	const n0 = dials.map((d) => d.feedback.length);
	const sent0 = v.host.sent.length;
	v.host.tunerInput(TID, { midi: 45, cent: -3, inTune: false });
	await settle();
	check("Modus aus, der Tuner misst: kein 0x24, kein neues Bild", [v.host.sent.slice(sent0).filter((f) => f[0] === 0xf0 && f[2] === P.MSG_TUNER).length, dials.map((d) => d.feedback.length)], [0, n0]);

	section("E2E: Wiederverbindung hebt eine liegengebliebene Tuner-Mute auf");
	press();
	await settle();
	check("wieder im Modus, Mute an", [v.session.tunerActive(), muteOf()], [true, 1]);
	v.online = false; // Nuendo hört das Deck nicht mehr, sendet aber weiter
	let t = 1000;
	for (; t <= 30000 && v.session.connected; t += 250) v.step(t);
	await settle();
	check("ohne Pong: Leiste und Taste „Warte…“, Modus bleibt", [stripShows(null, WAITING), image() === render.renderTunerKey(null, WAITING), v.session.tunerActive()], [all4, true, true]);
	from = v.toScript.length;
	press(); // aus, ohne Verbindung erlaubt; das 0x13 00 geht verloren
	await settle();
	check("Taste ohne Verbindung: Modus aus, Regler-Bilder zurück (Warte…); das 0x13 00 erreicht Nuendo nicht, Mute bleibt an", [v.session.tunerActive(), knobsShow(HOST_VALUES, WAITING), sysexToScript(v, from), muteOf()], [false, all4, [], 1]);
	v.host.tunerInput(TID, { midi: 40, cent: -7, inTune: false }); // Nuendo, noch im Modus, meldet 0x24 mit bit2 = 1
	await settle();
	check("0x24 mit bit2 = 1 ohne Verbindung: das Deck bleibt aus", v.session.tunerActive(), false);
	v.online = true;
	from = v.toScript.length;
	for (let k = 0; k < 10 && !v.session.connected; k++) v.step((t += 250));
	await settle();
	check("Wiederverbindung: erst 0x13 00 (Modus des Decks), dann die Abfrage", sysexToScript(v, from).slice(0, 2), ["F0 7D 13 00 F7", "F0 7D 10 F7"]);
	check("0x13 00 hebt die Mute im Stub auf; 0x24 bestätigt Modus aus, Mute aus", [muteOf(), v.session.tunerActive(), v.session.store.tuner.mode, v.session.store.tuner.muted], [0, false, false, false]);
	check("Regler zurück und wieder ok", knobsShow(HOST_VALUES), all4);

	section("E2E: Plugin-Neustart, während Nuendo im Modus weiter misst");
	press();
	await settle();
	check("im Modus, Mute an", [v.session.tunerActive(), muteOf()], [true, 1]);
	for (const d of dials) knobAction.onWillDisappear({ action: d }); // der alte Prozess ist weg
	tunerAction.onWillDisappear({ action: key });
	v.restartPlugin();
	v.host.tunerInput(TID, { midi: 40, cent: -20, inTune: false }); // 0x24 mit bit2 = 1 vor dem ersten Ping
	v.pump();
	check("0x24 vor dem ersten Pong: der neue Prozess bleibt beim Start-Modus aus", [v.session.tunerActive(), v.session.store.tuner], [false, null]);
	from = v.toScript.length;
	v.step((t += 250));
	check("erster Pong: erst 0x13 00, dann die Abfrage", sysexToScript(v, from).slice(0, 2), ["F0 7D 13 00 F7", "F0 7D 10 F7"]);
	check("Mute im Stub aufgehoben, Modus aus", [muteOf(), v.session.tunerActive(), v.session.store.tuner.mode], [0, false, false]);
	ok("keine Ausnahmen im Script (Aktionen)", v.host.callbackErrors.length === 0, v.host.callbackErrors.join(" | "));
	const sd = require("./fake-streamdeck.cjs");
	ok("keine Fehler im Log der Aktionen", !sd.logged.some((l) => l.startsWith("E ")), sd.logged.filter((l) => l.startsWith("E ")).join(" | "));
}
