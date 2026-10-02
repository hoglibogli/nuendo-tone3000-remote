/**
 * Logik ohne MIDI und ohne Timer: Wächter, Store, Session, Drossel.
 *
 * Die Uhr läuft von Hand; verschobene Aufgaben der Session (Abfrage „sofort",
 * Änderungsmeldung) sammeln sich in einer Liste und laufen mit flush().
 */
"use strict";

const path = require("node:path");
const { section, check, ok, hex } = require("./harness.cjs");

const build = path.join(__dirname, "..", "test-output", "build");
const P = require(path.join(build, "midi", "protocol.js"));
const { Health, PING_INTERVAL_MS, LOST_AFTER_MS } = require(path.join(build, "state", "health.js"));
const { ECHO_WINDOW_MS, STEP_PER_TICK, paramIndexFor, tunerSegmentFor } = require(path.join(build, "state", "store.js"));
const { Session, IDLE_QUERY_MS } = require(path.join(build, "state", "session.js"));
const { Throttle } = require(path.join(build, "state", "throttle.js"));

// Frames von Nuendo
const N = {
	pong: () => P.buildPing(),
	param: (p, v, text = P.hostText(p, v)) => [0xf0, 0x7d, 0x20, p, v >> 7, v & 0x7f, ...P.encodeText(text), 0xf7],
	preset: (name) => [0xf0, 0x7d, 0x21, ...P.encodeText(name), 0xf7],
	flags: (f) => [0xf0, 0x7d, 0x22, f, 0xf7],
	slot: (s, name) => [0xf0, 0x7d, 0x23, s, ...P.encodeText(name), 0xf7],
	debug: (text) => [0xf0, 0x7d, 0x7f, ...P.encodeText(text), 0xf7],
	/** 0x24 (Protokoll 4): flags, cent+64, oct+64, Note. */
	tuner: (flags, cent, oct, note) => [0xf0, 0x7d, 0x24, flags, cent + 64, oct + 64, ...P.encodeText(note), 0xf7],
};
/** Antwort auf eine Abfrage wie in protokoll.md 7. */
const ANSWER = [
	N.param(0, 8178, "0.4992"),
	N.param(1, 8192, "5.00"),
	N.param(2, 8192, "5.00"),
	N.param(3, 8192, "5.00"),
	N.preset("Calfinornia"),
	N.flags(0x64),
	N.slot(0, "GTR Tuner Mono"),
	N.slot(1, "H-Delay Mono"),
	N.slot(2, "TONE3000"),
];

const isPing = (b) => b.length === 4 && b[2] === P.MSG_PING;
const isQuery = (b) => b.length === 4 && b[2] === P.MSG_QUERY;
const status = (s) => (s.kind === "error" ? s.text : s.kind);

/** Tuner-Taste mit der Steinberg-Quelle (Protokoll 4); der eigene Tuner hat eigene Tests (tuner-plugin.test.cjs). */
const STEINBERG = { source: "steinberg", muteChannel: true, input: { device: "MADI (5+6)", channel: 1 }, a4: 440 };

/** Eine Session mit Uhr von Hand. alive: Pings werden sofort beantwortet. tuner: Einstellung der Tuner-Taste. */
function env(tuner = STEINBERG) {
	let t = 0;
	const sent = [];
	const tasks = [];
	const logs = [];
	let changes = 0;
	let pongDue = false;
	const e = {
		alive: true,
		sent,
		logs,
		s: null,
		at(ms) {
			t = ms;
		},
		now: () => t,
		flush() {
			while (tasks.length) tasks.shift()();
		},
		/** Uhr stellen, takten, Pong zustellen (falls Nuendo da ist), Aufgaben laufen lassen. */
		step(ms) {
			t = ms;
			e.s.tick();
			if (pongDue && e.alive) e.s.receive(N.pong());
			pongDue = false;
			e.flush();
		},
		feed(frames) {
			for (const f of frames) e.s.receive(f);
			e.flush();
		},
		queries: () => sent.filter(isQuery).length,
		changes: () => changes,
		/** Gesendetes seit Index i, ohne Pings. */
		since: (i) => sent.slice(i).filter((b) => !isPing(b)),
	};
	e.s = new Session({
		send: (b) => {
			sent.push(b);
			if (isPing(b)) pongDue = true;
		},
		now: () => t,
		log: (l) => logs.push(l),
		useTimers: false,
		defer: (fn) => tasks.push(fn),
	});
	e.s.configureTuner(tuner);
	while (tasks.length) tasks.shift()(); // die Änderungsmeldung des Einstellens zählt nicht
	e.s.onChange(() => changes++);
	return e;
}

/** Verbunden und abgefragt, Antwort wie in der Beispielsitzung. */
function ready() {
	const e = env();
	e.step(0);
	e.feed(ANSWER);
	return e;
}

module.exports = function run() {
	//==========================================================================
	section("Wächter (Ping/Pong)");
	{
		const h = new Health();
		check("anfangs nicht verbunden, Ping fällig", [h.connected, h.pingDue(0)], [false, true]);
		h.notePing(0);
		check("nächster Ping nach 2 s", [h.pingDue(PING_INTERVAL_MS - 1), h.pingDue(PING_INTERVAL_MS)], [false, true]);
		check("erster Pong verbindet", h.notePong(5), true);
		check("weiterer Pong verbindet nicht erneut", h.notePong(2005), false);
		check("noch verbunden kurz vor der Grenze", h.check(2005 + LOST_AFTER_MS - 1), false);
		check("verloren nach 7 s ohne Pong", [h.check(2005 + LOST_AFTER_MS), h.connected], [true, false]);
		check("nur einmal als verloren gemeldet", h.check(20000), false);
		check("nächster Pong verbindet wieder", h.notePong(21000), true);
	}

	//==========================================================================
	section("Verbinden und Abfragen (4.4)");
	{
		const e = env();
		e.s.receive(N.flags(0x64)); // unverlangt vor dem Pong: wird übernommen
		e.flush();
		check("Frame vor dem Pong übernommen, Status trotzdem Warte", [e.s.store.flags, status(e.s.knob(0).status)], [0x64, "waiting"]);
		e.alive = false;
		e.step(0);
		check("Takt bei 0: nur ein Ping", e.sent.map(hex), ["F0 7D 01 F7"]);
		e.step(1000);
		check("keine Abfrage ohne Pong", e.queries(), 0);
		e.alive = true;
		e.step(2000);
		check("Pong -> verbunden, genau eine Abfrage", [e.s.connected, e.queries()], [true, 1]);
		ok("Log nennt die Verbindung", e.logs.some((l) => /Pong/.test(l)));
		e.feed(ANSWER);
		const st = e.s.store;
		check("Antwort: vier Werte", st.knobs.map((k) => k.value01), [8178 / 16383, 8192 / 16383, 8192 / 16383, 8192 / 16383]);
		check("Antwort: Klartext", st.knobs.map((k) => k.text), ["0.4992", "5.00", "5.00", "5.00"]);
		check("Antwort: Preset, Flags, Slots", [st.preset, st.flags, st.slots], ["Calfinornia", 0x64, ["GTR Tuner Mono", "H-Delay Mono", "TONE3000"]]);
		check("Antwort löst keine weitere Abfrage aus (erstes Bekanntwerden)", e.queries(), 1);
		check("alles ok", [0, 1, 2, 3].map((p) => status(e.s.knob(p).status)).concat(status(e.s.preset("HMT").status)), ["ok", "ok", "ok", "ok", "ok"]);
		e.step(4000);
		check("weiterer Pong: keine weitere Abfrage", e.queries(), 1);
	}

	//==========================================================================
	section("Leerlauf-Abfrage alle 5 s, nur im Leerlauf (4.4)");
	{
		const e = ready(); // Abfrage bei 0
		e.step(2000);
		e.step(4000);
		e.step(4999);
		check("vor 5 s keine zweite", e.queries(), 1);
		e.step(IDLE_QUERY_MS);
		check("nach 5 s im Leerlauf", e.queries(), 2);
		e.at(9000);
		e.s.turn(1, 1); // 0x11
		e.step(10000);
		check("5 s um, aber 1 s nach einem 0x11: keine Abfrage", e.queries(), 2);
		e.step(10999);
		check("1999 ms nach dem 0x11: noch keine", e.queries(), 2);
		e.step(11000);
		check("2 s nach dem 0x11: Abfrage", e.queries(), 3);
		e.at(15000);
		e.s.selectPreset("HMT");
		e.step(16000);
		check("1 s nach einer Preset-Taste: keine", e.queries(), 3);
		e.step(17000);
		check("2 s nach der Preset-Taste: Abfrage", e.queries(), 4);
		e.at(21500);
		e.s.toggle("tuner");
		e.step(22000);
		check("Umschalt-Tasten halten den Leerlauf nicht auf", e.queries(), 5);
	}

	//==========================================================================
	section("Verbindung verloren und wieder da");
	{
		const e = ready();
		e.alive = false;
		for (let t = 2000; t <= 6750; t += 250) e.step(t);
		check("6,75 s nach dem letzten Pong noch verbunden", e.s.connected, true);
		e.step(7000);
		check("ohne Pong -> Warte", [e.s.connected, status(e.s.knob(0).status), status(e.s.toggleView("tuner").status)], [false, "waiting", "waiting"]);
		const before = e.since(0).length;
		e.step(9000);
		check("ohne Verbindung keine Leerlauf-Abfrage, nur Pings", e.since(0).length, before);
		check("Regler gesperrt", e.s.turn(0, 1), false);
		e.alive = true;
		const q = e.queries();
		e.step(11000);
		check("nächster Pong: verbunden und sofort abgefragt", [e.s.connected, e.queries()], [true, q + 1]);
		check("Werte über die Unterbrechung behalten", e.s.store.knobs[1].value01, 8192 / 16383);
		// Das Script beantwortet Pings schon vor der Aktivierung; das alte 0x22 gilt nicht mehr.
		const n = e.sent.length;
		check("Pong ohne frisches 0x22: alles Warte", [status(e.s.knob(1).status), status(e.s.preset("Calfinornia").status), status(e.s.toggleView("tuner").status)], ["waiting", "waiting", "waiting"]);
		check("Pong ohne frisches 0x22: Drehen, Drücken, Preset, Tasten gesperrt", [e.s.turn(1, 1), e.s.center(1), e.s.selectPreset("HMT"), e.s.toggle("tuner"), e.s.toggle("delay"), e.s.toggle("amp"), e.sent.length], [false, false, false, false, false, false, n]);
		check("alter Preset-Rahmen nur noch mit Warte…", e.s.preset("Calfinornia"), { active: true, status: { kind: "waiting" } });
		e.feed(ANSWER);
		check("Antwort mit 0x22: wieder frei", [status(e.s.knob(1).status), e.s.turn(1, 1)], ["ok", true]);
	}

	//==========================================================================
	section("Echo-Regel, 300 ms (4.4)");
	{
		const e = ready();
		e.at(1000);
		const turned = e.s.turn(1, 3);
		const v = e.s.knob(1).value01;
		const own = P.to14(v);
		check("Drehen +3 (schnell) von 8192: 0,12 weiter, 0x11 p1 mit dem eigenen Wert", [turned, Math.round((v - 8192 / 16383) * 1e4) / 1e4, hex(e.since(0).pop())], [true, 0.12, hex(P.buildSetParam(1, own))]);
		check("eigener Klartext sofort", e.s.store.knobs[1].text, P.hostText(1, own));
		e.at(1100);
		e.feed([N.param(1, 8519, "5.20")]);
		check("fremder Wert innerhalb 300 ms verworfen (Echo eines Zwischenwerts)", [e.s.store.knobs[1].value01, e.s.store.knobs[1].text], [v, P.hostText(1, own)]);
		e.at(1150);
		e.feed([N.param(1, own, "5.3")]);
		check("gleicher Wert innerhalb 300 ms: nur der Klartext", [e.s.store.knobs[1].value01, e.s.store.knobs[1].text], [v, "5.3"]);
		e.feed([N.param(2, 4096, "2.50")]);
		check("anderer Regler innerhalb des Fensters: übernommen", e.s.store.knobs[2].value01, 4096 / 16383);
		e.at(1000 + ECHO_WINDOW_MS - 1);
		e.feed([N.param(1, 8519, "5.20")]);
		check("bei 299 ms noch verworfen", e.s.store.knobs[1].value01, v);
		e.at(1000 + ECHO_WINDOW_MS);
		e.feed([N.param(1, 8519, "5.20")]);
		check("ab 300 ms: Wert und Klartext übernommen", [e.s.store.knobs[1].value01, e.s.store.knobs[1].text], [8519 / 16383, "5.20"]);
		e.at(2000);
		e.s.turn(1, 1);
		e.at(2250);
		e.s.turn(1, 1);
		const last = P.to14(e.s.store.knobs[1].value01);
		e.at(2500);
		e.feed([N.param(1, 9000)]);
		check("Fenster zählt ab dem letzten 0x11 (250 ms danach verworfen)", P.to14(e.s.store.knobs[1].value01), last);
		e.at(3000);
		e.s.center(0);
		e.at(3100);
		e.feed([N.param(0, 8192, "0.5000")]);
		check("Mitte: Echo 8192 bestätigt nur den Klartext", [e.s.store.knobs[0].value01, e.s.store.knobs[0].text], [0.5, "0.5000"]);
	}

	//==========================================================================
	section("Regler: Schritt, Anschlag, Mitte");
	{
		const e = ready();
		e.at(100);
		e.s.center(2); // 0,5 genau; der Host meldete 8192 = 0,50003
		const i = e.sent.length;
		e.s.turn(2, 1);
		check("+1 von 0,5: 0,52 -> 8519", [e.s.knob(2).value01, hex(e.sent[i])], [0.52, "F0 7D 11 02 42 47 F7"]);
		for (let k = 0; k < 9; k++) e.s.turn(2, 1);
		check("zehn einzelne Rasten: genau 0,7 (keine Gleitkommareste)", e.s.knob(2).value01, 0.7);
		e.s.turn(2, -1);
		check("-1: eine Raste zurück, 0,68", e.s.knob(2).value01, 0.68);
		e.s.turn(2, 2);
		check("+2 in einem Ereignis (schnell): doppelt, 0,76", e.s.knob(2).value01, 0.76);
		e.s.turn(2, -3);
		check("-3 in einem Ereignis (schnell): doppelt, 0,64", e.s.knob(2).value01, 0.64);
		check("ganzer Weg langsam in 50 Rasten", Math.round(1 / STEP_PER_TICK), 50);
		e.s.turn(2, -100);
		check("-100: begrenzt auf 0, gesendet 0", [e.s.knob(2).value01, hex(e.sent[e.sent.length - 1])], [0, "F0 7D 11 02 00 00 F7"]);
		const n = e.sent.length;
		check("am unteren Anschlag weiter links: nichts gesendet", [e.s.turn(2, -1), e.sent.length], [false, n]);
		e.s.turn(2, 250);
		check("+250: begrenzt auf 1 -> 16383", hex(e.sent[e.sent.length - 1]), "F0 7D 11 02 7F 7F F7");
		check("am oberen Anschlag: nichts gesendet", e.s.turn(2, 3), false);
		check("0 Ticks: nichts", e.s.turn(2, 0), false);
		e.s.center(2);
		check("Druck: Mitte 8192 = 40 00", [e.s.knob(2).value01, hex(e.sent[e.sent.length - 1])], [0.5, "F0 7D 11 02 40 00 F7"]);
		const m = e.sent.length;
		e.s.center(2);
		check("Druck auf Mitte wird trotzdem gesendet (ausdrücklicher Wunsch)", e.sent.length, m + 1);
		const c = e.changes();
		e.s.turn(3, -5);
		e.flush();
		check("Drehen meldet sofort eine Änderung (Anzeige ohne Rückmeldung)", e.changes(), c + 1);
	}
	{
		const e = env();
		e.step(0);
		e.feed([N.flags(0x64)]);
		check("Wert unbekannt: Regler wartet", status(e.s.knob(1).status), "waiting");
		check("Drehen ohne bekannten Wert gesperrt", e.s.turn(1, 1), false);
		const n = e.sent.length;
		// Kein 0x20 heißt meist: Parametertitel fehlt, das Script lehnt jedes 0x11 ab.
		check("Druck auf Mitte ohne bekannten Wert gesperrt, kein Scheinwert", [e.s.center(1), status(e.s.knob(1).status), e.s.store.knobs[1].value01, e.sent.length], [false, "waiting", null, n]);
		e.feed([N.param(1, 3000)]);
		check("mit 0x20: Druck setzt die Mitte", [e.s.center(1), status(e.s.knob(1).status), e.s.knob(1).value01, hex(e.sent[e.sent.length - 1])], [true, "ok", 0.5, "F0 7D 11 01 40 00 F7"]);
	}

	//==========================================================================
	section("Status für die Grafik");
	{
		const e = env();
		check("ohne Verbindung: alles Warte", [status(e.s.knob(0).status), status(e.s.preset("HMT").status), status(e.s.toggleView("amp").status), status(e.s.toggleView("delay").status)], ["waiting", "waiting", "waiting", "waiting"]);
		e.step(0);
		check("verbunden, noch kein 0x22: Warte", status(e.s.toggleView("tuner").status), "waiting");
		e.feed(ANSWER);
		e.feed([N.flags(0x40)]);
		const all = () => [status(e.s.knob(0).status), status(e.s.preset("HMT").status), status(e.s.toggleView("amp").status), status(e.s.toggleView("tuner").status), status(e.s.toggleView("delay").status)];
		check("bit5 = 0: überall Kanal?", all(), ["Kanal?", "Kanal?", "Kanal?", "Kanal?", "Kanal?"]);
		e.feed([N.flags(0x00)]);
		check("bit5 = 0 und bit6 = 0: Kanal? geht vor", all(), ["Kanal?", "Kanal?", "Kanal?", "Kanal?", "Kanal?"]);
		e.feed([N.flags(0x20)]);
		check("bit6 = 0: Plugin? auf Regler, Preset, amp; Tuner und Delay ok", all(), ["Plugin?", "Plugin?", "Plugin?", "ok", "ok"]);
		e.feed([N.flags(0x60)]);
		check("bit6 wieder da, Werte noch nicht: Regler warten, Rest ok", all(), ["waiting", "ok", "ok", "ok", "ok"]);
		e.feed([N.param(0, 100)]);
		check("mit 0x20: Regler ok", status(e.s.knob(0).status), "ok");
	}

	//==========================================================================
	section("Sofort abfragen: bit5, bit6, Slot-3-Name (4.4)");
	{
		const e = ready();
		let q = e.queries();
		e.feed([N.flags(0x65)]);
		check("nur bit0 (Mute) geändert: keine Abfrage", e.queries(), q);
		e.feed([N.flags(0x45)]);
		check("bit5 fällt: eine Abfrage", e.queries(), ++q);
		e.feed([N.flags(0x65)]);
		check("bit5 kommt zurück: eine Abfrage", e.queries(), ++q);
		e.feed([N.slot(0, "Anderer Tuner"), N.slot(1, "H-Delay Stereo")]);
		check("Slot 1 und 2 geändert: keine Abfrage", e.queries(), q);
		e.feed([N.slot(2, "TONE3000")]);
		check("Slot 3 unverändert: keine Abfrage", e.queries(), q);
		e.feed([N.slot(2, ""), N.flags(0x25), N.preset("")]);
		check("Slot 3 leer und bit6 fällt im selben Schwall: genau eine Abfrage", e.queries(), ++q);
		const st = e.s.store;
		check("bit6 = 0: Werte und Preset unbekannt", [st.knobs.map((k) => k.value01), st.preset], [[null, null, null, null], null]);
		e.feed([N.flags(0x65)]);
		check("bit6 kommt zurück: Abfrage", e.queries(), ++q);
		e.feed(ANSWER.slice(0, 5));
		check("Script sendet alle vier 0x20 und 0x21 neu: wieder bekannt", [st.knobs.every((k) => k.value01 !== null), st.preset], [true, "Calfinornia"]);
		e.feed([N.slot(2, "TONE3000")]);
		check("Slot-3-Name zurück: Abfrage", e.queries(), ++q);
		const fresh = env();
		fresh.step(0);
		const q0 = fresh.queries();
		fresh.feed([N.flags(0x24), N.slot(2, "Amp X")]);
		check("erstes 0x22 und erstes 0x23 s2: keine zusätzliche Abfrage", fresh.queries(), q0);
	}

	//==========================================================================
	section("Presets (4.4)");
	{
		const e = ready();
		const i = e.sent.length;
		check("Druck: 0x12 HMT", [e.s.selectPreset("HMT"), hex(e.sent[i])], [true, "F0 7D 12 34 38 34 44 35 34 F7"]);
		check("aktiv erst mit 0x21, nicht vorab", [e.s.preset("HMT").active, e.s.preset("Calfinornia").active], [false, true]);
		e.feed([N.preset("HMT")]);
		check("nach 0x21 HMT: Rahmen wandert", [e.s.preset("HMT").active, e.s.preset("Calfinornia").active], [true, false]);
		check("Groß/klein zählt", e.s.preset("hmt").active, false);
		e.feed([N.preset("")]);
		check("leeres 0x21: kein Preset aktiv", e.s.preset("HMT").active, false);
		check("leerer Name: nichts", e.s.selectPreset(""), false);
		check("Name über 100 Byte: nichts (nie gekürzt)", e.s.selectPreset("x".repeat(101)), false);
		e.feed([N.flags(0x24)]);
		const n = e.sent.length;
		check("bit6 = 0: gesperrt, nichts gesendet", [e.s.selectPreset("HMT"), e.sent.length], [false, n]);
	}

	//==========================================================================
	section("Umschalt-Tasten: Zielzustand aus 0x22 (4.1)");
	{
		const e = ready(); // 0x64: Delay im Bypass, alles zu
		const press = (kind) => {
			const i = e.sent.length;
			const done = e.s.toggle(kind);
			return done ? e.sent.slice(i).map(hex) : null;
		};
		check("Delay im Bypass: aus", e.s.toggleView("delay").on, false);
		check("Delay im Bypass: Bypass aus, Fenster auf", press("delay"), ["92 02 00", "92 03 7F"]);
		e.feed([N.flags(0x68)]);
		check("0x22 0x68: Delay an", e.s.toggleView("delay").on, true);
		check("Delay aktiv: Bypass an, Fenster zu", press("delay"), ["92 02 7F", "92 03 00"]);
		e.feed([N.flags(0x64)]);
		check("TONE3000-Fenster zu: auf", press("amp"), ["92 04 7F"]);
		e.feed([N.flags(0x74)]);
		check("0x22 0x74: amp an", e.s.toggleView("amp").on, true);
		check("TONE3000-Fenster offen: zu", press("amp"), ["92 04 00"]);
		check("Druck ohne neues 0x22: wieder derselbe Zielzustand (keine eigene Annahme)", press("amp"), ["92 04 00"]);
		e.feed([N.flags(0x34)]);
		check("bit6 = 0: amp gesperrt, Tuner nicht (0x13 an)", [press("amp"), press("tuner")], [null, ["F0 7D 13 01 F7"]]);
		press("tuner"); // wieder aus
		e.feed([N.flags(0x54)]);
		check("bit5 = 0: alle drei gesperrt", [press("amp"), press("tuner"), press("delay")], [null, null, null]);
	}

	//==========================================================================
	section("Tuner-Modus: Verbindungsaufbau schickt 0x13 (Protokoll 4)");
	{
		const e = env();
		e.step(0);
		check("erster Pong: erst 0x13 00 (Plugin-Start = aus), dann 0x10", e.since(0).map(hex), ["F0 7D 13 00 F7", "F0 7D 10 F7"]);
		e.feed(ANSWER);
		e.s.pressTuner(false);
		e.feed([N.tuner(0x1d, -16, 1, "E")]);
		check("im Modus", e.s.tunerActive(), true);
		e.alive = false;
		for (let t = 2000; t <= 7000; t += 250) e.step(t);
		check("Verbindung weg: Messung verworfen, Modus bleibt", [e.s.connected, e.s.store.tuner, e.s.tunerActive()], [false, null, true]);
		const i = e.sent.length;
		e.alive = true;
		e.step(9000);
		check("Wiederverbindung: 0x13 01 (Modus des Decks), dann 0x10", e.since(i).map(hex), ["F0 7D 13 01 F7", "F0 7D 10 F7"]);
		e.feed([N.tuner(0x1c, 0, 0, "--")]);
		check("0x24 nach der Wiederverbindung: Modus an, Stille", [e.s.tunerActive(), e.s.store.tuner.locked], [true, false]);

		// Ohne Verbindung ausgeschaltet: das nächste Verbindungsaufbau-0x13 ist 0
		e.alive = false;
		for (let t = 9250; t <= 16500; t += 250) e.step(t);
		check("wieder weg", e.s.connected, false);
		const j = e.sent.length;
		check("Ausschalten geht auch ohne Verbindung", [e.s.pressTuner(true), e.s.tunerActive(), e.since(j).map(hex)], [true, false, ["F0 7D 13 00 F7"]]);
		// Das 0x13 00 kam nie an: Nuendo misst im Modus weiter und schickt 0x24 mit bit2 = 1.
		e.feed([N.tuner(0x1d, -12, 1, "E"), N.tuner(0x1d, -10, 1, "E")]);
		check("0x24 ohne Verbindung ändert den Modus des Decks nicht (5.5)", [e.s.tunerActive(), e.s.store.tuner], [false, null]);
		e.alive = true;
		const k = e.sent.length;
		e.step(17000);
		check("danach verbunden: 0x13 00", e.since(k).map(hex), ["F0 7D 13 00 F7", "F0 7D 10 F7"]);

		const fresh = env(); // Plugin neu gestartet, während Nuendo im Modus hing
		fresh.step(0);
		check("neuer Plugin-Prozess: 0x13 00 hebt den liegengebliebenen Tuner-Mute auf", hex(fresh.since(0)[0]), "F0 7D 13 00 F7");

		// Dasselbe, aber Nuendo spielt im hängenden Modus weiter und sein 0x24 ist vor dem Pong da.
		const racing = env();
		racing.feed([N.tuner(0x1d, -16, 1, "E")]);
		check("0x24 mit bit2 = 1 vor dem ersten Pong: übergangen, Modus bleibt aus", [racing.s.tunerActive(), racing.s.store.tuner], [false, null]);
		racing.step(0);
		check("erster Pong trotzdem: erst 0x13 00, dann 0x10", racing.since(0).map(hex), ["F0 7D 13 00 F7", "F0 7D 10 F7"]);
		racing.feed([N.tuner(0x08, -16, 0, "--")]);
		check("Antwort nach dem Pong zählt wieder", [racing.s.tunerActive(), racing.s.store.tuner && racing.s.store.tuner.found], [false, true]);
	}

	//==========================================================================
	section("Tuner-Taste: nur 0x13, Fenster nur mit openWindow, nie der Kanal-Mute");
	{
		const e = ready(); // 0x64
		const press = (openWindow) => {
			const i = e.sent.length;
			const done = e.s.pressTuner(openWindow);
			return done ? e.sent.slice(i).map(hex) : null;
		};
		const key = () => [e.s.toggleView("tuner").on, status(e.s.toggleView("tuner").status)];
		check("aus: Taste dunkel, kein Hinweis", key(), [false, "ok"]);
		check("Druck ohne openWindow: nur 0x13 01", press(false), ["F0 7D 13 01 F7"]);
		check("Anzeige sofort im Modus (vor dem 0x24)", [e.s.tunerActive(), key()[0]], [true, true]);
		e.feed([N.tuner(0x0c, 0, 0, "--")]); // Antwort: Modus an, Tuner gefunden, Stille
		check("0x24 bestätigt: Modus an", [e.s.tunerActive(), e.s.tuner().status.kind], [true, "ok"]);
		check("zweiter Druck: 0x13 00", press(false), ["F0 7D 13 00 F7"]);
		check("Anzeige sofort aus", e.s.tunerActive(), false);
		e.feed([N.tuner(0x08, 0, 0, "--")]);
		check("mit openWindow an: 0x13 01, dann Note 1 Vel 127", press(true), ["F0 7D 13 01 F7", "92 01 7F"]);
		e.feed([N.tuner(0x0c, 0, 0, "--")]);
		check("mit openWindow aus: 0x13 00, dann Note 1 Vel 0", press(true), ["F0 7D 13 00 F7", "92 01 00"]);
		e.feed([N.tuner(0x08, 0, 0, "--")]);
		ok("kein einziges Mal Note 0 (Kanal-Mute)", !e.sent.some((b) => b[0] === 0x92 && b[1] === 0), e.sent.filter((b) => b[0] === 0x92).map(hex).join(" "));

		e.feed([N.flags(0x65)]); // Input 6 von Hand gemutet: geht die Tuner-Taste nichts an
		check("Kanal-Mute (bit0) ändert die Taste nicht mehr", key(), [false, "ok"]);
		check("und ein Druck sendet trotzdem nur 0x13", press(false), ["F0 7D 13 01 F7"]);
		e.feed([N.tuner(0x0c, 0, 0, "--"), N.flags(0x64)]);

		e.feed([N.flags(0x44)]); // bit5 fällt, Modus noch an
		check("bit5 = 0 im Modus: Ausschalten geht, ohne Note (wirkte ohne Titelprüfung)", press(true), ["F0 7D 13 00 F7"]);
		check("bit5 = 0: Einschalten gesperrt", press(true), null);
		check("bit5 = 0: Taste zeigt Kanal?", key(), [false, "Kanal?"]);
		e.feed([N.flags(0x64)]);
	}

	//==========================================================================
	section("Tuner-Modus: 0x24 lesen (Protokoll 4)");
	{
		const e = ready();
		check("vor dem ersten 0x24: Stimmanzeige wartet", [e.s.tuner().reading, status(e.s.tuner().status)], [null, "waiting"]);
		e.s.pressTuner(false);
		e.feed([N.tuner(0x1d, -16, 1, "E")]); // Locked, Modus, gefunden, Mute
		check("0x24: Note, Oktave, Cent, Bits", e.s.tuner().reading, { note: "E", octave: 1, cent: -16, locked: true, inTune: false, mode: true, found: true, muted: true });
		const c = e.changes();
		e.feed([N.tuner(0x1d, -16, 1, "E")]);
		check("dasselbe 0x24 noch einmal: keine Änderung", e.changes(), c);
		e.feed([N.tuner(0x1f, 3, 1, "E")]);
		check("gestimmt (bit1), +3", [e.s.store.tuner.inTune, e.s.store.tuner.cent, e.changes()], [true, 3, c + 1]);
		e.feed([N.tuner(0x1d, 60, 1, "E")]);
		check("Cent außerhalb begrenzt: 60 -> 50", e.s.store.tuner.cent, 50);
		e.feed([N.tuner(0x18, 0, 0, "--")]);
		check("bit2 = 0 vom Script: Modus aus (Nuendo hat das letzte Wort)", e.s.tunerActive(), false);
		e.feed([N.tuner(0x1c, 0, 0, "--")]);
		check("bit2 = 1 vom Script: Modus an", e.s.tunerActive(), true);
		e.feed([N.tuner(0x04, 0, 0, "--")]);
		check("bit3 = 0: Messung „nicht gefunden“, Stimmanzeige trotzdem ok (zeigt den Hinweis)", [e.s.tuner().reading.found, status(e.s.tuner().status)], [false, "ok"]);
		e.s.pressTuner(false);
		e.feed([N.tuner(0x00, 0, 0, "--")]);
		check("außerhalb des Modus und bit3 = 0: Taste „Tuner?“, sperrt nicht", [status(e.s.toggleView("tuner").status), e.s.pressTuner(false)], ["Tuner?", true]);
		e.feed([N.tuner(0x0c, 0, 0, "--")]);
		check("Tuner wieder gefunden: kein Hinweis", status(e.s.toggleView("tuner").status), "ok");
		e.feed([N.flags(0x24)]);
		check("bit6 = 0 (kein TONE3000) stört den Tuner nicht", [status(e.s.tuner().status), e.s.tunerActive()], ["ok", true]);
	}

	//==========================================================================
	section("Tuner-Mute ohne Modus: einmal 0x13 00, Taste „stumm“ (5.5)");
	{
		const e = ready(); // verbunden, 0x22 0x64, Modus aus
		const key = () => [e.s.toggleView("tuner").on, status(e.s.toggleView("tuner").status)];
		const mode = (m) => hex(P.buildTunerMode(m));
		let i = e.sent.length;
		e.feed([N.tuner(0x08, -49, 0, "--")]); // Abfrage: Modus aus, Tuner gefunden, Mute aus
		check("Mute aus: nichts gesendet, kein Hinweis", [e.since(i).map(hex), key()], [[], [false, "ok"]]);

		// Projekt mit gespeicherter Mute geöffnet, Deck verbunden: Die Abfrage meldet bit4 ohne Modus.
		e.feed([N.tuner(0x18, -49, 0, "--")]);
		check("bit2 = 0, bit3 = 1, bit4 = 1: genau einmal 0x13 00, Taste „stumm“, Lampe aus", [e.since(i).map(hex), key(), e.s.tunerActive()], [[mode(false)], [false, "stumm"], false]);
		ok("Log nennt den Grund", e.logs.some((l) => /Tuner-Mute steht außerhalb des Modus an/.test(l)), e.logs.slice(-3).join(" | "));
		i = e.sent.length;
		e.feed([N.tuner(0x18, -49, 0, "--"), N.tuner(0x18, -48, 0, "--")]); // Aufheben wirkt nicht
		check("Zustand hält an: kein weiteres 0x13 (keine Schleife), Hinweis bleibt", [e.since(i).map(hex), key()], [[], [false, "stumm"]]);
		e.feed([N.tuner(0x08, -48, 0, "--")]);
		check("Mute aufgehoben: Hinweis weg, nichts gesendet", [e.since(i).map(hex), key()], [[], [false, "ok"]]);
		e.feed([N.tuner(0x18, -48, 0, "--")]); // anderes Projekt, dessen Tuner noch stumm ist
		check("neues Eintreten: wieder genau einmal 0x13 00", e.since(i).map(hex), [mode(false)]);

		i = e.sent.length;
		check("„stumm“ sperrt nicht: Druck schaltet den Modus an, Hinweis sofort weg", [e.s.pressTuner(false), e.since(i).map(hex), key()], [true, [mode(true)], [true, "ok"]]);
		i = e.sent.length;
		e.feed([N.tuner(0x1c, -48, 0, "--")]); // Modus an, Mute an: so gehört es
		check("im Modus mit Mute: nichts gesendet, kein Hinweis", [e.since(i).map(hex), key()], [[], [true, "ok"]]);

		// Script im Modus neu geladen und zurück, bevor Pongs ausbleiben: kein Verbindungsaufbau,
		// die Abfrage meldet bit2 = 0 bei anliegender Mute.
		e.feed([N.tuner(0x18, -48, 0, "--")]);
		check("Script neu geladen: Deck übernimmt Modus aus und schickt 0x13 00", [e.s.tunerActive(), e.since(i).map(hex)], [false, [mode(false)]]);

		// Taste aus, das Aufheben scheitert („TUNER Fehler“ oder wirkungslos): Die nächste Meldung
		// zeigt die Mute ohne Modus, das Deck versucht es genau einmal mehr.
		e.feed([N.tuner(0x08, 0, 0, "--")]);
		e.s.pressTuner(false);
		e.feed([N.tuner(0x1c, 0, 0, "--")]);
		i = e.sent.length;
		e.s.pressTuner(false);
		check("Taste aus: 0x13 00, vor der Antwort kein Hinweis (die alte Messung war im Modus)", [e.since(i).map(hex), key()], [[mode(false)], [false, "ok"]]);
		e.feed([N.tuner(0x18, 0, 0, "--"), N.tuner(0x18, 0, 0, "--")]);
		check("Mute blieb an: genau ein zweites 0x13 00, dann „stumm“", [e.since(i).map(hex), key()], [[mode(false), mode(false)], [false, "stumm"]]);

		// Ohne Verbindung zählt kein 0x24; nach dem Pong gilt der Zustand neu.
		e.alive = false;
		for (let t = 250; t <= 9000 && e.s.connected; t += 250) e.step(t);
		check("Verbindung weg: Warte statt stumm", [e.s.connected, key()], [false, [false, "waiting"]]);
		i = e.sent.length;
		e.feed([N.tuner(0x18, 0, 0, "--")]);
		check("0x24 ohne Verbindung: nichts gesendet", e.since(i).map(hex), []);
		e.alive = true;
		e.step(10000);
		check("Pong: 0x13 00 und Abfrage wie immer", e.since(i).map(hex), [mode(false), "F0 7D 10 F7"]);
		e.feed([...ANSWER, N.tuner(0x18, 0, 0, "--")]);
		check("Antwort meldet die Mute noch: ein weiteres 0x13 00, „stumm“", [e.since(i).map(hex), key()], [[mode(false), "F0 7D 10 F7", mode(false)], [false, "stumm"]]);

		// Kein Tuner in Slot 1 (bit3 = 0): Es gibt keine Mute aufzuheben.
		const f = ready();
		const j = f.sent.length;
		f.feed([N.tuner(0x10, 0, 0, "")]);
		check("bit4 ohne bit3: nichts gesendet, „Tuner?“", [f.since(j).map(hex), status(f.s.toggleView("tuner").status)], [[], "Tuner?"]);
	}

	//==========================================================================
	section("Regler im Tuner-Modus gesperrt");
	{
		const e = ready();
		e.at(100);
		check("vorher: Drehen geht", e.s.turn(1, 1), true);
		e.at(3000);
		e.s.pressTuner(false);
		e.feed([N.tuner(0x0c, 0, 0, "--")]);
		const before = e.s.knob(1).value01;
		const n = e.sent.length;
		check("im Modus: Drehen und Drücken gesperrt, nichts gesendet", [e.s.turn(1, 1), e.s.turn(2, -3), e.s.center(0), e.sent.length], [false, false, false, n]);
		check("Wert unverändert", e.s.knob(1).value01, before);
		check("Presets bleiben wählbar", e.s.selectPreset("HMT"), true);
		e.s.pressTuner(false);
		e.feed([N.tuner(0x08, 0, 0, "--")]);
		check("Modus aus: Drehen geht wieder", e.s.turn(1, 1), true);
		check("Segment der Stimmanzeige = Parameter: Gain links … Treble rechts", [0, 1, 2, 3].map((p) => tunerSegmentFor(p)), [0, 1, 2, 3]);
		check("außerhalb 0..3 begrenzt", [tunerSegmentFor(5), tunerSegmentFor(-1)], [3, 0]);
	}

	//==========================================================================
	section("Änderungen gebündelt, Debugzeilen nur ins Log");
	{
		const e = env();
		e.step(0);
		const c = e.changes();
		for (const f of ANSWER) e.s.receive(f);
		e.flush();
		check("neun Frames, eine Änderungsmeldung", e.changes(), c + 1);
		const c2 = e.changes();
		e.feed(ANSWER);
		check("dieselbe Antwort noch einmal: keine Änderung", e.changes(), c2);
		e.feed([N.debug("Preset Gibtsnicht nicht übernommen, aktiv HMT")]);
		check("Debugzeile im Log, ohne Änderung", [e.logs[e.logs.length - 1], e.changes()], ["Nuendo: Preset Gibtsnicht nicht übernommen, aktiv HMT", c2]);
	}

	//==========================================================================
	section("Regler-Zuordnung: Setting vor Spalte");
	{
		check("ohne Setting: Spalten 0–3 -> Gain, Bass, Mid, Treble", [0, 1, 2, 3].map((c) => paramIndexFor(undefined, c)), [0, 1, 2, 3]);
		check("leeres Setting wie ohne", paramIndexFor("", 2), 2);
		check("Setting schlägt die Spalte", [paramIndexFor("treble", 0), paramIndexFor("gain", 3), paramIndexFor("mid", undefined)], [3, 0, 2]);
		check("Spalten 4 und 5 und ohne Spalte: Gain", [paramIndexFor(undefined, 4), paramIndexFor(undefined, 5), paramIndexFor(undefined, undefined)], [0, 0, 0]);
		check("unbekanntes Setting: Spalte", paramIndexFor("presence", 1), 1);
	}

	//==========================================================================
	section("Drossel der Anzeige (30 ms, letzter Stand gewinnt)");
	{
		let t = 0;
		let state = 0;
		const shown = [];
		const timers = [];
		const th = new Throttle(
			30,
			() => shown.push([t, state]),
			() => t,
			(fn, ms) => {
				timers.push({ fn, at: t + ms });
				return timers.length;
			},
			() => undefined,
		);
		const runTimers = (until) => {
			timers.sort((a, b) => a.at - b.at);
			while (timers.length && timers[0].at <= until) {
				const x = timers.shift();
				t = x.at;
				x.fn();
			}
			t = until;
		};
		state = 1;
		th.request();
		check("erster Aufruf sofort", shown, [[0, 1]]);
		t = 10;
		state = 2;
		th.request();
		t = 20;
		state = 3;
		th.request();
		check("innerhalb 30 ms: ein Lauf geplant", [shown.length, timers.length], [1, 1]);
		runTimers(30);
		check("bei 30 ms der neueste Stand", shown, [[0, 1], [30, 3]]);
		t = 45;
		state = 4;
		th.request();
		runTimers(60);
		check("nächster frühestens 30 ms nach dem letzten", shown[2], [60, 4]);
		t = 200;
		state = 5;
		th.request();
		check("nach einer Pause wieder sofort", shown[3], [200, 5]);
	}
	{
		// Intervall als Funktion: Regler 30 ms, Stimmanzeige 100 ms
		let t = 0;
		let interval = 30;
		const runs = [];
		const timers = [];
		const th = new Throttle(
			() => interval,
			() => runs.push(t),
			() => t,
			(fn, ms) => {
				timers.push({ fn, at: t + ms });
				return timers.length;
			},
			() => undefined,
		);
		th.request();
		interval = 100;
		t = 40;
		th.request();
		check("Intervall wird je Aufruf gelesen: Lauf geplant für 100 ms", timers.map((x) => x.at), [100]);
		t = 100;
		timers.shift().fn();
		check("Lauf bei 100 ms", runs, [0, 100]);
	}
};
