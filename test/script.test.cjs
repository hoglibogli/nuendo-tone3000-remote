/**
 * Test des Nuendo-Scripts nuendo-script/Vincent_Tone3000.js gegen die nachgebaute API
 * (test/stub-api.cjs). Kein Nuendo, keine MIDI-Ports, nichts wird ausgerollt.
 *
 *   node test/script.test.cjs           Prüfungen ausführen, Exit-Code 1 bei Fehlschlag
 *   node test/script.test.cjs --voll    dazu die Script-Ausgabe aus Teil 1
 *
 * Teile:
 *   0  statisch: node --check, ES5-Scan (Nodes eingebauter acorn mit ecmaVersion 5,
 *      dazu nachgestellte Kommas, Semikolons, Methoden jenseits von ES5)
 *   1  Protokoll 2 wie bisher: Suchlauf, Beobachtung, Setzen, Befehle
 *   3  Protokoll 3: Abfrage, Regler, Presets, Tasten auf Kanal 3, Zustände, Slotnamen,
 *      Zielkanal falsch, TONE3000 fehlt, Objekt-IDs wechseln, Fehler des Hosts; dazu die
 *      Beispielsitzung aus docs/protokoll.md Byte für Byte (3g, mit Protokoll 4)
 *   4  Protokoll 4: Tuner-Modus (0x13), Stimmanzeige (0x24), Weiterleitung nur im Modus,
 *      Dedup, kein Tuner, Tuner-Objekt wechselt, Kosten im Callback, Sicherheit beim Verbinden
 *   5  Deck-Kanal folgt dem Namen "Mono In 6" (Befund 2026-10-06): einziger Eingang auf Platz 0,
 *      32 Eingänge wie früher, Eingänge ändern sich zur Laufzeit, Ziel fehlt (keine
 *      Dauer-Schieberei, Rundenbudget), mehr Eingänge als die Such-Zone (Rückfall), keine
 *      Selbstauslösung durch Zonen-Aktionen, Beobachtung am Deck-Kanal, Selbsttest der
 *      Zonen im Stub. Teile 1, 3 und 4 aktivieren mit start(): Aktivierung und Leerlauf,
 *      bis der Deck-Kanal steht — wo eine Prüfung fest Platz 6 annahm, steht der Grund dabei.
 *   2  das echte Werkzeug tools/suchlauf.cjs gegen das Script, als Kopie in einem
 *      Temp-Ordner; MIDI über ein Portpaar im Speicher (der Import von @julusian/midi
 *      wird abgefangen), Zeit 20-fach gerafft
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");
const { createHost, decodeFrame, framesToLines, frameShape, textToHex, hexToText, TAG, TUNER_TAG, LONG_TITLE } = require("./stub-api.cjs");

const ROOT = path.join(__dirname, "..");
// T3K_SCRIPT zeigt den Test auf eine Kopie (Gegenproben mit absichtlich kaputtem Script).
const SCRIPT = process.env.T3K_SCRIPT ? path.resolve(process.env.T3K_SCRIPT) : path.join(ROOT, "nuendo-script", "Vincent_Tone3000.js");
const TOOL_SRC = path.join(ROOT, "tools", "suchlauf.cjs");
const FULL = process.argv.includes("--voll");
const NODE_BIN = process.execPath;

const results = [];
let section = "";
function heading(name) {
	section = name;
}
function expect(cond, label) {
	results.push({ section, ok: !!cond, label });
}

const realLog = console.log;
const realError = console.error;
const out = (...a) => realLog(...a);

const allHosts = [];
function newHost(options) {
	const h = createHost(options);
	h.load(SCRIPT);
	allHosts.push(h);
	return h;
}

/**
 * Aktivieren und Leerlauf, bis die Deck-Suche fertig ist: Erst danach steht der Deck-Kanal
 * auf "Mono In 6" (in Nuendo läuft mOnIdle ständig). Die Suche meldet dabei, was der
 * Deck-Kanal jetzt zeigt; die Prüfungen danach messen ab hier.
 */
function start(h) {
	h.activate();
	h.settle();
	return h;
}
const DECK_ZONE = "Tone3000 Ziel";
const deckActions = (h) => h.zoneActions.filter((a) => a.zone === DECK_ZONE);
const actionList = (h, from = 0) => deckActions(h).slice(from).map((a) => (a.action === "mShiftRight" ? "R" : a.action === "mResetBank" ? "0" : a.action)).join("");

const sysexBytes = (type, data = []) => [0xf0, 0x7d, type, ...data, 0xf7];
const v14 = (v) => [v >> 7, v & 0x7f];

/** Zustandsframes von Protokoll 3 (0x20..0x23) ab einem Index; 0x24 zählt tunerFrames. */
function deckFrames(h, from = 0) {
	return h.sent.slice(from).map(decodeFrame).filter((d) => d && d.type >= 0x20 && d.type <= 0x23);
}
/** Stimmanzeige (0x24) ab einem Index. */
function tunerFrames(h, from = 0) {
	return h.sent.slice(from).map(decodeFrame).filter((d) => d && d.type === 0x24);
}
function debugLines(h, from = 0) {
	return framesToLines(h.sent.slice(from));
}
function describe(d) {
	const hx = (n) => "0x" + n.toString(16).padStart(2, "0");
	if (d.type === 0x20) return `20 p${d.p} ${d.value} "${d.text}"`;
	if (d.type === 0x21) return `21 "${d.name}"`;
	if (d.type === 0x22) return `22 ${hx(d.flags)}`;
	if (d.type === 0x23) return `23 s${d.slot} "${d.name}"`;
	if (d.type === 0x24) return `24 ${hx(d.flags)} ${d.cent} ${d.oct} "${d.note}"`;
	return hx(d.type);
}
const describeAll = (frames) => frames.map(describe).join(" | ");
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const hostSets = (h, from = 0) => h.log.slice(from).filter((l) => /^setParameter(Process|Display)Value /.test(l));

//==============================================================================
// Teil 0: statisch
//==============================================================================
heading("0 statisch");

let checkError = "";
try {
	execFileSync(NODE_BIN, ["--check", SCRIPT], { stdio: "pipe" });
} catch (e) {
	checkError = String(e.stderr || e.message).split("\n").slice(0, 4).join(" ");
}
expect(!checkError, `node --check ${checkError || "ohne Fehler"}`);

// Nodes eingebauter acorn (internal/deps) parst mit ecmaVersion 5: let, const, Pfeile,
// Template-Strings, Spread scheitern dort. Nachgestellte Kommas erlaubt ES5 in Literalen,
// die Script-Engine aber nicht — die und den Stil prüft die Tokenliste.
const ES5_CHECK = String.raw`
const fs = require("fs");
let acorn;
try { acorn = require("internal/deps/acorn/acorn/dist/acorn"); } catch (e) { console.log(JSON.stringify({ parser: false })); process.exit(0); }
const src = fs.readFileSync(process.argv[1], "utf8");
const res = { parser: true, parseError: "", tokenError: "", trailingCommas: [], semicolons: [], apis: [] };
try { acorn.parse(src, { ecmaVersion: 5, sourceType: "script" }); } catch (e) { res.parseError = e.message; }
// Methoden jenseits von ES5: an jedem Objekt, oder nur an einem bestimmten (Array.from,
// nicht aber PORTS.from).
const MEMBERS = new Set(["includes", "startsWith", "endsWith", "padStart", "padEnd", "repeat", "find", "findIndex",
	"fill", "trimStart", "trimEnd", "flat", "flatMap", "codePointAt"]);
const STATICS = new Map(Object.entries({ Array: ["from", "of"], Object: ["assign", "entries", "values", "is"], Number: ["isNaN", "isFinite", "isInteger", "parseFloat", "parseInt"],
	Math: ["trunc", "sign", "log2", "log10", "cbrt"], String: ["fromCodePoint", "raw"] }));
const NAMES = new Set(["Symbol", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect", "let"]);
try {
	const toks = [];
	for (const t of acorn.tokenizer(src, { ecmaVersion: 5, locations: true })) toks.push(t);
	const parens = [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i], prev = toks[i - 1], next = toks[i + 1];
		const l = t.type.label;
		if (l === "(") parens.push(!!prev && prev.type.keyword === "for");
		else if (l === ")") parens.pop();
		else if (l === ";" && !parens[parens.length - 1]) res.semicolons.push(t.loc.start.line);
		else if (l === "," && next && ["]", "}", ")"].indexOf(next.type.label) >= 0) res.trailingCommas.push(t.loc.start.line);
		else if (l === "." && next && next.type.label === "name" && MEMBERS.has(next.value)) res.apis.push(t.loc.start.line + ": ." + next.value);
		else if (l === "." && next && prev && prev.type.label === "name" && STATICS.has(prev.value) && STATICS.get(prev.value).includes(next.value)) {
			res.apis.push(t.loc.start.line + ": " + prev.value + "." + next.value);
		}
		else if (l === "name" && NAMES.has(t.value) && !(prev && prev.type.label === ".")) res.apis.push(t.loc.start.line + ": " + t.value);
	}
} catch (e) { res.tokenError = e.message; }
console.log(JSON.stringify(res));
`;

function es5Scan(file) {
	try {
		return JSON.parse(execFileSync(NODE_BIN, ["--expose-internals", "-e", ES5_CHECK, file], { stdio: "pipe" }).toString());
	} catch (e) {
		return { parser: false, error: String(e.message) };
	}
}

/** Rückfall ohne Parser: Kommentare und Strings entfernen, dann Muster suchen. */
function es5TextScan(file) {
	const src = fs.readFileSync(file, "utf8");
	let code = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			code += "\n";
		} else if (c === "/" && src[i + 1] === "*") {
			i = src.indexOf("*/", i + 2) + 1;
		} else if (c === "'" || c === '"') {
			const q = c;
			i++;
			while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
			code += '""';
		} else code += c;
	}
	const bad = [];
	const patterns = [/\blet\b/, /\bconst\b/, /=>/, /`/, /\.\.\./, /\.(includes|startsWith|endsWith|find|findIndex|assign|repeat)\(/, /,\s*[\]})]/, /;\s*$/m];
	for (const p of patterns) if (p.test(code)) bad.push(String(p));
	return bad;
}

const es5 = es5Scan(SCRIPT);
if (es5.parser) {
	expect(!es5.parseError, `ES5-Syntax (acorn, ecmaVersion 5): ${es5.parseError || "ok"}`);
	expect(!es5.tokenError, `Tokenliste vollständig ${es5.tokenError || ""}`);
	expect(es5.trailingCommas.length === 0, `keine nachgestellten Kommas (Zeilen: ${es5.trailingCommas.join(", ") || "-"})`);
	expect(es5.semicolons.length === 0, `keine Semikolons außerhalb von for-Köpfen (Zeilen: ${es5.semicolons.join(", ") || "-"})`);
	expect(es5.apis.length === 0, `keine Methoden/Objekte jenseits von ES5 (${es5.apis.join(", ") || "-"})`);
} else {
	const bad = es5TextScan(SCRIPT);
	expect(bad.length === 0, `ES5-Textscan (acorn nicht verfügbar): ${bad.join(" ") || "ok"}`);
}

//==============================================================================
// Teil 1: Protokoll 2 — alles wie bisher
//==============================================================================
heading("1 Protokoll 2");

const consoleLines = [];
console.log = (...a) => consoleLines.push(a.join(" "));

const H1 = newHost();
const mark = (text) => console.log("### " + text);
const sx = (h, type, text) => h.sysex(sysexBytes(type, text === undefined ? [] : textToHex(text)));
let setCount = 0;
let probeCount = 0;
const setzen = (text) => {
	setCount++;
	sx(H1, 0x05, text);
};
const befehl = (text) => sx(H1, 0x06, text);
const suchlauf = (text) => {
	probeCount++;
	sx(H1, 0x02, text);
};
// Der Parameter-Callback hängt am DirectAccess des Deck-Kanals (Deck-Zone, 1 Platz).
const accDeck = H1.accesses.find((a) => a.mOnParameterChange);
const cb = (id, tag) => H1.invoke("mOnParameterChange direkt", accDeck.mOnParameterChange, H1.device, H1.mapping, id, tag);

H1.setInputTitles();

mark("Setzen vor der Aktivierung");
setzen("3;Program;plain;2");
start(H1);
sx(H1, 0x01);

mark("Setzen ohne Suchlauf");
setzen("3;Program;plain;2");

mark("Suchlauf Mono In 3 (eigener Platz, Basis 1003), Beobachtung muss abgelehnt werden");
suchlauf("Mono In 3");
sx(H1, 0x03);
setzen("3;Program;plain;2");

mark("Suchlauf: Basis-ID wirft");
H1.fail("getBaseObjectID");
suchlauf();

mark("Suchlauf: Typabfrage auf Program wirft");
H1.fail("getParameterProcessValueType", { when: (a) => a[2] === TAG.program });
suchlauf();

mark("Kaputte Frames");
H1.sysex([0xf0, 0x7d, 0x05, ...textToHex("3;Program;plain;2")]); // ohne F7
setCount++;
H1.sysex([0xf0, 0x7d, 0x05, ...textToHex("3;Program;plain;2"), 0x41, 0xf7]); // ungerade
setCount++;
H1.sysex([0xf0, 0x7d, 0x05, 0x33, 0x47, 0xf7]); // "3G" kein Hex
setCount++;
H1.sysex([0xf0, 0x7d, 0x06, ...textToHex("next;1")]); // Befehl ohne F7

mark("Suchlauf Vorgabe + Beobachtung");
suchlauf();
sx(H1, 0x03);
cb(100, 4012); // Pegel am Kanal: muss gefiltert werden
H1.param(100, 1027).value = 1;
cb(100, 1027);
for (let k = 0; k < 10; k++) H1.setParam(403, TAG.input, k / 10);
cb(403, TAG.input); // gleicher Wert: nicht zählen
cb(999, 1); // fremdes Objekt: ignorieren

mark("Setzen: plain, norm, text auf Program");
setzen("3;Program;plain;2");
setzen("3;Program;norm;0,0236");
setzen("3;Program;text;Matchless");
mark("Setzen: Slot-Bypass");
setzen("3/slot;Bypass;norm;1");
setzen("3 / SLOT;Bypass;Norm;0");
mark("Puls MIDI CC 0|20");
setzen("3;MIDI CC 0|20;norm;1");
setzen("3;MIDI CC 0|20;norm;0");
mark("Langer Titel mit Umlauten, Text mit Semikolon");
setzen(`3;${LONG_TITLE};text;neu; mit Semikolon`);

mark("Fehlerfälle");
setzen("4;Program;plain;1");
setzen("17;Program;plain;1");
setzen("3;Programm;plain;1");
setzen("3;Program;plain;abc");
setzen("3;Program;plain;");
setzen("3;Program;plain;200");
setzen("3;Program;norm;-0.1");
setzen("3;Program;foo;1");
setzen("x;Program;plain;1");
setzen("3;Program");
setzen("3/slot;Program;plain;1");
H1.fail("setParameterProcessValue");
setzen("3;Program;plain;1");
H1.objects[100].kids = [];
setzen("3;Program;plain;1");
H1.objects[100].kids = [150, 200];

mark("Plugin neu geladen: neue IDs");
H1.replacePlugin(3, 503);
setzen("3;Program;plain;5");
setzen("3;Program;plain;6");

mark("Acht weitere Presetwechsel: jede Runde eigenes Zeilenbudget");
for (const v of [1, 2, 3, 4, 5, 6, 0, 1]) setzen(`3;Program;plain;${v}`);

mark("Befehle");
befehl("next;1");
befehl("next;0");
befehl("prev;1");
befehl("prev;0");
befehl("browser;1");
befehl("browser;0");
befehl("browser2;1");
befehl("browser2;0");
befehl("next/taste;1");
befehl("next/taste;0");
befehl("foo;1");
befehl("constructor;1");
befehl("next;2");
befehl("next");
mark("Note an der Taste von prev (Kanal 2, Note 1)");
H1.note(1, 1, 127);
H1.note(1, 1, 0);

sx(H1, 0x04);
mark("Nach der Beobachtung: Befehl ohne WERT/BINDING-Zeilen");
befehl("next;1");
befehl("next;0");

// Variante: "Program" mitten im MIDI-CC-Block (so war es für 0.0.9 erwartet)
const H1b = newHost({ programAt: 450 });
H1b.setInputTitles();
start(H1b);
sx(H1b, 0x02);
console.log = realLog;

const lines = debugLines(H1);
const has = (re) => lines.some((l) => re.test(l));
const count = (re) => lines.filter((l) => re.test(l)).length;
const idx = (re, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));
const between = (re, from, to) => lines.some((l, i) => i > from && i < to && re.test(l));

// Konsolenzeilen "TONE3000: ...", "ABFRAGE: ...", "Tuner: ..." und "Deck: ..." schreibt das Script bewusst nur in die Konsole.
const scriptConsole = consoleLines.filter((l) => !l.startsWith("### ") && l !== "TONE3000 Remote aktiv" && !/^(TONE3000|ABFRAGE|Tuner|Deck): /.test(l));
const h1Console = scriptConsole.slice(0, scriptConsole.length - debugLines(H1b).length);
expect(JSON.stringify(h1Console) === JSON.stringify(lines), "Frames ergeben dieselben Zeilen wie die Konsole");
expect(H1.callbackErrors.length === 0, `keine Ausnahme verlässt einen Callback (${H1.callbackErrors.join(" | ") || "0"})`);
const shape1 = frameShape(H1.sent);
expect(shape1.badByte === 0 && shape1.badFrame === 0, "alle Datenbytes < 0x80, jedes Frame F0 7D .. F7");
expect(shape1.maxLen <= 205, `längster Frame ${shape1.maxLen} <= 205 Byte`);

expect(has(/^SETZEN 3 abgelehnt: noch kein activeMapping/), "Setzen vor Aktivierung abgelehnt");
expect(has(/^SETZEN 3 abgelehnt: erst einen Suchlauf ausführen/), "Setzen ohne Suchlauf abgelehnt");
expect(count(/^--- Setzen fertig ---$/) === setCount, `jedes Setzen endet mit "--- Setzen fertig ---" (${setCount}x)`);
expect(count(/^--- Suchlauf TONE3000 Remote, Protokoll 4, Ziel "/) === probeCount, `Kopfzeile mit "Protokoll 4" in jedem Suchlauf (${probeCount}x)`);
expect(count(/^--- Suchlauf beendet ---$/) === probeCount, `jeder Suchlauf endet genau einmal mit der Schlusszeile, auch nach Ausnahmen (${probeCount}x)`);
expect(has(/^Ziel: Platz 3 "Mono In 3" \(per Name\)$/) && has(/^DA Basis id=1003 /), "Mono In 3: eigener Platz mit Basis 1003");
expect(has(/^SETZEN 3 abgelehnt: kein Unterobjekt "Inserts" am Kanal id=1003$/), "Setzen nach Suchlauf Mono In 3 nutzt das DirectAccess-Objekt dieses Laufs (Such-Zone, Platz 3)");
// Bis 2026-10-06: "Beobachtung nur auf Platz 6". Der Parameter-Callback hängt jetzt am Deck-Kanal.
expect(has(/^Beobachtung nur auf dem Deck-Kanal \("Mono In 6"\) möglich, der Suchlauf traf Platz 3$/), "Beobachtung nur auf dem Deck-Kanal");
expect(has(/^Deck-Kanal: "Mono In 6" \(bit5=1\), Deck-Suche: auf Platz 6 geschoben, 7 Zonen-Aktionen seit dem Laden$/), "Suchlauf nennt den Deck-Kanal, bit5 und die Deck-Suche");
expect(has(/^Ziel: Platz 6 "Mono In 6" \(per Name, Deck-Kanal\)$/) && has(/^DA Basis id=100 /), "Vorgabeziel Mono In 6: Platz 6, über den Deck-Kanal (Basis 100)");
const iBase = idx(/^Suchlauf Fehler: Error: getBaseObjectID verweigert \(Test\)$/);
expect(iBase >= 0 && lines[iBase + 1] === "--- Suchlauf beendet ---", "Suchlauf mit Ausnahme: Fehlerzeile + Schlusszeile");
const iTypeErr = idx(/^   44 tag=1886553053 "Program" Fehler: Error: getParameterProcessValueType verweigert \(Test\)$/);
expect(iTypeErr >= 0, "Ausnahme an einem Parameter: eine Zeile, Lauf geht weiter");
const iCmdBlock = idx(/^--- Befehle ---$/, iTypeErr);
expect(iTypeErr >= 0 && iCmdBlock > iTypeErr && idx(/^--- Suchlauf beendet ---$/, iTypeErr) > iCmdBlock, "nach dem Fehler läuft der Suchlauf weiter bis Befehle und Schlusszeile");
expect(has(/^SETZEN abgelehnt: Frame ohne F7 am Ende/), "kaputter Frame: ohne F7 abgelehnt");
expect(has(/^SETZEN abgelehnt: Nutzlast mit ungerader Länge/), "kaputter Frame: ungerade Nutzlast abgelehnt");
expect(has(/^SETZEN abgelehnt: Nutzlast ist kein Hex-Text \(Byte 4 = 71\)$/), "kaputter Frame: kein Hex-Text abgelehnt");
expect(has(/^BEFEHL abgelehnt: Frame ohne F7 am Ende/), "kaputter Befehl-Frame abgelehnt");

expect(has(/^   44 tag=1886553053 "Program" = "Calfinornia"  \| roh 0 vorg 0 \| plain 0\.\.127 \| discrete auto$/), "Program auf Index 44 gelistet (wie TONE3000 0.0.11)");
expect(has(/^   \(2080 "MIDI CC"-Parameter übersprungen, Index 45\.\.2124\)$/), "MIDI CC gezählt mit Index 45..2124");
expect(!has(/innerhalb des MIDI-CC-Blocks/), "Program vor dem MIDI-CC-Block: keine 'innerhalb'-Zeile");
const linesB = debugLines(H1b);
expect(linesB.some((l) => /^   450 tag=1886553053 "Program" = "Calfinornia"/.test(l)) &&
	linesB.includes('   (2080 "MIDI CC"-Parameter übersprungen, Index 44..2124)') &&
	linesB.includes('   innerhalb des MIDI-CC-Blocks: Index 450 tag=1886553053 "Program"'), "Variante 0.0.9: Program auf Index 450 als 'innerhalb des MIDI-CC-Blocks' gemeldet");
expect(has(/^   \.\.\. 50 weitere nicht gelistet \(Obergrenze 400 Zeilen\)$/), "Delay: 50 über der Obergrenze gezählt");
expect(has(/^\s+Slot 3 "TONE3000" tag=1886553053 "Program" = Calfinornia$/), "Program in der Fundliste");
for (const [name, ok] of [["Next", true], ["Previous", true], ["Open Browser", true], ["Open/Close Browser", false]]) {
	expect(has(new RegExp(`^Befehl Preset/${name.replace("/", "\\/")} canPerform=${ok}$`)), `canPerform ${name} (Variable) = ${ok}`);
	expect(has(new RegExp(`^Befehl Preset/${name.replace("/", "\\/")} \\(Taste\\) canPerform=${ok}$`)), `canPerform ${name} (Taste) = ${ok}`);
}

const i1 = idx(/^SETZEN 3 id=403 tag=1886553053 "Program" auto=1 lock=0 vorher "Calfinornia" roh 0 -> plain 2 \(normiert 0\.0157\)$/);
const i1Next = idx(/^SETZEN /, i1 + 1);
expect(i1 >= 0, "SETZEN plain 2: Kopfzeile");
const i1After = idx(/^NACHHER /, i1 + 1);
expect(i1 >= 0 && /^NACHHER "Einstein Vollgas" roh 0\.0157$/.test(lines[i1After]) && lines[i1After + 1] === "--- Setzen fertig ---", "SETZEN plain 2: NACHHER, dann Schlusszeile");
expect(between(/^ÄNDERUNG Slot 3 "TONE3000" tag=1128262618 "toneBass" = "6\.00"/, i1, i1Next), "SETZEN plain 2: Folgeänderung toneBass in der Beobachtung");
expect(count(/^ÄNDERUNG .* tag=1886553053 "Program"/) === 0, "Program meldet sich selbst nicht (wie am Gerät 2026-10-01)");
expect(has(/-> norm 0\.0236 \(normiert 0\.0236\)$/) && has(/^NACHHER "HMT" roh 0\.0236$/), "SETZEN norm mit Dezimalkomma -> HMT");
expect(has(/-> text "Matchless"$/) && has(/^NACHHER "Matchless"/), "SETZEN text -> Matchless");
expect(has(/^SETZEN 3\/slot id=303 tag=4102 "Bypass" auto=1 lock=0 vorher "Off" roh 0 -> norm 1 \(normiert 1\)$/), "SETZEN 3/slot Bypass 1");
expect(has(/^ÄNDERUNG Slot 3 tag=4102 "Bypass" = "On" roh 1$/), "Slot-Bypass in der Beobachtung");
expect(has(/^SETZEN 3 \/ SLOT id=303 tag=4102 "Bypass" .* -> norm 0 \(normiert 0\)$/), "SETZEN '3 / SLOT' mit Großschreibung, Modus 'Norm'");
expect(H1.log.includes("JUCE: MIDI CC 0|20 -> CC 20 Kanal 1 Wert 127") && H1.log.includes("JUCE: MIDI CC 0|20 -> CC 20 Kanal 1 Wert 0"), "Puls MIDI CC 0|20: 127 und 0 beim Host");
expect(has(new RegExp(`^SETZEN 3 id=403 tag=4999 "${LONG_TITLE}" .* -> text "neu; mit Semikolon"$`)), "langer Titel (69 Zeichen, Umlaut) gefunden, Text mit ';' vollständig");
expect(has(/^NACHHER "neu; mit Semikolon"/), "langer Titel: NACHHER");

expect(has(/^SETZEN 4 abgelehnt: Slot 4 ist leer$/), "Fehler: leerer Slot");
expect(has(/^SETZEN 17 abgelehnt: Slot 17 nicht vorhanden \(16 Slots\)$/), "Fehler: Slot nicht vorhanden");
expect(has(/^SETZEN 3 abgelehnt: Titel "Programm" nicht gefunden in Slot 3 "TONE3000" id=403 \(2125 Parameter durchsucht\)$/), "Fehler: unbekannter Titel");
expect(has(/^SETZEN 3 abgelehnt: Wert "abc" ist keine Zahl$/), "Fehler: Wert keine Zahl");
expect(has(/^SETZEN 3 abgelehnt: Wert "" ist keine Zahl$/), "Fehler: leerer Wert");
expect(has(/^SETZEN 3 abgelehnt: "Program" plain 200 ergibt normiert 1\.5748, außerhalb 0\.\.1$/), "Fehler: plain außerhalb");
expect(has(/^SETZEN 3 abgelehnt: "Program" norm -0\.1 ergibt normiert -0\.1, außerhalb 0\.\.1$/), "Fehler: norm negativ");
expect(has(/^SETZEN 3 abgelehnt: Modus "foo" unbekannt/), "Fehler: Modus");
expect(has(/^SETZEN x abgelehnt: Ziel "x" unverständlich/), "Fehler: Ziel");
expect(has(/^SETZEN abgelehnt: erwartet "<ziel>;<titel>;<modus>;<wert>", bekommen "3;Program"$/), "Fehler: Format");
expect(has(/^SETZEN 3\/slot abgelehnt: Titel "Program" nicht gefunden in Slot 3 id=303 \(4 Parameter durchsucht\)$/), "Fehler: Titel am Slot");
const iThrow = idx(/^SETZEN Fehler: Error: setParameterProcessValue verweigert \(Test\)$/);
expect(iThrow >= 0 && lines[iThrow + 1] === "--- Setzen fertig ---", "Ausnahme des Hosts: Fehlerzeile + Schlusszeile");
expect(has(/^SETZEN 3 abgelehnt: kein Unterobjekt "Inserts" am Kanal id=100$/), "Fehler: kein Inserts-Objekt");

const iNew = idx(/^   \(id=503 war seit dem Suchlauf neu, jetzt in der Beobachtung\)$/);
expect(iNew >= 0, "neue Plugin-ID erkannt");
expect(iNew >= 0 && /^SETZEN 3 id=503 tag=1886553053 "Program"/.test(lines[iNew + 1]), "Setzen trifft die neue ID 503");
expect(has(/^ÄNDERUNG Slot 3 "TONE3000" tag=1128262618 "toneBass" = "7\.00"/), "Beobachtung meldet die neue ID (Vox AC 30)");
expect(count(/war seit dem Suchlauf neu/) === 1, "neue ID nur einmal gemeldet");
const bassLines = count(/^ÄNDERUNG Slot 3 "TONE3000" tag=1128262618 "toneBass"/);
expect(bassLines === 13, `jeder der 13 Presetwechsel in der Beobachtung sichtbar (toneBass ${bassLines}x)`);
const iFirstSet = idx(/^SETZEN 3 id=403 /);
const inLines = lines.slice(0, iFirstSet).filter((l) => /^ÄNDERUNG .* "inputLevel"/.test(l)).length;
expect(inLines === 6, `innerhalb einer Runde höchstens 6 Zeilen je Parameter (inputLevel ${inLines})`);

expect(has(/^BEFEHL next 1 \(Preset\/Next, canPerform=true\)$/) && has(/^BEFEHL next 0 \(Preset\/Next, canPerform=true\)$/), "BEFEHL next 1/0");
expect(has(/^BEFEHL browser2 1 \(Preset\/Open\/Close Browser, canPerform=false\)$/), "BEFEHL browser2 mit canPerform=false");
expect(has(/^BEFEHL next\/taste 1 \(Preset\/Next, canPerform=true\)$/), "BEFEHL next/taste");
expect(has(/^BEFEHL abgelehnt: Schlüssel "foo" unbekannt/), "BEFEHL unbekannter Schlüssel");
expect(has(/^BEFEHL abgelehnt: Schlüssel "constructor" unbekannt/), "BEFEHL 'constructor' abgelehnt (kein Prototyp-Treffer)");
expect(has(/^BEFEHL next abgelehnt: Zustand "2"/) && has(/^BEFEHL next abgelehnt: Zustand ""/), "BEFEHL ungültiger/fehlender Zustand");
const iCmd = idx(/^BEFEHL next 1 \(/);
expect(lines[iCmd + 1] === "WERT next = 1" && lines[iCmd + 2] === "BINDING next feuert value=1 diff=1", "BEFEHL next 1: WERT- und BINDING-Zeile");
expect(has(/^BINDING next\/taste feuert value=0 diff=-1$/), "BEFEHL next/taste 0: BINDING mit fallender Flanke");
const iNote = lines.findIndex((l) => l === "WERT prev/taste = 1");
expect(iNote >= 0 && lines[iNote + 1] === "BINDING prev/taste feuert value=1 diff=1" && lines[iNote + 2] === "WERT prev/taste = 0", "Note Kanal 2 Nr. 1 erreicht die Taste von prev");
const ran = H1.log.filter((h) => /^Befehl /.test(h));
expect(JSON.stringify(ran) === JSON.stringify([
	"Befehl Preset/Next ausgeführt", "Befehl Preset/Previous ausgeführt", "Befehl Preset/Open Browser ausgeführt",
	"Befehl Preset/Open/Close Browser unbekannt, nichts passiert", "Befehl Preset/Next ausgeführt", "Befehl Preset/Previous ausgeführt",
	"Befehl Preset/Next ausgeführt",
]), "Host führt jeden Befehl auf der fallenden Flanke aus (auch per Note)");
const calls = H1.log.filter((l) => /^setProcessValue /.test(l)).map((l) => l.replace(/^setProcessValue (\S+) = (\S+)$/, "$1=$2")).join(" ");
expect(calls === "var:cmd_next=1 var:cmd_next=0 var:cmd_prev=1 var:cmd_prev=0 var:cmd_browser=1 var:cmd_browser=0 var:cmd_browser2=1 var:cmd_browser2=0 button@0,3=1 button@0,3=0 var:cmd_next=1 var:cmd_next=0", "setProcessValue-Aufrufe in Reihenfolge");
expect(H1.commandBindings.length === 8 && H1.commandBindings.every((b) => b.key.startsWith("Preset/")), "8 Command-Bindings, alle Kategorie Preset");
const iEnd = idx(/^--- Beobachtung beendet ---$/);
expect(has(/^--- Zusammenfassung: \d+ Parameter geändert ---$/) && iEnd >= 0, "Beobachtung sauber beendet");
expect(iEnd >= 0 && !lines.slice(iEnd).some((l) => /^(WERT|BINDING) /.test(l)) && lines.slice(iEnd).some((l) => /^BEFEHL next 1 /.test(l)), "ohne Beobachtung keine WERT/BINDING-Zeilen");
expect(!lines.some((l) => / Fehler: /.test(l) && !/verweigert \(Test\)/.test(l)), "keine unerwarteten Fehlerzeilen");

//==============================================================================
// Teil 3: Protokoll 3 — Betrieb fürs Stream Deck
//==============================================================================
console.log = (...a) => consoleLines.push(a.join(" "));

/** Ein Host im Normalzustand: Titel, Slotnamen, Delay im Bypass, aktiviert. */
function readyHost(options = {}, titles = {}) {
	const h = newHost(options);
	h.setInputTitles(titles);
	const slot3 = options.slot3 === undefined ? "TONE3000" : options.slot3 === "leer" ? "" : options.slot3;
	const slot1 = { tuner: "Tuner", gtr: "GTR Tuner Mono", leer: "" }[options.slot1 ?? "tuner"] ?? options.slot1;
	h.setSlotTitle(6, 0, slot1);
	h.setSlotTitle(6, 1, "H-Delay Mono");
	h.setSlotTitle(6, 2, slot3);
	h.setHostValue("ch6.slot1.bypass", 1); // Delay im Bypass wie am Gerät
	return h;
}

//--- A: Grundablauf --------------------------------------------------------------
heading("3a Abfrage, Regler, Presets");
const A = readyHost();
expect(A.sent.length === 0, `vor der Aktivierung sendet das Script nichts (Titel und Zustände nur gemerkt) (${A.sent.length} Frames)`);
A.activate();
expect(A.sent.length === 0, `mOnActivate sendet nichts (${A.sent.length} Frames)`);
A.settle();
expect(actionList(A) === "0RRRRRR" && A.zoneTarget(DECK_ZONE) === "ch6", `Leerlauf: Deck-Zone mit mResetBank und 6x mShiftRight auf Platz 6 (${actionList(A)})`);
expect(A.zoneActions.every((a) => a.zone === DECK_ZONE), "die Such-Zone wird nie verschoben");

let at = A.sent.length;
sx(A, 0x10);
const q1 = deckFrames(A, at);
const QUERY_1 = '20 p0 8178 "0.4992" | 20 p1 8192 "5.00" | 20 p2 8192 "5.00" | 20 p3 8192 "5.00" | 21 "Calfinornia" | 22 0x64 | 23 s0 "Tuner" | 23 s1 "H-Delay Mono" | 23 s2 "TONE3000"';
expect(describeAll(q1) === QUERY_1, `0x10: alle 9 Frames von Protokoll 3 in fester Reihenfolge (${describeAll(q1)})`);
const q1All = A.sent.slice(at).map(decodeFrame);
expect(q1All.map((d) => d.type.toString(16)).join(" ") === "20 20 20 20 21 22 23 23 23 24" && describe(q1All[9]) === '24 0x08 -49 0 "--"',
	`0x10: 0x24 als zehntes und letztes Frame, Tuner gefunden, Modus aus, Stille (${q1All.map(describe).join(" | ")})`);
expect(debugLines(A, at).length === 0 && hostSets(A).length === 0, "0x10: keine Debugzeile, nichts gesetzt");
at = A.sent.length;
sx(A, 0x10);
expect(describeAll(deckFrames(A, at)) === QUERY_1, "0x10 zweimal: wieder alles, ohne Dedup");

// Der Stub meldet eigene Sets eines Plugins nicht zurück (gerätenah, JUCE): 0x11 bleibt
// ohne Antwort. Der Weg mit Echo steht weiter unten an einem eigenen Host (AE).
at = A.sent.length;
let logAt = A.log.length;
A.sysex(sysexBytes(0x11, [1, ...v14(12000)]));
let sets = hostSets(A, logAt);
expect(sets.length === 1 && sets[0] === `setParameterProcessValue id=403 tag=${TAG.bass} ${12000 / 16383}`, `0x11 Bass 12000: Tag toneBass, normiert 12000/16383 (${sets.join(" / ")})`);
expect(deckFrames(A, at).length === 0 && debugLines(A, at).length === 0, `0x11 ohne Echo des Hosts: nichts zurück (${describeAll(deckFrames(A, at)) || "nichts"})`);
at = A.sent.length;
logAt = A.log.length;
A.sysex(sysexBytes(0x11, [1, ...v14(12000)]));
expect(hostSets(A, logAt).length === 1 && deckFrames(A, at).length === 0, "0x11 gleicher Wert: wieder gesetzt, nichts zurück");
at = A.sent.length;
logAt = A.log.length;
A.sysex(sysexBytes(0x11, [0, 0, 0]));
A.sysex(sysexBytes(0x11, [3, 0x7f, 0x7f]));
sets = hostSets(A, logAt);
expect(sets[0] === `setParameterProcessValue id=403 tag=${TAG.input} 0` && sets[1] === `setParameterProcessValue id=403 tag=${TAG.treble} 1`, `0x11 Grenzen: Gain 0 -> 0, Treble 16383 -> 1 (${sets.join(" / ")})`);
expect(deckFrames(A, at).length === 0, `0x11 Grenzen: nichts zurück (${describeAll(deckFrames(A, at)) || "nichts"})`);
at = A.sent.length;
logAt = A.log.length;
A.sysex(sysexBytes(0x11, [0, ...v14(8192)]));
expect(hostSets(A, logAt).join() === `setParameterProcessValue id=403 tag=${TAG.input} ${8192 / 16383}` && deckFrames(A, at).length === 0,
	`0x11 Mitte 8192 (Drücken auf Mitte): normiert 8192/16383 (${hostSets(A, logAt).join()})`);

at = A.sent.length;
A.setParam(403, TAG.mid, 0.25);
expect(describeAll(deckFrames(A, at)) === '20 p2 4096 "2.50"', `Hand am Plugin (Mid): 0x20 unverlangt (${describeAll(deckFrames(A, at))})`);
at = A.sent.length;
A.setParam(403, TAG.output, 0.3);
A.setParam(403, TAG.mid, 0.25);
expect(deckFrames(A, at).length === 0 && debugLines(A, at).length === 0, "anderer Parameter oder gleicher Wert: nichts gesendet");

at = A.sent.length;
logAt = A.log.length;
sx(A, 0x12, "HMT");
sets = hostSets(A, logAt);
let fr = deckFrames(A, at);
expect(sets.length === 1 && sets[0] === `setParameterDisplayValue id=403 tag=${TAG.program} "HMT"`, `0x12 HMT: setParameterDisplayValue auf Program (${sets.join(" / ")})`);
expect(fr.filter((d) => d.type === 0x21).map(describe).join() === '21 "HMT"', `0x12: genau ein 0x21 "HMT" (${describeAll(fr)})`);
// Gain hat das Deck zuletzt selbst gesetzt (8192): Die erste Meldung des Hosts dafür geht
// hinaus, obwohl sich der Wert nicht geändert hat — der Dedup für p0 war vergessen.
expect(sameSet(fr.filter((d) => d.type === 0x20).map(describe), ['20 p0 8192 "0.5000"', '20 p1 7372 "4.50"', '20 p2 8192 "5.00"', '20 p3 8192 "5.00"']),
	`0x12: Presetwechsel meldet alle Regler, die das Deck selbst gesetzt hat oder die sich ändern (${describeAll(fr)})`);
expect(debugLines(A, at).length === 0, "0x12: keine Debugzeile, wenn übernommen");
at = A.sent.length;
sx(A, 0x12, "HMT");
expect(deckFrames(A, at).length === 0 && debugLines(A, at).join() === "Preset HMT laut Host schon aktiv, ohne aktives Preset in TONE3000 wirkungslos",
	`0x12 auf das aktive Preset: kein 0x21 (Dedup), eine Debugzeile (${debugLines(A, at).join(" / ")})`);
at = A.sent.length;
logAt = A.log.length;
sx(A, 0x12, "Gibtsnicht");
expect(hostSets(A, logAt).length === 1 && deckFrames(A, at).length === 0, "0x12 unbekannter Name: gesetzt, kein 0x21");
expect(debugLines(A, at).join() === "Preset Gibtsnicht nicht übernommen, aktiv HMT", `0x12 unbekannter Name: Debugzeile (${debugLines(A, at).join(" / ")})`);
at = A.sent.length;
logAt = A.log.length;
sx(A, 0x12, "Ölfass");
expect(hostSets(A, logAt)[0] === `setParameterDisplayValue id=403 tag=${TAG.program} "Ölfass"` && debugLines(A, at).join() === "Preset Ölfass nicht übernommen, aktiv HMT", "0x12 mit Umlaut: UTF-8 kommt beim Host an");

at = A.sent.length;
A.loadPresetInPlugin(403, 4);
fr = deckFrames(A, at);
expect(fr.filter((d) => d.type === 0x21).map(describe).join() === '21 "JCM 2000"', `Preset im Plugin gewählt: 0x21 "JCM 2000" genau einmal, obwohl Program sich nicht meldet (${describeAll(fr)})`);
expect(sameSet(fr.filter((d) => d.type === 0x20).map(describe), ['20 p1 8552 "5.22"', '20 p2 7929 "4.84"', '20 p3 12582 "7.68"']), "Preset im Plugin gewählt: geänderte Regler als 0x20");
at = A.sent.length;
A.param(403, TAG.program).value = 5 / 127;
A.notifyChange(403, TAG.program);
expect(describeAll(deckFrames(A, at)) === '21 "Matchless"', `Callback für Program selbst: 0x21 (${describeAll(deckFrames(A, at))})`);

// Plugin-State geladen (.vstpreset, Projekt): JUCE unterdrückt die Meldungen der Regler,
// es kommt nur eine für einen anderen Parameter. Der neue Presetname zieht die vier nach.
at = A.sent.length;
A.param(403, TAG.program).value = 6 / 127; // Vox AC 30
A.param(403, TAG.bass).value = 0.7;
A.param(403, TAG.mid).value = 0.6;
A.param(403, TAG.treble).value = 0.65;
A.notifyChange(403, TAG.output);
expect(describeAll(deckFrames(A, at)) === '21 "Vox AC 30" | 20 p1 11468 "7.00" | 20 p2 9830 "6.00" | 20 p3 10649 "6.50"',
	`State geladen, nur eine Meldung: neuer Presetname, dann alle vier Regler nachgelesen (${describeAll(deckFrames(A, at))})`);

// Mit Echo des Hosts (am Gerät ungeprüft): 0x20 kommt aus dem Callback, Dedup danach.
const AE = readyHost({ ownSetsNotify: true });
start(AE);
sx(AE, 0x10);
at = AE.sent.length;
AE.sysex(sysexBytes(0x11, [1, ...v14(12000)]));
expect(describeAll(deckFrames(AE, at)) === '20 p1 12000 "7.32"', `mit Echo: 0x11 -> genau ein 0x20 mit 14 Bit + Klartext (${describeAll(deckFrames(AE, at))})`);
at = AE.sent.length;
AE.notifyChange(403, TAG.bass);
AE.notifyChange(403, TAG.bass);
expect(deckFrames(AE, at).length === 0, "mit Echo: weitere Meldungen mit gleichem Wert -> Dedup, nichts");
at = AE.sent.length;
AE.sysex(sysexBytes(0x11, [1, ...v14(12000)]));
expect(describeAll(deckFrames(AE, at)) === '20 p1 12000 "7.32"', `mit Echo: dasselbe 0x11 nochmals -> Echo geht wieder hinaus (Dedup nach 0x11 vergessen) (${describeAll(deckFrames(AE, at))})`);
at = AE.sent.length;
AE.sysex(sysexBytes(0x11, [0, 0, 0]));
AE.sysex(sysexBytes(0x11, [3, 0x7f, 0x7f]));
AE.sysex(sysexBytes(0x11, [2, ...v14(8192)]));
expect(describeAll(deckFrames(AE, at)) === '20 p0 0 "0.0000" | 20 p3 16383 "10.00" | 20 p2 8192 "5.00"', `mit Echo: Grenzen und Mitte (${describeAll(deckFrames(AE, at))})`);

// Befund aus dem Review: ohne Echo darf der alte Dedup-Stand eine spätere Meldung nicht schlucken.
const A2 = readyHost();
start(A2);
sx(A2, 0x10); // Mid 8192 "5.00" gesendet
A2.sysex(sysexBytes(0x11, [2, ...v14(12000)])); // Deck zeigt jetzt 7.32, kein Echo
at = A2.sent.length;
sx(A2, 0x12, "HMT"); // HMT setzt Mid auf 0.5 zurück
fr = deckFrames(A2, at);
expect(fr.some((d) => describe(d) === '20 p2 8192 "5.00"') && fr.some((d) => describe(d) === '20 p1 7372 "4.50"') && fr.filter((d) => d.type === 0x20).length === 2,
	`0x11 ohne Echo, danach Preset mit Mid 5.00: 0x20 p2 geht hinaus, obwohl zuletzt "8192|5.00" gesendet war (${describeAll(fr)})`);

// Ohne aktives Preset zeigt "Program" den Namen von Programm 0; ein Wechsel darauf wird verschluckt.
const A3 = readyHost();
start(A3);
sx(A3, 0x10);
at = A3.sent.length;
logAt = A3.log.length;
sx(A3, 0x12, "Calfinornia");
expect(hostSets(A3, logAt).length === 1 && !A3.log.slice(logAt).some((l) => /lädt Preset/.test(l)), "0x12 auf Programm 0 einer frischen Instanz: gesetzt, aber nichts geladen (wie TONE3000)");
expect(deckFrames(A3, at).length === 0 && debugLines(A3, at).join() === "Preset Calfinornia laut Host schon aktiv, ohne aktives Preset in TONE3000 wirkungslos",
	`0x12 auf Programm 0: kein 0x21, Debugzeile "schon aktiv" (${debugLines(A3, at).join(" / ")})`);

// Presetname mit 4-Byte-Zeichen: hinaus als 0x21, herein per 0x12 wählbar.
at = A3.sent.length;
logAt = A3.log.length;
sx(A3, 0x12, "Lead \u{1F525}");
fr = deckFrames(A3, at);
expect(hostSets(A3, logAt)[0] === `setParameterDisplayValue id=403 tag=${TAG.program} "Lead \u{1F525}"`, `0x12 mit Emoji: Name kommt vollständig beim Host an (${hostSets(A3, logAt).join(" / ")})`);
expect(fr.filter((d) => d.type === 0x21).map(describe).join() === '21 "Lead \u{1F525}"' && debugLines(A3, at).length === 0, `0x12 mit Emoji: 0x21 zurück, keine Debugzeile (${describeAll(fr)})`);

//--- Tasten auf Kanal 3 ------------------------------------------------------------
heading("3b Tasten, Zustände, Slotnamen");
const svFor = (h, ch, note) => h.surfaceValues.find((s) => s.note && s.note.channel === ch && s.note.note === note);
const NOTE_TARGETS = ["ch6.mute", "ch6.slot0.edit", "ch6.slot1.bypass", "ch6.slot1.edit", "ch6.slot2.edit"];
for (let n = 0; n < NOTE_TARGETS.length; n++) {
	const sv = svFor(A, 2, n);
	const bs = sv ? A.bindings.filter((b) => b.sv === sv) : [];
	// Gebunden an den Wert des Deck-Kanals; der zeigt nach der Deck-Suche auf ch6.
	expect(sv && sv.inputPort === A.midiInput && bs.length === 1 && bs[0].hv.zoneValue && bs[0].hv.channel.zone.name === DECK_ZONE && bs[0].hv.key === NOTE_TARGETS[n] && !bs[0].toggle,
		`Kanal 3 Note ${n} -> Value-Binding am Deck-Kanal, jetzt ${NOTE_TARGETS[n]}, ohne Toggle (${bs.map((b) => b.hv.key).join() || "keins"})`);
}
expect(!A.surfaceValues.some((s) => s.note && s.note.channel === 2 && s.note.note > 4), "Kanal 3: nur Noten 0..4 gebunden");
expect(A.bindings.every((b) => !b.toggle), "nirgends setTypeToggle");
const vw = A.viewers;
expect(vw.length === 3 && vw.every((v, i) => v.zoneName === DECK_ZONE && v.channelKey === "ch6" && v.slot === i && v.zone.paramValues === 1 && typeof v.zone.titleHandler === "function") &&
	new Set(vw.map((v) => v.name)).size === 3, `3 Insert-Viewer am Deck-Kanal (jetzt ch6), Slot-Index 0..2, je ein Parameterwert der Zone und ein Titel-Callback (${vw.map((v) => `${v.name}@${v.channelKey}/${v.slot}`).join(", ")})`);
expect(A.zones.length === 2 && A.zones.every((z) => z.inputsOnly) && A.zones[0].name === "Eingaenge" && A.zones[0].channels.length === 32 &&
	A.zones[1].name === DECK_ZONE && A.zones[1].channels.length === 1 && A.channels.length === 33, "Such-Zone (32 Plätze) und Deck-Zone (1 Platz), beide includeInputChannels");
const pos = A.buttons.map((b) => `${b.x},${b.y}`);
expect(new Set(pos).size === pos.length, "keine zwei Tasten auf derselben Surface-Position");
expect(A.buttons.filter((b) => b.y === 5).length === 5 && !A.buttons.some((b) => b.y === 5 && b.x > 4), "Deck-Tasten in Zeile 5, x 0..4");
let oldOk = true;
for (let i = 0; i < 32; i++) {
	const sv = svFor(A, 0, i);
	const bs = sv ? A.bindings.filter((b) => b.sv === sv) : [];
	if (!(bs.length === 1 && bs[0].hv.key === `ch${i}.mute`)) oldOk = false;
}
expect(oldOk, "Kanal 1 Noten 0..31 weiter an der Mute der Eingänge");
expect([0, 1, 2, 3].every((n) => A.commandBindings.some((c) => c.sv === svFor(A, 1, n))), "Kanal 2 Noten 0..3 weiter an den Preset-Befehlen");
const withParamCb = A.accesses.filter((a) => a.mOnParameterChange);
expect(withParamCb.length === 1 && withParamCb[0]._channel.zone.name === DECK_ZONE, "mOnParameterChange nur am Deck-Kanal, nicht an den 32 Plätzen der Such-Zone");
expect(A.accesses.filter((a) => a.mOnObjectChange).every((a) => a._channel.zone.name === DECK_ZONE) && A.accesses.filter((a) => a.mOnObjectChange).length === 1, "mOnObjectChange nur am Deck-Kanal");

const press = (h, ch, note, vel) => {
	const from = h.sent.length;
	h.note(ch, note, vel);
	return deckFrames(h, from);
};
const flagSteps = [
	["Mute an", 2, 0, 127, "22 0x65"],
	["Mute an (nochmals)", 2, 0, 127, ""],
	["Mute aus", 2, 0, 0, "22 0x64"],
	["Tuner-Fenster auf", 2, 1, 127, "22 0x66"],
	["Delay-Bypass aus", 2, 2, 0, "22 0x62"],
	["Delay-Fenster auf", 2, 3, 127, "22 0x6a"],
	["TONE3000-Fenster auf", 2, 4, 127, "22 0x7a"],
	["Mute über die alte Kanal-1-Taste", 0, 6, 127, "22 0x7b"],
	["Mute über Kanal 1 aus", 0, 6, 0, "22 0x7a"],
	["Mute von Platz 5 (Kanal 1)", 0, 5, 127, ""],
];
for (const [label, ch, note, vel, want] of flagSteps) {
	const got = describeAll(press(A, ch, note, vel));
	expect(got === want, `${label}: ${want || "nichts"} (${got || "nichts"})`);
}
expect(A.hostValue("ch6.mute") === 0 && A.hostValue("ch6.slot2.edit") === 1 && A.hostValue("ch6.slot1.bypass") === 0, "Hostwerte folgen den Noten");
at = A.sent.length;
A.setHostValue("ch6.slot2.edit", 0);
expect(describeAll(deckFrames(A, at)) === "22 0x6a", "Fenster in Nuendo geschlossen: 0x22 unverlangt");
at = A.sent.length;
A.setHostValue("ch6.slot1.bypass", 1);
expect(describeAll(deckFrames(A, at)) === "22 0x6e", "Delay in Nuendo auf Bypass: 0x22 bit2");

at = A.sent.length;
A.setSlotTitle(6, 1, "H-Delay Stereo");
A.setSlotTitle(6, 1, "H-Delay Stereo");
expect(describeAll(deckFrames(A, at)) === '23 s1 "H-Delay Stereo"', "Slotname geändert: 0x23 einmal (Dedup)");
at = A.sent.length;
const longName = "Ä".repeat(60) + "x".repeat(40);
A.setSlotTitle(6, 0, longName);
const longFrame = A.sent[A.sent.length - 1];
fr = deckFrames(A, at);
expect(fr.length === 1 && fr[0].name === "Ä".repeat(50) && longFrame.length === 205, `langer Name: auf 100 Byte an der Zeichengrenze gekürzt, Frame ${longFrame.length} Byte`);
at = A.sent.length;
A.setSlotTitle(6, 0, "x".repeat(150));
fr = deckFrames(A, at);
expect(fr.length === 1 && fr[0].name === "x".repeat(100) && A.sent[A.sent.length - 1].length === 205, "langer ASCII-Name: genau 100 Byte, Frame 205 Byte");
at = A.sent.length;
A.param(403, TAG.mid).display = (v) => "Ü".repeat(20) + (v * 10).toFixed(2);
A.setParam(403, TAG.mid, 0.3);
fr = deckFrames(A, at);
expect(fr.length === 1 && fr[0].text === "Ü".repeat(16) && A.sent[A.sent.length - 1].length === 71, `langer Klartext in 0x20: auf 32 Byte gekürzt, Frame 71 Byte (${describeAll(fr)})`);
A.param(403, TAG.mid).display = (v) => (v * 10).toFixed(2);
A.setParam(403, TAG.mid, 0.25);

const callsAt = A.calls.total;
A.sysex(sysexBytes(0x11, [1, ...v14(11000)]));
expect(A.calls.total - callsAt <= 6, `0x11 mit gemerktem TONE3000: ${A.calls.total - callsAt} DirectAccess-Aufrufe (<= 6)`);
const tagCallsAt = A.calls.getParameterTagByIndex || 0;
sx(A, 0x10);
expect((A.calls.getParameterTagByIndex || 0) === tagCallsAt, "Abfrage mit unveränderter Objekt-ID: Tags nicht neu gesucht");

at = A.sent.length;
sx(A, 0x02);
sx(A, 0x03);
A.setParam(403, TAG.mid, 4000 / 16383); // Hand am Plugin: derselbe Callback bedient beide
sx(A, 0x04);
expect(debugLines(A, at).some((l) => /^ÄNDERUNG Slot 3 "TONE3000" tag=1006241759 "toneMid" = "2\.44"/.test(l)) &&
	describeAll(deckFrames(A, at)) === '20 p2 4000 "2.44"', "Beobachtung läuft neben dem Betrieb: ÄNDERUNG-Zeile und 0x20");

//--- B: Zielkanal falsch -----------------------------------------------------------
heading("3c Zielkanal falsch, TONE3000 fehlt");
// Bis 2026-10-06 hieß "Zielkanal falsch": Platz 6 trägt einen anderen Titel, bit5 = 0. Jetzt
// folgt der Deck-Kanal dem Namen — mit vertauschten Titeln steht er auf Platz 7 (ch7, dort
// ohne Inserts): bit5 an, bit6 aus. bit5 = 0 gibt es nur noch, wenn "Mono In 6" fehlt (B).
const BS = start(readyHost({}, { 6: "Mono In 7", 7: "Mono In 6" }));
at = BS.sent.length;
sx(BS, 0x10);
expect(BS.zoneTarget(DECK_ZONE) === "ch7" && actionList(BS) === "0RRRRRRR" && describeAll(deckFrames(BS, at)) === '21 "" | 22 0x20 | 23 s0 "" | 23 s1 "" | 23 s2 ""',
	`Titel vertauscht: Deck-Kanal folgt "Mono In 6" auf Platz 7, bit5 an, dort kein TONE3000 (${actionList(BS)} / ${describeAll(deckFrames(BS, at))})`);

// "Mono In 6" gibt es nicht: Der einzige Eingang ist ch6 unter anderem Namen. Nichts zu
// suchen, der Deck-Kanal bleibt dort; Tasten wirken, Regler und Presets nicht.
const B = start(readyHost({ inputs: [{ key: "ch6", title: "Gitarre" }] }));
expect(deckActions(B).length === 0 && B.zoneTarget(DECK_ZONE) === "ch6", `"Mono In 6" fehlt, keine weiteren Eingänge: keine Zonen-Aktion (${actionList(B) || "keine"})`);
at = B.sent.length;
sx(B, 0x10);
fr = deckFrames(B, at);
const flagsB = fr.find((d) => d.type === 0x22);
expect(flagsB && (flagsB.flags & 0x20) === 0 && (flagsB.flags & 0x40) === 0x40, `Deck-Kanal "Gitarre": bit5 aus, bit6 an (${describeAll(fr)})`);
at = B.sent.length;
logAt = B.log.length;
B.sysex(sysexBytes(0x11, [1, ...v14(9000)]));
B.sysex(sysexBytes(0x11, [1, ...v14(9100)]));
expect(hostSets(B, logAt).length === 0, "bit5 aus: 0x11 setzt nichts");
expect(debugLines(B, at).join(" / ") === 'TONE3000 Bass abgelehnt: Deck-Kanal heißt "Gitarre", nicht "Mono In 6"', `bit5 aus: eine Debugzeile, die Wiederholung nicht (${debugLines(B, at).join(" / ")})`);
at = B.sent.length;
sx(B, 0x12, "HMT");
expect(hostSets(B, logAt).length === 0 && debugLines(B, at).join() === 'Preset HMT abgelehnt: Deck-Kanal heißt "Gitarre", nicht "Mono In 6"', "bit5 aus: 0x12 abgelehnt");
at = B.sent.length;
B.setInputTitle(0, "Mono In 6");
expect(describeAll(deckFrames(B, at)) === "22 0x64", `umbenannt in "Mono In 6": 0x22 mit bit5 unverlangt (${describeAll(deckFrames(B, at))})`);
B.settle();
expect(deckActions(B).length === 0, "dafür nichts geschoben");
logAt = B.log.length;
B.sysex(sysexBytes(0x11, [1, ...v14(9000)]));
expect(hostSets(B, logAt).length === 1, "danach wirkt 0x11");

//--- C: TONE3000 fehlt in Slot 3 ------------------------------------------------------
const C = readyHost({ slot3: "leer" });
start(C);
at = C.sent.length;
sx(C, 0x10);
expect(describeAll(deckFrames(C, at)) === '21 "" | 22 0x24 | 23 s0 "Tuner" | 23 s1 "H-Delay Mono" | 23 s2 ""',
	`Slot 3 leer: kein 0x20, 0x21 leer, bit6 aus (${describeAll(deckFrames(C, at))})`);
at = C.sent.length;
logAt = C.log.length;
C.sysex(sysexBytes(0x11, [0, ...v14(9000)]));
sx(C, 0x12, "HMT");
expect(hostSets(C, logAt).length === 0, "ohne TONE3000: nichts gesetzt");
expect(debugLines(C, at).join(" / ") === "TONE3000 Gain abgelehnt: kein TONE3000 in Slot 3 / Preset HMT abgelehnt: kein TONE3000 in Slot 3", `ohne TONE3000: Debugzeilen (${debugLines(C, at).join(" / ")})`);
at = C.sent.length;
C.replacePlugin(3, 603);
C.setSlotTitle(6, 2, "TONE3000");
fr = deckFrames(C, at);
expect(fr.length === 7 && fr[0].type === 0x23 && fr[1].type === 0x22 && fr[1].flags === 0x64 && fr.filter((d) => d.type === 0x20).length === 4 && fr[6].type === 0x21 && fr[6].name === "Calfinornia",
	`TONE3000 eingesetzt: 0x23, 0x22 mit bit6, 4x 0x20, 0x21 (${describeAll(fr)})`);
logAt = C.log.length;
C.sysex(sysexBytes(0x11, [1, ...v14(1000)]));
expect(hostSets(C, logAt).join() === `setParameterProcessValue id=603 tag=${TAG.bass} ${1000 / 16383}`, "danach setzt 0x11 auf das neue Objekt 603");

const C2 = readyHost({ slot3: "Pro-Q 3" });
start(C2);
at = C2.sent.length;
sx(C2, 0x10);
expect(describeAll(deckFrames(C2, at)) === '21 "" | 22 0x24 | 23 s0 "Tuner" | 23 s1 "H-Delay Mono" | 23 s2 "Pro-Q 3"', `anderes Plugin in Slot 3: bit6 aus (${describeAll(deckFrames(C2, at))})`);

//--- D: Objekt-IDs wechseln, Fehler des Hosts ----------------------------------------
heading("3d Objekt-IDs, Fehler des Hosts");
const D = readyHost();
start(D);
sx(D, 0x10);
at = D.sent.length;
D.replacePlugin(3, 503, { removeCallback: true, objectChange: true });
expect(deckFrames(D, at).length === 0, "neu geladen mit mOnObjectChange, gleiche Werte: nichts gesendet (Dedup)");
logAt = D.log.length;
D.sysex(sysexBytes(0x11, [1, ...v14(9000)]));
expect(hostSets(D, logAt).join() === `setParameterProcessValue id=503 tag=${TAG.bass} ${9000 / 16383}`, "nach mOnObjectChange: 0x11 trifft die neue ID 503");
D.replacePlugin(3, 703); // still: kein Callback
logAt = D.log.length;
D.sysex(sysexBytes(0x11, [2, ...v14(5000)]));
expect(hostSets(D, logAt).join() === `setParameterProcessValue id=703 tag=${TAG.mid} ${5000 / 16383}`, "still neu geladen: Titel des gemerkten Objekts passt nicht mehr -> 0x11 trifft 703");
D.replacePlugin(3, 803);
at = D.sent.length;
D.setParam(803, TAG.bass, 0.9);
expect(describeAll(deckFrames(D, at)) === '20 p1 14745 "9.00" | 20 p2 8192 "5.00"',
	`still neu geladen, Hand am neuen Plugin: neu aufgelöst, jeder abweichende Regler als 0x20 (${describeAll(deckFrames(D, at))})`);
const DM = readyHost();
start(DM);
sx(DM, 0x10);
DM.replacePlugin(3, 903, { moveOldTo: 4, objectChange: true }); // altes TONE3000 lebt in Slot 4 weiter
logAt = DM.log.length;
DM.sysex(sysexBytes(0x11, [1, ...v14(9000)]));
expect(hostSets(DM, logAt).join() === `setParameterProcessValue id=903 tag=${TAG.bass} ${9000 / 16383}`, "TONE3000 nach Slot 4 gezogen, neues in Slot 3, mOnObjectChange: 0x11 trifft das neue");
at = DM.sent.length;
DM.setParam(403, TAG.bass, 0.1);
DM.setParam(403, TAG.bass, 0.2);
expect(deckFrames(DM, at).length === 0, "Bewegung am TONE3000 in Slot 4: nichts gesendet");
const DQ = readyHost();
start(DQ);
sx(DQ, 0x10);
DQ.replacePlugin(3, 913, { moveOldTo: 4 }); // ohne jeden Callback
sx(DQ, 0x10);
logAt = DQ.log.length;
DQ.sysex(sysexBytes(0x11, [1, ...v14(9000)]));
expect(hostSets(DQ, logAt).join() === `setParameterProcessValue id=913 tag=${TAG.bass} ${9000 / 16383}`, "dasselbe ohne Callback: die Abfrage geht den Weg ganz ab und findet das neue");

at = D.sent.length;
D.setParam(D.IDS.DELAY, 10001, 0.3);
D.setParam(D.IDS.DELAY, 10001, 0.4);
expect(deckFrames(D, at).length === 0, "Änderungen am Delay: nichts gesendet");

logAt = D.log.length;
at = D.sent.length;
D.fail("setParameterProcessValue");
D.sysex(sysexBytes(0x11, [3, ...v14(3000)]));
expect(hostSets(D, logAt).join() === `setParameterProcessValue id=803 tag=${TAG.treble} ${3000 / 16383}` && debugLines(D, at).length === 0, "Zugriff scheitert: neu aufgelöst und einmal wiederholt, ohne Debugzeile");
at = D.sent.length;
D.fail("getParameterProcessValue");
sx(D, 0x10);
expect(deckFrames(D, at).map((d) => d.type.toString(16)).join(" ") === "20 20 20 20 21 22 23 23 23", `Lesefehler in der Abfrage: wiederholt, Antwort vollständig (${describeAll(deckFrames(D, at))})`);
at = D.sent.length;
D.fail("getParameterDisplayValue");
D.setParam(803, TAG.bass, 0.1);
const errLines = debugLines(D, at);
expect(errLines.length === 1 && /^TONE3000-Rückmeldung Fehler: Error: getParameterDisplayValue verweigert \(Test\)$/.test(errLines[0]), `Fehler im Parameter-Callback: abgefangen, eine Debugzeile (${errLines.join(" / ")})`);
at = D.sent.length;
D.setParam(803, TAG.bass, 0.2);
expect(describeAll(deckFrames(D, at)) === '20 p1 3277 "2.00"', "danach meldet der Callback wieder");
at = D.sent.length;
D.fail("getBaseObjectID");
D.fireObjectChange(6);
expect(/^Objektwechsel Fehler: Error: getBaseObjectID verweigert/.test(debugLines(D, at).join()), "Fehler im Objektwechsel: abgefangen");
at = D.sent.length;
sx(D, 0x10);
expect(deckFrames(D, at).length === 9, "danach Abfrage wieder vollständig");
at = D.sent.length;
logAt = D.log.length;
D.fail("getObjectTitle");
D.sysex(sysexBytes(0x11, [0, ...v14(100)]));
expect(debugLines(D, at).length === 0 && hostSets(D, logAt).join() === `setParameterProcessValue id=803 tag=${TAG.input} ${100 / 16383}`, "getObjectTitle wirft bei der Prüfung: neu aufgelöst, gesetzt");
at = D.sent.length;
D.replacePlugin(3, 0, { title: null, removeCallback: true });
D.setSlotTitle(6, 2, "");
expect(describeAll(deckFrames(D, at)) === '23 s2 "" | 22 0x24 | 21 ""', `TONE3000 entfernt: 0x23 leer, bit6 aus, 0x21 leer (${describeAll(deckFrames(D, at))})`);

//--- Nachmelden, wenn sich TONE3000 woanders als anders herausstellt ----------------------
heading("3d2 Nachmelden, Dedup-Stand");
// Slot-Titel kommt VOR dem neuen Objekt im DirectAccess-Baum (wie mOnObjectChange in der
// FaderBank): bit6 darf nicht auf 0 hängen bleiben.
const R1 = readyHost();
start(R1);
sx(R1, 0x10);
R1.replacePlugin(3, 0, { title: null, removeCallback: true });
R1.setSlotTitle(6, 2, "");
at = R1.sent.length;
R1.setSlotTitle(6, 2, "TONE3000");
expect(describeAll(deckFrames(R1, at)) === '23 s2 "TONE3000"', `Titel vor dem Baum: nur 0x23, bit6 noch aus (${describeAll(deckFrames(R1, at))})`);
R1.replacePlugin(3, 777); // Baum umgebaut, ohne Callback
at = R1.sent.length;
R1.setHostValue("ch6.slot2.edit", 1); // Nuendo öffnet das Fenster des eingesetzten Plugins
fr = deckFrames(R1, at);
const r1Flags = fr.filter((d) => d.type === 0x22);
expect(r1Flags.length >= 1 && r1Flags[r1Flags.length - 1].flags === 0x74 &&
	sameSet(fr.filter((d) => d.type === 0x20).map(describe), ['20 p0 8178 "0.4992"', '20 p1 8192 "5.00"', '20 p2 8192 "5.00"', '20 p3 8192 "5.00"']) &&
	fr.filter((d) => d.type === 0x21).map(describe).join() === '21 "Calfinornia"',
	`nächster Callback prüft neu: bit6 an, dazu alle vier Regler (gleiche Werte!) und Preset (${describeAll(fr)})`);
at = R1.sent.length;
R1.note(2, 0, 127);
expect(describeAll(deckFrames(R1, at)) === "22 0x75", `danach Mute: nur 0x22 (${describeAll(deckFrames(R1, at))})`);

// Dasselbe, aber eine Meldung vom Delay verbraucht das Nachlesen, solange der Baum noch alt
// ist: Das nächste Zustandsbyte muss "nicht gefunden" trotzdem neu prüfen.
const R1b = readyHost();
start(R1b);
sx(R1b, 0x10);
R1b.replacePlugin(3, 0, { title: null, removeCallback: true });
R1b.setSlotTitle(6, 2, "");
R1b.setSlotTitle(6, 2, "TONE3000");
R1b.setParam(R1b.IDS.DELAY, 10001, 0.3); // Delay-Automation, Baum noch ohne TONE3000
R1b.replacePlugin(3, 778);
at = R1b.sent.length;
R1b.note(2, 0, 127); // Mute vom Deck
fr = deckFrames(R1b, at);
expect(describe(fr[0] || { type: 0 }) === "22 0x65" && fr.filter((d) => d.type === 0x20).length === 4 && fr.filter((d) => d.type === 0x21).length === 1,
	`"nicht gefunden" wird beim Zustandsbyte neu geprüft: bit6 an, Regler und Preset dazu (${describeAll(fr)})`);

// Leerer Slot-Titel kommt, solange das Objekt noch im Baum steht; erst ein Zugriff vom Deck
// merkt, dass TONE3000 fehlt. Das Deck muss es als 0x22/0x21 erfahren, nicht nur als Debugzeile.
for (const [label, send, want] of [
	["0x11", (h) => h.sysex(sysexBytes(0x11, [1, ...v14(9000)])), "TONE3000 Bass abgelehnt: kein TONE3000 in Slot 3"],
	["0x12", (h) => sx(h, 0x12, "HMT"), "Preset HMT abgelehnt: kein TONE3000 in Slot 3"],
]) {
	const R2 = readyHost();
	start(R2);
	sx(R2, 0x10);
	at = R2.sent.length;
	R2.setSlotTitle(6, 2, "");
	const early = describeAll(deckFrames(R2, at));
	R2.replacePlugin(3, 0, { title: null, removeCallback: true });
	at = R2.sent.length;
	send(R2);
	expect(early === '23 s2 ""' && describeAll(deckFrames(R2, at)) === '22 0x24 | 21 ""' && debugLines(R2, at).join() === want,
		`TONE3000 still verschwunden, ${label} merkt es: Debugzeile und 0x22 ohne bit6, 0x21 leer (${early} / ${describeAll(deckFrames(R2, at))} / ${debugLines(R2, at).join(" / ")})`);
}

// mOnObjectChange kommt, bevor Nuendo umgebaut hat: Das sofort gelesene Objekt gilt nur bis
// zum nächsten Bedarf. Das alte TONE3000 lebt in Slot 4 weiter und heißt noch so.
const R5 = readyHost();
start(R5);
sx(R5, 0x10);
R5.fireObjectChange(6);
R5.replacePlugin(3, 923, { moveOldTo: 4 });
logAt = R5.log.length;
at = R5.sent.length;
R5.sysex(sysexBytes(0x11, [1, ...v14(9000)]));
expect(hostSets(R5, logAt).join() === `setParameterProcessValue id=923 tag=${TAG.bass} ${9000 / 16383}` && deckFrames(R5, at).length === 0,
	`mOnObjectChange vor dem Umbau: nächstes 0x11 löst neu auf und trifft 923, gleiche Werte -> nichts gemeldet (${hostSets(R5, logAt).join()})`);

// Abfrage ohne TONE3000 (kein 0x20), dann TONE3000 still wieder eingesetzt, gleiche Werte:
// Das Deck hat keine Reglerwerte, also müssen alle vier kommen.
const R3 = readyHost();
start(R3);
sx(R3, 0x10);
R3.replacePlugin(3, 0, { title: null }); // still entfernt
at = R3.sent.length;
sx(R3, 0x10);
expect(describeAll(deckFrames(R3, at)) === '21 "" | 22 0x24 | 23 s0 "Tuner" | 23 s1 "H-Delay Mono" | 23 s2 "TONE3000"', `Abfrage ohne TONE3000: kein 0x20 (${describeAll(deckFrames(R3, at))})`);
R3.replacePlugin(3, 613); // still wieder eingesetzt, Vorgabewerte wie vorher
at = R3.sent.length;
R3.setParam(613, TAG.output, 0.3); // erste Meldung des neuen Objekts
expect(describeAll(deckFrames(R3, at)) === '22 0x64 | 20 p0 8178 "0.4992" | 20 p1 8192 "5.00" | 20 p2 8192 "5.00" | 20 p3 8192 "5.00" | 21 "Calfinornia"',
	`TONE3000 zurück mit gleichen Werten: bit6, alle vier 0x20, 0x21 (${describeAll(deckFrames(R3, at))})`);

// Lesefehler in der Abfrage: Für diesen Regler hat das Deck keinen Wert, der Dedup auch nicht.
const R6 = readyHost();
start(R6);
sx(R6, 0x10);
R6.fail("getParameterProcessValue", { times: 2, when: (a) => a[2] === TAG.mid });
at = R6.sent.length;
sx(R6, 0x10);
const r6q = deckFrames(R6, at).filter((d) => d.type === 0x20).map((d) => d.p).join();
at = R6.sent.length;
R6.notifyChange(403, TAG.mid); // gleicher Wert wie vor der Abfrage
expect(r6q === "0,1,3" && describeAll(deckFrames(R6, at)) === '20 p2 8192 "5.00"', `Abfrage ohne Mid (Lesefehler): nächste Meldung für Mid geht hinaus (${r6q} / ${describeAll(deckFrames(R6, at))})`);

//--- E: Abfrage vor der Aktivierung, Aktivierung zuerst ---------------------------------
heading("3e Aktivierung");
const E = readyHost();
at = E.sent.length;
sx(E, 0x10);
sx(E, 0x10);
logAt = E.log.length;
E.sysex(sysexBytes(0x11, [1, ...v14(9000)]));
expect(deckFrames(E, at).length === 0 && debugLines(E, at).join(" / ") === "ABFRAGE vor der Aktivierung: Antwort folgt mit der Aktivierung / TONE3000 Bass abgelehnt: noch kein activeMapping (Seite nie aktiviert)",
	`vor der Aktivierung: Abfrage gemerkt (eine Zeile), 0x11 abgelehnt (${debugLines(E, at).join(" / ")})`);
expect(hostSets(E, logAt).length === 0, "vor der Aktivierung: nichts gesetzt");
// Bis 2026-10-06 beantwortete die Aktivierung die Abfrage sofort (Platz 6 war fest
// gebunden). Jetzt steht die Deck-Zone dabei noch auf Platz 0; eine Antwort zeigte den
// falschen Kanal. Sie kommt mit dem Ende der ersten Deck-Suche.
at = E.sent.length;
E.activate();
sx(E, 0x10);
expect(E.sent.length === at, `Aktivierung, Deck-Kanal noch auf Platz 0: Abfrage bleibt gemerkt, auch eine weitere, ohne Debugzeile (${E.sent.length - at} Frames)`);
E.settle();
expect(describeAll(deckFrames(E, at)) === QUERY_1 && tunerFrames(E, at).length === 1,
	`Ende der ersten Deck-Suche beantwortet die ausstehende Abfrage, sonst nichts — ihr Bericht findet danach nichts Neues (${describeAll(deckFrames(E, at))})`);

const F2 = readyHost({ objectChangeOnActivate: true });
F2.activate();
expect(F2.sent.length === 0 && F2.callbackErrors.length === 0, `Callbacks mitten in der Aktivierung senden nichts (${F2.sent.length} Frames)`);

const F = newHost();
F.activate();
expect(F.sent.length === 0, "Aktivierung ohne ausstehende Abfrage: nichts gesendet");
at = F.sent.length;
F.setInputTitles();
F.setSlotTitle(6, 0, "Tuner");
F.setSlotTitle(6, 1, "H-Delay Mono");
F.setSlotTitle(6, 2, "TONE3000");
// Die Titel kommen erst nach der Aktivierung: Der Deck-Kanal steht da noch auf Platz 0
// ("Stereo In 1-2", ohne Inserts), die Slotnamen von ch6 erreichen ihn erst nach dem Schieben.
const fEarly = describeAll(deckFrames(F, at));
const fAt = F.sent.length;
F.settle();
fr = deckFrames(F, fAt);
const kinds = fr.map((d) => (d.type === 0x20 ? `20/${d.p}` : d.type === 0x23 ? `23/${d.slot}` : d.type.toString(16)));
expect(fEarly === '22 0x00 | 21 ""' && new Set(kinds).size === kinds.length && kinds.length === 9 && fr.find((d) => d.type === 0x22).flags === 0x60 && fr.find((d) => d.type === 0x21).name === "Calfinornia",
	`Titel nach der Aktivierung: erst 0x22 ohne bit5 (Platz 0), nach der Deck-Suche jede Meldung genau einmal, bit5 und bit6 (${fEarly} / ${describeAll(fr)})`);
at = F.sent.length;
const fActions = deckActions(F).length;
F.setInputTitles();
F.setSlotTitle(6, 2, "TONE3000");
F.settle();
expect(F.sent.length === at && deckActions(F).length === fActions, "dieselben Titel nochmals: nichts gesendet, nichts geschoben");

//--- G: kaputte Frames ------------------------------------------------------------------
heading("3f kaputte Frames");
const G = readyHost();
start(G);
at = G.sent.length;
logAt = G.log.length;
G.sysex([0xf0, 0x7d, 0x11, 0x01, 0xf7]);
G.sysex([0xf0, 0x7d, 0x11, 0x04, 0x00, 0x00, 0xf7]);
G.sysex([0xf0, 0x7d, 0x11, 0x01, 0x00, 0x00]);
G.sysex([0xf0, 0x7d, 0x12, 0xf7]);
G.sysex([0xf0, 0x7d, 0x12, 0x34, 0xf7]);
G.sysex([0xf0, 0x7d, 0x12, 0x34, 0x38, 0x34, 0x44, 0x35, 0x34]);
const gl = debugLines(G, at);
expect(hostSets(G, logAt).length === 0 && deckFrames(G, at).length === 0, "kaputte 0x11/0x12: nichts gesetzt, nichts gemeldet");
expect(gl.join(" / ") === [
	"TONE3000 setzen abgelehnt: Frame mit 5 Byte, erwartet F0 7D 11 <p> <v1> <v0> F7",
	"TONE3000 setzen abgelehnt: Regler 4 unbekannt (0..3)",
	"TONE3000 setzen abgelehnt: Frame mit 6 Byte, erwartet F0 7D 11 <p> <v1> <v0> F7",
	"Preset abgelehnt: kein Name",
	"Preset abgelehnt: Nutzlast mit ungerader Länge (1 Byte)",
	"Preset abgelehnt: Frame ohne F7 am Ende (9 Byte, gekappt?)",
].join(" / "), `kaputte Frames: je eine Debugzeile (${gl.join(" / ")})`);
G.sysex([0xf0, 0x7e, 0x10, 0xf7]);
G.sysex([0xf0, 0x7d, 0x14, 0xf7]); // 0x13 ist seit Protokoll 4 belegt
expect(G.sent.length === at + gl.length, "fremde Hersteller-ID und unbekannter Typ (0x14): ignoriert");

//--- Beispielsitzung aus docs/protokoll.md, Byte für Byte ------------------------------
heading("3g Beispielsitzung docs/protokoll.md");
const docText = fs.readFileSync(path.join(ROOT, "docs", "protokoll.md"), "utf8");
const docBlock = /```text\r?\n([\s\S]*?)```/.exec(docText.slice(docText.indexOf("## 8 Beispielsitzung")));
const steps = [];
// "Gitarre E1 -16", "Gitarre E1 +2 gestimmt", "Gitarre Stille": ein Ton am Eingang von Input 6,
// den der Tuner misst (Ereignis in Nuendo, kein Frame). Danach wie bei "Deck" die Frames des Scripts.
const SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
for (const raw of docBlock ? docBlock[1].split(/\r?\n/) : []) {
	const g = /^Gitarre\s+(?:(Stille)|([A-G])(#?)(-?\d)\s+([+-]?\d+)(\s+gestimmt)?)(?:\s+#.*)?$/.exec(raw.trim());
	if (g) {
		const spec = g[1] ? null : { midi: (Number(g[4]) + 1) * 12 + SEMITONE[g[2]] + (g[3] ? 1 : 0), cent: Number(g[5]), inTune: !!g[6] };
		steps.push({ guitar: spec, want: [], text: raw.trim() });
		continue;
	}
	const m = /^(Deck|Nuendo)\s+((?:[0-9A-F]{2}\s?)+?)\s*(#.*)?$/.exec(raw.trim());
	if (!m) continue;
	const bytes = m[2].trim().split(/\s+/).map((x) => parseInt(x, 16));
	if (m[1] === "Deck") steps.push({ deck: bytes, want: [], text: raw.trim() });
	else if (steps.length) steps[steps.length - 1].want.push(bytes);
}
expect(steps.length >= 9, `Beispielsitzung gefunden (${steps.length} Schritte vom Deck)`);
expect(steps.some((s) => s.guitar) && steps.some((s) => s.deck && s.deck[2] === 0x13), `Beispielsitzung zeigt die Stimmanzeige (${steps.filter((s) => s.guitar).length} Gitarren-Schritte)`);
const X = readyHost();
start(X);
const hexLine = (b) => b.map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");
for (const s of steps) {
	const from = X.sent.length;
	if (s.text.startsWith("Gitarre")) X.tunerInput(X.IDS.TUNER, s.guitar);
	else if (s.deck[0] === 0xf0) X.sysex(s.deck);
	else X.note(s.deck[0] & 0x0f, s.deck[1], s.deck[2]);
	const got = X.sent.slice(from).map(hexLine);
	const want = s.want.map(hexLine);
	expect(JSON.stringify(got) === JSON.stringify(want), `${s.text.replace(/\s+/g, " ").slice(0, 60)} -> ${want.length} Frame(s) wie dokumentiert${JSON.stringify(got) === JSON.stringify(want) ? "" : " | bekommen: " + got.join(" / ")}`);
}

//==============================================================================
// Teil 4: Protokoll 4 — Stimmanzeige
//==============================================================================
heading("4a Tuner-Modus, Weiterleitung, Dedup");
const TU = 401; // Steinbergs Tuner in Slot 1 (IDS.TUNER)
const tuner24 = (h, from = 0) => describeAll(tunerFrames(h, from));
const tunerSets = (h, from = 0) => hostSets(h, from).filter((l) => / tag=4201 /.test(l));
const tunerMode = (h, m) => h.sysex(sysexBytes(0x13, [m]));
const E1 = (cent, inTune = false) => ({ midi: 28, cent, inTune });
const muteSet = (id, v) => `setParameterProcessValue id=${id} tag=${TUNER_TAG.mute} ${v}`;

const T = readyHost();
start(T);
sx(T, 0x10);
at = T.sent.length;
T.tunerInput(TU, E1(-16));
expect(T.sent.length === at, `Modus aus: Tuner misst, nichts gesendet (${T.sent.length - at} Frames)`);

at = T.sent.length;
logAt = T.log.length;
tunerMode(T, 1);
expect(hostSets(T, logAt).join(" / ") === muteSet(TU, 1), `0x13 1: "Mute" des Tuners auf On, sonst nichts gesetzt (${hostSets(T, logAt).join(" / ")})`);
expect(tuner24(T, at) === '24 0x1d -16 1 "E"' && T.sent.length - at === 1, `0x13 1: sofort genau ein 0x24 mit Modus, gefunden, Mute, Ton erkannt (${tuner24(T, at)})`);
expect(T.hostValue("ch6.mute") === 0 && !T.log.some((l) => /ch6\.mute/.test(l)), "0x13 berührt die Mute des Kanals nicht");
at = T.sent.length;
logAt = T.log.length;
tunerMode(T, 1);
expect(hostSets(T, logAt).length === 0 && tuner24(T, at) === '24 0x1d -16 1 "E"', `0x13 1 nochmals: nichts gesetzt (Mute schon an), 0x24 wieder ohne Dedup (${tuner24(T, at)})`);

at = T.sent.length;
for (const c of [-12, -8, -8, -3]) T.tunerInput(TU, E1(c));
expect(tuner24(T, at) === '24 0x1d -12 1 "E" | 24 0x1d -8 1 "E" | 24 0x1d -3 1 "E"', `im Modus: jede Messung ein 0x24, eine gleiche nicht (${tuner24(T, at)})`);
at = T.sent.length;
T.tunerInput(TU, E1(1, true));
T.tunerInput(TU, E1(1, false));
T.tunerInput(TU, E1(0, true));
expect(tuner24(T, at) === '24 0x1f 1 1 "E" | 24 0x1d 1 1 "E" | 24 0x1f 0 1 "E"', `"In Tune" flackert: bit1 folgt (${tuner24(T, at)})`);
at = T.sent.length;
T.notifyChange(TU, TUNER_TAG.cent);
T.notifyChange(TU, TUNER_TAG.note);
T.notifyChange(TU, TUNER_TAG.locked);
expect(T.sent.length === at, "Dedup: Meldungen ohne Änderung bringen nichts");
let tCalls = T.calls.total;
at = T.sent.length;
T.setParam(TU, TUNER_TAG.frequency, 0.03);
T.setParam(TU, TUNER_TAG.base, 0.6);
expect(T.sent.length === at && T.calls.total === tCalls, `Frequency und Base im Modus: nichts gelesen, nichts gesendet (${T.calls.total - tCalls} Aufrufe)`);

tCalls = T.calls.total;
const baseCalls = T.calls.getBaseObjectID || 0;
at = T.sent.length;
const a1Tags = T.tunerInput(TU, { midi: 33, cent: 5 }); // A1
const a1Relevant = a1Tags.filter((t) => t !== TUNER_TAG.frequency).length;
expect(tuner24(T, at) === '24 0x1d 5 1 "A"', `Durchgang mit ${a1Tags.length} Meldungen: genau ein 0x24 (${tuner24(T, at)})`);
expect((T.calls.getBaseObjectID || 0) === baseCalls && T.calls.total - tCalls <= 6 * a1Relevant,
	`Kosten im Modus: kein Baum, höchstens 6 Lesezugriffe je relevanter Meldung (${T.calls.total - tCalls} für ${a1Relevant})`);
at = T.sent.length;
T.tunerInput(TU, null);
T.tunerInput(TU, { midi: 42, cent: -20 }); // F#2
expect(tuner24(T, at) === '24 0x1c 5 0 "--" | 24 0x1d -20 2 "F#"', `Stille: bit0 aus, Oktave 0, Note "--", Cent bleibt; danach F#2 (${tuner24(T, at)})`);
at = T.sent.length;
sx(T, 0x10);
const tq = T.sent.slice(at).map(decodeFrame);
expect(tq.length === 10 && describe(tq[9]) === '24 0x1d -20 2 "F#"', `Abfrage im Modus: 0x24 zuletzt, ohne Dedup, mit bit2 (${describe(tq[tq.length - 1])})`);

at = T.sent.length;
logAt = T.log.length;
tunerMode(T, 0);
expect(hostSets(T, logAt).join(" / ") === muteSet(TU, 0) && tuner24(T, at) === '24 0x09 -20 2 "F#"', `0x13 0: Mute Off, 0x24 ohne bit2/bit4 (${hostSets(T, logAt).join(" / ")} | ${tuner24(T, at)})`);
tCalls = T.calls.total;
at = T.sent.length;
let offNotes = 0;
for (let i = 0; i < 30; i++) offNotes += T.tunerInput(TU, i % 3 ? E1(i - 15, i % 5 === 0) : null).length;
expect(T.sent.length === at && T.calls.total === tCalls, `Modus aus: 30 Messungen, ${offNotes} Meldungen: nichts gesendet, ${T.calls.total - tCalls} DirectAccess-Aufrufe (0)`);
at = T.sent.length;
logAt = T.log.length;
tunerMode(T, 0);
expect(hostSets(T, logAt).length === 0 && tunerFrames(T, at).length === 1 && (tunerFrames(T, at)[0].flags & 0x14) === 0, "0x13 0 nochmals: nichts gesetzt, 0x24 trotzdem");
at = T.sent.length;
sx(T, 0x10);
const tq2 = T.sent.slice(at).map(decodeFrame);
expect(tq2.length === 10 && tq2[9].type === 0x24 && (tq2[9].flags & 0x1c) === 0x08, `Abfrage bei Modus aus: 0x24 zuletzt, gefunden, ohne bit2/bit4 (${describe(tq2[tq2.length - 1])})`);

// Mute im Plugin von Hand aufgehoben: gemeldet, nicht wieder gesetzt. Mit Echo des Hosts.
const TE = readyHost({ ownSetsNotify: true });
start(TE);
sx(TE, 0x10);
at = TE.sent.length;
tunerMode(TE, 1);
expect(tuner24(TE, at) === '24 0x1c -49 0 "--"', `mit Echo des Hosts: 0x13 1 bringt genau ein 0x24 (${tuner24(TE, at)})`);
at = TE.sent.length;
logAt = TE.log.length;
TE.setParam(TU, TUNER_TAG.mute, 0);
expect(tuner24(TE, at) === '24 0x0c -49 0 "--"' && hostSets(TE, logAt).length === 0, `Mute im Plugin von Hand aus: 0x24 ohne bit4, nicht wieder gesetzt (${tuner24(TE, at)})`);
at = TE.sent.length;
logAt = TE.log.length;
tunerMode(TE, 0);
expect(tuner24(TE, at) === '24 0x08 -49 0 "--"' && hostSets(TE, logAt).length === 0, `mit Echo: 0x13 0 bei schon aufgehobener Mute: nichts gesetzt, ein 0x24 (${tuner24(TE, at)})`);

// Klartexte, die nicht dem Normalfall entsprechen
const TX = readyHost();
start(TX);
tunerMode(TX, 1);
const px = (tag) => TX.param(TU, tag);
at = TX.sent.length;
px(TUNER_TAG.note).textOverride = " ÄÄÄÄÄ "; // 10 Byte, Leerzeichen außen
TX.notifyChange(TU, TUNER_TAG.note);
px(TUNER_TAG.cent).value = 0.34;
px(TUNER_TAG.cent).textOverride = "?";
TX.notifyChange(TU, TUNER_TAG.cent);
px(TUNER_TAG.cent).textOverride = "+75";
TX.notifyChange(TU, TUNER_TAG.cent);
px(TUNER_TAG.cent).textOverride = "-12,6 ct";
TX.notifyChange(TU, TUNER_TAG.cent);
for (const o of ["200", "-3", "x"]) {
	px(TUNER_TAG.oct).textOverride = o;
	TX.notifyChange(TU, TUNER_TAG.oct);
}
expect(tuner24(TX, at) === '24 0x1c -49 0 "ÄÄÄÄ" | 24 0x1c -16 0 "ÄÄÄÄ" | 24 0x1c 50 0 "ÄÄÄÄ" | 24 0x1c -13 0 "ÄÄÄÄ" | 24 0x1c -13 63 "ÄÄÄÄ" | 24 0x1c -13 -3 "ÄÄÄÄ" | 24 0x1c -13 0 "ÄÄÄÄ"',
	`Note auf 8 Byte an der Zeichengrenze, Cent-Rückfall auf roh, Begrenzung, Komma, Oktave unlesbar = 0 (${tuner24(TX, at)})`);
expect(Math.max(...TX.sent.filter((f) => f[2] === 0x24).map((f) => f.length)) === 23, "0x24 höchstens 23 Byte");

heading("4b Kein Tuner, Tuner wechselt");
for (const [label, slot1] of [["GTR Tuner Mono", "gtr"], ["Slot 1 leer", "leer"]]) {
	const NG = readyHost({ slot1 });
	start(NG);
	const ngFrom = NG.sent.length;
	at = NG.sent.length;
	logAt = NG.log.length;
	sx(NG, 0x10);
	const q = tuner24(NG, at);
	at = NG.sent.length;
	tunerMode(NG, 1);
	const on = tuner24(NG, at);
	at = NG.sent.length;
	if (slot1 === "gtr") NG.setParam(TU, 1, 0.4);
	const moved = NG.sent.length - at;
	at = NG.sent.length;
	tunerMode(NG, 0);
	expect(q === '24 0x00 0 0 ""' && on === '24 0x04 0 0 ""' && moved === 0 && tuner24(NG, at) === '24 0x00 0 0 ""' && hostSets(NG, logAt).length === 0 && debugLines(NG, ngFrom).length === 0,
		`${label}: bit3 = 0 in Abfrage und auf 0x13, nichts gesetzt, keine Debugzeile (${q} / ${on} / ${tuner24(NG, at)})`);
}
const NT = readyHost({ slot1: "gtr" });
start(NT);
tunerMode(NT, 1);
at = NT.sent.length;
logAt = NT.log.length;
NT.replacePlugin(1, 461, { title: "Tuner" });
NT.setSlotTitle(6, 0, "Tuner");
expect(hostSets(NT, logAt).join(" / ") === muteSet(461, 1) && tuner24(NT, at) === '24 0x1c -49 0 "--"' && describeAll(deckFrames(NT, at)) === '23 s0 "Tuner"',
	`im Modus Tuner in Slot 1 eingesetzt: Slot-Titel löst neu auf, Mute an, 0x24 (${hostSets(NT, logAt).join(" / ")} | ${tuner24(NT, at)})`);
const NP = readyHost();
start(NP);
NP.replacePlugin(1, 462, { title: "Tuner", kind: "plain" }); // heißt so, hat aber keine Tuner-Parameter
at = NP.sent.length;
logAt = NP.log.length;
tunerMode(NP, 1);
expect(hostSets(NP, logAt).length === 0 && tuner24(NP, at) === '24 0x04 0 0 ""', `Plugin "Tuner" ohne "Mute"/"Note"/"Cent": nicht gefunden, nichts gesetzt (${tuner24(NP, at)})`);
const NL = readyHost();
start(NL);
NL.replacePlugin(1, 463, { title: "Stimmgerät", kind: "tuner" }); // übersetzter Titel
at = NL.sent.length;
logAt = NL.log.length;
tunerMode(NL, 1);
expect(hostSets(NL, logAt).join() === muteSet(463, 1) && tuner24(NL, at) === '24 0x1c -49 0 "--"', `anderer Titel, Klassenkennung des Steinberg-Tuners: gefunden (${tuner24(NL, at)})`);

const TW = readyHost();
start(TW);
sx(TW, 0x10);
tunerMode(TW, 1);
TW.replacePlugin(1, 471, { title: "Tuner" }); // still neu geladen, kein Callback
at = TW.sent.length;
logAt = TW.log.length;
TW.tunerInput(471, E1(-7));
expect(hostSets(TW, logAt).join(" / ") === muteSet(471, 1) && tuner24(TW, at) === '24 0x1d -7 1 "E"',
	`Tuner still neu geladen: erste Meldung des neuen Objekts löst neu auf, Mute an, 0x24 (${hostSets(TW, logAt).join(" / ")} | ${tuner24(TW, at)})`);
at = TW.sent.length;
TW.tunerInput(471, E1(-4));
expect(tuner24(TW, at) === '24 0x1d -4 1 "E"', "danach meldet das neue Objekt wie gewohnt");
at = TW.sent.length;
logAt = TW.log.length;
TW.replacePlugin(1, 472, { title: "Tuner", removeCallback: true, objectChange: true });
expect(hostSets(TW, logAt).join(" / ") === muteSet(472, 1) && tuner24(TW, at) === '24 0x1c -49 0 "--"',
	`neu geladen mit mOnObjectChange: sofort aufgelöst, Mute an, 0x24 mit Dedup (${hostSets(TW, logAt).join(" / ")} | ${tuner24(TW, at)})`);
at = TW.sent.length;
TW.replacePlugin(1, 473, { title: "Pro-Q 3" });
TW.setSlotTitle(6, 0, "Pro-Q 3");
expect(tuner24(TW, at) === '24 0x04 0 0 ""', `anderes Plugin in Slot 1 (Slot-Titel): bit3 aus (${tuner24(TW, at)})`);

const TM = readyHost();
start(TM);
tunerMode(TM, 1);
TM.replacePlugin(1, 481, { title: "Tuner", moveOldTo: 5, objectChange: true }); // alter Tuner lebt in Slot 5 weiter, stumm
at = TM.sent.length;
TM.tunerInput(TU, E1(3)); // der alte meldet sich
TM.tunerInput(TU, E1(9));
expect(tunerFrames(TM, at).length === 0, "alter Tuner in Slot 5 meldet: nichts weitergeleitet");
logAt = TM.log.length;
at = TM.sent.length;
tunerMode(TM, 0);
expect(sameSet(hostSets(TM, logAt), [muteSet(481, 0), muteSet(TU, 0)]) && tuner24(TM, at) === '24 0x08 -49 0 "--"',
	`0x13 0: Mute am Tuner in Slot 1 und am alten in Slot 5 aufgehoben (${hostSets(TM, logAt).join(" / ")})`);
expect(TM.param(TU, TUNER_TAG.mute).value === 0 && TM.param(481, TUNER_TAG.mute).value === 0, "danach ist kein Tuner mehr stumm");

const TR = readyHost();
start(TR);
tunerMode(TR, 1);
TR.tunerInput(TU, E1(-16));
TR.replacePlugin(1, 491, { title: "Tuner", removeCallback: true }); // mOnObjectWillBeRemoved, dann ohne Callback
at = TR.sent.length;
logAt = TR.log.length;
TR.setParam(TR.IDS.DELAY, 10001, 0.3); // irgendeine Meldung: jetzt einmal auflösen
expect(hostSets(TR, logAt).join() === muteSet(491, 1) && tuner24(TR, at) === '24 0x1c -49 0 "--"', `Tuner entfernt gemeldet: nächste Meldung löst einmal neu auf (${tuner24(TR, at)})`);
tCalls = TR.calls.total;
TR.setParam(TR.IDS.DELAY, 10001, 0.4);
TR.setParam(TR.IDS.DELAY, 10001, 0.5);
expect(TR.calls.total === tCalls, `danach kosten Meldungen vom Delay nichts (${TR.calls.total - tCalls} Aufrufe)`);

heading("4c Sicherheit, Aktivierung, kaputte Frames");
const S = readyHost();
S.param(TU, TUNER_TAG.mute).value = 1; // Mute im Projekt gespeichert, Deck war weg
start(S);
at = S.sent.length;
logAt = S.log.length;
sx(S, 0x01);
tunerMode(S, 0); // Deck beim Verbinden: eigener Modus, beim Start 0
expect(hostSets(S, logAt).join() === muteSet(TU, 0) && tuner24(S, at) === '24 0x08 -49 0 "--"',
	`Verbinden: 0x13 0 hebt eine liegengebliebene Tuner-Mute auf, die das Script nie gesetzt hat (${hostSets(S, logAt).join()})`);

const P0 = readyHost();
P0.param(TU, TUNER_TAG.mute).value = 1;
at = P0.sent.length;
logAt = P0.log.length;
tunerMode(P0, 1);
tunerMode(P0, 0);
sx(P0, 0x10);
expect(debugLines(P0, at).join(" / ") === "TUNER vor der Aktivierung: Modus folgt mit der Aktivierung / ABFRAGE vor der Aktivierung: Antwort folgt mit der Aktivierung" &&
	hostSets(P0, logAt).length === 0 && tunerFrames(P0, at).length === 0, `vor der Aktivierung: 0x13 gemerkt (eine Zeile), nichts gesetzt (${debugLines(P0, at).join(" / ")})`);
at = P0.sent.length;
start(P0);
const act = P0.sent.slice(at).map(decodeFrame);
expect(hostSets(P0, logAt).join() === muteSet(TU, 0) && act.map((d) => d.type.toString(16)).join(" ") === "24 20 20 20 20 21 22 23 23 23 24" && describe(act[0]) === '24 0x08 -49 0 "--"',
	`Aktivierung und erste Deck-Suche: zuletzt gemerkter Modus (aus) zuerst, Mute am Tuner von ch6 aufgehoben, dann die Abfrage (${act.map((d) => d.type.toString(16)).join(" ")})`);
at = P0.sent.length;
start(P0);
expect(P0.sent.length === at, "zweite Aktivierung: nichts mehr ausstehend, nichts geschoben");

// bit5 = 0: Der einzige Eingang ist ch6 (mit dem Tuner) unter anderem Namen.
const B4 = start(readyHost({ inputs: [{ key: "ch6", title: "Gitarre" }] }));
logAt = B4.log.length;
tunerMode(B4, 1);
tunerMode(B4, 0);
expect(hostSets(B4, logAt).join(" / ") === `${muteSet(TU, 1)} / ${muteSet(TU, 0)}`, "0x13 wirkt wie die Tasten ohne Titelprüfung (bit5 = 0)");

const GM = readyHost();
start(GM);
at = GM.sent.length;
logAt = GM.log.length;
GM.sysex([0xf0, 0x7d, 0x13, 0xf7]);
GM.sysex([0xf0, 0x7d, 0x13, 0x02, 0xf7]);
GM.sysex([0xf0, 0x7d, 0x13, 0x01, 0x00, 0xf7]);
GM.sysex([0xf0, 0x7d, 0x13, 0x01]);
expect(debugLines(GM, at).join(" / ") === [
	"TUNER abgelehnt: Frame mit 4 Byte, erwartet F0 7D 13 <m> F7",
	"TUNER abgelehnt: Modus 2 unbekannt (0 aus, 1 an)",
	"TUNER abgelehnt: Frame mit 6 Byte, erwartet F0 7D 13 <m> F7",
	"TUNER abgelehnt: Frame mit 4 Byte, erwartet F0 7D 13 <m> F7",
].join(" / ") && hostSets(GM, logAt).length === 0 && tunerFrames(GM, at).length === 0, `kaputte 0x13: je eine Debugzeile, nichts gesetzt, kein 0x24 (${debugLines(GM, at).join(" / ")})`);
at = GM.sent.length;
GM.fail("getParameterProcessValue", { times: 1 });
tunerMode(GM, 1);
expect(tuner24(GM, at) === '24 0x1c -49 0 "--"' && debugLines(GM, at).length === 0, "Lesefehler beim 0x13: neu aufgelöst und wiederholt, ohne Debugzeile");
at = GM.sent.length;
GM.fail("getParameterDisplayValue", { times: 2, when: (a) => a[2] === TUNER_TAG.note });
sx(GM, 0x10);
expect(tunerFrames(GM, at).length === 0 && deckFrames(GM, at).length === 9 && /^ABFRAGE Tuner Fehler: Error: getParameterDisplayValue verweigert \(Test\)$/.test(debugLines(GM, at).join()),
	`Lesefehler auch beim zweiten Versuch: Abfrage ohne 0x24, eine Debugzeile (${debugLines(GM, at).join(" / ")})`);
at = GM.sent.length;
GM.fail("getParameterDisplayValue", { when: (a) => a[2] === TUNER_TAG.cent });
GM.tunerInput(TU, E1(-16));
expect(/^Tuner Fehler: Error: getParameterDisplayValue verweigert/.test(debugLines(GM, at).join()) && tuner24(GM, at) === '24 0x1d -16 1 "E"' && GM.callbackErrors.length === 0,
	`Fehler im Tuner-Callback: abgefangen, eine Debugzeile, die nächste Meldung sendet (${debugLines(GM, at).join(" / ")} | ${tuner24(GM, at)})`);

//==============================================================================
// Teil 5: Der Deck-Kanal folgt dem Namen (Befund 2026-10-06)
//==============================================================================
const NUM_INPUTS = 32;
const flagsOf = (frames) => frames.filter((d) => d.type === 0x22).map((d) => d.flags);
const bit5Seq = (frames) => flagsOf(frames).map((f) => (f & 0x20 ? 1 : 0)).join("");
const lastFlags = (h, from = 0) => {
	const f = flagsOf(deckFrames(h, from));
	return f.length ? f[f.length - 1] : -1;
};
const hex2 = (n) => "0x" + n.toString(16).padStart(2, "0");

//--- a: ein einziger Eingang, "Mono In 6" auf Platz 0 (so am Gerät 2026-10-06) ---------
heading("5a Deck-Kanal: einziger Eingang Mono In 6 auf Platz 0");
const ONE = [{ key: "ch6", title: "Mono In 6" }];
const S1 = readyHost({ inputs: ONE });
at = S1.sent.length;
sx(S1, 0x10); // vor der Aktivierung
S1.activate();
expect(describeAll(deckFrames(S1, at)) === QUERY_1, `Deck-Zone steht schon auf "Mono In 6": die Aktivierung beantwortet die ausstehende Abfrage sofort, bit5 an (${describeAll(deckFrames(S1, at))})`);
S1.settle();
expect(deckActions(S1).length === 0 && S1.zoneTarget(DECK_ZONE) === "ch6", `nichts zu schieben: keine Zonen-Aktion (${actionList(S1) || "keine"})`);
logAt = S1.log.length;
S1.sysex(sysexBytes(0x11, [1, ...v14(12000)]));
sx(S1, 0x12, "HMT");
sets = hostSets(S1, logAt);
expect(sets.length === 2 && sets[0] === `setParameterProcessValue id=403 tag=${TAG.bass} ${12000 / 16383}` && sets[1] === `setParameterDisplayValue id=403 tag=${TAG.program} "HMT"`,
	`0x11 und 0x12 wirken auf TONE3000 von "Mono In 6" (${sets.join(" / ")})`);
at = S1.sent.length;
S1.note(2, 0, 127);
S1.note(2, 4, 127);
S1.note(2, 2, 0);
expect(S1.hostValue("ch6.mute") === 1 && S1.hostValue("ch6.slot2.edit") === 1 && S1.hostValue("ch6.slot1.bypass") === 0 && hex2(lastFlags(S1, at)) === "0x71",
	`Tasten auf Kanal 3 wirken auf "Mono In 6": Mute, TONE3000-Fenster, Delay-Bypass aus (${describeAll(deckFrames(S1, at))})`);
S1.note(0, 0, 0); // Kanal 1 Note 0 = Platz 0 der Such-Zone, derselbe Kanal
expect(S1.hostValue("ch6.mute") === 0 && (lastFlags(S1, at) & 1) === 0, "Kanal 1 Note 0 (Platz 0) schaltet dieselbe Mute");
logAt = S1.log.length;
at = S1.sent.length;
tunerMode(S1, 1);
expect(hostSets(S1, logAt).join() === muteSet(TU, 1) && tuner24(S1, at) === '24 0x1c -49 0 "--"', `0x13 1: Mute am Tuner von "Mono In 6" (${tuner24(S1, at)})`);
tunerMode(S1, 0);

//--- g: Beobachtung, wenn der Zielkanal auf Platz 0 steht -------------------------------
heading("5g Beobachtung am Deck-Kanal");
at = S1.sent.length;
sx(S1, 0x02);
sx(S1, 0x03);
S1.setParam(403, TAG.mid, 0.3);
sx(S1, 0x04);
let pl = debugLines(S1, at);
expect(pl.includes("Eingang 0: \"Mono In 6\" mute=0") && pl.includes("1 von 32 Plätzen belegt") && pl.includes("Ziel: Platz 0 \"Mono In 6\" (per Name, Deck-Kanal)"),
	"Suchlauf: Mono In 6 auf Platz 0, über den Deck-Kanal");
expect(pl.includes("--- Beobachtung läuft ---") && pl.some((l) => /^ÄNDERUNG Slot 3 "TONE3000" tag=1006241759 "toneMid" = "3\.00" roh 0\.3$/.test(l)) && describeAll(deckFrames(S1, at)) === '20 p2 4915 "3.00"',
	`Beobachtung meldet die Änderung am Zielkanal auf Platz 0, der Betrieb sendet 0x20 (${describeAll(deckFrames(S1, at))})`);
// Die Deck-Zone zieht nach dem Suchlauf weiter (Kanal davor eingefügt, noch nicht neu gesucht):
// Der Callback meldet jetzt einen anderen Kanal, also keine Beobachtung.
const G5 = start(readyHost());
sx(G5, 0x02);
G5.insertInput(0, "Neu");
at = G5.sent.length;
sx(G5, 0x03);
pl = debugLines(G5, at);
expect(pl.length === 1 && /^Beobachtung nicht möglich: Der Deck-Kanal zeigt seit dem Suchlauf einen anderen Kanal \(id=1005 statt 100\), erst neu suchen$/.test(pl[0]), `Deck-Zone seit dem Suchlauf weitergezogen: Beobachtung abgelehnt (${pl.join(" / ")})`);
G5.settle();
at = G5.sent.length;
sx(G5, 0x02);
sx(G5, 0x03);
expect(debugLines(G5, at).includes("--- Beobachtung läuft ---"), "nach der Deck-Suche und einem neuen Suchlauf geht sie wieder");
sx(G5, 0x04);

//--- b: 32 Eingänge wie im Projekt vom 2026-10-01 ---------------------------------------
heading("5b 32 Eingänge, Mono In 6 auf Platz 6");
const S2 = readyHost();
at = S2.sent.length;
S2.activate();
expect(S2.sent.length === at && deckActions(S2).length === 0, "Aktivierung: nichts gesendet, noch nicht geschoben (das tut der Leerlauf)");
S2.idle(1);
expect(actionList(S2) === "0RRRRRR", `erster Leerlauf-Durchgang: mResetBank, 6x mShiftRight (${actionList(S2)})`);
S2.settle();
fr = deckFrames(S2, at);
expect(actionList(S2) === "0RRRRRR" && S2.zoneTarget(DECK_ZONE) === "ch6" && describeAll(fr) === '23 s0 "Tuner" | 23 s1 "H-Delay Mono" | 23 s2 "TONE3000" | 22 0x64 | 20 p0 8178 "0.4992" | 20 p1 8192 "5.00" | 20 p2 8192 "5.00" | 20 p3 8192 "5.00" | 21 "Calfinornia"',
	`danach nur Warten auf den Titel, dann der Bericht: Slotnamen, Zustände mit bit5/bit6, Regler, Preset (${describeAll(fr)})`);
expect(S2.zoneActions.every((a) => a.at === S2.zoneActions[0].at), "alle Zonen-Aktionen im ersten Durchgang, keine danach");

//--- c: Eingänge ändern sich zur Laufzeit -----------------------------------------------
heading("5c Eingänge ändern sich zur Laufzeit");
const C5 = start(readyHost());
sx(C5, 0x10);
let c0 = deckActions(C5).length;
at = C5.sent.length;
C5.insertInput(2, "Mono In 1b");
const cNow = deckFrames(C5, at);
C5.settle();
fr = deckFrames(C5, at);
expect(cNow.some((d) => d.type === 0x22 && !(d.flags & 0x20)), `Kanal vor "Mono In 6" eingefügt: sofort 0x22 ohne bit5 (Deck-Zone zeigt jetzt "Mono In 5") (${describeAll(cNow)})`);
expect(C5.zoneTarget(DECK_ZONE) === "ch6" && actionList(C5, c0) === "0RRRRRRR" && lastFlags(C5, at) === 0x64,
	`… dann auf Platz 7 geschoben, bit5 wieder an (${actionList(C5, c0)} / ${bit5Seq(fr)})`);
logAt = C5.log.length;
C5.sysex(sysexBytes(0x11, [2, ...v14(5000)]));
expect(hostSets(C5, logAt).join() === `setParameterProcessValue id=403 tag=${TAG.mid} ${5000 / 16383}`, "danach wirkt 0x11 wieder auf ch6");
c0 = deckActions(C5).length;
at = C5.sent.length;
C5.removeInput(0);
C5.settle();
fr = deckFrames(C5, at);
expect(C5.zoneTarget(DECK_ZONE) === "ch6" && actionList(C5, c0) === "0RRRRRR" && bit5Seq(fr).includes("0") && lastFlags(C5, at) === 0x64,
	`Kanal davor entfernt: kurz bit5 = 0, dann zurück auf Platz 6 (${actionList(C5, c0)} / ${bit5Seq(fr)})`);
c0 = deckActions(C5).length;
at = C5.sent.length;
C5.renameInput("ch6", "Gitarre");
C5.renameInput("ch7", "Mono In 6");
C5.settle();
fr = deckFrames(C5, at);
expect(C5.zoneTarget(DECK_ZONE) === "ch7" && actionList(C5, c0) === "0RRRRRRR" && bit5Seq(fr).startsWith("0") && lastFlags(C5, at) === 0x20,
	`umbenannt ("Mono In 6" heißt jetzt ch7): Deck folgt dem Namen auf Platz 7 (${actionList(C5, c0)} / ${describeAll(fr)})`);
c0 = deckActions(C5).length;
at = C5.sent.length;
C5.renameInput("ch7", "Mono In 7");
C5.renameInput("ch6", "Mono In 6");
C5.settle();
expect(C5.zoneTarget(DECK_ZONE) === "ch6" && actionList(C5, c0) === "0RRRRRR" && lastFlags(C5, at) === 0x64, `zurück umbenannt: wieder Platz 6 (${actionList(C5, c0)})`);
// Im Tuner-Modus: Der Tuner folgt dem Deck-Kanal, der von ch6 bleibt stumm, bis der Modus endet.
tunerMode(C5, 1);
at = C5.sent.length;
logAt = C5.log.length;
C5.insertInput(0, "Neu");
const tAway = tuner24(C5, at);
C5.settle();
expect(tAway === '24 0x04 0 0 ""' && (tunerFrames(C5, at).pop().flags & 0x1c) === 0x1c && hostSets(C5, logAt).length === 0,
	`Tuner-Modus: Deck-Zone verlässt ch6 -> 0x24 ohne Tuner; zurück -> Tuner gefunden und weiter stumm, nichts neu gesetzt (${tuner24(C5, at)})`);
logAt = C5.log.length;
tunerMode(C5, 0);
expect(hostSets(C5, logAt).join() === muteSet(TU, 0), "Modus aus: Mute am Tuner von ch6 aufgehoben");
expect(C5.callbackErrors.length === 0, "keine Ausnahme");

//--- d: "Mono In 6" fehlt ---------------------------------------------------------------
heading("5d Mono In 6 fehlt: bit5 = 0, keine Dauer-Schieberei");
const D1 = start(readyHost({ inputs: [{ key: "ch0", title: "Stereo In 1-2" }, { key: "ch6", title: "Gitarre" }] }));
D1.idle(400); // 20 s Leerlauf
at = D1.sent.length;
sx(D1, 0x10);
expect(deckActions(D1).length === 0 && (lastFlags(D1, at) & 0x20) === 0, `zwei Eingänge, keiner heißt so: keine einzige Zonen-Aktion, auch nach 20 s, bit5 = 0 (${actionList(D1) || "keine"})`);
const D2 = start(readyHost({}, { 6: "Gitarre" }));
const d2n = deckActions(D2).length;
D2.idle(400);
at = D2.sent.length;
sx(D2, 0x10);
expect(actionList(D2) === "0" + "R".repeat(NUM_INPUTS) + "R" && deckActions(D2).length === d2n && (lastFlags(D2, at) & 0x20) === 0,
	`32 Eingänge, keiner heißt so: Rückfall einmal bis zum Ende (${d2n} Aktionen), dann 20 s Ruhe, bit5 = 0`);
at = D2.sent.length;
D2.sysex(sysexBytes(0x11, [1, ...v14(9000)]));
expect(debugLines(D2, at).join() === 'TONE3000 Bass abgelehnt: Deck-Kanal heißt "Mono In 31", nicht "Mono In 6"', `Regler gesperrt (${debugLines(D2, at).join()})`);
D2.setInputTitle(6, "Mono In 6");
D2.settle();
expect(D2.zoneTarget(DECK_ZONE) === "ch6" && actionList(D2, d2n) === "0RRRRRR" && lastFlags(D2) === 0x64, `wieder da: neuer Anlass, auf Platz 6 geschoben (${actionList(D2, d2n)})`);
const D3 = start(readyHost({ zoneBroken: true })); // Nuendo bewegt die Zone nicht
D3.idle(400);
at = D3.sent.length;
sx(D3, 0x10);
expect(actionList(D3) === "0RRRRRR".repeat(3) && (lastFlags(D3, at) & 0x20) === 0, `Zone bewegt sich nicht: drei Runden, dann aufgegeben und Ruhe (${deckActions(D3).length} Aktionen)`);
expect(D3.callbackErrors.length === 0 && D2.callbackErrors.length === 0 && D1.callbackErrors.length === 0, "keine Ausnahme");

//--- e: mehr als 32 Eingänge, Ziel auf Platz 40 -------------------------------------------
heading("5e mehr Eingänge als die Such-Zone: Rückfall");
const BIG = Array.from({ length: 45 }, (_, i) => (i === 40 ? { key: "ch6", title: "Mono In 6" } : { key: `in${i}`, title: `Eingang ${i}` }));
const E5 = readyHost({ inputs: BIG });
at = E5.sent.length;
logAt = E5.log.length;
tunerMode(E5, 1);
sx(E5, 0x10);
E5.activate();
E5.settle();
fr = deckFrames(E5, at);
expect(E5.zoneTarget(DECK_ZONE) === "ch6" && actionList(E5) === "0" + "R".repeat(NUM_INPUTS) + "R".repeat(8), `Platz 40: Sprung auf Platz 32, dann 8 Einzelschritte (${deckActions(E5).length} Aktionen)`);
expect(bit5Seq(fr) === "01" && lastFlags(E5, at) === 0x64,
	`die ausstehende Abfrage wird mit dem Rückfall beantwortet (bit5 = 0), sein Ende meldet bit5 (${bit5Seq(fr)})`);
expect(hostSets(E5, logAt).join() === muteSet(TU, 1) && (tunerFrames(E5, at).pop().flags & 0x1c) === 0x1c,
	`vor der Aktivierung gemerkter Tuner-Modus: am Ende der Tuner von ch6 stumm (${tuner24(E5, at)})`);
tunerMode(E5, 0);
logAt = E5.log.length;
E5.sysex(sysexBytes(0x11, [3, ...v14(3000)]));
expect(hostSets(E5, logAt).join() === `setParameterProcessValue id=403 tag=${TAG.treble} ${3000 / 16383}`, "0x11 wirkt auf ch6 auf Platz 40");
at = E5.sent.length;
sx(E5, 0x02);
sx(E5, 0x03);
E5.setParam(403, TAG.input, 0.25);
sx(E5, 0x04);
pl = debugLines(E5, at);
expect(pl.includes("Ziel: Deck-Kanal \"Mono In 6\" (per Name, nicht unter den 32 Plätzen)") && pl.some((l) => /^ÄNDERUNG Slot 3 "TONE3000" tag=1368699459 "inputLevel"/.test(l)),
	"Suchlauf und Beobachtung über den Deck-Kanal, auch jenseits der Such-Zone");
let e0 = deckActions(E5).length;
at = E5.sent.length;
E5.insertInput(35, "Eingang 35b"); // hinter der Such-Zone: nur der Deck-Kanal merkt es
E5.settle();
fr = deckFrames(E5, at);
// Der Objektwechsel kommt im Stub vor dem Titel: Das erste 0x22 trägt noch bit5 (aber kein bit6).
expect(E5.zoneTarget(DECK_ZONE) === "ch6" && actionList(E5, e0) === "0" + "R".repeat(NUM_INPUTS) + "R".repeat(9) && bit5Seq(fr).includes("0") && lastFlags(E5, at) === 0x64,
	`Kanal auf Platz 35 eingefügt: Deck-Kanal verlässt das Ziel, Rückfall findet es auf Platz 41 (${bit5Seq(fr)})`);
e0 = deckActions(E5).length;
E5.idle(400);
expect(deckActions(E5).length === e0 && E5.callbackErrors.length === 0, "danach Ruhe");

//--- f: Zonen-Aktionen stoßen keine neue Suche an --------------------------------------------
heading("5f keine Selbstauslösung");
for (const [label, opts] of [
	["Meldungen nach mOnIdle (Vorgabe)", {}],
	["Meldungen mitten in trigger()", { zoneDelivery: "sofort" }],
	["ohne Echo, nur echte Änderungen", { zoneEcho: false }],
]) {
	const h = start(readyHost(opts));
	const n = deckActions(h).length;
	const sentAt = h.sent.length;
	h.idle(1200); // 60 s Leerlauf
	h.fireObjectChange(6); // ein Objektwechsel nach der Suche
	h.setInputTitles(); // dieselben Titel noch einmal
	h.idle(100);
	expect(n === 7 && deckActions(h).length === 7 && h.sent.length === sentAt && h.callbackErrors.length === 0,
		`${label}: 7 Aktionen, danach 60 s Leerlauf, Objektwechsel und gleiche Titel ohne Aktion und ohne Frame (${deckActions(h).length}, ${h.sent.length - sentAt} Frames)`);
}
// Ein echter Anlass mitten in der Suche: von vorn, mit frischem Platz, und dann Ruhe.
const F5 = readyHost();
F5.activate();
F5.idle(1); // Runde 1 geschoben, wartet auf den Titel
F5.insertInput(0, "Neu 0");
F5.settle();
F5.idle(400);
expect(F5.zoneTarget(DECK_ZONE) === "ch6" && actionList(F5) === "0RRRRRR" + "0RRRRRRR" && lastFlags(F5) === 0x64,
	`Kanal eingefügt, während die Suche wartet: neu gesucht, auf Platz 7, dann Ruhe (${actionList(F5)})`);
// Ein Host, der die Zone nicht bewegt und bei jedem mResetBank einen Titel der Such-Zone ändert
// (als stieße jede Aktion einen neuen Anlass an): Neustarts sind gedeckelt, das Aufgeben
// schiebt nicht, danach Ruhe.
const Z5 = readyHost({ zoneBroken: true });
const z5Action = Z5.zones.find((z) => z.name === DECK_ZONE).mAction.mResetBank;
const z5Reset = z5Action.trigger;
let z5Toggle = 0;
z5Action.trigger = (m) => {
	z5Reset(m);
	Z5.setInputTitle(20, ++z5Toggle % 2 ? "Mono In 20x" : "Mono In 20");
};
start(Z5);
const z5n = deckActions(Z5).length;
Z5.idle(400);
expect(z5n === 7 * 9 && deckActions(Z5).length === z5n && (lastFlags(Z5) & 0x20) === 0 && Z5.callbackErrors.length === 0,
	`jede Aktion ein neuer Anlass: erste Runde und 8 Neustarts, dann aufgegeben und Ruhe (${z5n} Aktionen)`);
// Nuendo meldet den Titel beim Schieben erst spät (oder nie): Das Basisobjekt per DirectAccess
// sagt, dass das Ziel erreicht ist; sein Name gilt, bit5 kommt ohne den Callback.
const L5 = readyHost();
const lateTitle = L5.channels.find((c) => c.zone.name === DECK_ZONE);
const realTitle = lateTitle.mOnTitleChange;
const held = [];
lateTitle.mOnTitleChange = (...args) => held.push(args);
start(L5);
L5.idle(400);
expect(actionList(L5) === "0RRRRRR" && hex2(lastFlags(L5)) === "0x64", `Titel-Callback bleibt aus: per DirectAccess angekommen, eine Runde, bit5 trotzdem an (${actionList(L5)})`);
lateTitle.mOnTitleChange = realTitle;
at = L5.sent.length;
L5.invoke("später Titel", realTitle, ...held[held.length - 1]);
L5.idle(400);
expect(actionList(L5) === "0RRRRRR" && L5.sent.length === at, `der späte Titel ist derselbe: kein Frame, kein neues Schieben (${describeAll(deckFrames(L5, at))})`);
// Ein veralteter Titel kommt nach dem Ziel (Reihenfolge vertauscht): Der Deck-Kanal verlässt
// das Ziel nur scheinbar; die Suche findet ihn per DirectAccess am Platz und schiebt nicht.
at = L5.sent.length;
L5.invoke("veralteter Titel", realTitle, L5.device, L5.mapping, "Mono In 5");
L5.idle(400);
expect(actionList(L5) === "0RRRRRR" && bit5Seq(deckFrames(L5, at)) === "01", `veralteter Titel danach: kurz bit5 = 0, dann per DirectAccess wieder 1, ohne Schieben (${describeAll(deckFrames(L5, at))})`);

heading("5h Stub-Selbsttest: Zonen-Aktionen");
// Selbsttest des Stubs: Bankbefehle einer 32 Plätze breiten Zone über 45 Eingänge, Ränder,
// und was der Position folgt (Titel, Bindung, DirectAccess, Viewer am Deck-Kanal).
const ZS = readyHost({ inputs: BIG });
ZS.activate();
const sz = ZS.zones.find((z) => z.name === "Eingaenge");
const zsTitles = [];
sz.channels[0].mOnTitleChange = (dev, map, title) => zsTitles.push(title);
const zsStep = (name) => {
	sz.mAction[name].trigger(ZS.mapping);
	return sz.offset;
};
const zsSeq = ["mNextBank", "mNextBank", "mPrevBank", "mShiftRight", "mShiftLeft", "mShiftLeft", "mNextBank", "mResetBank"].map(zsStep);
const zsBinding = ZS.bindings.find((b) => b.hv.zoneValue && b.hv.channel === sz.channels[0]);
expect(JSON.stringify(zsSeq) === "[32,32,0,1,0,0,32,0]" && zsTitles.join() === "Eingang 32,Eingang 32,Eingang 0,Eingang 1,Eingang 0,Eingang 0,Eingang 32,Eingang 0",
	`Stub: mNextBank um 32 (am Ende ins Leere), mPrevBank, mShiftLeft/Right, mResetBank; Titel bei jeder Aktion (Echo) (${zsSeq} / ${zsTitles.join()})`);
zsStep("mNextBank");
expect(zsBinding.hv.key === "in32.mute" && ZS.accesses[0]._base === ZS.inputByKey("in32").base && ZS.targetOf(sz.channels[13]) === null,
	"Stub: Bindung und DirectAccess folgen der Position, Plätze hinter dem Ende sind leer");
const zsDeck = ZS.zones.find((z) => z.name === DECK_ZONE);
for (let i = 0; i < 40; i++) zsDeck.mAction.mShiftRight.trigger(ZS.mapping);
ZS.flush();
expect(ZS.viewers.every((v) => v.channelKey === "ch6" && v.lastTitle === ["Tuner", "H-Delay Mono", "TONE3000"][v.slot]), "Stub: die Viewer des Deck-Kanals zeigen auf Platz 40 die Slotnamen von ch6");

console.log = realLog;

//==============================================================================
// Teil 2: das echte Werkzeug gegen das Script (asynchron)
//==============================================================================
const SCALE = 20;
const realSetTimeout = setTimeout;
const realSleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
const realExit = process.exit;
const realNow = Date.now;

async function asyncProtocol3() {
	heading("3h asynchron wie in Nuendo");
	console.log = (...a) => consoleLines.push(a.join(" "));
	const AS = start(readyHost({ ownSetsNotify: true })); // mit Echo: prüft, dass es erst aus dem Callback kommt
	AS.asyncMs = 0;
	sx(AS, 0x10); // wie das Deck nach dem Verbinden
	await realSleep(20);
	let from = AS.sent.length;
	sx(AS, 0x12, "HMT");
	const direct = deckFrames(AS, from);
	await realSleep(30);
	const all = deckFrames(AS, from);
	expect(describeAll(direct) === '21 "HMT"', `0x12: 0x21 sofort aus dem Handler (${describeAll(direct)})`);
	expect(all.filter((d) => d.type === 0x21).length === 1 && all.filter((d) => d.type === 0x20).length === 1, `0x12: die späten Callbacks bringen 0x20, aber kein zweites 0x21 (${describeAll(all)})`);
	from = AS.sent.length;
	AS.sysex(sysexBytes(0x11, [1, ...v14(10000)]));
	const now = deckFrames(AS, from).length;
	await realSleep(30);
	expect(now === 0 && describeAll(deckFrames(AS, from)) === '20 p1 10000 "6.10"', "0x11: nichts sofort zurück, 0x20 erst aus dem Callback des Hosts");
	from = AS.sent.length;
	AS.note(2, 4, 127);
	await realSleep(30);
	expect(describeAll(deckFrames(AS, from)) === "22 0x74", `Note asynchron: ein 0x22 (${describeAll(deckFrames(AS, from))})`);
	from = AS.sent.length;
	AS.sysex(sysexBytes(0x13, [1]));
	const direct24 = tuner24(AS, from);
	await realSleep(30);
	expect(direct24 === '24 0x1c -49 0 "--"' && tuner24(AS, from) === direct24, `0x13 1: 0x24 sofort aus dem Handler, das späte Echo der Mute bringt kein zweites (${tuner24(AS, from)})`);
	from = AS.sent.length;
	AS.tunerInput(TU, E1(-16));
	await realSleep(30);
	expect(tuner24(AS, from) === '24 0x1d -16 1 "E"', `Tuner asynchron: späte Meldungen, ein 0x24 je Messung (${tuner24(AS, from)})`);
	from = AS.sent.length;
	AS.sysex(sysexBytes(0x13, [0]));
	AS.tunerInput(TU, E1(-3));
	await realSleep(30);
	expect(tuner24(AS, from) === '24 0x09 -16 1 "E"', `0x13 0 asynchron: ein 0x24, danach nichts mehr (${tuner24(AS, from)})`);
	console.log = realLog;
}

// MIDI-Portpaar im Speicher (ersetzt @julusian/midi im Werkzeug)
const flow = { active: false, host: null, oldScript: false, delayNextSetMs: 0, throwOnSendType: -1, lostDebug: 0, lostState: 0, stateToTool: 0 };
const toolInputs = [];
const toolSent = [];

function deliverToTool(bytes) {
	let b = bytes;
	if (flow.oldScript && b[0] === 0xf0 && b[2] === 0x7f) {
		const t = hexToText(b.slice(3, b.length - 1)).replace(/^(--- Suchlauf TONE3000 Remote, )Protokoll \d+, /, "$1");
		b = [0xf0, 0x7d, 0x7f, ...textToHex(t), 0xf7];
	}
	if (!toolInputs.some((i) => i.open)) {
		if (b[2] === 0x7f) flow.lostDebug++;
		else flow.lostState++;
		return;
	}
	if (b[2] !== 0x7f) flow.stateToTool++;
	setImmediate(() => {
		for (const inp of toolInputs) if (inp.open) inp.handlers.forEach((h) => h(0, b));
	});
}

function deliverToScript(bytes) {
	const b = [...bytes];
	const h = flow.host;
	if (b[0] === 0xf0) {
		if (flow.oldScript && (b[2] === 0x05 || b[2] === 0x06)) return;
		if (b[2] === 0x05 && flow.delayNextSetMs > 0) {
			const d = flow.delayNextSetMs;
			flow.delayNextSetMs = 0;
			realSetTimeout(() => h.sysex(b), d);
			return;
		}
		setImmediate(() => h.sysex(b));
		return;
	}
	if ((b[0] & 0xf0) === 0x90) setImmediate(() => h.note(b[0] & 0x0f, b[1], b[2]));
}

class FakeInput {
	constructor() {
		this.handlers = [];
		this.open = false;
		toolInputs.push(this);
	}
	getPortCount() { return 2; }
	getPortName(i) { return ["Anderer Port", "tone3000_sd"][i]; }
	ignoreTypes() {}
	on(ev, fn) { if (ev === "message") this.handlers.push(fn); }
	openPort() { this.open = true; }
	closePort() { this.open = false; }
}
class FakeOutput {
	constructor() { this.open = false; }
	getPortCount() { return 2; }
	getPortName(i) { return ["sd_tone3000", "Anderer Port"][i]; }
	openPort() { this.open = true; }
	closePort() { this.open = false; }
	sendMessage(bytes) {
		if (!this.open) throw new Error("Port geschlossen");
		if (bytes[0] === 0xf0 && bytes[2] === flow.throwOnSendType) throw new Error("Senden fehlgeschlagen (Test)");
		toolSent.push({ at: performance.now(), bytes: [...bytes] });
		deliverToScript(bytes);
	}
}

class ExitSignal extends Error {
	constructor(code) {
		super("process.exit(" + code + ")");
		this.code = code;
	}
}

async function part2() {
	heading("2 Werkzeug tools/suchlauf.cjs");
	const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tone3000-test-"));
	const TOOL_COPY = path.join(TMP, "tools", "suchlauf.cjs");
	const OUT_DIR = path.join(TMP, "suchlauf");
	fs.mkdirSync(path.dirname(TOOL_COPY), { recursive: true });
	fs.copyFileSync(TOOL_SRC, TOOL_COPY);

	console.log = (...a) => consoleLines.push(a.join(" "));
	const HT = readyHost();
	start(HT);
	HT.asyncMs = 10; // Nuendo meldet Änderungen nach dem SysEx-Handler
	HT.onSend = (frame) => {
		if (flow.active) deliverToTool(frame);
	};
	flow.host = HT;
	const sentBefore = HT.sent.length;
	const P = (id, tag) => HT.param(id, tag);
	const pluginID = () => HT.objects[303].kids[0];

	let onExit = null;
	const unexpected = [];
	const runs = [];
	const origLoad = Module._load;
	const t0 = realNow();
	Module._load = function (request, ...rest) {
		if (String(request).includes("@julusian")) return { Input: FakeInput, Output: FakeOutput };
		return origLoad.call(this, request, ...rest);
	};
	global.setTimeout = (fn, ms = 0, ...a) => realSetTimeout(fn, ms / SCALE, ...a);
	Date.now = () => t0 + (realNow() - t0) * SCALE;
	process.exit = (code) => {
		if (onExit) {
			const f = onExit;
			onExit = null;
			f(code ?? 0);
		}
		throw new ExitSignal(code);
	};
	const swallow = (e) => {
		if (!(e instanceof ExitSignal)) unexpected.push(String((e && e.stack) || e));
	};
	process.on("uncaughtException", swallow);
	process.on("unhandledRejection", swallow);
	const toolConsole = [];
	console.log = (...a) => toolConsole.push(a.join(" "));
	console.error = (...a) => toolConsole.push("ERR " + a.join(" "));
	flow.active = true;

	async function runTool(label, args, during) {
		fs.rmSync(OUT_DIR, { recursive: true, force: true });
		delete require.cache[require.resolve(TOOL_COPY)];
		toolSent.length = 0;
		const hostFrom = HT.log.length;
		const exited = new Promise((resolve) => {
			onExit = resolve;
		});
		process.argv = [NODE_BIN, TOOL_COPY, ...args];
		try {
			require(TOOL_COPY);
		} catch (e) {
			if (!(e instanceof ExitSignal)) throw e;
		}
		if (during) during();
		const code = await Promise.race([exited, realSleep(20000).then(() => "Zeitüberschreitung")]);
		for (const s of ["SIGINT", "SIGBREAK", "SIGHUP"]) process.removeAllListeners(s);
		await realSleep(30);
		const files = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".txt")) : [];
		const text = files.length === 1 ? fs.readFileSync(path.join(OUT_DIR, files[0]), "utf8") : "";
		const fileLines = [];
		for (const l of text.split("\n")) {
			if (l === "") continue;
			if (l.startsWith("  ~ ") && fileLines.length) fileLines[fileLines.length - 1] += l.slice(4);
			else fileLines.push(l);
		}
		return { label, code, files: files.length, lines: fileLines, sent: toolSent.slice(), host: HT.log.slice(hostFrom), hostFrom };
	}

	const kind = (s) => (s.bytes[0] === 0xf0 ? s.bytes[2] : "note");
	const kindsOf = (r) => r.sent.map(kind).map((k) => (k === "note" ? "N" : "0" + k.toString(16))).join(" ");
	const fIdx = (r, re, from = 0) => r.lines.findIndex((l, i) => i >= from && re.test(l));
	const fHas = (r, re) => r.lines.some((l) => re.test(l));
	const until = async (cond, ms = 5000) => {
		const end = performance.now() + ms;
		while (!cond() && performance.now() < end) await realSleep(5);
		return cond();
	};

	try {
		const s1 = await runTool("S1 ohne Aktionen", []);
		runs.push(s1);
		expect(s1.code === 0, "S1: Exit-Code 0");
		expect(kindsOf(s1) === "01 02", `S1: nur Ping und Suchlauf geschickt (${kindsOf(s1)})`);
		expect(/^--- Suchlauf TONE3000 Remote, Protokoll 4, Ziel "Mono In 6" ---$/.test(s1.lines[0]) && s1.lines[s1.lines.length - 1] === "--- Suchlauf beendet ---", "S1: Datei von Kopfzeile (Protokoll 4) bis Schlusszeile");
		expect(!fHas(s1, /Beobachtung/), "S1: keine Beobachtung");

		const stateBefore = flow.stateToTool;
		const s2 = await runTool("S2 Aktionen", [
			"--setzen", "3;Program;plain;2",
			"--puls", "3;MIDI CC 0|20",
			"--befehl", "next",
			"--befehl", "next/taste",
			"--befehl", "next/note",
		]);
		runs.push(s2);
		expect(s2.code === 0, "S2: Exit-Code 0");
		expect(kindsOf(s2) === "01 02 03 05 05 05 06 06 06 06 N N 04", `S2: Reihenfolge Ping, Suchlauf, Beobachtung an, Aktionen, Beobachtung aus (${kindsOf(s2)})`);
		const notes = s2.sent.filter((s) => kind(s) === "note").map((s) => s.bytes.map((b) => b.toString(16)).join(" "));
		expect(JSON.stringify(notes) === JSON.stringify(["91 0 7f", "91 0 0"]), `S2: Note auf Kanal 2, Nr. 0, Velocity 127 dann 0 (${notes.join(" / ")})`);
		const noteGap = s2.sent.filter((s) => kind(s) === "note").map((s) => s.at);
		expect(noteGap[1] - noteGap[0] >= (150 / SCALE) * 0.8, `S2: Note gehalten (${(noteGap[1] - noteGap[0]).toFixed(1)} ms echt, Soll ${150 / SCALE})`);
		const a = [1, 2, 3, 4, 5].map((n) => fIdx(s2, new RegExp(`^>>> Aktion ${n}/5: `)));
		const aEnd = fIdx(s2, /^--- Zusammenfassung: /);
		expect(a.every((v, i) => v > 0 && (i === 0 || v > a[i - 1])) && aEnd > a[4], "S2: >>>-Marken 1..5 in Reihenfolge, Zusammenfassung danach");
		const fin1 = fIdx(s2, /^--- Setzen fertig ---$/, a[0]);
		const chg1 = fIdx(s2, /^ÄNDERUNG Slot 3 "TONE3000" tag=1128262618 "toneBass" = "6\.00"/, a[0]);
		expect(fin1 > a[0] && chg1 > fin1 && chg1 < a[1], "S2: verzögerte ÄNDERUNG kommt nach \"Setzen fertig\", landet aber vor der nächsten >>>-Marke");
		const cc = s2.host.map((h, i) => ({ h, t: HT.logTimes[s2.hostFrom + i] })).filter((x) => /^JUCE: MIDI CC 0\|20/.test(x.h));
		expect(cc.length === 2 && /Wert 127$/.test(cc[0].h) && /Wert 0$/.test(cc[1].h), "S2: Puls kommt beim Host als CC 20 = 127, dann 0 an");
		expect(cc.length === 2 && cc[1].t - cc[0].t >= (250 / SCALE) * 0.8, `S2: Pulsabstand ${cc.length === 2 ? (cc[1].t - cc[0].t).toFixed(1) : "?"} ms echt (Soll ${250 / SCALE})`);
		expect(fIdx(s2, /^BINDING next feuert value=1 diff=1$/, a[2]) > a[2] && fIdx(s2, /^BINDING next feuert value=1/, a[2]) < a[3], "S2: --befehl next -> BINDING next");
		expect(fIdx(s2, /^BINDING next\/taste feuert value=1/, a[3]) < a[4] && fIdx(s2, /^BINDING next\/taste feuert value=1/, a[3]) > a[3], "S2: --befehl next/taste -> BINDING next/taste");
		expect(fIdx(s2, /^WERT next\/taste = 1$/, a[4]) > a[4] && fIdx(s2, /^BINDING next\/taste feuert value=0 diff=-1$/, a[4]) > a[4], "S2: --befehl next/note -> WERT und BINDING an der Taste, beide Flanken");
		expect(s2.host.filter((h) => h === "Befehl Preset/Next ausgeführt").length === 3, "S2: Preset/Next dreimal ausgeführt (Variable, Taste, Note)");
		expect(fHas(s2, /^BEFEHL next 1 \(Preset\/Next, canPerform=true\)$/), "S2: BEFEHL-Zeile mit canPerform zum Auslösezeitpunkt");
		expect(s2.lines[s2.lines.length - 1] === "--- Beobachtung beendet ---", "S2: Datei endet mit dem Ende der Beobachtung");
		expect(flow.stateToTool > stateBefore && !s2.lines.some((l) => /[^\x20-\x7e -ɏ]/.test(l)), `S2: Protokoll-3-Frames (${flow.stateToTool - stateBefore}) laufen mit, das Werkzeug übergeht sie`);

		const s3 = await runTool("S3 beobachten + Stopp-Datei", [
			"--setzen", "3/slot;Bypass;norm;1",
			"--setzen", "3/slot;Bypass;norm;0",
			"--pause", "0,5",
			"--beobachten", "600",
		], async () => {
			await until(() => toolSent.filter((s) => kind(s) === 0x05).length === 2);
			await realSleep(80);
			HT.setParam(pluginID(), TAG.input, 0.77); // Hand am Plugin
			await realSleep(60);
			fs.writeFileSync(path.join(OUT_DIR, "stopp"), "");
		});
		runs.push(s3);
		const stop = fIdx(s3, /^\(Stopp-Datei gefunden\)$/);
		const manual = fIdx(s3, /^ÄNDERUNG Slot 3 "TONE3000" tag=1368699459 "inputLevel" = "0\.77/);
		const last = fIdx(s3, /^>>> Aktion 2\/2/);
		expect(s3.code === 0 && kindsOf(s3) === "01 02 03 05 05 04", `S3: Exit 0, Beobachtung erst nach --beobachten aus (${kindsOf(s3)})`);
		expect(last > 0 && manual > last && stop > manual, "S3: Handänderung nach den Aktionen mitgeschrieben, dann Stopp-Datei");
		expect(!fs.existsSync(path.join(OUT_DIR, "stopp")), "S3: Stopp-Datei entfernt");
		expect(fHas(s3, /^ÄNDERUNG Slot 3 tag=4102 "Bypass" = "On" roh 1$/) && fHas(s3, /^ÄNDERUNG Slot 3 tag=4102 "Bypass" = "Off" roh 0$/), "S3: Slot-Bypass an und aus in der Beobachtung");

		flow.oldScript = true;
		const s4 = await runTool("S4 Script veraltet", ["--setzen", "3;Program;plain;2", "--befehl", "next"]);
		flow.oldScript = false;
		runs.push(s4);
		expect(s4.code === 1, `S4: Exit-Code 1 (${s4.code})`);
		expect(kindsOf(s4) === "01 02", `S4: keine Beobachtung, keine Aktion geschickt (${kindsOf(s4)})`);
		expect(fHas(s4, /^ACHTUNG: Script veraltet \(ohne Protokollangabe, nötig 2\)/), "S4: klare Meldung \"Script veraltet\"");

		flow.delayNextSetMs = 10000 / SCALE + 150;
		const s5 = await runTool("S5 Zeitüberschreitung", ["--setzen", "3;Program;plain;3", "--setzen", "3;Program;plain;4", "--befehl", "next"]);
		runs.push(s5);
		expect(kindsOf(s5) === "01 02 03 05 04", `S5: nach der Zeitüberschreitung nichts mehr geschickt außer Beobachtung aus (${kindsOf(s5)})`);
		expect(fHas(s5, /^ACHTUNG: kein "--- Setzen fertig ---" nach 10 s für "3;Program;plain;3"$/) && fHas(s5, /^ACHTUNG: 2 weitere Aktion\(en\) ausgelassen/), "S5: Zeitüberschreitung gemeldet, übrige Aktionen ausgelassen");
		expect(!fHas(s5, /^>>> Aktion 2\//), "S5: keine zweite >>>-Marke, die eine verspätete Zeile schlucken könnte");

		const s6 = await runTool("S6 Strg+C", ["--setzen", "3;Program;plain;1", "--beobachten", "600"], async () => {
			await until(() => toolSent.some((s) => kind(s) === 0x05));
			await realSleep(250);
			process.emit("SIGINT", "SIGINT");
		});
		runs.push(s6);
		await realSleep(50);
		const lostBefore = flow.lostDebug;
		HT.setParam(pluginID(), TAG.input, 0.31);
		await realSleep(50);
		expect(s6.code === 130, `S6: Exit-Code 130 (${s6.code})`);
		expect(kindsOf(s6).endsWith("05 04") && fHas(s6, /^ACHTUNG: abgebrochen \(SIGINT\)\.$/) && fHas(s6, /^\(Beobachtung abgeschaltet\)$/), `S6: Beobachtung beim Abbruch abgeschaltet (${kindsOf(s6)})`);
		expect(flow.lostDebug === lostBefore, `S6: danach keine Debugzeilen mehr ungefragt (${flow.lostDebug - lostBefore})`);

		flow.throwOnSendType = 0x06;
		const s7 = await runTool("S7 Fehler im Werkzeug", ["--setzen", "3;Program;plain;2", "--befehl", "next"]);
		flow.throwOnSendType = -1;
		runs.push(s7);
		expect(s7.code === 1 && fHas(s7, /^ACHTUNG: Fehler im Werkzeug: Error: Senden fehlgeschlagen \(Test\)/), `S7: Fehler gemeldet, Exit-Code 1 (${s7.code})`);
		expect(kindsOf(s7) === "01 02 03 05 04" && fHas(s7, /^\(Beobachtung abgeschaltet\)$/), `S7: Beobachtung trotzdem abgeschaltet (${kindsOf(s7)})`);

		HT.sysex([0xf0, 0x7d, 0x02, 0xf7]);
		HT.sysex([0xf0, 0x7d, 0x03, 0xf7]);
		const s8 = await runTool("S8 liegengebliebene Beobachtung", []);
		runs.push(s8);
		const lost8 = flow.lostDebug;
		HT.setParam(pluginID(), TAG.input, 0.42);
		await realSleep(50);
		expect(fHas(s8, /^\(Beobachtung aus einem früheren Lauf beendet: /) && flow.lostDebug === lost8, "S8: neuer Suchlauf beendet eine hängende Beobachtung, danach Ruhe");

		HT.fail("getParameterProcessValueType", { when: (args) => args[2] === TAG.program });
		const s9 = await runTool("S9 Ausnahme im Suchlauf", ["--setzen", "3;Program;plain;5", "--pause", "1"]);
		runs.push(s9);
		expect(s9.code === 0 && fHas(s9, /^   44 tag=1886553053 "Program" Fehler: Error: getParameterProcessValueType verweigert \(Test\)$/) && fHas(s9, /^--- Suchlauf beendet ---$/), "S9: Fehlerzeile, Suchlauf trotzdem beendet");
		expect(fHas(s9, /^SETZEN 3 id=\d+ tag=1886553053 "Program" .* -> plain 5 /) && fHas(s9, /^NACHHER "Matchless"/), "S9: Setzen läuft nach dem Fehler im Suchlauf");

		const shape = frameShape(HT.sent.slice(sentBefore));
		expect(shape.badByte === 0 && shape.badFrame === 0, "Teil 2: alle Datenbytes < 0x80");
		expect(shape.maxLen <= 205, `Teil 2: längster Frame ${shape.maxLen} <= 205 Byte`);
		expect(runs.every((r) => r.files === 1), "Teil 2: je Lauf genau eine Ausgabedatei");
		expect(unexpected.length === 0, `Teil 2: keine unerwarteten Ausnahmen (${unexpected.length})`);
	} finally {
		global.setTimeout = realSetTimeout;
		Date.now = realNow;
		process.exit = realExit;
		console.log = realLog;
		console.error = realError;
		Module._load = origLoad;
		process.removeListener("uncaughtException", swallow);
		process.removeListener("unhandledRejection", swallow);
		flow.active = false;
		fs.rmSync(TMP, { recursive: true, force: true });
	}
	for (const u of unexpected) out("UNERWARTET: " + u);
	return runs;
}

//==============================================================================
// Ablauf und Ausgabe
//==============================================================================
(async () => {
	let runs = [];
	try {
		await asyncProtocol3();
		runs = await part2();
	} catch (e) {
		results.push({ section, ok: false, label: "Ablauf abgebrochen: " + ((e && e.stack) || e) });
	}

	heading("gesamt");
	const frames = allHosts.flatMap((h) => h.sent);
	const shape = frameShape(frames);
	expect(shape.badByte === 0 && shape.badFrame === 0, `alle ${frames.length} Frames: Datenbytes < 0x80, Rahmen F0 7D .. F7`);
	expect(shape.maxLen <= 205, `längster Frame ${shape.maxLen} <= 205 Byte`);
	const errors = allHosts.flatMap((h) => h.callbackErrors);
	expect(errors.length === 0, `keine Ausnahme verlässt einen Callback, über alle ${allHosts.length} Hosts (${errors.join(" | ") || "0"})`);

	if (FULL) {
		out("=== Script-Ausgabe Teil 1 ===");
		for (const l of consoleLines) out("  " + l);
		for (const r of runs) {
			out(`--- ${r.label}: Exit ${r.code}`);
			for (const l of r.lines.filter((x) => /^(>>>|ACHTUNG|SETZEN|NACHHER|BEFEHL|---|\()/.test(x))) out("   " + l);
		}
	}

	let current = null;
	for (const r of results) {
		if (r.section !== current) {
			current = r.section;
			const inSection = results.filter((x) => x.section === current);
			out(`\n== ${current} (${inSection.filter((x) => x.ok).length}/${inSection.length})`);
		}
		out(`  ${r.ok ? "ok  " : "FEHL"} ${r.label}`);
	}
	const failed = results.filter((r) => !r.ok);
	out(`\nPrüfungen: ${results.length - failed.length} ok, ${failed.length} fehlgeschlagen`);
	process.exitCode = failed.length ? 1 : 0;
})();
