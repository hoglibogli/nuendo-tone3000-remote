/**
 * Der Marshall-Knopf: schwarzer, geriffelter Rand, cremegoldene Kappe, schwarzer
 * Zeigerstrich. 0 steht bei -135°, 10 bei +135° (270° Drehweg, wie am Amp).
 *
 * Geometrie und Farben 1:1 aus dem Entwurf. Der Knopf ist reine Vektorgrafik
 * ohne Filter — er wird bei jedem Drehen neu gezeichnet und kostet dabei fast
 * nichts.
 */
import { n } from "./style";

const CAP_GRADIENT = "cp";

export const KNOB_MIN_ANGLE = -135;
export const KNOB_MAX_ANGLE = 135;

export function knobDefs(): string {
	return (
		`<radialGradient id="${CAP_GRADIENT}" cx=".38" cy=".32" r=".75">` +
		`<stop offset="0" stop-color="#fff8d2"/><stop offset=".55" stop-color="#efd98a"/><stop offset="1" stop-color="#c39c3c"/>` +
		`</radialGradient>`
	);
}

/** Zeigerwinkel in Grad für einen Wert 0…1. */
export function knobAngle(value01: number): number {
	return KNOB_MIN_ANGLE + (KNOB_MAX_ANGLE - KNOB_MIN_ANGLE) * value01;
}

/**
 * Knopf um (cx, cy) mit Außenradius r. dim = abgedunkelt (Wert unbekannt):
 * eine halbdurchsichtige schwarze Scheibe über dem ganzen Knopf.
 */
export function knob(cx: number, cy: number, r: number, value01: number, dim: boolean): string {
	const angle = knobAngle(value01);
	const rc = r * 0.7; // Kappe
	const ridge = r - 2.6; // Mitte des geriffelten Rands
	const pitch = (2 * Math.PI * ridge) / 40; // 40 Rillen rundum
	let s =
		`<ellipse cx="${n(cx + 3)}" cy="${n(cy + 4)}" rx="${n(r)}" ry="${n(r)}" fill="#000" opacity=".45"/>` +
		`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="#16110c" stroke="#000"/>` +
		`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(ridge)}" fill="none" stroke="#4a3b2a" stroke-width="5" stroke-dasharray="${n(pitch * 0.45)} ${n(pitch * 0.55)}"/>` +
		`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rc + 1.6)}" fill="#a8842c"/>` +
		`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rc)}" fill="url(#${CAP_GRADIENT})"/>` +
		`<rect x="${n(cx - rc * 0.09)}" y="${n(cy - rc * 0.88)}" width="${n(rc * 0.18)}" height="${n(rc * 0.5)}" fill="#141414" transform="rotate(${n(angle)} ${n(cx)} ${n(cy)})"/>`;
	if (dim) s += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r + 1)}" fill="#000" opacity=".58"/>`;
	return s;
}
