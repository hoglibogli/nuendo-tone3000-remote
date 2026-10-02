/**
 * Prüfwerkzeug für den Audio-Eingang des Stimmgeräts (WASAPI, geteilter Modus).
 *
 *   node tools/audio-probe.cjs                                 Eingänge auflisten
 *   node tools/audio-probe.cjs --geraet "MADI (5+6)" --kanal 2 --sekunden 10
 *        Pegel des Kanals alle 0,5 s (Spitze und RMS in dBFS)
 *   node tools/audio-probe.cjs --geraet "MADI (5+6)" --kanal 2 --sekunden 90 --wav suchlauf/saiten.wav
 *        dazu den Kanal als 32-Bit-Float-WAV mitschreiben (Testmaterial)
 *
 * Gerätename als Teilstring, ohne Groß/klein. Kanal 1 = links, 2 = rechts des
 * Windows-Paars; "MADI (5+6)" Kanal 2 ist MADI 6.
 *
 * Läuft neben Nuendo: RME erlaubt WDM und ASIO gleichzeitig auf denselben Eingängen
 * (Handbuch MADIface Pro, Multi-Client). Das Paar muss in den RME-Einstellungen
 * unter "WDM Devices" freigegeben sein, sonst fehlt es in der Liste.
 *
 * Das Audio-Modul (audify, RtAudio) stammt aus dem .sdPlugin-Ordner des Plugins.
 */
const fs = require("fs");
const path = require("path");

const AUDIFY = path.join(__dirname, "..", "streamdeck-plugin", "com.sorg.tone3000.sdPlugin", "node_modules", "audify");
const { RtAudio, RtAudioApi } = require(AUDIFY);

const FLOAT32 = 0x10;

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
const inputs = rt.getDevices().filter((d) => d.inputChannels > 0);

const wanted = arg("--geraet");
if (!wanted) {
	console.log("WASAPI-Eingänge:");
	for (const d of inputs) {
		console.log(`  ${d.id}  ${d.name}  (${d.inputChannels} Kanäle, ${d.preferredSampleRate} Hz${d.isDefaultInput ? ", Standard" : ""})`);
	}
	process.exit(0);
}

const device = inputs.find((d) => d.name.toLowerCase().includes(wanted.toLowerCase()));
if (!device) {
	console.error(`Kein Eingang enthält "${wanted}". Freigegeben sind: ${inputs.map((d) => d.name).join(" | ")}`);
	process.exit(1);
}
const channel = Number(arg("--kanal") || 1);
const seconds = Number(arg("--sekunden") || 10);
const wavPath = arg("--wav");
if (!(channel >= 1 && channel <= device.inputChannels)) {
	console.error(`Kanal ${channel} gibt es bei "${device.name}" nicht (1..${device.inputChannels}).`);
	process.exit(1);
}

const rate = device.preferredSampleRate || 48000;
const nCh = device.inputChannels;
const recorded = [];
let block = [];
let blockLen = 0;
const reportEvery = Math.round(rate / 2);
let frames = 0;
let callbacks = 0;

const dbfs = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf");

function onInput(buf) {
	callbacks++;
	const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
	const n = data.length / nCh;
	const mono = new Float32Array(n);
	for (let i = 0; i < n; i++) mono[i] = data[i * nCh + (channel - 1)];
	if (wavPath) recorded.push(mono);
	block.push(mono);
	blockLen += n;
	frames += n;
	if (blockLen >= reportEvery) {
		let peak = 0;
		let sum = 0;
		for (const b of block) {
			for (let i = 0; i < b.length; i++) {
				const a = Math.abs(b[i]);
				if (a > peak) peak = a;
				sum += b[i] * b[i];
			}
		}
		const rms = Math.sqrt(sum / blockLen);
		const t = (frames / rate).toFixed(1).padStart(5);
		const bar = "#".repeat(Math.max(0, Math.min(40, Math.round((60 + 20 * Math.log10(peak || 1e-9)) * 40 / 60))));
		console.log(`${t} s  Spitze ${dbfs(peak).padStart(6)} dBFS  RMS ${dbfs(rms).padStart(6)} dBFS  ${bar}`);
		block = [];
		blockLen = 0;
	}
}

function writeWav(file, chunks) {
	const total = chunks.reduce((s, c) => s + c.length, 0);
	const data = Buffer.alloc(total * 4);
	let o = 0;
	for (const c of chunks) for (let i = 0; i < c.length; i++, o += 4) data.writeFloatLE(c[i], o);
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + data.length, 4);
	h.write("WAVE", 8);
	h.write("fmt ", 12);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(3, 20); // IEEE float
	h.writeUInt16LE(1, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * 4, 28);
	h.writeUInt16LE(4, 32);
	h.writeUInt16LE(32, 34);
	h.write("data", 36);
	h.writeUInt32LE(data.length, 40);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, Buffer.concat([h, data]));
	console.log(`WAV: ${file} (${(total / rate).toFixed(1)} s, ${rate} Hz, mono float)`);
}

console.log(`Eingang "${device.name}", Kanal ${channel} von ${nCh}, ${rate} Hz, ${seconds} s${wavPath ? ", Aufnahme nach " + wavPath : ""}`);
rt.openStream(null, { deviceId: device.id, nChannels: nCh, firstChannel: 0 }, FLOAT32, rate, Math.round(rate / 100), "tone3000-tuner-probe", onInput, null, 0, (type, msg) => console.error(`Audio-Fehler ${type}: ${msg}`));
rt.start();

setTimeout(() => {
	rt.stop();
	rt.closeStream();
	console.log(`Ende: ${callbacks} Blöcke, ${(frames / rate).toFixed(2)} s Audio empfangen.`);
	if (wavPath) writeWav(path.resolve(wavPath), recorded);
	process.exit(0);
}, seconds * 1000);
