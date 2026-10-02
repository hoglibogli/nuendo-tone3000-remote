/**
 * WAV lesen (16/24/32-Bit-PCM oder 32-Bit-Float), genau ein Kanal — nie eine Summe.
 * Für die Ersatzquelle des Workers (Tests, Auswertung aufgenommener Saiten).
 */
import { readFileSync } from "node:fs";

export interface WavData {
	samples: Float32Array;
	rate: number;
	channels: number;
}

export function readWav(file: string, channel = 0): WavData {
	const buf = readFileSync(file);
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file}: keine WAV-Datei`);
	let off = 12;
	let tag = 0;
	let channels = 0;
	let rate = 0;
	let bits = 0;
	let data: Buffer | null = null;
	while (off + 8 <= buf.length) {
		const id = buf.toString("ascii", off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		if (id === "fmt ") {
			tag = buf.readUInt16LE(off + 8);
			if (tag === 0xfffe && size >= 40) tag = buf.readUInt16LE(off + 8 + 24); // WAVE_FORMAT_EXTENSIBLE
			channels = buf.readUInt16LE(off + 10);
			rate = buf.readUInt32LE(off + 12);
			bits = buf.readUInt16LE(off + 22);
		} else if (id === "data") {
			data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
		}
		off += 8 + size + (size & 1);
	}
	if (data === null || channels === 0) throw new Error(`${file}: fmt- oder data-Block fehlt`);
	if (channel < 0 || channel >= channels) throw new Error(`${file}: Kanal ${channel + 1} gibt es nicht (1 … ${channels})`);
	const bytes = bits / 8;
	const frame = bytes * channels;
	const n = Math.floor(data.length / frame);
	const out = new Float32Array(n);
	const d = data;
	const at = (i: number): number => i * frame + channel * bytes;
	if (tag === 3 && bits === 32) for (let i = 0; i < n; i++) out[i] = d.readFloatLE(at(i));
	else if (tag === 1 && bits === 16) for (let i = 0; i < n; i++) out[i] = d.readInt16LE(at(i)) / 32768;
	else if (tag === 1 && bits === 24) for (let i = 0; i < n; i++) out[i] = d.readIntLE(at(i), 3) / 8388608;
	else if (tag === 1 && bits === 32) for (let i = 0; i < n; i++) out[i] = d.readInt32LE(at(i)) / 2147483648;
	else throw new Error(`${file}: Format ${tag}/${bits} Bit wird nicht unterstützt`);
	return { samples: out, rate, channels };
}
