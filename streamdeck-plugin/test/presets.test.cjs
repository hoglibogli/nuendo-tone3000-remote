/**
 * Preset-Liste: der Leser gegen nachgebaute Dateien beider Fassungen und gegen die
 * echten Presets dieses Rechners (nur lesen). Läuft einzeln
 * (node test/presets.test.cjs) oder aus run.cjs: Der Export ist die Testfunktion,
 * gezählt wird über harness.cjs.
 */
"use strict";

const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { section, check, ok, state } = require("./harness.cjs");
const { ensureBuilt, outDir } = require("./render-build.cjs");

// --- Nachbau von JUCE ValueTree::writeToStream ---------------------------------
const cstr = (s) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
/** compressedInt: Längenbyte, dann little endian. */
function cint(v) {
	if (v === 0) return Buffer.from([0]);
	const bytes = [];
	let x = v;
	while (x > 0) {
		bytes.push(x & 0xff);
		x = Math.floor(x / 256);
	}
	return Buffer.from([bytes.length, ...bytes]);
}
const varString = (s) => {
	const data = cstr(s);
	return Buffer.concat([cint(data.length + 1), Buffer.from([5]), data]);
};
const varInt = (v) => {
	const b = Buffer.alloc(4);
	b.writeInt32LE(v);
	return Buffer.concat([cint(5), Buffer.from([1]), b]);
};
function tree(type, props, children = []) {
	const parts = [cstr(type), cint(props.length)];
	for (const [k, v] of props) parts.push(cstr(k), v);
	parts.push(cint(children.length), ...children);
	return Buffer.concat(parts);
}
/** "T3KH" + uint32 LE Länge + Kopfbaum + Hauptbaum, wie die Werkspresets. */
function withHeader(header, main) {
	const len = Buffer.alloc(4);
	len.writeUInt32LE(header.length);
	return Buffer.concat([Buffer.from("T3KH"), len, header, main]);
}

function run() {
	ensureBuilt();
	const presets = require(join(outDir, "presets", "t3k-presets.js"));

	section("Presets: Dateiformat");
	{
		const t3kb = Buffer.concat([
			Buffer.from("T3KB"),
			tree("T3KPreset", [["schemaVersion", varInt(1)], ["name", varString("Einstein Halbgas")]], [tree("ChainSnapshot", [])]),
		]);
		check("T3KB: Name aus dem Wurzelbaum", presets.readPresetName(t3kb), "Einstein Halbgas");

		const t3kh = withHeader(
			tree("T3KPresetHeader", [["id", varString("0f487d25")], ["name", varString("Dumble Spread")]]),
			tree("T3KPreset", [["schemaVersion", varInt(1)], ["name", varString("Dumble Spread")]]),
		);
		check("T3KH: Name aus dem Kopf", presets.readPresetName(t3kh), "Dumble Spread");

		const umlaut = Buffer.concat([Buffer.from("T3KB"), tree("T3KPreset", [["name", varString("Größenwahn 🔥")]])]);
		check("UTF-8 mit Umlaut und Emoji", presets.readPresetName(umlaut), "Größenwahn 🔥");

		const noNameInHeader = withHeader(
			tree("T3KPresetHeader", [["id", varString("x")]]),
			tree("T3KPreset", [["name", varString("Aus dem Hauptbaum")]]),
		);
		check("T3KH ohne Namen im Kopf: Hauptbaum", presets.readPresetName(noNameInHeader), "Aus dem Hauptbaum");

		const future = Buffer.concat([Buffer.from("T3KZ\x07\x00\x00junk"), cstr("name"), varString("Zukunft")]);
		check("unbekannte Fassung: Suche nach name", presets.readPresetName(future), "Zukunft");

		check("Müll: kein Name", presets.readPresetName(Buffer.from("T3KB\x01\x02\x03")), null);
		check("leer: kein Name", presets.readPresetName(Buffer.alloc(0)), null);
		check("abgeschnitten: kein Name, kein Wurf", presets.readPresetName(t3kb.subarray(0, 30)), null);
		check("Ordner fehlen: leere Liste", presets.listPresets({ user: ["X:\\gibt\\es\\nicht"], factory: [] }), []);
	}

	section("Presets: echte Dateien (nur lesen)");
	{
		const dirs = presets.defaultPresetDirs();
		console.log(`      eigene: ${dirs.user.join(", ")}`);
		console.log(`      Werk:   ${dirs.factory.join(", ")}`);
		if (!dirs.user.some((d) => existsSync(d))) {
			console.log("      (keine TONE3000-Presets auf diesem Rechner — Prüfung gegen echte Dateien entfällt)");
			return;
		}
		const t = process.hrtime.bigint();
		const list = presets.listPresets();
		const took = Number(process.hrtime.bigint() - t) / 1e6;
		for (const p of list) console.log(`      ${p.source.padEnd(7)} ${p.name.padEnd(24)} ${p.file}`);
		console.log(`      ${list.length} Presets in ${took.toFixed(1)} ms`);

		const expected = ["JCM 2000", "Calfinornia", "Vox AC 30", "Einstein Vollgas", "Einstein Halbgas", "Matchless", "HMT"];
		const users = list.filter((p) => p.source === "user").map((p) => p.name);
		check("die sieben eigenen Namen sind da (fehlend)", expected.filter((n) => !users.includes(n)), []);
		const firstFactory = list.findIndex((p) => p.source === "factory");
		const lastUser = list.map((p) => p.source).lastIndexOf("user");
		ok("eigene vor den Werkspresets", firstFactory === -1 || lastUser < firstFactory);
		const sorted = [...users].sort((a, b) => a.localeCompare(b, "de", { sensitivity: "base" }));
		check("eigene alphabetisch ohne Groß/klein", users, sorted);
		check("Namen eindeutig", new Set(list.map((p) => p.name)).size, list.length);
		ok("jede Datei existiert", list.every((p) => existsSync(p.file)));
		const factory = list.filter((p) => p.source === "factory");
		ok("Werkspresets gefunden", factory.length > 0);
		// Werkspresets heißen auf der Platte wie in der Liste: Name aus der Datei = Dateiname
		check(
			"Werkspresets: Name = Dateiname (Abweichungen)",
			factory.filter((p) => !p.file.endsWith(`${p.name}.t3kpreset`)).map((p) => p.name),
			[],
		);
	}
}

module.exports = run;

if (require.main === module) {
	run();
	const { passes, failures } = state;
	console.log(failures === 0 ? `\npresets: alle ${passes} Prüfungen bestanden` : `\npresets: ${failures} von ${passes + failures} Prüfungen fehlgeschlagen`);
	process.exit(failures === 0 ? 0 : 1);
}
