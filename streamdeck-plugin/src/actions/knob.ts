import {
	action,
	DialAction,
	DialDownEvent,
	DialRotateEvent,
	DidReceiveSettingsEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

import { PARAM_NAMES } from "../midi/protocol";
import { renderDial, renderTunerSegment } from "../render";
import { Session } from "../state/session";
import { paramIndexFor, tunerSegmentFor } from "../state/store";
import { Throttle } from "../state/throttle";
import { ImageCache } from "./image-cache";

type KnobSettings = {
	/** gain | bass | mid | treble; leer = nach Spalte. */
	param?: string;
};

/** Höchstens alle 30 ms ein setFeedback je Regler, der letzte Stand gewinnt. */
export const DISPLAY_INTERVAL_MS = 30;
/**
 * Stimmanzeige: höchstens alle 100 ms ein setFeedback je Segment. Elgato erlaubt
 * etwa 10 Bild-Updates je Sekunde und Aktion; die Cent-Werte kommen ebenso schnell.
 */
export const TUNER_INTERVAL_MS = 100;

interface Entry {
	dial: DialAction<KnobSettings>;
	/** Setting „param" aus dem Property Inspector; leer = nach Position. */
	explicit: string | undefined;
	/** p nach protokoll.md 4.1: 0 Gain, 1 Bass, 2 Mid, 3 Treble; bestimmt auch das Segment der Stimmanzeige. */
	p: number;
	/** Spalte am Gerät; nur für die Reihenfolge der Regler untereinander. */
	column: number | undefined;
	throttle: Throttle;
}

/**
 * Ein Drehregler des Stream Deck + XL für einen der vier TONE3000-Regler.
 *
 * Drehen: Wert += turnDelta(Ticks) (0,02 je Raste, schnelles Drehen doppelt) und
 * sofort 0x11; Drücken: Mitte (8192). Die Anzeige
 * folgt sofort dem eigenen Wert, nicht erst einer Rückmeldung (protokoll.md 4.4).
 * Gezeichnet wird ein Bild über das ganze Segment der Touch-Leiste
 * (layouts/knob.json), gedrosselt und nur, wenn es sich geändert hat.
 *
 * Tuner-Modus (Protokoll 4): Die Leiste zeigt statt der Regler die Stimmanzeige,
 * jeder Regler das Segment seines Parameters (tunerSegmentFor), höchstens alle 100 ms.
 * Segmente, in denen sich nichts geändert hat, liefert die Grafik als dieselbe
 * Zeichenkette — ImageCache setzt sie dann nicht neu. Drehen und Drücken ruhen
 * (der Store sperrt), ohne Warnzeichen. Endet der Modus, kommt das Regler-Bild aus
 * dem Zwischenspeicher der Grafik sofort zurück.
 *
 * Welcher Regler: das Setting „param", sonst die Position unter allen
 * Tone3000-Reglern von links (reassign): der linke Gain, dann Bass, Mid, Treble.
 */
@action({ UUID: "com.sorg.tone3000.knob" })
export class KnobAction extends SingletonAction<KnobSettings> {
	private readonly entries = new Map<string, Entry>();
	private readonly images = new ImageCache();

	constructor(private readonly session: Session) {
		super();
		session.onChange(() => {
			for (const entry of this.entries.values()) entry.throttle.request();
		});
	}

	override onWillAppear(ev: WillAppearEvent<KnobSettings>): void {
		if (!ev.action.isDial()) return;
		const dial = ev.action;
		const id = dial.id;
		this.entries.get(id)?.throttle.cancel();
		this.images.forget(id);
		const explicit = ev.payload.settings.param;
		const entry: Entry = {
			dial,
			explicit,
			p: paramIndexFor(explicit, undefined),
			column: dial.coordinates?.column,
			throttle: new Throttle(
				() => (this.session.tunerActive() ? TUNER_INTERVAL_MS : DISPLAY_INTERVAL_MS),
				() => this.paint(id),
			),
		};
		this.entries.set(id, entry);
		this.reassign();
		entry.throttle.request();
	}

	override onWillDisappear(ev: WillDisappearEvent<KnobSettings>): void {
		this.entries.get(ev.action.id)?.throttle.cancel();
		this.entries.delete(ev.action.id);
		this.images.forget(ev.action.id);
		this.reassign();
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KnobSettings>): void {
		if (!ev.action.isDial()) return;
		const entry = this.entries.get(ev.action.id);
		if (!entry) return;
		entry.explicit = ev.payload.settings.param;
		this.reassign();
		entry.throttle.request();
	}

	/**
	 * p aller Regler neu bestimmen: das Setting, sonst der Rang unter allen
	 * Tone3000-Reglern nach Spalte (der linke 0 = Gain). Regler, deren p sich ändert,
	 * zeichnen neu. Läuft bei jedem Erscheinen, Verschwinden und neuen Setting.
	 */
	private reassign(): void {
		const byColumn = [...this.entries.values()]
			.filter((e) => e.column !== undefined)
			.sort((a, b) => (a.column as number) - (b.column as number));
		for (const e of this.entries.values()) {
			const rank = byColumn.indexOf(e);
			const p = paramIndexFor(e.explicit, rank >= 0 ? rank : undefined);
			if (p === e.p) continue;
			e.p = p;
			e.throttle.request();
		}
	}

	/** Im Tuner-Modus sperrt der Store: Nichts geht hinaus. */
	override onDialRotate(ev: DialRotateEvent<KnobSettings>): void {
		this.session.turn(this.paramOf(ev.action, ev.payload.settings), ev.payload.ticks);
	}

	/**
	 * Gesperrt (Wert unbekannt, keine Verbindung, bit5/bit6): Warnzeichen wie bei den
	 * Tasten. Im Tuner-Modus einfach nichts — die Leiste zeigt dort keinen Regler.
	 */
	override onDialDown(ev: DialDownEvent<KnobSettings>): void {
		if (this.session.tunerActive()) return;
		if (!this.session.center(this.paramOf(ev.action, ev.payload.settings))) void ev.action.showAlert();
	}

	private paramOf(dial: DialAction<KnobSettings>, settings: KnobSettings): number {
		return this.entries.get(dial.id)?.p ?? paramIndexFor(settings.param, dial.coordinates?.column);
	}

	private paint(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		let image: string;
		try {
			if (this.session.tunerActive()) {
				const tuner = this.session.tuner();
				image = renderTunerSegment(tunerSegmentFor(entry.p), tuner.reading, tuner.status);
			} else {
				const view = this.session.knob(entry.p);
				image = renderDial(PARAM_NAMES[entry.p], view.value01, view.status);
			}
		} catch (e) {
			streamDeck.logger.error(`Regler zeichnen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.images.update(id, image, (img) => entry.dial.setFeedback({ canvas: img }));
	}
}
