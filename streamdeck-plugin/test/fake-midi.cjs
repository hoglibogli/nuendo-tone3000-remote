/**
 * Ports im Speicher anstelle von @julusian/midi.
 *
 * Gleiche Form wie die Klassen des Pakets (soweit der MidiManager sie benutzt),
 * samt statischem getPortNames() und destroy(). Die Portlisten stehen in `ports`
 * und lassen sich im Test ändern — Ports verschwinden, kommen wieder, verschieben
 * sich. Jedes erzeugte Objekt wird mitgeschrieben, damit die Tests prüfen können,
 * was erzeugt, geöffnet, geschlossen und freigegeben wurde. `failure.list` (ein
 * Error) lässt getPortNames() werfen, wie /lazy ohne natives Binding.
 */
"use strict";

const ports = {
	inputs: [],
	outputs: [],
};
const created = { inputs: [], outputs: [] };
/** Wohin ein offener Ausgang sendet: (bytes, name) => void. */
let sink = null;
/** Fehler zum Einspielen: list = getPortNames() wirft diesen Error. */
const failure = { list: null };

function portNames(list) {
	if (failure.list) throw failure.list;
	return [...list];
}

class FakeInput {
	constructor() {
		this.handlers = [];
		this.openName = null;
		this.openCalls = 0;
		this.closeCalls = 0;
		this.destroyCalls = 0;
		this.ignored = null;
		created.inputs.push(this);
	}
	static getPortNames() {
		return portNames(ports.inputs);
	}
	getPortCount() {
		return ports.inputs.length;
	}
	getPortName(i) {
		return ports.inputs[i] ?? "";
	}
	ignoreTypes(sysex, timing, activeSensing) {
		this.ignored = [sysex, timing, activeSensing];
	}
	on(event, fn) {
		if (event === "message") this.handlers.push(fn);
		return this;
	}
	openPort(i) {
		if (i < 0 || i >= ports.inputs.length) throw new Error(`Eingang ${i} gibt es nicht`);
		this.openCalls++;
		this.openName = ports.inputs[i];
	}
	closePort() {
		this.closeCalls++;
		this.openName = null;
	}
	destroy() {
		this.destroyCalls++;
		this.openName = null;
	}
	isPortOpen() {
		return this.openName !== null;
	}
}

class FakeOutput {
	constructor() {
		this.openName = null;
		this.openCalls = 0;
		this.closeCalls = 0;
		this.destroyCalls = 0;
		this.sent = [];
		created.outputs.push(this);
	}
	static getPortNames() {
		return portNames(ports.outputs);
	}
	getPortCount() {
		return ports.outputs.length;
	}
	getPortName(i) {
		return ports.outputs[i] ?? "";
	}
	openPort(i) {
		if (i < 0 || i >= ports.outputs.length) throw new Error(`Ausgang ${i} gibt es nicht`);
		this.openCalls++;
		this.openName = ports.outputs[i];
	}
	closePort() {
		this.closeCalls++;
		this.openName = null;
	}
	destroy() {
		this.destroyCalls++;
		this.openName = null;
	}
	isPortOpen() {
		return this.openName !== null;
	}
	sendMessage(bytes) {
		if (this.openName === null) throw new Error("Port geschlossen");
		this.sent.push([...bytes]);
		if (sink) sink([...bytes], this.openName);
	}
}

/** Alle offenen Eingänge mit diesem Namen bekommen die Nachricht. */
function deliver(name, bytes) {
	let n = 0;
	for (const inp of created.inputs) {
		if (inp.openName !== name) continue;
		n++;
		for (const h of inp.handlers) h(0, [...bytes]);
	}
	return n;
}

function reset(inputs = [], outputs = []) {
	ports.inputs = [...inputs];
	ports.outputs = [...outputs];
	created.inputs.length = 0;
	created.outputs.length = 0;
	sink = null;
	failure.list = null;
}

module.exports = {
	backend: { Input: FakeInput, Output: FakeOutput },
	ports,
	created,
	failure,
	deliver,
	reset,
	setSink(fn) {
		sink = fn;
	},
};
