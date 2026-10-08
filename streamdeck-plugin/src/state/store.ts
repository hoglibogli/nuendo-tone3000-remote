import {
	buildChain,
	buildNote,
	buildSelectPreset,
	buildSetParam,
	buildTunerMode,
	CENT_MAX,
	CENT_MIN,
	CHAIN_LOADED,
	ChainFrame,
	FLAG_AMP_OPEN,
	FLAG_CHANNEL_OK,
	FLAG_DELAY_BYPASS,
	FLAG_MUTE,
	FLAG_PLUGIN_FOUND,
	from14,
	hostText,
	NOTE_AMP_WINDOW,
	NOTE_DELAY_BYPASS,
	NOTE_DELAY_WINDOW,
	NOTE_MUTE,
	NOTE_TUNER_WINDOW,
	PARAM_COUNT,
	PARAM_NAMES,
	ParamName,
	presetNameFits,
	SLOT_COUNT,
	StateFrame,
	to14,
	TUNER_FOUND,
	TUNER_IN_TUNE,
	TUNER_LOCKED,
	TUNER_MODE,
	TUNER_MUTE,
	TunerFrame,
} from "../midi/protocol";
import type { OwnTunerState } from "../tuner/wire";

/**
 * Was das Deck über Nuendo weiß, und die Regeln, nach denen es das ändert.
 *
 * Grundlage ist protokoll.md, vor allem 4.2 (was ein Frame bedeutet) und 4.4 (was
 * das Deck daraufhin tut). Jedes Frame ist für sich gültig und wird einfach
 * übernommen — mit zwei Ausnahmen, die hier entschieden werden:
 *
 *   Echo-Regel   Ein 0x20 für einen Regler, für den das Deck in den letzten 300 ms
 *                selbst ein 0x11 gesendet hat, zählt nur, wenn der Wert gleich dem
 *                eigenen ist, und dann nur sein Klartext. Sonst ist es ein
 *                verspätetes Echo eines Zwischenwerts und wird verworfen.
 *   bit6 fällt   Reglerwerte und Preset gelten als unbekannt. Das Script sendet sie
 *                neu, sobald es TONE3000 wiederfindet.
 *
 * Nach einem Verbindungsverlust gilt das letzte 0x22 nicht mehr: Nuendo kann neu
 * gestartet sein oder ein anderes Projekt geladen haben, und das Script beantwortet
 * Pings schon vor der Aktivierung seiner Seite. Bis zum nächsten 0x22 bleibt deshalb
 * alles auf „Warte…" und gesperrt; Reglerwerte und Preset bleiben zur Anzeige stehen.
 *
 * Tuner-Modus (Protokoll 4): tunerMode ist der Modus, den das Deck zeigt und bei
 * jedem Verbindungsaufbau als 0x13 schickt — beim Start aus, gesetzt durch die
 * Tuner-Taste und durch jedes 0x24 nach dem Pong (bit2; Nuendo hat das letzte Wort,
 * aber erst mit der Verbindung, siehe applyTuner). Solange er an ist, zeigt die
 * Leiste die Stimmanzeige, und die Regler ruhen.
 *
 * Außerhalb des Modus gehört keine Tuner-Mute an. Meldet ein 0x24 trotzdem eine
 * (bit2 = 0, bit3 = 1, bit4 = 1: im Projekt gespeichert, Script neu geladen, anderes
 * Projekt), verlangt applyTuner einmal ein 0x13 00 — nur beim Eintreten dieses
 * Zustands, nicht je Frame, sonst entstünde eine Schleife, falls das Aufheben nicht
 * wirkt. Solange er anhält, zeigt die Tuner-Taste „stumm" (protokoll.md 5.5).
 *
 * Quelle der Stimmanzeige (Setting der Tuner-Taste, tunerSource):
 *
 *   own        Eigener Tuner (Vorgabe): Der Modus gehört allein dem Deck; das Plugin
 *              misst selbst (Audio-Kindprozess, tuner/source.ts), die Session reicht die
 *              Messungen herein (own, ownStatus) — auch außerhalb des Modus, die Taste
 *              zeigt sie immer; der Modus schaltet nur die große Anzeige in der Leiste
 *              und die Kanal-Mute. Ans Script geht kein 0x13 01; sein
 *              Tuner-Modus soll aus sein — beim Verbinden 0x13 00 wie bisher, und meldet
 *              ein 0x24 doch Modus oder Tuner-Mute, einmal 0x13 00 (Flanke).
 *              Kanal-Mute „wie vorher" (muteChannel, Vorgabe an): beim Einschalten Note 0
 *              mit Velocity 127 auf Kanal 3, aber nur, wenn Input 6 nicht schon stumm ist
 *              (bit0); beim Ausschalten IMMER Note 0 mit Velocity 0 — gleich, wer gemutet
 *              hat (Wunsch des Users 2026-10-02: Wurde das Projekt mit laufendem Tuner
 *              gespeichert, war Input 6 beim nächsten Öffnen stumm, und die alte Regel
 *              „nur eigene Mute aufheben" ließ ihn beim Ausschalten stumm). Der Merker
 *              channelMuted bleibt für den Neustart des Plugins. Gesendet wird nur mit Verbindung und
 *              bit5 (die Note wirkt ohne Titelprüfung auf den Deck-Kanal); sonst wird es mit dem
 *              nächsten 0x22 nachgeholt. Der Merker überlebt einen Neustart des Plugins
 *              (globale Einstellungen, restoreChannelMute): Steht er nach dem Start und ist
 *              Input 6 noch stumm, hebt das erste 0x22 die Mute einmal auf.
 *   steinberg  Steinbergs Tuner in Slot 1 wie bisher (Protokoll 4): 0x13 schaltet seinen
 *              Modus und seine Mute, die Messwerte kommen als 0x24, Nuendo hat das letzte
 *              Wort über den Modus. Die Kanal-Mute fasst diese Quelle nicht an.
 *
 * Bedienung gibt die zu sendenden Bytes zurück (oder null, wenn sie gesperrt ist);
 * gesendet wird in state/session.ts. Kein Timer, kein MIDI, kein SDK: Die Zeit
 * kommt als Argument, damit die Regeln prüfbar bleiben.
 */

/** Zustand für die Grafik; strukturgleich mit Status in render/index.ts. */
export type Status = { kind: "ok" } | { kind: "waiting" } | { kind: "error"; text: string };
export type ToggleKind = "amp" | "tuner" | "delay";
/** Woher die Stimmanzeige kommt (Setting „source" der Tuner-Taste). */
export type TunerSourceKind = "own" | "steinberg";

/** Was die Tuner-Taste für den Store einstellt. */
export interface TunerConfig {
	source: TunerSourceKind;
	/** Eigener Tuner: Input 6 beim Stimmen stummschalten (Vorgabe an). */
	muteChannel: boolean;
}

/** Echo-Regel (4.4). */
export const ECHO_WINDOW_MS = 300;
/** Leerlauf: so lange kein 0x11 und kein Druck auf eine Preset-Taste (4.4). */
export const IDLE_AFTER_MS = 2000;
/**
 * Ein Rastschritt des Drehreglers, normiert: 0,02 = 0,2 auf der Skala 0–10, der
 * ganze Weg in 50 Rasten. Mit 0,01 waren es 100 — am Gerät zu zäh (2026-10-02).
 */
export const STEP_PER_TICK = 0.02;
/**
 * Schnelles Drehen: Meldet das Stream Deck in einem Ereignis mindestens so viele
 * Rasten, zählt jede FAST_FACTOR-fach. Langsames Drehen bleibt beim feinen Schritt.
 */
export const FAST_TICKS = 2;
export const FAST_FACTOR = 2;

/** Wertänderung für ein Dreh-Ereignis mit `ticks` Rasten (Vorzeichen = Richtung). */
export function turnDelta(ticks: number): number {
	const factor = Math.abs(ticks) >= FAST_TICKS ? FAST_FACTOR : 1;
	return ticks * STEP_PER_TICK * factor;
}
/** Druck auf den Regler setzt die Mitte; to14(0,5) = 8192 (2.3). */
export const CENTER_01 = 0.5;

const OK: Status = Object.freeze({ kind: "ok" });
const WAITING: Status = Object.freeze({ kind: "waiting" });
const NO_CHANNEL: Status = Object.freeze({ kind: "error", text: "Kanal?" });
const NO_PLUGIN: Status = Object.freeze({ kind: "error", text: "Plugin?" });
/** Tuner-Taste außerhalb des Modus: Das letzte 0x24 fand keinen Steinberg-Tuner in Slot 1. */
const NO_TUNER: Status = Object.freeze({ kind: "error", text: "Tuner?" });
/** Tuner-Taste außerhalb des Modus: Die Mute des Tuners steht trotzdem an (tunerMuteHangs). */
const TUNER_MUTED: Status = Object.freeze({ kind: "error", text: "stumm" });

/** Was das Deck vom Steinberg-Tuner weiß: das letzte 0x24, ausgepackt. */
export interface TunerReading {
	/** Klartext von „Note" ohne Leerzeichen: "E", "F#", bei Stille "--". */
	note: string;
	/** Aus „Oct"; leer meldet das Script als 0. */
	octave: number;
	/** -50 … 50, ganzzahlig. */
	cent: number;
	/** bit0: Ton erkannt. */
	locked: boolean;
	/** bit1: gestimmt. */
	inTune: boolean;
	/** bit2: Tuner-Modus in Nuendo an. */
	mode: boolean;
	/** bit3: Steinberg-Tuner in Slot 1 gefunden. */
	found: boolean;
	/** bit4: Mute des Tuners an. */
	muted: boolean;
}

function readingOf(f: TunerFrame): TunerReading {
	return {
		note: f.note,
		octave: f.oct,
		cent: Math.min(CENT_MAX, Math.max(CENT_MIN, Math.round(f.cent))),
		locked: (f.flags & TUNER_LOCKED) !== 0,
		inTune: (f.flags & TUNER_IN_TUNE) !== 0,
		mode: (f.flags & TUNER_MODE) !== 0,
		found: (f.flags & TUNER_FOUND) !== 0,
		muted: (f.flags & TUNER_MUTE) !== 0,
	};
}

function sameReading(a: TunerReading, b: TunerReading): boolean {
	return (
		a.note === b.note &&
		a.octave === b.octave &&
		a.cent === b.cent &&
		a.locked === b.locked &&
		a.inTune === b.inTune &&
		a.mode === b.mode &&
		a.found === b.found &&
		a.muted === b.muted
	);
}

export interface KnobState {
	/** Wert 0..1, wie das Deck ihn zeigt; null = unbekannt. */
	value01: number | null;
	/** Klartext des Hosts oder die eigene Umrechnung (4.1); fürs Log. */
	text: string | null;
	/** Zuletzt selbst gesendeter 14-Bit-Wert und wann (Echo-Regel). */
	sent14: number | null;
	sentAt: number;
}

export interface ApplyResult {
	/** Hat sich etwas geändert, das die Anzeige betrifft? */
	changed: boolean;
	/** Sofort abfragen: bit5 oder bit6 oder der Slot-3-Name hat sich geändert (4.4). */
	queryNow: boolean;
	/**
	 * Einmal 0x13 00 senden: Eine Tuner-Mute steht außerhalb des Modus an, und das
	 * gerade erst (Store.tunerMuteHangs, Flanke). Fehlt = nein.
	 */
	releaseTuner?: boolean;
	/** Noten der Kanal-Mute, nachgeholt mit diesem 0x22 (eigener Tuner). Fehlt = keine. */
	send?: number[][];
	/** 0x25: Ergebnis der Kette (Protokoll 5), für Log und Tuner-Taste. Fehlt = kein 0x25. */
	chain?: ChainFrame;
	/** 0x12 mit dem zuletzt aktiven Preset nach einem frisch geladenen TONE3000. Fehlt = keins. */
	selectPreset?: number[];
}

/**
 * Kette (Protokoll 5): So lange nach dem 0x14 gilt ein 0x21 nicht als „zuletzt aktives
 * Preset" — ein frisch geladenes TONE3000 meldet sein Programm 0. Kommt kein 0x25 (ein
 * Script ohne Protokoll 5), endet die Sperre so.
 */
export const CHAIN_AWAIT_MS = 15000;
/** Nach einem 0x25 mit frisch geladenem TONE3000 noch so lange (späte Callbacks). */
export const PRESET_GUARD_MS = 3000;

const NOTHING: ApplyResult = Object.freeze({ changed: false, queryNow: false });

function unknownKnob(): KnobState {
	return { value01: null, text: null, sent14: null, sentAt: -Infinity };
}

/**
 * Welcher Regler (p) zu einem Drehregler gehört: das Setting „param", sonst die
 * Position — 0 Gain bis 3 Treble, darüber Gain. Die Aktion übergibt als Position den
 * Rang des Reglers unter allen Tone3000-Reglern (von links gezählt), nicht die
 * Gerätespalte: Die Regler müssen nicht in Spalte 0 beginnen.
 */
export function paramIndexFor(param: unknown, column: number | undefined): number {
	const named = PARAM_NAMES.indexOf(param as ParamName);
	if (named >= 0) return named;
	if (column !== undefined && Number.isInteger(column) && column >= 0 && column < PARAM_COUNT) return column;
	return 0;
}

/** Segmente der Stimmanzeige: die vier linken Regler, 0 Gain … 3 Treble. */
export const TUNER_SEGMENTS = 4;

/**
 * Welches Segment der Stimmanzeige ein Drehregler im Tuner-Modus zeigt: das seines
 * Parameters p — Gain links, Treble rechts —, genau wie die Goldkante im
 * Reglerbetrieb. Nicht die Gerätespalte: Am Gerät liegen die vier Regler auf den
 * Spalten 1–4 (links und rechts davon Micstacy); nach Spalte erschien Segment 0 nie
 * und Segment 3 doppelt (Foto 2026-10-02).
 */
export function tunerSegmentFor(p: number): number {
	return Math.min(TUNER_SEGMENTS - 1, Math.max(0, p));
}

/** Auf 0..1 begrenzen und Gleitkommareste wegrunden (0,1 + 0,2 ≠ 0,3). */
function clamp01(v: number): number {
	return Math.min(1, Math.max(0, Math.round(v * 1e6) / 1e6));
}

export class Store {
	/** Steht die Verbindung (Pong)? Setzt die Session. */
	connected = false;
	/** Letztes Zustandsbyte 0x22; null = noch keins. */
	flags: number | null = null;
	/** Aktives Preset aus 0x21; null = unbekannt (leeres 0x21, bit6 = 0). */
	preset: string | null = null;
	/**
	 * Zuletzt aktives Preset (Kette): Die Session hält es in den globalen Einstellungen
	 * fest; nach dem Laden eines frischen TONE3000 wird es zurückgeholt. null = nie bekannt.
	 */
	lastPreset: string | null = null;
	/** Das mit dem letzten 0x14 zurückzuholende Preset (Stand beim Senden). */
	private chainRestore: string | null = null;
	/** 0x14 gesendet, 0x25 steht aus: Nur das erste 0x25 danach holt das Preset zurück. */
	private chainPending = false;
	/** Bis hierhin zählt ein 0x21 nicht als „zuletzt aktiv" (Kette). */
	private presetGuardUntil = -Infinity;
	/** Plugin-Namen der Slots 1–3 aus 0x23; "" = leerer Slot, null = unbekannt. */
	readonly slots: (string | null)[] = Array.from({ length: SLOT_COUNT }, () => null);
	readonly knobs: KnobState[] = Array.from({ length: PARAM_COUNT }, unknownKnob);
	/** Letztes 0x11 oder letzter Druck auf eine Preset-Taste (Leerlauf, 4.4). */
	lastUserActionAt = -Infinity;
	/**
	 * Tuner-Modus, wie das Deck ihn zeigt und bei jedem Verbindungsaufbau schickt.
	 * Beim Plugin-Start aus: Das erste 0x13 0 hebt einen liegengebliebenen Tuner-Mute auf.
	 */
	tunerMode = false;
	/** Letztes 0x24; null = noch keins seit dem letzten Verbindungsaufbau (vor dem Pong übergangen). */
	tuner: TunerReading | null = null;
	/** Quelle der Stimmanzeige; Vorgabe der eigene Tuner. */
	tunerSource: TunerSourceKind = "own";
	/** Eigener Tuner: Input 6 beim Stimmen stummschalten. */
	muteChannel = true;
	/**
	 * Merker: Die Tuner-Taste hat Input 6 stummgeschaltet und muss es wieder aufheben.
	 * Die Session hält ihn in den globalen Einstellungen fest (überlebt einen Neustart).
	 */
	channelMuted = false;
	/** Eigener Tuner: letzte Messung; null = noch keine seit dem Einschalten („Warte…"). */
	own: OwnTunerState | null = null;
	/** Eigener Tuner: Zustand des Audio-Kindprozesses für Leiste und Taste. */
	ownStatus: Status = WAITING;
	ownKeyStatus: Status = WAITING;
	/** Kanal-Mute steht aus (eingeschaltet ohne Verbindung oder ohne bekanntes 0x22). */
	private pendingMute = false;
	/** Tuner ausgeschaltet: Input 6 entmuten steht aus (immer, gleich wer gemutet hat). */
	private pendingUnmute = false;
	/** In dieser Verbindung selbst Note 0 an gesendet (ein 0x22 bestätigt das womöglich noch nicht). */
	private muteSentLive = false;

	/**
	 * true, wenn sich der Verbindungsstand geändert hat. Beim Verlust werden das letzte
	 * 0x22 und das letzte 0x24 verworfen: Bis frische kommen, ist alles „Warte…" und
	 * gesperrt. Der Tuner-Modus bleibt; er geht beim Wiederverbinden als 0x13 hinaus.
	 */
	setConnected(on: boolean): boolean {
		if (this.connected === on) return false;
		this.connected = on;
		if (!on) {
			this.flags = null;
			this.tuner = null;
			this.muteSentLive = false;
		}
		return true;
	}

	/** Welchen Tuner-Modus das Script haben soll: nur mit der Steinberg-Quelle je an. */
	scriptTunerMode(): boolean {
		return this.tunerMode && this.tunerSource === "steinberg";
	}

	/**
	 * Setting der Tuner-Taste übernehmen. Wechselt die Quelle im Modus, endet der Modus
	 * mit der alten Quelle (0x13 00 bzw. Kanal-Mute aufheben); einschalten ist dann ein
	 * neuer Druck. Gibt die zu sendenden Bytes zurück.
	 */
	configureTuner(config: TunerConfig): number[][] {
		const out: number[][] = [];
		if (config.source !== this.tunerSource && this.tunerMode) {
			if (this.tunerSource === "steinberg") out.push(buildTunerMode(false));
			// Der eigene Tuner endet: wie beim Ausschalten immer entmuten.
			if (this.tunerSource === "own" && this.muteChannel) this.pendingUnmute = true;
			this.tunerMode = false;
		}
		// Haken im Modus gesetzt: jetzt stummschalten (sofern Input 6 nicht schon stumm ist).
		if (config.muteChannel && !this.muteChannel && this.tunerMode && config.source === "own") this.pendingMute = true;
		this.tunerSource = config.source;
		this.muteChannel = config.muteChannel;
		out.push(...this.channelMuteStep());
		return out;
	}

	/**
	 * Merker aus den globalen Einstellungen (Plugin-Start). Gilt nur, wenn die Taste in
	 * diesem Lauf noch nichts gemutet hat; aufgehoben wird mit dem nächsten 0x22.
	 */
	restoreChannelMute(on: boolean): number[][] {
		if (!on || this.channelMuted) return [];
		this.channelMuted = true;
		return this.channelMuteStep();
	}

	/**
	 * Kanal-Mute nachführen (eigener Tuner): stummschalten, solange der Modus es will und
	 * es aussteht; aufheben, wenn der Merker steht und der Modus es nicht mehr will.
	 * Nur mit Verbindung und bit5, sonst beim nächsten Aufruf (0x22).
	 */
	private channelMuteStep(): number[][] {
		const wanted = this.tunerMode && this.tunerSource === "own" && this.muteChannel;
		const canSend = this.baseStatus().kind === "ok";
		const muted = this.flags !== null && (this.flags & FLAG_MUTE) !== 0;
		if (wanted) {
			if (!this.pendingMute || !canSend) return [];
			this.pendingMute = false;
			if (muted || this.channelMuted) return []; // schon stumm: nicht anfassen
			this.channelMuted = true;
			this.muteSentLive = true;
			return [buildNote(NOTE_MUTE, true)];
		}
		this.pendingMute = false;
		// Tuner ausgeschaltet: immer entmuten, auch wenn Input 6 schon vorher stumm war
		// oder 0x22 gerade nicht stumm meldet (Note 0 mit Velocity 0 ist dann harmlos).
		if (this.pendingUnmute) {
			if (!canSend) return []; // mit dem nächsten 0x22 nachholen
			this.pendingUnmute = false;
			this.channelMuted = false;
			this.muteSentLive = false;
			return [buildNote(NOTE_MUTE, false)];
		}
		if (!this.channelMuted || !canSend) return [];
		// Selbst gerade gemutet (0x22 womöglich noch alt) oder laut 0x22 stumm: aufheben.
		const send = this.muteSentLive || muted;
		this.channelMuted = false;
		this.muteSentLive = false;
		return send ? [buildNote(NOTE_MUTE, false)] : [];
	}

	/** Eigener Tuner frisch gestartet: keine Messung, „Warte…"; true bei Änderung. */
	resetOwn(): boolean {
		if (this.own === null && this.ownStatus === WAITING && this.ownKeyStatus === WAITING) return false;
		this.own = null;
		this.ownStatus = WAITING;
		this.ownKeyStatus = WAITING;
		return true;
	}

	/** Eigener Tuner: neue Messung; true, wenn sich die Anzeige ändert. */
	setOwnReading(state: OwnTunerState): boolean {
		const o = this.own;
		if (o !== null && o.note === state.note && o.octave === state.octave && o.cent === state.cent && o.locked === state.locked && o.inTune === state.inTune && o.held === state.held) {
			return false;
		}
		this.own = state;
		return true;
	}

	/** Eigener Tuner: Zustand des Kindprozesses (Leiste und Taste); true bei Änderung. */
	setOwnStatus(strip: Status, key: Status): boolean {
		const same = (a: Status, b: Status): boolean => a.kind === b.kind && (a.kind !== "error" || (b.kind === "error" && a.text === b.text));
		if (same(this.ownStatus, strip) && same(this.ownKeyStatus, key)) return false;
		this.ownStatus = strip;
		this.ownKeyStatus = key;
		return true;
	}

	/** Ein Frame von Nuendo übernehmen. */
	apply(frame: StateFrame, now: number): ApplyResult {
		switch (frame.type) {
			case "param":
				return this.applyParam(frame.p, frame.value, frame.text, now);
			case "preset": {
				const name = frame.name === "" ? null : frame.name;
				// Zuletzt aktives Preset merken (Kette); nicht, was ein frisch geladenes
				// TONE3000 von sich aus meldet — außer es ist das zurückgeholte.
				if (name !== null && (now >= this.presetGuardUntil || name === this.chainRestore)) this.lastPreset = name;
				if (name === this.preset) return NOTHING;
				this.preset = name;
				return { changed: true, queryNow: false };
			}
			case "chain":
				return this.applyChain(frame, now);
			case "flags":
				return this.applyFlags(frame.flags);
			case "slot": {
				const prev = this.slots[frame.slot];
				if (prev === frame.name) return NOTHING;
				this.slots[frame.slot] = frame.name;
				// Nur ein Wechsel zählt, nicht das erste Bekanntwerden: Das kommt mit
				// der Antwort auf eine Abfrage, und eine zweite brächte nichts Neues.
				return { changed: true, queryNow: frame.slot === 2 && prev !== null };
			}
			case "tuner":
				return this.applyTuner(readingOf(frame));
		}
	}

	/**
	 * 0x25: Ergebnis der Kette. Wurde TONE3000 frisch geladen, das zuletzt aktive Preset
	 * zurückholen (0x12) und die Sperre für „zuletzt aktiv" noch kurz halten; sonst endet
	 * sie hier. Danach abfragen: Slotnamen, bit6 und das Delay haben sich womöglich geändert.
	 */
	private applyChain(frame: ChainFrame, now: number): ApplyResult {
		const restore = this.chainPending ? this.chainRestore : null;
		this.chainPending = false;
		const amp = frame.amp === CHAIN_LOADED;
		this.presetGuardUntil = amp ? now + PRESET_GUARD_MS : now;
		const selectPreset = amp && restore !== null && presetNameFits(restore) ? buildSelectPreset(restore) : undefined;
		if (!amp) this.chainRestore = null;
		return { changed: false, queryNow: true, selectPreset, chain: frame };
	}

	/**
	 * 0x24: Messwerte übernehmen; bit2 setzt den Modus (Nuendo hat das letzte Wort).
	 *
	 * Aber erst mit der Verbindung (Pong): Hing der Modus in Nuendo, weil das Deck
	 * verschwand, sendet das Script weiter 0x24 mit bit2 = 1. Ein frisch gestartetes
	 * Plugin übernähme daraus den Modus und schickte beim Pong 0x13 01 statt 0x13 00 —
	 * die Gitarre bliebe stumm (protokoll.md 5.5). Ebenso nach einem Verbindungsverlust,
	 * in dem die Taste den Modus ausgeschaltet hat. Bis zum Pong gilt der eigene Modus.
	 */
	private applyTuner(reading: TunerReading): ApplyResult {
		if (!this.connected) return NOTHING;
		const same = this.tuner !== null && sameReading(this.tuner, reading);
		const hung = this.tunerMuteHangs();
		this.tuner = reading;
		if (this.tunerSource === "own") {
			// Eigener Tuner: Das 0x24 sagt nur, ob das Script (noch) im Modus ist oder
			// Steinbergs Tuner stumm hält — beides soll aus sein. Der Modus des Decks bleibt.
			if (same) return NOTHING;
			return { changed: true, queryNow: false, releaseTuner: !hung && this.tunerMuteHangs() };
		}
		const modeChanged = this.tunerMode !== reading.mode;
		this.tunerMode = reading.mode;
		if (same && !modeChanged) return NOTHING;
		// Nur die Flanke: Ein neues 0x13 00 erst, nachdem der Zustand einmal vorbei war
		// (aufgehoben, Modus an, Verbindung weg).
		return { changed: true, queryNow: false, releaseTuner: !hung && this.tunerMuteHangs() };
	}

	/**
	 * Steht die Mute des Tuners an, obwohl der Modus aus ist — auf dem Deck und laut
	 * Nuendo (bit2 = 0, bit3 = 1, bit4 = 1)? Dann bliebe die Gitarre stumm, ohne dass
	 * jemand stimmt: Projekt mit gespeicherter Mute geöffnet, Script im Modus neu
	 * geladen, Aufheben gescheitert, anderes Projekt mit noch stummem Tuner.
	 */
	tunerMuteHangs(): boolean {
		const t = this.tuner;
		if (!this.connected || t === null) return false;
		// Eigener Tuner: Steinbergs Modus und Mute gehören aus, gleich was das Deck zeigt.
		if (this.tunerSource === "own") return t.mode || (t.found && t.muted);
		return !this.tunerMode && t.found && !t.mode && t.muted;
	}

	private applyParam(p: number, value: number, text: string, now: number): ApplyResult {
		const k = this.knobs[p];
		if (now - k.sentAt < ECHO_WINDOW_MS) {
			// Das Deck dreht p gerade selbst (Echo-Regel, 4.4).
			if (value !== k.sent14 || text === k.text) return NOTHING;
			k.text = text;
			return { changed: true, queryNow: false };
		}
		const value01 = from14(value);
		if (value01 === k.value01 && text === k.text) return NOTHING;
		k.value01 = value01;
		k.text = text;
		return { changed: true, queryNow: false };
	}

	private applyFlags(flags: number): ApplyResult {
		const prev = this.flags;
		this.flags = flags;
		let changed = prev !== flags;
		if ((flags & FLAG_PLUGIN_FOUND) === 0 && this.forgetPlugin()) changed = true;
		const watched = FLAG_CHANNEL_OK | FLAG_PLUGIN_FOUND;
		const queryNow = prev !== null && ((prev ^ flags) & watched) !== 0;
		const send = this.connected ? this.channelMuteStep() : [];
		if (send.length > 0) return { changed, queryNow, send };
		return changed || queryNow ? { changed, queryNow } : NOTHING;
	}

	/** bit6 = 0: Regler und Preset sind unbekannt (4.2). true, wenn etwas bekannt war. */
	private forgetPlugin(): boolean {
		let had = this.preset !== null;
		this.preset = null;
		for (let p = 0; p < PARAM_COUNT; p++) {
			if (this.knobs[p].value01 !== null) had = true;
			this.knobs[p] = unknownKnob();
		}
		return had;
	}

	//--------------------------------------------------------------------------
	// Zustand für die Anzeige
	//--------------------------------------------------------------------------

	/** Verbindung und Zielkanal (bit5); gilt für Tuner und Delay. */
	baseStatus(): Status {
		if (!this.connected || this.flags === null) return WAITING;
		if ((this.flags & FLAG_CHANNEL_OK) === 0) return NO_CHANNEL;
		return OK;
	}

	/** Dazu TONE3000 in Slot 3 (bit6); gilt für Regler, Presets und die Amp-Taste. */
	pluginStatus(): Status {
		const base = this.baseStatus();
		if (base.kind !== "ok") return base;
		if (((this.flags as number) & FLAG_PLUGIN_FOUND) === 0) return NO_PLUGIN;
		return OK;
	}

	/** Ein Regler, dessen Wert noch nicht gemeldet ist, wartet. */
	knobStatus(p: number): Status {
		const s = this.pluginStatus();
		if (s.kind === "ok" && this.knobs[p].value01 === null) return WAITING;
		return s;
	}

	presetStatus(): Status {
		return this.pluginStatus();
	}

	/** Was eine Umschalt-Taste anzeigt; amp und delay sperren damit auch den Druck. */
	toggleStatus(kind: ToggleKind): Status {
		if (kind === "amp") return this.pluginStatus();
		if (kind === "tuner") return this.tunerKeyStatus();
		return this.baseStatus();
	}

	/**
	 * Tuner-Taste: Verbindung und bit5, dazu „Tuner?", wenn das letzte 0x24 keinen
	 * Steinberg-Tuner in Slot 1 fand, und „stumm", wenn seine Mute außerhalb des Modus
	 * anliegt (tunerMuteHangs). Beides sperrt nichts — das Script sucht bei jedem 0x13
	 * neu, und zweimal Drücken (an, aus) hebt die Mute auf.
	 */
	tunerKeyStatus(): Status {
		// Eigener Tuner: misst ohne Nuendo; die Taste meldet außerhalb des Modus nichts.
		if (this.tunerSource === "own") return OK;
		const base = this.baseStatus();
		if (base.kind !== "ok") return base;
		if (this.tuner !== null && !this.tuner.found) return NO_TUNER;
		return this.tunerMuteHangs() ? TUNER_MUTED : OK;
	}

	/**
	 * Stimmanzeige: Verbindung und bit5, und ein 0x24 muss da sein. Ob der Tuner in
	 * Slot 1 fehlt, steht in der Messung selbst (found), nicht hier.
	 */
	tunerStatus(): Status {
		if (this.tunerSource === "own") return this.ownStatus;
		const base = this.baseStatus();
		if (base.kind !== "ok") return base;
		return this.tuner === null ? WAITING : OK;
	}

	/** Was die Tuner-Taste im Modus zeigt: beim eigenen Tuner die kurze Meldung. */
	tunerKeyViewStatus(): Status {
		return this.tunerSource === "own" ? this.ownKeyStatus : this.tunerStatus();
	}

	/** Messung für die Stimmanzeige der gewählten Quelle; null = noch keine. */
	tunerReading(): TunerReading | OwnTunerState | null {
		return this.tunerSource === "own" ? this.own : this.tuner;
	}

	/** Wert für die Anzeige; unbekannt zeigt die Mitte (abgedunkelt, „Warte…"). */
	knobValue(p: number): number {
		return this.knobs[p].value01 ?? CENTER_01;
	}

	/** Rahmen auf der Preset-Taste: erst mit 0x21, nie vorab (4.4). */
	isPresetActive(name: string): boolean {
		return name !== "" && this.preset === name;
	}

	/** amp: Fenster offen (bit4 von 0x22); tuner: Tuner-Modus (bit2 von 0x24); delay: nicht im Bypass (bit2 von 0x22). */
	isToggleOn(kind: ToggleKind): boolean {
		if (kind === "tuner") return this.tunerMode;
		if (this.flags === null) return false;
		switch (kind) {
			case "amp":
				return (this.flags & FLAG_AMP_OPEN) !== 0;
			case "delay":
				return (this.flags & FLAG_DELAY_BYPASS) === 0;
		}
	}

	//--------------------------------------------------------------------------
	// Bedienung: liefert die Bytes, oder null, wenn gesperrt oder wirkungslos
	//--------------------------------------------------------------------------

	/**
	 * Drehen: Wert += turnDelta(Ticks), begrenzt auf 0..1. Gesperrt ohne bekannten Wert
	 * (worauf sollte der Schritt aufsetzen?), ohne bit5/bit6 und im Tuner-Modus (die
	 * Leiste zeigt dann keine Regler). Am Anschlag geht nichts hinaus — Dedup vor dem Senden.
	 */
	turn(p: number, ticks: number, now: number): number[] | null {
		if (this.tunerMode || this.knobStatus(p).kind !== "ok" || !Number.isFinite(ticks) || ticks === 0) return null;
		const current = this.knobs[p].value01 as number;
		const next = clamp01(current + turnDelta(ticks));
		if (next === current) return null;
		return this.setOwn(p, next, now);
	}

	/**
	 * Drücken = Mitte (8192). Gesperrt wie das Drehen, solange der Wert unbekannt
	 * ist: Kommt für p nie ein 0x20, fehlt meist der Parametertitel in TONE3000
	 * (4.1), und das Script lehnt jedes 0x11 ab. Ein Druck zeigte sonst „5,0" als
	 * gültig, obwohl in TONE3000 nichts passiert. Im Tuner-Modus gesperrt wie das Drehen.
	 */
	center(p: number, now: number): number[] | null {
		if (this.tunerMode || this.knobStatus(p).kind !== "ok") return null;
		return this.setOwn(p, CENTER_01, now);
	}

	private setOwn(p: number, value01: number, now: number): number[] {
		const k = this.knobs[p];
		const value14 = to14(value01);
		k.value01 = value01;
		k.sent14 = value14;
		k.sentAt = now;
		// Eine Rückmeldung kommt womöglich nie; das Deck bildet den Klartext selbst (4.1).
		k.text = hostText(p, value14);
		this.lastUserActionAt = now;
		return buildSetParam(p, value14);
	}

	/** Preset-Taste: 0x12. Das aktive Preset ändert sich erst mit dem 0x21. */
	selectPreset(name: string, now: number): number[] | null {
		if (this.presetStatus().kind !== "ok" || !presetNameFits(name)) return null;
		this.lastUserActionAt = now;
		return buildSelectPreset(name);
	}

	/**
	 * Umschalt-Tasten: Zielzustand aus dem letzten 0x22 (4.4), keine eigene Annahme.
	 *
	 *   amp    Note 4 = Fenster von TONE3000 auf/zu
	 *   tuner  pressTuner ohne Fenster
	 *   delay  im Bypass: Bypass aus, Fenster auf; sonst Bypass an, Fenster zu (Noten 2, 3)
	 */
	toggle(kind: ToggleKind): number[][] | null {
		if (kind === "tuner") return this.pressTuner(false);
		if (this.toggleStatus(kind).kind !== "ok") return null;
		const flags = this.flags as number;
		switch (kind) {
			case "amp":
				return [buildNote(NOTE_AMP_WINDOW, (flags & FLAG_AMP_OPEN) === 0)];
			case "delay": {
				const bypass = (flags & FLAG_DELAY_BYPASS) !== 0;
				return [buildNote(NOTE_DELAY_BYPASS, !bypass), buildNote(NOTE_DELAY_WINDOW, bypass)];
			}
		}
	}

	/**
	 * Tuner-Taste, eigener Tuner: Modus um (große Anzeige in der Leiste), ohne 0x13 und ohne
	 * Verbindung möglich (gemessen wird im Plugin). Dazu die Kanal-Mute nach
	 * channelMuteStep. Steinberg-Quelle: siehe unten (pressSteinberg).
	 *
	 * Steinberg-Quelle (Protokoll 4): schaltet den Tuner-Modus um, 0x13 mit dem Gegenteil des
	 * angezeigten Modus. Das Stummschalten erledigt das Script über „Mute" des Tuners;
	 * die Mute von Input 6 (Note 0) fasst diese Quelle nicht an.
	 *
	 *   an   nur mit Verbindung und bit5 (sonst null = gesperrt)
	 *   aus  immer: Ein hängender Modus hielte die Gitarre stumm. Ohne Verbindung geht
	 *        das 0x13 ins Leere, der Modus ist trotzdem aus und geht beim nächsten
	 *        Verbindungsaufbau als 0x13 0 hinaus.
	 *
	 * openWindow (Setting der Taste): dazu Note 1 = Tuner-Fenster auf bzw. zu — nur mit
	 * bit5, denn die Note wirkt ohne Titelprüfung auf den Deck-Kanal (4.1).
	 */
	pressTuner(openWindow: boolean, now = 0): number[][] | null {
		let out: number[][] | null;
		if (this.tunerSource === "own") {
			this.tunerMode = !this.tunerMode;
			this.pendingMute = this.tunerMode && this.muteChannel;
			// Ausschalten: Input 6 immer entmuten (nur mit der Option, sonst fasst die Taste den Mute nie an).
			this.pendingUnmute = !this.tunerMode && this.muteChannel;
			// Die Messung bleibt: Der Tuner läuft schon, solange die Taste da ist (Session).
			out = this.channelMuteStep();
		} else {
			out = this.pressSteinberg(openWindow);
		}
		if (out !== null && !this.tunerMode) out.push(...this.chainStep(now));
		return out;
	}

	/**
	 * Tuner-Modus verlassen: Kette sicherstellen (0x14, Wunsch des Users 2026-10-08) —
	 * nur mit Verbindung und bit5, denn das Script lädt in den Deck-Kanal. Ohne beides
	 * entfällt sie diesmal; beim nächsten Verlassen wieder.
	 */
	private chainStep(now: number): number[][] {
		if (this.baseStatus().kind !== "ok") return [];
		this.chainRestore = this.lastPreset;
		this.chainPending = true;
		this.presetGuardUntil = now + CHAIN_AWAIT_MS;
		return [buildChain()];
	}

	private pressSteinberg(openWindow: boolean): number[][] | null {
		const target = !this.tunerMode;
		const channelOk = this.baseStatus().kind === "ok";
		if (target && !channelOk) return null;
		this.tunerMode = target;
		const out = [buildTunerMode(target)];
		if (openWindow && channelOk) out.push(buildNote(NOTE_TUNER_WINDOW, target));
		return out;
	}

	/** Leerlauf (4.4): seit IDLE_AFTER_MS kein 0x11 und kein Druck auf eine Preset-Taste. */
	idle(now: number): boolean {
		return now - this.lastUserActionAt >= IDLE_AFTER_MS;
	}
}
