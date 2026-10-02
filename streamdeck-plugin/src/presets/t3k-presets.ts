/**
 * Die TONE3000-Presets, wie TONE3000 sie in seiner Liste führt: eigene und Werkspresets.
 *
 * Gewählt wird ein Preset per Namen (Protokoll 3, 0x12; Groß/klein zählt), deshalb
 * zählt hier der Name aus der Datei, nicht der Dateiname — eigene Presets heißen auf
 * der Platte nur nach ihrer ID (18e5dfd1….t3kpreset).
 *
 * Orte (TONE3000 0.0.11, am 2026-10-02 nachgesehen):
 * - eigene:  %APPDATA%\TONE3000\Presets\*.t3kpreset
 * - Werk:    %PROGRAMDATA%\TONE3000\Presets\Factory\*.t3kpreset
 * Beide werden bis drei Ebenen tief durchsucht, falls TONE3000 Unterordner anlegt.
 *
 * Dateiformat, zwei Fassungen, beide ein binärer JUCE-ValueTree (writeToStream):
 * - "T3KB" + Baum "T3KPreset" — so liegen die eigenen Presets (ältere Fassung).
 * - "T3KH" + uint32 LE Länge + Kopfbaum "T3KPresetHeader" (id, name) + Baum
 *   "T3KPreset" — so liegen die Werkspresets.
 * Baum: Typname (UTF-8, nullterminiert), compressedInt Anzahl Eigenschaften, je
 * Eigenschaft Name + var, dann compressedInt Anzahl Kinder und die Kinder. var:
 * compressedInt Größe, dann ein Typbyte (5 = String) und die Daten. Gelesen werden
 * nur die Eigenschaften des Wurzelbaums; die Kinder (Modelle, bis 4 MB) nicht.
 *
 * Rückfall, falls sich das Format ändert: die Bytefolge „name\0" mit String-var
 * suchen; danach der Dateiname, sofern er keine bloße ID ist.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

export interface T3kPreset {
	name: string;
	source: "user" | "factory";
	file: string;
}

export type PresetDirs = { user: string[]; factory: string[] };

const EXTENSION = ".t3kpreset";
const MAX_DEPTH = 3;
/** Der Kopf mit dem Namen steht in den ersten paar hundert Bytes. */
const HEAD_BYTES = 64 * 1024;

const VAR_STRING = 5;

/** Wo TONE3000 seine Presets ablegt. */
export function defaultPresetDirs(): PresetDirs {
	if (process.platform === "darwin") {
		return {
			user: [join(homedir(), "Library", "Application Support", "TONE3000", "Presets")],
			factory: [join("/Library", "Application Support", "TONE3000", "Presets")],
		};
	}
	const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	const programData = process.env.PROGRAMDATA ?? process.env.ALLUSERSPROFILE ?? "C:\\ProgramData";
	return {
		user: [join(appData, "TONE3000", "Presets")],
		factory: [join(programData, "TONE3000", "Presets")],
	};
}

/**
 * Alle Presets: eigene zuerst (alphabetisch, ohne Groß/klein), dann die Werkspresets
 * ebenso. Jeder Name nur einmal — bei Gleichstand gewinnt das eigene Preset, denn
 * TONE3000 wählt ohnehin nach dem Namen. Wirft nicht; unlesbare Ordner und Dateien
 * fallen still heraus.
 */
export function listPresets(dirs: PresetDirs = defaultPresetDirs()): T3kPreset[] {
	const seen = new Set<string>();
	const result: T3kPreset[] = [];
	const groups: [T3kPreset["source"], string[]][] = [
		["user", dirs.user],
		["factory", dirs.factory],
	];
	for (const [source, roots] of groups) {
		const found: T3kPreset[] = [];
		for (const root of roots) {
			for (const file of findPresetFiles(root, 0)) {
				const name = presetNameFromFile(file);
				if (name) found.push({ name, source, file });
			}
		}
		found.sort(byName);
		for (const preset of found) {
			if (seen.has(preset.name)) continue;
			seen.add(preset.name);
			result.push(preset);
		}
	}
	return result;
}

const collator = new Intl.Collator("de", { sensitivity: "base", numeric: true });

function byName(a: T3kPreset, b: T3kPreset): number {
	return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.file < b.file ? -1 : 1);
}

function findPresetFiles(dir: string, depth: number): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (depth < MAX_DEPTH) files.push(...findPresetFiles(full, depth + 1));
		} else if (entry.isFile() && extname(entry.name).toLowerCase() === EXTENSION) {
			files.push(full);
		}
	}
	return files;
}

/** Name aus der Datei; Rückfall Dateiname, außer er ist nur eine ID. */
export function presetNameFromFile(file: string): string | null {
	let name: string | null = null;
	try {
		const head = readHead(file, HEAD_BYTES);
		name = readPresetName(head);
		if (name === null && head.length === HEAD_BYTES && statSync(file).size > HEAD_BYTES) {
			name = readPresetName(readFileSync(file));
		}
	} catch {
		name = null;
	}
	if (name !== null) return name;
	const stem = basename(file, extname(file)).trim();
	if (stem === "" || /^[0-9a-f]{32}$/i.test(stem) || /^[0-9a-f-]{36}$/i.test(stem)) return null;
	return stem;
}

function readHead(file: string, bytes: number): Buffer {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const got = readSync(fd, buf, 0, bytes, 0);
		return buf.subarray(0, got);
	} finally {
		closeSync(fd);
	}
}

/** Presetname aus dem Dateiinhalt (oder seinem Anfang); null, wenn nicht zu finden. */
export function readPresetName(data: Buffer): string | null {
	const magic = data.subarray(0, 4).toString("latin1");
	const starts: number[] = [];
	if (magic === "T3KH" && data.length >= 8) {
		const headerLength = data.readUInt32LE(4);
		starts.push(8); // Kopfbaum mit id und name
		let main = 8 + headerLength;
		if (data.subarray(main, main + 4).toString("latin1") === "T3KB") main += 4;
		starts.push(main);
	} else if (magic === "T3KB") {
		starts.push(4);
	} else {
		starts.push(0);
	}
	for (const start of starts) {
		const props = readRootProperties(data, start);
		const name = props?.get("name");
		if (typeof name === "string" && name.trim() !== "") return name.trim();
	}
	return scanForName(data);
}

/** Liest compressedInt nach JUCE: Längenbyte (Bit 7 = negativ), dann bis 4 Bytes little endian. */
class Reader {
	constructor(
		private readonly buf: Buffer,
		public pos: number,
	) {}

	byte(): number {
		if (this.pos >= this.buf.length) throw new RangeError("Ende der Daten");
		return this.buf[this.pos++];
	}

	compressedInt(): number {
		const head = this.byte();
		const count = head & 0x7f;
		if (count > 4) throw new RangeError("compressedInt zu lang");
		let value = 0;
		for (let i = 0; i < count; i++) value += this.byte() * 2 ** (8 * i);
		return head & 0x80 ? -value : value;
	}

	/** Nullterminierter UTF-8-String. */
	string(): string {
		const end = this.buf.indexOf(0, this.pos);
		if (end < 0) throw new RangeError("String ohne Ende");
		const s = this.buf.subarray(this.pos, end).toString("utf8");
		this.pos = end + 1;
		return s;
	}

	bytes(count: number): Buffer {
		if (count < 0 || this.pos + count > this.buf.length) throw new RangeError("Ende der Daten");
		const b = this.buf.subarray(this.pos, this.pos + count);
		this.pos += count;
		return b;
	}
}

type PropValue = string | number | boolean | null;

/** Eigenschaften des Baums ab start (ohne Kinder); null, wenn es kein gültiger Baum ist. */
export function readRootProperties(data: Buffer, start: number): Map<string, PropValue> | null {
	try {
		const r = new Reader(data, start);
		const type = r.string();
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(type)) return null;
		const count = r.compressedInt();
		if (count < 0 || count > 1000) return null;
		const props = new Map<string, PropValue>();
		for (let i = 0; i < count; i++) {
			const key = r.string();
			const size = r.compressedInt();
			if (size < 0) return null;
			if (size === 0) {
				props.set(key, null);
				continue;
			}
			const raw = r.bytes(size);
			props.set(key, decodeVar(raw));
		}
		return props;
	} catch {
		return null;
	}
}

/** var-Inhalt: Typbyte + Daten. Nur was hier gebraucht wird; Rest als null. */
function decodeVar(raw: Buffer): PropValue {
	const marker = raw[0];
	const body = raw.subarray(1);
	switch (marker) {
		case 1: // int
			return body.length >= 4 ? body.readInt32LE(0) : null;
		case 2: // true
			return true;
		case 3: // false
			return false;
		case 4: // double
			return body.length >= 8 ? body.readDoubleLE(0) : null;
		case VAR_STRING: {
			const end = body.indexOf(0);
			return body.subarray(0, end < 0 ? body.length : end).toString("utf8");
		}
		default:
			return null;
	}
}

/** Rückfall: erste Eigenschaft „name" mit String-Wert irgendwo in den Daten. */
function scanForName(data: Buffer): string | null {
	const needle = Buffer.from("name\0", "latin1");
	let at = data.indexOf(needle);
	while (at >= 0) {
		// Der erste Treffer mit String-Wert ist in beiden Fassungen der Name des Wurzelbaums.
		try {
			const r = new Reader(data, at + needle.length);
			const size = r.compressedInt();
			if (size > 1 && size < 1024) {
				const raw = r.bytes(size);
				if (raw[0] === VAR_STRING) {
					const value = decodeVar(raw);
					if (typeof value === "string" && value.trim() !== "") return value.trim();
				}
			}
		} catch {
			// weiter suchen
		}
		at = data.indexOf(needle, at + 1);
	}
	return null;
}
