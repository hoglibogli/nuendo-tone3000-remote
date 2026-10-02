/**
 * Grafik: rendert jede Variante, prüft Bildmaße und Zeiten und legt alle Bilder als
 * PNG nach test-output/ — zum Ansehen und zum Vergleich mit dem Entwurf
 * (strip.png gegen strip-a.png, dazu strip-compare.png: Entwurf oben, Plugin unten).
 * Stimmanzeige: tuner-strip-*.png (vier Segmente als 800x100-Leiste), tuner-key-*.png,
 * tuner-overview.png; dazu Pixelprüfungen (Nadel, Note mittig, Lampen, Cent-Anzeige).
 *
 * Öffnet keine Ports und fasst weder Stream Deck noch Nuendo an. Läuft einzeln
 * (node test/render.test.cjs) oder aus run.cjs: Der Export ist die Testfunktion,
 * gezählt wird über harness.cjs.
 */
"use strict";

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { section, check, ok, state } = require("./harness.cjs");
const { ensureBuilt, root, outDir } = require("./render-build.cjs");

const pluginDir = join(root, "com.sorg.tone3000.sdPlugin");
const outputDir = join(root, "test-output");

/** Der freigegebene Entwurf (nur zum Vergleich; fehlt er, entfällt das Vergleichsbild). */
const DRAFT =
	process.env.TONE3000_DRAFT ??
	"C:\\Users\\sorg\\AppData\\Local\\Temp\\claude\\C--Users-sorg-Desktop-Claude-Code-Projekte-DAW-Controller-mit-Motorfader\\b249e9c2-3367-4f91-91ff-3a483bb5b24f\\scratchpad\\strip-a.png";

const PNG_PREFIX = "data:image/png;base64,";
const PARAMS = ["gain", "bass", "mid", "treble"];
const OK = { kind: "ok" };
const WAITING = { kind: "waiting" };
const errorFor = (p) => ({ kind: "error", text: p === "gain" ? "Kanal?" : "Plugin?" });

/** PNG aus der Data-URL; Breite und Höhe aus dem IHDR-Block. */
function decode(url) {
	if (!url.startsWith(PNG_PREFIX)) return { png: null, width: 0, height: 0 };
	const png = Buffer.from(url.slice(PNG_PREFIX.length), "base64");
	if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return { png: null, width: 0, height: 0 };
	return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function ms(start) {
	return Number(process.hrtime.bigint() - start) / 1e6;
}

function run() {
	ensureBuilt();
	mkdirSync(outputDir, { recursive: true });
	const render = require(join(outDir, "render", "index.js"));
	const engine = require(join(outDir, "render", "engine.js"));
	const dial = require(join(outDir, "render", "dial.js"));
	const keys = require(join(outDir, "render", "keys.js"));

	const save = (name, url) => {
		const { png } = decode(url);
		if (png) writeFileSync(join(outputDir, name), png);
	};
	const sheet = (width, height, body) =>
		engine.renderPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`);

	// --- Start ----------------------------------------------------------------
	section("Grafik: Start");
	{
		const t = process.hrtime.bigint();
		render.initRenderer(pluginDir);
		console.log(`      initRenderer ${ms(t).toFixed(1)} ms`);
		check("resvg geladen, Schriften da", engine.engineProblem(), null);
		check("rendererProblem() an der Schnittstelle: nichts", render.rendererProblem(), null);
		check("Renderer bereit", engine.engineReady(), true);
	}

	// --- Wertanzeige ------------------------------------------------------------
	section("Grafik: Wertanzeige");
	check("0 -> 0,0", dial.formatValue(0), "0,0");
	check("0,5 -> 5,0", dial.formatValue(0.5), "5,0");
	check("1 -> 10,0", dial.formatValue(1), "10,0");
	check("0,123 -> 1,2", dial.formatValue(0.123), "1,2");
	check("immer eine Nachkommastelle", dial.formatValue(0.655).length, 3);

	// --- Regler: jede Variante --------------------------------------------------
	section("Grafik: Regler 200x100");
	{
		let allSized = true;
		for (const p of PARAMS) {
			const variants = [
				["0", 0, OK],
				["5", 0.5, OK],
				["10", 1, OK],
				["waiting", 0.5, WAITING],
				["error", 0.5, errorFor(p)],
			];
			for (const [label, value, status] of variants) {
				const t = process.hrtime.bigint();
				const url = render.renderDial(p, value, status);
				const took = ms(t);
				const { width, height } = decode(url);
				if (width !== 200 || height !== 100) allSized = false;
				save(`dial-${p}-${label}.png`, url);
				console.log(`      dial ${p.padEnd(6)} ${label.padEnd(7)} ${took.toFixed(1).padStart(5)} ms  ${url.length} Zeichen`);
			}
		}
		ok("alle Regler-Bilder 200x100 PNG", allSized);
		const longError = render.renderDial("mid", 0.5, { kind: "error", text: "Nuendo antwortet nicht" });
		save("dial-mid-error-long.png", longError);
		check("langer Fehlertext: trotzdem 200x100", [decode(longError).width, decode(longError).height], [200, 100]);
		ok("Wert über 1 wird begrenzt", render.renderDial("gain", 1.7, OK) === render.renderDial("gain", 1, OK));
		ok("NaN zeichnet 0", render.renderDial("gain", Number.NaN, OK) === render.renderDial("gain", 0, OK));
	}

	// --- Zeiten: Regler-Bild nach dem Aufwärmen ----------------------------------
	section("Grafik: Zeiten");
	{
		for (const p of PARAMS) render.renderDial(p, 0.25, OK); // Hintergründe sind spätestens jetzt da
		const times = [];
		for (let i = 0; i < 120; i++) {
			const p = PARAMS[i % 4];
			const v = 0.0005 + i / 121; // jedes Bild neu, kein Treffer im Zwischenspeicher
			const t = process.hrtime.bigint();
			render.renderDial(p, v, OK);
			times.push(ms(t));
		}
		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / times.length;
		const p95 = times[Math.floor(times.length * 0.95)];
		const max = times[times.length - 1];
		console.log(
			`      Regler-Bild: Mittel ${avg.toFixed(2)} ms, Median ${times[60].toFixed(2)} ms, 95 % ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`,
		);
		ok("Regler-Bild im Mittel unter 15 ms", avg < 15, `Mittel ${avg.toFixed(2)} ms`);
		ok("Regler-Bild zu 95 % unter 15 ms", p95 < 15, `95 % ${p95.toFixed(2)} ms`);

		const t = process.hrtime.bigint();
		for (let i = 0; i < 1000; i++) render.renderDial("bass", 0.5, OK);
		const hit = ms(t) / 1000;
		console.log(`      Treffer im Zwischenspeicher: ${(hit * 1000).toFixed(1)} µs`);
		ok("Treffer im Zwischenspeicher unter 0,1 ms", hit < 0.1, `${hit.toFixed(3)} ms`);
	}

	// --- Leiste: vier Segmente nebeneinander --------------------------------------
	section("Grafik: Leiste 800x100");
	{
		const values = [0.5, 0.65, 0.4, 0.75]; // wie im Entwurf: 5,0 6,5 4,0 7,5
		const strip = (urls) => urls.map((u, i) => `<image href="${u}" x="${i * 200}" y="0" width="200" height="100"/>`).join("");
		const png = sheet(800, 100, strip(PARAMS.map((p, i) => render.renderDial(p, values[i], OK))));
		writeFileSync(join(outputDir, "strip.png"), png);
		check("strip.png 800x100", [png.readUInt32BE(16), png.readUInt32BE(20)], [800, 100]);
		writeFileSync(
			join(outputDir, "strip-status.png"),
			sheet(800, 100, strip(PARAMS.map((p, i) => render.renderDial(p, values[i], i < 2 ? WAITING : errorFor(p))))),
		);
		if (existsSync(DRAFT)) {
			const draft = readFileSync(DRAFT).toString("base64");
			writeFileSync(
				join(outputDir, "strip-compare.png"),
				sheet(
					800,
					208,
					`<rect width="800" height="208" fill="#808080"/>` +
						`<image href="data:image/png;base64,${draft}" x="0" y="0" width="800" height="100"/>` +
						`<image href="data:image/png;base64,${png.toString("base64")}" x="0" y="108" width="800" height="100"/>`,
				),
			);
			console.log("      strip-compare.png: Entwurf oben, Plugin unten");

			// Pixelvergleich: beide Bilder über resvg in RGBA dekodieren
			const { Resvg } = createRequire(join(pluginDir, "package.json"))("@resvg/resvg-js");
			const pixels = (b64) =>
				new Resvg(
					`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="100"><image href="data:image/png;base64,${b64}" width="800" height="100"/></svg>`,
				).render().pixels;
			const a = pixels(draft);
			const b = pixels(png.toString("base64"));
			let sum = 0;
			for (let i = 0; i < a.length; i += 4) {
				sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
			}
			const mean = sum / (a.length / 4);
			console.log(`      Abweichung vom Entwurf: im Mittel ${mean.toFixed(2)} von 765 je Pixel`);
			ok("strip.png gleicht dem Entwurf (mittlere Abweichung unter 2 von 765)", mean < 2, `${mean.toFixed(2)}`);
		}
	}

	// --- Preset-Tasten -------------------------------------------------------------
	section("Grafik: Preset-Tasten 144x144");
	{
		const names = [
			["kurz", "HMT"],
			["mittel", "JCM 2000"],
			["zwei-woerter", "Einstein Vollgas"],
			["lang-umlaut", "Überstürzte Höhenflüge im Hochgebirge"],
			["ein-langes-wort", "Röhrenverstärkerübersteuerung"],
		];
		let allSized = true;
		for (const [label, name] of names) {
			for (const active of [false, true]) {
				const t = process.hrtime.bigint();
				const url = render.renderPresetKey(name, active, OK);
				const took = ms(t);
				const { width, height } = decode(url);
				if (width !== 144 || height !== 144) allSized = false;
				save(`preset-${label}-${active ? "aktiv" : "inaktiv"}.png`, url);
				console.log(`      preset ${label.padEnd(15)} ${active ? "aktiv  " : "inaktiv"} ${took.toFixed(1).padStart(5)} ms`);
			}
		}
		save("preset-zwei-woerter-warte.png", render.renderPresetKey("Einstein Vollgas", false, WAITING));
		save("preset-zwei-woerter-aktiv-warte.png", render.renderPresetKey("Einstein Vollgas", true, WAITING));
		save("preset-mittel-fehler.png", render.renderPresetKey("JCM 2000", true, { kind: "error", text: "Plugin?" }));
		save("preset-leer.png", render.renderPresetKey("", false, OK));
		ok("ohne Preset: Platzhalter abgedunkelt, nicht wie ein echtes Preset", render.renderPresetKey("", false, OK) !== render.renderPresetKey("Preset wählen", false, OK));
		ok("alle Preset-Tasten 144x144 PNG", allSized);
		ok("aktiv und inaktiv unterscheiden sich", render.renderPresetKey("JCM 2000", true, OK) !== render.renderPresetKey("JCM 2000", false, OK));
		// XML-Sonderzeichen und Steuerzeichen im Namen dürfen nichts kaputt machen
		const odd = render.renderPresetKey('Clean & "Crunch" <2>\u0007', false, OK);
		save("preset-sonderzeichen.png", odd);
		check("Sonderzeichen im Namen: trotzdem PNG", decode(odd).width, 144);
	}

	// --- Schalter-Tasten -------------------------------------------------------------
	section("Grafik: Schalter-Tasten 144x144");
	{
		let allSized = true;
		for (const kind of ["amp", "tuner", "delay"]) {
			for (const on of [false, true]) {
				const url = render.renderToggleKey(kind, on, OK);
				const { width, height } = decode(url);
				if (width !== 144 || height !== 144) allSized = false;
				save(`toggle-${kind}-${on ? "an" : "aus"}.png`, url);
			}
			save(`toggle-${kind}-warte.png`, render.renderToggleKey(kind, true, WAITING));
			save(`toggle-${kind}-fehler.png`, render.renderToggleKey(kind, true, { kind: "error", text: "Kanal?" }));
		}
		// außerhalb des Modus, Steinberg-Tuner fehlt in Slot 1 (Protokoll 4)
		save("toggle-tuner-fehlt.png", render.renderToggleKey("tuner", false, { kind: "error", text: "Tuner?" }));
		// außerhalb des Modus, Mute des Tuners steht trotzdem an (5.5)
		save("toggle-tuner-stumm.png", render.renderToggleKey("tuner", false, { kind: "error", text: "stumm" }));
		{
			// Meldungen der Tuner-Taste in klarer Schrift: Unter dem Namen (ab Zeile 117) steht nur
			// die Meldung. Amp und Delay setzen „Kanal?“ gleich (Georgia), der Tuner anders (Segoe UI).
			const { Resvg } = createRequire(join(pluginDir, "package.json"))("@resvg/resvg-js");
			const band = (url) => {
				const { png } = decode(url);
				const px = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><image href="data:image/png;base64,${png.toString("base64")}" width="144" height="144"/></svg>`).render().pixels;
				return Buffer.from(px.subarray(117 * 144 * 4, 140 * 144 * 4)).toString("base64");
			};
			const err = { kind: "error", text: "Kanal?" };
			const [amp, delay, tuner] = ["amp", "delay", "tuner"].map((k) => band(render.renderToggleKey(k, false, err)));
			check("Meldung: Amp und Delay gleich (Georgia), Tuner-Taste anders (klare Schrift)", [amp === delay, tuner === amp], [true, false]);
		}
		ok("alle Schalter-Tasten 144x144 PNG", allSized);
		ok("an und aus unterscheiden sich", render.renderToggleKey("tuner", true, OK) !== render.renderToggleKey("tuner", false, OK));
		save("knob-key.png", keys.renderKnobKey());

		// Übersicht aller Tasten in einem Bild (4 Spalten)
		const tiles = [
			render.renderPresetKey("JCM 2000", true, OK),
			render.renderPresetKey("Einstein Vollgas", false, OK),
			render.renderPresetKey("Überstürzte Höhenflüge im Hochgebirge", false, OK),
			render.renderPresetKey("HMT", false, WAITING),
			render.renderToggleKey("amp", true, OK),
			render.renderToggleKey("tuner", true, OK),
			render.renderToggleKey("delay", true, OK),
			render.renderToggleKey("tuner", false, { kind: "error", text: "Kanal?" }),
			render.renderToggleKey("amp", false, OK),
			render.renderToggleKey("tuner", false, OK),
			render.renderToggleKey("delay", false, OK),
			keys.renderKnobKey(),
		];
		const body = tiles
			.map((u, i) => `<image href="${u}" x="${(i % 4) * 152 + 8}" y="${Math.floor(i / 4) * 152 + 8}" width="144" height="144"/>`)
			.join("");
		writeFileSync(join(outputDir, "keys-overview.png"), sheet(616, 464, `<rect width="616" height="464" fill="#111"/>${body}`));
	}

	// --- Stimmanzeige (Protokoll 4) ------------------------------------------------
	section("Grafik: Stimmanzeige, Leiste 4 x 200x100 und Taste 144x144");
	{
		const tuner = require(join(outDir, "render", "tuner.js"));
		const st = (note, octave, cent, inTune, locked = true, found = true) => ({ note, octave, cent, locked, inTune, found });
		const cases = [
			["minus50", st("A", 2, -50, false), OK],
			["minus16", st("E", 1, -16, false), OK],
			["null", st("D", 3, 0, true), OK],
			["plus3-gestimmt", st("F#", 2, 3, true), OK],
			["plus50", st("B", 2, 50, false), OK],
			["stille", st("--", 0, -49, false, false), OK],
			["fehlt", st("", 0, 0, false, false, false), OK],
			["warte", null, WAITING],
			["kanal", null, { kind: "error", text: "Kanal?" }],
		];
		const stripOf = (urls) => urls.map((u, i) => `<image href="${u}" x="${i * 200}" y="0" width="200" height="100"/>`).join("");
		let sized = true;
		const strips = {};
		const keyUrls = {};
		for (const [label, s, status] of cases) {
			const urls = [0, 1, 2, 3].map((i) => render.renderTunerSegment(i, s, status));
			for (const u of urls) {
				const { width, height } = decode(u);
				if (width !== 200 || height !== 100) sized = false;
			}
			const png = sheet(800, 100, stripOf(urls));
			strips[label] = png;
			writeFileSync(join(outputDir, `tuner-strip-${label}.png`), png);
			const key = render.renderTunerKey(s, status);
			const k = decode(key);
			if (k.width !== 144 || k.height !== 144) sized = false;
			keyUrls[label] = key;
			save(`tuner-key-${label}.png`, key);
		}
		ok("alle Segmente 200x100, alle Tasten 144x144 PNG", sized);
		check("Index außerhalb 0..3 wird begrenzt", [render.renderTunerSegment(-1, cases[1][1], OK) === render.renderTunerSegment(0, cases[1][1], OK), render.renderTunerSegment(9, cases[1][1], OK) === render.renderTunerSegment(3, cases[1][1], OK)], [true, true]);
		check("Cent als Anzeige", [tuner.formatCent(-16), tuner.formatCent(3), tuner.formatCent(0), tuner.formatCent(50)], ["−16", "+3", "0", "+50"]);
		check("Stille: ohne Locked oder mit Note --", [tuner.isSilent(st("E", 1, 0, false, false)), tuner.isSilent(st("--", 0, 0, false, true)), tuner.isSilent(st("E", 1, 0, false))], [true, true, false]);

		// Übersicht: alle Leisten untereinander, die Tasten rechts daneben
		let body = `<rect width="1420" height="${cases.length * 108}" fill="#5a5a5a"/>`;
		cases.forEach(([label], r) => {
			body += `<image href="data:image/png;base64,${strips[label].toString("base64")}" x="0" y="${r * 108}" width="800" height="100"/>`;
		});
		cases.forEach(([label], k) => {
			body += `<image href="${keyUrls[label]}" x="${816 + (k % 4) * 150}" y="${Math.floor(k / 4) * 150}" width="144" height="144"/>`;
		});
		writeFileSync(join(outputDir, "tuner-overview.png"), sheet(1420, cases.length * 108, body));
		console.log("      tuner-strip-*.png, tuner-key-*.png, tuner-overview.png");

		// --- Pixel: liegt alles dort, wo der Entwurf es vorsieht? ---
		const { Resvg } = createRequire(join(pluginDir, "package.json"))("@resvg/resvg-js");
		const pixelsOf = (png, w, h) =>
			new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image href="data:image/png;base64,${png.toString("base64")}" width="${w}" height="${h}"/></svg>`).render().pixels;
		const at = (px, w, x, y) => {
			const i = (y * w + x) * 4;
			return { r: px[i], g: px[i + 1], b: px[i + 2], lum: 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] };
		};
		/** Spalten mit hellen Pixeln in einem Band: [min, max] oder null. */
		const brightSpan = (px, w, x0, x1, y0, y1, minLum) => {
			let lo = Infinity;
			let hi = -Infinity;
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					if (at(px, w, x, y).lum >= minLum) {
						lo = Math.min(lo, x);
						hi = Math.max(hi, x);
					}
				}
			}
			return lo === Infinity ? null : [lo, hi];
		};
		const P = Object.fromEntries(cases.map(([label]) => [label, pixelsOf(strips[label], 800, 100)]));
		const needleX = (label) => {
			const span = brightSpan(P[label], 800, 100, 700, 62, 66, 200);
			return span ? (span[0] + span[1]) / 2 : null;
		};
		const near = (a, b, tol) => a !== null && Math.abs(a - b) <= tol;
		const nx = { minus50: needleX("minus50"), minus16: needleX("minus16"), null: needleX("null"), plus50: needleX("plus50") };
		console.log(`      Nadel bei x: -50 -> ${nx.minus50}, -16 -> ${nx.minus16}, 0 -> ${nx.null}, +50 -> ${nx.plus50} (Soll 120, 310,4, 400, 680)`);
		ok("Nadel auf der Skala: -50 bei x 120, -16 bei 310, 0 bei 400 (Mitte zwischen Bass und Mid), +50 bei 680", near(nx.minus50, 120, 2) && near(nx.minus16, 310.4, 2) && near(nx.null, 400, 2) && near(nx.plus50, 680, 2), JSON.stringify(nx));
		ok("Stille, fehlt, Warte: keine Nadel", ["stille", "fehlt", "warte", "kanal"].every((l) => needleX(l) === null));
		const noteSpan = brightSpan(P.minus16, 800, 330, 470, 14, 56, 222);
		const noteCenter = noteSpan ? (noteSpan[0] + noteSpan[1]) / 2 : null;
		console.log(`      Note „E“ hell zwischen x ${noteSpan} (Mitte ${noteCenter})`);
		ok("Note mittig über der Skala (x 400 ± 3)", near(noteCenter, 400, 3), String(noteCenter));
		ok("Note groß: mindestens 30 px hoch", (() => {
			let top = Infinity;
			let bottom = -Infinity;
			for (let y = 5; y < 60; y++) for (let x = 385; x <= 415; x++) if (at(P.minus16, 800, x, y).lum >= 222) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
			return bottom - top >= 30;
		})());
		const centSpan = (label) => brightSpan(P[label], 800, 708, 792, 20, 58, 200);
		ok("Cent-Zahl rechts (x 708–792) bei Ton, leer bei Stille", centSpan("minus16") !== null && centSpan("plus50") !== null && centSpan("stille") === null, JSON.stringify([centSpan("minus16"), centSpan("stille")]));
		/** Mittlere Farbe des Lampenglases (Scheibe um den Mittelpunkt). */
		const disk = (px, w, cx, cy, rad) => {
			let r = 0, g = 0, b = 0, n = 0;
			for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) {
				if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue;
				const p = at(px, w, x, y);
				r += p.r; g += p.g; b += p.b; n++;
			}
			r /= n; g /= n; b /= n;
			return { r: Math.round(r), g: Math.round(g), b: Math.round(b), lum: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b) };
		};
		const green = (p) => p.g > p.r + 40 && p.g > 120;
		const lampL = (label) => disk(P[label], 800, 310, 36, 7);
		const lampR = (label) => disk(P[label], 800, 490, 36, 7);
		console.log(`      Lampen der Leiste (Mittel): gestimmt ${JSON.stringify(lampL("plus3-gestimmt"))}, verstimmt ${JSON.stringify(lampL("minus16"))}`);
		ok("gestimmt: beide Lampen grün", green(lampL("plus3-gestimmt")) && green(lampR("plus3-gestimmt")), JSON.stringify([lampL("plus3-gestimmt"), lampR("plus3-gestimmt")]));
		ok("verstimmt und Stille: Lampen dunkel (weniger als halb so hell wie gestimmt)", ["minus16", "stille"].every((l) => lampL(l).lum * 2 < lampL("plus3-gestimmt").lum && lampR(l).lum * 2 < lampR("plus3-gestimmt").lum), JSON.stringify([lampL("minus16"), lampL("stille")]));
		const centGreen = brightSpan(P["plus3-gestimmt"], 800, 708, 792, 20, 58, 150);
		const centPixel = (() => {
			for (let x = 720; x < 780; x++) for (let y = 30; y < 56; y++) { const p = at(P["plus3-gestimmt"], 800, x, y); if (p.lum > 150) return p; }
			return null;
		})();
		ok("gestimmt: Cent-Zahl grün", centGreen !== null && centPixel !== null && centPixel.g > centPixel.r + 30, JSON.stringify(centPixel));
		const reddish = (label) => {
			const px = P[label];
			let n = 0;
			for (let y = 35; y < 65; y++) for (let x = 200; x < 600; x++) { const p = at(px, 800, x, y); if (p.r > 180 && p.r > p.g + 40) n++; }
			return n;
		};
		ok("fehlt: Hinweis in Rot über die Mitte, keine Skala", reddish("fehlt") > 200 && brightSpan(P.fehlt, 800, 130, 670, 85, 87, 110) === null, String(reddish("fehlt")));
		ok("Warte: Skala bleibt, kein roter Hinweis", reddish("warte") === 0 && brightSpan(P.warte, 800, 130, 670, 85, 87, 110) !== null);

		// Taste: Lampe grün gestimmt, rot verstimmt, dunkel bei Stille; Note hell in der Mitte
		const keyPx = (label) => pixelsOf(decode(keyUrls[label]).png, 144, 144);
		const keyLamp = (label) => disk(keyPx(label), 144, 72, 33, 9);
		const red = (p) => p.r > p.g + 60 && p.r > 120;
		console.log(`      Lampe der Taste (Mittel): gestimmt ${JSON.stringify(keyLamp("plus3-gestimmt"))}, verstimmt ${JSON.stringify(keyLamp("minus16"))}, Stille ${JSON.stringify(keyLamp("stille"))}`);
		ok("Taste: Lampe grün gestimmt, rot verstimmt, dunkel bei Stille", green(keyLamp("plus3-gestimmt")) && red(keyLamp("minus16")) && keyLamp("stille").lum * 2 < keyLamp("minus16").lum, JSON.stringify([keyLamp("plus3-gestimmt"), keyLamp("minus16"), keyLamp("stille")]));
		const keyNote = brightSpan(keyPx("minus16"), 144, 20, 124, 50, 104, 222);
		const keyNoteRows = (() => {
			let top = Infinity;
			let bottom = -Infinity;
			const px = keyPx("minus16");
			for (let y = 50; y <= 104; y++) for (let x = 60; x <= 84; x++) if (at(px, 144, x, y).lum >= 222) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
			return bottom - top;
		})();
		ok("Taste: Note groß (mindestens 30 px hoch) und mittig (x 72 ± 4)", keyNote !== null && near((keyNote[0] + keyNote[1]) / 2, 72, 4) && keyNoteRows >= 30, JSON.stringify([keyNote, keyNoteRows]));
		const frameLum = (label) => at(keyPx(label), 144, 3, 72).lum;
		ok("Taste im Modus: heller Goldrahmen, ohne Verbindung der schlichte", frameLum("minus16") > frameLum("warte") + 20, JSON.stringify([frameLum("minus16"), frameLum("warte")]));

		// Nur geänderte Segmente: dieselbe Zeichenkette, wo sich nichts geändert hat
		const a = st("E", 1, 10, false);
		const b = st("E", 1, 20, false);
		const same = [0, 1, 2, 3].map((i) => render.renderTunerSegment(i, a, OK) === render.renderTunerSegment(i, b, OK));
		check("Nadel 10 -> 20 Cent (in Mid): Gain und Bass gleich, Mid und Treble neu", same, [true, true, false, false]);
		const c = st("A", 1, 20, false);
		check("andere Note, gleicher Cent: nur Bass und Mid neu (die Note steht auf der Grenze)", [0, 1, 2, 3].map((i) => render.renderTunerSegment(i, b, OK) === render.renderTunerSegment(i, c, OK)), [true, false, false, true]);
		const d = st("E", 1, -45, false);
		const e = st("E", 1, -40, false);
		check("Nadel in Gain: Bass und Mid gleich", [0, 1, 2, 3].map((i) => render.renderTunerSegment(i, d, OK) === render.renderTunerSegment(i, e, OK)), [false, true, true, false]);
		check("Stille bleibt Stille, auch wenn Cent sich ändert", [0, 1, 2, 3].map((i) => render.renderTunerSegment(i, st("--", 0, -49, false, false), OK) === render.renderTunerSegment(i, st("--", 0, 12, false, false), OK)), [true, true, true, true]);

		// Zeiten nach dem Aufwärmen: jedes Bild neu (anderer Cent, andere Note)
		for (let i = 0; i < 4; i++) render.renderTunerSegment(i, st("C", 1, 1, false), OK);
		const notes = ["E", "A", "D", "G", "B", "F#", "C#", "G#"];
		const times = [];
		const keyTimes = [];
		for (let k = 0; k < 160; k++) {
			const s = st(notes[k % notes.length], 1 + (k % 3), ((k * 7) % 101) - 50, k % 5 === 0);
			for (let i = 0; i < 4; i++) {
				const t = process.hrtime.bigint();
				render.renderTunerSegment(i, s, OK);
				times.push(ms(t));
			}
			const t = process.hrtime.bigint();
			render.renderTunerKey(s, OK);
			keyTimes.push(ms(t));
		}
		const stats = (arr) => {
			const sorted = [...arr].sort((x, y) => x - y);
			return { avg: sorted.reduce((x, y) => x + y, 0) / sorted.length, p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1] };
		};
		const seg = stats(times);
		const keyStat = stats(keyTimes);
		console.log(`      Segment: Mittel ${seg.avg.toFixed(2)} ms, 95 % ${seg.p95.toFixed(2)} ms, max ${seg.max.toFixed(2)} ms (inkl. Treffern); Taste: Mittel ${keyStat.avg.toFixed(2)} ms, 95 % ${keyStat.p95.toFixed(2)} ms`);
		ok("Segment im Mittel unter 15 ms", seg.avg < 15, seg.avg.toFixed(2));
		ok("Segment zu 95 % unter 15 ms", seg.p95 < 15, seg.p95.toFixed(2));
		ok("Taste zu 95 % unter 15 ms", keyStat.p95 < 15, keyStat.p95.toFixed(2));
		const full = [];
		for (let k = 0; k < 40; k++) {
			const s = st(notes[k % notes.length], 4, ((k * 13) % 101) - 50, false);
			const t = process.hrtime.bigint();
			for (let i = 0; i < 4; i++) render.renderTunerSegment(i, s, OK);
			full.push(ms(t));
		}
		const fullStat = stats(full);
		console.log(`      ganze Leiste (4 Segmente) neu: Mittel ${fullStat.avg.toFixed(2)} ms, max ${fullStat.max.toFixed(2)} ms`);
		ok("ganze Leiste im Mittel unter 15 ms je Segment", fullStat.avg / 4 < 15);

		// Ein Absturz in resvg (panic) beendete den Plugin-Prozess: jede Nadelstellung einmal,
		// auch die, bei denen die Nadel gerade noch in ein Nachbarsegment ragt.
		let allPng = true;
		for (let cent = -50; cent <= 50; cent++) {
			const s = st(cent % 2 ? "C#" : "E", 2, cent, cent % 3 === 0);
			for (let i = 0; i < 4; i++) if (!render.renderTunerSegment(i, s, OK).startsWith(PNG_PREFIX)) allPng = false;
			if (!render.renderTunerKey(s, OK).startsWith(PNG_PREFIX)) allPng = false;
		}
		ok("jede Nadelstellung -50 … +50: alle Segmente und die Taste als PNG", allPng);
	}

	// --- Rückfall ohne resvg: SVG statt PNG, kein Absturz ------------------------------
	section("Grafik: Rückfall ohne resvg");
	{
		const cwd = process.cwd();
		process.chdir(tmpdir()); // dort liegt kein resvg, auch nicht über process.cwd()
		try {
			render.initRenderer(join(tmpdir(), "kein-plugin-ordner"));
			check("ohne resvg: Problem gemeldet", typeof engine.engineProblem(), "string");
			ok("rendererProblem() nennt den Grund", /resvg nicht geladen/.test(render.rendererProblem() ?? ""), render.rendererProblem());
			const url = render.renderDial("mid", 0.5, OK);
			ok("ohne resvg: Regler als SVG-Data-URL", url.startsWith("data:image/svg+xml;base64,"));
			const svg = Buffer.from(url.split(",")[1], "base64").toString("utf8");
			ok("ohne resvg: Wert steht im SVG", svg.includes(">5,0<"));
			ok("ohne resvg: Taste als SVG", render.renderToggleKey("delay", true, OK).startsWith("data:image/svg+xml"));
			const seg = render.renderTunerSegment(2, { note: "E", octave: 1, cent: 10, locked: true, inTune: false, found: true }, OK);
			ok("ohne resvg: Stimmanzeige als SVG, Note und Cent stehen darin", seg.startsWith("data:image/svg+xml") && Buffer.from(seg.split(",")[1], "base64").toString("utf8").includes(">E<"));
			ok("ohne resvg: Tuner-Taste als SVG", render.renderTunerKey(null, WAITING).startsWith("data:image/svg+xml"));
		} finally {
			process.chdir(cwd);
			render.initRenderer(pluginDir);
		}
		ok("danach wieder PNG", render.renderDial("mid", 0.5, OK).startsWith(PNG_PREFIX));
	}

	console.log(`      Bilder: ${outputDir}`);
}

module.exports = run;

if (require.main === module) {
	run();
	const { passes, failures } = state;
	console.log(failures === 0 ? `\nrender: alle ${passes} Prüfungen bestanden` : `\nrender: ${failures} von ${passes + failures} Prüfungen fehlgeschlagen`);
	process.exit(failures === 0 ? 0 : 1);
}
