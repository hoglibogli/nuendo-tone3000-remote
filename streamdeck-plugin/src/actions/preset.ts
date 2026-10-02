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

import { listPresets, T3kPreset } from "../presets/t3k-presets";
import { renderPresetKey } from "../render";
import { Session } from "../state/session";
import { ImageCache } from "./image-cache";

type PresetSettings = {
	/** Presetname, wie TONE3000 ihn führt (Groß/klein zählt). */
	preset?: string;
};

interface Entry {
	key: KeyAction<PresetSettings>;
	name: string;
}

/**
 * Eine Taste für ein TONE3000-Preset.
 *
 * Druck: 0x12 mit dem Namen. Den hellen Goldrahmen bekommt die Taste erst, wenn
 * Nuendo das Preset als aktiv meldet (0x21), nie vorab (protokoll.md 4.4). Gesperrt
 * ohne Verbindung, bei bit5 = 0 oder bit6 = 0; ein gesperrter Druck zeigt das
 * Warnzeichen.
 *
 * Die Auswahl im Property Inspector kommt aus listPresets(): eigene Presets zuerst,
 * dann die Werkspresets.
 */
@action({ UUID: "com.sorg.tone3000.preset" })
export class PresetAction extends SingletonAction<PresetSettings> {
	private readonly entries = new Map<string, Entry>();
	private readonly images = new ImageCache();

	constructor(private readonly session: Session) {
		super();
		session.onChange(() => {
			for (const id of this.entries.keys()) this.paint(id);
		});
	}

	override onWillAppear(ev: WillAppearEvent<PresetSettings>): void {
		if (!ev.action.isKey()) return;
		this.images.forget(ev.action.id);
		this.entries.set(ev.action.id, { key: ev.action, name: nameOf(ev.payload.settings) });
		this.paint(ev.action.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<PresetSettings>): void {
		this.entries.delete(ev.action.id);
		this.images.forget(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<PresetSettings>): void {
		const entry = this.entries.get(ev.action.id);
		if (!entry) return;
		entry.name = nameOf(ev.payload.settings);
		this.paint(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<PresetSettings>): void {
		const name = nameOf(ev.payload.settings);
		if (name === "" || !this.session.selectPreset(name)) void ev.action.showAlert();
	}

	/** Datenquelle der Auswahl im Property Inspector (sdpi-components). */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, PresetSettings>): Promise<void> {
		const event = (ev.payload as { event?: string })?.event;
		if (event !== "getPresets") return;
		let presets: T3kPreset[] = [];
		try {
			presets = listPresets();
		} catch (e) {
			streamDeck.logger.error(`Presets nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
		}
		const item = (p: T3kPreset) => ({ label: p.name, value: p.name });
		const own = presets.filter((p) => p.source === "user").map(item);
		const factory = presets.filter((p) => p.source === "factory").map(item);
		const items: JsonValue[] = [];
		if (own.length > 0) items.push({ label: "Eigene", children: own });
		if (factory.length > 0) items.push({ label: "Werkspresets", children: factory });
		await streamDeck.ui.current?.sendToPropertyInspector({ event, items });
	}

	private paint(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		const view = this.session.preset(entry.name);
		let image: string;
		try {
			// Ohne gewähltes Preset "": Die Grafik setzt den Platzhalter und dimmt ihn ab.
			image = renderPresetKey(entry.name, view.active, view.status);
		} catch (e) {
			streamDeck.logger.error(`Preset-Taste zeichnen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.images.update(id, image, (img) => entry.key.setImage(img));
	}
}

function nameOf(settings: PresetSettings): string {
	return typeof settings.preset === "string" ? settings.preset : "";
}
