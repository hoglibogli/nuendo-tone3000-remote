/**
 * Marshall-„Jewel": die runde, facettierte Kontrolllampe im Chromring.
 *
 * Aufbau von außen nach innen: (an: Lichthof) – Chromring mit Rändelung – dunkler
 * Sitz – Glaskörper mit Farbverlauf – zehn Facetten im Kranz und eine Tafel in der
 * Mitte – Glanzlicht. Aus ist es dasselbe Glas, nur dunkel; das Glanzlicht bleibt,
 * damit man die Lampe auch aus als Lampe erkennt.
 */
import { n } from "./style";

/** amp/tuner/delay: die Schalter-Tasten; green: „gestimmt" in der Stimmanzeige. */
export type LampColor = "amp" | "tuner" | "delay" | "green";

type Palette = { core: string; mid: string; rim: string; offMid: string; offRim: string; glow: string };

const PALETTES: Record<LampColor, Palette> = {
	// Creme/Gold wie die Kappen der Knöpfe
	amp: { core: "#fffdf2", mid: "#f4dc88", rim: "#a07a22", offMid: "#4b4333", offRim: "#191610", glow: "#f8e6a4" },
	// Rot wie die Netzlampe am Amp
	tuner: { core: "#fff0e4", mid: "#ff3a22", rim: "#8c0c05", offMid: "#521411", offRim: "#1b0504", glow: "#ff4a2a" },
	// Bernstein
	delay: { core: "#fff8dc", mid: "#ffa414", rim: "#9a4c00", offMid: "#553308", offRim: "#1d1203", glow: "#ffae22" },
	// Grün: gestimmt
	green: { core: "#f2fff0", mid: "#3fdc5a", rim: "#0b6a1e", offMid: "#1d4424", offRim: "#06150a", glow: "#5cff7a" },
};

const FACETS = 10;

/**
 * Lampe um (cx, cy) mit Außenradius r (Chromring). prefix hält die Verlaufs-IDs
 * eindeutig, falls mehrere Lampen in einem Bild stehen.
 */
export function jewelLamp(cx: number, cy: number, r: number, color: LampColor, on: boolean, prefix = "lp"): string {
	const p = PALETTES[color];
	const rj = r * 0.76; // Glaskörper
	const inner = rj * 0.46; // Facettenkranz innen
	const ids = { halo: `${prefix}h`, chrome: `${prefix}c`, glass: `${prefix}g`, shine: `${prefix}s` };

	let defs =
		`<linearGradient id="${ids.chrome}" x1="0" y1="0" x2="1" y2="1">` +
		`<stop offset="0" stop-color="#fbfbfb"/><stop offset=".42" stop-color="#9c9c9c"/>` +
		`<stop offset=".62" stop-color="#e8e8e8"/><stop offset="1" stop-color="#5e5e5e"/></linearGradient>` +
		`<radialGradient id="${ids.glass}" cx=".45" cy=".42" r=".62">` +
		(on
			? `<stop offset="0" stop-color="${p.core}"/><stop offset=".38" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.rim}"/>`
			: `<stop offset="0" stop-color="${p.offMid}"/><stop offset="1" stop-color="${p.offRim}"/>`) +
		`</radialGradient>` +
		`<radialGradient id="${ids.shine}" cx=".5" cy=".5" r=".5">` +
		`<stop offset="0" stop-color="#fff" stop-opacity="${on ? ".85" : ".5"}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>` +
		`</radialGradient>`;
	if (on) {
		defs +=
			`<radialGradient id="${ids.halo}" cx=".5" cy=".5" r=".5">` +
			`<stop offset=".35" stop-color="${p.glow}" stop-opacity=".75"/>` +
			`<stop offset=".6" stop-color="${p.glow}" stop-opacity=".28"/>` +
			`<stop offset="1" stop-color="${p.glow}" stop-opacity="0"/></radialGradient>`;
	}

	let s = `<defs>${defs}</defs>`;
	if (on) s += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 1.75)}" fill="url(#${ids.halo})"/>`;
	// Schatten, Chromring, Rändelung, Sitz
	s +=
		// fill-opacity statt opacity: Gruppen-Deckkraft legt in resvg eine eigene Ebene an,
		// und eine solche Ebene ganz außerhalb der Bildfläche bringt resvg 2.6 zum Absturz
		// (panic in geom.rs) — das Leisten-Segment zeichnet Lampen außerhalb seines Ausschnitts.
		`<circle cx="${n(cx + 2)}" cy="${n(cy + 3)}" r="${n(r)}" fill="#000" fill-opacity=".5"/>` +
		`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="url(#${ids.chrome})" stroke="#0b0b0b" stroke-width="1.2"/>` +
		`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r - 2)}" fill="none" stroke="#3c3c3c" stroke-opacity=".55" stroke-width="1.6" stroke-dasharray="1.2 1.6"/>` +
		`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rj + 1.8)}" fill="#0c0c0c"/>` +
		`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rj)}" fill="url(#${ids.glass})"/>`;

	// Facetten: Kranz aus Dreiecken zwischen Außenkreis und innerem Zehneck,
	// abwechselnd aufgehellt und abgedunkelt — so bricht das Glas das Licht.
	const outer: [number, number][] = [];
	const ring: [number, number][] = [];
	for (let k = 0; k < FACETS; k++) {
		const a = ((k * 360) / FACETS - 90) * (Math.PI / 180);
		const b = (((k + 0.5) * 360) / FACETS - 90) * (Math.PI / 180);
		outer.push([cx + rj * 0.97 * Math.cos(a), cy + rj * 0.97 * Math.sin(a)]);
		ring.push([cx + inner * Math.cos(b), cy + inner * Math.sin(b)]);
	}
	const pt = (q: [number, number]): string => `${n(q[0])},${n(q[1])}`;
	const light = on ? ".2" : ".09";
	const dark = on ? ".16" : ".22";
	for (let k = 0; k < FACETS; k++) {
		const o1 = outer[k];
		const o2 = outer[(k + 1) % FACETS];
		const r1 = ring[k];
		const r0 = ring[(k + FACETS - 1) % FACETS];
		s += `<polygon points="${pt(o1)} ${pt(o2)} ${pt(r1)}" fill="#fff" fill-opacity="${light}"/>`;
		s += `<polygon points="${pt(r0)} ${pt(o1)} ${pt(r1)}" fill="#000" fill-opacity="${dark}"/>`;
	}
	s += `<polygon points="${ring.map(pt).join(" ")}" fill="#fff" fill-opacity="${on ? ".22" : ".06"}" stroke="#000" stroke-opacity=".18" stroke-width=".6"/>`;
	// Glanzlicht oben links
	s += `<ellipse cx="${n(cx - rj * 0.34)}" cy="${n(cy - rj * 0.4)}" rx="${n(rj * 0.36)}" ry="${n(rj * 0.2)}" fill="url(#${ids.shine})" transform="rotate(-35 ${n(cx - rj * 0.34)} ${n(cy - rj * 0.4)})"/>`;
	return s;
}
