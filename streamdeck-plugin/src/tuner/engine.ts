/**
 * Tonhöhenerkennung für das Stimmgerät (Gitarre, Bariton, Bass; chromatisch
 * 27,5 Hz … 1,4 kHz), rein vom Datenstrom getrieben: kein Timer, keine Uhr. push()
 * verarbeitet Abtastwerte genau eines Mono-Kanals (nie eine Summe), reading() gibt
 * den Stand nach dem letzten vollständigen 10-ms-Schritt. Gleiche Eingabe in
 * beliebigen Blockgrößen ergibt dieselben Werte.
 *
 * Je Abtastwert (volle Rate fs):
 *   Hochpass 20 Hz → Verlauf (1,5 s) → Bänder der Stufe 2 (falls aktiv)
 *   → Tiefpass, Dezimation auf ~12 kHz → Fenster „hoch" der Stufe 1
 *   → Tiefpass, Dezimation auf ~3 kHz → Fenster „tief" der Stufe 1.
 *
 * Alle 10 ms:
 *   1. Pegel und Anschlag: Spitzenhüllkurve gegen die drei vorigen Schritte (+6 dB) und
 *      gegen das Grundrauschen (Minimum der letzten 5 s, +20 dB) — nur Verhältnisse,
 *      keine feste Pegelschwelle.
 *   2. Stufe 1 „Note finden" (yin.ts), zweistufig:
 *        hoch  12 kHz, 58 Hz … 1,4 kHz, Bezugsfenster 35 ms (Puffer ~52 ms): schnell.
 *        tief  3 kHz, 26 … 400 Hz, Bezugsfenster 70 ms (Puffer ~110 ms, ≥ 3 Perioden
 *              von A0): findet Bass-Grundtöne und erkennt, wenn „hoch" nur einen
 *              Oberton gesehen hat (Bass-DI mit starkem 2. Teilton).
 *      Unter ~120 Hz könnte jeder Ton der 2. Teilton eines Basstons sein; solche Noten
 *      werden erst übernommen, wenn das tiefe Fenster ganz nach dem Anschlag liegt.
 *      Eine Note gilt, wenn drei Schritte hintereinander dieselbe liefern (Median,
 *      alle innerhalb ±35 Cent). Während einer Verfolgung schaltet eine andere Note
 *      sofort um, wenn seit der Übernahme ein neuer Anschlag kam; ohne Anschlag erst
 *      nach zehn Schritten, nie auf einen Oberton und nie auf die Nachbarnote, solange
 *      Stufe 2 gültig misst (die Notengrenze regelt Stufe 2) — nur kurz nach der
 *      Übernahme darf Stufe 1 noch auf den Grundton darunter korrigieren.
 *   3. Stufe 2 „Note verfolgen" (heterodyne.ts): Bänder bei f, 2f, 3f (Sollfrequenz der
 *      Note), je ein schmaler Tiefpass (h · bandFactor · Abstand von 50 Cent: E2 3 Hz,
 *      E4 12 Hz, B0 1,1 Hz) und ein breiter (20 Hz) für das schnelle Einschwingen,
 *      davor ein Kamm über eine Periode der Note gegen die Nachbarteiltöne. Dazu zwei
 *      Nachbarbänder bei f·√2 und f·√6 (zwischen den Teiltönen) für die
 *      Rauschschätzung. Die Bänder laufen über den Verlauf ab einer Vorlaufzeit vor dem
 *      Anschlag nach, damit sie nicht erst einschwingen müssen.
 *      Phasenregression über 0,05 … 0,3 s (das kürzeste Fenster, das die Ziel-
 *      genauigkeit erreicht, solange längere nicht abweichen). Die Teiltöne werden in
 *      Cent auf den Grundton umgerechnet, um die gemessene Spreizung (Inharmonizität)
 *      bereinigt und nach ihrer Unsicherheit gewichtet; wer über Sekunden stärker
 *      streut, als seine Unsicherheit erklärt, zählt weniger.
 *      Angezeigt wird ab drei Schritten mit Unsicherheit ≤ 0,6 Cent; verfolgt, solange
 *      sie ≤ maxErrorCents und der Abstand zum Rauschen im Band ≥ minSnrDb ist —
 *      pegelunabhängig, nur relativ zum gemessenen Rauschen. Wandert die Saite über
 *      ±55 Cent, wechselt die Note.
 *   4. Haltefunktion: Fünf ungültige Schritte hintereinander → „held" mit dem letzten
 *      guten Wert; nach holdSeconds „silent". Wird das Band in der Haltezeit wieder
 *      gültig (Schwebung), geht es ohne neuen Anschlag weiter. Fällt die Leistung binnen
 *      150 ms um 12 dB (Saite abgedämpft), wird sofort der Wert von davor gehalten.
 *      Kommt ein Anschlag, bevor ein Versuch je gültig war (Griffgeräusch nach dem
 *      Abdämpfen, dann der eigentliche Anschlag), beginnt der Versuch dort neu.
 *   5. Anzeige: einpolige Glättung (smoothingSeconds), im leisen Ausklang länger.
 */
import { FrontEnd, LOW_DECIMATION, SlidingBuffer } from "./filters";
import { BandBank, fitPhase, type BandSpec, type PhaseFit, type Stream } from "./heterodyne";
import { CENTS_PER_LN, DEFAULT_A4, frequencyOf, IN_TUNE_CENTS, midiOf, noteName, octaveOf } from "./notes";

/** |Cent| bis hierhin gilt als gestimmt (aus notes.ts, hier wie bisher zu haben). */
export { IN_TUNE_CENTS };
import { Yin, type PitchCandidate } from "./yin";

/** Notenname bei Stille. */
export const SILENT_NOTE = "--";
/** Länge eines Auswertungsschritts. */
export const HOP_SECONDS = 0.01;

export type TunerEngineState = "silent" | "tracking" | "held";

export interface TunerReading {
	/** "E", "F#" …; bei Stille "--". */
	noteName: string;
	/** Oktave (E2 = tiefe E-Saite der Gitarre, E1 = Bass); bei Stille 0. */
	octave: number;
	/** Abweichung von der Note in Cent, gegen den eingestellten Kammerton. */
	cents: number;
	/** Gemessene Grundfrequenz in Hz; bei Stille 0. */
	frequency: number;
	state: TunerEngineState;
	/** |cents| ≤ IN_TUNE_CENTS (auch im Haltezustand, mit dem gehaltenen Wert). */
	inTune: boolean;
	/** 0 … 1 aus der Messunsicherheit: 1 = sehr sicher, 0 = an der Grenze maxErrorCents. */
	clarity: number;
	/** Breitbandpegel (RMS) der letzten 50 ms in dBFS. */
	level: number;
	/** MIDI-Nummer der Note (E2 = 40); bei Stille 0. */
	midi: number;
}

export interface TunerOptions {
	/** Kammerton in Hz (440). */
	a4?: number;
	/** "H" statt "B" (aus). */
	germanH?: boolean;
	/** Suchbereich in Hz (26 … 1400). */
	minFrequency?: number;
	maxFrequency?: number;
	/** Haltezeit nach verlorener Verfolgung in s (3). */
	holdSeconds?: number;
	/** YIN-Schwelle für d' (0,12). */
	yinThreshold?: number;
	/** Schritte mit derselben Note bis zur Übernahme (3). */
	lockFrames?: number;
	/** Schritte bis zum Wechsel ohne neuen Anschlag (10). */
	switchFrames?: number;
	/** Eckfrequenz der Bänder in Vielfachen des 50-Cent-Abstands (1,25). */
	bandFactor?: number;
	/** Verfolgte Teiltöne (3). */
	harmonics?: number;
	/** Verfolgen, solange die geschätzte Unsicherheit darunter liegt (1 Cent). */
	maxErrorCents?: number;
	/** Das Regressionsfenster wächst, bis diese Unsicherheit erreicht ist (0,15 Cent). */
	targetErrorCents?: number;
	/** Mindestabstand zum Rauschen im Band in dB (8). */
	minSnrDb?: number;
	/** Regressionsfenster in s (0,05 … 0,3). */
	minWindowSeconds?: number;
	maxWindowSeconds?: number;
	/** Zeitkonstante der Anzeigeglättung in s (0,03). */
	smoothingSeconds?: number;
	/** Spreizung der Teiltöne messen und herausrechnen (an). */
	inharmonicityCorrection?: boolean;
}

const DEFAULTS: Required<TunerOptions> = {
	a4: DEFAULT_A4,
	germanH: false,
	minFrequency: 26,
	maxFrequency: 1400,
	holdSeconds: 3,
	yinThreshold: 0.12,
	lockFrames: 3,
	switchFrames: 10,
	bandFactor: 1.25,
	harmonics: 3,
	maxErrorCents: 1,
	targetErrorCents: 0.15,
	minSnrDb: 8,
	minWindowSeconds: 0.05,
	maxWindowSeconds: 0.3,
	smoothingSeconds: 0.03,
	inharmonicityCorrection: true,
};

/** Grenze zwischen den beiden Fenstern der Stufe 1 (untere Grenze von „hoch"). */
const SPLIT_HZ = 58;
/** Obere Grenze des tiefen Fensters. */
const LOW_MAX_HZ = 400;
/** Bezugsfenster W der beiden YIN-Läufe; dazu kommt jeweils τmax. */
const YIN_HIGH_SECONDS = 0.035;
const YIN_LOW_SECONDS = 0.07;
/** Verlauf auf voller Rate für das Nachholen der Bänder. */
const HISTORY_SECONDS = 1.5;
/** Vorlauf vor dem Anschlag: so viele Zeitkonstanten des Bandfilters, begrenzt. */
const PRE_ROLL_CUTOFF_PERIODS = 1;
const PRE_ROLL_MIN = 0.25;
const PRE_ROLL_MAX = 1;
/**
 * Basisbandrate der Bänder: ~1 kHz, bei hohen Noten 2,5 · f, damit die Abstände der
 * Nachbarteiltöne unter der halben Rate bleiben. Kamm nur, wenn eine Periode der Note
 * mindestens so viele Basisbandwerte lang ist.
 */
const BASEBAND_RATE = 1000;
const BASEBAND_PER_NOTE = 2.5;
const COMB_MIN_LENGTH = 4;
/** Nach einem Anschlag zählen die Nachbarbänder so viele Zeitkonstanten lang nicht (begrenzt). */
const NOISE_EXCLUDE_CUTOFF_PERIODS = 3;
const NOISE_EXCLUDE_MIN = 0.1;
const NOISE_EXCLUDE_MAX = 2;
/** Rauschschätzung: Blockmittel je 10 ms, Median über 1,5 s, erst nach dem Einschwingen. */
const NOISE_BLOCK_SECONDS = 0.01;
const NOISE_WINDOW_SECONDS = 1.5;
const NOISE_SETTLE_CUTOFF_PERIODS = 0.6;
/** Weichen die beiden Nachbarbänder um mehr als diesen Faktor ab, zählt das leisere. */
const NOISE_DISAGREE = 4;
/** Grundrauschen: Minimum der Schritt-Energien über diese Zeit. */
const FLOOR_SECONDS = 5;
/**
 * Anschlag: Spitzenhüllkurve (sofortiger Anstieg, Abfall mit 80 ms — länger als die
 * Periode von A0, also ohne Welligkeit bei tiefen Tönen) am Schrittende über dem
 * Doppelten (+6 dB) des kleinsten der drei vorigen Schrittenden …
 */
const ONSET_RISE = 2;
const ENVELOPE_RELEASE_SECONDS = 0.08;
/** … und mindestens 20 dB über dem Grundrauschen (RMS). */
const ONSET_ABOVE_FLOOR = 10;
/** Zwischen zwei Anschlägen mindestens (Schritte). */
const ONSET_REFRACTORY = 5;
/** Ungültige Schritte bis „verloren". */
const LOST_FRAMES = 5;
/**
 * Die erste Anzeige einer Note verlangt eine Unsicherheit unter diesem Anteil von
 * maxErrorCents (Einstieg strenger als Ausstieg): Fingergeräusche vor einem Anschlag
 * liefern sonst kurz eine Phantomnote.
 */
const ENTRY_ERROR_SHARE = 0.6;
/** … und so viele Schritte hintereinander (kürzere Fetzen werden nie angezeigt). */
const ENTRY_FRAMES = 3;
/**
 * Abgedämpft: Fällt die Leistung der Teiltöne binnen 150 ms um mehr als 12 dB (80 dB/s;
 * eine frei ausklingende Saite verliert 10 … 30 dB/s), hat eine Hand die Saite
 * berührt. Der Finger verstimmt sie dabei; gehalten wird der Wert von vor dem Abfall,
 * und dieselbe Note wird nicht ohne neuen Anschlag wieder aufgenommen.
 */
const DAMP_DB = 12;
const DAMP_HOPS = 15;
/** Der Finger verstimmt schon, bevor die Leistung sichtbar fällt: Haltewert so viele Schritte vor dem Höchststand. */
const DAMP_HOLD_BACK = 5;
/**
 * Teiltöne einer echten Saite stimmen nicht genau überein (Anschlag, zwei
 * Schwingungsebenen, Mitschwingen anderer Saiten). Je Teilton wird gleitend über diese
 * Zeit (s) gelernt, wie weit er neben den übrigen liegt (Versatz) und wie stark er
 * darüber hinaus schwankt (Zusatzvarianz).
 */
const PARTIAL_SCATTER_SECONDS = 1.5;
/** Gelerntes zählt erst mit genug Schritten: Anteil = n / (n + diese Zahl). */
const PARTIAL_PRIOR_STEPS = 20;
/** Gültige Schritte bis zur Wiederaufnahme in der Haltezeit, mit Abstand zur Grenze (kein Flackern). */
const REACQUIRE_FRAMES = 5;
const REACQUIRE_ERROR_SHARE = 0.7;
/**
 * Die Anzeigeglättung wird mit wachsender Unsicherheit länger: Zeitkonstante ·
 * (Unsicherheit / Zielgenauigkeit)², höchstens das Achtfache. Solange die Saite laut
 * ist, folgt die Nadel schnell; im leisen Ausklang bleibt sie ruhig.
 */
const SMOOTHING_MAX_FACTOR = 8;
const SMOOTHING_REFERENCE_CENTS = 0.3;
/** Ab hier (|Cent|, mehrere Schritte) wechselt Stufe 2 zur Nachbarnote, ab RETARGET_NOW_CENTS sofort. */
const RETARGET_CENTS = 55;
const RETARGET_FRAMES = 5;
const RETARGET_NOW_CENTS = 65;
/** Ein längeres Regressionsfenster muss so nah am kürzesten liegen (σ, Cent), sonst gilt die Tonhöhe als in Bewegung. */
const CHANGE_SIGMAS = 2.5;
const CHANGE_SLACK_CENTS = 0.05;
/** Über diesem |Cent| ist das Band nicht mehr zuverlässig. */
const BAND_LIMIT_CENTS = 75;
/** Stufe 2 muss nach der Übernahme spätestens so schnell gültig werden (s). */
const READY_TIMEOUT_SECONDS = 0.8;
/**
 * Nach einem Anschlag schwingt das Bandfilter ein; seine Eigenschwingung verbiegt die
 * Phase, und zwar umso mehr, je weiter die Saite von der Mischfrequenz entfernt ist.
 * Die Regression eines Teiltons beginnt deshalb erst 1,2 / Eckfrequenz nach dem
 * Anschlag (gut fünf Zeitkonstanten; bei 16 Cent Verstimmung bleiben < 0,3 Cent
 * Fehler, die das wachsende Fenster weiter verdünnt) und braucht dann mindestens 30 ms.
 */
const SKIP_CUTOFF_PERIODS = 1.2;
/**
 * Eckfrequenz des breiten Tiefpasses je Teilton (Hz), wenn der schmale darunter liegt:
 * schwingt in 1,2 / 20 Hz = 60 ms ein und trägt die ersten Anzeigen, bis der schmale so
 * weit ist (B0-Grundton: 1,1 s). Die Nachbarteiltöne hält der Kamm fern.
 */
const WIDE_CUTOFF_HZ = 20;
const MIN_FIT_SECONDS = 0.03;
/** Stufe 1: Werte einer Note dürfen so weit (Halbtöne) um ihren Median streuen. */
const STABLE_SPREAD = 0.35;
/** So lange nach der Übernahme darf Stufe 1 noch auf den Grundton darunter korrigieren (s). */
const SUBHARMONIC_FIX_SECONDS = 0.5;
/** Spreizungsmessung: nur Teiltöne, die so genau gemessen sind (Cent). */
const STRETCH_MAX_SE = 0.5;
/**
 * Vorwissen zur Spreizung in Cent je (h² − 1): unter 65 Hz (Bass, Bariton) 0 ± 0,35
 * (B bis etwa 4e-4, steife Saiten), darüber 0 ± 0,15 (Gitarre: B 1e-5 … 1e-4).
 * Solange sie unsicher ist, zählen höhere Teiltöne entsprechend weniger.
 */
const STRETCH_PRIOR_LOW_SE = 0.35;
const STRETCH_PRIOR_SE = 0.15;
const STRETCH_PRIOR_SPLIT_HZ = 65;
/** Ältere Messungen der Spreizung verblassen mit dieser Zeitkonstante (s). */
const STRETCH_MEMORY_SECONDS = 1;
/** Physikalisch sinnvoller Bereich der Spreizung (Cent je (h²−1); B ≈ s / 866). */
const STRETCH_MAX = 1.5;

interface Candidate {
	midi: number;
	clarity: number;
}

interface Estimate {
	cents: number;
	se: number;
	snrDb: number;
	valid: boolean;
	/** Noch kein Teilton hat seit dem Anschlag genug eingeschwungene Werte. */
	pending: boolean;
	/** Längere Fenster wichen ab: Die Tonhöhe ändert sich gerade. */
	moving: boolean;
	windowSeconds: number;
	/** Cent und Unsicherheit je Teilton (unbereinigt), NaN ohne gültige Messung. */
	partCents: number[];
	partSe: number[];
}

interface StableNote {
	note: number;
	median: number;
	clarity: number;
}

type Mode = "search" | "track" | "hold";

/** Interner Stand für Auswertung und Fehlersuche. */
export interface TunerDebug {
	mode: Mode;
	source: "stage2" | "none";
	note: number;
	/** Geschätzte Unsicherheit der Stufe 2 in Cent (NaN ohne). */
	errorCents: number;
	/** Bester Rauschabstand im Band in dB (NaN ohne). */
	snrDb: number;
	/** Benutztes Regressionsfenster in s. */
	windowSeconds: number;
	/** Grundrauschen breitbandig in dBFS RMS. */
	floorDb: number;
	/** Rohwert der Stufe 2 in Cent (ungeglättet). */
	rawCents: number;
	/** Gemessene Spreizung in Cent je (h² − 1). */
	stretch: number;
	/** Anzahl erkannter Anschläge seit dem Start. */
	onsets: number;
	/** Warum die letzte Verfolgung endete: abgedämpft, zu unsicher (Rauschen, Störung) oder noch keine. */
	lostBy: "damped" | "uncertain" | "";
}

export class TunerEngine {
	private readonly o: Required<TunerOptions>;
	private readonly front: FrontEnd;
	private readonly yinHigh: Yin;
	private readonly yinLow: Yin | null;
	private readonly win: SlidingBuffer;
	private readonly winLow: SlidingBuffer | null;
	/** Länge des tiefen Fensters in Vollratenwerten. */
	private readonly lowSpan: number;
	private readonly hop: number;
	private readonly hopSamples: number;
	private hopCount = 0;
	private hops = 0;

	private readonly history: Float32Array;
	private index = 0;

	private hopEnergy = 0;
	private readonly energies: Float64Array;
	private envelope = 0;
	private readonly envRelease: number;
	private readonly envelopes = new Float64Array(4);
	private readonly levelHops = 5;

	private lastOnsetIndex = -Infinity;
	private lastOnsetHop = -Infinity;
	private onsets = 0;

	private readonly candidates: (Candidate | null)[] = [];

	private mode: Mode = "search";
	private note = 0;
	private noteFrequency = 0;
	private bank: BandBank | null = null;
	private harmonics = 0;
	private noiseExclude = 0;
	private readonly windowCounts: number[] = [];
	private skipNarrow: number[] = [];
	private skipWide: number[] = [];
	private minFit = 1;
	private regStart = 0;
	private lockIndex = 0;
	private lockHop = 0;
	private stage2Ever = false;
	private invalidStreak = 0;
	private validStreak = 0;
	private retargetStreak = 0;
	private holdUntilHop = 0;
	private stretchPrior = 1 / (STRETCH_PRIOR_SE * STRETCH_PRIOR_SE);
	private stretchW = this.stretchPrior;
	private stretchWS = 0;
	private stretch = 0;
	private stretchVar = STRETCH_PRIOR_SE * STRETCH_PRIOR_SE;
	private lostIndex = 0;
	private damped = false;
	private lostBy: "damped" | "uncertain" | "" = "";
	private entryStreak = 0;
	private readonly powerHist = new Float64Array(DAMP_HOPS + 1);
	private readonly displayHist = new Float64Array(DAMP_HOPS + DAMP_HOLD_BACK + 1);
	private scatterW: number[] = [];
	private scatterM: number[] = [];
	private scatterQ: number[] = [];
	private scatterExp: number[] = [];
	private scatterShare: number[] = [];
	/** Zusatzvarianz je Teilton (Cent²). */
	private excess: number[] = [];
	/** Gelernter Versatz je Teilton gegen die übrigen (Cent). */
	private offset: number[] = [];

	private display = 0;
	private displaySet = false;
	private clarity = 0;
	private source: "stage2" | "none" = "none";
	private lastEstimate: Estimate | null = null;
	private readonly smoothing: number;

	constructor(
		readonly sampleRate: number,
		options: TunerOptions = {},
	) {
		this.o = { ...DEFAULTS, ...options };
		this.front = new FrontEnd(sampleRate);
		const fsd = this.front.analysisRate;
		this.yinHigh = new Yin({
			sampleRate: fsd,
			minFrequency: Math.max(this.o.minFrequency, SPLIT_HZ),
			maxFrequency: this.o.maxFrequency,
			windowSeconds: YIN_HIGH_SECONDS,
			threshold: this.o.yinThreshold,
			fallback: 0,
			octaveCheck: true,
		});
		this.win = new SlidingBuffer(this.yinHigh.length);
		if (this.o.minFrequency < SPLIT_HZ) {
			this.yinLow = new Yin({
				sampleRate: this.front.lowRate,
				minFrequency: this.o.minFrequency,
				maxFrequency: LOW_MAX_HZ,
				windowSeconds: YIN_LOW_SECONDS,
				threshold: this.o.yinThreshold,
				fallback: 0,
				octaveCheck: true,
			});
			this.winLow = new SlidingBuffer(this.yinLow.length);
			this.lowSpan = this.yinLow.length * this.front.decimation * LOW_DECIMATION;
		} else {
			this.yinLow = null;
			this.winLow = null;
			this.lowSpan = 0;
		}
		this.hop = Math.max(1, Math.round(HOP_SECONDS * fsd));
		this.hopSamples = this.hop * this.front.decimation;
		this.history = new Float32Array(Math.ceil(HISTORY_SECONDS * sampleRate));
		this.energies = new Float64Array(Math.ceil(FLOOR_SECONDS / HOP_SECONDS));
		this.envRelease = Math.exp(-1 / (ENVELOPE_RELEASE_SECONDS * sampleRate));
		this.smoothing = Math.max(1e-6, this.o.smoothingSeconds);
	}

	/** Regressionsfenster als Anzahl Basisbandwerte (je Note, weil die Basisbandrate von ihr abhängt). */
	private setWindows(bbRate: number): void {
		const min = this.o.minWindowSeconds;
		const max = Math.max(min, this.o.maxWindowSeconds);
		this.windowCounts.length = 0;
		for (const t of [min, 2 * min, 3 * min, 4 * min, max]) {
			const n = Math.round(Math.min(t, max) * bbRate);
			if (!this.windowCounts.includes(n)) this.windowCounts.push(n);
		}
		this.windowCounts.sort((a, b) => a - b);
		this.minFit = Math.ceil(MIN_FIT_SECONDS * bbRate);
	}

	/** Dauer eines Auswertungsschritts in s (genau, je nach Rate knapp 10 ms). */
	get hopSeconds(): number {
		return this.hopSamples / this.sampleRate;
	}

	/** Verarbeitete Abtastwerte seit dem Start. */
	get samplesProcessed(): number {
		return this.index;
	}

	/** Einen Block eines Mono-Kanals verarbeiten (beliebige Länge). */
	push(block: ArrayLike<number>): void {
		const front = this.front;
		const hist = this.history;
		const histLen = hist.length;
		const winLow = this.winLow;
		for (let i = 0; i < block.length; i++) {
			const y = front.highpass(block[i]);
			hist[this.index % histLen] = y;
			this.index++;
			this.hopEnergy += y * y;
			const a = y < 0 ? -y : y;
			const e = this.envelope * this.envRelease;
			this.envelope = a > e ? a : e;
			if (this.bank !== null) this.bank.feed(y);
			const v = front.decimate(y);
			if (v === v) {
				this.win.push(v);
				const l = front.low;
				if (winLow !== null && l === l) winLow.push(l);
				if (++this.hopCount === this.hop) {
					this.hopCount = 0;
					this.frame();
				}
			}
		}
	}

	/** Stand nach dem letzten vollständigen Schritt. */
	reading(): TunerReading {
		const level = this.levelDb();
		if (this.mode === "search" || !this.displaySet) {
			return {
				noteName: SILENT_NOTE,
				octave: 0,
				cents: 0,
				frequency: 0,
				state: "silent",
				inTune: false,
				clarity: 0,
				level,
				midi: 0,
			};
		}
		const cents = this.display;
		return {
			noteName: noteName(this.note, this.o.germanH),
			octave: octaveOf(this.note),
			cents,
			frequency: this.noteFrequency * Math.pow(2, cents / 1200),
			// Ein Versuch, der noch nie gültig war, zeigt nur den alten Wert: gehalten
			// (gedimmt), bis Stufe 2 den neuen hat — nicht hell, als wäre er gemessen.
			state: this.mode === "track" && this.stage2Ever ? "tracking" : "held",
			inTune: Math.abs(cents) <= IN_TUNE_CENTS,
			clarity: this.clarity,
			level,
			midi: this.note,
		};
	}

	debug(): TunerDebug {
		const e = this.lastEstimate;
		return {
			mode: this.mode,
			source: this.source,
			note: this.note,
			errorCents: e ? e.se : NaN,
			snrDb: e ? e.snrDb : NaN,
			windowSeconds: e ? e.windowSeconds : 0,
			floorDb: 10 * Math.log10(Math.max(this.floorEnergy(), 1e-30)),
			rawCents: e ? e.cents : NaN,
			stretch: this.stretch,
			onsets: this.onsets,
			lostBy: this.lostBy,
		};
	}

	// --- Schritt -----------------------------------------------------------------

	private frame(): void {
		const hopIndex = this.hops++;
		const energy = this.hopEnergy / this.hopSamples;
		this.hopEnergy = 0;
		this.energies[hopIndex % this.energies.length] = energy;
		this.envelopes[hopIndex % this.envelopes.length] = this.envelope;
		if (this.detectOnset(hopIndex)) {
			this.lastOnsetIndex = this.index - this.hopSamples;
			this.lastOnsetHop = hopIndex;
			this.onsets++;
			if (this.bank !== null && this.mode === "track" && !this.stage2Ever) {
				// Anschlag, bevor die Verfolgung je gültig war: Meist hat ein Griffgeräusch nach
				// dem Abdämpfen den Versuch ausgelöst, und jetzt kommt der eigentliche Anschlag
				// (Bass-Aufnahmen 2026-10-07: sonst 3 s Haltezeit trotz klingender Saite). Der
				// Versuch beginnt hier neu — Bänder ab dem Anschlag, das aus dem Geräusch Gelernte
				// verworfen, die Frist ab jetzt.
				this.restartAttempt(hopIndex);
			} else if (this.bank !== null) {
				// Neuer Anschlag: Die Regression beginnt neu (Phasensprung beim Wiederanschlag),
				// das Einschwingen der Nachbarbänder zählt nicht zum Rauschen.
				const b = this.bank.basebandIndex(this.lastOnsetIndex);
				this.regStart = Math.max(this.regStart, b);
				this.excludeNoise(b);
			}
		}

		// Stufe 1
		const p = this.pitch();
		this.candidates.push(p ? { midi: midiOf(p.frequency, this.o.a4), clarity: p.clarity } : null);
		if (this.candidates.length > this.o.switchFrames) this.candidates.shift();
		let lock = this.stable(this.o.lockFrames);
		if (lock && !this.lowWindowFresh(lock.note)) lock = null;

		if (this.mode === "search") {
			if (lock) this.lock(lock);
		} else if (this.mode === "hold") {
			// In der Haltezeit nur nach einem neuen Anschlag neu aufsetzen: Dieselbe Note nimmt
			// Stufe 2 von selbst wieder auf (Schwebung); eine andere ohne Anschlag ist meist eine
			// mitschwingende Saite oder Rauschen und soll den gehaltenen Wert nicht verdrängen.
			if (lock && this.lastOnsetIndex > this.lostIndex) this.lock(lock);
		} else if (lock && lock.note !== this.note) {
			const freshOnset = this.lastOnsetIndex > this.lockIndex;
			const sure = this.stable(this.o.switchFrames);
			const early = (hopIndex - this.lockHop) * this.hopSeconds <= SUBHARMONIC_FIX_SECONDS;
			// Ohne Anschlag nur wechseln, wenn Stufe 2 die bisherige Note nicht mehr gültig misst
			// (Legato: deren Band wird leer). Sonst pendelten Stufe 1 und Stufe 2 an der
			// Notengrenze (die regelt Stufe 2 selbst), und eine Periodizität im Grundrauschen
			// könnte eine noch klingende Saite verdrängen.
			const current = this.lastEstimate !== null && this.lastEstimate.valid;
			const neighbour = Math.abs(lock.note - this.note) === 1 && current;
			if (
				!neighbour &&
				(freshOnset ||
					(early && lock.note < this.note && harmonicRelation(lock.note, this.note) && this.lowNote(lock.note)) ||
					(sure && sure.note === lock.note && !current && !harmonicRelation(lock.note, this.note)))
			) {
				this.lock(lock);
			}
		}

		// Stufe 2
		const est = this.bank !== null ? this.estimate() : null;
		this.lastEstimate = est;
		if (this.mode === "track") this.trackStep(hopIndex, est);
		else if (this.mode === "hold") this.holdStep(hopIndex, est);
		this.displayHist[hopIndex % this.displayHist.length] = this.mode === "track" && this.displaySet ? this.display : NaN;
	}

	/**
	 * Stufe 1 dieses Schritts: das hohe Fenster, außer das tiefe sieht einen tiefen
	 * Grundton, von dem das hohe nur einen Oberton erfasst hat.
	 */
	private pitch(): PitchCandidate | null {
		const o = this.o;
		let hi: PitchCandidate | null = null;
		if (this.win.filled === this.win.length) {
			hi = this.yinHigh.analyze(this.win.data, this.win.start);
			if (hi && (hi.frequency < Math.max(o.minFrequency, SPLIT_HZ) * 0.97 || hi.frequency > o.maxFrequency * 1.03)) hi = null;
		}
		let lo: PitchCandidate | null = null;
		if (this.yinLow !== null && this.winLow !== null && this.winLow.filled === this.winLow.length) {
			lo = this.yinLow.analyze(this.winLow.data, this.winLow.start);
			if (lo && lo.frequency < o.minFrequency * 0.97) lo = null;
		}
		// Nur unterhalb von „hoch" entscheidet „tief"; darüber prüft „hoch" Oktaven selbst
		// (2τ liegt dort noch in seinem Suchbereich).
		if (lo && lo.frequency >= SPLIT_HZ * 1.03) lo = null;
		if (lo && hi) return isHarmonic(hi.frequency, lo.frequency, 4) && hi.frequency > 1.5 * lo.frequency ? lo : hi;
		return lo ?? hi;
	}

	/** Liegt die Note im Bereich, in dem das tiefe Fenster entscheidet (Grundton eines Basstons)? */
	private lowNote(note: number): boolean {
		return this.yinLow !== null && frequencyOf(note, this.o.a4) < SPLIT_HZ * 1.03;
	}

	/**
	 * Unter ~2 · SPLIT_HZ kann ein Ton der 2. Teilton eines Basstons sein. Übernehmen
	 * erst, wenn das tiefe Fenster ganz nach dem letzten Anschlag liegt.
	 */
	private lowWindowFresh(note: number): boolean {
		if (this.yinLow === null) return true;
		if (frequencyOf(note, this.o.a4) > 2.06 * SPLIT_HZ) return true;
		return this.index - this.lastOnsetIndex >= this.lowSpan;
	}

	private trackStep(hopIndex: number, est: Estimate | null): void {
		if (est && est.pending && this.stage2Ever) {
			// Nach einem Anschlag schwingen die Bänder neu ein: Anzeige stehen lassen.
			this.invalidStreak = 0;
			return;
		}
		if (this.stage2Ever && this.detectDamping(hopIndex)) return;
		// Vor der ersten Anzeige schon lernen: Solange die Spreizung unbekannt ist, zählen
		// die Obertöne wenig, und ohne sie wird die Unsicherheit beim Bass nicht klein genug.
		if (!this.stage2Ever && est && !est.pending) this.learnPartials(est);
		const entry = this.stage2Ever || (est !== null && est.se <= ENTRY_ERROR_SHARE * this.o.maxErrorCents);
		if (est && est.valid && entry) {
			if (!this.stage2Ever && ++this.entryStreak < ENTRY_FRAMES) return;
			if (Math.abs(est.cents) > RETARGET_CENTS) {
				const now = Math.abs(est.cents) > RETARGET_NOW_CENTS || !this.stage2Ever;
				if (now || ++this.retargetStreak >= RETARGET_FRAMES) {
					this.retarget(est.cents > 0 ? 1 : -1);
					return;
				}
			} else {
				this.retargetStreak = 0;
			}
			const first = !this.stage2Ever;
			this.stage2Ever = true;
			this.invalidStreak = 0;
			this.validStreak++;
			this.show(est);
			if (!first) this.learnPartials(est);
			return;
		}
		this.validStreak = 0;
		this.retargetStreak = 0;
		this.entryStreak = 0;
		if (!this.stage2Ever) {
			// Stufe 2 schwingt noch ein; Stufe 1 allein ist für die Anzeige zu ungenau (der
			// erste YIN-Wert nach dem Anschlag liegt oft einige Cent daneben).
			if ((hopIndex - this.lockHop) * this.hopSeconds > READY_TIMEOUT_SECONDS) this.lose(hopIndex);
			return;
		}
		if (++this.invalidStreak >= LOST_FRAMES) this.lose(hopIndex);
	}

	private holdStep(hopIndex: number, est: Estimate | null): void {
		// Kam der Versuch nie zur Anzeige (Frist abgelaufen, die Saite klingt aber weiter):
		// weiter lernen wie vor der ersten Anzeige, sonst wird die Unsicherheit beim Bass
		// nie klein genug, um wieder aufzunehmen.
		if (!this.stage2Ever && est && !est.pending) this.learnPartials(est);
		if (!this.damped && est && est.valid && est.se <= REACQUIRE_ERROR_SHARE * this.o.maxErrorCents) {
			if (++this.validStreak >= REACQUIRE_FRAMES) {
				this.mode = "track";
				this.stage2Ever = true;
				this.invalidStreak = 0;
				this.show(est);
				return;
			}
		} else {
			this.validStreak = 0;
		}
		if (hopIndex >= this.holdUntilHop) {
			this.mode = "search";
			this.bank = null;
			this.displaySet = false;
			this.source = "none";
		}
	}

	private show(est: Estimate): void {
		const cents = est.cents;
		if (!this.displaySet) {
			this.display = cents;
			this.displaySet = true;
		} else {
			// In Bewegung (Wirbel wird gedreht) folgt die Nadel ohne Verlängerung.
			const ratio = est.moving ? 1 : est.se / SMOOTHING_REFERENCE_CENTS;
			const tau = this.smoothing * Math.min(SMOOTHING_MAX_FACTOR, Math.max(1, ratio * ratio));
			this.display += (1 - Math.exp(-this.hopSeconds / tau)) * (cents - this.display);
		}
		this.clarity = Math.max(0, Math.min(1, 1 - est.se / this.o.maxErrorCents));
		this.source = "stage2";
	}

	private lose(hopIndex: number): void {
		this.mode = "hold";
		this.lostBy = this.damped ? "damped" : "uncertain";
		this.lostIndex = this.index;
		this.validStreak = 0;
		this.holdUntilHop = hopIndex + Math.round(this.o.holdSeconds / this.hopSeconds);
		if (!this.displaySet) {
			this.mode = "search";
			this.bank = null;
		}
	}

	// --- Anschlag und Pegel ------------------------------------------------------

	private detectOnset(hopIndex: number): boolean {
		const n = this.envelopes.length;
		if (hopIndex < 3) return false;
		const now = this.envelopes[hopIndex % n];
		let prev = Infinity;
		for (let k = 1; k <= 3; k++) prev = Math.min(prev, this.envelopes[(hopIndex - k) % n]);
		return (
			now > ONSET_RISE * prev &&
			now > ONSET_ABOVE_FLOOR * Math.sqrt(this.floorEnergy()) &&
			hopIndex - this.lastOnsetHop >= ONSET_REFRACTORY
		);
	}

	/** Grundrauschen: kleinste Schritt-Energie der letzten FLOOR_SECONDS. */
	private floorEnergy(): number {
		const count = Math.min(this.hops, this.energies.length);
		if (count === 0) return 0;
		let min = Infinity;
		for (let k = 0; k < count; k++) min = Math.min(min, this.energies[k]);
		return min;
	}

	private levelDb(): number {
		const count = Math.min(this.hops, this.levelHops);
		if (count === 0) return -Infinity;
		let sum = 0;
		for (let k = 1; k <= count; k++) sum += this.energies[(this.hops - k) % this.energies.length];
		const ms = sum / count;
		return ms > 0 ? 10 * Math.log10(ms) : -Infinity;
	}

	// --- Stufe 1: Übernahme -------------------------------------------------------

	/** Die letzten n Kandidaten liefern dieselbe Note (alle innerhalb ±35 Cent um den Median). */
	private stable(n: number): StableNote | null {
		const c = this.candidates;
		if (c.length < n) return null;
		const midis: number[] = [];
		let clarity = 0;
		for (let k = c.length - n; k < c.length; k++) {
			const x = c[k];
			if (x === null) return null;
			midis.push(x.midi);
			clarity += x.clarity;
		}
		midis.sort((a, b) => a - b);
		const median = midis[Math.floor(n / 2)];
		if (midis[0] < median - STABLE_SPREAD || midis[n - 1] > median + STABLE_SPREAD) return null;
		return { note: Math.round(median), median, clarity: clarity / n };
	}

	// --- Stufe 2: Bänder ---------------------------------------------------------

	private lock(s: StableNote): void {
		// Dieselbe Note neu angeschlagen (aus der Haltezeit): den letzten Wert stehen lassen,
		// bis Stufe 2 den neuen hat — kein kurzes „--“ bei jedem Anschlag.
		const keep = this.displaySet && this.mode !== "search" && s.note === this.note;
		this.damped = false;
		this.entryStreak = 0;
		this.startBands(s.note, true);
		this.mode = "track";
		this.lockIndex = this.index;
		this.lockHop = this.hops - 1;
		this.stage2Ever = false;
		this.invalidStreak = 0;
		this.validStreak = 0;
		this.retargetStreak = 0;
		this.displaySet = keep;
		if (!keep) this.source = "none";
	}

	/**
	 * Unbestätigten Versuch ab dem eben erkannten Anschlag neu beginnen (dieselbe Note).
	 * lockIndex bleibt: Liefert Stufe 1 nach diesem Anschlag eine andere Note, gilt er
	 * weiter als frisch, und sie wird sofort übernommen.
	 */
	private restartAttempt(hopIndex: number): void {
		this.startBands(this.note, true);
		this.lockHop = hopIndex;
		this.entryStreak = 0;
		this.invalidStreak = 0;
		this.validStreak = 0;
		this.retargetStreak = 0;
	}

	/** Stufe 2 hat die Saite über die Notengrenze wandern sehen: Nachbarnote verfolgen. */
	private retarget(step: number): void {
		const fresh = !this.stage2Ever;
		this.startBands(this.note + step, fresh);
		this.retargetStreak = 0;
		this.invalidStreak = 0;
		if (fresh) return; // noch nichts angezeigt: wie eine neue Übernahme einschwingen
		this.lockIndex = this.index;
		this.lockHop = this.hops - 1;
		// Dieselbe Tonhöhe, von der neuen Note aus gezählt.
		this.display -= 100 * step;
	}

	private startBands(note: number, fromOnset: boolean): void {
		const o = this.o;
		const fs = this.sampleRate;
		const f = frequencyOf(note, o.a4);
		this.note = note;
		this.noteFrequency = f;
		if (fromOnset) {
			const prior = f < STRETCH_PRIOR_SPLIT_HZ ? STRETCH_PRIOR_LOW_SE : STRETCH_PRIOR_SE;
			this.stretchPrior = 1 / (prior * prior);
			this.stretchW = this.stretchPrior;
			this.stretchWS = 0;
			this.stretch = 0;
			this.stretchVar = prior * prior;
		}
		const cut = o.bandFactor * f * (Math.pow(2, 50 / 1200) - 1);
		// Dezimation und Kamm so wählen, dass Dezimation · Kammlänge eine Periode der Note ergibt.
		const target = Math.max(BASEBAND_RATE, BASEBAND_PER_NOTE * f);
		let decimation = Math.max(1, Math.round(fs / target));
		let comb = Math.round(fs / f / decimation);
		if (comb >= COMB_MIN_LENGTH) decimation = Math.max(1, Math.round(fs / f / comb));
		else comb = 1;
		const bbRate = fs / decimation;
		this.setWindows(bbRate);
		const specs: BandSpec[] = [];
		for (let h = 1; h <= Math.max(1, o.harmonics); h++) {
			if (h > 1 && (h * (f + cut) > 0.45 * fs || h * f > 6000)) break;
			specs.push({ frequency: h * f, cutoff: h * cut, wideCutoff: WIDE_CUTOFF_HZ, order: 2, comb });
		}
		this.harmonics = specs.length;
		if (fromOnset) {
			this.scatterW = specs.map(() => 0);
			this.scatterM = specs.map(() => 0);
			this.scatterQ = specs.map(() => 0);
			this.scatterExp = specs.map(() => 0);
			this.scatterShare = specs.map(() => 0);
			this.excess = specs.map(() => 0);
			this.offset = specs.map(() => 0);
		}
		this.powerHist.fill(0);
		this.displayHist.fill(NaN);
		specs.push({ frequency: f * Math.SQRT2, cutoff: cut, order: 4, noise: true });
		specs.push({ frequency: f * Math.sqrt(6), cutoff: cut, order: 4, noise: true });

		const histLen = this.history.length;
		const preRollSec = Math.min(PRE_ROLL_MAX, Math.max(PRE_ROLL_MIN, PRE_ROLL_CUTOFF_PERIODS / cut));
		const preRoll = Math.round(preRollSec * fs);
		const oldest = Math.max(0, this.index - histLen);
		const onsetKnown = fromOnset && this.lastOnsetIndex >= oldest;
		const start = onsetKnown ? Math.max(oldest, this.lastOnsetIndex - preRoll) : oldest;
		const capacity = Math.ceil((this.o.maxWindowSeconds + 0.1) * bbRate) + 16;
		const settle = Math.min(NOISE_SETTLE_CUTOFF_PERIODS / cut, preRollSec - 0.05);
		const bank = new BandBank(
			specs,
			fs,
			decimation,
			capacity,
			{ blockSeconds: NOISE_BLOCK_SECONDS, windowSeconds: NOISE_WINDOW_SECONDS, settleSeconds: Math.max(0, settle) },
			start,
		);
		this.bank = bank;
		this.noiseExclude = Math.round(
			Math.min(NOISE_EXCLUDE_MAX, Math.max(NOISE_EXCLUDE_MIN, NOISE_EXCLUDE_CUTOFF_PERIODS / cut)) * bbRate,
		);
		if (onsetKnown) this.excludeNoise(bank.basebandIndex(this.lastOnsetIndex));
		for (let j = start; j < this.index; j++) bank.feed(this.history[j % histLen]);
		const regFrom = onsetKnown ? this.lastOnsetIndex : this.index - Math.round(this.o.maxWindowSeconds * fs);
		this.regStart = bank.basebandIndex(regFrom);
		const skip = (cutoff: number): number => Math.ceil((SKIP_CUTOFF_PERIODS / cutoff) * bbRate);
		this.skipNarrow = bank.bands.slice(0, this.harmonics).map((b) => skip(b.narrow.cutoff));
		this.skipWide = bank.bands.slice(0, this.harmonics).map((b) => (b.wide !== null ? skip(b.wide.cutoff) : Infinity));
	}

	/** Das Einschwingen der Nachbarbänder nach einem Anschlag (Basisbandindex) aus der Rauschschätzung nehmen. */
	private excludeNoise(at: number): void {
		const b = this.bank!.bands;
		for (let i = this.harmonics; i < b.length; i++) b[i].exclude(at, at + this.noiseExclude);
	}

	/** Rauschleistungsdichte (je Hz zweiseitig) aus den Nachbarbändern; 0, solange keine Schätzung vorliegt. */
	private noiseDensity(): number {
		const b = this.bank!.bands;
		const lo = b[this.harmonics];
		const hi = b[this.harmonics + 1];
		const a = lo.noisePower();
		const c = hi.noisePower();
		const bw = lo.narrow.noiseBandwidth;
		let n: number;
		if (a === a && c === c) {
			const small = Math.min(a, c);
			const big = Math.max(a, c);
			n = big > NOISE_DISAGREE * small ? small : 0.5 * (a + c);
		} else if (a === a) n = a;
		else if (c === c) n = c;
		else return 0;
		return n / bw;
	}

	/**
	 * Regressionsfenster wählen: vom kürzesten aufwärts, bis die Zielgenauigkeit
	 * erreicht ist. Ein längeres Fenster zählt nur, solange es mit dem kürzesten
	 * übereinstimmt (innerhalb 2,5 σ) — weicht es ab, ändert sich die Tonhöhe gerade
	 * (Wirbel wird gedreht), und das längere Fenster hinkte nur hinterher.
	 */
	private estimate(): Estimate | null {
		const bank = this.bank!;
		const to = bank.bands[0].count - 1;
		if (to < 4) return null;
		const density = this.noiseDensity();
		let chosen: Estimate | null = null;
		let base: Estimate | null = null;
		for (const n of this.windowCounts) {
			const from = Math.max(this.regStart, to - n + 1);
			const e = this.combine(from, to, density, (to - from + 1) / bank.rate);
			if (e !== null) {
				if (e.valid) {
					if (base === null) base = e;
					else if (Math.abs(e.cents - base.cents) > CHANGE_SIGMAS * Math.hypot(e.se, base.se) + CHANGE_SLACK_CENTS) {
						if (chosen !== null) chosen.moving = true;
						break;
					}
				}
				if (chosen === null || !chosen.valid || (e.valid && e.se < chosen.se)) chosen = e;
				if (e.valid && e.se <= this.o.targetErrorCents) break;
			}
			if (from === this.regStart) break;
		}
		return chosen;
	}

	private combine(from: number, to: number, density: number, windowSeconds: number): Estimate | null {
		const bank = this.bank!;
		const rate = bank.rate;
		let wsum = 0;
		let csum = 0;
		let bestSnr = 0;
		const minSnr = Math.pow(10, this.o.minSnrDb / 10);
		const partCents: number[] = [];
		const partSe: number[] = [];
		let pending = true;
		for (let h = 0; h < this.harmonics; h++) {
			partCents.push(NaN);
			partSe.push(NaN);
			const band = bank.bands[h];
			// Beide Tiefpässe, sobald eingeschwungen; der genauere zählt.
			let fit: PhaseFit | null = null;
			let snr = 0;
			for (const [stream, skip] of [
				[band.narrow, this.skipNarrow[h]],
				[band.wide, this.skipWide[h]],
			] as [Stream | null, number][]) {
				if (stream === null) continue;
				const start = Math.max(from, this.regStart + skip);
				if (to - start + 1 < this.minFit) continue;
				pending = false;
				const noise = density * stream.noiseBandwidth;
				const f = fitPhase(stream, start, to, noise, rate);
				if (f === null) continue;
				const r = f.power / Math.max(noise, 1e-300);
				if (r > bestSnr) bestSnr = r;
				if (r < minSnr) continue;
				if (fit === null || f.se < fit.se) {
					fit = f;
					snr = r;
				}
			}
			if (fit === null || !(snr >= minSnr)) continue;
			const fh = band.frequency + (fit.slope * rate) / (2 * Math.PI);
			if (!(fh > 0)) continue;
			const cents = CENTS_PER_LN * Math.log(fh / band.frequency);
			const se = (((fit.se * rate) / (2 * Math.PI)) * CENTS_PER_LN) / fh;
			partCents[h] = cents;
			partSe[h] = se;
			// Auf den Grundton umrechnen: Spreizung (h² − 1) · s herausnehmen; ihre
			// Unsicherheit geht in die Gewichtung ein.
			const k = (h + 1) * (h + 1) - 1;
			let corrected = cents - (this.offset[h] ?? 0);
			let variance = se * se + (this.excess[h] ?? 0);
			if (this.o.inharmonicityCorrection) {
				corrected -= k * this.stretch;
				variance += k * k * this.stretchVar;
			}
			const w = 1 / Math.max(variance, 1e-12);
			wsum += w;
			csum += w * corrected;
		}
		const snrDb = bestSnr > 0 ? 10 * Math.log10(bestSnr) : -Infinity;
		if (wsum === 0) return { cents: NaN, se: Infinity, snrDb, valid: false, pending, moving: false, windowSeconds, partCents, partSe };
		const cents = csum / wsum;
		const se = 1 / Math.sqrt(wsum);
		const valid = se <= this.o.maxErrorCents && Math.abs(cents) <= BAND_LIMIT_CENTS;
		return { cents, se, snrDb, valid, pending, moving: false, windowSeconds, partCents, partSe };
	}

	/**
	 * Versatz und Streuung je Teilton gegen die übrigen (ohne ihn selbst gemittelt,
	 * jeweils um Spreizung und gelernten Versatz bereinigt), gleitend über ~1,5 s.
	 *
	 * Versatz: Liegt ein Teilton dauerhaft neben den anderen (beim G der echten Aufnahme
	 * der Grundton 4 Cent unter dem 2. und 3. Teilton), wird er darum korrigiert; die
	 * gewichtete Summe der Versätze bleibt 0, die Anzeige also das gewichtete Mittel.
	 * Klingt später ein Teilton aus, springt die Anzeige nicht auf den Wert der übrigen.
	 *
	 * Streuung: Was über die erwartete Schwankung (eigene Unsicherheit plus die des
	 * Mittels der anderen) hinausgeht, wird nach dem Anteil der eigenen Unsicherheit
	 * zugeteilt: Widersprechen sich ein genauer und ein ungenauer Teilton, trägt der
	 * ungenaue die Schuld (Mitschwingen einer anderen Saite, Rauschen); schwankt der
	 * Grundton bei stabilen Obertönen (Schwebung zweier Schwingungsebenen), trägt er sie.
	 */
	private learnScatter(est: Estimate): void {
		const c = est.partCents;
		const e = est.partSe;
		const n = c.length;
		const corr = this.o.inharmonicityCorrection;
		const val: number[] = [];
		const own: number[] = [];
		const w: number[] = [];
		for (let h = 0; h < n; h++) {
			const k = (h + 1) * (h + 1) - 1;
			const ok = e[h] === e[h];
			val.push(ok ? c[h] - (corr ? k * this.stretch : 0) : NaN);
			own.push(ok ? e[h] * e[h] + (corr ? k * k * this.stretchVar : 0) : NaN);
			w.push(ok ? 1 / Math.max(own[h] + this.excess[h], 1e-8) : 0);
		}
		const keep = Math.exp(-this.hopSeconds / PARTIAL_SCATTER_SECONDS);
		let changed = false;
		for (let h = 0; h < n; h++) {
			if (!(w[h] > 0)) continue;
			let ws = 0;
			let vs = 0;
			for (let j = 0; j < n; j++) {
				if (j === h || !(w[j] > 0)) continue;
				ws += w[j];
				vs += w[j] * (val[j] - this.offset[j]);
			}
			if (ws === 0) continue;
			changed = true;
			const r = val[h] - vs / ws;
			const expected = own[h] + 1 / ws;
			this.scatterW[h] = keep * this.scatterW[h] + 1;
			this.scatterM[h] = keep * this.scatterM[h] + r;
			this.scatterQ[h] = keep * this.scatterQ[h] + r * r;
			this.scatterExp[h] = keep * this.scatterExp[h] + expected;
			this.scatterShare[h] = keep * this.scatterShare[h] + own[h] / expected;
			const W = this.scatterW[h];
			const trust = W / (W + PARTIAL_PRIOR_STEPS);
			const mean = this.scatterM[h] / W;
			const fluct = Math.max(0, this.scatterQ[h] / W - mean * mean - this.scatterExp[h] / W);
			this.excess[h] = trust * fluct * (this.scatterShare[h] / W);
			this.offset[h] = trust * mean;
		}
		if (!changed) return;
		// Gewichtete Summe der Versätze auf 0 halten: Die Anzeige bleibt das gewichtete Mittel.
		let ws = 0;
		let os = 0;
		for (let h = 0; h < n; h++) {
			if (!(w[h] > 0)) continue;
			ws += w[h];
			os += w[h] * this.offset[h];
		}
		if (ws > 0) for (let h = 0; h < n; h++) this.offset[h] -= os / ws;
	}

	/**
	 * Abdämpfen erkennen (Leistung der Teiltöne fällt binnen 150 ms um mehr als 12 dB):
	 * dann sofort halten, mit dem Wert von vor dem Abfall.
	 */
	private detectDamping(hopIndex: number): boolean {
		const bank = this.bank;
		if (bank === null) return false;
		let p = 0;
		const n = Math.max(1, Math.round(this.hopSeconds * bank.rate * 2));
		for (let h = 0; h < this.harmonics; h++) p += bank.bands[h].recentPower(n);
		const len = this.powerHist.length;
		this.powerHist[hopIndex % len] = p;
		let max = 0;
		let at = hopIndex;
		for (let k = 1; k < len; k++) {
			const v = this.powerHist[(hopIndex - k + len * 4) % len];
			if (v > max) {
				max = v;
				at = hopIndex - k;
			}
		}
		if (!(max > 0) || p >= max * Math.pow(10, -DAMP_DB / 10)) return false;
		// Wert von kurz vor dem Höchststand halten, sofern damals angezeigt.
		const dl = this.displayHist.length;
		const held = this.displayHist[(at - DAMP_HOLD_BACK + dl * 8) % dl];
		if (held === held) this.display = held;
		this.damped = true;
		this.lose(hopIndex);
		return true;
	}

	/**
	 * Nach einem gültigen Schritt: Streuung je Teilton (learnScatter) und Spreizung der
	 * Teiltöne lernen. Bei einer steifen Saite liegt Teilton h um etwa (h² − 1) · s Cent
	 * über h · f1 (s ≈ 866 · B). Jedes Paar genau gemessener Teiltöne liefert
	 * s = (c_j − c_i) / (j² − i²); gewichtet gemittelt mit dem Vorwissen. Gilt für die
	 * Saite, also bis zum nächsten Anschlag einer Note.
	 */
	private learnPartials(est: Estimate): void {
		this.learnScatter(est);
		if (!this.o.inharmonicityCorrection) return;
		const c = est.partCents;
		const e = est.partSe;
		// Aufeinanderfolgende Schritte teilen sich ihr Fenster: nur den Anteil des neuen Stücks zählen.
		const share = this.hopSeconds / Math.max(est.windowSeconds, this.hopSeconds);
		// Alte Messungen verblassen (frühe Werte können vom Einschwingen gefärbt sein), das Vorwissen bleibt.
		const keep = Math.exp(-this.hopSeconds / STRETCH_MEMORY_SECONDS);
		this.stretchW = this.stretchPrior + keep * (this.stretchW - this.stretchPrior);
		this.stretchWS *= keep;
		for (let i = 0; i < c.length; i++) {
			if (!(e[i] <= STRETCH_MAX_SE)) continue;
			for (let j = i + 1; j < c.length; j++) {
				if (!(e[j] <= STRETCH_MAX_SE)) continue;
				const k = (j + 1) * (j + 1) - (i + 1) * (i + 1);
				const v = (e[i] * e[i] + e[j] * e[j]) / (k * k);
				const w = share / Math.max(v, 1e-8);
				this.stretchW += w;
				this.stretchWS += (w * (c[j] - c[i])) / k;
			}
		}
		this.stretch = Math.max(0, Math.min(STRETCH_MAX, this.stretchWS / this.stretchW));
		this.stretchVar = 1 / this.stretchW;
	}
}

/** Ist a ein Oberton von b oder b einer von a (Oktave, Duodezime, Doppeloktave …)? */
export function harmonicRelation(a: number, b: number): boolean {
	const d = Math.abs(a - b);
	for (let k = 2; k <= 8; k++) {
		if (d === Math.round(12 * Math.log2(k))) return true;
	}
	return false;
}

/** Liegt f nahe einem ganzzahligen Vielfachen (1 … kMax) von base (±30 Cent)? */
function isHarmonic(f: number, base: number, kMax: number): boolean {
	const r = f / base;
	const k = Math.round(r);
	return k >= 1 && k <= kMax && Math.abs(CENTS_PER_LN * Math.log(r / k)) < 30;
}
