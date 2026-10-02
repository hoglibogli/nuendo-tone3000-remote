/**
 * Schnittstelle zwischen Logik und Grafik. Die Logik-Seite benutzt nur diese
 * Exporte; alles Weitere liegt in den Modulen daneben.
 *
 * Alle Funktionen sind synchron und liefern data:image/png;base64-URLs, fertig für
 * setFeedback (Regler, 200x100) und setImage (Tasten, 144x144). Jedes Ergebnis wird
 * je Zustand gemerkt (LRU), die teuren Hintergründe nur einmal gerendert. Gemessen
 * (test/render.test.cjs): ein Regler-Bild nach dem Aufwärmen um 2–3 ms.
 *
 * Fehlt resvg zur Laufzeit, kommen SVG-Data-URLs mit flachem Hintergrund — das
 * Plugin bleibt bedienbar. Den Grund nennt rendererProblem(); das Plugin schreibt
 * ihn nach initRenderer ins Log, sonst bliebe der Rückfall ohne Spur.
 */
import { engineProblem, initEngine } from "./engine";
import { clearDialCache, renderDial as dial } from "./dial";
import { clearKeyCache, renderPresetKey as presetKey, renderToggleKey as toggleKey } from "./keys";
import { clearBackgrounds } from "./scene";
import { clearTunerCache, renderTunerKey as tunerKey, renderTunerSegment as tunerSegment } from "./tuner";
import type { Param, Status, TunerState } from "./types";

export type { Param, Status, TunerState } from "./types";

/** Einmal beim Start: Pfad des .sdPlugin-Ordners (Schrift, resvg). Wirft nicht. */
export function initRenderer(pluginDir: string): void {
	if (!initEngine(pluginDir)) return;
	clearBackgrounds();
	clearDialCache();
	clearKeyCache();
	clearTunerCache();
}

/**
 * Warum die Grafik eingeschränkt läuft (resvg nicht geladen, Yellowtail, Georgia
 * oder Segoe UI fehlt); null, wenn alles da ist. Nach initRenderer abfragen.
 */
export function rendererProblem(): string | null {
	return engineProblem();
}

/** Regler-Segment 200x100. value01 = 0…1, angezeigt als 0,0…10,0. */
export function renderDial(param: Param, value01: number, status: Status): string {
	return dial(param, value01, status);
}

/** Preset-Taste 144x144; active = breiter heller Goldrahmen. Leerer Name = abgedunkelter Platzhalter „Preset wählen". */
export function renderPresetKey(name: string, active: boolean, status: Status): string {
	return presetKey(name, active, status);
}

/**
 * Schalter-Taste 144x144 mit Jewel-Lampe: amp = „Tone3000", tuner, delay. Die Tuner-Taste
 * setzt ihre Meldungen („Tuner?", „stumm", „Kanal?", „Warte…") in klarer Schrift.
 */
export function renderToggleKey(kind: "amp" | "tuner" | "delay", on: boolean, status: Status): string {
	return toggleKey(kind, on, status);
}

/**
 * Segment index (0 Gain, 1 Bass, 2 Mid, 3 Treble) der Stimmanzeige, 200x100 — die
 * vier zusammen ergeben eine 800x100-Leiste. state null = noch keine Messung.
 * Segmente, in die sich nichts geändert hat, liefern dieselbe Zeichenkette.
 */
export function renderTunerSegment(index: number, state: TunerState | null, status: Status): string {
	return tunerSegment(index, state, status);
}

/** Tuner-Taste 144x144 im Tuner-Modus: Note in klarer Schrift, Cent-Balken, Lampe. */
export function renderTunerKey(state: TunerState | null, status: Status): string {
	return tunerKey(state, status);
}
