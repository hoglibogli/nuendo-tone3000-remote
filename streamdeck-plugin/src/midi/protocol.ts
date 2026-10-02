/**
 * Protokoll 4 zwischen Stream Deck und dem Nuendo-Script Vincent_Tone3000.js:
 * alles aus Protokoll 3, dazu der Tuner-Modus (0x13) und die Stimmanzeige (0x24).
 *
 * Maßgeblich ist docs/protokoll.md im Projektordner; die Abschnittsnummern in den
 * Kommentaren beziehen sich darauf. Dieses Modul kennt nur Bytes: Kodieren,
 * Dekodieren, Umrechnen. Was das Deck mit einem Frame tut, steht in state/store.ts.
 *
 * Bewusst ohne Abhängigkeit vom Stream-Deck-SDK, damit die Tests es direkt laden.
 */

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;
/** Hersteller-ID „non-commercial" (2.1). */
export const MANUFACTURER_ID = 0x7d;

// Typbytes Deck → Nuendo (3, 4.1)
export const MSG_PING = 0x01;
export const MSG_QUERY = 0x10;
export const MSG_SET_PARAM = 0x11;
export const MSG_SELECT_PRESET = 0x12;
/** Tuner-Modus an/aus (Protokoll 4). */
export const MSG_TUNER_MODE = 0x13;

// Typbytes Nuendo → Deck (4.2)
export const MSG_PARAM = 0x20;
export const MSG_PRESET = 0x21;
export const MSG_FLAGS = 0x22;
export const MSG_SLOT = 0x23;
/** Stimmanzeige des Steinberg-Tuners in Slot 1 (Protokoll 4). */
export const MSG_TUNER = 0x24;
export const MSG_DEBUG = 0x7f;

/** Note On auf MIDI-Kanal 3 (4.1, „Tasten auf MIDI-Kanal 3"). */
export const NOTE_ON_CH3 = 0x92;
export const VELOCITY_ON = 0x7f;
export const VELOCITY_OFF = 0x00;

export const NOTE_MUTE = 0;
export const NOTE_TUNER_WINDOW = 1;
export const NOTE_DELAY_BYPASS = 2;
export const NOTE_DELAY_WINDOW = 3;
export const NOTE_AMP_WINDOW = 4;

// Bits im Zustandsbyte 0x22 (4.2)
export const FLAG_MUTE = 0x01;
export const FLAG_TUNER_OPEN = 0x02;
export const FLAG_DELAY_BYPASS = 0x04;
export const FLAG_DELAY_OPEN = 0x08;
export const FLAG_AMP_OPEN = 0x10;
/** bit5: Platz 6 heißt „Mono In 6". */
export const FLAG_CHANNEL_OK = 0x20;
/** bit6: TONE3000 steckt in Slot 3. */
export const FLAG_PLUGIN_FOUND = 0x40;

// Bits im Flag-Byte von 0x24 (Protokoll 4)
/** bit0: Ton erkannt (Parameter „Locked"). */
export const TUNER_LOCKED = 0x01;
/** bit1: gestimmt (Parameter „In Tune"). */
export const TUNER_IN_TUNE = 0x02;
/** bit2: Tuner-Modus an. */
export const TUNER_MODE = 0x04;
/** bit3: Steinberg-Tuner in Slot 1 gefunden. */
export const TUNER_FOUND = 0x08;
/** bit4: Mute des Tuners an (sein Ausgang, nicht der Kanal). */
export const TUNER_MUTE = 0x10;
/** Cent und Oktave stehen in 0x24 als Wert + 64. */
export const TUNER_OFFSET = 64;
export const CENT_MIN = -50;
export const CENT_MAX = 50;
/** Note in 0x24: höchstens 8 Byte UTF-8. */
export const MAX_NOTE_BYTES = 8;

/** 14-Bit-Werte (2.3). */
export const VALUE_MAX = 16383;
/** Mitte: v1 = 0x40, v0 = 0x00. */
export const VALUE_CENTER = 8192;

/** Text zum Script höchstens 100 Byte UTF-8 (2.4). */
export const MAX_TEXT_BYTES = 100;

/** Die vier Regler in der Reihenfolge von p (4.1). */
export const PARAM_NAMES = ["gain", "bass", "mid", "treble"] as const;
export type ParamName = (typeof PARAM_NAMES)[number];
export const PARAM_COUNT = PARAM_NAMES.length;
/** Slots 1–3 als s = 0, 1, 2 (4.2, 0x23). */
export const SLOT_COUNT = 3;

//------------------------------------------------------------------------------
// Text: UTF-8, jedes Byte als zwei ASCII-Hex-Ziffern (2.2)
//------------------------------------------------------------------------------

const HEX = "0123456789ABCDEF";

/** Länge eines Textes in Byte UTF-8. */
export function utf8Length(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Text in Hex-ASCII-Datenbytes (Großbuchstaben, wie das Script). */
export function encodeText(text: string): number[] {
	const out: number[] = [];
	for (const b of Buffer.from(text, "utf8")) {
		out.push(HEX.charCodeAt(b >> 4), HEX.charCodeAt(b & 0x0f));
	}
	return out;
}

function hexDigit(c: number): number {
	if (c >= 0x30 && c <= 0x39) return c - 0x30; // 0–9
	if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10; // A–F
	if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10; // a–f
	return -1;
}

/**
 * Hex-ASCII-Datenbytes zurück in Text. null bei ungerader Länge oder fremden
 * Zeichen — abgelehnt, nicht geraten (2.2). Klein- und Großbuchstaben gelten.
 */
export function decodeText(chars: number[]): string | null {
	if (chars.length % 2 !== 0) return null;
	const raw: number[] = [];
	for (let i = 0; i < chars.length; i += 2) {
		const hi = hexDigit(chars[i]);
		const lo = hexDigit(chars[i + 1]);
		if (hi < 0 || lo < 0) return null;
		raw.push((hi << 4) | lo);
	}
	return Buffer.from(raw).toString("utf8");
}

//------------------------------------------------------------------------------
// 14-Bit-Werte (2.3)
//------------------------------------------------------------------------------

/** Normiert 0..1 → 0..16383, gerundet und begrenzt. 0,5 → 8192 (Mitte). */
export function to14(value01: number): number {
	if (!Number.isFinite(value01)) return 0;
	return Math.min(VALUE_MAX, Math.max(0, Math.round(value01 * VALUE_MAX)));
}

/** 0..16383 → normiert 0..1. */
export function from14(value14: number): number {
	return value14 / VALUE_MAX;
}

/**
 * Klartext, wie der Host ihn zeigt (4.1): Gain normiert mit vier Nachkommastellen,
 * Bass/Mid/Treble 0 … 10 mit zweien. Das Deck bildet ihn selbst, wenn nach einem
 * eigenen 0x11 keine Rückmeldung kommt.
 */
export function hostText(p: number, value14: number): string {
	const n = from14(value14);
	return p === 0 ? n.toFixed(4) : (n * 10).toFixed(2);
}

//------------------------------------------------------------------------------
// Deck → Nuendo
//------------------------------------------------------------------------------

function sysex(type: number, data: number[] = []): number[] {
	return [SYSEX_START, MANUFACTURER_ID, type, ...data, SYSEX_END];
}

/** `F0 7D 01 F7` — Ping; die Antwort ist dasselbe Frame. */
export function buildPing(): number[] {
	return sysex(MSG_PING);
}

/** `F0 7D 10 F7` — Abfrage (4.1). */
export function buildQuery(): number[] {
	return sysex(MSG_QUERY);
}

/** `F0 7D 11 <p> <v1> <v0> F7` — TONE3000-Regler setzen, genau 7 Byte (4.1). */
export function buildSetParam(p: number, value14: number): number[] {
	if (!Number.isInteger(p) || p < 0 || p >= PARAM_COUNT) throw new RangeError(`Regler ${p} unbekannt (0..3)`);
	const v = Math.min(VALUE_MAX, Math.max(0, Math.round(value14)));
	return sysex(MSG_SET_PARAM, [p, v >> 7, v & 0x7f]);
}

/** Passt ein Presetname in ein 0x12 (1 … 100 Byte UTF-8)? */
export function presetNameFits(name: string): boolean {
	const n = utf8Length(name);
	return n > 0 && n <= MAX_TEXT_BYTES;
}

/**
 * `F0 7D 12 <Name> F7` — Preset per Namen (4.1). Wird nie gekürzt: Ein gekürzter
 * Name wählte ein anderes oder gar kein Preset. Zu lange oder leere Namen werfen.
 */
export function buildSelectPreset(name: string): number[] {
	if (!presetNameFits(name)) throw new RangeError(`Presetname mit ${utf8Length(name)} Byte, erlaubt 1..${MAX_TEXT_BYTES}`);
	return sysex(MSG_SELECT_PRESET, encodeText(name));
}

/**
 * `F0 7D 13 <m> F7` — Tuner-Modus, m = 1 an, 0 aus (Protokoll 4). Das Script setzt
 * dann „Mute" des Steinberg-Tuners in Slot 1 und antwortet sofort mit 0x24.
 * Dasselbe m mehrfach ist harmlos.
 */
export function buildTunerMode(on: boolean): number[] {
	return sysex(MSG_TUNER_MODE, [on ? 1 : 0]);
}

/** `92 <n> <vel>` — Taste n auf Kanal 3, Velocity = Zielzustand, kein Note Off (4.1). */
export function buildNote(note: number, on: boolean): number[] {
	return [NOTE_ON_CH3, note & 0x7f, on ? VELOCITY_ON : VELOCITY_OFF];
}

//------------------------------------------------------------------------------
// Nuendo → Deck
//------------------------------------------------------------------------------

export type PongFrame = { type: "pong" };
export type ParamFrame = { type: "param"; p: number; value: number; text: string };
export type PresetFrame = { type: "preset"; name: string };
export type FlagsFrame = { type: "flags"; flags: number };
export type SlotFrame = { type: "slot"; slot: number; name: string };
export type DebugFrame = { type: "debug"; text: string };
/**
 * 0x24 (Protokoll 4): flags nach TUNER_*, cent und oct ohne den Versatz 64 (cent so,
 * wie gesendet; begrenzt wird im Store), note ohne umgebende Leerzeichen ("E", "F#", "--").
 */
export type TunerFrame = { type: "tuner"; flags: number; cent: number; oct: number; note: string };
/** Frames, die den Zustand des Decks ändern. */
export type StateFrame = ParamFrame | PresetFrame | FlagsFrame | SlotFrame | TunerFrame;
export type InFrame = PongFrame | StateFrame | DebugFrame;

/**
 * Ein eingehendes Frame lesen. null für alles, was übergangen wird: Noten, fremde
 * Hersteller-ID, unbekannter Typ (2.1), kaputte Frames (fehlendes F7, Datenbyte
 * ab 0x80, falsche Länge, ungültiger Text) und Frames, die nur Nuendo empfängt.
 */
export function parseFrame(bytes: ArrayLike<number>): InFrame | null {
	const n = bytes.length;
	if (n < 4 || bytes[0] !== SYSEX_START || bytes[1] !== MANUFACTURER_ID || bytes[n - 1] !== SYSEX_END) return null;
	const data: number[] = [];
	for (let i = 3; i < n - 1; i++) {
		const b = bytes[i];
		if (b > 0x7f) return null; // jedes Datenbyte ist 7 Bit (2.1)
		data.push(b);
	}
	switch (bytes[2]) {
		case MSG_PING:
			return data.length === 0 ? { type: "pong" } : null;
		case MSG_PARAM: {
			if (data.length < 3 || data[0] >= PARAM_COUNT) return null;
			const text = decodeText(data.slice(3));
			if (text === null) return null;
			return { type: "param", p: data[0], value: data[1] * 128 + data[2], text };
		}
		case MSG_PRESET: {
			const name = decodeText(data);
			return name === null ? null : { type: "preset", name };
		}
		case MSG_FLAGS:
			return data.length === 1 ? { type: "flags", flags: data[0] } : null;
		case MSG_SLOT: {
			if (data.length < 1 || data[0] >= SLOT_COUNT) return null;
			const name = decodeText(data.slice(1));
			return name === null ? null : { type: "slot", slot: data[0], name };
		}
		case MSG_TUNER: {
			// flags, cent+64, oct+64, dann die Note mit höchstens 8 Byte
			if (data.length < 3 || data.length - 3 > MAX_NOTE_BYTES * 2) return null;
			const note = decodeText(data.slice(3));
			if (note === null) return null;
			return { type: "tuner", flags: data[0], cent: data[1] - TUNER_OFFSET, oct: data[2] - TUNER_OFFSET, note: note.trim() };
		}
		case MSG_DEBUG: {
			const text = decodeText(data);
			return text === null ? null : { type: "debug", text };
		}
		default:
			return null;
	}
}

//------------------------------------------------------------------------------
// Für das Log
//------------------------------------------------------------------------------

const hex2 = (b: number): string => b.toString(16).padStart(2, "0");

/** Bytes als Hex, für den Rohmitschnitt. */
export function hex(bytes: ArrayLike<number>): string {
	return Array.from(bytes, hex2).join(" ");
}

/** Eine lesbare Zeile je Nachricht, in beide Richtungen. */
export function describeMessage(bytes: ArrayLike<number>): string {
	if (bytes[0] === NOTE_ON_CH3 && bytes.length === 3) return `NOTE ch3 n=${bytes[1]} vel=${bytes[2]}`;
	if (bytes[0] !== SYSEX_START || bytes[1] !== MANUFACTURER_ID) return `RAW ${hex(bytes)}`;
	const f = parseFrame(bytes);
	if (f) {
		switch (f.type) {
			case "pong":
				return "PING";
			case "param":
				return `PARAM p${f.p} ${f.value} "${f.text}"`;
			case "preset":
				return `PRESET "${f.name}"`;
			case "flags":
				return `FLAGS 0x${hex2(f.flags)}`;
			case "slot":
				return `SLOT s${f.slot} "${f.name}"`;
			case "tuner":
				return `TUNER 0x${hex2(f.flags)} "${f.note}" oct ${f.oct} cent ${f.cent}`;
			case "debug":
				return `DEBUG ${f.text}`;
		}
	}
	switch (bytes[2]) {
		case MSG_QUERY:
			return "QUERY";
		case MSG_SET_PARAM:
			return `SET p${bytes[3]} ${bytes[4] * 128 + bytes[5]}`;
		case MSG_SELECT_PRESET:
			return `SELECT "${decodeText(Array.from(bytes).slice(3, bytes.length - 1)) ?? "?"}"`;
		case MSG_TUNER_MODE:
			return bytes.length === 5 && bytes[3] <= 1 ? `TUNER-MODUS ${bytes[3] === 1 ? "an" : "aus"}` : `SYSEX ${hex(bytes)}`;
		default:
			return `SYSEX ${hex(bytes)}`;
	}
}
