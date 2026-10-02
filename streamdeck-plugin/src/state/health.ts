/**
 * Steht die Verbindung zu Nuendo? Allein der Pong entscheidet (protokoll.md 4.1, 4.4).
 *
 * Das Script sendet unverlangt nur Änderungen; ein stehendes Nuendo ist still.
 * Stille beweist also nichts — deshalb geht alle PING_INTERVAL_MS ein Ping hinaus,
 * den das Script sofort mit demselben Frame beantwortet. Mit dem ersten Pong gilt
 * die Verbindung als hergestellt, und der Aufrufer fragt ab (0x10). Bleiben mehrere
 * Pongs aus (Nuendo beendet oder neu gestartet, Script neu geladen), gilt sie als
 * verloren; der nächste Pong stellt sie wieder her und löst erneut eine Abfrage aus.
 *
 * Andere Frames zählen nicht als Lebenszeichen: Ein Nuendo, das sendet, aber nicht
 * mehr empfängt (der halbe Zustand der FaderBank, README dort), antwortet nicht auf
 * Pings und soll genau dann „Warte…" zeigen, statt gesund auszusehen.
 *
 * Ohne Timer und ohne MIDI, damit es prüfbar bleibt: Die Session ruft die Methoden
 * mit der aktuellen Zeit auf.
 */

/** „etwa alle 2 s" (4.4). */
export const PING_INTERVAL_MS = 2000;
/** Drei ausgebliebene Pongs plus Luft. */
export const LOST_AFTER_MS = 7000;

export class Health {
	/** Kam in den letzten LOST_AFTER_MS ein Pong? */
	connected = false;

	// -Infinity heißt: noch nie. Nicht 0 — das ist ein gültiger Zeitpunkt.
	private lastPingAt = -Infinity;
	private lastPongAt = -Infinity;

	/** Ist der nächste Ping fällig? */
	pingDue(now: number): boolean {
		return now - this.lastPingAt >= PING_INTERVAL_MS;
	}

	notePing(now: number): void {
		this.lastPingAt = now;
	}

	/** Ein Pong kam. true, wenn er die Verbindung (wieder) herstellt. */
	notePong(now: number): boolean {
		this.lastPongAt = now;
		if (this.connected) return false;
		this.connected = true;
		return true;
	}

	/** Urteilen. true, wenn die Verbindung eben verloren ging. */
	check(now: number): boolean {
		if (!this.connected || now - this.lastPongAt < LOST_AFTER_MS) return false;
		this.connected = false;
		return true;
	}
}
