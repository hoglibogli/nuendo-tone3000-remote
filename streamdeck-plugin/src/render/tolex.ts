/**
 * Tolex: das genarbte Kunstleder der Marshall-Gehäuse.
 *
 * Fraktales Rauschen (feTurbulence) als Höhenfeld, seitlich beleuchtet
 * (feDiffuseLighting) und mit der dunklen Grundfarbe multipliziert — genau der
 * Filter des Entwurfs. Er ist das Teure am Bild (einige Millisekunden je
 * Fläche); deshalb rendert der Renderer ihn nur in die zwischengespeicherten
 * Hintergründe, nie in ein Bild beim Drehen.
 *
 * Das Rauschen hängt an den Nutzerkoordinaten, nicht an der Fläche: Rendert man
 * die vier Regler-Segmente jeweils mit ihrem Versatz (x = 0, 200, 400, 600), geht
 * die Narbung über die Segmentgrenzen nahtlos weiter, wie auf einer Leiste.
 */
import { TOLEX_BASE, TOLEX_FLAT } from "./style";

export const TOLEX_FILTER_ID = "tx";

export function tolexDefs(): string {
	return (
		`<filter id="${TOLEX_FILTER_ID}" x="0" y="0" width="100%" height="100%">` +
		`<feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="3" seed="7" result="n"/>` +
		`<feDiffuseLighting in="n" lighting-color="#b4b4bc" surfaceScale="2.4" result="l">` +
		`<feDistantLight azimuth="235" elevation="52"/></feDiffuseLighting>` +
		`<feComposite in="l" in2="SourceGraphic" operator="arithmetic" k1="1.25" k2="0" k3="0" k4="0"/>` +
		`</filter>`
	);
}

/**
 * Tolex-Fläche. Ohne Filter (SVG-Rückfall, Stream Deck kann keine Filter) eine
 * flache, dunkle Fläche.
 */
export function tolexRect(x: number, y: number, w: number, h: number, filtered: boolean): string {
	if (!filtered) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${TOLEX_FLAT}"/>`;
	return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${TOLEX_BASE}" filter="url(#${TOLEX_FILTER_ID})"/>`;
}
