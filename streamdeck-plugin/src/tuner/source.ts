/**
 * Quellen-Verwaltung des eigenen Stimmgeräts auf der Seite des Plugins: startet den
 * Audio-Kindprozess (worker.ts) im Tuner-Modus, stoppt ihn beim Verlassen, überwacht
 * ihn und meldet Messungen und Zustand.
 *
 *   Start        start(config): läuft schon einer mit genau diesem Auftrag, bleibt er;
 *                sonst wird der alte beendet und ein neuer gestartet.
 *   Stopp        stop(): „stop" an den Worker, nach 1 s hart beenden.
 *   Eingang weg  Meldet der Worker „missing-input" (Gerät aus, Kanal fehlt, liefert
 *                nichts mehr), zeigt die Anzeige den Fehler, und alle 5 s wird es erneut
 *                versucht — RME einschalten genügt. Das zählt nicht als Absturz.
 *   Absturz      Endet der Worker unerwartet oder bleiben die Lebenszeichen 5 s aus
 *                (dann wird er beendet), startet er nach 1 s neu — höchstens 3-mal in
 *                60 s, danach bleibt der Fehler stehen, bis start() neu gerufen wird.
 *
 * Prozesse und Uhr kommen von außen (Spawner, Timers): Im Plugin child_process.fork und
 * setTimeout, im Test Attrappen. Ein Fehler im Worker reißt das Plugin nie mit: Alle
 * Zugriffe auf den Kanal sind abgefangen, „error"-Ereignisse des Kindprozesses gehören
 * hierher.
 */
import { inputLabel, type InputChoice, type InputItem } from "./inputs";
import type { WireReading, WorkerConfig, WorkerMessage } from "./wire";

/** Was am Kindprozess gebraucht wird (child_process.ChildProcess erfüllt es). */
export interface ChildLike {
	send(message: unknown): unknown;
	kill(signal?: NodeJS.Signals | number): unknown;
	on(event: "message", listener: (message: unknown) => void): unknown;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: "error", listener: (err: Error) => void): unknown;
}

/** Startet einen Worker mit dem Auftrag als erstem Argument. */
export type Spawner = (config: WorkerConfig) => ChildLike;

export interface Timers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** Was die Session vom eigenen Tuner wissen will. */
export type OwnTunerStatus =
	| { kind: "starting" }
	| { kind: "running"; rate: number }
	/** key: kurz für die Taste; text: für die Leiste. */
	| { kind: "error"; code: "missing-input" | "failed"; text: string; key: string };

export type OwnTunerEvent = { type: "reading"; reading: WireReading } | { type: "status"; status: OwnTunerStatus };

/** Auftrag des eigenen Tuners. */
export interface OwnTunerConfig extends InputChoice {
	a4: number;
}

/** Was die Session braucht (TunerSource oder eine Attrappe). */
export interface OwnTunerPort {
	start(config: OwnTunerConfig): void;
	stop(): void;
	listen(fn: (ev: OwnTunerEvent) => void): void;
}

export interface TunerSourceOptions {
	spawn: Spawner;
	timers?: Timers;
	now?: () => number;
	log?: (line: string) => void;
	restartDelayMs?: number;
	missingRetryMs?: number;
	maxCrashes?: number;
	crashWindowMs?: number;
	aliveTimeoutMs?: number;
	stopGraceMs?: number;
	listTimeoutMs?: number;
}

const DEFAULTS = {
	restartDelayMs: 1000,
	missingRetryMs: 5000,
	maxCrashes: 3,
	crashWindowMs: 60000,
	aliveTimeoutMs: 5000,
	stopGraceMs: 1000,
	listTimeoutMs: 8000,
};

const REAL_TIMERS: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function sameConfig(a: OwnTunerConfig | null, b: OwnTunerConfig | null): boolean {
	return a !== null && b !== null && a.device === b.device && a.channel === b.channel && a.a4 === b.a4;
}

export class TunerSource implements OwnTunerPort {
	private readonly o: Required<TunerSourceOptions>;
	private readonly listeners = new Set<(ev: OwnTunerEvent) => void>();
	/** Gewünschter Auftrag; null = aus. */
	private want: OwnTunerConfig | null = null;
	private child: ChildLike | null = null;
	/** Letzte Fehlermeldung des laufenden Workers (vor seinem Ende). */
	private childError: { code: string; text: string } | null = null;
	private crashes: number[] = [];
	private retryTimer: unknown = null;
	private aliveTimer: unknown = null;
	private status: OwnTunerStatus = { kind: "starting" };

	constructor(options: TunerSourceOptions) {
		this.o = {
			spawn: options.spawn,
			timers: options.timers ?? REAL_TIMERS,
			now: options.now ?? (() => Date.now()),
			log: options.log ?? (() => undefined),
			restartDelayMs: options.restartDelayMs ?? DEFAULTS.restartDelayMs,
			missingRetryMs: options.missingRetryMs ?? DEFAULTS.missingRetryMs,
			maxCrashes: options.maxCrashes ?? DEFAULTS.maxCrashes,
			crashWindowMs: options.crashWindowMs ?? DEFAULTS.crashWindowMs,
			aliveTimeoutMs: options.aliveTimeoutMs ?? DEFAULTS.aliveTimeoutMs,
			stopGraceMs: options.stopGraceMs ?? DEFAULTS.stopGraceMs,
			listTimeoutMs: options.listTimeoutMs ?? DEFAULTS.listTimeoutMs,
		};
	}

	listen(fn: (ev: OwnTunerEvent) => void): void {
		this.listeners.add(fn);
	}

	/** Läuft gerade ein Worker? (für Tests und Protokoll) */
	get running(): boolean {
		return this.child !== null;
	}

	start(config: OwnTunerConfig): void {
		if (sameConfig(this.want, config) && (this.child !== null || this.retryTimer !== null)) return;
		this.stopChild();
		this.want = { ...config };
		this.crashes = [];
		this.launch();
	}

	stop(): void {
		this.want = null;
		this.clearRetry();
		this.stopChild();
	}

	/**
	 * Alle Eingänge als Mono-Kanäle (für den Property Inspector): ein eigener, kurzer
	 * Worker im Listenmodus. Scheitert er, kommt eine leere Liste.
	 */
	listInputs(): Promise<InputItem[]> {
		return new Promise((resolve) => {
			let done = false;
			let child: ChildLike;
			const finish = (items: InputItem[]): void => {
				if (done) return;
				done = true;
				this.o.timers.clearTimeout(timer);
				resolve(items);
			};
			const timer = this.o.timers.setTimeout(() => {
				this.o.log("Tuner: Eingänge nicht gelistet (keine Antwort)");
				try {
					child.kill();
				} catch {
					/* schon weg */
				}
				finish([]);
			}, this.o.listTimeoutMs);
			try {
				child = this.o.spawn({ mode: "list" });
			} catch (e) {
				this.o.log(`Tuner: Liste nicht startbar: ${e instanceof Error ? e.message : String(e)}`);
				finish([]);
				return;
			}
			child.on("message", (m) => {
				const msg = m as WorkerMessage;
				if (msg?.type === "inputs" && Array.isArray(msg.items)) finish(msg.items);
				else if (msg?.type === "error") {
					this.o.log(`Tuner: Eingänge nicht gelistet: ${msg.text}`);
					finish([]);
				}
			});
			child.on("error", (e) => {
				this.o.log(`Tuner: Liste: ${e.message}`);
				finish([]);
			});
			child.on("exit", () => finish([]));
		});
	}

	// --- intern -------------------------------------------------------------------

	private emit(ev: OwnTunerEvent): void {
		for (const fn of this.listeners) {
			try {
				fn(ev);
			} catch (e) {
				this.o.log(`Tuner: Empfänger fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	private setStatus(status: OwnTunerStatus): void {
		this.status = status;
		this.emit({ type: "status", status });
	}

	private launch(): void {
		const want = this.want;
		if (want === null) return;
		this.clearRetry();
		this.childError = null;
		if (this.status.kind !== "error" || this.status.code !== "missing-input") this.setStatus({ kind: "starting" });
		let child: ChildLike;
		try {
			child = this.o.spawn({ mode: "audio", device: want.device, channel: want.channel, a4: want.a4 });
		} catch (e) {
			this.o.log(`Tuner: Worker nicht startbar: ${e instanceof Error ? e.message : String(e)}`);
			this.crashed();
			return;
		}
		this.child = child;
		child.on("message", (m) => {
			if (this.child === child) this.onMessage(m as WorkerMessage);
		});
		child.on("error", (e) => {
			this.o.log(`Tuner: Worker-Fehler: ${e.message}`);
		});
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = null;
			this.clearAlive();
			this.onExit(code, signal);
		});
		this.armAlive();
	}

	private onMessage(msg: WorkerMessage): void {
		if (!msg || typeof msg !== "object") return;
		this.armAlive();
		switch (msg.type) {
			case "ready":
				this.o.log(`Tuner: ${msg.device}, Kanal ${msg.channel + 1}, ${msg.rate} Hz`);
				this.setStatus({ kind: "running", rate: msg.rate });
				return;
			case "reading":
				if (this.status.kind !== "running") this.setStatus({ kind: "running", rate: 0 });
				this.emit({ type: "reading", reading: msg.reading });
				return;
			case "error":
				this.childError = { code: msg.code, text: msg.text };
				this.o.log(`Tuner: ${msg.text}`);
				return;
			default:
				return;
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.want === null) return; // gewollt beendet
		const label = inputLabel(this.want);
		if (this.childError?.code === "missing-input") {
			// Eingang fehlt: Anzeige zeigt es, alle paar Sekunden neu versuchen.
			this.setStatus({ kind: "error", code: "missing-input", text: `Eingang ${label} fehlt`, key: "Eingang?" });
			this.schedule(this.o.missingRetryMs);
			return;
		}
		this.o.log(`Tuner: Worker beendet (Code ${code ?? "–"}, Signal ${signal ?? "–"})${this.childError ? `: ${this.childError.text}` : ""}`);
		this.crashed();
	}

	/** Unerwartetes Ende: begrenzt neu starten. */
	private crashed(): void {
		const now = this.o.now();
		this.crashes = this.crashes.filter((t) => now - t < this.o.crashWindowMs);
		this.crashes.push(now);
		if (this.crashes.length > this.o.maxCrashes) {
			const detail = this.childError?.code === "no-audio" ? "Audio-Modul fehlt" : "Tuner-Fehler";
			this.setStatus({ kind: "error", code: "failed", text: `Eigener Tuner: ${detail}`, key: "Fehler" });
			return;
		}
		this.setStatus({ kind: "starting" });
		this.schedule(this.o.restartDelayMs);
	}

	private schedule(ms: number): void {
		this.clearRetry();
		this.retryTimer = this.o.timers.setTimeout(() => {
			this.retryTimer = null;
			this.launch();
		}, ms);
	}

	private clearRetry(): void {
		if (this.retryTimer !== null) this.o.timers.clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}

	private armAlive(): void {
		this.clearAlive();
		const child = this.child;
		this.aliveTimer = this.o.timers.setTimeout(() => {
			this.aliveTimer = null;
			if (this.child !== child || child === null) return;
			this.o.log("Tuner: Worker antwortet nicht mehr, beende ihn");
			try {
				child.kill();
			} catch {
				/* schon weg */
			}
		}, this.o.aliveTimeoutMs);
	}

	private clearAlive(): void {
		if (this.aliveTimer !== null) this.o.timers.clearTimeout(this.aliveTimer);
		this.aliveTimer = null;
	}

	private stopChild(): void {
		const child = this.child;
		this.child = null;
		this.clearAlive();
		if (child === null) return;
		try {
			child.send({ type: "stop" });
		} catch {
			/* Kanal schon zu */
		}
		this.o.timers.setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* schon beendet */
			}
		}, this.o.stopGraceMs);
	}
}
