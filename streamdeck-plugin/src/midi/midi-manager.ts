/**
 * Das Portpaar zu Nuendo, über @julusian/midi (RtMidi).
 *
 * Die Namen stehen fest (protokoll.md 1) und werden exakt verglichen: beide
 * enthalten „tone3000", ein Teilstring wäre mehrdeutig.
 *
 *   Ausgang  sd_tone3000   Deck → Nuendo
 *   Eingang  tone3000_sd   Nuendo → Deck
 *
 * Die Regeln aus der FaderBank (docs/erbe-trackinfo.md, Regeln 3 und 4) gelten:
 *
 *   - Ein offenes Handle wird nie grundlos geschlossen. Bei den Loopbacks der
 *     Windows MIDI Services setzt das Schließen eines Handles offenbar den Endpunkt
 *     zurück und macht Nuendos Handles ungültig; danach hilft nur ein Neustart von
 *     Nuendo. Ein Aussetzer (kein Pong) ist kein Grund.
 *   - Ein fehlender Port wird periodisch gesucht und geöffnet, sobald er da ist.
 *   - Verschwindet unser Port aus der Portliste, ist das Handle ohnehin tot: Es
 *     wird verworfen und beim Wiedererscheinen durch ein frisches ersetzt. Ein
 *     altes Handle wiederzuverwenden ist nicht sicher — es meldet Erfolg und
 *     empfängt nichts (Regel 4).
 *
 * Speicher: Ein `new Input()` von @julusian/midi hält seinen Callback nativ als
 * starke Referenz (Napi::Persistent); der Callback hält das Objekt. Ohne destroy()
 * wird es nie eingesammelt, samt RtMidiIn und Ringpuffer. Deshalb kommen die
 * Portnamen aus den statischen getPortNames() (nativ ein Hilfsobjekt, das sofort
 * wieder frei ist), und ein erzeugtes Objekt, das nicht geöffnet wurde oder dessen
 * Port verschwunden ist, wird mit destroy() freigegeben. Ein lebendes Handle nie.
 *
 * Laden: @julusian/midi kommt erst mit dem ersten maintain(), nicht beim Import.
 * Ein statischer Import landete im Bündel ganz oben, vor Absturzprotokoll und
 * SDK-Logger; fehlte das Paket oder sein natives Binding, endete der Prozess ohne
 * jede Spur (der Haupteinstieg prüft das Binding schon beim require). Jetzt wird
 * der Einstieg „/lazy" bei Bedarf geladen, und maintain() meldet jeden Fehler —
 * Paket fehlt, Binding fehlt — einmal im Log und versucht es beim nächsten Mal neu.
 *
 * Das Backend (Input/Output) wird hineingereicht, damit die Tests ein Portpaar im
 * Speicher benutzen können; das Modul selbst öffnet beim Laden nichts.
 */
import { describeMessage } from "./protocol";

export const PORT_OUT = "sd_tone3000";
export const PORT_IN = "tone3000_sd";

export type MessageListener = (message: number[]) => void;

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** Was der Manager von einem Eingang braucht (Teilmenge von @julusian/midi). */
export interface MidiInputPort {
	getPortCount(): number;
	getPortName(port: number): string;
	openPort(port: number): void;
	closePort(): void;
	/** Schließt und gibt das native Objekt frei. Nie auf einem lebenden Handle. */
	destroy(): void;
	ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
	on(event: "message", callback: (deltaTime: number, message: number[]) => void): unknown;
}

/** Was der Manager von einem Ausgang braucht. */
export interface MidiOutputPort {
	getPortCount(): number;
	getPortName(port: number): string;
	openPort(port: number): void;
	closePort(): void;
	/** Schließt und gibt das native Objekt frei. Nie auf einem lebenden Handle. */
	destroy(): void;
	sendMessage(message: number[]): void;
}

/** Die Klassen samt statischem getPortNames(): Portnamen ohne bleibendes Objekt. */
export interface MidiBackend {
	Input: { new (): MidiInputPort; getPortNames(): string[] };
	Output: { new (): MidiOutputPort; getPortNames(): string[] };
}

/** Das Backend selbst oder eine Funktion, die es beim ersten Bedarf lädt (und werfen darf). */
export type MidiBackendSource = MidiBackend | (() => MidiBackend);

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class MidiManager {
	/** null, solange ein Lader noch nicht erfolgreich lief. */
	private backend: MidiBackend | null;
	private input: MidiInputPort | null = null;
	private output: MidiOutputPort | null = null;
	private readonly listeners = new Set<MessageListener>();
	private logger: Logger = silent;
	/** Rohmitschnitt beider Richtungen, für die Fehlersuche. */
	private debug = false;
	/** Fehlende Ports nur einmal melden, nicht bei jeder Suche. */
	private missingLogged = { input: false, output: false };
	/** Zuletzt gemeldeter Fehler der Portliste; derselbe kommt nicht alle 3 s wieder. */
	private listError: string | null = null;

	constructor(
		private readonly source: MidiBackendSource,
		readonly inputName: string = PORT_IN,
		readonly outputName: string = PORT_OUT,
	) {
		this.backend = typeof source === "function" ? null : source;
	}

	/** Das Backend, beim ersten Aufruf geladen. Wirft, wenn es sich nicht laden lässt. */
	private midiBackend(): MidiBackend {
		if (!this.backend) this.backend = (this.source as () => MidiBackend)();
		return this.backend;
	}

	setLogger(logger: Logger): void {
		this.logger = logger;
	}

	setDebug(on: boolean): void {
		this.debug = on;
	}

	hasInput(): boolean {
		return this.input !== null;
	}

	hasOutput(): boolean {
		return this.output !== null;
	}

	/** Portnamen auflisten. Öffnet nichts und lässt kein Objekt zurück. Wirft, wenn MIDI fehlt. */
	listPorts(): { inputs: string[]; outputs: string[] } {
		const backend = this.midiBackend();
		return { inputs: [...backend.Input.getPortNames()], outputs: [...backend.Output.getPortNames()] };
	}

	/**
	 * Fehlende Ports öffnen, verschwundene verwerfen. Beliebig oft aufrufbar; ein
	 * offenes Handle, dessen Port noch in der Liste steht, bleibt unangetastet.
	 */
	maintain(): void {
		let ports: { inputs: string[]; outputs: string[] };
		try {
			ports = this.listPorts();
		} catch (e) {
			// Paket oder natives Binding fehlt (beides wirft erst hier). Einmal melden.
			const text = errorText(e);
			if (text !== this.listError) this.logger.error(`MIDI-Ports nicht lesbar: ${text}`);
			this.listError = text;
			return;
		}
		this.listError = null;

		if (this.input && !ports.inputs.includes(this.inputName)) {
			this.logger.warn(`MIDI-Eingang ${this.inputName} verschwunden; Handle verworfen`);
			release(this.input);
			this.input = null;
		}
		if (this.output && !ports.outputs.includes(this.outputName)) {
			this.logger.warn(`MIDI-Ausgang ${this.outputName} verschwunden; Handle verworfen`);
			release(this.output);
			this.output = null;
		}

		if (!this.input) this.input = this.openInput(ports.inputs);
		if (!this.output) this.output = this.openOutput(ports.outputs);
	}

	private openInput(names: string[]): MidiInputPort | null {
		const idx = names.indexOf(this.inputName);
		if (idx < 0) {
			if (!this.missingLogged.input) this.logger.warn(`MIDI-Eingang ${this.inputName} nicht gefunden; suche weiter`);
			this.missingLogged.input = true;
			return null;
		}
		// Immer ein frisches Objekt (Regel 4); der Index stammt aus derselben Aufzählung.
		let input: MidiInputPort;
		try {
			input = new (this.midiBackend().Input)();
		} catch (e) {
			this.logger.error(`MIDI-Eingang ${this.inputName}: RtMidi nicht bereit: ${errorText(e)}`);
			return null;
		}
		try {
			// SysEx empfangen (darüber kommt alles), Timing und Active Sensing nicht.
			input.ignoreTypes(false, true, true);
			input.on("message", (_delta, message) => this.onMessage(message));
			const port = findPort(input, this.inputName, idx);
			if (port < 0) {
				release(input);
				return null;
			}
			input.openPort(port);
		} catch (e) {
			this.logger.error(`MIDI-Eingang ${this.inputName} lässt sich nicht öffnen: ${errorText(e)}`);
			release(input);
			return null;
		}
		this.missingLogged.input = false;
		this.logger.info(`MIDI-Eingang geöffnet: ${this.inputName}`);
		return input;
	}

	private openOutput(names: string[]): MidiOutputPort | null {
		const idx = names.indexOf(this.outputName);
		if (idx < 0) {
			if (!this.missingLogged.output) this.logger.warn(`MIDI-Ausgang ${this.outputName} nicht gefunden; suche weiter`);
			this.missingLogged.output = true;
			return null;
		}
		let output: MidiOutputPort;
		try {
			output = new (this.midiBackend().Output)();
		} catch (e) {
			this.logger.error(`MIDI-Ausgang ${this.outputName}: RtMidi nicht bereit: ${errorText(e)}`);
			return null;
		}
		try {
			const port = findPort(output, this.outputName, idx);
			if (port < 0) {
				release(output);
				return null;
			}
			output.openPort(port);
		} catch (e) {
			this.logger.error(`MIDI-Ausgang ${this.outputName} lässt sich nicht öffnen: ${errorText(e)}`);
			release(output);
			return null;
		}
		this.missingLogged.output = false;
		this.logger.info(`MIDI-Ausgang geöffnet: ${this.outputName}`);
		return output;
	}

	/** Rohe MIDI-Bytes senden. false, wenn kein Ausgang offen ist oder das Senden scheitert. */
	send(bytes: number[]): boolean {
		if (!this.output) return false;
		if (this.debug) this.logger.info(`TX ${describeMessage(bytes)}`);
		try {
			this.output.sendMessage(bytes);
			return true;
		} catch (e) {
			this.logger.error(`MIDI senden fehlgeschlagen: ${errorText(e)}`);
			return false;
		}
	}

	addListener(fn: MessageListener): void {
		this.listeners.add(fn);
	}

	removeListener(fn: MessageListener): void {
		this.listeners.delete(fn);
	}

	private onMessage(message: number[]): void {
		if (this.debug) this.logger.info(`RX ${describeMessage(message)}`);
		for (const fn of this.listeners) {
			try {
				fn(message);
			} catch (e) {
				this.logger.error(`MIDI-Empfänger fehlgeschlagen: ${errorText(e)}`);
			}
		}
	}
}

/**
 * Den Port mit exakt diesem Namen finden. Erst am Index aus der Aufzählung, sonst
 * die ganze Liste — falls sich die Reihenfolge seither verschoben hat.
 */
function findPort(port: MidiInputPort | MidiOutputPort, name: string, hint: number): number {
	const count = port.getPortCount();
	if (hint < count && port.getPortName(hint) === name) return hint;
	for (let i = 0; i < count; i++) {
		if (port.getPortName(i) === name) return i;
	}
	return -1;
}

/**
 * Ein Objekt freigeben, das nicht (mehr) gebraucht wird: nie geöffnet, oder sein
 * Port ist aus der Liste verschwunden (das Handle ist dann ohnehin tot). destroy()
 * schließt und löscht das native RtMidi samt Callback. Nie für ein lebendes Handle.
 */
function release(port: MidiInputPort | MidiOutputPort): void {
	try {
		port.destroy();
	} catch {
		/* war schon frei */
	}
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * @julusian/midi laden, erst beim ersten Bedarf. „/lazy" wirft beim require nicht,
 * wenn nur das native Binding fehlt, sondern erst bei getPortNames(); fehlt das
 * ganze Paket, wirft schon dieses require — beides fängt maintain().
 */
function loadJulusianMidi(): MidiBackend {
	const mod = require("@julusian/midi/lazy") as typeof import("@julusian/midi/lazy");
	return { Input: mod.Input, Output: mod.Output };
}

/** Ein Manager für den ganzen Plugin-Prozess. */
export const midi = new MidiManager(loadJulusianMidi);
