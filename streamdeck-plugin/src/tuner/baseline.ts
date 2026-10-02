/**
 * Breitband-Basislinie zum Vergleich: das Verfahren des TONE3000-Tuners
 * (TunerDetector.cpp und TunerFeed.h, v0.0.11, MIT-Lizenz), nachgebaut.
 *
 *   - Dezimation durch Mitteln auf ~12 kHz, Fenster 2048 Werte (~170 ms)
 *   - alle 25 ms YIN, Schwelle 0,15; ohne Fund das globale Minimum bis d' = 0,3;
 *     Suchbereich 28 … 1500 Hz
 *   - feste Pegelschwelle: Fenster-RMS unter -55 dBFS → kein Ton
 *   - Anzeige nur bei Klarheit > 0,5; Cent geglättet (neu = alt · 0,7 + Messung · 0,3
 *     je 25 ms); Note ohne Hysterese
 *   - nach dem letzten gültigen Wert 900 ms halten, dann Stille
 *
 * Gleiche Schnittstelle wie TunerEngine (push / reading), damit die Auswertung
 * beide gleich behandeln kann. „tracking" heißt hier: gültige Messung in den letzten
 * 50 ms; danach „held" bis zum Ende der Haltezeit.
 */
import { HOP_SECONDS, IN_TUNE_CENTS, SILENT_NOTE, type TunerReading } from "./engine";
import { DEFAULT_A4, frequencyOf, midiOf, noteName, octaveOf } from "./notes";
import { Yin } from "./yin";

export interface BaselineOptions {
	a4?: number;
	germanH?: boolean;
	/** Pegelschwelle (Fenster-RMS) in dBFS (-55). */
	gateDb?: number;
	/** Mindestklarheit (0,5). */
	minClarity?: number;
	/** Haltezeit in s (0,9). */
	holdSeconds?: number;
}

const WINDOW = 2048;
const INTERVAL_SECONDS = 0.025;

export class BaselineTuner {
	private readonly decimation: number;
	private readonly yin: Yin;
	private readonly ring: Float32Array;
	private readonly window: Float64Array;
	private index = 0;
	private readonly interval: number;
	private nextAnalysis: number;
	private readonly gate: number;
	private readonly minClarity: number;
	private readonly holdSamples: number;
	private readonly a4: number;
	private readonly germanH: boolean;

	private has = false;
	private note = 0;
	private cents = 0;
	private clarity = 0;
	private lastValid = -Infinity;
	private levelDb = -Infinity;

	constructor(
		readonly sampleRate: number,
		options: BaselineOptions = {},
	) {
		this.decimation = Math.max(1, Math.min(16, Math.round(sampleRate / 12000)));
		const rate = sampleRate / this.decimation;
		const tauMax = Math.min(Math.floor(rate / 28), WINDOW / 2 - 1);
		this.yin = new Yin({
			sampleRate: rate,
			minFrequency: rate / tauMax,
			maxFrequency: 1500,
			windowSeconds: (WINDOW - tauMax) / rate,
			threshold: 0.15,
			fallback: 0.3,
			octaveCheck: false,
		});
		this.ring = new Float32Array(this.yin.length * this.decimation);
		this.window = new Float64Array(this.yin.length);
		this.interval = Math.round(INTERVAL_SECONDS * sampleRate);
		this.nextAnalysis = this.interval;
		this.gate = Math.pow(10, (options.gateDb ?? -55) / 20);
		this.minClarity = options.minClarity ?? 0.5;
		this.holdSamples = Math.round((options.holdSeconds ?? 0.9) * sampleRate);
		this.a4 = options.a4 ?? DEFAULT_A4;
		this.germanH = options.germanH ?? false;
	}

	push(block: ArrayLike<number>): void {
		const ring = this.ring;
		const len = ring.length;
		for (let i = 0; i < block.length; i++) {
			ring[this.index % len] = block[i];
			this.index++;
			if (this.index === this.nextAnalysis) {
				this.nextAnalysis += this.interval;
				this.analyze();
			}
		}
	}

	private analyze(): void {
		const d = this.decimation;
		const n = this.window.length;
		const len = this.ring.length;
		const start = this.index - n * d;
		let sum = 0;
		for (let i = 0; i < n; i++) {
			let acc = 0;
			for (let k = 0; k < d; k++) {
				const j = start + i * d + k;
				acc += j >= 0 ? this.ring[j % len] : 0;
			}
			const v = acc / d;
			this.window[i] = v;
			sum += v * v;
		}
		const rms = Math.sqrt(sum / n);
		this.levelDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
		const p = rms >= this.gate ? this.yin.analyze(this.window, 0) : null;
		if (p && p.clarity > this.minClarity) {
			const midi = midiOf(p.frequency, this.a4);
			const note = Math.round(midi);
			const cents = 100 * (midi - note);
			this.cents = this.has ? this.cents * 0.7 + cents * 0.3 : cents;
			this.note = note;
			this.clarity = p.clarity;
			this.has = true;
			this.lastValid = this.index;
		}
	}

	reading(): TunerReading {
		const age = this.index - this.lastValid;
		if (!this.has || age >= this.holdSamples) {
			return {
				noteName: SILENT_NOTE,
				octave: 0,
				cents: 0,
				frequency: 0,
				state: "silent",
				inTune: false,
				clarity: 0,
				level: this.levelDb,
				midi: 0,
			};
		}
		const fresh = age < 5 * HOP_SECONDS * this.sampleRate;
		return {
			noteName: noteName(this.note, this.germanH),
			octave: octaveOf(this.note),
			cents: this.cents,
			frequency: frequencyOf(this.note + this.cents / 100, this.a4),
			state: fresh ? "tracking" : "held",
			inTune: Math.abs(this.cents) <= IN_TUNE_CENTS,
			clarity: this.clarity,
			level: this.levelDb,
			midi: this.note,
		};
	}
}
