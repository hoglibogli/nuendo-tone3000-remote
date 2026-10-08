import {
	action,
	DidReceiveSettingsEvent,
	JsonValue,
	KeyAction,
	KeyDownEvent,
	KeyUpEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

import { CHAIN_LOADED } from "../midi/protocol";
import { renderToggleKey, renderTunerKey } from "../render";
import type { TunerSettingsView } from "../state/session";
import { Session } from "../state/session";
import { Throttle } from "../state/throttle";
import { inputValue, parseInputSetting, type InputItem } from "../tuner/inputs";
import { DEFAULT_A4 } from "../tuner/notes";
import { ImageCache } from "./image-cache";

type TunerSettings = {
	/** Quelle: "own" eigener Tuner (Vorgabe) oder "steinberg" (Steinberg-Tuner in Slot 1). */
	source?: string;
	/** Eingang des eigenen Tuners: {device, channel} bzw. sein JSON-Text; Vorgabe MADI 6. */
	input?: JsonValue;
	/** Eigener Tuner: Input 6 beim Stimmen stummschalten; Vorgabe an. */
	muteChannel?: boolean;
	/** Kammerton A4 in Hz (Text aus dem Property Inspector oder Zahl); Vorgabe 440. */
	a4?: string | number;
	/** Steinberg-Quelle: „Tuner-Fenster am Rechner öffnen"; Vorgabe aus. */
	openWindow?: boolean;
};

/** Höchstens alle 100 ms ein setImage (Elgato: etwa 10 Bilder je Sekunde und Aktion). */
export const TUNER_KEY_INTERVAL_MS = 100;
/** Ab so langem Halten gilt der Druck als lang: automatische Stummschaltung umschalten. */
export const LONG_PRESS_MS = 500;
/** Erlaubter Kammerton (Hz); außerhalb gilt 440. */
export const A4_MIN = 400;
export const A4_MAX = 480;

interface Entry {
	key: KeyAction<TunerSettings>;
	throttle: Throttle;
	/** Letzte bekannte Settings der Taste (Rahmenfarbe, Langdruck). */
	settings: TunerSettings;
	/** Läuft, solange die Taste gedrückt ist und der Druck noch nicht als lang gilt. */
	pressTimer: ReturnType<typeof setTimeout> | null;
}

/** Roter Rahmen: eigener Tuner mit eingeschalteter automatischer Stummschaltung. */
export function muteArmed(settings: TunerSettings | undefined): boolean {
	const view = tunerSettingsOf(settings);
	return view.source === "own" && view.muteChannel;
}

/** Nur ein echtes true zählt; alles andere (fehlt, "true", 1) heißt aus. */
export function openWindowOf(settings: TunerSettings | undefined): boolean {
	return settings?.openWindow === true;
}

/** Kammerton aus dem Setting: Zahl oder Text („442", „441,5"); sonst 440. */
export function a4Of(value: unknown): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim().replace(",", ".")) : NaN;
	return Number.isFinite(n) && n >= A4_MIN && n <= A4_MAX ? n : DEFAULT_A4;
}

/** Settings der Taste → was Session und Store brauchen; Fehlendes nach Vorgabe. */
export function tunerSettingsOf(settings: TunerSettings | undefined): TunerSettingsView {
	return {
		source: settings?.source === "steinberg" ? "steinberg" : "own",
		muteChannel: settings?.muteChannel !== false,
		input: parseInputSetting(settings?.input),
		a4: a4Of(settings?.a4),
	};
}

/** Auswahl „Eingang" im Property Inspector: je Gerät eine Gruppe mit seinen Mono-Kanälen. */
export function inputItems(items: readonly InputItem[]): JsonValue[] {
	if (items.length === 0) return [{ label: "Keine Eingänge gefunden", value: "", disabled: true }];
	const groups = new Map<string, JsonValue[]>();
	for (const it of items) {
		const list = groups.get(it.device) ?? [];
		list.push({ label: it.label, value: inputValue(it) });
		groups.set(it.device, list);
	}
	return [...groups].map(([device, children]) => ({ label: device, children }));
}

/**
 * Stimmen: Mit dem eigenen Tuner zeigt die Taste die Stimmanzeige immer, solange sie auf
 * dem Deck liegt (Wunsch des Users 2026-10-07). Ein kurzer Druck schaltet den
 * Tuner-Modus um (beim Loslassen): die große Stimmanzeige in der Touch-Leiste, die Regler
 * ruhen, und mit der automatischen Stummschaltung ist Input 6 stumm; im Modus trägt die
 * Taste einen hellen Rahmen. Ein langer Druck (LONG_PRESS_MS) schaltet die automatische
 * Stummschaltung um; ist sie an, ist der Rahmen rot statt golden.
 *
 * Verlässt ein kurzer Druck den Modus, prüft das Script die Kette (Protokoll 5): fehlt
 * H-Delay Mono in Slot 2 oder TONE3000 in Slot 3, lädt es sie (Wunsch 2026-10-08). Die
 * Taste zeigt danach ein Häkchen (geladen) oder ein Warndreieck (gescheitert).
 *
 * Quelle (Setting „source"):
 *   own        Eigener Tuner (Vorgabe): Das Plugin misst den gewählten Eingang selbst
 *              (Audio-Kindprozess, Setting „input", Vorgabe MADI 6; Kammerton „a4").
 *              Mit „muteChannel" (Vorgabe an) wird Input 6 in Nuendo stummgeschaltet,
 *              solange gestimmt wird (nur wenn er nicht schon stumm war); beim
 *              Ausschalten wird er immer wieder offen geschaltet.
 *   steinberg  Steinbergs Tuner in Slot 1 wie bisher (0x13/0x24, dessen eigene Mute);
 *              „openWindow" öffnet dazu sein Fenster.
 *
 * Die Stimmanzeige der Taste: Note in klarer Schrift mit Cent-Balken und Lampe
 * (renderTunerKey), höchstens alle 100 ms neu. Steinberg zeigt sie nur im Modus,
 * außerhalb das gewohnte Bild mit Lampe und „Tuner" (renderToggleKey), klein „Tuner?",
 * wenn der Tuner fehlt, „stumm", wenn seine Mute ohne Modus anliegt. Eigener Tuner ohne
 * Eingang: Taste „Eingang?", Leiste „Eingang MADI 6 fehlt".
 *
 * Gesperrt ist nur das Einschalten der Steinberg-Quelle ohne Verbindung oder bei bit5 = 0
 * (Warnzeichen); Ausschalten geht immer. Der eigene Tuner braucht Nuendo nicht.
 *
 * Die Auswahl „Eingang" im Property Inspector kommt aus dem Listenmodus des Workers
 * (listInputs): jedes WASAPI-Gerät in einzelne Mono-Kanäle zerlegt.
 */
@action({ UUID: "com.sorg.tone3000.tuner" })
export class TunerAction extends SingletonAction<TunerSettings> {
	private readonly entries = new Map<string, Entry>();
	private readonly images = new ImageCache();

	constructor(
		private readonly session: Session,
		private readonly listInputs: () => Promise<InputItem[]> = async () => [],
	) {
		super();
		session.onChange(() => {
			for (const entry of this.entries.values()) entry.throttle.request();
		});
		session.onChainResult((result) => this.showChainResult(result.delay, result.amp));
	}

	/**
	 * Kette (0x25): Warndreieck, wenn ein Slot nicht stimmt; Häkchen, wenn etwas geladen
	 * wurde; nichts, wenn beides schon da war.
	 */
	private showChainResult(delay: number, amp: number): void {
		const failed = delay > CHAIN_LOADED || amp > CHAIN_LOADED;
		const loaded = delay === CHAIN_LOADED || amp === CHAIN_LOADED;
		for (const entry of this.entries.values()) {
			if (failed) void entry.key.showAlert();
			else if (loaded) void entry.key.showOk();
		}
	}

	override onWillAppear(ev: WillAppearEvent<TunerSettings>): void {
		if (!ev.action.isKey()) return;
		const id = ev.action.id;
		this.forget(id);
		const entry: Entry = {
			key: ev.action,
			throttle: new Throttle(TUNER_KEY_INTERVAL_MS, () => this.paint(id)),
			settings: ev.payload.settings ?? {},
			pressTimer: null,
		};
		this.entries.set(id, entry);
		this.session.configureTuner(tunerSettingsOf(entry.settings));
		this.session.setTunerKeyVisible(true);
		entry.throttle.request();
	}

	override onWillDisappear(ev: WillDisappearEvent<TunerSettings>): void {
		this.forget(ev.action.id);
		this.session.setTunerKeyVisible(this.entries.size > 0);
	}

	/** Quelle, Eingang, Mute und Kammerton gelten sofort; neu zeichnen (Rahmenfarbe). */
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<TunerSettings>): void {
		const entry = this.entries.get(ev.action.id);
		if (entry) entry.settings = ev.payload.settings ?? {};
		this.session.configureTuner(tunerSettingsOf(ev.payload.settings));
		entry?.throttle.request();
	}

	/**
	 * Kurz oder lang: Beim Drücken startet nur die Uhr. Wird vor LONG_PRESS_MS
	 * losgelassen, schaltet onKeyUp den Tuner-Modus um (kurzer Druck, wie bisher —
	 * jetzt beim Loslassen, sonst ließe sich lang nicht von kurz trennen). Läuft die
	 * Uhr ab, schaltet die Taste noch während des Haltens die automatische
	 * Stummschaltung um; das Loslassen danach tut nichts mehr.
	 */
	override onKeyDown(ev: KeyDownEvent<TunerSettings>): void {
		const entry = this.entries.get(ev.action.id);
		if (!entry) {
			this.shortPress(ev.action, ev.payload.settings);
			return;
		}
		entry.settings = ev.payload.settings ?? entry.settings;
		if (entry.pressTimer) clearTimeout(entry.pressTimer);
		entry.pressTimer = setTimeout(() => {
			entry.pressTimer = null;
			this.toggleAutoMute(entry);
		}, LONG_PRESS_MS);
	}

	override onKeyUp(ev: KeyUpEvent<TunerSettings>): void {
		const entry = this.entries.get(ev.action.id);
		if (!entry || !entry.pressTimer) return; // langer Druck schon ausgeführt
		clearTimeout(entry.pressTimer);
		entry.pressTimer = null;
		entry.settings = ev.payload.settings ?? entry.settings;
		this.shortPress(ev.action, entry.settings);
	}

	/** Kurzer Druck: Tuner-Modus an/aus (gesperrt nur bei der Steinberg-Quelle, Warnzeichen). */
	private shortPress(key: KeyAction<TunerSettings>, settings: TunerSettings | undefined): void {
		this.session.configureTuner(tunerSettingsOf(settings));
		if (!this.session.pressTuner(openWindowOf(settings))) void key.showAlert();
	}

	/**
	 * Langer Druck: automatische Stummschaltung (Setting „muteChannel") umschalten und
	 * speichern — der Haken im Property Inspector zieht mit. Wirkt sofort, auch im
	 * Tuner-Modus: an = Input 6 jetzt stumm (sofern nicht schon), aus = die eigene
	 * Stummschaltung wieder aufheben (Store.configureTuner).
	 */
	private toggleAutoMute(entry: Entry): void {
		const next: TunerSettings = { ...entry.settings, muteChannel: !tunerSettingsOf(entry.settings).muteChannel };
		entry.settings = next;
		this.session.configureTuner(tunerSettingsOf(next));
		void entry.key.setSettings(next);
		streamDeck.logger.info(`Tuner: automatische Stummschaltung ${next.muteChannel ? "an" : "aus"} (langer Druck)`);
		entry.throttle.request();
	}

	private forget(id: string): void {
		const entry = this.entries.get(id);
		if (entry?.pressTimer) clearTimeout(entry.pressTimer);
		entry?.throttle.cancel();
		this.entries.delete(id);
		this.images.forget(id);
	}

	/** Datenquelle der Auswahl „Eingang" im Property Inspector (sdpi-components). */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, TunerSettings>): Promise<void> {
		const event = (ev.payload as { event?: string })?.event;
		if (event !== "getInputs") return;
		let items: InputItem[] = [];
		try {
			items = await this.listInputs();
		} catch (e) {
			streamDeck.logger.error(`Eingänge nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
		}
		await streamDeck.ui.current?.sendToPropertyInspector({ event, items: inputItems(items) });
	}

	private paint(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		let image: string;
		try {
			const tuner = this.session.tuner();
			const red = muteArmed(entry.settings);
			// Eigener Tuner: Stimmanzeige immer; Steinberg liefert Messwerte nur im Modus.
			if (tuner.active || this.session.store.tunerSource === "own") {
				image = renderTunerKey(tuner.reading, tuner.keyStatus, red, tuner.active);
			} else {
				const view = this.session.toggleView("tuner");
				image = renderToggleKey("tuner", view.on, view.status, red);
			}
		} catch (e) {
			streamDeck.logger.error(`Taste tuner zeichnen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.images.update(id, image, (img) => entry.key.setImage(img));
	}
}
