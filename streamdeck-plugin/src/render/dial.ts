/**
 * Regler-Segment der Touch-Leiste, 200x100: Knopf links, rechts daneben der Name
 * in Yellowtail und darunter der Wert 0–10 in Georgia ("5,0").
 *
 * Maße aus dem Entwurf: Knopf um (58, 50) mit Radius 33, Name ab (104, 53) in 31 px,
 * Wert ab (108, 81) in 17 px. Hintergrund je Segment (Tolex mit Versatz, Ausschnitt
 * des Leistenrahmens, Name) wird einmal gerendert; beim Drehen entsteht nur der
 * Vordergrund neu.
 */
import { SCRIPT_FONT, SERIF_FONT } from "./engine";
import { stripEdge, stripEdgeDefs, STRIP_HEIGHT } from "./edge";
import { knob, knobDefs } from "./knob";
import { Lru } from "./lru";
import { compose, type Background } from "./scene";
import { CREAM, ERROR_TEXT, VALUE_GOLD, WAIT_TEXT } from "./style";
import { fitLine, textEl } from "./text";
import { tolexDefs, tolexRect } from "./tolex";
import { PARAMS, statusKey, type Param, type Status } from "./types";

export const DIAL_WIDTH = 200;
export const DIAL_HEIGHT = STRIP_HEIGHT;

const LABELS: Record<Param, string> = { gain: "Gain", bass: "Bass", mid: "Mid", treble: "Treble" };

const KNOB_X = 58;
const KNOB_Y = 50;
const KNOB_R = 33;
const NAME_X = 104;
const NAME_Y = 53;
const NAME_SIZE = 31;
const VALUE_X = 108;
const VALUE_Y = 81;
const VALUE_SIZE = 17;
const VALUE_MIN_SIZE = 11;
/** Rechts bleibt Luft bis zur Innenlinie des Rahmens (Treble). */
const VALUE_MAX_W = DIAL_WIDTH - VALUE_X - 10;

/** Auflösung des Zwischenspeichers: 1/1000 des Wegs = 0,27° am Knopf. */
const STEPS = 1000;

const cache = new Lru<string>(256);

function segmentBackground(param: Param): Background {
	const offset = PARAMS.indexOf(param) * DIAL_WIDTH;
	return {
		key: `dial:${param}`,
		markup: (filtered) =>
			`<defs>${filtered ? tolexDefs() : ""}${stripEdgeDefs()}</defs>` +
			`<g transform="translate(${-offset} 0)">` +
			tolexRect(offset, 0, DIAL_WIDTH, DIAL_HEIGHT, filtered) +
			textEl(offset + NAME_X, NAME_Y, LABELS[param], NAME_SIZE, { family: SCRIPT_FONT, fill: CREAM }) +
			stripEdge() +
			`</g>`,
	};
}

/** Wert 0…1 als Anzeige 0–10 mit einer Nachkommastelle und Komma. */
export function formatValue(value01: number): string {
	return (value01 * 10).toFixed(1).replace(".", ",");
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

export function renderDial(param: Param, value01: number, status: Status): string {
	const q = Math.round(clamp01(value01) * STEPS) / STEPS;
	const key = `${param}|${q}|${statusKey(status)}`;
	const hit = cache.get(key);
	if (hit) return hit;

	let text: string;
	let fill: string;
	if (status.kind === "ok") {
		text = formatValue(q);
		fill = VALUE_GOLD;
	} else if (status.kind === "waiting") {
		text = "Warte…";
		fill = WAIT_TEXT;
	} else {
		text = status.text.trim() || "Fehler";
		fill = ERROR_TEXT;
	}
	const fitted = fitLine(text, SERIF_FONT, VALUE_MAX_W, VALUE_SIZE, VALUE_MIN_SIZE);

	const foreground =
		`<defs>${knobDefs()}</defs>` +
		knob(KNOB_X, KNOB_Y, KNOB_R, q, status.kind !== "ok") +
		textEl(VALUE_X, VALUE_Y, fitted.text, fitted.size, { family: SERIF_FONT, fill });

	const url = compose(DIAL_WIDTH, DIAL_HEIGHT, segmentBackground(param), foreground);
	cache.set(key, url);
	return url;
}

export function clearDialCache(): void {
	cache.clear();
}
