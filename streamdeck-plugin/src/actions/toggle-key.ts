import {
	JsonObject,
	KeyAction,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

import { renderToggleKey } from "../render";
import { Session } from "../state/session";
import { ToggleKind } from "../state/store";
import { ImageCache } from "./image-cache";

/**
 * Gemeinsamer Teil der Umschalt-Tasten amp und delay. Die Tuner-Taste hat seit
 * Protokoll 4 ihre eigene Aktion (tuner.ts): Tuner-Modus, Stimmanzeige, Drossel.
 *
 * Der Zielzustand kommt aus dem letzten 0x22 (protokoll.md 4.4); was gesendet wird,
 * entscheidet Store.toggle. Ohne Verbindung und bei bit5 = 0 — bei amp auch bei
 * bit6 = 0 — ist die Taste gesperrt: Die Noten wirken ohne Titelprüfung auf den Deck-Kanal,
 * also womöglich auf einen fremden Kanal (4.1). Ein gesperrter Druck zeigt das
 * Warnzeichen.
 */
export abstract class ToggleKeyAction extends SingletonAction<JsonObject> {
	private readonly keys = new Map<string, KeyAction<JsonObject>>();
	private readonly images = new ImageCache();

	protected constructor(
		private readonly session: Session,
		private readonly kind: Exclude<ToggleKind, "tuner">,
	) {
		super();
		session.onChange(() => {
			for (const id of this.keys.keys()) this.paint(id);
		});
	}

	override onWillAppear(ev: WillAppearEvent<JsonObject>): void {
		if (!ev.action.isKey()) return;
		this.images.forget(ev.action.id);
		this.keys.set(ev.action.id, ev.action);
		this.paint(ev.action.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		this.keys.delete(ev.action.id);
		this.images.forget(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<JsonObject>): void {
		if (!this.session.toggle(this.kind)) void ev.action.showAlert();
	}

	private paint(id: string): void {
		const key = this.keys.get(id);
		if (!key) return;
		const view = this.session.toggleView(this.kind);
		let image: string;
		try {
			image = renderToggleKey(this.kind, view.on, view.status);
		} catch (e) {
			streamDeck.logger.error(`Taste ${this.kind} zeichnen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.images.update(id, image, (img) => key.setImage(img));
	}
}
