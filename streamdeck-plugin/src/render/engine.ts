/// <reference path="../@types/resvg-js.d.ts" />
/**
 * Die Maschine unter allen Bildern: SVG rein, PNG raus, über resvg.
 *
 * resvg ist ein natives Modul und liegt nur im .sdPlugin-Ordner (neben
 * bin/plugin.js). Geladen wird es erst in initEngine, ausdrücklich von dort aus
 * (createRequire auf den Ordner) — so findet es der gebündelte Code zur Laufzeit
 * genauso wie die Tests, die aus test-output/render-build laufen. Rollup sieht dadurch keinen
 * statischen Import; "@resvg/resvg-js" in external zu führen schadet trotzdem nicht.
 *
 * Schriften: Gemessen kostet `loadSystemFonts: true` rund 70 ms je Bild — das
 * Durchsuchen aller Windows-Schriften, bei jedem `new Resvg` von vorn. Deshalb lädt
 * der Renderer nur einzelne Dateien, in zwei Sätzen:
 *
 *   base   Yellowtail aus dem Plugin und Georgia aus dem System — Regler und
 *          Tasten. Ein Regler-Bild braucht damit unter 3 ms.
 *   clear  dazu Segoe UI normal und halbfett (segoeui.ttf, seguisb.ttf) für die
 *          Stimmanzeige: Note und Cent in klarer Schrift. Jede Datei kostet je Bild
 *          gut 0,2 ms, deshalb nur dort.
 *
 * Fehlt Georgia oder eine Segoe-Datei, fällt der betroffene Satz auf die
 * Systemschriften zurück (langsam, aber richtig); engineProblem() nennt es.
 *
 * Lädt resvg nicht, liefern alle Render-Funktionen SVG-Ersatzbilder ohne
 * Struktur und Schriftdatei (Stream Deck zeichnet SVG selbst), statt das Plugin
 * scheitern zu lassen. engineProblem() nennt dann den Grund.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Resvg as ResvgClass, ResvgRenderOptions } from "@resvg/resvg-js";

type ResvgModule = { Resvg: typeof ResvgClass };

/** Schriftfamilien, wie sie im SVG stehen. */
export const SCRIPT_FONT = "Yellowtail";
export const SERIF_FONT = "Georgia";
/** Klare Schrift der Stimmanzeige. Halbfett über font-weight, nicht über den Namen. */
export const CLEAR_FONT = "Segoe UI";
export const SEMIBOLD = 600;

/** Welcher Schriftsatz für ein Bild geladen wird (siehe oben). */
export type FontSet = "base" | "clear";

const YELLOWTAIL_FILE = join("fonts", "Yellowtail-Regular.ttf");

function fontsDir(): string {
	const windir = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
	return join(windir, "Fonts");
}

/** Wo Georgia liegen kann: Windows zuerst, macOS als Rückfall. */
function georgiaCandidates(): string[] {
	return [
		join(fontsDir(), "georgia.ttf"),
		"/System/Library/Fonts/Supplemental/Georgia.ttf",
		"/Library/Fonts/Georgia.ttf",
	];
}

/** Segoe UI normal und halbfett; nur unter Windows vorhanden. */
const SEGOE_FILES = ["segoeui.ttf", "seguisb.ttf"];

let resvg: ResvgModule | null = null;
const optionSets: Record<FontSet, ResvgRenderOptions> = { base: {}, clear: {} };
let problem: string | null = null;
let initializedFor: string | null = null;

/** Lädt resvg aus <pluginDir>/node_modules; null, wenn es dort nicht geht. */
function loadResvg(pluginDir: string): ResvgModule | null {
	const bases = [join(pluginDir, "package.json"), join(process.cwd(), "package.json")];
	const errors: string[] = [];
	for (const base of bases) {
		try {
			const mod = createRequire(base)("@resvg/resvg-js") as ResvgModule;
			if (typeof mod.Resvg === "function") return mod;
			errors.push(`${base}: kein Resvg-Export`);
		} catch (err) {
			errors.push(`${base}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
		}
	}
	problem = `resvg nicht geladen (${errors.join("; ")})`;
	return null;
}

function fontOptions(fontFiles: string[], loadSystemFonts: boolean): ResvgRenderOptions {
	return {
		font: {
			fontFiles,
			loadSystemFonts,
			defaultFontFamily: SERIF_FONT,
			serifFamily: SERIF_FONT,
		},
		logLevel: "off",
	};
}

/**
 * Einmal beim Start: resvg laden und die Schriften festlegen. Wirft nicht; ein
 * Fehler landet in engineProblem(). Ein zweiter Aufruf mit demselben Ordner tut
 * nichts; true heißt: neu eingerichtet, gemerkte Bilder gelten nicht mehr.
 */
export function initEngine(pluginDir: string): boolean {
	if (initializedFor === pluginDir) return false;
	initializedFor = pluginDir;
	problem = null;

	const baseFiles: string[] = [];
	const missing: string[] = [];
	const yellowtail = join(pluginDir, YELLOWTAIL_FILE);
	if (existsSync(yellowtail)) baseFiles.push(yellowtail);
	else missing.push(`Schrift fehlt: ${yellowtail}`);

	const georgia = georgiaCandidates().find((p) => existsSync(p));
	if (georgia) baseFiles.push(georgia);
	else missing.push("Georgia nicht gefunden, lade Systemschriften (langsam)");

	const segoe = SEGOE_FILES.map((f) => join(fontsDir(), f));
	const segoeFound = segoe.filter((p) => existsSync(p));
	if (segoeFound.length < segoe.length) {
		const absent = segoe.filter((p) => !segoeFound.includes(p));
		missing.push(`Segoe UI fehlt (${absent.join(", ")}), Stimmanzeige mit Systemschriften (langsam)`);
	}

	optionSets.base = fontOptions(baseFiles, !georgia);
	optionSets.clear = fontOptions([...baseFiles, ...segoeFound], !georgia || segoeFound.length < segoe.length);

	resvg = loadResvg(pluginDir);
	if (problem) missing.push(problem);
	problem = missing.length ? missing.join("; ") : null;
	measured.clear();
	return true;
}

/** Lazy-Start, falls jemand vor initRenderer zeichnet: Stream Deck startet im .sdPlugin-Ordner. */
export function ensureEngine(): void {
	if (initializedFor === null) initEngine(process.cwd());
}

export function engineReady(): boolean {
	ensureEngine();
	return resvg !== null;
}

/** Warum resvg oder eine Schrift fehlt; null, wenn alles da ist. */
export function engineProblem(): string | null {
	return problem;
}

/** SVG zu PNG mit dem gewählten Schriftsatz; null, wenn resvg nicht geladen ist. */
export function renderPng(svg: string, fonts: FontSet = "base"): Buffer | null {
	ensureEngine();
	if (!resvg) return null;
	return new resvg.Resvg(svg, optionSets[fonts]).render().asPng();
}

export function pngDataUrl(png: Buffer): string {
	return `data:image/png;base64,${png.toString("base64")}`;
}

export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * Tintenmaße eines Textes, bezogen auf Schriftgröße 1 und den Ankerpunkt
 * (x am Textanfang, y auf der Grundlinie): left/right/top/bottom.
 */
export type Ink = { left: number; right: number; top: number; bottom: number };

const measured = new Map<string, Ink>();
const REF_SIZE = 100;
const REF_X = 100;
const REF_Y = 200;

/**
 * Misst den tatsächlichen Glyphenumriss über resvg (mit Formung, Kerning und
 * Umlautpunkten). Kostet um 1 ms und wird je Text gemerkt. Ohne resvg eine
 * Schätzung aus der Zeichenzahl. weight: font-weight, etwa SEMIBOLD für die Note.
 */
export function measureInk(family: string, text: string, weight?: number): Ink {
	const key = `${family}\u0000${weight ?? ""}\u0000${text}`;
	const hit = measured.get(key);
	if (hit) return hit;

	let ink: Ink = estimateInk(family, text);
	if (text.trim() !== "" && engineReady() && resvg) {
		const w = weight !== undefined ? ` font-weight="${weight}"` : "";
		const svg =
			`<svg xmlns="http://www.w3.org/2000/svg" width="${REF_SIZE * (text.length + 4)}" height="${REF_Y * 2}">` +
			`<text x="${REF_X}" y="${REF_Y}" font-family="${family}"${w} font-size="${REF_SIZE}">${escapeXml(text)}</text></svg>`;
		try {
			const box = new resvg.Resvg(svg, optionSets[family === CLEAR_FONT ? "clear" : "base"]).getBBox();
			if (box && box.width > 0) {
				ink = {
					left: (box.x - REF_X) / REF_SIZE,
					right: (box.x + box.width - REF_X) / REF_SIZE,
					top: (box.y - REF_Y) / REF_SIZE,
					bottom: (box.y + box.height - REF_Y) / REF_SIZE,
				};
			}
		} catch {
			// Schätzung bleibt stehen
		}
	}
	if (measured.size > 2000) measured.clear();
	measured.set(key, ink);
	return ink;
}

/** Grobe Breite je Zeichen, falls nichts gemessen werden kann. */
function estimateInk(family: string, text: string): Ink {
	const perChar = family === SCRIPT_FONT ? 0.46 : 0.56;
	return { left: 0, right: perChar * [...text].length, top: -0.75, bottom: 0.22 };
}

export function escapeXml(text: string): string {
	return text
		// Steuerzeichen sind in XML verboten und ließen resvg scheitern
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
