/**
 * Filter und Puffer für das Stimmgerät, alles in doppelter Genauigkeit.
 *
 * Biquads nach dem Audio-EQ-Kochbuch (R. Bristow-Johnson), Direktform II
 * transponiert. Butterworth höherer Ordnung als Kette von Biquads mit den Güten
 * aus butterworthQ.
 */

/**
 * Winziger Gleichanteil am Eingang jedes Biquads: Bei reiner digitaler Stille
 * klängen die Zustände sonst bis in den denormalen Zahlenbereich ab, und der
 * rechnet auf x86 um ein Vielfaches langsamer. -400 dBFS stören keine Messung.
 */
const DENORMAL_GUARD = 1e-20;

export class Biquad {
	private z1 = 0;
	private z2 = 0;

	private constructor(
		private readonly b0: number,
		private readonly b1: number,
		private readonly b2: number,
		private readonly a1: number,
		private readonly a2: number,
	) {}

	/** Tiefpass 2. Ordnung; q = 1/√2 ergibt Butterworth. */
	static lowpass(sampleRate: number, cutoff: number, q = Math.SQRT1_2): Biquad {
		const w = (2 * Math.PI * cutoff) / sampleRate;
		const cos = Math.cos(w);
		const alpha = Math.sin(w) / (2 * q);
		const a0 = 1 + alpha;
		const b = (1 - cos) / a0;
		return new Biquad(b / 2, b, b / 2, (-2 * cos) / a0, (1 - alpha) / a0);
	}

	/** Hochpass 2. Ordnung; q = 1/√2 ergibt Butterworth. */
	static highpass(sampleRate: number, cutoff: number, q = Math.SQRT1_2): Biquad {
		const w = (2 * Math.PI * cutoff) / sampleRate;
		const cos = Math.cos(w);
		const alpha = Math.sin(w) / (2 * q);
		const a0 = 1 + alpha;
		const b = (1 + cos) / a0;
		return new Biquad(b / 2, -b, b / 2, (-2 * cos) / a0, (1 - alpha) / a0);
	}

	process(input: number): number {
		const x = input + DENORMAL_GUARD;
		const y = this.b0 * x + this.z1;
		this.z1 = this.b1 * x - this.a1 * y + this.z2;
		this.z2 = this.b2 * x - this.a2 * y;
		return y;
	}
}

/** Güten der Biquad-Stufen eines Butterworth-Filters gerader Ordnung. */
export function butterworthQ(order: number): number[] {
	const qs: number[] = [];
	for (let k = 0; k < order / 2; k++) qs.push(1 / (2 * Math.cos(((2 * k + 1) * Math.PI) / (2 * order))));
	return qs;
}

/** Butterworth-Tiefpass gerader Ordnung als Kette von Biquads. */
export function butterworthLowpass(sampleRate: number, cutoff: number, order: number): Biquad[] {
	return butterworthQ(order).map((q) => Biquad.lowpass(sampleRate, cutoff, q));
}

/**
 * Rauschäquivalente Bandbreite eines Butterworth-Tiefpasses (einseitig, in Hz):
 * fc · (π/2n) / sin(π/2n). 2. Ordnung: 1,11 fc; 4. Ordnung: 1,03 fc.
 */
export function butterworthNoiseBandwidth(cutoff: number, order: number): number {
	const a = Math.PI / (2 * order);
	return (cutoff * a) / Math.sin(a);
}

/**
 * Die letzten `length` Werte eines Stroms, stets zusammenhängend lesbar: Jeder Wert
 * steht doppelt im Speicher (pos und pos + length), das Fenster beginnt bei `start`.
 */
export class SlidingBuffer {
	readonly data: Float64Array;
	private pos = 0;
	/** Anzahl geschriebener Werte, höchstens length. */
	filled = 0;

	constructor(readonly length: number) {
		this.data = new Float64Array(2 * length);
	}

	push(v: number): void {
		this.data[this.pos] = v;
		this.data[this.pos + this.length] = v;
		this.pos = this.pos + 1 === this.length ? 0 : this.pos + 1;
		if (this.filled < this.length) this.filled++;
	}

	/** Index des ältesten Werts im Fenster; der neueste liegt bei start + length - 1. */
	get start(): number {
		return this.pos;
	}
}

/** Zielrate der Stufe 1 nach der Dezimation (44,1 und 48 kHz: Faktor 4). */
export const ANALYSIS_RATE = 12000;
/** Zweite Dezimation für die tiefen Töne (Bass): noch einmal Faktor 4, ~3 kHz. */
export const LOW_DECIMATION = 4;
/** Eckfrequenz des Hochpasses: Gleichanteil und Trittschall weg, A0 (27,5 Hz) bleibt. */
export const HIGHPASS_HZ = 20;

/**
 * Vorstufe: Hochpass 20 Hz (2. Ordnung) auf voller Rate, dann Tiefpass 4. Ordnung
 * bei 0,23 · Zielrate und Dezimation auf ~12 kHz für Stufe 1; daraus noch einmal
 * Tiefpass und Faktor 4 auf ~3 kHz für die Suche nach tiefen Tönen.
 */
export class FrontEnd {
	readonly decimation: number;
	readonly analysisRate: number;
	readonly lowRate: number;
	private readonly hp: Biquad;
	private readonly aa: Biquad[];
	private readonly aaLow: Biquad[];
	private count = 0;
	private lowCount = 0;
	/** Letzter Wert der zweiten Dezimation; NaN, wenn der letzte Aufruf keinen lieferte. */
	low = NaN;

	constructor(readonly sampleRate: number) {
		this.decimation = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE));
		this.analysisRate = sampleRate / this.decimation;
		this.lowRate = this.analysisRate / LOW_DECIMATION;
		this.hp = Biquad.highpass(sampleRate, HIGHPASS_HZ);
		this.aa = butterworthLowpass(sampleRate, 0.23 * this.analysisRate, 4);
		this.aaLow = butterworthLowpass(this.analysisRate, 0.23 * this.lowRate, 4);
	}

	/** Hochpass auf voller Rate. */
	highpass(x: number): number {
		return this.hp.process(x);
	}

	/**
	 * Tiefpass und Dezimation: liefert jeden decimation-ten Wert, sonst NaN.
	 * Erwartet den Ausgang von highpass. Kommt ein Wert, steht in `low` jeder
	 * vierte davon nach dem zweiten Tiefpass (sonst NaN).
	 */
	decimate(y: number): number {
		const v = this.aa[1].process(this.aa[0].process(y));
		if (++this.count < this.decimation) return NaN;
		this.count = 0;
		const l = this.aaLow[1].process(this.aaLow[0].process(v));
		if (++this.lowCount === LOW_DECIMATION) {
			this.lowCount = 0;
			this.low = l;
		} else {
			this.low = NaN;
		}
		return v;
	}
}
