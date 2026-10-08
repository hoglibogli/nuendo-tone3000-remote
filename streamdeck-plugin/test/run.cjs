/**
 * Testlauf (npm test): kompiliert die Module nach test-output/build (CommonJS),
 * ersetzt @julusian/midi durch Ports im Speicher und @elgato/streamdeck durch eine
 * Attrappe und führt die Tests der Reihe nach aus. Kein MIDI-Port wird geöffnet,
 * nichts ausgerollt; Nuendo und Stream Deck bleiben unberührt.
 *
 *   protocol  Kodieren/Dekodieren, Beispielsitzung aus docs/protokoll.md 9
 *   logic     Wächter, Store, Session, Drossel (Uhr von Hand)
 *   midi      MidiManager gegen Ports im Speicher
 *   e2e       das echte Nuendo-Script im Stub über ein Portpaar im Speicher
 *   actions   die Aktionen mit echter Grafik, SDK als Attrappe
 *   presets   Preset-Liste: nachgebaute Dateien beider Fassungen, echte Presets (nur lesen)
 *   render    jede Bildvariante, Maße, Zeiten, Vergleich mit dem Entwurf; Bilder nach test-output/
 *   manifest  Manifest gegen Bilder (Maße laut Elgato-Schema), Layout, UUIDs, Bündel ohne native Module
 *   tuner     Tonhöhenerkennung (src/tuner) an synthetischen Saiten, gegen die Breitband-Basislinie
 *   tuner-plugin  eigener Tuner im Plugin: Eingänge, Quellen-Verwaltung, Kanal-Mute, Taste, Bilder,
 *             Worker als Kindprozess mit WAV statt Audiogerät
 *
 * presets und render bauen sich selbst nach test-output/render-build (test/render-build.cjs),
 * damit sie auch einzeln laufen; jede Datei exportiert ihre Testfunktion und zählt über
 * harness.cjs.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const Module = require("node:module");

const root = join(__dirname, "..");
const outDir = join(root, "test-output", "build");

const TSC_FLAGS = [
	"--outDir", outDir,
	// Ausdrücklich, damit die Ausgabe die Gliederung von src/ behält.
	"--rootDir", "src",
	"--module", "commonjs",
	"--target", "ES2022",
	"--moduleResolution", "node",
	"--esModuleInterop",
	"--strict",
	"--skipLibCheck",
];

/** Den Compiler direkt über node starten; npx.cmd scheitert unter Windows ohne Shell (EINVAL). */
function tsc(files) {
	execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), ...files, ...TSC_FLAGS], {
		cwd: root,
		stdio: "inherit",
	});
}

rmSync(outDir, { recursive: true, force: true });

// Die Logik zuerst und allein: Sie hängt weder an der Grafik noch am SDK.
tsc([
	"src/@types/julusian-midi.d.ts",
	"src/midi/protocol.ts",
	"src/midi/midi-manager.ts",
	"src/state/health.ts",
	"src/state/store.ts",
	"src/state/session.ts",
	"src/state/throttle.ts",
]);

// Dann die Aktionen samt Grafik. Scheitert das, laufen die übrigen Tests trotzdem.
let actionsBuilt = true;
try {
	tsc(["src/actions/knob.ts", "src/actions/preset.ts", "src/actions/amp.ts", "src/actions/tuner.ts", "src/actions/delay.ts"]);
} catch {
	actionsBuilt = false;
}

// Die Tonhöhenerkennung hängt an nichts davon; scheitert sie, laufen die übrigen Tests trotzdem.
let tunerBuilt = true;
try {
	tsc(["src/tuner/engine.ts", "src/tuner/baseline.ts", "src/tuner/worker.ts", "src/tuner/source.ts"]);
} catch {
	tunerBuilt = false;
}

// Das Projekt ist "type": "module"; die kompilierten .js sind CommonJS.
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

// @julusian/midi liegt nur im .sdPlugin-Ordner und würde echte Ports anfassen; das
// SDK verbände sich mit der Stream-Deck-App. Im Test kommen Ersatzteile.
const fakeMidi = require("./fake-midi.cjs");
const fakeStreamDeck = require("./fake-streamdeck.cjs");
const origLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === "@julusian/midi" || request === "@julusian/midi/lazy") return fakeMidi.backend;
	if (request === "@elgato/streamdeck") return fakeStreamDeck;
	return origLoad.call(this, request, ...rest);
};

const harness = require("./harness.cjs");

(async () => {
	const files = [
		"protocol.test.cjs",
		"logic.test.cjs",
		"midi.test.cjs",
		"e2e.test.cjs",
		"actions.test.cjs",
		"presets.test.cjs",
		"render.test.cjs",
		"manifest.test.cjs",
		"tuner.test.cjs",
		"tuner-plugin.test.cjs",
	];
	for (const file of files) {
		console.log(`\n=== ${file}`);
		if (file === "actions.test.cjs" && !actionsBuilt) {
			harness.state.failures++;
			console.log("FAIL  Aktionen und Grafik ließen sich nicht kompilieren (siehe tsc oben)");
			continue;
		}
		if ((file === "tuner.test.cjs" || file === "tuner-plugin.test.cjs") && !tunerBuilt) {
			harness.state.failures++;
			console.log("FAIL  Die Tonhöhenerkennung ließ sich nicht kompilieren (siehe tsc oben)");
			continue;
		}
		try {
			const run = require(`./${file}`);
			if (typeof run === "function") await run();
		} catch (e) {
			harness.state.failures++;
			console.log(`FAIL  ${file} abgebrochen: ${(e && e.stack) || e}`);
		}
	}

	const { passes, failures } = harness.state;
	console.log(failures === 0 ? `\nalle ${passes} Prüfungen bestanden` : `\n${failures} von ${passes + failures} Prüfungen fehlgeschlagen`);
	process.exit(failures === 0 ? 0 : 1);
})();
