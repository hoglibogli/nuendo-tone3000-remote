import { buildPing, buildQuery, buildTunerMode, parseFrame } from "../midi/protocol";
import { DEFAULT_INPUT, type InputChoice } from "../tuner/inputs";
import { DEFAULT_A4 } from "../tuner/notes";
import type { OwnTunerConfig, OwnTunerEvent, OwnTunerPort, OwnTunerStatus } from "../tuner/source";
import { ownTunerState, type OwnTunerState } from "../tuner/wire";
import { Health } from "./health";
import { Status, Store, ToggleKind, TunerReading, TunerSourceKind } from "./store";

/**
 * Die Verbindung zu Nuendo als Ganzes: Store, Wächter, Senden, Abfragen.
 *
 * Hier laufen die Abläufe aus protokoll.md 4.4 zusammen:
 *
 *   Verbinden        Ping alle 2 s; mit dem ersten Pong steht die Verbindung, dann
 *                    0x13 mit dem Tuner-Modus des Decks (beim Plugin-Start aus) und 0x10.
 *                    Das 0x13 hebt einen Tuner-Mute auf, der liegen blieb, weil das
 *                    Deck verschwand, während der Modus an war (Protokoll 4).
 *   Wiederverbinden  Bleiben die Pongs aus, gilt sie als verloren („Warte…"); der
 *                    nächste Pong schickt wieder 0x13 und fragt erneut ab. Gesperrt
 *                    bleibt bis zum ersten frischen 0x22 (Store.setConnected).
 *   Leerlauf         Alle 5 s 0x10, solange seit 2 s kein 0x11 und kein Druck auf eine
 *                    Preset-Taste kam.
 *   Sofort           0x10, wenn sich bit5, bit6 oder der Slot-3-Name ändert. Mehrere
 *                    Anlässe aus einem Schwall werden zu einer Abfrage zusammengefasst.
 *   Tuner-Mute       Meldet ein 0x24 außerhalb des Modus eine Tuner-Mute (bit2 = 0,
 *                    bit3 = 1, bit4 = 1), einmal 0x13 00 — bei bestehender Verbindung,
 *                    wo das 0x13 des Verbindungsaufbaus nicht hilft (protokoll.md 5.5).
 *                    Mit dem eigenen Tuner soll Steinbergs Modus und Mute immer aus sein.
 *   Eigener Tuner    Im Tuner-Modus mit der Quelle „own" läuft der Audio-Kindprozess
 *                    (ownTuner, tuner/source.ts), sonst nicht; seine Messungen und
 *                    Fehler landen im Store. Die Kanal-Mute (Note 0) regelt der Store; den
 *                    Merker „Taste hat gemutet" meldet onChannelMuteMarker, damit das
 *                    Plugin ihn in den globalen Einstellungen festhält.
 *
 * Senden und Zeit kommen von außen: Im Plugin der MIDI-Ausgang und Date.now, im
 * Test ein Portpaar im Speicher und eine Uhr von Hand. Ohne useTimers läuft nichts
 * von selbst; der Test ruft tick() und lässt verschobene Aufgaben über `defer` laufen.
 */

/** Leerlauf-Abfrage (4.4). */
export const IDLE_QUERY_MS = 5000;
/** Takt für Ping, Verbindungsurteil und Leerlauf-Abfrage. */
export const TICK_MS = 250;

export interface SessionOptions {
	send: (bytes: number[]) => void;
	now?: () => number;
	log?: (line: string) => void;
	/** Takt per setInterval (Plugin). Ohne: tick() von Hand (Tests). Vorgabe true. */
	useTimers?: boolean;
	/** Verschiebt eine Aufgabe ans Ende des Schwalls. Vorgabe setImmediate. */
	defer?: (fn: () => void) => void;
	/** Eigener Tuner (Audio-Kindprozess). Ohne: Die Quelle „own" wartet nur. */
	ownTuner?: OwnTunerPort;
	/** Merker der Kanal-Mute hat sich geändert (festhalten, überlebt den Neustart). */
	onChannelMuteMarker?: (on: boolean) => void;
}

/** Was die Tuner-Taste einstellt (Property Inspector). */
export interface TunerSettingsView {
	source: TunerSourceKind;
	muteChannel: boolean;
	input: InputChoice;
	a4: number;
}

export interface KnobView {
	value01: number;
	status: Status;
}
export interface PresetView {
	active: boolean;
	status: Status;
}
export interface ToggleView {
	on: boolean;
	status: Status;
}
/** Stimmanzeige: Modus, letzte Messung (null = noch keine) und Zustand für Leiste und Taste. */
export interface TunerView {
	active: boolean;
	reading: TunerReading | OwnTunerState | null;
	/** Für die Leiste (etwa „Eingang MADI 6 fehlt"). */
	status: Status;
	/** Für die Taste im Modus (etwa „Eingang?"). */
	keyStatus: Status;
}

export class Session {
	readonly store = new Store();
	readonly health = new Health();

	private readonly sendBytes: (bytes: number[]) => void;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly useTimers: boolean;
	private readonly defer: (fn: () => void) => void;

	private lastQueryAt = -Infinity;
	private queryPending = false;
	private changePending = false;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private readonly listeners = new Set<() => void>();
	private readonly ownTuner: OwnTunerPort | undefined;
	private readonly onMarker: (on: boolean) => void;
	private ownConfig: OwnTunerConfig = { ...DEFAULT_INPUT, a4: DEFAULT_A4 };
	private ownRunning = false;
	private markerSeen = false;

	constructor(options: SessionOptions) {
		this.sendBytes = options.send;
		this.now = options.now ?? (() => Date.now());
		this.log = options.log ?? (() => undefined);
		this.useTimers = options.useTimers ?? true;
		this.defer = options.defer ?? ((fn) => void setImmediate(fn));
		this.ownTuner = options.ownTuner;
		this.onMarker = options.onChannelMuteMarker ?? (() => undefined);
		this.ownTuner?.listen((ev) => this.onOwnTuner(ev));
	}

	/** Meldet jede Änderung, die die Anzeige betrifft — einmal je Schwall. */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** Takt starten: Ping sofort, danach alle TICK_MS urteilen. */
	start(): void {
		if (!this.useTimers || this.ticker !== undefined) return;
		this.ticker = setInterval(() => this.tick(), TICK_MS);
		this.tick();
	}

	stop(): void {
		if (this.ticker !== undefined) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	get connected(): boolean {
		return this.health.connected;
	}

	/** Ping, Verbindungsurteil, Leerlauf-Abfrage. */
	tick(now: number = this.now()): void {
		if (this.health.check(now)) {
			this.store.setConnected(false);
			this.log("Nuendo antwortet nicht mehr auf Pings (Warte…)");
			this.changed();
		}
		if (this.health.pingDue(now)) {
			this.health.notePing(now);
			this.sendBytes(buildPing());
		}
		if (this.health.connected && now - this.lastQueryAt >= IDLE_QUERY_MS && this.store.idle(now)) {
			this.query(now);
		}
	}

	/** Jede Nachricht von Nuendo. */
	receive(bytes: ArrayLike<number>): void {
		const frame = parseFrame(bytes);
		if (!frame) return;
		const now = this.now();
		switch (frame.type) {
			case "pong":
				if (this.health.notePong(now)) {
					this.store.setConnected(true);
					const mode = this.store.tunerMode;
					this.log(`Nuendo antwortet (Pong), Tuner-Modus ${mode ? "an" : "aus"}, frage ab`);
					this.changed();
					// Erst der Modus fürs Script (eigener Tuner: immer aus), dann die Abfrage (Protokoll 4).
					this.sendBytes(buildTunerMode(this.store.scriptTunerMode()));
					this.query(now);
				}
				return;
			case "debug":
				// Debugzeilen werden nicht ausgewertet (4.2), nur protokolliert.
				this.log(`Nuendo: ${frame.text}`);
				return;
			default: {
				const result = this.store.apply(frame, now);
				if (result.changed) this.changed();
				if (result.releaseTuner) {
					this.log("Tuner-Mute steht außerhalb des Modus an, hebe sie auf (0x13 00)");
					this.sendBytes(buildTunerMode(false));
				}
				if (result.send) this.sendNotes(result.send, "nachgeholt");
				if (result.queryNow) this.requestQuery();
			}
		}
	}

	//--------------------------------------------------------------------------
	// Bedienung; true, wenn etwas gesendet wurde
	//--------------------------------------------------------------------------

	turn(p: number, ticks: number): boolean {
		return this.sendOwn(this.store.turn(p, ticks, this.now()));
	}

	center(p: number): boolean {
		return this.sendOwn(this.store.center(p, this.now()));
	}

	selectPreset(name: string): boolean {
		const bytes = this.store.selectPreset(name, this.now());
		if (!bytes) return false;
		this.sendBytes(bytes);
		return true;
	}

	toggle(kind: ToggleKind): boolean {
		if (kind === "tuner") return this.pressTuner(false);
		const notes = this.store.toggle(kind);
		if (!notes) return false;
		for (const bytes of notes) this.sendBytes(bytes);
		return true;
	}

	/**
	 * Tuner-Taste: Modus umschalten (0x13), mit openWindow dazu das Tuner-Fenster
	 * (Note 1). Die Anzeige wechselt sofort; das 0x24 der Antwort bestätigt den Modus.
	 */
	pressTuner(openWindow: boolean): boolean {
		const own = this.store.tunerSource === "own";
		const messages = this.store.pressTuner(openWindow && !own);
		if (!messages) return false;
		this.log(`Tuner-Modus ${this.store.tunerMode ? "an" : "aus"} (${own ? "eigener Tuner" : "Steinberg-Tuner"})${openWindow && !own ? " (mit Fenster)" : ""}`);
		for (const bytes of messages) this.sendBytes(bytes);
		this.afterTunerChange();
		return true;
	}

	/**
	 * Setting der Tuner-Taste (Erscheinen, Änderung im Property Inspector, Druck). Wechselt
	 * die Quelle im Modus, endet der Modus; ein neuer Eingang oder Kammerton startet den
	 * laufenden eigenen Tuner neu.
	 */
	configureTuner(settings: TunerSettingsView): void {
		const wasMode = this.store.tunerMode;
		const wasSource = this.store.tunerSource;
		const messages = this.store.configureTuner({ source: settings.source, muteChannel: settings.muteChannel });
		this.ownConfig = { device: settings.input.device, channel: settings.input.channel, a4: settings.a4 };
		if (wasSource !== settings.source) this.log(`Tuner-Quelle: ${settings.source === "own" ? "eigener Tuner" : "Steinberg-Tuner in Slot 1"}${wasMode && !this.store.tunerMode ? " (Modus beendet)" : ""}`);
		this.sendNotes(messages, "Einstellung");
		this.afterTunerChange(wasMode !== this.store.tunerMode || wasSource !== settings.source);
	}

	/**
	 * Merker der Kanal-Mute aus den globalen Einstellungen (Plugin-Start): Steht er und
	 * ist Input 6 noch stumm, hebt das nächste 0x22 die Mute einmal auf.
	 */
	restoreChannelMute(on: boolean): void {
		const messages = this.store.restoreChannelMute(on);
		if (on) this.log("Merker: Die Tuner-Taste hatte Input 6 stummgeschaltet; wird aufgehoben, sobald Nuendo meldet");
		this.sendNotes(messages, "Merker");
		this.checkMarker();
	}

	private sendNotes(messages: number[][], why: string): void {
		for (const bytes of messages) {
			this.log(`Kanal-Mute Input 6 ${bytes[2] ? "an" : "aus"} (${why})`);
			this.sendBytes(bytes);
		}
		this.checkMarker();
	}

	/** Merker geändert? Dann dem Plugin melden (globale Einstellungen). */
	private checkMarker(): void {
		const on = this.store.channelMuted;
		if (this.markerSeen === on) return;
		this.markerSeen = on;
		this.onMarker(on);
	}

	/** Nach Druck oder Einstellung: Kindprozess nachführen, Anzeige melden. */
	private afterTunerChange(changed = true): void {
		this.checkMarker();
		this.syncOwnTuner();
		if (changed) this.changed();
	}

	/** Eigener Tuner läuft genau im Modus mit der Quelle „own". */
	private syncOwnTuner(): void {
		const want = this.store.tunerMode && this.store.tunerSource === "own";
		if (want) {
			this.ownTuner?.start(this.ownConfig); // gleicher Auftrag: bleibt, anderer: Neustart
			this.ownRunning = true;
		} else if (this.ownRunning) {
			this.ownTuner?.stop();
			this.ownRunning = false;
		}
	}

	private onOwnTuner(ev: OwnTunerEvent): void {
		if (!this.ownRunning) return; // Nachzügler nach dem Stopp
		let changed: boolean;
		if (ev.type === "reading") {
			changed = this.store.setOwnReading(ownTunerState(ev.reading));
		} else {
			const [strip, key] = statusOf(ev.status);
			changed = this.store.setOwnStatus(strip, key);
			if (ev.status.kind === "error") this.log(`Eigener Tuner: ${ev.status.text}`);
		}
		if (changed) this.changed();
	}

	private sendOwn(bytes: number[] | null): boolean {
		if (!bytes) return false;
		this.sendBytes(bytes);
		this.changed(); // sofort lokal anzeigen, nicht auf ein 0x20 warten
		return true;
	}

	//--------------------------------------------------------------------------
	// Anzeige
	//--------------------------------------------------------------------------

	knob(p: number): KnobView {
		return { value01: this.store.knobValue(p), status: this.store.knobStatus(p) };
	}

	preset(name: string): PresetView {
		return { active: this.store.isPresetActive(name), status: this.store.presetStatus() };
	}

	/** Beim Tuner: an = Tuner-Modus; Status auch „Tuner?" und „stumm" (Store.tunerKeyStatus). */
	toggleView(kind: ToggleKind): ToggleView {
		return { on: this.store.isToggleOn(kind), status: this.store.toggleStatus(kind) };
	}

	/** Zeigt die Leiste die Stimmanzeige statt der Regler? */
	tunerActive(): boolean {
		return this.store.tunerMode;
	}

	tuner(): TunerView {
		return {
			active: this.store.tunerMode,
			reading: this.store.tunerReading(),
			status: this.store.tunerStatus(),
			keyStatus: this.store.tunerKeyViewStatus(),
		};
	}

	//--------------------------------------------------------------------------

	private query(now: number): void {
		this.lastQueryAt = now;
		this.sendBytes(buildQuery());
	}

	private requestQuery(): void {
		if (this.queryPending) return;
		this.queryPending = true;
		this.defer(() => {
			this.queryPending = false;
			this.query(this.now());
		});
	}

	private changed(): void {
		if (this.changePending) return;
		this.changePending = true;
		this.defer(() => {
			this.changePending = false;
			for (const fn of this.listeners) {
				try {
					fn();
				} catch (e) {
					this.log(`Anzeige fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		});
	}
}

/** Zustand des Kindprozesses → Status für Leiste und Taste. */
function statusOf(status: OwnTunerStatus): [Status, Status] {
	switch (status.kind) {
		case "starting":
			return [{ kind: "waiting" }, { kind: "waiting" }];
		case "running":
			return [{ kind: "ok" }, { kind: "ok" }];
		case "error":
			return [
				{ kind: "error", text: status.text },
				{ kind: "error", text: status.key },
			];
	}
}
