/**
 * Erzeugt alle festen Bilder des Plugins unter com.sorg.tone3000.sdPlugin/imgs mit resvg:
 *
 *   plugin/marketplace.png         256x256  (+ @2x 512)  E-Gitarre auf Tolex, goldene Kante
 *   plugin/category-icon.png        28x28   (+ @2x 56)   Gitarren-Silhouette, weiß auf transparent
 *   actions/<aktion>/icon.png       20x20   (+ @2x 40)   Symbol der Aktionsliste, weiß auf transparent
 *   actions/<aktion>/key.png        72x72   (+ @2x 144)  Standard-Tastenbild im Marshall-Stil
 *   actions/knob/encoder.png        72x72   (+ @2x 144)  Knopf für den runden Platz des Reglers in der App
 *
 * Die Maße sind die des Manifest-Schemas von Elgato (@elgato/schemas, imageDimensions);
 * test/manifest.test.cjs prüft sie.
 *
 * Aktionen: knob, preset, amp, tuner, delay. Die Tastenbilder kommen aus demselben
 * Renderer wie zur Laufzeit (src/render, gebaut nach test-output/render-build), sehen
 * also genau so aus wie die Tasten auf dem Deck; die 72er-Fassung ist das 144er-Bild
 * verkleinert.
 *
 * Die Gitarre ist eine eigene Zeichnung (Single-Cut im Goldtop-Stil: goldener Korpus mit
 * cremefarbenem Binding, Palisanderhals, zwei Humbucker, Open-Book-Kopf mit 3+3
 * Mechaniken). Größe und Lage ergeben sich aus ihrem gemessenen Umriss.
 *
 * Aufruf: node scripts/make-icons.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(root, "com.sorg.tone3000.sdPlugin");
const imgs = join(pluginDir, "imgs");

const require = createRequire(import.meta.url);
const { ensureBuilt, outDir } = require("../test/render-build.cjs");
ensureBuilt();
const render = require(join(outDir, "render", "index.js"));
const keys = require(join(outDir, "render", "keys.js"));
const engine = require(join(outDir, "render", "engine.js"));
const tolex = require(join(outDir, "render", "tolex.js"));
const style = require(join(outDir, "render", "style.js"));
const knobArt = require(join(outDir, "render", "knob.js"));

render.initRenderer(pluginDir);
if (engine.engineProblem()) throw new Error(`Renderer nicht bereit: ${engine.engineProblem()}`);
const { Resvg } = createRequire(join(pluginDir, "package.json"))("@resvg/resvg-js");

const WHITE = "#ffffff";

// --- Gitarre --------------------------------------------------------------------
// Hals nach oben, Cutaway links; Ursprung Mitte Hals/Korpus, Einheiten ≈ mm/2.

const BODY =
	"M -9 96 C -12 84 -20 70 -31 70 C -41 70 -47 80 -49 92 " +
	"C -51 106 -46 120 -48 134 C -50 148 -65 158 -65 182 " +
	"C -65 208 -35 224 0 224 C 35 224 65 208 65 182 " +
	"C 65 158 50 148 48 134 C 46 120 52 104 52 90 " +
	"C 52 70 32 56 9 57 L -9 60 Z";
const HEAD = "M -9 -78 L -16 -118 C -18 -128 -14 -136 -6 -134 L 0 -130 L 6 -134 C 14 -136 18 -128 16 -118 L 9 -78 Z";
const NUT_Y = -80;
const PICKUPS = [128, 162];

/** Umriss als eine Fläche (für Schatten, Silhouette und Messung). */
function guitarOutline(neckWidth = 16) {
	const hw = neckWidth / 2;
	return `<path d="${BODY}"/><rect x="${-hw}" y="${NUT_Y - 2}" width="${neckWidth}" height="170"/><path d="${HEAD}"/>`;
}

function guitarDefs() {
	return (
		`<linearGradient id="gb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3c8"/><stop offset=".45" stop-color="#e9c96a"/><stop offset="1" stop-color="#9a7320"/></linearGradient>` +
		`<linearGradient id="gn" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2a170c"/><stop offset=".5" stop-color="#4d2d18"/><stop offset="1" stop-color="#2a170c"/></linearGradient>` +
		style.verticalGradient("gg", style.GOLD_STOPS) +
		`<radialGradient id="gk" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#fff8d2"/><stop offset=".55" stop-color="#efd98a"/><stop offset="1" stop-color="#c39c3c"/></radialGradient>`
	);
}

/** Die ausgearbeitete Gitarre in Farbe. */
function guitarDetailed() {
	const ink = "#0a0806";
	let s = "";
	// Korpus mit Binding
	s += `<path d="${BODY}" fill="url(#gb)" stroke="${ink}" stroke-width="2.6"/>`;
	s += `<path d="${BODY}" fill="none" stroke="#f8f0d6" stroke-width="1.6" transform="translate(0 141) scale(.955) translate(0 -141)"/>`;
	// Hals mit Bünden und Einlagen
	s += `<rect x="-8" y="${NUT_Y}" width="16" height="190" rx="2" fill="url(#gn)" stroke="${ink}" stroke-width="1.2"/>`;
	s += `<rect x="-8" y="${NUT_Y}" width="16" height="190" rx="2" fill="none" stroke="#f4eacb" stroke-width=".8" stroke-opacity=".7"/>`;
	const scale = 330;
	const frets = [];
	for (let i = 1; i <= 22; i++) frets.push(NUT_Y + scale - scale / 2 ** (i / 12));
	for (const f of frets.filter((f) => f < 108)) {
		s += `<line x1="-7.6" y1="${f.toFixed(1)}" x2="7.6" y2="${f.toFixed(1)}" stroke="#e2cf8e" stroke-width="1"/>`;
	}
	const fp = [NUT_Y, ...frets];
	for (const k of [3, 5, 7, 9, 12]) {
		const y = (fp[k - 1] + fp[k]) / 2;
		s += `<rect x="-4.5" y="${(y - 1.6).toFixed(1)}" width="9" height="3.2" fill="#f4eacb"/>`;
	}
	// Kopf mit 3+3 Mechaniken und Sattel
	s += `<path d="${HEAD}" fill="#141210" stroke="#d8bd6a" stroke-width="1.6"/>`;
	for (const [ty, dx] of [[-92, 0], [-106, 1.6], [-120, 3.2]]) {
		s += `<rect x="${-25 - dx}" y="${ty - 3}" width="10" height="6" rx="3" fill="url(#gk)" stroke="${ink}" stroke-width=".8"/>`;
		s += `<rect x="${15 + dx}" y="${ty - 3}" width="10" height="6" rx="3" fill="url(#gk)" stroke="${ink}" stroke-width=".8"/>`;
		s += `<circle cx="${-8 - dx / 2}" cy="${ty}" r="1.7" fill="#f0d77c"/><circle cx="${8 + dx / 2}" cy="${ty}" r="1.7" fill="#f0d77c"/>`;
	}
	s += `<rect x="-8.5" y="${NUT_Y - 1.5}" width="17" height="3.5" fill="#f4eacb"/>`;
	// Zwei Humbucker in cremefarbenen Rahmen
	for (const py of PICKUPS) {
		s += `<rect x="-19" y="${py - 9}" width="38" height="18" rx="3" fill="#f1e6c2" stroke="${ink}" stroke-width=".8"/>`;
		s += `<rect x="-16" y="${py - 7}" width="32" height="14" rx="2" fill="#0f0e0d"/>`;
		for (let i = 0; i < 6; i++) s += `<circle cx="${(-11.5 + i * 4.6).toFixed(1)}" cy="${py - 3}" r="1.2" fill="#d8bd6a"/>`;
		for (let i = 0; i < 6; i++) s += `<circle cx="${(-11.5 + i * 4.6).toFixed(1)}" cy="${py + 3}" r="1.2" fill="#8a7440"/>`;
	}
	// Steg, Saitenhalter, vier Regler, Schalter
	s += `<rect x="-15" y="176" width="30" height="5" rx="2" fill="url(#gg)" stroke="${ink}" stroke-width=".8"/>`;
	s += `<rect x="-18" y="190" width="36" height="7" rx="3.5" fill="url(#gg)" stroke="${ink}" stroke-width=".8"/>`;
	for (const [kx, ky] of [[30, 172], [44, 186], [24, 196], [38, 208]]) {
		s += `<circle cx="${kx}" cy="${ky}" r="6" fill="url(#gk)" stroke="${ink}" stroke-width=".9"/>`;
		s += `<circle cx="${kx}" cy="${ky}" r="2" fill="none" stroke="#7a5d1c" stroke-width=".7"/>`;
	}
	s += `<circle cx="-36" cy="82" r="4" fill="#141210" stroke="#d8bd6a" stroke-width="1"/><circle cx="-36" cy="82" r="1.8" fill="#f4eacb"/>`;
	// Saiten
	for (let i = 0; i < 6; i++) {
		const xn = -5.5 + i * 2.2;
		const xb = -11.5 + i * 4.6;
		s += `<line x1="${xn.toFixed(1)}" y1="${NUT_Y + 1}" x2="${xb.toFixed(1)}" y2="193" stroke="#f7f1de" stroke-opacity=".85" stroke-width=".7"/>`;
	}
	return s;
}

const ROTATION = 40; // Kopf nach rechts oben

/**
 * Transform, der die gedrehte Gitarre mittig in ein Quadrat der Kantenlänge size
 * mit Rand margin setzt — aus dem von resvg gemessenen Umriss.
 */
function fitGuitar(size, margin, neckWidth) {
	const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><g transform="translate(500 500) rotate(${ROTATION})">${guitarOutline(neckWidth)}</g></svg>`;
	const box = new Resvg(probe).getBBox();
	const scale = (size - 2 * margin) / Math.max(box.width, box.height);
	const cx = box.x + box.width / 2 - 500;
	const cy = box.y + box.height / 2 - 500;
	return `translate(${size / 2 - cx * scale} ${size / 2 - cy * scale}) scale(${scale}) rotate(${ROTATION})`;
}

// --- Bilder --------------------------------------------------------------------

function svgDoc(viewSize, pixelSize, body) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${viewSize} ${viewSize}">${body}</svg>`;
}

function write(rel, png) {
	const file = join(imgs, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, png);
	const w = png.readUInt32BE(16);
	const h = png.readUInt32BE(20);
	console.log(`${rel.padEnd(32)} ${w}x${h}  ${png.length} Bytes`);
	return file;
}

/** Marktplatz-Symbol: Tolex, goldene Kante, Gitarre mit weichem Schatten. */
function marketplace() {
	const S = 288;
	const fit = fitGuitar(S, 34, 16);
	const body =
		`<defs>${tolex.tolexDefs()}${style.verticalGradient("kg", style.GOLD_STOPS)}${guitarDefs()}` +
		`<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>` +
		`<clipPath id="round"><rect width="${S}" height="${S}" rx="44"/></clipPath></defs>` +
		`<g clip-path="url(#round)">${tolex.tolexRect(0, 0, S, S, true)}</g>` +
		`<rect x="5" y="5" width="${S - 10}" height="${S - 10}" rx="40" fill="none" stroke="url(#kg)" stroke-width="10"/>` +
		`<rect x="10.5" y="10.5" width="${S - 21}" height="${S - 21}" rx="35" fill="none" stroke="#000" stroke-opacity=".5"/>` +
		`<g transform="translate(5 7)" opacity=".6" filter="url(#sh)"><g transform="${fit}" fill="#000">${guitarOutline()}</g></g>` +
		`<g transform="${fit}">${guitarDetailed()}</g>`;
	// Gezeichnet auf 288er Raster, ausgegeben in den Maßen des Schemas (256, @2x 512).
	write("plugin/marketplace.png", engine.renderPng(svgDoc(S, 256, body)));
	write("plugin/marketplace@2x.png", engine.renderPng(svgDoc(S, 512, body)));
}

/** Kategorie: Silhouette, weiß auf transparent; die Tonabnehmer ausgespart. */
function category() {
	const V = 56;
	const fit = fitGuitar(V, 1.5, 26);
	const holes = PICKUPS.map((py) => `<rect x="-17" y="${py - 8}" width="34" height="16" rx="3"/>`).join("");
	const body =
		`<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${V}" height="${V}">` +
		`<g transform="${fit}"><g fill="#fff">${guitarOutline(26)}</g><g fill="#000">${holes}</g></g></mask></defs>` +
		`<rect width="${V}" height="${V}" fill="${WHITE}" mask="url(#m)"/>`;
	write("plugin/category-icon.png", engine.renderPng(svgDoc(V, 28, body)));
	write("plugin/category-icon@2x.png", engine.renderPng(svgDoc(V, 56, body)));
}

/** Symbole der Aktionsliste, gezeichnet auf 40x40, weiß auf transparent. */
const ACTION_ICONS = {
	// Drehknopf: Ring, Zeiger, Anschläge bei 0 und 10
	knob: () => {
		const a = (deg) => [20 + 17.5 * Math.sin((deg * Math.PI) / 180), 21 - 17.5 * Math.cos((deg * Math.PI) / 180)];
		const [x0, y0] = a(-135);
		const [x1, y1] = a(135);
		const tip = [20 + 9 * Math.sin(Math.PI / 4), 21 - 9 * Math.cos(Math.PI / 4)];
		return (
			`<circle cx="20" cy="21" r="12" fill="none" stroke="${WHITE}" stroke-width="3.2"/>` +
			`<line x1="20" y1="21" x2="${tip[0].toFixed(2)}" y2="${tip[1].toFixed(2)}" stroke="${WHITE}" stroke-width="3.4" stroke-linecap="round"/>` +
			`<circle cx="${x0.toFixed(2)}" cy="${y0.toFixed(2)}" r="2" fill="${WHITE}"/><circle cx="${x1.toFixed(2)}" cy="${y1.toFixed(2)}" r="2" fill="${WHITE}"/>`
		);
	},
	// Preset-Liste: drei Zeilen, die oberste gewählt
	preset: () =>
		[8, 20, 32]
			.map(
				(y, i) =>
					`<circle cx="7" cy="${y}" r="${i === 0 ? 3.4 : 2.6}" fill="${WHITE}"/>` +
					`<rect x="14" y="${y - (i === 0 ? 3 : 2)}" width="${i === 0 ? 22 : 20}" height="${i === 0 ? 6 : 4}" rx="2" fill="${WHITE}" fill-opacity="${i === 0 ? 1 : 0.7}"/>`,
			)
			.join(""),
	// Amp-Topteil: Griff, Bedienfeld mit Knöpfen, Bespannung
	amp: () =>
		`<path d="M14 11 V7.5 H26 V11" fill="none" stroke="${WHITE}" stroke-width="2.6" stroke-linejoin="round"/>` +
		`<rect x="4.5" y="11" width="31" height="23" rx="3" fill="none" stroke="${WHITE}" stroke-width="2.6"/>` +
		[11, 17, 23, 29].map((x) => `<circle cx="${x}" cy="16.5" r="1.7" fill="${WHITE}"/>`).join("") +
		`<rect x="8" y="21" width="24" height="10" rx="1" fill="${WHITE}" fill-opacity=".55"/>`,
	// Stimmgabel
	tuner: () =>
		`<path d="M14 4 V19 A6 6 0 0 0 26 19 V4" fill="none" stroke="${WHITE}" stroke-width="3.2" stroke-linecap="round"/>` +
		`<line x1="20" y1="25" x2="20" y2="35" stroke="${WHITE}" stroke-width="3.6" stroke-linecap="round"/>`,
	// Echo: ein Schlag und zwei leiser werdende Wiederholungen
	delay: () =>
		`<circle cx="8" cy="20" r="6.5" fill="${WHITE}"/>` +
		`<circle cx="21.5" cy="20" r="5" fill="${WHITE}" fill-opacity=".65"/>` +
		`<circle cx="32.5" cy="20" r="3.8" fill="${WHITE}" fill-opacity=".38"/>`,
};

function actionIcons() {
	for (const [name, draw] of Object.entries(ACTION_ICONS)) {
		const body = draw();
		write(`actions/${name}/icon.png`, engine.renderPng(svgDoc(40, 20, body)));
		write(`actions/${name}/icon@2x.png`, engine.renderPng(svgDoc(40, 40, body)));
	}
}

/** 144er-PNG verkleinert auf size (resvg skaliert das eingebettete Bild). */
function downscale(png, size) {
	const href = `data:image/png;base64,${png.toString("base64")}`;
	return engine.renderPng(svgDoc(144, size, `<image href="${href}" x="0" y="0" width="144" height="144"/>`));
}

/** Tastenbild als key@2x.png (144, aus dem Renderer) und key.png (72). */
function writeKey(rel, url) {
	if (!url.startsWith("data:image/png;base64,")) throw new Error(`${rel}: Renderer lieferte kein PNG`);
	const png = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
	write(`${rel}/key@2x.png`, png);
	write(`${rel}/key.png`, downscale(png, 72));
}

function keyImages() {
	const ok = { kind: "ok" };
	writeKey("actions/knob", keys.renderKnobKey());
	writeKey("actions/preset", render.renderPresetKey("Preset", false, ok));
	for (const kind of ["amp", "tuner", "delay"]) {
		writeKey(`actions/${kind}`, render.renderToggleKey(kind, false, ok));
	}
}

/**
 * Bild des Reglers in der App (Encoder.Icon): der Knopf allein auf transparentem
 * Grund — die App legt ihn in einen runden Platz.
 */
function encoderIcon() {
	const body = `<defs>${knobArt.knobDefs()}</defs>` + knobArt.knob(70, 70, 60, 0.7, false);
	write("actions/knob/encoder.png", engine.renderPng(svgDoc(144, 72, body)));
	write("actions/knob/encoder@2x.png", engine.renderPng(svgDoc(144, 144, body)));
}

marketplace();
category();
actionIcons();
keyImages();
encoderIcon();
