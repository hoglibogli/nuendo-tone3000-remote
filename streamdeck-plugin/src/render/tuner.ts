/**
 * Stimmanzeige (Protokoll 4, Entwurf T1): die Touch-Leiste über den vier linken
 * Reglern als ein durchgehendes Stimmgerät im Marshall-Stil, dazu die Tuner-Taste.
 *
 * Leiste, 800x100 in vier Segmenten zu 200x100 (Gain, Bass, Mid, Treble):
 *
 *   x 12–100   „Tuner" klein in Yellowtail, die Marshall-Note
 *   x 120–680  Cent-Skala -50 … +50, ein Strich alle 5 Cent, ±25 und ±50 länger,
 *              0 golden und am längsten; „b" links, „#" rechts an den Enden.
 *              Mitte bei x = 400, genau zwischen Bass- und Mid-Regler.
 *              Darauf die cremefarbene Nadel mit goldenem Fußpunkt (gestimmt: grünlich).
 *   oben Mitte die Note groß in Segoe UI halbfett, die Oktave klein daneben,
 *              links und rechts davon je eine Jewel-Lampe (grün bei gestimmt).
 *   x 706–794  Cent-Anzeige in Segoe UI normal: „−16" groß, „Cent" klein darunter,
 *              grün bei gestimmt.
 *
 * Stille: Note „--", keine Nadel, keine Cent-Zahl. Gehalten (eigener Tuner, Verfolgung
 * verloren): Nadel, Note und Cent gedimmt an ihrem letzten Platz, Lampen aus.
 * Tuner fehlt: „Steinberg-Tuner in Slot 1 fehlt" statt der Skala, eigener Tuner ohne
 * Eingang: „Eingang MADI 6 fehlt" (als Status). Keine Verbindung: „Warte…".
 *
 * Wie bei den Reglern zeichnet jedes Segment die ganze Leiste und sieht nur seinen
 * Ausschnitt; nebeneinander ergibt das ein Bild. Alles Feste (Tolex, Kante, Skala,
 * dunkle Lampen, Beschriftung) steckt im Hintergrund je Segment, einmal gerendert.
 * Der Vordergrund besteht aus Teilen mit waagerechter Ausdehnung; ein Segment nimmt
 * nur die Teile, die in seinen Ausschnitt reichen, und sein Schlüssel im
 * Zwischenspeicher besteht nur aus deren Schlüsseln. Bewegt sich die Nadel innerhalb
 * von Mid, bleiben Gain und Bass dieselbe Zeichenkette — die Aktion setzt dort kein
 * neues Bild (ImageCache vergleicht). So ändern sich je Messung meist nur zwei
 * Segmente: das mit der Nadel und Treble mit der Cent-Zahl.
 *
 * Taste, 144x144: Jewel-Lampe oben (grün gestimmt, rot verstimmt, dunkel bei Stille und
 * gehalten), die Note groß in Segoe UI halbfett, darunter ein kleiner Cent-Balken mit
 * Marke (gehalten gedimmt); heller Goldrahmen, solange der Modus an ist.
 */
import { CLEAR_FONT, measureInk, SCRIPT_FONT, SEMIBOLD } from "./engine";
import { keyEdge, stripEdge, stripEdgeDefs, STRIP_HEIGHT, STRIP_WIDTH } from "./edge";
import { jewelLamp } from "./lamp";
import { Lru } from "./lru";
import { compose, type Background } from "./scene";
import { CREAM, ERROR_TEXT, n, VALUE_GOLD, WAIT_TEXT } from "./style";
import { textEl } from "./text";
import { tolexDefs, tolexRect } from "./tolex";
import { statusKey, type Status, type TunerState } from "./types";

export const TUNER_SEGMENT_WIDTH = 200;
export const TUNER_SEGMENT_HEIGHT = STRIP_HEIGHT;
export const TUNER_SEGMENTS = STRIP_WIDTH / TUNER_SEGMENT_WIDTH;
export const TUNER_KEY_SIZE = 144;

/** Text der Leiste, wenn bit3 = 0. */
export const MISSING_TEXT = "Steinberg-Tuner in Slot 1 fehlt";
/** Text der Taste, wenn bit3 = 0. */
export const MISSING_KEY_TEXT = "Tuner?";

// --- Leiste, Leistenkoordinaten ---------------------------------------------
const CENTER_X = 400;
const SCALE_LEFT = 120;
const SCALE_RIGHT = 680;
const PX_PER_CENT = (SCALE_RIGHT - SCALE_LEFT) / 100;
/** Grundlinie der Skala; die Striche stehen darauf. */
const SCALE_Y = 86;
const NEEDLE_TOP = 61;
/** Halbe Breite der Nadel samt Schatten, Lichthof und Fußpunkt. */
const NEEDLE_REACH = 7;
const NOTE_SIZE = 54;
const NOTE_BASELINE = 55;
const OCTAVE_SIZE = 22;
const LAMP_DX = 90;
const LAMP_Y = 36;
const LAMP_R = 13;
const LABEL_CX = 58;
const LABEL_BASELINE = 62;
const LABEL_SIZE = 30;
const DIVIDER_X = 706;
const CENT_CX = 750;
const CENT_SIZE = 34;
const CENT_BASELINE = 55;
const CENT_LABEL_SIZE = 13;
const CENT_LABEL_BASELINE = 75;
const MESSAGE_SIZE = 24;
const MESSAGE_BASELINE = 59;

// --- Farben ------------------------------------------------------------------
const NEEDLE = "#f4eacb";
const NEEDLE_IN_TUNE = "#c9f7b6";
const IN_TUNE_GLOW = "#5cff7a";
const IN_TUNE_TEXT = "#8fe89c";
const SILENT_OPACITY = 0.42;
/** Gehalten: deutlich zurückgenommen, aber lesbar. */
const HELD_OPACITY = 0.45;

/** Ein Teil des Vordergrunds mit waagerechter Ausdehnung in Leistenkoordinaten. */
type Item = { x0: number; x1: number; key: string; svg: string };
type Variant = "scale" | "bare";

const segmentCache = new Lru<string>(512);
const keyCache = new Lru<string>(256);

/** Ton da? Ohne Locked oder mit leerer Note bzw. „--" ist Stille. */
export function isSilent(state: TunerState): boolean {
	const note = state.note.trim();
	return !state.locked || note === "" || note === "--";
}

/** Cent als Anzeige: „+3", „0", „−16" (echtes Minuszeichen, so breit wie das Plus). */
export function formatCent(cent: number): string {
	const c = Math.round(cent);
	if (c > 0) return `+${c}`;
	if (c < 0) return `−${-c}`;
	return "0";
}

function clampCent(cent: number): number {
	if (!Number.isFinite(cent)) return 0;
	return Math.min(50, Math.max(-50, Math.round(cent)));
}

/** x des Textanfangs, damit die Tinte um cx steht; dazu linke und rechte Tintenkante. */
function centered(text: string, size: number, cx: number, weight?: number): { x: number; left: number; right: number } {
	const ink = measureInk(CLEAR_FONT, text, weight);
	const x = cx - ((ink.left + ink.right) / 2) * size;
	return { x, left: x + ink.left * size, right: x + ink.right * size };
}

/** Größte Schrift bis maxSize, mit der der Text in maxW passt (mindestens minSize). */
function fitSize(text: string, maxW: number, maxSize: number, minSize: number, weight?: number): number {
	const ink = measureInk(CLEAR_FONT, text, weight);
	const w = ink.right - ink.left;
	if (w <= 0) return maxSize;
	return Math.max(minSize, Math.min(maxSize, maxW / w));
}

function clearText(x: number, y: number, text: string, size: number, fill: string, weight?: number, opacity?: number): string {
	return textEl(x, y, text, size, { family: CLEAR_FONT, fill, weight, opacity });
}

//------------------------------------------------------------------------------
// Leiste: Hintergrund
//------------------------------------------------------------------------------

function scaleMarkup(): string {
	let s = `<rect x="${SCALE_LEFT}" y="${SCALE_Y - 0.25}" width="${SCALE_RIGHT - SCALE_LEFT}" height="1.5" fill="${CREAM}" fill-opacity=".45"/>`;
	for (let c = -50; c <= 50; c += 5) {
		const x = CENTER_X + c * PX_PER_CENT;
		const a = Math.abs(c);
		if (c === 0) {
			s += `<rect x="${n(x - 1.5)}" y="${SCALE_Y - 18}" width="3" height="18" fill="url(#tz)"/>`;
			continue;
		}
		const h = a === 50 ? 13 : a === 25 ? 11 : 7;
		const w = a === 50 || a === 25 ? 2 : 1.4;
		const op = a === 50 || a === 25 ? ".8" : ".6";
		s += `<rect x="${n(x - w / 2)}" y="${SCALE_Y - h}" width="${n(w)}" height="${h}" fill="${CREAM}" fill-opacity="${op}"/>`;
	}
	// b und # an den Skalenenden
	const flat = centered("b", 18, SCALE_LEFT - 13, SEMIBOLD);
	const sharp = centered("#", 18, SCALE_RIGHT + 13, SEMIBOLD);
	s += clearText(flat.x, SCALE_Y, "b", 18, VALUE_GOLD, SEMIBOLD);
	s += clearText(sharp.x, SCALE_Y, "#", 18, VALUE_GOLD, SEMIBOLD);
	return s;
}

/** Die festen Teile der Leiste, mit Ausdehnung wie der Vordergrund. */
function staticItems(variant: Variant): Item[] {
	const ink = measureInk(SCRIPT_FONT, "Tuner");
	const labelX = LABEL_CX - ((ink.left + ink.right) / 2) * LABEL_SIZE;
	const items: Item[] = [
		{
			x0: labelX + ink.left * LABEL_SIZE - 2,
			x1: labelX + ink.right * LABEL_SIZE + 2,
			key: "label",
			svg: textEl(labelX, LABEL_BASELINE, "Tuner", LABEL_SIZE, { family: SCRIPT_FONT, fill: CREAM }),
		},
	];
	if (variant === "bare") return items;
	const label = centered("Cent", CENT_LABEL_SIZE, CENT_CX);
	items.push(
		{ x0: SCALE_LEFT - 24, x1: SCALE_RIGHT + 24, key: "scale", svg: scaleMarkup() },
		// dunkle Lampen; gestimmt legt der Vordergrund leuchtende darüber
		{ x0: CENTER_X - LAMP_DX - 16, x1: CENTER_X - LAMP_DX + 16, key: "lamp-l", svg: jewelLamp(CENTER_X - LAMP_DX, LAMP_Y, LAMP_R, "green", false, "bl") },
		{ x0: CENTER_X + LAMP_DX - 16, x1: CENTER_X + LAMP_DX + 16, key: "lamp-r", svg: jewelLamp(CENTER_X + LAMP_DX, LAMP_Y, LAMP_R, "green", false, "br") },
		// Cent-Anzeige: Trennlinie und Beschriftung
		{
			x0: DIVIDER_X - 1,
			x1: STRIP_WIDTH,
			key: "cent",
			svg:
				`<rect x="${DIVIDER_X - 0.5}" y="18" width="1" height="${SCALE_Y - 18}" fill="${VALUE_GOLD}" fill-opacity=".35"/>` +
				clearText(label.x, CENT_LABEL_BASELINE, "Cent", CENT_LABEL_SIZE, VALUE_GOLD, undefined, 0.8),
		},
	);
	return items;
}

/** Nur die Teile, die in das Segment reichen: Was ganz außerhalb liegt, bleibt weg. */
function within(items: Item[], left: number): Item[] {
	return items.filter((it) => it.x1 > left && it.x0 < left + TUNER_SEGMENT_WIDTH);
}

function segmentBackground(index: number, variant: Variant): Background {
	const offset = index * TUNER_SEGMENT_WIDTH;
	return {
		key: `tuner:${variant}:${index}`,
		fonts: "clear",
		markup: (filtered) =>
			`<defs>${filtered ? tolexDefs() : ""}${stripEdgeDefs()}` +
			`<linearGradient id="tz" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3c0"/><stop offset="1" stop-color="#c99a32"/></linearGradient>` +
			`</defs>` +
			`<g transform="translate(${-offset} 0)">` +
			tolexRect(offset, 0, TUNER_SEGMENT_WIDTH, TUNER_SEGMENT_HEIGHT, filtered) +
			within(staticItems(variant), offset)
				.map((it) => it.svg)
				.join("") +
			stripEdge() +
			`</g>`,
	};
}

//------------------------------------------------------------------------------
// Leiste: Vordergrund
//------------------------------------------------------------------------------

function needleItem(cent: number, inTune: boolean, held = false): Item {
	const x = CENTER_X + cent * PX_PER_CENT;
	// Gehalten: nie grün (die Lampen sind aus), nur die gedimmte Nadel am letzten Platz.
	if (held) inTune = false;
	const fill = inTune ? NEEDLE_IN_TUNE : NEEDLE;
	const len = SCALE_Y - NEEDLE_TOP;
	let svg =
		`<defs><radialGradient id="nf" cx=".38" cy=".35" r=".7"><stop offset="0" stop-color="#fff6cc"/>` +
		`<stop offset=".6" stop-color="#d9b04a"/><stop offset="1" stop-color="#7d5b16"/></radialGradient></defs>`;
	if (inTune) {
		svg +=
			`<rect x="${n(x - 5.5)}" y="${NEEDLE_TOP - 3}" width="11" height="${len + 6}" rx="5.5" fill="${IN_TUNE_GLOW}" fill-opacity=".16"/>` +
			`<rect x="${n(x - 3.5)}" y="${NEEDLE_TOP - 1}" width="7" height="${len + 2}" rx="3.5" fill="${IN_TUNE_GLOW}" fill-opacity=".22"/>`;
	}
	svg +=
		`<rect x="${n(x - 2 + 1.5)}" y="${NEEDLE_TOP + 2}" width="4" height="${len}" rx="2" fill="#000" fill-opacity=".5"/>` +
		`<rect x="${n(x - 2)}" y="${NEEDLE_TOP}" width="4" height="${len}" rx="2" fill="${fill}" stroke="#000" stroke-opacity=".45" stroke-width=".6"/>` +
		`<circle cx="${n(x + 1)}" cy="${SCALE_Y + 1.5}" r="5" fill="#000" fill-opacity=".45"/>` +
		`<circle cx="${n(x)}" cy="${SCALE_Y}" r="4.6" fill="url(#nf)" stroke="#000" stroke-opacity=".55" stroke-width=".6"/>`;
	if (held) svg = `<g opacity="${HELD_OPACITY}">${svg}</g>`;
	return { x0: x - NEEDLE_REACH, x1: x + NEEDLE_REACH, key: `nd${cent}${inTune ? "g" : ""}${held ? "h" : ""}`, svg };
}

/** dim: Stille (nur die Note, stärker); held: gehalten (Note und Oktave). */
function noteItem(note: string, octave: number | null, dim: boolean, held = false): Item {
	const at = centered(note, NOTE_SIZE, CENTER_X, SEMIBOLD);
	const opacity = dim ? SILENT_OPACITY : held ? HELD_OPACITY : undefined;
	let svg = clearText(at.x, NOTE_BASELINE, note, NOTE_SIZE, CREAM, SEMIBOLD, opacity);
	let right = at.right;
	if (octave !== null) {
		const oct = String(octave);
		const ink = measureInk(CLEAR_FONT, oct);
		const ox = at.right + 3 - ink.left * OCTAVE_SIZE;
		svg += clearText(ox, NOTE_BASELINE, oct, OCTAVE_SIZE, VALUE_GOLD, undefined, held ? HELD_OPACITY : undefined);
		right = ox + ink.right * OCTAVE_SIZE;
	}
	return { x0: at.left - 2, x1: right + 2, key: `n${note}\u0000${octave ?? ""}${dim ? "d" : ""}${held ? "h" : ""}`, svg };
}

function messageItem(text: string, fill: string, weight: number | undefined, baseline: number, size: number): Item {
	const fitted = fitSize(text, 560, size, 12, weight);
	const at = centered(text, fitted, CENTER_X, weight);
	return {
		x0: at.left - 2,
		x1: at.right + 2,
		key: `m${text}\u0000${fill}`,
		svg: clearText(at.x, baseline, text, fitted, fill, weight),
	};
}

function litLamp(cx: number, prefix: string): Item {
	return {
		x0: cx - LAMP_R * 1.8,
		x1: cx + LAMP_R * 1.8,
		key: `l${prefix}`,
		svg: jewelLamp(cx, LAMP_Y, LAMP_R, "green", true, prefix),
	};
}

function centItem(cent: number, inTune: boolean, held = false): Item {
	const text = formatCent(cent);
	const at = centered(text, CENT_SIZE, CENT_CX);
	const green = inTune && !held;
	return {
		x0: DIVIDER_X + 1,
		x1: STRIP_WIDTH - 6,
		key: `c${text}${green ? "g" : ""}${held ? "h" : ""}`,
		svg: clearText(at.x, CENT_BASELINE, text, CENT_SIZE, green ? IN_TUNE_TEXT : CREAM, undefined, held ? HELD_OPACITY : undefined),
	};
}

/** Was die ganze Leiste zeigt: Hintergrund-Variante und Vordergrund-Teile. */
function stripContent(state: TunerState | null, status: Status): { variant: Variant; items: Item[] } {
	if (status.kind === "error") {
		const text = status.text.trim() || "Fehler";
		return { variant: "bare", items: [messageItem(text, ERROR_TEXT, SEMIBOLD, MESSAGE_BASELINE, MESSAGE_SIZE)] };
	}
	if (status.kind === "waiting" || state === null) {
		return { variant: "scale", items: [messageItem("Warte…", WAIT_TEXT, undefined, NOTE_BASELINE - 4, 26)] };
	}
	if (!state.found) {
		return { variant: "bare", items: [messageItem(MISSING_TEXT, ERROR_TEXT, SEMIBOLD, MESSAGE_BASELINE, MESSAGE_SIZE)] };
	}
	if (isSilent(state)) return { variant: "scale", items: [noteItem("--", null, true)] };
	const cent = clampCent(state.cent);
	const held = state.held === true;
	const items = [noteItem(state.note.trim(), state.octave, false, held), needleItem(cent, state.inTune, held), centItem(cent, state.inTune, held)];
	if (state.inTune && !held) items.push(litLamp(CENTER_X - LAMP_DX, "gl"), litLamp(CENTER_X + LAMP_DX, "gr"));
	return { variant: "scale", items };
}

/**
 * Segment index (0 Gain … 3 Treble) der Stimmanzeige, 200x100 als PNG-Data-URL.
 * state null = noch keine Messung (zeigt „Warte…").
 */
export function renderTunerSegment(index: number, state: TunerState | null, status: Status): string {
	const i = Math.min(TUNER_SEGMENTS - 1, Math.max(0, Math.floor(Number.isFinite(index) ? index : 0)));
	const { variant, items } = stripContent(state, status);
	const left = i * TUNER_SEGMENT_WIDTH;
	const visible = within(items, left);
	const key = `${i}|${variant}|${visible.map((it) => it.key).join("|")}`;
	const hit = segmentCache.get(key);
	if (hit) return hit;

	const foreground = visible.length ? `<g transform="translate(${-left} 0)">${visible.map((it) => it.svg).join("")}</g>` : "";
	const url = compose(TUNER_SEGMENT_WIDTH, TUNER_SEGMENT_HEIGHT, segmentBackground(i, variant), foreground);
	segmentCache.set(key, url);
	return url;
}

//------------------------------------------------------------------------------
// Taste
//------------------------------------------------------------------------------

const KEY_BACKGROUND: Background = {
	key: "tuner-key",
	fonts: "clear",
	markup: (filtered) =>
		(filtered ? `<defs>${tolexDefs()}</defs>` : "") + tolexRect(0, 0, TUNER_KEY_SIZE, TUNER_KEY_SIZE, filtered),
};

const KEY_CX = TUNER_KEY_SIZE / 2;
const KEY_LAMP_Y = 33;
const KEY_LAMP_R = 17;
const KEY_NOTE_SIZE = 50;
const KEY_NOTE_BASELINE = 99;
const KEY_TEXT_MAX_W = 104;
const BAR_Y = 118;
const BAR_HALF = 44;
const BAR_PX_PER_CENT = BAR_HALF / 50;

function centBar(cent: number | null, inTune: boolean, held = false): string {
	let s =
		`<rect x="${KEY_CX - BAR_HALF - 2}" y="${BAR_Y - 3}" width="${2 * BAR_HALF + 4}" height="6" rx="3" fill="#000" fill-opacity=".55" stroke="${VALUE_GOLD}" stroke-opacity=".55" stroke-width=".8"/>` +
		`<rect x="${KEY_CX - 1}" y="${BAR_Y - 7}" width="2" height="14" fill="${VALUE_GOLD}"/>`;
	for (const c of [-25, 25]) {
		s += `<rect x="${n(KEY_CX + c * BAR_PX_PER_CENT - 0.6)}" y="${BAR_Y - 4.5}" width="1.2" height="9" fill="${CREAM}" fill-opacity=".55"/>`;
	}
	if (cent !== null) {
		const x = KEY_CX + clampCent(cent) * BAR_PX_PER_CENT;
		const marker =
			`<rect x="${n(x - 3 + 1)}" y="${BAR_Y - 7 + 1.5}" width="6" height="14" rx="1.5" fill="#000" fill-opacity=".5"/>` +
			`<rect x="${n(x - 3)}" y="${BAR_Y - 7}" width="6" height="14" rx="1.5" fill="${inTune && !held ? NEEDLE_IN_TUNE : NEEDLE}" stroke="#000" stroke-opacity=".5" stroke-width=".6"/>`;
		s += held ? `<g opacity="${HELD_OPACITY}">${marker}</g>` : marker;
	}
	return s;
}

function keyNote(note: string, octave: number | null, fill: string, opacity?: number, octaveOpacity?: number): string {
	const size = fitSize(note, KEY_TEXT_MAX_W - (octave !== null ? 16 : 0), KEY_NOTE_SIZE, 20, SEMIBOLD);
	const at = centered(note, size, KEY_CX, SEMIBOLD);
	let s = clearText(at.x, KEY_NOTE_BASELINE, note, size, fill, SEMIBOLD, opacity);
	if (octave !== null) {
		const oct = String(octave);
		const ink = measureInk(CLEAR_FONT, oct);
		s += clearText(at.right + 2 - ink.left * 18, KEY_NOTE_BASELINE, oct, 18, VALUE_GOLD, undefined, octaveOpacity);
	}
	return s;
}

function keyMessage(text: string, fill: string, maxSize: number, weight?: number): string {
	const size = fitSize(text, KEY_TEXT_MAX_W, maxSize, 11, weight);
	const at = centered(text, size, KEY_CX, weight);
	return clearText(at.x, 98, text, size, fill, weight);
}

/**
 * Tuner-Taste im Tuner-Modus, 144x144. state null = noch keine Messung („Warte…").
 * Außerhalb des Modus bleibt die Taste renderToggleKey("tuner", …).
 */
export function renderTunerKey(state: TunerState | null, status: Status): string {
	const live = status.kind === "ok" && state !== null && state.found && !isSilent(state) ? state : null;
	const cent = live ? clampCent(live.cent) : null;
	const key =
		`${statusKey(status)}|` +
		(state === null
			? "-"
			: `${state.found ? 1 : 0}|` + (live ? `${live.note.trim()}|${live.octave}|${cent}|${live.inTune ? 1 : 0}|${live.held === true ? 1 : 0}` : "s"));
	const hit = keyCache.get(key);
	if (hit) return hit;

	const darkLamp = (): string => jewelLamp(KEY_CX, KEY_LAMP_Y, KEY_LAMP_R, "tuner", false, "kl");
	let body: string;
	let lamp: string;
	if (status.kind === "error") {
		lamp = darkLamp();
		body = keyMessage(status.text.trim() || "Fehler", ERROR_TEXT, 24, SEMIBOLD);
	} else if (status.kind === "waiting" || state === null) {
		lamp = darkLamp();
		body = keyMessage("Warte…", WAIT_TEXT, 22);
	} else if (!state.found) {
		lamp = darkLamp();
		body = keyMessage(MISSING_KEY_TEXT, ERROR_TEXT, 32, SEMIBOLD);
	} else if (live === null) {
		lamp = darkLamp();
		body = keyNote("--", null, CREAM, SILENT_OPACITY) + centBar(null, false);
	} else if (live.held === true) {
		// Gehalten: Lampe aus, Note und Marke gedimmt am letzten Platz.
		lamp = darkLamp();
		body = keyNote(live.note.trim(), live.octave, CREAM, HELD_OPACITY, HELD_OPACITY) + centBar(cent, false, true);
	} else {
		lamp = jewelLamp(KEY_CX, KEY_LAMP_Y, KEY_LAMP_R, live.inTune ? "green" : "tuner", true, "kl");
		body = keyNote(live.note.trim(), live.octave, live.inTune ? IN_TUNE_TEXT : CREAM) + centBar(cent, live.inTune);
	}
	// Heller Rahmen = Modus aktiv; ohne Verbindung der schlichte.
	const foreground = lamp + keyEdge(status.kind === "ok" ? "bright" : "plain", TUNER_KEY_SIZE) + body;
	const url = compose(TUNER_KEY_SIZE, TUNER_KEY_SIZE, KEY_BACKGROUND, foreground);
	keyCache.set(key, url);
	return url;
}

export function clearTunerCache(): void {
	segmentCache.clear();
	keyCache.clear();
}
