/**
 * MidiManager gegen Ports im Speicher: exakte Namen, offene Handles bleiben offen,
 * fehlende Ports werden gesucht, verschwundene durch frische ersetzt. Die Portsuche
 * erzeugt keine Objekte (sie würden nie eingesammelt), nicht geöffnete werden
 * freigegeben, ein fehlendes natives Binding steht einmal im Log.
 */
"use strict";

const path = require("node:path");
const { section, check, ok } = require("./harness.cjs");
const fake = require("./fake-midi.cjs");

const build = path.join(__dirname, "..", "test-output", "build");
const { MidiManager, PORT_IN, PORT_OUT } = require(path.join(build, "midi", "midi-manager.js"));

function logger() {
	const lines = [];
	return {
		lines,
		info: (m) => lines.push(`I ${m}`),
		warn: (m) => lines.push(`W ${m}`),
		error: (m) => lines.push(`E ${m}`),
	};
}

const opened = (list) => list.filter((p) => p.openCalls > 0);
/** Schließen oder Freigeben — beides darf ein lebendes Handle nie treffen. */
const closes = (list) => list.reduce((n, p) => n + p.closeCalls + p.destroyCalls, 0);

module.exports = function run() {
	section("Portnamen exakt (protokoll.md 1)");
	check("Namen aus Sicht des Plugins", [PORT_OUT, PORT_IN], ["sd_tone3000", "tone3000_sd"]);
	fake.reset(["Anderer Port", "tone3000_sd 2", "tone3000_sd", "N_to_SD"], ["sd_tone3000_alt", "SD_to_N", "sd_tone3000"]);
	const log = logger();
	const mm = new MidiManager(fake.backend);
	mm.setLogger(log);
	check("vor maintain() nichts offen", [mm.hasInput(), mm.hasOutput(), opened(fake.created.inputs).length], [false, false, 0]);
	mm.maintain();
	const inp = opened(fake.created.inputs);
	const out = opened(fake.created.outputs);
	check("je genau ein Port geöffnet, mit exaktem Namen", [inp.map((p) => p.openName), out.map((p) => p.openName)], [["tone3000_sd"], ["sd_tone3000"]]);
	check("SysEx wird empfangen, Timing und Active Sensing nicht", inp[0].ignored, [false, true, true]);

	section("offene Handles bleiben offen");
	for (let i = 0; i < 5; i++) mm.maintain();
	check("fünfmal maintain(): nichts neu geöffnet, nichts geschlossen", [opened(fake.created.inputs).length, opened(fake.created.outputs).length, closes(fake.created.inputs) + closes(fake.created.outputs)], [1, 1, 0]);
	fake.ports.inputs.unshift("Neues USB-Gerät");
	fake.ports.outputs.unshift("Neues USB-Gerät");
	mm.maintain();
	check("Portliste geändert, unsere Ports noch da: unangetastet", [opened(fake.created.inputs).length, closes(fake.created.inputs) + closes(fake.created.outputs)], [1, 0]);
	check("Portsuche ohne Hilfsobjekte: je genau ein Objekt erzeugt", [fake.created.inputs.length, fake.created.outputs.length], [1, 1]);

	section("Senden und Empfangen");
	check("send() über den offenen Ausgang", [mm.send([0xf0, 0x7d, 0x01, 0xf7]), out[0].sent], [true, [[0xf0, 0x7d, 0x01, 0xf7]]]);
	const got = [];
	mm.addListener(() => {
		throw new Error("kaputter Empfänger");
	});
	mm.addListener((m) => got.push(m));
	fake.deliver("tone3000_sd", [0xf0, 0x7d, 0x22, 0x64, 0xf7]);
	check("Empfang erreicht die Empfänger, ein kaputter hält die anderen nicht auf", got, [[0xf0, 0x7d, 0x22, 0x64, 0xf7]]);
	ok("der Fehler steht im Log", log.lines.some((l) => /^E MIDI-Empfänger fehlgeschlagen/.test(l)));
	fake.deliver("tone3000_sd 2", [0xf0, 0x7d, 0x22, 0x00, 0xf7]);
	check("fremder Port mit ähnlichem Namen erreicht uns nicht", got.length, 1);

	section("verschwundener Port: Handle verworfen, später frisch geöffnet");
	fake.ports.inputs = fake.ports.inputs.filter((n) => n !== "tone3000_sd");
	mm.maintain();
	check("Eingang weg: totes Handle freigegeben (destroy)", [mm.hasInput(), inp[0].destroyCalls], [false, 1]);
	check("Ausgang bleibt offen, unangetastet", [mm.hasOutput(), out[0].closeCalls + out[0].destroyCalls], [true, 0]);
	mm.maintain();
	mm.maintain();
	const warns = log.lines.filter((l) => /^W MIDI-Eingang tone3000_sd nicht gefunden/.test(l)).length;
	check("fehlender Port nur einmal gemeldet", warns, 1);
	fake.ports.inputs.push("tone3000_sd");
	mm.maintain();
	const inp2 = opened(fake.created.inputs);
	check("Port wieder da: frisches Objekt geöffnet, das alte nicht wiederverwendet", [mm.hasInput(), inp2.length, inp2[1] !== inp[0], inp[0].openCalls], [true, 2, true, 1]);
	got.length = 0;
	fake.deliver("tone3000_sd", [0xf0, 0x7d, 0x01, 0xf7]);
	check("über das neue Handle kommt wieder etwas an", got.length, 1);

	section("Port fehlt beim Start");
	fake.reset(["Anderer Port"], ["Anderer Port"]);
	const mm2 = new MidiManager(fake.backend);
	const log2 = logger();
	mm2.setLogger(log2);
	for (let i = 0; i < 1200; i++) mm2.maintain(); // eine Stunde Portsuche im 3-s-Takt
	check("eine Stunde Suche ohne Nuendo: kein einziges Objekt erzeugt", [fake.created.inputs.length, fake.created.outputs.length], [0, 0]);
	check("nichts offen, send() liefert false statt zu werfen", [mm2.hasInput(), mm2.hasOutput(), mm2.send([0xf0, 0x7d, 0x10, 0xf7])], [false, false, false]);
	fake.ports.outputs.push("sd_tone3000");
	mm2.maintain();
	check("Ausgang erscheint: geöffnet, Eingang wird weiter gesucht", [mm2.hasOutput(), mm2.hasInput()], [true, false]);
	fake.ports.inputs.push("tone3000_sd");
	mm2.maintain();
	check("Eingang erscheint: geöffnet", mm2.hasInput(), true);

	section("Öffnen scheitert");
	fake.reset(["tone3000_sd"], ["sd_tone3000"]);
	const Orig = fake.backend.Input;
	let failOnce = true;
	class Flaky extends Orig {
		openPort(i) {
			if (failOnce) {
				failOnce = false;
				throw new Error("Port belegt (Test)");
			}
			super.openPort(i);
		}
	}
	const mm3 = new MidiManager({ Input: Flaky, Output: fake.backend.Output });
	const log3 = logger();
	mm3.setLogger(log3);
	mm3.maintain();
	check("Fehler beim Öffnen: kein Eingang, Zeile im Log", [mm3.hasInput(), log3.lines.some((l) => /^E MIDI-Eingang tone3000_sd lässt sich nicht öffnen/.test(l))], [false, true]);
	check("das nicht geöffnete Objekt ist freigegeben", fake.created.inputs[0].destroyCalls, 1);
	mm3.maintain();
	check("nächster Versuch gelingt", mm3.hasInput(), true);
	check("das neue Handle bleibt unangetastet", [fake.created.inputs[1].openCalls, fake.created.inputs[1].destroyCalls], [1, 0]);

	section("Port verschwindet zwischen Liste und Öffnen");
	fake.reset(["tone3000_sd"], ["sd_tone3000"]);
	class Gone extends Orig {
		getPortCount() {
			return 0;
		}
	}
	const mm4 = new MidiManager({ Input: Gone, Output: fake.backend.Output });
	mm4.maintain();
	check("nicht gefunden: kein Eingang, Objekt freigegeben, nichts geöffnet", [mm4.hasInput(), fake.created.inputs[0].openCalls, fake.created.inputs[0].destroyCalls], [false, 0, 1]);

	section("natives Binding fehlt (/lazy wirft erst beim Zugriff)");
	fake.reset(["tone3000_sd"], ["sd_tone3000"]);
	fake.failure.list = new Error("No native build was found (Test)");
	const mm5 = new MidiManager(fake.backend);
	const log5 = logger();
	mm5.setLogger(log5);
	for (let i = 0; i < 5; i++) mm5.maintain();
	const fails = log5.lines.filter((l) => /^E MIDI-Ports nicht lesbar: No native build/.test(l)).length;
	check("maintain() wirft nicht, Grund genau einmal im Log", [mm5.hasInput(), mm5.hasOutput(), fails], [false, false, 1]);
	fake.failure.list = null;
	mm5.maintain();
	check("Binding wieder da: Ports offen", [mm5.hasInput(), mm5.hasOutput()], [true, true]);

	section("Paket fehlt: geladen wird erst in maintain(), ein Fehler wirft nicht");
	fake.reset(["tone3000_sd"], ["sd_tone3000"]);
	let loads = 0;
	let missing = true;
	const mm6 = new MidiManager(() => {
		loads++;
		if (missing) throw new Error("Cannot find module '@julusian/midi/lazy' (Test)");
		return fake.backend;
	});
	const log6 = logger();
	mm6.setLogger(log6);
	check("Konstruktor lädt nichts", loads, 0);
	for (let i = 0; i < 3; i++) mm6.maintain();
	const missingLines = log6.lines.filter((l) => /^E MIDI-Ports nicht lesbar: Cannot find module/.test(l)).length;
	check("maintain() wirft nicht, Grund einmal im Log, jeder Versuch lädt neu", [mm6.hasInput(), missingLines, loads], [false, 1, 3]);
	missing = false;
	mm6.maintain();
	mm6.maintain();
	check("Paket da: einmal geladen, Ports offen", [loads, mm6.hasInput(), mm6.hasOutput()], [4, true, true]);
	fake.reset();
};
