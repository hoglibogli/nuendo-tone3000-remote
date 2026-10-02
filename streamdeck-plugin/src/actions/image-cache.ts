import streamDeck from "@elgato/streamdeck";

/**
 * Zuletzt gesetztes Bild je Kontext. Ein Bild geht nur hinaus, wenn es sich vom
 * angezeigten unterscheidet — die Grafik liefert für denselben Zustand dieselbe
 * Zeichenkette, der Vergleich ist also fast immer ein Referenzvergleich.
 *
 * Schlägt das Setzen fehl, wird der Eintrag vergessen, damit der nächste Anlass
 * es erneut versucht.
 */
export class ImageCache {
	private readonly shown = new Map<string, string>();

	forget(id: string): void {
		this.shown.delete(id);
	}

	/** `apply` setzt das Bild (setImage oder setFeedback); nur bei einer Änderung aufgerufen. */
	update(id: string, image: string, apply: (image: string) => Promise<void>): void {
		if (this.shown.get(id) === image) return;
		this.shown.set(id, image);
		apply(image).catch((err: unknown) => {
			if (this.shown.get(id) === image) this.shown.delete(id);
			streamDeck.logger.error(`Bild setzen fehlgeschlagen (${id}): ${String(err)}`);
		});
	}
}
