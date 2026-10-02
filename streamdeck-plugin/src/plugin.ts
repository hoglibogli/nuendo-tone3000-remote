import { fork } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { AmpAction } from "./actions/amp";
import { DelayAction } from "./actions/delay";
import { KnobAction } from "./actions/knob";
import { PresetAction } from "./actions/preset";
import { TunerAction } from "./actions/tuner";
import { midi } from "./midi/midi-manager";
import { initRenderer, rendererProblem } from "./render";
import { Session } from "./state/session";
import { TunerSource, type ChildLike } from "./tuner/source";
import type { WorkerConfig } from "./tuner/wire";

// Frühes Absturzprotokoll: Startfehler in eine Datei neben dem Plugin schreiben,
// weil Fehler vor dem Hochfahren des SDK-Loggers sonst unsichtbar bleiben. Die
// nativen Module laden erst danach: resvg in initRenderer, MIDI über
// „@julusian/midi/lazy" erst beim ersten maintain() (midi-manager.ts).
const crashLogPath = join(__dirname, "..", "crash.log");
function crashLog(label: string, err: unknown): void {
	try {
		const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
		appendFileSync(crashLogPath, `[${new Date().toISOString()}] ${label}: ${detail}\n`);
	} catch {
		/* ignorieren */
	}
}
process.on("uncaughtException", (e) => crashLog("uncaughtException", e));
process.on("unhandledRejection", (e) => crashLog("unhandledRejection", e));
crashLog("startup", "plugin process started");

/** Rohmitschnitt aller MIDI-Nachrichten ins Log, für die Fehlersuche. */
const DEBUG_MIDI = false;
/**
 * Takt der Portpflege. Gesucht wird nur, solange ein Port fehlt oder Nuendo nicht
 * antwortet; bei gesunder Verbindung bleibt die Portliste unangetastet.
 */
const PORT_CHECK_MS = 3000;

streamDeck.logger.setLevel(LogLevel.INFO);

// Grafik: Schrift und Zwischenspeicher liegen im .sdPlugin-Ordner, bin/plugin.js darin.
try {
	initRenderer(join(__dirname, ".."));
	// Der Rückfall (flache SVG-Bilder, Ersatzschrift) wirft nicht; den Grund hier festhalten.
	const problem = rendererProblem();
	if (problem) {
		streamDeck.logger.warn(`Grafik eingeschränkt: ${problem}`);
		crashLog("renderer", problem);
	}
} catch (e) {
	crashLog("initRenderer", e);
}

midi.setLogger(streamDeck.logger);
midi.setDebug(DEBUG_MIDI);

/**
 * Eigener Tuner: Audio-Kindprozess bin/tuner-worker.js mit dem Node von Stream Deck
 * (process.execPath). Ohne Debug-Schalter des Plugins (execArgv leer: ein --inspect
 * des Elternprozesses bekäme sonst denselben Port), stdout verworfen, stderr ins Log.
 * Stirbt der Worker, bleibt das Plugin (MIDI, Anzeige) davon unberührt.
 */
const WORKER_PATH = join(__dirname, "tuner-worker.js");
function spawnTunerWorker(config: WorkerConfig): ChildLike {
	const child = fork(WORKER_PATH, [JSON.stringify(config)], {
		execPath: process.execPath,
		execArgv: [],
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let logged = 0;
	child.stderr?.on("data", (chunk: Buffer) => {
		if (logged++ < 20) streamDeck.logger.warn(`Tuner-Worker: ${String(chunk).trim().slice(0, 500)}`);
	});
	return child;
}
const tunerSource = new TunerSource({ spawn: spawnTunerWorker, log: (line) => streamDeck.logger.info(line) });

/** Globale Einstellung: Die Tuner-Taste hat Input 6 stummgeschaltet (überlebt den Neustart). */
const MUTE_MARKER = "tunerChannelMuted";

async function saveMuteMarker(on: boolean): Promise<void> {
	try {
		const current = await streamDeck.settings.getGlobalSettings();
		await streamDeck.settings.setGlobalSettings({ ...current, [MUTE_MARKER]: on });
	} catch (e) {
		crashLog("setGlobalSettings", e);
	}
}

/** Merker lesen; bleibt die Antwort aus, gilt er als nicht gesetzt. */
async function loadMuteMarker(): Promise<boolean> {
	try {
		const settings = await Promise.race([
			streamDeck.settings.getGlobalSettings(),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
		]);
		return settings !== null && (settings as Record<string, unknown>)[MUTE_MARKER] === true;
	} catch (e) {
		crashLog("getGlobalSettings", e);
		return false;
	}
}

const session = new Session({
	send: (bytes) => {
		midi.send(bytes);
	},
	log: (line) => streamDeck.logger.info(line),
	ownTuner: tunerSource,
	onChannelMuteMarker: (on) => void saveMuteMarker(on),
});
midi.addListener((message) => session.receive(message));

streamDeck.actions.registerAction(new KnobAction(session));
streamDeck.actions.registerAction(new PresetAction(session));
streamDeck.actions.registerAction(new AmpAction(session));
streamDeck.actions.registerAction(new TunerAction(session, () => tunerSource.listInputs()));
streamDeck.actions.registerAction(new DelayAction(session));

/**
 * Fehlende Ports suchen, verschwundene ersetzen. Offene Handles bleiben offen —
 * auch wenn Nuendo gerade nicht antwortet (erbe-trackinfo.md, Regel 3).
 */
function maintainPorts(): void {
	if (midi.hasInput() && midi.hasOutput() && session.connected) return;
	midi.maintain();
}

streamDeck
	.connect()
	.then(async () => {
		crashLog("startup", "connected to Stream Deck");
		// Vor dem ersten 0x22: Hing eine Kanal-Mute der Tuner-Taste, hebt sie das 0x22 auf.
		session.restoreChannelMute(await loadMuteMarker());
		midi.maintain();
		session.start();
		setInterval(maintainPorts, PORT_CHECK_MS);
	})
	.catch((e) => crashLog("connect", e));
