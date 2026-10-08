/**
 * Gemeinsames für die Auswertewerkzeuge des Stimmgeräts (tuner-eval.cjs, ansprech-eval.cjs):
 * die kompilierte Engine laden und WAV-Dateien lesen. Keine Audiogeräte, keine Ports.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PLUGIN = path.join(__dirname, "..", "streamdeck-plugin");

// --- Engine laden -------------------------------------------------------------

function newestSource() {
	const dir = path.join(PLUGIN, "src", "tuner");
	return Math.max(...fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
}

function upToDate(dir) {
	const files = ["engine.js", "baseline.js", "heterodyne.js", "yin.js", "filters.js", "notes.js"].map((f) => path.join(dir, "tuner", f));
	if (!files.every((f) => fs.existsSync(f))) return false;
	if (!fs.existsSync(path.join(dir, "package.json"))) return false;
	return Math.min(...files.map((f) => fs.statSync(f).mtimeMs)) >= newestSource();
}

/** Verzeichnis mit der kompilierten Engine (…/tuner/engine.js darunter). */
function buildDir() {
	const testBuild = path.join(PLUGIN, "test-output", "build");
	if (upToDate(testBuild)) return testBuild;
	const own = path.join(PLUGIN, "test-output", "tuner-build");
	if (upToDate(own)) return own;
	process.stderr.write("Kompiliere src/tuner nach test-output/tuner-build …\n");
	fs.rmSync(own, { recursive: true, force: true });
	execFileSync(
		process.execPath,
		[
			path.join(PLUGIN, "node_modules", "typescript", "bin", "tsc"),
			"src/tuner/engine.ts",
			"src/tuner/baseline.ts",
			"--outDir", own,
			"--rootDir", "src",
			"--module", "commonjs",
			"--target", "ES2022",
			"--moduleResolution", "node",
			"--esModuleInterop",
			"--strict",
			"--skipLibCheck",
		],
		{ cwd: PLUGIN, stdio: "inherit" },
	);
	fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ type: "commonjs" }));
	return own;
}

function loadTuner(dir) {
	return {
		TunerEngine: require(path.join(dir, "tuner", "engine.js")).TunerEngine,
		BaselineTuner: require(path.join(dir, "tuner", "baseline.js")).BaselineTuner,
	};
}

/** WAV lesen: ein Kanal als Float32Array, nie eine Summe. */
function readWav(file, channel) {
	const buf = fs.readFileSync(file);
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file}: keine WAV-Datei`);
	let off = 12;
	let fmtChunk = null;
	let data = null;
	while (off + 8 <= buf.length) {
		const id = buf.toString("ascii", off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		if (id === "fmt ") {
			let tag = buf.readUInt16LE(off + 8);
			if (tag === 0xfffe && size >= 40) tag = buf.readUInt16LE(off + 8 + 24); // WAVE_FORMAT_EXTENSIBLE: Unterformat
			fmtChunk = { tag, channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
		} else if (id === "data") {
			data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
		}
		off += 8 + size + (size & 1);
	}
	if (!fmtChunk || !data) throw new Error(`${file}: fmt- oder data-Block fehlt`);
	const { tag, channels, rate, bits } = fmtChunk;
	if (channel < 1 || channel > channels) throw new Error(`${file}: Kanal ${channel} gibt es nicht (1 … ${channels})`);
	const bytes = bits / 8;
	const frame = bytes * channels;
	const n = Math.floor(data.length / frame);
	const out = new Float32Array(n);
	const at = (i) => i * frame + (channel - 1) * bytes;
	if (tag === 3 && bits === 32) for (let i = 0; i < n; i++) out[i] = data.readFloatLE(at(i));
	else if (tag === 1 && bits === 16) for (let i = 0; i < n; i++) out[i] = data.readInt16LE(at(i)) / 32768;
	else if (tag === 1 && bits === 24) for (let i = 0; i < n; i++) out[i] = data.readIntLE(at(i), 3) / 8388608;
	else if (tag === 1 && bits === 32) for (let i = 0; i < n; i++) out[i] = data.readInt32LE(at(i)) / 2147483648;
	else throw new Error(`${file}: Format ${tag}/${bits} Bit wird nicht unterstützt (PCM 16/24/32 oder Float 32)`);
	return { samples: out, rate, channels, bits, float: tag === 3 };
}

module.exports = { PLUGIN, buildDir, loadTuner, readWav };
