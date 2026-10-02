import {
	action,
	DidReceiveSettingsEvent,
	JsonValue,
	KeyAction,
	KeyDownEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

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
/** Erlaubter Kammerton (Hz); außerhalb gilt 440. */
export const A4_MIN = 400;
export const A4_MAX = 480;

interface Entry {
	key: KeyAction<TunerSettings>;
	throttle: Throttle;
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
 * Stimmen: Ein Druck schaltet den Tuner-Modus um. Die Touch-Leiste zeigt dann die
 * Stimmanzeige, die Regler ruhen.
 *
 * Quelle (Setting „source"):
 *   own        Eigener Tuner (Vorgabe): Das Plugin misst den gewählten Eingang selbst
 *              (Audio-Kindprozess, Setting „input", Vorgabe MADI 6; Kammerton „a4").
 *              Mit „muteChannel" (Vorgabe an) wird Input 6 in Nuendo stummgeschaltet,
 *              solange gestimmt wird — nur wenn er nicht schon stumm war, und aufgehoben
 *              wird nur, was die Taste selbst gesetzt hat.
 *   steinberg  Steinbergs Tuner in Slot 1 wie bisher (0x13/0x24, dessen eigene Mute);
 *              „openWindow" öffnet dazu sein Fenster.
 *
 * Im Modus zeigt die Taste die Note in klarer Schrift mit Cent-Balken und Lampe
 * (renderTunerKey), höchstens alle 100 ms neu; außerhalb das gewohnte Bild mit Lampe
 * und „Tuner" (renderToggleKey). Steinberg: klein „Tuner?", wenn der Tuner fehlt,
 * „stumm", wenn seine Mute ohne Modus anliegt. Eigener Tuner ohne Eingang: Taste
 * „Eingang?", Leiste „Eingang MADI 6 fehlt".
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
	}

	override onWillAppear(ev: WillAppearEvent<TunerSettings>): void {
		if (!ev.action.isKey()) return;
		const id = ev.action.id;
		this.entries.get(id)?.throttle.cancel();
		this.images.forget(id);
		const entry: Entry = { key: ev.action, throttle: new Throttle(TUNER_KEY_INTERVAL_MS, () => this.paint(id)) };
		this.entries.set(id, entry);
		this.session.configureTuner(tunerSettingsOf(ev.payload.settings));
		entry.throttle.request();
	}

	override onWillDisappear(ev: WillDisappearEvent<TunerSettings>): void {
		this.entries.get(ev.action.id)?.throttle.cancel();
		this.entries.delete(ev.action.id);
		this.images.forget(ev.action.id);
	}

	/** Quelle, Eingang, Mute und Kammerton gelten sofort; neu zeichnen. */
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<TunerSettings>): void {
		this.session.configureTuner(tunerSettingsOf(ev.payload.settings));
		this.entries.get(ev.action.id)?.throttle.request();
	}

	override onKeyDown(ev: KeyDownEvent<TunerSettings>): void {
		this.session.configureTuner(tunerSettingsOf(ev.payload.settings));
		if (!this.session.pressTuner(openWindowOf(ev.payload.settings))) void ev.action.showAlert();
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
			if (tuner.active) {
				image = renderTunerKey(tuner.reading, tuner.keyStatus);
			} else {
				const view = this.session.toggleView("tuner");
				image = renderToggleKey("tuner", view.on, view.status);
			}
		} catch (e) {
			streamDeck.logger.error(`Taste tuner zeichnen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.images.update(id, image, (img) => entry.key.setImage(img));
	}
}
