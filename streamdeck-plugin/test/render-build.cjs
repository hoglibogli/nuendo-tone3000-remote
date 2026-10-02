/**
 * Baut Grafik und Preset-Liste für die Tests (und scripts/make-icons.mjs) nach
 * test-output/render-build (CommonJS), mit denselben Schaltern wie run.cjs, aber in
 * einem eigenen Ordner: run.cjs räumt test-output/build bei jedem Lauf ab. Gebaut
 * wird nur, wenn eine Quelle neuer ist als die Ausgabe. So laufen render.test.cjs
 * und presets.test.cjs einzeln wie aus run.cjs.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const outDir = join(root, "test-output", "render-build");

const ENTRIES = ["src/render/index.ts", "src/presets/t3k-presets.ts"];
const SOURCE_DIRS = ["src/render", "src/presets", "src/@types"];
const OUTPUTS = ["render/index.js", "render/keys.js", "render/engine.js", "render/dial.js", "render/tuner.js", "presets/t3k-presets.js"];

function newestSource() {
	let newest = 0;
	for (const dir of SOURCE_DIRS) {
		const full = join(root, dir);
		if (!existsSync(full)) continue;
		for (const f of readdirSync(full)) {
			if (f.endsWith(".ts")) newest = Math.max(newest, statSync(join(full, f)).mtimeMs);
		}
	}
	return newest;
}

function isFresh() {
	const newest = newestSource();
	return OUTPUTS.every((o) => {
		const p = join(outDir, o);
		return existsSync(p) && statSync(p).mtimeMs >= newest;
	});
}

function ensureBuilt() {
	if (isFresh()) return;
	execFileSync(
		process.execPath,
		[
			join(root, "node_modules", "typescript", "bin", "tsc"),
			...ENTRIES,
			"--outDir", outDir,
			"--rootDir", "src",
			"--module", "commonjs",
			"--target", "ES2022",
			"--moduleResolution", "node",
			"--strict",
			"--skipLibCheck",
		],
		{ cwd: root, stdio: "inherit" },
	);
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
}

module.exports = { ensureBuilt, root, outDir, ENTRIES };
