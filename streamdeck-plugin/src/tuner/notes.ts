/**
 * Noten für das Stimmgerät: Frequenz ↔ MIDI-Nummer ↔ Name und Oktave.
 *
 * Oktaven in wissenschaftlicher Schreibweise: A4 = Kammerton, das eingestrichene C
 * ist C4, die tiefe E-Saite der Gitarre E2, die hohe E4. Namen englisch mit Kreuz
 * ("F#"); auf Wunsch "H" statt "B" (das deutsche B für Ais gibt es nicht, Ais bleibt "A#").
 */

/** |Cent| bis hierhin gilt als gestimmt. */
export const IN_TUNE_CENTS = 2;

/** Kammerton A4 in Hz, wenn nichts anderes eingestellt ist. */
export const DEFAULT_A4 = 440;

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Cent je Oktave geteilt durch ln 2: Cent = CENTS_PER_LN · ln(f / Bezug). */
export const CENTS_PER_LN = 1200 / Math.LN2;

/** MIDI-Nummer einer Frequenz, mit Nachkommastellen (A4 = 69). */
export function midiOf(frequency: number, a4 = DEFAULT_A4): number {
	return 69 + 12 * Math.log2(frequency / a4);
}

/** Frequenz einer (auch gebrochenen) MIDI-Nummer. */
export function frequencyOf(midi: number, a4 = DEFAULT_A4): number {
	return a4 * Math.pow(2, (midi - 69) / 12);
}

/** Name der nächstliegenden Note ohne Oktave: "E", "F#", mit germanH "H" statt "B". */
export function noteName(midi: number, germanH = false): string {
	const name = SHARP_NAMES[((Math.round(midi) % 12) + 12) % 12];
	return germanH && name === "B" ? "H" : name;
}

/** Oktave der nächstliegenden Note (C4 = eingestrichenes C). */
export function octaveOf(midi: number): number {
	return Math.floor(Math.round(midi) / 12) - 1;
}

/** Abstand in Cent von f zu ref; positiv = höher. */
export function centsBetween(frequency: number, reference: number): number {
	return CENTS_PER_LN * Math.log(frequency / reference);
}
