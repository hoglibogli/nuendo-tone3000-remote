/**
 * Farben und Verläufe des Marshall-Looks, einmal festgelegt für Leiste, Tasten
 * und Symbole. Vorbild ist der freigegebene Entwurf „A mit Yellowtail":
 * schwarzes Tolex, goldene Kante, cremefarbene Schreibschrift.
 */

/** Grundfarbe unter der Tolex-Struktur (der Filter hellt sie zur Narbung auf). */
export const TOLEX_BASE = "#2e2e33";
/** Ersatzfarbe ohne Filter (SVG-Rückfall): etwa die mittlere Helligkeit mit Struktur. */
export const TOLEX_FLAT = "#1f1f22";

/** Beschriftung in Yellowtail. */
export const CREAM = "#f4eacb";
/** Werte in Georgia. */
export const VALUE_GOLD = "#d9c98f";
/** „Warte…" — dieselbe Familie, deutlich zurückgenommen. */
export const WAIT_TEXT = "#a3977a";
/** Fehlertext: ziegelrot, auf Tolex gut lesbar, ohne zu schreien. */
export const ERROR_TEXT = "#ec977c";

/** Goldene Kante, senkrechter Verlauf wie im Entwurf. */
export const GOLD_STOPS: readonly [number, string][] = [
	[0, "#fbeaa6"],
	[0.5, "#b8902e"],
	[1, "#f0d77c"],
];
/** Heller, leuchtender Rahmen: eingeschaltete Taste. */
export const GOLD_BRIGHT_STOPS: readonly [number, string][] = [
	[0, "#fffbe2"],
	[0.5, "#e6c25a"],
	[1, "#fff2b8"],
];
/** Breiter Rahmen des gewählten Presets: noch heller, fast weißgolden. */
export const GOLD_ACTIVE_STOPS: readonly [number, string][] = [
	[0, "#fffef4"],
	[0.45, "#f7dc84"],
	[0.6, "#e9c560"],
	[1, "#fff6cc"],
];

/** Roter Rahmen der Tuner-Taste: automatische Stummschaltung eingeschaltet. */
export const RED_STOPS: readonly [number, string][] = [
	[0, "#ff9f8f"],
	[0.5, "#b3221a"],
	[1, "#ea6552"],
];
/** Dasselbe hell leuchtend: Tuner-Modus an und Stummschaltung eingeschaltet. */
export const RED_BRIGHT_STOPS: readonly [number, string][] = [
	[0, "#ff9c8c"],
	[0.5, "#e3261a"],
	[1, "#ff5f4a"],
];

/** Linearer Verlauf von oben nach unten. */
export function verticalGradient(id: string, stops: readonly [number, string][]): string {
	const s = stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("");
	return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${s}</linearGradient>`;
}

/** Zahlen kurz halten, das SVG wird bei jedem Drehen neu gebaut. */
export function n(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}
