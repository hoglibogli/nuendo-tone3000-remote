/**
 * Tasten, 144x144, im selben Stil wie die Leiste: Tolex, goldene Kante innen,
 * Beschriftung in Yellowtail.
 *
 * - Preset-Taste: Presetname, ein- oder zweizeilig, so groß wie es passt. Das
 *   gewählte Preset trägt den breiten, hellen Goldrahmen — der Rahmen ist das
 *   Kennzeichen, nicht die Schrift.
 * - Schalter (Tone3000, Tuner, Delay): Jewel-Lampe oben, Name darunter. An =
 *   Lampe leuchtet, Rahmen heller; aus = Lampe dunkel.
 * - waiting/error: kleiner Text unten („Warte…" bzw. die Ursache), Lampe dunkel,
 *   Beschriftung zurückgenommen. Auf der Tuner-Taste in klarer Schrift (Segoe UI,
 *   Ursachen halbfett) wie im Tuner-Modus (tuner.ts) und auf der Stimmanzeige: Der
 *   Name bleibt Yellowtail, alles, was die Taste meldet, ist klar zu lesen.
 */
import { CLEAR_FONT, SCRIPT_FONT, SEMIBOLD, SERIF_FONT } from "./engine";
import { keyEdge, type KeyEdge } from "./edge";
import { knob, knobDefs } from "./knob";
import { jewelLamp, type LampColor } from "./lamp";
import { Lru } from "./lru";
import { compose, type Background } from "./scene";
import { CREAM, ERROR_TEXT, WAIT_TEXT } from "./style";
import { blockEl, centeredX, fitBlock, fitLine, textEl, type Box } from "./text";
import { tolexDefs, tolexRect } from "./tolex";
import { statusKey, type Status } from "./types";

export const KEY_SIZE = 144;

export type ToggleKind = "amp" | "tuner" | "delay";

const TOGGLE_LABELS: Record<ToggleKind, string> = { amp: "Tone3000", tuner: "Tuner", delay: "Delay" };

/** Name des gewählten Presets: etwas heller als die übrigen. */
const ACTIVE_NAME = "#fff8e2";
/** Beschriftung, solange der Zustand unbekannt ist. */
const UNKNOWN_OPACITY = 0.55;
/** Preset-Taste ohne gewähltes Preset (leerer Name): abgedunkelt, damit sie auffällt. */
export const UNSET_PRESET_LABEL = "Preset wählen";

/** Innenfläche für Schrift; gleich für aktiv und inaktiv, damit der Name beim Wählen nicht springt. */
const TEXT_LEFT = 18;
const TEXT_RIGHT = KEY_SIZE - 18;
const STATUS_BASELINE = 126;
const STATUS_SIZE = 13;
/** Klare Schrift wirkt bei gleicher Größe kleiner als Georgia; so steht sie gleich groß da. */
const CLEAR_STATUS_SIZE = 15;

const cache = new Lru<string>(128);

const KEY_BACKGROUND: Background = {
	key: "key",
	markup: (filtered) =>
		(filtered ? `<defs>${tolexDefs()}</defs>` : "") + tolexRect(0, 0, KEY_SIZE, KEY_SIZE, filtered),
};

/** Dasselbe Tolex, gerendert mit Segoe UI im Schriftsatz (Tuner-Taste). */
const KEY_BACKGROUND_CLEAR: Background = { ...KEY_BACKGROUND, key: "key:clear", fonts: "clear" };

/** Kleiner Zustandstext unten, oder nichts bei ok. clear: Segoe UI statt Georgia. */
function statusLine(status: Status, clear = false): string {
	if (status.kind === "ok") return "";
	const text = status.kind === "waiting" ? "Warte…" : status.text.trim() || "Fehler";
	const fill = status.kind === "waiting" ? WAIT_TEXT : ERROR_TEXT;
	const family = clear ? CLEAR_FONT : SERIF_FONT;
	const weight = clear && status.kind === "error" ? SEMIBOLD : undefined;
	const fitted = fitLine(text, family, TEXT_RIGHT - TEXT_LEFT, clear ? CLEAR_STATUS_SIZE : STATUS_SIZE, 9, weight);
	const x = centeredX(fitted.text, family, fitted.size, KEY_SIZE / 2, weight);
	return textEl(x, STATUS_BASELINE, fitted.text, fitted.size, { family, fill, weight });
}

export function renderPresetKey(name: string, active: boolean, status: Status): string {
	const key = `p|${name}|${active ? 1 : 0}|${statusKey(status)}`;
	const hit = cache.get(key);
	if (hit) return hit;

	const ok = status.kind === "ok";
	const shown = name.trim() || UNSET_PRESET_LABEL;
	const box: Box = { x: TEXT_LEFT, y: 19, w: TEXT_RIGHT - TEXT_LEFT, h: ok ? 106 : 88 };
	const block = fitBlock(shown, SCRIPT_FONT, box, {
		maxSize: 44,
		minSize: 15,
		maxLines: 2,
		lineGap: 1.0,
		preferSingle: 0.88,
	});
	const edge: KeyEdge = active ? "active" : "plain";
	const foreground =
		keyEdge(edge, KEY_SIZE) +
		blockEl(block, {
			family: SCRIPT_FONT,
			fill: active ? ACTIVE_NAME : CREAM,
			opacity: ok && name.trim() ? 1 : UNKNOWN_OPACITY,
		}) +
		statusLine(status);

	const url = compose(KEY_SIZE, KEY_SIZE, KEY_BACKGROUND, foreground);
	cache.set(key, url);
	return url;
}

/** redEdge: roter statt goldener Rahmen (Tuner-Taste, automatische Stummschaltung an). */
export function renderToggleKey(kind: ToggleKind, on: boolean, status: Status, redEdge = false): string {
	const key = `t|${kind}|${on ? 1 : 0}|${redEdge ? 1 : 0}|${statusKey(status)}`;
	const hit = cache.get(key);
	if (hit) return hit;

	const ok = status.kind === "ok";
	const lit = ok && on;
	const lampY = ok ? 54 : 49;
	const labelBaseline = ok ? 119 : 106;
	const label = TOGGLE_LABELS[kind];
	// Alle drei Schalter in derselben Größe; „Tone3000" ist der breiteste und passt bei 30 px.
	const fitted = fitLine(label, SCRIPT_FONT, TEXT_RIGHT - TEXT_LEFT - 4, 30, 16);
	const labelX = centeredX(fitted.text, SCRIPT_FONT, fitted.size, KEY_SIZE / 2);
	// Tuner: Meldungen („Tuner?", „stumm", „Kanal?", „Warte…") in klarer Schrift.
	const clear = kind === "tuner" && !ok;

	const foreground =
		jewelLamp(KEY_SIZE / 2, lampY, 25, kind as LampColor, lit) +
		keyEdge(redEdge ? (lit ? "redBright" : "red") : lit ? "bright" : "plain", KEY_SIZE) +
		textEl(labelX, labelBaseline, fitted.text, fitted.size, {
			family: SCRIPT_FONT,
			fill: CREAM,
			opacity: ok ? 1 : UNKNOWN_OPACITY,
		}) +
		statusLine(status, clear);

	const url = compose(KEY_SIZE, KEY_SIZE, clear ? KEY_BACKGROUND_CLEAR : KEY_BACKGROUND, foreground);
	cache.set(key, url);
	return url;
}

/** Standardbild der Regler-Aktion (Aktionsliste, Tasten-Vorschau): ein großer Knopf. */
export function renderKnobKey(value01 = 0.7): string {
	const foreground = `<defs>${knobDefs()}</defs>` + keyEdge("plain", KEY_SIZE) + knob(70, 70, 44, value01, false);
	return compose(KEY_SIZE, KEY_SIZE, KEY_BACKGROUND, foreground);
}

export function clearKeyCache(): void {
	cache.clear();
}
