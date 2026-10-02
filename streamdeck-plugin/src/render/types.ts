/**
 * Gemeinsame Typen der Schnittstelle zwischen Logik und Grafik (siehe index.ts).
 */

/** Die vier Regler von TONE3000, in der Reihenfolge der Leiste von links. */
export type Param = "gain" | "bass" | "mid" | "treble";

/** ok = Wert gilt; waiting = noch keine Antwort von Nuendo; error = Ursache im Klartext, kurz. */
export type Status = { kind: "ok" } | { kind: "waiting" } | { kind: "error"; text: string };

export const PARAMS: readonly Param[] = ["gain", "bass", "mid", "treble"];

/**
 * Messung des Steinberg-Tuners für die Stimmanzeige (aus 0x24); strukturgleich mit
 * TunerReading in state/store.ts, das noch mehr Felder trägt.
 */
export type TunerState = {
	/** Klartext der Note ohne Leerzeichen: "E", "F#"; Stille "--" oder leer. */
	note: string;
	/** Oktave aus „Oct", klein neben der Note. */
	octave: number;
	/** -50 … 50. */
	cent: number;
	/** Ton erkannt (Locked). Ohne: Stille, keine Nadel. */
	locked: boolean;
	/** Gestimmt (In Tune): grüne Lampen, grünliche Nadel, grüne Cent-Zahl. */
	inTune: boolean;
	/** Steinberg-Tuner in Slot 1 gefunden (eigener Tuner: immer). Ohne: Hinweis statt Skala. */
	found: boolean;
	/**
	 * Eigener Tuner: Verfolgung verloren, letzter Wert gehalten. Nadel, Note und Cent
	 * gedimmt, Lampen aus. Fehlt = nein.
	 */
	held?: boolean;
};

/** Fester Schlüssel eines Zustands für die Zwischenspeicher. */
export function statusKey(status: Status): string {
	if (status.kind === "error") return `e:${status.text}`;
	return status.kind;
}
