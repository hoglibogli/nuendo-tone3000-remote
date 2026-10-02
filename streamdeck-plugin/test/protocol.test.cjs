/**
 * Protokoll: Kodieren und Dekodieren, gegen docs/protokoll.md.
 *
 * Die Beispielsitzung (letzter Abschnitt) wird direkt aus der Datei gelesen: Jede
 * Deck-Zeile muss der Builder Byte für Byte erzeugen, jede Nuendo-Zeile muss der
 * Parser mit dem erwarteten Inhalt lesen. Ändert sich die Beispielsitzung, fällt
 * das hier auf.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { section, check, ok, hex, bytes } = require("./harness.cjs");

const build = path.join(__dirname, "..", "test-output", "build");
const P = require(path.join(build, "midi", "protocol.js"));

const PROTOKOLL = path.join(__dirname, "..", "..", "docs", "protokoll.md");

/** Die Zeilen der Beispielsitzung als { dir, bytes, note }; die Abschnittsnummer zählt nicht. */
function sessionFromDoc() {
	const md = fs.readFileSync(PROTOKOLL, "utf8");
	const head = /^## \d+ Beispielsitzung/m.exec(md);
	if (!head) throw new Error("Abschnitt Beispielsitzung fehlt in protokoll.md");
	const start = head.index;
	const block = md.slice(start).split("```text")[1].split("```")[0];
	const lines = [];
	let echo = null;
	for (const raw of block.split(/\r?\n/)) {
		const m = /^(Deck|Nuendo)\s+((?:[0-9A-F]{2}\s+)*[0-9A-F]{2})\s*(?:#\s*(.*))?$/.exec(raw);
		if (m) {
			lines.push({ dir: m[1], bytes: bytes(m[2]), note: (m[3] || "").trim() });
			continue;
		}
		const e = /käme:\s+((?:[0-9A-F]{2}\s)+F7)/.exec(raw);
		if (e) echo = bytes(e[1]);
	}
	return { lines, echo };
}

module.exports = function run() {
	section("Text (2.2)");
	check("HMT -> 34 38 34 44 35 34", hex(P.encodeText("HMT")), "34 38 34 44 35 34");
	check("5.00 -> 33 35 32 45 33 30 33 30", hex(P.encodeText("5.00")), "33 35 32 45 33 30 33 30");
	check("Ä -> 43 33 38 34", hex(P.encodeText("Ä")), "43 33 38 34");
	check("leer -> keine Bytes", P.encodeText(""), []);
	check("Kleinbuchstaben werden angenommen", P.decodeText(bytes("63 33 38 34")), "Ä");
	check("Emoji hin und zurück (4 Byte UTF-8)", P.decodeText(P.encodeText("Lead \u{1F525}")), "Lead \u{1F525}");
	check("Emoji kodiert als F0 9F 94 A5", hex(P.encodeText("\u{1F525}")), hex([..."F09F94A5"].map((c) => c.charCodeAt(0))));
	check("ungerade Hexlänge abgelehnt", P.decodeText(bytes("34 38 34")), null);
	check("fremdes Zeichen abgelehnt", P.decodeText(bytes("34 47")), null);
	ok("jedes kodierte Byte ist 7 Bit", P.encodeText("Ölfass \u{1F525} 100%").every((b) => b < 0x80));

	section("14 Bit (2.3)");
	check("0 -> 0", P.to14(0), 0);
	check("1 -> 16383", P.to14(1), 16383);
	check("0,5 -> 8192 (Mitte)", P.to14(0.5), 8192);
	check("begrenzt unter 0 und über 1", [P.to14(-0.2), P.to14(1.7)], [0, 16383]);
	check("16383 -> 1,0", P.from14(16383), 1);
	check("Klartext Gain 8192 / 8178", [P.hostText(0, 8192), P.hostText(0, 8178)], ["0.5000", "0.4992"]);
	check("Klartext Bass 12000 / 8192", [P.hostText(1, 12000), P.hostText(1, 8192)], ["7.32", "5.00"]);
	check("Klartext Treble 0 / 16383", [P.hostText(3, 0), P.hostText(3, 16383)], ["0.00", "10.00"]);

	section("Deck -> Nuendo, Grenzen");
	check("0x11 genau 7 Byte", P.buildSetParam(3, 16383).length, 7);
	check("0x11 Treble 16383 -> 7F 7F", hex(P.buildSetParam(3, 16383)), "F0 7D 11 03 7F 7F F7");
	check("0x11 Wert begrenzt", hex(P.buildSetParam(0, 99999)), "F0 7D 11 00 7F 7F F7");
	let threw = false;
	try {
		P.buildSetParam(4, 0);
	} catch {
		threw = true;
	}
	ok("0x11 p = 4 wirft", threw);
	check("Presetname 100 Byte passt, 101 nicht, leer nicht", [P.presetNameFits("x".repeat(100)), P.presetNameFits("x".repeat(101)), P.presetNameFits("")], [true, false, false]);
	check("Presetname mit 50 × Ä (100 Byte) passt", P.presetNameFits("Ä".repeat(50)), true);
	check("0x12 mit 100 Byte: 204 Byte Frame", P.buildSelectPreset("x".repeat(100)).length, 204);
	threw = false;
	try {
		P.buildSelectPreset("x".repeat(101));
	} catch {
		threw = true;
	}
	ok("0x12 zu lang wirft statt zu kürzen", threw);
	check("Note an: 92 n 7F", P.buildNote(3, true), [0x92, 3, 0x7f]);
	check("Note aus: 92 n 00 (kein Note Off)", P.buildNote(3, false), [0x92, 3, 0x00]);

	section("Nuendo -> Deck, übergangen wird");
	check("Note", P.parseFrame([0x92, 0, 0x7f]), null);
	check("fremde Hersteller-ID", P.parseFrame(bytes("F0 43 22 64 F7")), null);
	check("unbekannter Typ", P.parseFrame(bytes("F0 7D 30 01 F7")), null);
	check("ohne F7", P.parseFrame(bytes("F0 7D 22 64")), null);
	check("Datenbyte ab 0x80", P.parseFrame(bytes("F0 7D 22 80 F7")), null);
	check("0x22 mit zwei Datenbytes", P.parseFrame(bytes("F0 7D 22 64 00 F7")), null);
	check("0x20 mit p = 4", P.parseFrame(bytes("F0 7D 20 04 40 00 F7")), null);
	check("0x20 zu kurz", P.parseFrame(bytes("F0 7D 20 01 40 F7")), null);
	check("0x20 mit ungerader Textlänge", P.parseFrame(bytes("F0 7D 20 01 40 00 33 F7")), null);
	check("0x23 mit s = 3", P.parseFrame(bytes("F0 7D 23 03 F7")), null);
	check("Ping mit Daten ist kein Pong", P.parseFrame(bytes("F0 7D 01 00 F7")), null);
	check("Abfrage (Deck -> Nuendo) liest das Deck nicht", P.parseFrame(P.buildQuery()), null);
	check("leeres 0x21 = Preset unbekannt", P.parseFrame(bytes("F0 7D 21 F7")), { type: "preset", name: "" });
	check("leeres 0x23 = leerer Slot", P.parseFrame(bytes("F0 7D 23 02 F7")), { type: "slot", slot: 2, name: "" });
	check("0x20 ohne Klartext", P.parseFrame(bytes("F0 7D 20 02 00 00 F7")), { type: "param", p: 2, value: 0, text: "" });

	section("Protokoll 4: Tuner-Modus 0x13 und Stimmanzeige 0x24");
	check("0x13 an: F0 7D 13 01 F7", hex(P.buildTunerMode(true)), "F0 7D 13 01 F7");
	check("0x13 aus: F0 7D 13 00 F7", hex(P.buildTunerMode(false)), "F0 7D 13 00 F7");
	check("0x13 liest das Deck nicht", P.parseFrame(P.buildTunerMode(true)), null);
	check("0x24 E, Oktave 1, -16 Cent, Ton/Modus/gefunden/Mute", P.parseFrame(bytes("F0 7D 24 1D 30 41 34 35 F7")), { type: "tuner", flags: 0x1d, cent: -16, oct: 1, note: "E" });
	check("0x24 F#2 gestimmt, 0 Cent", P.parseFrame(bytes("F0 7D 24 1F 40 42 34 36 32 33 F7")), { type: "tuner", flags: 0x1f, cent: 0, oct: 2, note: "F#" });
	check("0x24 Stille \"--\", Cent -49 (bedeutungslos)", P.parseFrame(bytes("F0 7D 24 08 0F 40 32 44 32 44 F7")), { type: "tuner", flags: 0x08, cent: -49, oct: 0, note: "--" });
	check("0x24 ohne Tuner: Note leer", P.parseFrame(bytes("F0 7D 24 04 40 40 F7")), { type: "tuner", flags: 0x04, cent: 0, oct: 0, note: "" });
	check("0x24 +50 und -50", [P.parseFrame(bytes("F0 7D 24 1D 72 41 34 35 F7")).cent, P.parseFrame(bytes("F0 7D 24 1D 0E 41 34 35 F7")).cent], [50, -50]);
	check("0x24: Leerzeichen um die Note fallen weg", P.parseFrame([0xf0, 0x7d, 0x24, 0x1d, 0x30, 0x41, ...P.encodeText(" E "), 0xf7]).note, "E");
	check("0x24 mit 8 Byte Note: gelesen", P.parseFrame([0xf0, 0x7d, 0x24, 0x1d, 0x40, 0x41, ...P.encodeText("ABCDEFGH"), 0xf7]).note, "ABCDEFGH");
	check("0x24 mit 9 Byte Note: abgelehnt", P.parseFrame([0xf0, 0x7d, 0x24, 0x1d, 0x40, 0x41, ...P.encodeText("ABCDEFGHI"), 0xf7]), null);
	check("0x24 zu kurz", P.parseFrame(bytes("F0 7D 24 1D 30 F7")), null);
	check("0x24 mit ungerader Notenlänge", P.parseFrame(bytes("F0 7D 24 1D 30 41 34 F7")), null);
	check("Bits laut Protokoll", [P.TUNER_LOCKED, P.TUNER_IN_TUNE, P.TUNER_MODE, P.TUNER_FOUND, P.TUNER_MUTE], [1, 2, 4, 8, 16]);
	check("fürs Log", [P.describeMessage(P.buildTunerMode(true)), P.describeMessage(P.buildTunerMode(false)), P.describeMessage(bytes("F0 7D 24 1D 30 41 34 35 F7"))], [
		"TUNER-MODUS an",
		"TUNER-MODUS aus",
		'TUNER 0x1d "E" oct 1 cent -16',
	]);
	{
		// Jedes 0x24-Beispiel aus protokoll.md (Abschnitt Stimmanzeige) wird gelesen.
		const md = fs.readFileSync(PROTOKOLL, "utf8");
		const examples = [...md.matchAll(/`(F0 7D 24(?: [0-9A-F]{2})+ F7)`/g)].map((m) => m[1]);
		ok(`Beispiele für 0x24 im Protokoll gefunden (${examples.length})`, examples.length >= 5);
		const bad = examples.filter((x) => P.parseFrame(bytes(x)) === null);
		ok("jedes 0x24-Beispiel im Protokoll wird gelesen", bad.length === 0, bad.join(" | "));
		const modeFrames = [...md.matchAll(/`(F0 7D 13 0[01] F7)`/g)].map((m) => m[1]);
		ok("0x13 im Protokoll so, wie das Deck es baut", modeFrames.length > 0 && modeFrames.every((x) => x === hex(P.buildTunerMode(true)) || x === hex(P.buildTunerMode(false))), modeFrames.join(" | "));
	}

	section("Beispielsitzung (protokoll.md)");
	const { lines, echo } = sessionFromDoc();
	const deck = lines.filter((l) => l.dir === "Deck");
	const nuendo = lines.filter((l) => l.dir === "Nuendo");
	check("Zeilen gelesen: 12 vom Deck, 25 von Nuendo", [deck.length, nuendo.length], [12, 25]);

	const deckBuilt = [
		["Ping", P.buildPing()],
		["Tuner-Modus des Decks beim Verbinden (aus)", P.buildTunerMode(false)],
		["Abfrage", P.buildQuery()],
		["Bass auf 12000", P.buildSetParam(1, 12000)],
		["Gain auf Mitte (Regler gedrückt)", P.buildSetParam(0, P.to14(0.5))],
		["Preset HMT", P.buildSelectPreset("HMT")],
		["Preset Gibtsnicht", P.buildSelectPreset("Gibtsnicht")],
		["Mute an", P.buildNote(P.NOTE_MUTE, true)],
		["TONE3000-Fenster auf", P.buildNote(P.NOTE_AMP_WINDOW, true)],
		["Mute aus", P.buildNote(P.NOTE_MUTE, false)],
		["Tuner-Taste: Modus an", P.buildTunerMode(true)],
		["Tuner-Taste: Modus aus", P.buildTunerMode(false)],
	];
	deckBuilt.forEach(([label, built], i) => {
		check(`Deck ${i + 1} ${label}: ${deck[i] ? hex(deck[i].bytes) : "?"}`, hex(built), deck[i] ? hex(deck[i].bytes) : null);
	});

	const tuner = (flags, cent, oct, note) => ({ type: "tuner", flags, cent, oct, note });
	const nuendoExpected = [
		{ type: "pong" },
		tuner(0x08, -49, 0, "--"),
		{ type: "param", p: 0, value: 8178, text: "0.4992" },
		{ type: "param", p: 1, value: 8192, text: "5.00" },
		{ type: "param", p: 2, value: 8192, text: "5.00" },
		{ type: "param", p: 3, value: 8192, text: "5.00" },
		{ type: "preset", name: "Calfinornia" },
		{ type: "flags", flags: 0x64 },
		{ type: "slot", slot: 0, name: "Tuner" },
		{ type: "slot", slot: 1, name: "H-Delay Mono" },
		{ type: "slot", slot: 2, name: "TONE3000" },
		tuner(0x08, -49, 0, "--"),
		{ type: "param", p: 0, value: 8192, text: "0.5000" },
		{ type: "preset", name: "HMT" },
		{ type: "param", p: 1, value: 7372, text: "4.50" },
		{ type: "debug", text: "Preset Gibtsnicht nicht übernommen, aktiv HMT" },
		{ type: "flags", flags: 0x65 },
		{ type: "flags", flags: 0x75 },
		{ type: "flags", flags: 0x74 },
		tuner(0x1d, -16, 1, "E"),
		tuner(0x1f, 2, 1, "E"),
		tuner(0x1d, -5, 2, "A"),
		tuner(0x1f, 0, 2, "F#"),
		tuner(0x1c, 0, 0, "--"),
		tuner(0x08, 0, 0, "--"),
	];
	nuendoExpected.forEach((want, i) => {
		const line = nuendo[i];
		check(`Nuendo ${i + 1} ${line ? line.note.slice(0, 50) : "?"}`, line ? P.parseFrame(line.bytes) : null, want);
	});
	ok("Echo aus dem Kommentar gefunden", Array.isArray(echo));
	check("Echo p1 12000 \"7.32\"", echo ? P.parseFrame(echo) : null, { type: "param", p: 1, value: 12000, text: "7.32" });

	// Rückweg: Was der Parser liest, ergibt kodiert wieder dieselben Bytes.
	const reencode = (f) => {
		switch (f.type) {
			case "pong":
				return P.buildPing();
			case "param":
				return [0xf0, 0x7d, 0x20, f.p, f.value >> 7, f.value & 0x7f, ...P.encodeText(f.text), 0xf7];
			case "preset":
				return [0xf0, 0x7d, 0x21, ...P.encodeText(f.name), 0xf7];
			case "flags":
				return [0xf0, 0x7d, 0x22, f.flags, 0xf7];
			case "slot":
				return [0xf0, 0x7d, 0x23, f.slot, ...P.encodeText(f.name), 0xf7];
			case "tuner":
				return [0xf0, 0x7d, 0x24, f.flags, f.cent + 64, f.oct + 64, ...P.encodeText(f.note), 0xf7];
			case "debug":
				return [0xf0, 0x7d, 0x7f, ...P.encodeText(f.text), 0xf7];
		}
	};
	const roundTrip = nuendo.every((l) => hex(reencode(P.parseFrame(l.bytes))) === hex(l.bytes));
	ok("alle Nuendo-Frames: lesen und wieder kodieren ergibt dieselben Bytes", roundTrip);
	check("Beschreibung fürs Log", [P.describeMessage(nuendo[2].bytes), P.describeMessage(deck[3].bytes), P.describeMessage(deck[5].bytes), P.describeMessage(deck[7].bytes), P.describeMessage(deck[1].bytes), P.describeMessage(nuendo[19].bytes)], [
		'PARAM p0 8178 "0.4992"',
		"SET p1 12000",
		'SELECT "HMT"',
		"NOTE ch3 n=0 vel=127",
		"TUNER-MODUS aus",
		'TUNER 0x1d "E" oct 1 cent -16',
	]);
};
