/**
 * Goldene Kante: 5 px Goldverlauf mit dunkler Innenlinie, wie im Entwurf.
 *
 * Leiste: Die Kante gehört zur ganzen 800x100-Leiste, nicht zum Segment. Jedes
 * Segment zeichnet denselben umlaufenden Rahmen und sieht davon nur seinen
 * Ausschnitt — Gain bekommt so die linke Kante mit den Ecken, Treble die rechte,
 * Bass und Mid nur oben und unten. Nebeneinander ergibt das den einen Rahmen.
 *
 * Tasten: dieselbe Kante innen um die Taste; „hell" für eingeschaltete Tasten,
 * „aktiv" als breiter, heller Rahmen für das gewählte Preset.
 */
import { GOLD_ACTIVE_STOPS, GOLD_BRIGHT_STOPS, GOLD_STOPS, verticalGradient } from "./style";

export const STRIP_WIDTH = 800;
export const STRIP_HEIGHT = 100;

const STRIP_GRADIENT = "gp";

export function stripEdgeDefs(): string {
	return verticalGradient(STRIP_GRADIENT, GOLD_STOPS);
}

/** Der umlaufende Rahmen der ganzen Leiste in Leistenkoordinaten. */
export function stripEdge(): string {
	return (
		`<rect x="2.5" y="2.5" width="${STRIP_WIDTH - 5}" height="${STRIP_HEIGHT - 5}" rx="9" fill="none" stroke="url(#${STRIP_GRADIENT})" stroke-width="5"/>` +
		`<rect x="5.5" y="5.5" width="${STRIP_WIDTH - 11}" height="${STRIP_HEIGHT - 11}" rx="7" fill="none" stroke="#000" stroke-opacity=".5"/>`
	);
}

export type KeyEdge = "plain" | "bright" | "active";

/** Wie weit der Rahmen innen reicht — Inhalte halten mindestens diesen Abstand. */
export const KEY_EDGE_INSET: Record<KeyEdge, number> = { plain: 7, bright: 9, active: 15 };

/** Rahmen einer 144er-Taste samt eigener Verläufe. */
export function keyEdge(style: KeyEdge, size = 144): string {
	if (style === "plain") {
		return (
			`<defs>${verticalGradient("kgp", GOLD_STOPS)}</defs>` +
			`<rect x="2.5" y="2.5" width="${size - 5}" height="${size - 5}" rx="14" fill="none" stroke="url(#kgp)" stroke-width="5"/>` +
			`<rect x="5.5" y="5.5" width="${size - 11}" height="${size - 11}" rx="11.5" fill="none" stroke="#000" stroke-opacity=".5"/>`
		);
	}
	if (style === "bright") {
		return (
			`<defs>${verticalGradient("kgb", GOLD_BRIGHT_STOPS)}</defs>` +
			`<rect x="3" y="3" width="${size - 6}" height="${size - 6}" rx="14" fill="none" stroke="url(#kgb)" stroke-width="6"/>` +
			`<rect x="6.5" y="6.5" width="${size - 13}" height="${size - 13}" rx="11" fill="none" stroke="#000" stroke-opacity=".45"/>` +
			`<rect x="8.5" y="8.5" width="${size - 17}" height="${size - 17}" rx="9.5" fill="none" stroke="#fbeaa6" stroke-opacity=".28" stroke-width="2"/>`
		);
	}
	// Gewähltes Preset: 11 px breites, helles Gold, außen und innen dunkel abgesetzt,
	// dazu ein schwacher Lichtsaum nach innen — auf einen Blick vom 5-px-Rahmen der
	// übrigen Presets zu unterscheiden.
	return (
		`<defs>${verticalGradient("kga", GOLD_ACTIVE_STOPS)}</defs>` +
		`<rect x="7" y="7" width="${size - 14}" height="${size - 14}" rx="12" fill="none" stroke="url(#kga)" stroke-width="11"/>` +
		`<rect x="1.5" y="1.5" width="${size - 3}" height="${size - 3}" rx="16" fill="none" stroke="#000" stroke-opacity=".55"/>` +
		`<rect x="12.5" y="12.5" width="${size - 25}" height="${size - 25}" rx="7" fill="none" stroke="#000" stroke-opacity=".6"/>` +
		`<rect x="14.5" y="14.5" width="${size - 29}" height="${size - 29}" rx="6" fill="none" stroke="#fbeaa6" stroke-opacity=".3" stroke-width="2"/>`
	);
}
