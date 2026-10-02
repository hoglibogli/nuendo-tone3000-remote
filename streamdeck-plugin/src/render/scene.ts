/**
 * Ein Bild = Hintergrund + Vordergrund.
 *
 * Der Hintergrund (Tolex mit Filter, Kante, feste Beschriftung) ist teuer und
 * ändert sich nie; er wird je Schlüssel EINMAL gerendert und als PNG gemerkt. Jedes
 * weitere Bild legt ihn per <image href="data:image/png;base64,…"> unter den
 * Vordergrund (Knopf, Wert, Lampe, Name) — resvg dekodiert das in Bruchteilen einer
 * Millisekunde, der Filter läuft nicht noch einmal.
 *
 * Schriften: Hintergrund und Vordergrund rendern mit dem Schriftsatz `fonts`
 * (engine.ts); die Stimmanzeige braucht "clear" für Segoe UI, alles andere "base".
 *
 * Ohne resvg (Modul fehlt) entsteht dasselbe Bild als SVG-Data-URL mit flachem
 * Hintergrund; Stream Deck zeichnet es selbst.
 */
import { engineReady, pngDataUrl, renderPng, svgDataUrl, type FontSet } from "./engine";

export type Background = {
	/** Eindeutig je Aussehen, z. B. "dial:bass" oder "key". */
	key: string;
	/** Markup des Hintergrunds; filtered = false für den SVG-Rückfall. */
	markup: (filtered: boolean) => string;
	/** Schriftsatz für Hintergrund und Vordergrund; Vorgabe "base". */
	fonts?: FontSet;
};

const backgrounds = new Map<string, string>();

export function svgDoc(width: number, height: number, body: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function tryRender(svg: string, fonts: FontSet): Buffer | null {
	try {
		return renderPng(svg, fonts);
	} catch {
		return null; // kaputtes SVG: Rückfall statt Absturz
	}
}

/** Hintergrund als PNG-Data-URL, gerendert beim ersten Bedarf. */
export function backgroundPng(width: number, height: number, bg: Background): string | null {
	const known = backgrounds.get(bg.key);
	if (known) return known;
	const png = tryRender(svgDoc(width, height, bg.markup(true)), bg.fonts ?? "base");
	if (!png) return null;
	const url = pngDataUrl(png);
	backgrounds.set(bg.key, url);
	return url;
}

/** Fertiges Bild als data:image/png;base64 (oder SVG-Rückfall). */
export function compose(width: number, height: number, bg: Background, foreground: string): string {
	if (engineReady()) {
		const under = backgroundPng(width, height, bg);
		if (under) {
			const png = tryRender(
				svgDoc(width, height, `<image href="${under}" x="0" y="0" width="${width}" height="${height}"/>${foreground}`),
				bg.fonts ?? "base",
			);
			if (png) return pngDataUrl(png);
		}
	}
	return svgDataUrl(svgDoc(width, height, bg.markup(false) + foreground));
}

export function clearBackgrounds(): void {
	backgrounds.clear();
}
