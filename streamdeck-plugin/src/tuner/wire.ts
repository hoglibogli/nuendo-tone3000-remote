/**
 * Nachrichten zwischen Plugin und Audio-Kindprozess (worker.ts) über den IPC-Kanal von
 * child_process.fork, und die Abbildung einer Messung auf die Stimmanzeige.
 *
 * Plugin → Worker: Startauftrag als erstes Argument (JSON, WorkerConfig); danach nur
 * noch { type: "stop" }.
 * Worker → Plugin: WorkerMessage. Messungen höchstens alle 50 ms und nur bei Änderung,
 * dazu jede Sekunde ein Lebenszeichen.
 */
import { IN_TUNE_CENTS } from "./notes";
import type { InputChoice, InputItem } from "./inputs";

/** Startauftrag an den Worker. */
export type WorkerConfig =
	| { mode: "audio"; device: string; channel: number; a4: number }
	/** Alle WASAPI-Eingänge als Mono-Kanäle melden und beenden. */
	| { mode: "list" }
	/** Ersatzquelle für Tests: WAV-Datei (ein Kanal), speed = Vielfaches der Echtzeit, 0 = so schnell es geht. */
	| { mode: "wav"; file: string; channel?: number; a4: number; speed: number };

/** Eine Messung, wie sie über den Kanal geht (gerundet, kurz). */
export interface WireReading {
	/** "E", "F#" …; Stille "--". */
	note: string;
	octave: number;
	/** Cent auf 0,1 gerundet. */
	cents: number;
	state: "silent" | "tracking" | "held";
	/** Pegel in dBFS, auf 1 dB gerundet. */
	level: number;
	/** Zeit im Audiostrom in s (für Tests und Protokoll). */
	t: number;
}

export type WorkerErrorCode =
	/** Gerät oder Kanal nicht da (RME aus, Paar nicht freigegeben). */
	| "missing-input"
	/** Audio-Modul fehlt oder lässt sich nicht laden. */
	| "no-audio"
	/** Stream ließ sich nicht öffnen oder brach ab. */
	| "stream"
	/** Sonstiges (kaputter Auftrag, Ausnahme). */
	| "failed";

export type WorkerMessage =
	| { type: "ready"; device: string; channel: number; rate: number }
	| { type: "reading"; reading: WireReading }
	| { type: "alive" }
	| { type: "inputs"; items: InputItem[] }
	| { type: "error"; code: WorkerErrorCode; text: string }
	/** Ersatzquelle zu Ende gespielt. */
	| { type: "end" };

/** Was die Stimmanzeige aus einer eigenen Messung zeigt; strukturgleich mit TunerState der Grafik. */
export interface OwnTunerState {
	note: string;
	octave: number;
	/** Gerundet, -50 … 50. */
	cent: number;
	/** Ton da (verfolgt oder gehalten). */
	locked: boolean;
	/** |cent| ≤ IN_TUNE_CENTS (gerundet, wie angezeigt). */
	inTune: boolean;
	/** Beim eigenen Tuner immer true (kein Steinberg-Tuner nötig). */
	found: true;
	/** Verfolgung verloren, letzter Wert gehalten: gedimmt, Lampen aus. */
	held: boolean;
}

/** Messung → Stimmanzeige: Cent gerundet und begrenzt, gestimmt nach der gerundeten Zahl. */
export function ownTunerState(r: WireReading): OwnTunerState {
	const silent = r.state === "silent" || r.note === "--" || r.note === "";
	if (silent) return { note: "--", octave: 0, cent: 0, locked: false, inTune: false, found: true, held: false };
	const cent = Math.min(50, Math.max(-50, Math.round(Number.isFinite(r.cents) ? r.cents : 0)));
	return {
		note: r.note,
		octave: r.octave,
		cent,
		locked: true,
		inTune: Math.abs(cent) <= IN_TUNE_CENTS,
		found: true,
		held: r.state === "held",
	};
}

/** Gleich für die Anzeige? (Pegel und Zeit zählen nicht.) */
export function sameReading(a: WireReading, b: WireReading): boolean {
	return a.note === b.note && a.octave === b.octave && a.cents === b.cents && a.state === b.state;
}

/** Für Nachrichten an das Plugin: Eingang mit Anzeigename. */
export type { InputChoice, InputItem };
