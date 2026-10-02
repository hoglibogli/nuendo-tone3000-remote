/**
 * Audio-Eingänge für das Stimmgerät: WASAPI-Geräte in einzelne Mono-Kanäle zerlegen,
 * benennen und wiederfinden. Reine Funktionen ohne Audio-Modul — der Worker liefert die
 * Geräteliste, die Tests prüfen die Namen.
 *
 * Gemessen wird immer genau ein Kanal (nie eine Summe): der Stream wird mit
 * nChannels 1 und firstChannel = Kanal geöffnet. Am Gerät liefert „MADI (5+6) (RME
 * MADIface Pro)" mit firstChannel 1 nur MADI 6.
 *
 * Kennung eines Eingangs = Gerätename + Kanalindex (0-basiert). Gesucht wird das
 * Gerät per Namen, weil sich die numerischen IDs von RtAudio ändern.
 */

/** Ein Mono-Kanal eines Eingabegeräts. */
export interface InputChoice {
	/** Gerätename (vollständig, wie WASAPI ihn meldet, oder ein Teil davon). */
	device: string;
	/** Kanalindex 0-basiert (firstChannel). */
	channel: number;
}

/** Ein Eintrag der Auswahlliste. */
export interface InputItem extends InputChoice {
	/** Anzeigename: „MADI 6", „Analog 1", sonst „<Gerät> – Kanal n". */
	label: string;
}

/** Ein Eingabegerät, wie RtAudio es beschreibt (nur was hier gebraucht wird). */
export interface DeviceInfo {
	name: string;
	inputChannels: number;
}

/** Vorgabe: das Gerät mit „MADI (5+6)" im Namen, zweiter Kanal = MADI 6 (Mono In 6). */
export const DEFAULT_INPUT: InputChoice = Object.freeze({ device: "MADI (5+6)", channel: 1 });

/**
 * Namen der Kanäle eines Geräts. Ein Paarname „<Name> (a+b) …" ergibt „<Name> a",
 * „<Name> b" (RME: „MADI (5+6) (RME MADIface Pro)" → „MADI 5", „MADI 6"; „Analog (1+2)
 * (…)" → „Analog 1", „Analog 2"). Kanäle, die das Paar nicht abdeckt, und alle anderen
 * Geräte: „<Gerätename> – Kanal n" (n ab 1).
 */
export function channelLabels(deviceName: string, channels: number): string[] {
	const out: string[] = [];
	const m = /^(.*?)\s*\((\d+)\s*\+\s*(\d+)\)/.exec(deviceName.trim());
	const prefix = m ? m[1].trim() : "";
	const first = m ? Number(m[2]) : NaN;
	const last = m ? Number(m[3]) : NaN;
	const span = m && prefix !== "" && last >= first ? last - first + 1 : 0;
	for (let i = 0; i < channels; i++) {
		out.push(i < span ? `${prefix} ${first + i}` : `${deviceName.trim()} – Kanal ${i + 1}`);
	}
	return out;
}

/** Anzeigename eines gewählten Eingangs (auch für einen Teilnamen wie „MADI (5+6)"). */
export function inputLabel(choice: InputChoice): string {
	const labels = channelLabels(choice.device, Math.max(choice.channel + 1, 1));
	return labels[choice.channel] ?? `${choice.device} – Kanal ${choice.channel + 1}`;
}

/** Alle Eingänge der Geräte als Mono-Kanäle, in Geräte- und Kanalreihenfolge. */
export function listChannels(devices: readonly DeviceInfo[]): InputItem[] {
	const items: InputItem[] = [];
	for (const d of devices) {
		if (!(d.inputChannels > 0)) continue;
		channelLabels(d.name, d.inputChannels).forEach((label, channel) => items.push({ device: d.name, channel, label }));
	}
	return items;
}

/**
 * Gerät zu einem gespeicherten Namen: zuerst exakt, dann ohne Groß/klein als Teil des
 * Namens (die Vorgabe „MADI (5+6)" trifft „MADI (5+6) (RME MADIface Pro)"). Nur Geräte
 * mit Eingängen zählen.
 */
export function findDevice<T extends DeviceInfo>(devices: readonly T[], wanted: string): T | null {
	const inputs = devices.filter((d) => d.inputChannels > 0);
	const exact = inputs.find((d) => d.name === wanted);
	if (exact) return exact;
	const w = wanted.trim().toLowerCase();
	if (w === "") return null;
	return inputs.find((d) => d.name.toLowerCase().includes(w)) ?? null;
}

/**
 * Setting „input" lesen: {device, channel} als Objekt oder als JSON-Text (so speichert
 * die Auswahl im Property Inspector ihren Wert). Fehlt es oder ist es kaputt: Vorgabe.
 */
export function parseInputSetting(value: unknown): InputChoice {
	let v: unknown = value;
	if (typeof v === "string") {
		try {
			v = JSON.parse(v);
		} catch {
			return DEFAULT_INPUT;
		}
	}
	if (typeof v !== "object" || v === null) return DEFAULT_INPUT;
	const o = v as { device?: unknown; channel?: unknown };
	const channel = Number(o.channel);
	if (typeof o.device !== "string" || o.device.trim() === "" || !Number.isInteger(channel) || channel < 0 || channel > 255) {
		return DEFAULT_INPUT;
	}
	return { device: o.device, channel };
}

/** Wert eines Eintrags der Auswahl (JSON-Text, siehe parseInputSetting). */
export function inputValue(choice: InputChoice): string {
	return JSON.stringify({ device: choice.device, channel: choice.channel });
}
