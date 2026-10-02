/**
 * Holt die audify-Binärdatei für N-API 9 (Node 20) in den .sdPlugin-Ordner.
 *
 * Stream Deck startet Plugins mit seinem eigenen Node 20. Die im npm-Paket audify
 * 1.10.1 mitgelieferte build/Release/audify.node stürzte darunter beim Auflisten der
 * Geräte mit 0xC0000005 ab (unter Node 24 lief sie) — gemessen 2026-10-02, der
 * Tuner-Worker endete sofort mit Code 3221225477. Die Release-Fassung napi-v9 von
 * GitHub läuft unter Node 20 und 24. npm 11 blockiert das Installationsskript von
 * audify (prebuild-install), und selbst erlaubt würde es die Fassung für die Node-
 * Version holen, mit der npm läuft — deshalb hier ausdrücklich N-API 9.
 *
 *   node scripts/audify-napi9.cjs      (läuft auch als Teil von postinstall)
 */
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const plugin = path.join(__dirname, "..", "com.sorg.tone3000.sdPlugin");
const audify = path.join(plugin, "node_modules", "audify");
const bin = path.join(plugin, "node_modules", "prebuild-install", "bin.js");

if (!fs.existsSync(audify) || !fs.existsSync(bin)) {
	console.log("audify oder prebuild-install fehlt im .sdPlugin-Ordner — nichts zu tun.");
	process.exit(0);
}
execFileSync(process.execPath, [bin, "-r", "napi", "-t", "9", "--verbose"], { cwd: audify, stdio: "inherit" });
