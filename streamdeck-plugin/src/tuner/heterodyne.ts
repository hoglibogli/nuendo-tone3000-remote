/**
 * Stufe 2 „Note verfolgen" wie ein Strobe-Stimmgerät.
 *
 * Ein Band mischt das Vollraten-Signal komplex mit einer festen Frequenz herunter
 * (z = x · e^{−jωn}), fasst je M Werte in einem Kasten zusammen (Dezimation auf
 * ~1 kHz; die Nullstellen des Kastens liegen genau auf den Faltungsfrequenzen) und
 * filtert tief (Butterworth 2. Ordnung). Was übrig bleibt, ist ein langsam drehender
 * Zeiger: Seine Drehgeschwindigkeit ist die Abweichung der Saite von der Mischfrequenz.
 *
 * Die Phase wird je Basisbandwert abgewickelt (die Abweichung bleibt weit unter der
 * halben Basisbandrate) und mit dem Betragsquadrat als Gewicht abgelegt. fitPhase
 * legt eine gewichtete Gerade durch ein Stück davon; die Steigung ist die
 * Frequenzabweichung, ihr Standardfehler die Messunsicherheit.
 *
 * Zwei Tiefpässe je Teilton hinter demselben Mischer: ein breiter (schwingt nach dem
 * Anschlag schnell ein, für die erste Anzeige) und ein schmaler (±50 Cent, bester
 * Rauschabstand, für den langen Ausklang). Das Einschwingen verbiegt die Phase umso
 * länger, je schmaler das Filter ist — bei B0 dauerte es mit dem schmalen allein über
 * eine Sekunde.
 *
 * Vor den Tiefpässen läuft in den Teiltonbändern ein gleitender Mittelwert über genau
 * eine Periode der Note (Kamm): Seine Nullstellen liegen auf den Abständen der
 * Nachbarteiltöne (±f, ±2f …). Ohne ihn ließe das Filter einen um 10 dB stärkeren
 * Nachbarteilton (Bass: 2. Teilton) als Phasenwelligkeit durch — harmlos für die
 * Steigung, aber sie bläht den Restfehler und damit die geschätzte Unsicherheit auf.
 *
 * Nachbarbänder (ohne Teiltöne der Saite) schätzen das Rauschen: Mittelwerte von
 * |z|² je Block (10 ms), davon der Median über die letzten 1,5 s. Blöcke, in die das
 * Einschwingen nach einem Anschlag fällt, zählen nicht (exclude); ein gleitender
 * Mittelwert schleppte den breitbandigen Anschlag sekundenlang mit.
 */
import { butterworthLowpass, butterworthNoiseBandwidth, type Biquad } from "./filters";

export interface BandSpec {
	/** Mischfrequenz in Hz. */
	frequency: number;
	/** Eckfrequenz des (schmalen) Tiefpasses im Basisband (Hz). */
	cutoff: number;
	/** Ordnung der Butterworth-Tiefpässe (gerade). */
	order: number;
	/** Eckfrequenz eines zweiten, breiten Tiefpasses (Hz); fehlt = nur der schmale. */
	wideCutoff?: number;
	/** Nachbarband: Blockmittel für die Rauschschätzung sammeln. */
	noise?: boolean;
	/** Länge des Kamms (gleitender Mittelwert im Basisband) in Werten; 1 = ohne. */
	comb?: number;
}

/**
 * Median eines Blockmittels von |z|² im Verhältnis zum Mittelwert: Nach dem schmalen
 * Filter ist ein 10-ms-Block kaum mehr als ein komplexer Gaußwert, |z|² also
 * exponentialverteilt mit Median ln 2 · Mittelwert.
 */
const MEDIAN_TO_MEAN = Math.LN2;

/** Ein Tiefpass hinter dem Mischer mit abgewickelter Phase und Leistung je Basisbandwert. */
export class Stream {
	/** Abgewickelte Phase je Basisbandwert (Ring). */
	readonly phase: Float64Array;
	/** |z|² je Basisbandwert (Ring). */
	readonly power: Float64Array;
	/** Rauschäquivalente Bandbreite, zweiseitig (komplexes Basisband), Hz. */
	readonly noiseBandwidth: number;
	private readonly lpRe: Biquad[];
	private readonly lpIm: Biquad[];
	private wrapped = 0;
	private unwrapped = 0;

	constructor(
		rate: number,
		readonly cutoff: number,
		order: number,
		readonly capacity: number,
	) {
		this.noiseBandwidth = 2 * butterworthNoiseBandwidth(cutoff, order);
		this.lpRe = butterworthLowpass(rate, cutoff, order);
		this.lpIm = butterworthLowpass(rate, cutoff, order);
		this.phase = new Float64Array(capacity);
		this.power = new Float64Array(capacity);
	}

	/** Basisbandwert filtern und unter Index k ablegen; liefert |z|². */
	put(re: number, im: number, k: number): number {
		for (let i = 0; i < this.lpRe.length; i++) {
			re = this.lpRe[i].process(re);
			im = this.lpIm[i].process(im);
		}
		const p = re * re + im * im;
		const ph = Math.atan2(im, re);
		let dph = ph - this.wrapped;
		if (dph > Math.PI) dph -= 2 * Math.PI;
		else if (dph < -Math.PI) dph += 2 * Math.PI;
		this.unwrapped += dph;
		this.wrapped = ph;
		const slot = k % this.capacity;
		this.phase[slot] = this.unwrapped;
		this.power[slot] = p;
		return p;
	}
}

export class Band {
	readonly frequency: number;
	/** Schmaler Tiefpass (immer da). */
	readonly narrow: Stream;
	/** Breiter Tiefpass für das schnelle Einschwingen; null = keiner. */
	readonly wide: Stream | null;
	/** Erzeugte Basisbandwerte; der neueste hat den Index count − 1. */
	count = 0;

	private c = 1;
	private s = 0;
	private readonly cd: number;
	private readonly sd: number;
	private accRe = 0;
	private accIm = 0;
	private readonly inv: number;

	// Kamm
	private readonly combRe: Float64Array | null;
	private readonly combIm: Float64Array | null;
	private combSumRe = 0;
	private combSumIm = 0;
	private combPos = 0;
	private combWraps = 0;

	// Rauschschätzung (nur Nachbarbänder)
	private readonly blocks: Float64Array | null;
	private readonly blockStarts: Float64Array | null;
	private readonly scratch: Float64Array | null;
	private blockSum = 0;
	private blockFill = 0;
	private blockCount = 0;
	private readonly excluded: [number, number][] = [];
	private lastNoise = NaN;

	constructor(
		spec: BandSpec,
		inputRate: number,
		decimation: number,
		readonly capacity: number,
		private readonly blockLength: number,
		blockCount: number,
		/** Blöcke vor diesem Basisbandindex zählen nicht (Filter schwingt noch ein). */
		private readonly settleCount: number,
	) {
		this.frequency = spec.frequency;
		const rate = inputRate / decimation;
		const w = (2 * Math.PI * spec.frequency) / inputRate;
		this.cd = Math.cos(w);
		this.sd = Math.sin(w);
		this.inv = 1 / decimation;
		this.narrow = new Stream(rate, spec.cutoff, spec.order, capacity);
		this.wide =
			spec.wideCutoff !== undefined && spec.wideCutoff > spec.cutoff * 1.05
				? new Stream(rate, Math.min(spec.wideCutoff, 0.4 * rate), spec.order, capacity)
				: null;
		this.blocks = spec.noise ? new Float64Array(blockCount) : null;
		this.blockStarts = spec.noise ? new Float64Array(blockCount) : null;
		this.scratch = spec.noise ? new Float64Array(blockCount) : null;
		const comb = Math.max(1, Math.round(spec.comb ?? 1));
		this.combRe = comb > 1 ? new Float64Array(comb) : null;
		this.combIm = comb > 1 ? new Float64Array(comb) : null;
	}

	/** Einen Vollratenwert mischen und in den Kasten legen. */
	mix(x: number): void {
		const c = this.c;
		const s = this.s;
		this.accRe += x * c;
		this.accIm -= x * s;
		this.c = c * this.cd - s * this.sd;
		this.s = s * this.cd + c * this.sd;
	}

	/** Kasten schließen: Basisbandwert durch Kamm und Tiefpässe, Phase abwickeln, ablegen. */
	emit(): void {
		let re = this.accRe * this.inv;
		let im = this.accIm * this.inv;
		this.accRe = 0;
		this.accIm = 0;
		const cr = this.combRe;
		const ci = this.combIm;
		if (cr !== null && ci !== null) {
			const k = this.combPos;
			this.combSumRe += re - cr[k];
			this.combSumIm += im - ci[k];
			cr[k] = re;
			ci[k] = im;
			this.combPos = k + 1 === cr.length ? 0 : k + 1;
			// Rundungsfehler der laufenden Summe gelegentlich verwerfen.
			if (this.combPos === 0 && (++this.combWraps & 63) === 0) {
				let a = 0;
				let b = 0;
				for (let j = 0; j < cr.length; j++) {
					a += cr[j];
					b += ci[j];
				}
				this.combSumRe = a;
				this.combSumIm = b;
			}
			re = this.combSumRe / cr.length;
			im = this.combSumIm / cr.length;
		}
		const p = this.narrow.put(re, im, this.count);
		if (this.wide !== null) this.wide.put(re, im, this.count);
		this.count++;
		if (this.blocks !== null && this.count > this.settleCount) {
			this.blockSum += p;
			if (++this.blockFill === this.blockLength) {
				const slot = this.blockCount % this.blocks.length;
				this.blocks[slot] = this.blockSum / this.blockLength;
				this.blockStarts![slot] = this.count - this.blockLength;
				this.blockCount++;
				this.blockSum = 0;
				this.blockFill = 0;
			}
		}
		// Der Zeiger des Mischers wird per Drehung fortgeschrieben; Betrag nachziehen.
		const g = 1.5 - 0.5 * (this.c * this.c + this.s * this.s);
		this.c *= g;
		this.s *= g;
	}

	/**
	 * Rauschleistung |z|² (schmaler Tiefpass) aus dem Median der Blockmittel, auf den
	 * Mittelwert umgerechnet; NaN, solange kein eingeschwungener, nicht ausgeschlossener
	 * Block vorlag.
	 */
	noisePower(): number {
		const b = this.blocks;
		const starts = this.blockStarts;
		const s = this.scratch;
		if (b === null || starts === null || s === null || this.blockCount === 0) return NaN;
		const total = Math.min(this.blockCount, b.length);
		let n = 0;
		for (let i = 0; i < total; i++) {
			if (!this.isExcluded(starts[i])) s[n++] = b[i];
		}
		// Alles im Fenster ausgeschlossen (frisch nach einem Anschlag): letzte Schätzung behalten.
		if (n === 0) return this.lastNoise;
		const view = s.subarray(0, n).sort();
		const median = n % 2 === 1 ? view[(n - 1) / 2] : 0.5 * (view[n / 2 - 1] + view[n / 2]);
		this.lastNoise = median / MEDIAN_TO_MEAN;
		return this.lastNoise;
	}

	/** Blöcke ab Basisbandindex from bis vor to nicht für die Rauschschätzung verwenden. */
	exclude(from: number, to: number): void {
		this.excluded.push([from, to]);
		if (this.excluded.length > 8) this.excluded.shift();
	}

	private isExcluded(start: number): boolean {
		for (const [a, b] of this.excluded) if (start + this.blockLength > a && start < b) return true;
		return false;
	}

	/** Mittlere Leistung der letzten n Basisbandwerte, aus dem breiten Tiefpass (reagiert schneller), sonst dem schmalen. */
	recentPower(n: number): number {
		const st = this.wide ?? this.narrow;
		const to = this.count - 1;
		const from = Math.max(0, to - n + 1);
		if (to < from) return 0;
		let sum = 0;
		for (let i = from; i <= to; i++) sum += st.power[i % this.capacity];
		return sum / (to - from + 1);
	}
}

/**
 * Mehrere Bänder mit gemeinsamem Kasten-Takt. startIndex ist der Vollraten-Index
 * des ersten gemischten Werts; Basisbandwert b deckt die Vollratenwerte
 * startIndex + b·M … startIndex + (b+1)·M − 1 ab.
 */
export class BandBank {
	readonly bands: Band[];
	readonly rate: number;
	private n = 0;

	constructor(
		specs: BandSpec[],
		inputRate: number,
		readonly decimation: number,
		capacity: number,
		noise: { blockSeconds: number; windowSeconds: number; settleSeconds: number },
		readonly startIndex: number,
	) {
		this.rate = inputRate / decimation;
		const blockLength = Math.max(1, Math.round(noise.blockSeconds * this.rate));
		const blockCount = Math.max(1, Math.round(noise.windowSeconds / noise.blockSeconds));
		const settle = Math.round(noise.settleSeconds * this.rate);
		this.bands = specs.map((s) => new Band(s, inputRate, decimation, capacity, blockLength, blockCount, settle));
	}

	feed(x: number): void {
		const b = this.bands;
		for (let i = 0; i < b.length; i++) b[i].mix(x);
		if (++this.n === this.decimation) {
			this.n = 0;
			for (let i = 0; i < b.length; i++) b[i].emit();
		}
	}

	/** Erster Basisbandindex, der den Vollraten-Index `index` oder Späteres abdeckt. */
	basebandIndex(index: number): number {
		return Math.max(0, Math.floor((index - this.startIndex) / this.decimation));
	}
}

export interface PhaseFit {
	/** Steigung in rad je Basisbandwert. */
	slope: number;
	/** Standardfehler der Steigung, gleiche Einheit. */
	se: number;
	/** Mittlere Leistung |z|² im Fenster. */
	power: number;
	/** Restfehler im Verhältnis zum Erwarteten bei reinem Rauschen (≈ 1; groß = Störung). */
	excess: number;
	samples: number;
}

/**
 * Gewichtete Gerade durch die abgewickelte Phase der Werte [from, to] eines Streams.
 *
 * Gewicht |z|²: Die Phasenstreuung eines Werts ist bei Rauschleistung N etwa
 * N / (2|z|²), das Gewicht ist also genau die inverse Varianz (bis auf N/2).
 * Standardfehler der Steigung: √((N/2) · κ / Σ w (t − t̄)²); κ = Basisbandrate /
 * Rauschbandbreite gleicht aus, dass benachbarte Werte nach dem Tiefpass nicht
 * unabhängig sind. Liegt der Restfehler über dem Erwarteten (Schwebung, Brumm im
 * Band, Phasensprung), wächst der Standardfehler mit.
 */
export function fitPhase(stream: Stream, from: number, to: number, noisePower: number, rate: number): PhaseFit | null {
	const first = Math.max(from, to - stream.capacity + 1);
	const n = to - first + 1;
	if (n < 4) return null;
	const cap = stream.capacity;
	const ph = stream.phase;
	const pw = stream.power;
	const ref = ph[to % cap];
	let sw = 0;
	let st = 0;
	let stt = 0;
	let sp = 0;
	let stp = 0;
	for (let i = first; i <= to; i++) {
		const k = i % cap;
		const w = pw[k];
		const t = i - to;
		const p = ph[k] - ref;
		sw += w;
		st += w * t;
		stt += w * t * t;
		sp += w * p;
		stp += w * t * p;
	}
	const det = sw * stt - st * st;
	if (!(sw > 0) || !(det > 0)) return null;
	const slope = (sw * stp - st * sp) / det;
	const icpt = (sp - slope * st) / sw;
	let rss = 0;
	for (let i = first; i <= to; i++) {
		const k = i % cap;
		const r = ph[k] - ref - icpt - slope * (i - to);
		rss += pw[k] * r * r;
	}
	const sxx = det / sw;
	const half = Math.max(noisePower, 1e-300) / 2;
	const kappa = Math.max(1, rate / stream.noiseBandwidth);
	const excess = rss / (half * n);
	const variance = ((half * kappa) / sxx) * Math.max(1, excess);
	return { slope, se: Math.sqrt(variance), power: sw / n, excess, samples: n };
}
