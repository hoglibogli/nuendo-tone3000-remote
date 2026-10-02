/**
 * Manifest gegen die Dateien im .sdPlugin-Ordner: jedes Bild als .png und @2x.png in
 * den Maßen des Elgato-Schemas (@elgato/schemas, imageDimensions), Layout, Property
 * Inspector, Schrift, die UUIDs der Aktionen im Quelltext — und, falls gebaut, dass
 * bin/plugin.js die nativen Module nicht bündelt, sondern zur Laufzeit lädt.
 *
 * Liest nur Dateien; kein Port, kein Stream Deck, kein Nuendo.
 */
"use strict";

const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { section, check, ok } = require("./harness.cjs");

const root = join(__dirname, "..");
const sd = join(root, "com.sorg.tone3000.sdPlugin");

/** Breite und Höhe aus dem IHDR-Block; null, wenn es kein PNG ist. */
function pngSize(file) {
	const b = readFileSync(file);
	if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
	return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** Bildmaße laut Schema (1x); @2x ist das Doppelte. */
function schemaDimensions() {
	const schema = JSON.parse(readFileSync(join(root, "node_modules", "@elgato", "schemas", "streamdeck", "plugins", "manifest.json"), "utf8"));
	const d = schema.definitions;
	const pluginLevel = (prop) => d.Manifest.allOf.map((a) => a.then?.properties?.[prop]?.imageDimensions).find(Boolean);
	return {
		pluginIcon: pluginLevel("Icon"),
		categoryIcon: pluginLevel("CategoryIcon"),
		actionIcon: d.Action.properties.Icon.imageDimensions,
		encoderIcon: d.Encoder.properties.Icon.imageDimensions,
		stateImage: d.State.properties.Image.imageDimensions,
	};
}

function checkImage(label, ref, dims) {
	for (const [suffix, factor] of [[".png", 1], ["@2x.png", 2]]) {
		const file = join(sd, ref + suffix);
		const want = [dims[0] * factor, dims[1] * factor];
		if (!ok(`${label}: ${ref}${suffix} vorhanden`, existsSync(file))) continue;
		check(`${label}: ${ref}${suffix} ${want[0]}x${want[1]}`, pngSize(file), want);
	}
}

function run() {
	const manifest = JSON.parse(readFileSync(join(sd, "manifest.json"), "utf8"));
	const dims = schemaDimensions();

	section("Manifest: Bilder in den Maßen des Schemas");
	ok("Schema liefert alle Maße", Object.values(dims).every((v) => Array.isArray(v) && v.length === 2), JSON.stringify(dims));
	checkImage("Plugin-Symbol", manifest.Icon, dims.pluginIcon);
	checkImage("Kategorie", manifest.CategoryIcon, dims.categoryIcon);
	for (const a of manifest.Actions) {
		const name = a.UUID.split(".").pop();
		checkImage(`${name} Icon`, a.Icon, dims.actionIcon);
		if (a.Encoder?.Icon) checkImage(`${name} Encoder.Icon`, a.Encoder.Icon, dims.encoderIcon);
		for (const s of a.States ?? []) checkImage(`${name} State.Image`, s.Image, dims.stateImage);
	}

	section("Manifest: Aktionen, Layout, Property Inspector");
	const actions = Object.fromEntries(manifest.Actions.map((a) => [a.UUID, a]));
	ok("jede Aktion beginnt mit der Plugin-UUID", manifest.Actions.every((a) => a.UUID.startsWith(`${manifest.UUID}.`)));
	// Die UUIDs aus den @action-Dekoratoren im Quelltext
	const sourceUuids = readdirSync(join(root, "src", "actions"))
		.filter((f) => f.endsWith(".ts"))
		.flatMap((f) => [...readFileSync(join(root, "src", "actions", f), "utf8").matchAll(/@action\(\{\s*UUID:\s*"([^"]+)"/g)].map((m) => m[1]))
		.sort();
	check("UUIDs im Quelltext = UUIDs im Manifest", sourceUuids, Object.keys(actions).sort());
	for (const a of manifest.Actions) {
		if (a.PropertyInspectorPath) ok(`${a.UUID}: ${a.PropertyInspectorPath} vorhanden`, existsSync(join(sd, a.PropertyInspectorPath)));
	}
	const knob = actions["com.sorg.tone3000.knob"];
	check("Regler: nur Encoder", knob?.Controllers, ["Encoder"]);
	const layoutFile = join(sd, knob?.Encoder?.layout ?? "");
	if (ok("Regler: Layout vorhanden", !!knob?.Encoder?.layout && existsSync(layoutFile))) {
		const layout = JSON.parse(readFileSync(layoutFile, "utf8"));
		check("Layout: eine Pixmap „canvas“ über das ganze Segment", layout.items, [{ key: "canvas", type: "pixmap", rect: [0, 0, 200, 100] }]);
		check("Layout-ID = Aktions-UUID", layout.id, knob.UUID);
	}
	ok("knob.ts setzt genau dieses Element", /setFeedback\(\{\s*canvas:/.test(readFileSync(join(root, "src", "actions", "knob.ts"), "utf8")));
	ok("Schrift Yellowtail samt Lizenz", existsSync(join(sd, "fonts", "Yellowtail-Regular.ttf")) && existsSync(join(sd, "fonts", "LICENSE.txt")));
	check("CodePath", manifest.CodePath, "bin/plugin.js");
	const tunerAction = actions["com.sorg.tone3000.tuner"];
	check("Tuner-Taste: Property Inspector ui/tuner.html", tunerAction?.PropertyInspectorPath, "ui/tuner.html");
	const tunerHtml = existsSync(join(sd, "ui", "tuner.html")) ? readFileSync(join(sd, "ui", "tuner.html"), "utf8") : "";
	ok("tuner.html: Checkbox mit Setting openWindow, „Tuner-Fenster am Rechner öffnen“ (nur Steinberg-Tuner)", /<sdpi-checkbox[^>]*setting="openWindow"[^>]*label="Tuner-Fenster am Rechner öffnen[^"]*Steinberg[^"]*"/.test(tunerHtml));
	ok("tuner.ts liest genau dieses Setting", /settings\?\.openWindow === true/.test(readFileSync(join(root, "src", "actions", "tuner.ts"), "utf8")));

	section("Bündel: native Module bleiben draußen");
	const runtime = JSON.parse(readFileSync(join(sd, "package.json"), "utf8"));
	check("Laufzeitpakete im .sdPlugin-Ordner", Object.keys(runtime.dependencies ?? {}).sort(), ["@julusian/midi", "@resvg/resvg-js", "audify"]);
	ok("installiert: audify (Audio-Eingang des Stimmgeräts)", existsSync(join(sd, "node_modules", "audify", "package.json")));
	// Stream Deck startet den Tuner-Worker mit seinem eigenen Node 20, nicht mit dem
	// Node dieser Tests. Die im npm-Paket mitgelieferte audify.node stürzte darunter
	// beim Auflisten ab (0xC0000005, 2026-10-02) — scripts/audify-napi9.cjs holt die
	// passende Fassung. Hier wird nur geladen und aufgelistet, kein Stream geöffnet.
	const sdNode = join(process.env.APPDATA ?? "", "Elgato", "StreamDeck", "NodeJS", "20.20.0", "node.exe");
	if (existsSync(sdNode)) {
		const { spawnSync } = require("node:child_process");
		const probe = "const a=require('audify');const rt=new a.RtAudio(a.RtAudioApi.WINDOWS_WASAPI);console.log('GERAETE '+rt.getDevices().length)";
		const r = spawnSync(sdNode, ["-e", probe], { cwd: sd, encoding: "utf8", timeout: 20000 });
		ok("audify unter Stream Decks Node 20: laden und Geräte auflisten ohne Absturz", r.status === 0 && /GERAETE \d+/.test(r.stdout ?? ""), `Code ${r.status}, Signal ${r.signal}, ${(r.stderr ?? "").slice(0, 200)} — ggf. npm run fix:audify`);
	} else {
		console.log("  (übersprungen: Stream Decks Node 20 nicht gefunden)");
	}
	ok("installiert: @julusian/midi", existsSync(join(sd, "node_modules", "@julusian", "midi", "package.json")));
	ok("installiert: @resvg/resvg-js", existsSync(join(sd, "node_modules", "@resvg", "resvg-js", "package.json")));
	let lazyPath = "";
	try {
		lazyPath = require.resolve("@julusian/midi/lazy", { paths: [join(sd, "bin")] }); // nur auflösen, nicht laden
	} catch {
		/* bleibt leer */
	}
	ok("@julusian/midi/lazy aus bin/ auflösbar (Einstieg im exports-Feld)", lazyPath.startsWith(join(sd, "node_modules")) && /lazy\.js$/.test(lazyPath), lazyPath);
	const rollup = readFileSync(join(root, "rollup.config.mjs"), "utf8");
	ok("rollup: beide als external, MIDI auch als /lazy", /external:\s*\[[^\]]*"@julusian\/midi"[^\]]*"@julusian\/midi\/lazy"[^\]]*"@resvg\/resvg-js"/.test(rollup));
	const bundleFile = join(sd, "bin", "plugin.js");
	if (!existsSync(bundleFile)) {
		console.log("      bin/plugin.js fehlt (npm run build), Prüfung des Bündels entfällt");
		return;
	}
	const bundle = readFileSync(bundleFile, "utf8");
	ok("bin/plugin.js lädt @julusian/midi/lazy per require", /require\(['"]@julusian\/midi\/lazy['"]\)/.test(bundle));
	ok("bin/plugin.js lädt den Haupteinstieg von @julusian/midi nicht", !/require\(['"]@julusian\/midi['"]\)/.test(bundle));
	// Ein require auf oberster Ebene liefe vor dem Absturzprotokoll und risse den Prozess spurlos mit.
	ok("MIDI nicht auf oberster Ebene geladen (erst in maintain())", !/^var [\w$]+ = require\(['"]@julusian\//m.test(bundle));
	ok("bin/plugin.js lädt @resvg/resvg-js aus dem .sdPlugin-Ordner", /createRequire\([^)]*\)\(['"]@resvg\/resvg-js['"]\)/.test(bundle));
	ok("kein nativer Code im Bündel", !/process\.dlopen|resvg-js-win32|\.node['"]\)/.test(bundle));
	ok("rollup: Audio-Kindprozess als eigenes Ziel, audify external", /input:\s*"src\/tuner\/worker\.ts"[\s\S]*?tuner-worker\.js[\s\S]*?external:\s*\["audify"\]/.test(rollup));
	const workerFile = join(sd, "bin", "tuner-worker.js");
	ok("bin/tuner-worker.js gebaut", existsSync(workerFile));
	if (existsSync(workerFile)) {
		const worker = readFileSync(workerFile, "utf8");
		ok("Worker lädt audify aus dem .sdPlugin-Ordner (createRequire), erst bei Bedarf", /createRequire\(__filename\)\("audify"\)/.test(worker) && !/^var [\w$]+ = require\(['"]audify['"]\)/m.test(worker));
		ok("kein nativer Code im Worker", !/process\.dlopen|\.node['"]\)/.test(worker));
		ok("plugin.js startet den Worker per fork mit dem Node von Stream Deck (execPath)", /fork\(/.test(bundle) && /tuner-worker\.js/.test(bundle) && /execPath:\s*process\.execPath/.test(bundle));
	}
}

module.exports = run;

if (require.main === module) {
	run();
	const { state } = require("./harness.cjs");
	console.log(state.failures === 0 ? `\nmanifest: alle ${state.passes} Prüfungen bestanden` : `\nmanifest: ${state.failures} von ${state.passes + state.failures} Prüfungen fehlgeschlagen`);
	process.exit(state.failures === 0 ? 0 : 1);
}
