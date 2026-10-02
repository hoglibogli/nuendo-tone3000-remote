/**
 * Audio-Kindprozess des Stimmgeräts (bin/tuner-worker.js), gestartet vom Plugin per
 * child_process.fork mit dem Node von Stream Deck. Stürzt hier das native Audio-Modul
 * ab, stirbt nur dieser Prozess — MIDI und Anzeige im Plugin laufen weiter, und das
 * Plugin startet ihn begrenzt neu (source.ts).
 *
 * Auftrag: erstes Argument, JSON (WorkerConfig in wire.ts):
 *   audio  WASAPI-Eingang per Gerätenamen suchen, genau einen Kanal öffnen (nChannels 1,
 *          firstChannel = Kanal; nie eine Summe), bevorzugte Rate, Blöcke von 10 ms,
 *          TunerEngine füttern.
 *   list   alle WASAPI-Eingänge als Mono-Kanäle melden (inputs.ts) und enden.
 *   wav    Ersatzquelle: eine WAV-Datei (ein Kanal), beschleunigt oder in Echtzeit.
 *
 * Meldungen (WorkerMessage): ready, alle 50 ms Audiozeit die Messung — nur wenn sie sich
 * geändert hat —, jede Sekunde „alive", bei Problemen „error" mit Code und Klartext.
 * „stop" vom Plugin oder ein abgerissener IPC-Kanal (Plugin beendet) schließt den Stream
 * und beendet den Prozess; verwaiste Worker gibt es so nicht.
 *
 * Ohne IPC-Kanal (von Hand gestartet: node bin/tuner-worker.js '{"mode":"list"}') gehen
 * die Meldungen als JSON-Zeilen auf stdout.
 */
import { createRequire } from "node:module";

import { TunerEngine } from "./engine";
import { findDevice, inputLabel, listChannels, type DeviceInfo } from "./inputs";
import { readWav } from "./wav";
import { sameReading, type WireReading, type WorkerConfig, type WorkerErrorCode, type WorkerMessage } from "./wire";

/** Abstand der Messungen an das Plugin (Audiozeit). */
const EMIT_SECONDS = 0.05;
/** Lebenszeichen (Uhrzeit). */
const ALIVE_MS = 1000;
/** Kommt so lange kein Audio, gilt der Eingang als weg (Gerät abgezogen, RME aus). */
const STALL_MS = 2500;
/** Blocklänge des Streams und der Ersatzquelle. */
const BLOCK_SECONDS = 0.01;
/** RtAudio: Format 32-Bit-Float. */
const RTAUDIO_FLOAT32 = 0x10;
/** RtAudio-Fehlertypen bis hierhin sind Warnungen (WARNING, DEBUG_WARNING). */
const RTAUDIO_LAST_WARNING = 1;

// --- Melden ---------------------------------------------------------------------

function post(msg: WorkerMessage, done?: () => void): void {
	if (typeof process.send === "function" && process.connected) {
		try {
			process.send(msg, undefined, {}, () => done?.());
			return;
		} catch {
			/* Kanal zu: dann eben stdout */
		}
	}
	process.stdout.write(JSON.stringify(msg) + "\n");
	done?.();
}

function fail(code: WorkerErrorCode, text: string, exitCode = 1): void {
	post({ type: "error", code, text }, () => process.exit(exitCode));
	// Falls der Rückruf ausbleibt (Kanal schon zu): spätestens nach 1 s beenden.
	setTimeout(() => process.exit(exitCode), 1000).unref();
}

// --- Engine füttern ----------------------------------------------------------------

/** Füttert die Engine und meldet alle 50 ms Audiozeit die Messung, wenn sie sich geändert hat. */
class Feeder {
	private readonly engine: TunerEngine;
	private samples = 0;
	private nextEmit: number;
	private last: WireReading | null = null;

	constructor(
		private readonly rate: number,
		a4: number,
	) {
		this.engine = new TunerEngine(rate, { a4 });
		this.nextEmit = Math.round(EMIT_SECONDS * rate);
	}

	push(block: Float32Array): void {
		this.engine.push(block);
		this.samples += block.length;
		while (this.samples >= this.nextEmit) {
			this.nextEmit += Math.round(EMIT_SECONDS * this.rate);
			this.emit();
		}
	}

	private emit(): void {
		const r = this.engine.reading();
		const wire: WireReading = {
			note: r.noteName,
			octave: r.octave,
			cents: Math.round(r.cents * 10) / 10,
			state: r.state,
			level: Number.isFinite(r.level) ? Math.round(r.level) : -200,
			t: Math.round((this.samples / this.rate) * 100) / 100,
		};
		if (this.last !== null && sameReading(this.last, wire)) return;
		this.last = wire;
		post({ type: "reading", reading: wire });
	}
}

// --- WASAPI über audify ------------------------------------------------------------

interface AudioDevice extends DeviceInfo {
	id: number;
	preferredSampleRate: number;
}

interface RtAudioLike {
	getDevices(): AudioDevice[];
	openStream(
		output: null,
		input: { deviceId: number; nChannels: number; firstChannel: number },
		format: number,
		sampleRate: number,
		frameSize: number,
		streamName: string,
		inputCallback: (data: Buffer) => void,
		outputCallback: null,
		flags: number,
		errorCallback: (type: number, msg: string) => void,
	): number;
	start(): void;
	stop(): void;
	closeStream(): void;
	isStreamOpen(): boolean;
}

interface AudifyModule {
	RtAudio: new (api?: number) => RtAudioLike;
	RtAudioApi: { WINDOWS_WASAPI: number };
}

/** audify aus dem .sdPlugin-Ordner (bin/ liegt darin) — erst hier, nie auf oberster Ebene. */
function loadAudify(): AudifyModule {
	return createRequire(__filename)("audify") as AudifyModule;
}

function openRtAudio(): RtAudioLike | null {
	try {
		const audify = loadAudify();
		return new audify.RtAudio(audify.RtAudioApi.WINDOWS_WASAPI);
	} catch (e) {
		fail("no-audio", `Audio-Modul nicht ladbar: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

let rt: RtAudioLike | null = null;
let stopping = false;

function closeStream(): void {
	const r = rt;
	rt = null;
	if (r === null) return;
	try {
		r.stop();
	} catch {
		/* schon gestoppt */
	}
	try {
		if (r.isStreamOpen()) r.closeStream();
	} catch {
		/* egal, der Prozess endet */
	}
}

function shutdown(code = 0): void {
	if (stopping) return;
	stopping = true;
	closeStream();
	process.exit(code);
}

function runList(): void {
	const r = openRtAudio();
	if (r === null) return;
	let devices: AudioDevice[];
	try {
		devices = r.getDevices();
	} catch (e) {
		fail("failed", `Geräteliste nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
		return;
	}
	post({ type: "inputs", items: listChannels(devices) }, () => process.exit(0));
}

function runAudio(cfg: Extract<WorkerConfig, { mode: "audio" }>): void {
	const label = inputLabel({ device: cfg.device, channel: cfg.channel });
	const r = openRtAudio();
	if (r === null) return;
	let device: AudioDevice | null;
	try {
		device = findDevice(r.getDevices(), cfg.device);
	} catch (e) {
		fail("failed", `Geräteliste nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
		return;
	}
	if (device === null || cfg.channel >= device.inputChannels) {
		fail("missing-input", device === null ? `Eingang ${label} fehlt (kein Gerät „${cfg.device}“)` : `Eingang ${label} fehlt (Gerät hat ${device.inputChannels} Kanäle)`, 2);
		return;
	}
	const rate = device.preferredSampleRate > 0 ? device.preferredSampleRate : 48000;
	const feeder = new Feeder(rate, cfg.a4);
	let lastAudio = Date.now();
	try {
		r.openStream(
			null,
			{ deviceId: device.id, nChannels: 1, firstChannel: cfg.channel },
			RTAUDIO_FLOAT32,
			rate,
			Math.round(rate * BLOCK_SECONDS),
			"tone3000-tuner",
			(data) => {
				lastAudio = Date.now();
				feeder.push(new Float32Array(data.buffer, data.byteOffset, data.byteLength >> 2));
			},
			null,
			0,
			(type, msg) => {
				if (type <= RTAUDIO_LAST_WARNING) return;
				fail("stream", `Audio-Fehler ${type}: ${msg}`, 3);
			},
		);
		r.start();
	} catch (e) {
		fail("stream", `Eingang ${label} ließ sich nicht öffnen: ${e instanceof Error ? e.message : String(e)}`, 3);
		return;
	}
	rt = r;
	post({ type: "ready", device: device.name, channel: cfg.channel, rate });
	setInterval(() => {
		if (Date.now() - lastAudio > STALL_MS) {
			closeStream();
			fail("missing-input", `Eingang ${label} liefert nichts mehr`, 2);
			return;
		}
		post({ type: "alive" });
	}, ALIVE_MS);
}

function runWav(cfg: Extract<WorkerConfig, { mode: "wav" }>): void {
	let wav;
	try {
		wav = readWav(cfg.file, cfg.channel ?? 0);
	} catch (e) {
		fail("missing-input", e instanceof Error ? e.message : String(e), 2);
		return;
	}
	const feeder = new Feeder(wav.rate, cfg.a4);
	const block = Math.max(1, Math.round(wav.rate * BLOCK_SECONDS));
	const samples = wav.samples;
	post({ type: "ready", device: cfg.file, channel: cfg.channel ?? 0, rate: wav.rate });
	setInterval(() => post({ type: "alive" }), ALIVE_MS).unref();
	let pos = 0;
	const finish = (): void => post({ type: "end" }, () => process.exit(0));
	if (!(cfg.speed > 0)) {
		// So schnell es geht, aber in Happen, damit „stop" ankommt.
		const chunk = (): void => {
			if (stopping) return;
			const until = Math.min(samples.length, pos + wav.rate);
			for (; pos < until; pos += block) feeder.push(samples.subarray(pos, Math.min(until, pos + block)));
			if (pos >= samples.length) finish();
			else setImmediate(chunk);
		};
		chunk();
		return;
	}
	const timer = setInterval(() => {
		if (pos >= samples.length) {
			clearInterval(timer);
			finish();
			return;
		}
		feeder.push(samples.subarray(pos, Math.min(samples.length, pos + block)));
		pos += block;
	}, (BLOCK_SECONDS * 1000) / cfg.speed);
}

// --- Start --------------------------------------------------------------------------

function parseConfig(text: string | undefined): WorkerConfig | null {
	if (!text) return null;
	try {
		const c = JSON.parse(text) as WorkerConfig;
		if (c.mode === "list") return c;
		if (c.mode === "audio" && typeof c.device === "string" && Number.isInteger(c.channel) && c.channel >= 0) return { ...c, a4: c.a4 > 0 ? c.a4 : 440 };
		if (c.mode === "wav" && typeof c.file === "string") return { ...c, a4: c.a4 > 0 ? c.a4 : 440, speed: Number(c.speed) || 0 };
	} catch {
		/* unten */
	}
	return null;
}

process.on("message", (m) => {
	if ((m as { type?: string })?.type === "stop") shutdown(0);
});
// Plugin beendet oder abgestürzt: nicht verwaist weiterlaufen.
process.on("disconnect", () => shutdown(0));
process.on("uncaughtException", (e) => fail("failed", `Ausnahme: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));

const config = parseConfig(process.argv[2]);
if (config === null) fail("failed", `kaputter Auftrag: ${process.argv[2] ?? "(fehlt)"}`);
else if (config.mode === "list") runList();
else if (config.mode === "audio") runAudio(config);
else runWav(config);
