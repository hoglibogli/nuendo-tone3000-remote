/**
 * Löst den Suchlauf im Nuendo-Script aus und schreibt seine Ausgabe mit.
 *
 *   node tools/suchlauf.cjs                       Ping, Suchlauf, Ende
 *   node tools/suchlauf.cjs --kanal "Mono In 6"   anderer Zielkanal (Name in der MixConsole)
 *   node tools/suchlauf.cjs --beobachten 600      nach dem Suchlauf bis zu 600 s lang jede
 *                                                 Parameteränderung an Input 6 mitschreiben
 *
 * Aktionen nach dem Suchlauf, abgearbeitet in der Reihenfolge der Kommandozeile:
 *
 *   --setzen "<ziel>;<titel>;<modus>;<wert>"   Parameter setzen (mehrfach erlaubt), wartet
 *                                              auf "--- Setzen fertig ---", höchstens 10 s
 *        ziel   3 = Plugin in Insert-Slot 3, 3/slot = der Slot selbst (Bypass usw.)
 *        titel  exakter Parametertitel, Leerzeichen und "|" erlaubt, kein ";"
 *        modus  norm (0..1) | plain (Plain-Wert, z. B. Programmnummer) | text (Klartext)
 *   --puls "<ziel>;<titel>"                    norm 1, 250 ms warten, norm 0 (MIDI-CC-Weg)
 *   --befehl next|prev|browser|browser2        Nuendo-Befehl Preset/Next, /Previous,
 *                                              /Open Browser, /Open/Close Browser (der letzte
 *                                              ist ein falscher interner Name, die Gegenprobe).
 *                                              Drei Wege, wahlweise mit Anhang:
 *        next        SysEx 0x06: setProcessValue einer CustomValueVariable, 1, 150 ms, 0
 *        next/taste  SysEx 0x06: dasselbe auf einem Button-Element
 *        next/note   echte Note an diesem Button: Note On auf MIDI-Kanal 2, Velocity 127,
 *                    150 ms, dann Velocity 0 (Note = 0 next, 1 prev, 2 browser, 3 browser2).
 *                    Nur dieser Weg ist belegt — so löst die FaderBank ihre Befehle aus.
 *                    Seine Diagnosezeilen tragen im Script den Schlüssel "next/taste".
 *   --pause <s>                                Wartezeit nach jeder Aktion, Standard 3
 *
 * Mit mindestens einer Aktion läuft die Beobachtung automatisch: an vor der ersten
 * Aktion, aus nach der letzten Aktion plus Pause. Mit --beobachten N läuft sie danach
 * noch bis N Sekunden bzw. bis zur Stopp-Datei weiter. Beispiele:
 *
 *   node tools/suchlauf.cjs --setzen "3;Program;plain;2" --setzen "3;Program;plain;4"
 *   node tools/suchlauf.cjs --setzen "3;Program;text;HMT"
 *   node tools/suchlauf.cjs --puls "3;MIDI CC 0|20"
 *   node tools/suchlauf.cjs --befehl next
 *   node tools/suchlauf.cjs --befehl next --befehl next/taste --befehl next/note --pause 5
 *   node tools/suchlauf.cjs --setzen "3/slot;Bypass;norm;1" --setzen "3/slot;Bypass;norm;0"
 *
 * Werte mit Leerzeichen, "|" oder ";" in Anführungszeichen setzen — sie müssen als ein
 * Argument ankommen (PowerShell und cmd behandeln "|" und ";" in Anführungszeichen
 * als Text). Ein Wert darf als UTF-8 höchstens 100 Byte lang sein (beim Puls samt
 * ";norm;1"): Länger hat Nuendo noch nie etwas vom Werkzeug bekommen, und 100 Byte
 * Text je Frame ist die am Loopback erprobte Grenze der Gegenrichtung.
 *
 * Vor --befehl: in Nuendo das TONE3000-Fenster von Slot 3 öffnen und hineinklicken,
 * erst dann das Werkzeug starten. Next, Previous und Open Browser wirken auf das
 * Plugin-Fenster mit Fokus; ohne es kann auch ein richtiger Name canPerform=false
 * melden. Maßgeblich ist canPerform in der BEFEHL-Zeile zum Auslösezeitpunkt, nicht
 * die Zeile aus dem Suchlauf.
 *
 * Aktionen verlangen die passende Script-Fassung: Die erste Suchlaufzeile muss
 * "Protokoll 2" (oder höher) nennen. Eine ältere, noch ausgerollte Fassung verwirft
 * Setzen und Befehle still — dann bricht das Werkzeug vor der ersten Aktion ab
 * (Exit-Code 1): Script ausrollen, Nuendo neu starten.
 *
 * Kommt die Schlusszeile eines Setzens nicht binnen 10 s, werden die übrigen Aktionen
 * ausgelassen: Eine verspätete Schlusszeile würde sonst das Warten des nächsten
 * Auftrags beenden und die Zeilen der falschen Aktion zuordnen. Ein Puls setzt auch
 * nach einer Zeitüberschreitung noch auf 0 zurück, sonst gäbe der nächste keine Flanke.
 *
 * Strg+C (auch Strg+Pause oder Fenster schließen) beendet sauber: Lief die
 * Beobachtung, wird sie abgeschaltet, dann gehen die Ports zu (Exit-Code 130).
 *
 * Die Ausgabe landet zeilenweise in suchlauf/<Zeit>.txt, schon während des Laufs;
 * jede Aktion beginnt dort mit einer Zeile ">>> ...". Folgeänderungen (ÄNDERUNG-
 * Zeilen) kommen meist erst nach "--- Setzen fertig ---" und landen dank der Pause
 * noch vor der nächsten ">>>"-Zeile — mit --pause 0 können sie dahinter rutschen.
 * Eine Beobachtung endet vorzeitig, sobald die Datei suchlauf/stopp auftaucht.
 *
 * Reihenfolge: Nuendo läuft, das Projekt mit Input 6 ist geladen — erst dann
 * starten. Ein Port, der vor Nuendo geöffnet wurde, bleibt taub.
 *
 * Mehrere Läufe je Nuendo-Sitzung gehen: Am 2026-10-01 antwortete Nuendo nach
 * einem beendeten Lauf (Ports geschlossen) sieben Minuten später erneut, ohne
 * Neustart. Die FaderBank-Lehre "Plugin-Prozess stirbt -> Nuendos Ausgang tot"
 * hat sich hier nicht gezeigt — dort sendete Nuendo allerdings dauernd, hier nur
 * auf Anfrage. Kommt kein Pong, ist ein Nuendo-Neustart trotzdem der erste Griff.
 *
 * Die MIDI-Anbindung stammt vorerst aus dem FaderBank-Plugin; sobald dieses
 * Projekt ein eigenes Plugin mit eigener Installation hat, zeigt MIDI_HOME dorthin.
 */
const fs = require("fs");
const path = require("path");

const MIDI_HOME = path.join(
	__dirname, "..", "..", "DAW Controller mit Motorfader",
	"streamdeck-plugin", "com.sorg.faderbank.sdPlugin",
);
const { Input, Output } = require(path.join(MIDI_HOME, "node_modules", "@julusian", "midi"));

const PORT_TO_NUENDO = "sd_tone3000";
const PORT_FROM_NUENDO = "tone3000_sd";

const MANUFACTURER_ID = 0x7d;
const MSG_PING = 0x01;
const MSG_PROBE = 0x02;
const MSG_WATCH_ON = 0x03;
const MSG_WATCH_OFF = 0x04;
const MSG_SET = 0x05;
const MSG_COMMAND = 0x06;
const MSG_DEBUG = 0x7f;
const PROBE_END = "--- Suchlauf beendet ---";
const WATCH_START = "--- Beobachtung läuft ---";
const WATCH_END = "--- Beobachtung beendet ---";
const SET_END = "--- Setzen fertig ---";

// Erste Zeile des Suchlaufs ab Script-Protokoll 2; ältere Fassungen nennen keins.
const PROBE_HEAD = /^--- Suchlauf TONE3000 Remote, Protokoll (\d+), /;
const REQUIRED_PROTOCOL = 2;

const PROBE_TIMEOUT_S = 30;
const SET_TIMEOUT_S = 10;
const PULSE_MS = 250;
const COMMAND_HOLD_MS = 150;
const MAX_PAYLOAD_BYTES = 100;
// Reihenfolge = PRESET_COMMANDS im Script = Notennummer für den Weg "/note".
const COMMAND_KEYS = ["next", "prev", "browser", "browser2"];
const SET_MODES = ["norm", "plain", "text"];
// Note On auf MIDI-Kanal 2 — im Script bindToNote(1, index). Kanal 1 ist tabu,
// dort hängen die Mute-Tasten der Eingänge.
const NOTE_ON_COMMANDS = 0x91;

/** Zahl wie im Script: Dezimalkomma erlaubt, leer ist keine Zahl. */
function parseNumber(text) {
	const t = String(text).trim().replace(",", ".");
	if (t === "") return NaN;
	const n = Number(t);
	return Number.isFinite(n) ? n : NaN;
}

/** Text, der als SysEx zu Nuendo geht, auf MAX_PAYLOAD_BYTES (UTF-8) begrenzen. */
function checkPayloadLength(payload, option, value) {
	const n = Buffer.byteLength(payload, "utf8");
	if (n > MAX_PAYLOAD_BYTES) {
		throw new Error(`${option} "${value}": ${n} Byte Nutzlast, höchstens ${MAX_PAYLOAD_BYTES} (UTF-8)`);
	}
}

/** Ziel "3" oder "3/slot" — dieselbe Form, die das Script annimmt. */
function checkTarget(target, option, value) {
	if (!/^\s*\d+\s*(\/\s*slot)?\s*$/i.test(target)) {
		throw new Error(`${option} "${value}": Ziel "${target}" unverständlich (erwartet z. B. 3 oder 3/slot)`);
	}
}

function checkSet(value, option) {
	const parts = value.split(";");
	if (parts.length < 4) throw new Error(`${option} "${value}": erwartet "<ziel>;<titel>;<modus>;<wert>"`);
	checkTarget(parts[0], option, value);
	if (parts[1] === "") throw new Error(`${option} "${value}": Titel fehlt`);
	const mode = parts[2].trim().toLowerCase();
	if (!SET_MODES.includes(mode)) throw new Error(`${option} "${value}": Modus "${parts[2]}" unbekannt (norm, plain, text)`);
	if (mode !== "text" && Number.isNaN(parseNumber(parts.slice(3).join(";")))) {
		throw new Error(`${option} "${value}": Wert ist keine Zahl`);
	}
	checkPayloadLength(value, option, value);
}

function checkPulse(value, option) {
	const parts = value.split(";");
	if (parts.length !== 2 || parts[1] === "") throw new Error(`${option} "${value}": erwartet "<ziel>;<titel>"`);
	checkTarget(parts[0], option, value);
	checkPayloadLength(`${value};norm;1`, option, value);
}

function checkCommand(value, option) {
	const m = /^([a-z0-9]+)(\/(taste|note))?$/i.exec(value.trim());
	if (!m || !COMMAND_KEYS.includes(m[1].toLowerCase())) {
		throw new Error(`${option} "${value}": erwartet ${COMMAND_KEYS.join("|")}, wahlweise mit /taste oder /note`);
	}
}

/**
 * Kommandozeile in Optionen und eine geordnete Aktionsliste. Jeder Wert ist genau
 * ein argv-Element, Leerzeichen, "|" und ";" darin bleiben unangetastet.
 */
function parseArgs(argv) {
	const opts = { channel: undefined, watchSeconds: 0, pauseSeconds: 3, actions: [] };
	for (let i = 0; i < argv.length; i++) {
		const name = argv[i];
		const next = argv[i + 1];
		const hasValue = next !== undefined && !next.startsWith("--");
		const take = () => {
			if (!hasValue) throw new Error(`${name} braucht einen Wert`);
			i++;
			return next;
		};
		switch (name) {
			case "--kanal":
				opts.channel = take();
				checkPayloadLength(opts.channel, name, opts.channel);
				break;
			case "--beobachten":
				// Wie bisher: ohne (gültige) Zahl 600 s.
				opts.watchSeconds = 600;
				if (hasValue) opts.watchSeconds = Number(take()) || 600;
				break;
			case "--pause": {
				const s = parseNumber(take());
				if (Number.isNaN(s) || s < 0) throw new Error(`--pause "${next}": erwartet Sekunden >= 0`);
				opts.pauseSeconds = s;
				break;
			}
			case "--setzen": {
				const value = take();
				checkSet(value, name);
				opts.actions.push({ kind: "setzen", value });
				break;
			}
			case "--puls": {
				const value = take();
				checkPulse(value, name);
				opts.actions.push({ kind: "puls", value });
				break;
			}
			case "--befehl": {
				const value = take();
				checkCommand(value, name);
				opts.actions.push({ kind: "befehl", value: value.trim().toLowerCase() });
				break;
			}
			default:
				throw new Error(`Unbekanntes Argument "${name}" (siehe Kopfkommentar von tools/suchlauf.cjs)`);
		}
	}
	return opts;
}

let opts;
try {
	opts = parseArgs(process.argv.slice(2));
} catch (err) {
	console.error(err.message);
	process.exit(2);
}
const { channel, watchSeconds, pauseSeconds, actions } = opts;

const dir = path.join(__dirname, "..", "suchlauf");
fs.mkdirSync(dir, { recursive: true });
const stopFile = path.join(dir, "stopp");
if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);

function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const outFile = path.join(dir, `${stamp()}.txt`);

/** Exakter Portname — beide Namen enthalten "tone3000", ein Teilstring wäre mehrdeutig. */
function findPort(port, name) {
	for (let i = 0; i < port.getPortCount(); i++) {
		if (port.getPortName(i) === name) return i;
	}
	return -1;
}

/** Hex-ASCII zurück in Bytes, dann als UTF-8 lesen. */
function decodeText(payload) {
	const bytes = [];
	for (let i = 0; i + 1 < payload.length; i += 2) {
		bytes.push(parseInt(String.fromCharCode(payload[i], payload[i + 1]), 16));
	}
	return Buffer.from(bytes).toString("utf8");
}

/** Text als Hex-ASCII, wie das Script ihn erwartet. */
function encodeText(text) {
	return [...Buffer.from(text, "utf8").toString("hex").toUpperCase()].map((ch) => ch.charCodeAt(0));
}

function record(text) {
	console.log(text);
	fs.appendFileSync(outFile, text + "\n", "utf8");
}

const input = new Input();
const output = new Output();

const inIdx = findPort(input, PORT_FROM_NUENDO);
const outIdx = findPort(output, PORT_TO_NUENDO);
if (inIdx < 0 || outIdx < 0) {
	console.error(`Port fehlt: ${inIdx < 0 ? PORT_FROM_NUENDO : ""} ${outIdx < 0 ? PORT_TO_NUENDO : ""}`);
	process.exit(1);
}

let gotPong = false;
let finished = false;
let aborting = false;
let watching = false; // Beobachtung in Nuendo eingeschaltet und noch nicht wieder aus
let scriptProtocol = 0; // aus der ersten Suchlaufzeile, 0 = ältere Fassung
let waitingFor = null; // { text, resolve }

input.ignoreTypes(false, true, true);
input.on("message", (_delta, message) => {
	if (message[0] !== 0xf0 || message[1] !== MANUFACTURER_ID) return;
	if (message[2] === MSG_PING) {
		gotPong = true;
		return;
	}
	if (message[2] !== MSG_DEBUG) return;
	const text = decodeText(message.slice(3, message.length - 1));
	record(text);
	const head = PROBE_HEAD.exec(text);
	if (head) scriptProtocol = Number(head[1]);
	if (waitingFor && text === waitingFor.text) {
		const w = waitingFor;
		waitingFor = null;
		w.resolve(true);
	}
});
input.openPort(inIdx);
output.openPort(outIdx);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Auf eine bestimmte Zeile warten, höchstens `seconds` lang. Der Zeitgeber prüft
 * auf genau diesen Auftrag: Mehrere Setzen-Aufträge warten nacheinander auf
 * dieselbe Zeile, ein alter Zeitgeber darf den nächsten nicht abbrechen.
 */
function waitForLine(text, seconds) {
	return new Promise((resolve) => {
		const entry = { text, resolve };
		waitingFor = entry;
		setTimeout(() => {
			if (waitingFor === entry) {
				waitingFor = null;
				resolve(false);
			}
		}, seconds * 1000);
	});
}

/** Beobachten, bis die Zeit um ist oder suchlauf/stopp auftaucht. */
async function watchUntilStop(seconds) {
	const end = Date.now() + seconds * 1000;
	while (Date.now() < end) {
		if (aborting) return;
		if (fs.existsSync(stopFile)) {
			fs.unlinkSync(stopFile);
			record("(Stopp-Datei gefunden)");
			return;
		}
		await sleep(500);
	}
	record("(Beobachtungszeit abgelaufen)");
}

/** Nach finish() oder während eines Abbruchs geht nichts mehr hinaus. */
function send(bytes) {
	if (finished || aborting) return;
	output.sendMessage(bytes);
}

function sendSysex(type, payload) {
	send([0xf0, MANUFACTURER_ID, type, ...payload, 0xf7]);
}

/** Ein Setzen-Auftrag; wartet auf die Schlusszeile des Scripts. false = Zeit abgelaufen. */
async function sendSet(value) {
	const done = waitForLine(SET_END, SET_TIMEOUT_S);
	sendSysex(MSG_SET, encodeText(value));
	const ok = await done;
	if (!ok && !aborting) record(`ACHTUNG: kein "${SET_END}" nach ${SET_TIMEOUT_S} s für "${value}"`);
	return ok;
}

/** Command-Bindings brauchen beide Flanken: 1, kurz warten, 0 — als SysEx oder als echte Note. */
async function sendCommand(value) {
	const [key, way] = value.split("/");
	if (way === "note") {
		const note = COMMAND_KEYS.indexOf(key);
		send([NOTE_ON_COMMANDS, note, 0x7f]);
		await sleep(COMMAND_HOLD_MS);
		send([NOTE_ON_COMMANDS, note, 0x00]);
		return;
	}
	sendSysex(MSG_COMMAND, encodeText(`${value};1`));
	await sleep(COMMAND_HOLD_MS);
	sendSysex(MSG_COMMAND, encodeText(`${value};0`));
}

/** Eine Aktion; false heißt: Zeit abgelaufen, die übrigen nicht mehr schicken. */
async function runAction(action, n) {
	record(`>>> Aktion ${n}/${actions.length}: --${action.kind} "${action.value}"`);
	if (action.kind === "setzen") return sendSet(action.value);
	if (action.kind === "puls") {
		const up = await sendSet(`${action.value};norm;1`);
		await sleep(PULSE_MS);
		// Auch nach einer Zeitüberschreitung zurück auf 0: Bliebe der Parameter auf 1,
		// gäbe der nächste Puls keine Flanke mehr.
		const down = await sendSet(`${action.value};norm;0`);
		return up && down;
	}
	await sendCommand(action.value);
	return true;
}

function startWatching() {
	watching = true;
	sendSysex(MSG_WATCH_ON, []);
}

/** Beobachtung beenden und auf die Zusammenfassung warten. */
async function stopWatching() {
	const watchDone = waitForLine(WATCH_END, 15);
	sendSysex(MSG_WATCH_OFF, []);
	watching = false;
	return watchDone;
}

function finish(note, code = 0) {
	if (finished) return;
	finished = true;
	if (note) record(note);
	console.log(`\nAusgabe: ${outFile}`);
	input.closePort();
	output.closePort();
	setTimeout(() => process.exit(code), 100);
}

/**
 * Abbruch von außen (Strg+C) oder durch einen Fehler im Werkzeug. Lief die
 * Beobachtung, wird sie abgeschaltet — sonst meldete Nuendo jede weitere Änderung
 * in einen Port, den niemand mehr liest. Ein zweites Strg+C beendet sofort.
 */
async function abort(note, code) {
	if (finished) return;
	if (aborting) {
		process.exit(code);
		return;
	}
	aborting = true;
	record(note);
	if (watching) {
		watching = false;
		try {
			output.sendMessage([0xf0, MANUFACTURER_ID, MSG_WATCH_OFF, 0xf7]);
			record("(Beobachtung abgeschaltet)");
		} catch (err) {
			record(`ACHTUNG: Beobachtung ließ sich nicht abschalten (${err.message}); der nächste Suchlauf beendet sie.`);
		}
		await sleep(300);
	}
	finish(undefined, code);
}

for (const signal of ["SIGINT", "SIGBREAK", "SIGHUP"]) {
	process.on(signal, () => abort(`ACHTUNG: abgebrochen (${signal}).`, 130));
}

async function main() {
	send([0xf0, MANUFACTURER_ID, MSG_PING, 0xf7]);
	await sleep(1500);
	if (aborting || finished) return;
	if (!gotPong) {
		finish("Kein Pong von Nuendo. Läuft das Script (MIDI Remote Manager), und wurde Nuendo seit dem letzten Lauf neu gestartet?");
		return;
	}
	console.log("Nuendo antwortet, Suchlauf startet ...\n");

	const payload = channel ? encodeText(channel) : [];
	const probeDone = waitForLine(PROBE_END, PROBE_TIMEOUT_S);
	send([0xf0, MANUFACTURER_ID, MSG_PROBE, ...payload, 0xf7]);
	const probeOk = await probeDone;
	if (aborting || finished) return;
	if (!probeOk) {
		finish("ACHTUNG: Suchlauf nicht bis zum Ende gekommen, Ausgabe unvollständig.");
		return;
	}

	if (actions.length > 0) {
		if (scriptProtocol < REQUIRED_PROTOCOL) {
			const found = scriptProtocol > 0 ? `Protokoll ${scriptProtocol}` : "ohne Protokollangabe";
			finish(`ACHTUNG: Script veraltet (${found}, nötig ${REQUIRED_PROTOCOL}): Es verwirft Setzen und Befehle still. ` +
				"Script ausrollen und Nuendo neu starten. Keine Aktion ausgeführt.", 1);
			return;
		}

		// Beobachtung an, damit die Folgen jeder Aktion als ÄNDERUNG-Zeilen landen.
		const watchStarted = waitForLine(WATCH_START, 3);
		startWatching();
		if (!(await watchStarted)) record("ACHTUNG: Beobachtung nicht bestätigt, die Aktionen laufen trotzdem.");
		for (let a = 0; a < actions.length; a++) {
			if (aborting || finished) return;
			const ok = await runAction(actions[a], a + 1);
			await sleep(pauseSeconds * 1000);
			if (!ok) {
				const rest = actions.length - a - 1;
				if (rest > 0) record(`ACHTUNG: ${rest} weitere Aktion(en) ausgelassen, damit keine verspätete Schlusszeile dem nächsten Auftrag zugeordnet wird.`);
				break;
			}
		}
		if (aborting || finished) return;
		if (watchSeconds > 0) {
			console.log(`\nBeobachtung läuft weiter, bis zu ${watchSeconds} s; Ende vorzeitig mit der Datei ${stopFile}\n`);
			await watchUntilStop(watchSeconds);
		}
		if (aborting || finished) return;
		if (!(await stopWatching())) {
			finish("ACHTUNG: Ende der Beobachtung nicht bestätigt.");
			return;
		}
	} else if (watchSeconds > 0) {
		startWatching();
		console.log(`\nBeobachtung läuft bis zu ${watchSeconds} s; Ende vorzeitig mit der Datei ${stopFile}\n`);
		await watchUntilStop(watchSeconds);
		if (aborting || finished) return;
		if (!(await stopWatching())) {
			finish("ACHTUNG: Ende der Beobachtung nicht bestätigt.");
			return;
		}
	}
	finish();
}

main().catch((err) => abort(`ACHTUNG: Fehler im Werkzeug: ${(err && err.stack) || err}`, 1));
