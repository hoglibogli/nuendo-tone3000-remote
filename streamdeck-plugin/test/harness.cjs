/**
 * Kleinste Prüfhilfe für die Tests: PASS/FAIL je Zusicherung, Summe am Ende.
 */
"use strict";

const state = { section: "", failures: 0, passes: 0 };
// Beim Laden festgehalten: Die E2E-Tests leiten console.log des Scripts um.
const print = console.log.bind(console);

function section(name) {
	state.section = name;
	print(`\n--- ${name}`);
}

/** Vergleich über JSON: Arrays und Objekte werden inhaltlich verglichen. */
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		state.passes++;
		print(`PASS  ${label}`);
		return true;
	}
	state.failures++;
	print(`FAIL  ${label}\n        ist   ${a}\n        soll  ${e}`);
	return false;
}

/** Bedingung; detail erscheint nur beim Fehlschlag. */
function ok(label, cond, detail = "") {
	if (cond) {
		state.passes++;
		print(`PASS  ${label}`);
		return true;
	}
	state.failures++;
	print(`FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
	return false;
}

/** Bytes als Hex wie in protokoll.md. */
function hex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

/** "F0 7D 01 F7" → [0xf0, 0x7d, 0x01, 0xf7] */
function bytes(text) {
	return text.trim().split(/\s+/).map((h) => parseInt(h, 16));
}

module.exports = { state, section, check, ok, hex, bytes };
