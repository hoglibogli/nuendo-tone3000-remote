/**
 * Drossel für die Anzeige: höchstens alle `intervalMs` ein Lauf, der letzte Stand
 * gewinnt.
 *
 * Der erste Aufruf nach einer Pause läuft sofort (ein Rastschritt soll ohne
 * Verzögerung zu sehen sein). Kommen weitere innerhalb des Intervalls, wird genau
 * ein Lauf an dessen Ende geplant; er liest den Zustand erst dann und zeigt damit
 * den neuesten. Zwischenstände fallen weg.
 *
 * Das Intervall darf eine Funktion sein, gelesen bei jedem Aufruf: Die Regler
 * zeichnen ihre Knöpfe alle 30 ms, die Stimmanzeige höchstens alle 100 ms (Elgato
 * erlaubt etwa 10 Bilder je Sekunde und Aktion).
 */
export class Throttle {
	private lastRun = -Infinity;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly intervalMs: number | (() => number),
		private readonly run: () => void,
		private readonly now: () => number = () => Date.now(),
		private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) =>
			setTimeout(fn, ms),
		private readonly unschedule: (t: ReturnType<typeof setTimeout>) => void = (t) => clearTimeout(t),
	) {}

	request(): void {
		if (this.timer !== undefined) return; // der geplante Lauf nimmt den neuesten Stand mit
		const interval = typeof this.intervalMs === "function" ? this.intervalMs() : this.intervalMs;
		const wait = this.lastRun + interval - this.now();
		if (wait <= 0) {
			this.fire();
			return;
		}
		this.timer = this.schedule(() => {
			this.timer = undefined;
			this.fire();
		}, wait);
	}

	cancel(): void {
		if (this.timer !== undefined) this.unschedule(this.timer);
		this.timer = undefined;
	}

	/**
	 * Gezählt wird ab dem Ende des Laufs: Der Lauf zeichnet und setzt das Bild, erst
	 * dann beginnt das Intervall. So liegen zwei Bild-Updates auch dann mindestens
	 * intervalMs auseinander, wenn das Zeichnen unterschiedlich lange dauert.
	 */
	private fire(): void {
		try {
			this.run();
		} finally {
			this.lastRun = this.now();
		}
	}
}
