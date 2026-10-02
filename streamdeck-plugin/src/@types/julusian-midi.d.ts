/**
 * Knappe Typen für @julusian/midi (3.8.1).
 *
 * Das Paket liegt nur im .sdPlugin-Ordner (Laufzeit) und bleibt aus dem Bundle
 * heraus, der Compiler findet es also nicht im node_modules des Projekts. Hier steht
 * nur, was das Plugin benutzt. Das Plugin lädt den Einstieg „/lazy": Der wirft nicht
 * schon beim require, wenn das native Binding fehlt, sondern erst beim ersten
 * Zugriff (getPortNames, new Input/Output).
 */
declare module "@julusian/midi/lazy" {
	export class Input {
		constructor();
		/** Namen aller Eingänge; nativ über ein Hilfsobjekt, das sofort wieder frei ist. */
		static getPortNames(): string[];
		getPortCount(): number;
		getPortName(port: number): string;
		openPort(port: number): void;
		closePort(): void;
		/** Schließt und löscht das native RtMidiIn samt Callback. */
		destroy(): void;
		isPortOpen(): boolean;
		/** sysex, timing, activeSensing — true = diesen Typ übergehen. */
		ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
		on(event: "message", callback: (deltaTime: number, message: number[]) => void): this;
	}

	export class Output {
		constructor();
		/** Namen aller Ausgänge; nativ über ein Hilfsobjekt, das sofort wieder frei ist. */
		static getPortNames(): string[];
		getPortCount(): number;
		getPortName(port: number): string;
		openPort(port: number): void;
		closePort(): void;
		/** Schließt und löscht das native RtMidiOut. */
		destroy(): void;
		isPortOpen(): boolean;
		sendMessage(message: number[]): void;
	}
}
