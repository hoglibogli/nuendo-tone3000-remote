/**
 * Stufe 1 „Note finden": YIN (de Cheveigné & Kawahara 2002) auf dem dezimierten
 * Signal (~12 kHz), wie im TONE3000-Tuner (TunerDetector.cpp, MIT-Lizenz), aber mit
 * kürzerem Fenster und einer Prüfung gegen Oktavfehler.
 *
 *   d(τ)  = Σ (x[i] − x[i−τ])² über die neuesten W Werte (Bezugsfenster), verglichen
 *           mit den um τ älteren; der Puffer fasst W + τmax Werte.
 *   d'(τ) = d(τ) · τ / Σ_{j≤τ} d(j)  (kumulierte mittlere Normierung, CMNDF)
 *   Das erste τ im Suchbereich mit d' < Schwelle, verfeinert bis zum lokalen Minimum
 *   und parabolisch interpoliert. Klarheit = 1 − d'(τ).
 *
 * Oktavprüfung: Ist die Grundschwingung schwach (tiefe Saiten, Bass-DI, Steg-
 * Tonabnehmer), kann d' schon bei der halben Periode unter die Schwelle fallen — YIN
 * meldet dann die Oktave darüber. Bei einem echten Periodenfund ist d(2τ) etwa so
 * groß wie d(τ); liegt d nahe 2τ (oder 3τ) deutlich darunter, war τ nur ein Teil der
 * Periode. Verglichen wird d an den verfeinerten (gebrochenen) Verzögerungen, mit
 * kubisch interpoliertem Signal — nicht an ganzzahligen: Bei grober Abtastung (3 kHz,
 * A2 hat 27,5 Werte je Periode) läge sonst ein ganzzahliges 2τ zufällig genau auf dem
 * Minimum und τ eine halbe Abtastung daneben, und die Prüfung sähe eine Oktave tiefer.
 */

export interface PitchCandidate {
	/** Hz */
	frequency: number;
	/** 0 … 1, 1 − d'(τ) */
	clarity: number;
}

export interface YinOptions {
	/** Rate des Eingangs (dezimiert). */
	sampleRate: number;
	minFrequency: number;
	maxFrequency: number;
	/** Länge des Bezugsfensters W in Sekunden. */
	windowSeconds: number;
	/** Schwelle für d'. */
	threshold: number;
	/** Ohne Fund unter der Schwelle: globales Minimum nehmen, wenn d' darunter liegt (0 = nie). */
	fallback: number;
	/** Oktavprüfung über d(2τ), d(3τ). */
	octaveCheck: boolean;
}

/** d nahe m·τ muss unter diesem Bruchteil von d(τ) liegen, damit m·τ gilt. */
const OCTAVE_RATIO = 0.4;
/**
 * Oktavprüfung erst ab so vielen Werten je Periode: Darunter (12 kHz: über 500 Hz) ist
 * die Interpolation für die Obertöne zu grob, und hohe Saiten haben ohnehin einen
 * kräftigen Grundton.
 */
const OCTAVE_CHECK_MIN_TAU = 24;

export class Yin {
	/** W: Länge des Bezugsfensters in Werten. */
	readonly window: number;
	readonly tauMin: number;
	readonly tauMax: number;
	/** Benötigte Pufferlänge: W + τmax. */
	readonly length: number;
	private readonly d: Float64Array;
	private readonly c: Float64Array;

	constructor(private readonly o: YinOptions) {
		this.tauMax = Math.ceil(o.sampleRate / o.minFrequency);
		this.tauMin = Math.max(2, Math.floor(o.sampleRate / o.maxFrequency));
		this.window = Math.round(o.windowSeconds * o.sampleRate);
		this.length = this.window + this.tauMax;
		this.d = new Float64Array(this.tauMax + 1);
		this.c = new Float64Array(this.tauMax + 1);
	}

	/**
	 * Tonhöhe der `length` Werte ab x[offset] (ältester zuerst) oder null.
	 */
	analyze(x: Float64Array, offset: number): PitchCandidate | null {
		const W = this.window;
		const tMax = this.tauMax;
		const tMin = this.tauMin;
		const d = this.d;
		const c = this.c;
		const s = offset + tMax; // Beginn des Bezugsfensters

		let running = 0;
		c[0] = 1;
		for (let tau = 1; tau <= tMax; tau++) {
			const b = s - tau;
			let sum = 0;
			for (let i = 0; i < W; i++) {
				const delta = x[s + i] - x[b + i];
				sum += delta * delta;
			}
			d[tau] = sum;
			running += sum;
			c[tau] = running > 0 ? (sum * tau) / running : 1;
		}

		let best = -1;
		for (let tau = tMin; tau <= tMax; tau++) {
			if (c[tau] < this.o.threshold) {
				while (tau + 1 <= tMax && c[tau + 1] < c[tau]) tau++;
				best = tau;
				break;
			}
		}
		if (best < 0) {
			if (!(this.o.fallback > 0)) return null;
			let min = Infinity;
			for (let tau = tMin; tau <= tMax; tau++) {
				if (c[tau] < min) {
					min = c[tau];
					best = tau;
				}
			}
			if (best < 0 || min > this.o.fallback) return null;
		} else if (this.o.octaveCheck && best >= OCTAVE_CHECK_MIN_TAU) {
			best = this.checkOctave(x, s, best);
		}

		let tau = best;
		if (best > 1 && best < tMax) {
			const y0 = c[best - 1];
			const y1 = c[best];
			const y2 = c[best + 1];
			const den = y0 - 2 * y1 + y2;
			if (Math.abs(den) > 1e-12) tau = best + (0.5 * (y0 - y2)) / den;
		}
		return { frequency: this.o.sampleRate / tau, clarity: Math.min(1, Math.max(0, 1 - c[best])) };
	}

	/** Liegt d nahe 2τ oder 3τ deutlich unter d(τ), ist die Periode ein Vielfaches. */
	private checkOctave(x: Float64Array, s: number, best: number): number {
		for (let round = 0; round < 2; round++) {
			let moved = false;
			const here = this.fractionalDiff(x, s, this.refine(this.localMin(best, 1)));
			for (const m of [2, 3]) {
				const center = best * m;
				if (center + m + 3 > this.tauMax) break;
				const tm = this.localMin(center, m);
				if (this.fractionalDiff(x, s, this.refine(tm)) < OCTAVE_RATIO * here) {
					best = tm;
					moved = true;
					break;
				}
			}
			if (!moved) break;
		}
		// Auf das lokale Minimum von d' setzen (für Interpolation und Klarheit).
		const c = this.c;
		while (best + 1 < this.tauMax && c[best + 1] < c[best]) best++;
		while (best - 1 > this.tauMin && c[best - 1] < c[best]) best--;
		return best;
	}

	/** Kleinstes d im Bereich center ± radius. */
	private localMin(center: number, radius: number): number {
		const d = this.d;
		let tm = center;
		for (let t = Math.max(1, center - radius); t <= Math.min(this.tauMax - 1, center + radius); t++) {
			if (d[t] < d[tm]) tm = t;
		}
		return tm;
	}

	/** Gebrochene Verzögerung des Minimums: Parabel durch d(t−1), d(t), d(t+1). */
	private refine(t: number): number {
		const d = this.d;
		if (t <= 1 || t >= this.tauMax) return t;
		const den = d[t - 1] - 2 * d[t] + d[t + 1];
		if (!(den > 0)) return t;
		return t + Math.max(-0.5, Math.min(0.5, (0.5 * (d[t - 1] - d[t + 1])) / den));
	}

	/** d bei gebrochener Verzögerung, das ältere Signal kubisch (Catmull-Rom) interpoliert. */
	private fractionalDiff(x: Float64Array, s: number, tau: number): number {
		const W = this.window;
		const k = Math.floor(tau);
		// x[s + i − τ] liegt bei (j − 1) + t mit j = s + i − k, t = 1 − (τ − k);
		// Catmull-Rom über x[j−2], x[j−1], x[j], x[j+1].
		const t = 1 - (tau - k);
		const t2 = t * t;
		const t3 = t2 * t;
		const w0 = 0.5 * (-t3 + 2 * t2 - t);
		const w1 = 0.5 * (3 * t3 - 5 * t2 + 2);
		const w2 = 0.5 * (-3 * t3 + 4 * t2 + t);
		const w3 = 0.5 * (t3 - t2);
		let sum = 0;
		for (let i = 0; i < W; i++) {
			const j = s + i - k;
			const v = w0 * x[j - 2] + w1 * x[j - 1] + w2 * x[j] + w3 * x[j + 1];
			const delta = x[s + i] - v;
			sum += delta * delta;
		}
		return sum;
	}
}
