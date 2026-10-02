/**
 * Nachgebaute MIDI-Remote-API v1 für Vincent_Tone3000.js — ohne Nuendo, ohne MIDI-Ports.
 *
 * Abgeleitet vom Trockenlauf-Stub aus dem Suchlauf (2026-10-01), aber mit ausdrücklichen
 * Objekten statt Proxy-Ketten: Ruft das Script etwas auf, das hier nicht nachgebaut ist,
 * wirft es — so fällt ein Tippfehler im API-Namen auf, statt still ins Leere zu laufen.
 *
 * Nachgebaut ist, was das Script braucht, mit dem Verhalten, das am Gerät belegt ist:
 *   - Eingangszone mit 32 Kanälen; Platz 6 trägt Input 6 samt Inserts (16 Slots):
 *     Slot 1 Steinbergs "Tuner" (12 Parameter wie im Suchlauf 2026-10-02_125415, Klassen-
 *     kennung "6B9B08D2…-0"), Slot 2 "H-Delay Mono", Slot 3 "TONE3000" (2125 Parameter,
 *     "Program" auf Index 44, dahinter 2080 "MIDI CC"-Platzhalter, Tags wie am Gerät).
 *   - Der Tuner misst auf Bestellung (tunerInput): Er setzt alle Messwerte eines Durchgangs
 *     und meldet danach jeden geänderten Parameter in der Reihenfolge vom Gerät (Cent, Oct,
 *     Note, Locked, Frequency, In Tune). Klartexte wie am Gerät: Note "E " mit Leerzeichen,
 *     Stille "--", Oct bei Stille leer. Ob er Werte meldet, die das Script setzt (Mute),
 *     ist am Gerät ungeprüft; wie bei TONE3000 nur mit ownSetsNotify.
 *   - DirectAccess je Kanal; mOnParameterChange meldet nur Objekte UNTER dem Kanal
 *     (Kanalparameter wie Mute meldet Nuendo dort nicht, FaderBank E-25).
 *   - "Program" meldet sich selbst nicht; ein Presetwechsel meldet alle übrigen echten
 *     Parameter einmal (Suchlauf 2026-10-01). Ein Druck auf das aktive Preset lädt nicht neu.
 *   - Ein Plugin meldet Werte, die das Script per DirectAccess setzt, NICHT zurück: JUCE
 *     übergeht in paramChanged jeden vom Host gesetzten Parameter, und im Suchlauf kam für
 *     das selbst gesetzte "Program" kein Callback. Für die Regler am Gerät ungeprüft, deshalb
 *     umschaltbar (ownSetsNotify). Parameter von Nuendo selbst (Slot) melden sich weiter.
 *   - setParameterDisplayValue auf "Program" wählt per Namen, Unbekanntes wird still ignoriert.
 *   - Insert-Viewer je Slot mit mEdit, mBypass, mOn und Parameter-Bank-Zone (Titel = Plugin-Name).
 *   - Value-Bindings: Note -> Surface-Wert -> Hostwert -> alle gebundenen Surface-Werte.
 *   - Entfernte Objekte: getObjectTitle liefert "", jeder andere Zugriff wirft.
 *
 * Aufgezeichnet wird alles, was die Tests prüfen: gesendete Frames, Bindungen, Tasten,
 * Viewer, Host-Aktionen (log), Ausnahmen, die einen Callback verlassen (callbackErrors).
 */
"use strict";

const Module = require("module");

const TAG = {
	input: 1368699459,
	bass: 1128262618,
	mid: 1006241759,
	treble: 307695311,
	output: 1305090924,
	bypass: 1652130012,
	program: 1886553053,
	longTitle: 4999,
};

// Steinbergs Tuner, Tags laut Suchlauf 2026-10-02_125415.
const TUNER_TAG = {
	mute: 4201,
	frequency: 4202,
	note: 4203,
	cent: 4204,
	oct: 4205,
	bypass: 4207,
	reset: 4208,
	locked: 4209,
	inTune: 4210,
	base: 4211,
	anaDig: 4212,
	strobe: 4213,
};
const TUNER_CLASS = "6B9B08D2CA294270BF092A62865521BF-0";
// Note = MIDI-Notennummer - 2, 0..89 (am Gerät: E1 = MIDI 28 kam als roh 0.2921 = 26/89).
const NOTE_NAMES = ["C ", "C#", "D ", "D#", "E ", "F ", "F#", "G ", "G#", "A ", "A#", "B "];

const LONG_TITLE = "Ein sehr langer Parametername mit Ümlauten und noch mehr Text dahinter";

// Presets wie in TONE3000: eigene alphabetisch. Werte frei gewählt, Bass je Preset verschieden,
// damit jeder Wechsel in der Beobachtung sichtbar wird. Der Gain bleibt beim Wechsel stehen.
// Dahinter eines mit einem 4-Byte-Zeichen (Surrogatpaar), angehängt, damit die Nummern der
// übrigen bleiben.
const PRESETS = [
	{ name: "Calfinornia", bass: 0.5, mid: 0.5, treble: 0.5 },
	{ name: "Einstein Halbgas", bass: 0.55, mid: 0.45, treble: 0.6 },
	{ name: "Einstein Vollgas", bass: 0.6, mid: 0.4, treble: 0.7 },
	{ name: "HMT", bass: 0.45, mid: 0.5, treble: 0.5 },
	{ name: "JCM 2000", bass: 0.522, mid: 0.484, treble: 0.768 },
	{ name: "Matchless", bass: 0.65, mid: 0.55, treble: 0.45 },
	{ name: "Vox AC 30", bass: 0.7, mid: 0.6, treble: 0.65 },
	{ name: "Lead \u{1F525}", bass: 0.4, mid: 0.7, treble: 0.8 },
];

const INPUT_BASE = 100; // Basisobjekt von Platz 6
const INSERTS = 200;
const SLOT_BASE = 300; // Slot n (1..16) = 300 + n
const TUNER = 401;
const DELAY = 402;
const TONE3000 = 403;

function onOff(v) {
	return v >= 0.5 ? "On" : "Off";
}

function param(tag, title, o = {}) {
	const lo = o.lo ?? 0;
	const hi = o.hi ?? 1;
	return {
		tag,
		title,
		value: o.value ?? 0,
		def: o.def ?? o.value ?? 0,
		lo,
		hi,
		type: o.type ?? "continuous",
		auto: o.auto ?? true,
		lock: o.lock ?? false,
		units: o.units ?? "",
		display: o.display ?? ((v) => String(Math.round((lo + v * (hi - lo)) * 100) / 100)),
		fromText: o.fromText,
		textOverride: null,
		onSet: o.onSet,
	};
}

/**
 * Ein nachgebauter Host. options:
 *   slot1      "tuner" (Vorgabe, Steinbergs Tuner) | "gtr" (GTR Tuner Mono) | "leer" | ein anderer Titel
 *   slot3      "tone3000" (Vorgabe) | "leer" | ein anderer Plugin-Titel
 *   programAt  Index von "Program" (Vorgabe 44 wie in 0.0.11; 450 = mitten im MIDI-CC-Block)
 *   programNotifies  true: auch "Program" meldet einen Callback (am Gerät: nein)
 *   ownSetsNotify    true: ein Plugin meldet auch Werte, die das Script per DirectAccess setzt
 *                    (Vorgabe false, gerätenah; für die Regler am Gerät ungeprüft)
 */
function createHost(options = {}) {
	const host = {
		sent: [], // Frames des Scripts, in Reihenfolge
		log: [], // was der Host getan hat
		logTimes: [],
		callbackErrors: [], // Ausnahmen, die einen Callback verlassen haben
		bindings: [], // { sv, hv, toggle }
		buttons: [], // { x, y, w, h, sv }
		surfaceValues: [],
		commandBindings: [],
		viewers: [],
		channels: [],
		accesses: [],
		zones: [],
		objects: {},
		removed: new Set(),
		hostValues: new Map(),
		faults: [],
		calls: { total: 0 }, // DirectAccess-Aufrufe je Name, für Kostenprüfungen
		asyncMs: -1, // < 0: Callbacks synchron; sonst so viele echte ms verzögert
		mapping: { name: "activeMapping" },
		device: { name: "activeDevice" },
		sysexHandler: null,
		activateHandler: null,
		midiInput: null,
		onSend: null, // Haken für den Werkzeug-Lauf
		options,
	};
	const realSetTimeout = setTimeout;

	function logHost(text) {
		host.log.push(text);
		host.logTimes.push(performance.now());
	}

	/** Jeder Aufruf vom Host ins Script läuft hierüber: Ausnahmen werden gezählt, nicht geworfen. */
	function invoke(label, fn, ...args) {
		if (typeof fn !== "function") return;
		try {
			fn(...args);
		} catch (e) {
			host.callbackErrors.push(`${label}: ${(e && e.stack) || e}`);
		}
	}

	function later(label, fn, ...args) {
		if (host.asyncMs < 0) invoke(label, fn, ...args);
		else realSetTimeout(() => invoke(label, fn, ...args), host.asyncMs);
	}

	//--------------------------------------------------------------------------
	// Objektmodell für DirectAccess
	//--------------------------------------------------------------------------
	function obj(id, type, title, params, kids = [], uniqueName = null) {
		const o = { id, type, title, params, kids, uniqueName, byTag: new Map() };
		for (const p of params) o.byTag.set(p.tag, p);
		host.objects[id] = o;
		host.removed.delete(id);
		return o;
	}

	function slotParams() {
		return [
			param(4098, "On", { value: 1, display: onOff, type: "discrete" }),
			param(4101, "Edit", { display: onOff, type: "discrete" }),
			param(4102, "Bypass", { display: onOff, type: "discrete" }),
			param(4125, "Effect Type", { display: () => "Plugin", auto: false }),
		];
	}

	function midiCCParams(baseTag) {
		const out = [];
		for (let c = 0; c < 16; c++) {
			for (let n = 0; n < 130; n++) {
				const title = `MIDI CC ${c}|${n}`;
				out.push(param(baseTag + c * 130 + n, title, {
					display: (v) => String(Math.round(v * 127)),
					auto: false,
					onSet: (p, v) => logHost(`JUCE: ${title} -> CC ${n} Kanal ${c + 1} Wert ${Math.round(v * 127)}`),
				}));
			}
		}
		return out;
	}

	/** TONE3000 0.0.11: 45 echte Parameter, "Program" auf Index 44, dann 2080 MIDI CC. */
	function makeTone3000(id, title = "TONE3000") {
		const knob = (v) => (v * 10).toFixed(2);
		const real = [
			param(TAG.input, "inputLevel", { value: 0.4992, def: 0.5, display: (v) => v.toFixed(4) }),
			param(TAG.bass, "toneBass", { value: 0.5, display: knob }),
			param(TAG.mid, "toneMid", { value: 0.5, display: knob }),
			param(TAG.treble, "toneTreble", { value: 0.5, display: knob }),
			param(TAG.output, "outputLevel", { value: 0.4717, display: (v) => v.toFixed(4) }),
		];
		for (let i = 5; i < 42; i++) real.push(param(5000 + i, `realParam${i}`));
		real.push(param(TAG.longTitle, LONG_TITLE, { display: () => "äöü" }));
		real.push(param(TAG.bypass, "Bypass", { display: onOff, type: "discrete" }));
		const program = param(TAG.program, "Program", {
			lo: 0,
			hi: 127,
			type: "discrete",
			display: (v) => (PRESETS[Math.round(v * 127)] ? PRESETS[Math.round(v * 127)].name : `Programm ${Math.round(v * 127)}`),
			fromText: (t) => {
				const i = PRESETS.findIndex((p) => p.name === t);
				return i < 0 ? null : i / 127;
			},
			onSet: (p, v, oid, previous) => loadPreset(oid, Math.round(v * 127), previous),
		});
		const cc = midiCCParams(100000);
		const at = options.programAt ?? 44;
		let params;
		if (at <= real.length) params = [...real, program, ...cc];
		else params = [...real, ...cc.slice(0, at - real.length), program, ...cc.slice(at - real.length)];
		return obj(id, "Plugin", title, params);
	}

	/** Steinbergs Tuner: 12 Parameter in der Reihenfolge vom Gerät, Startzustand Stille. */
	function makeSteinbergTuner(id, title = "Tuner") {
		const plain = (lo, hi, digits) => (v) => (lo + v * (hi - lo)).toFixed(digits);
		const sw = { display: onOff, type: "discrete", units: "On/Off" };
		return obj(id, "Plugin", title, [
			param(TUNER_TAG.mute, "Mute", { display: onOff, type: "discrete" }),
			param(TUNER_TAG.bypass, "Bypass", sw),
			param(TUNER_TAG.base, "Base", { lo: 425, hi: 455, value: 0.5, display: plain(425, 455, 1), type: "discrete", units: "Hz" }),
			param(TUNER_TAG.frequency, "Frequency", { lo: 0, hi: 4000, display: plain(0, 4000, 1), units: "Hz", auto: false }),
			param(TUNER_TAG.note, "Note", {
				lo: 0,
				hi: 89,
				type: "discrete",
				auto: false,
				display: (v) => (v <= 0 ? "--" : NOTE_NAMES[(Math.round(v * 89) + 2) % 12]),
			}),
			param(TUNER_TAG.cent, "Cent", { lo: -50, hi: 50, value: 0.01, def: 0.5, auto: false, display: (v) => String(Math.round(v * 100 - 50)) }),
			param(TUNER_TAG.oct, "Oct", { lo: -50, hi: 50, value: 0, def: 0.5, auto: false, display: (v) => (v <= 0 ? "" : String(Math.round(v * 100 - 50))) }),
			param(TUNER_TAG.reset, "Reset", { display: onOff, type: "discrete", auto: false }),
			param(TUNER_TAG.locked, "Locked", { ...sw, auto: false }),
			param(TUNER_TAG.inTune, "In Tune", { ...sw, auto: false }),
			param(TUNER_TAG.anaDig, "AnaDig", { ...sw, auto: false }),
			param(TUNER_TAG.strobe, "Strobe", sw),
		], [], TUNER_CLASS);
	}

	/**
	 * Preset laden wie TONE3000: EQ verstellen, dann jeden echten Parameter außer "Program"
	 * einmal melden. Ein Druck auf das aktive Preset lädt nicht neu.
	 */
	function loadPreset(id, index, previousIndex, setProgram) {
		const o = host.objects[id];
		const preset = PRESETS[index];
		if (!preset || index === previousIndex) return;
		logHost(`TONE3000 id=${id}: lädt Preset "${preset.name}"`);
		if (setProgram) o.byTag.get(TAG.program).value = index / 127;
		o.byTag.get(TAG.bass).value = preset.bass;
		o.byTag.get(TAG.mid).value = preset.mid;
		o.byTag.get(TAG.treble).value = preset.treble;
		for (const p of o.params) {
			if (p.title.startsWith("MIDI CC")) continue;
			if (p.tag === TAG.program && !options.programNotifies) continue;
			notifyChange(id, p.tag);
		}
	}

	// Platz 6: Input 6 mit Inserts und 16 Slots
	obj(INPUT_BASE, "InputChannel", "Mono In 6", [
		param(1027, "Mute", { display: onOff, type: "discrete" }),
		param(1025, "Volume", { lock: true }),
		param(4012, "Peak", { display: () => "-oo" }),
	], [150, INSERTS]);
	obj(150, "Quick Controls", "Quick Controls", []);
	const slotIDs = [];
	for (let n = 1; n <= 16; n++) {
		slotIDs.push(SLOT_BASE + n);
		obj(SLOT_BASE + n, "Slot", String(n), slotParams());
	}
	obj(INSERTS, "Inserts", "Inserts", [param(4096, "Bypass", { display: onOff })], slotIDs);
	const slot1 = options.slot1 ?? "tuner";
	if (slot1 === "tuner") makeSteinbergTuner(TUNER);
	else if (slot1 === "gtr") obj(TUNER, "Plugin", "GTR Tuner Mono", [param(1, "Pitch")]);
	else if (slot1 !== "leer") obj(TUNER, "Plugin", slot1, [param(7, "Gain")]);
	if (slot1 !== "leer") host.objects[SLOT_BASE + 1].kids = [TUNER];
	// Delay mit 450 Parametern: prüft die Obergrenze gelisteter Zeilen im Suchlauf.
	obj(DELAY, "Plugin", "H-Delay Mono", Array.from({ length: 450 }, (_, i) => param(10000 + i, `Delay Param ${i}`)));
	host.objects[SLOT_BASE + 2].kids = [DELAY];
	const slot3 = options.slot3 ?? "tone3000";
	if (slot3 === "tone3000") {
		makeTone3000(TONE3000);
		host.objects[SLOT_BASE + 3].kids = [TONE3000];
	} else if (slot3 !== "leer") {
		obj(TONE3000, "Plugin", slot3, [param(7, "Gain")]);
		host.objects[SLOT_BASE + 3].kids = [TONE3000];
	}

	function contains(rootID, id) {
		if (rootID === id) return true;
		const o = host.objects[rootID];
		if (!o || host.removed.has(rootID)) return false;
		return o.kids.some((k) => contains(k, id));
	}

	/**
	 * Meldet sich ein Setzen durch das Script? "Program" nie (Gerät), ein anderer
	 * Plugin-Parameter nur mit ownSetsNotify, Parameter von Nuendo selbst (Slot) immer.
	 */
	function ownSetNotifies(id, tag) {
		if (tag === TAG.program && !options.programNotifies) return false;
		if (host.objects[id].type === "Plugin") return !!options.ownSetsNotify;
		return true;
	}

	/** Der Host meldet eine Änderung an jedes DirectAccess-Objekt, unter dessen Kanal sie liegt. */
	function notifyChange(id, tag) {
		for (const a of host.accesses) {
			if (!a.mOnParameterChange) continue;
			if (id === a._base || !contains(a._base, id)) continue; // Kanalebene meldet Nuendo nicht
			later(`mOnParameterChange Platz ${a._index}`, a.mOnParameterChange, host.device, host.mapping, id, tag);
		}
	}

	//--------------------------------------------------------------------------
	// Hostwerte und Surface-Werte
	//--------------------------------------------------------------------------
	function hv(key) {
		let v = host.hostValues.get(key);
		if (!v) {
			v = { key, value: 0, bindings: [] };
			host.hostValues.set(key, v);
		}
		return v;
	}

	/** Hostwert ändern (Nuendo selbst oder über ein Binding) und an alle Bindungen melden. */
	function setHostValue(key, value, origin = "Host") {
		const v = hv(key);
		if (v.value === value) return;
		v.value = value;
		logHost(`Hostwert ${key} = ${value} (${origin})`);
		mirrorToDirectAccess(key, value);
		for (const b of v.bindings) setSurface(b.sv, value);
	}

	/** Mute und Slot-Zustände stehen in Nuendo auch als DirectAccess-Parameter. */
	function mirrorToDirectAccess(key, value) {
		let m = /^ch6\.slot(\d+)\.(edit|bypass)$/.exec(key);
		if (m) {
			const slotID = SLOT_BASE + Number(m[1]) + 1;
			const tag = m[2] === "edit" ? 4101 : 4102;
			const p = host.objects[slotID].byTag.get(tag);
			if (p.value !== value) {
				p.value = value;
				notifyChange(slotID, tag);
			}
			return;
		}
		m = /^ch6\.mute$/.exec(key);
		if (m) host.objects[INPUT_BASE].byTag.get(1027).value = value;
	}

	function setSurface(sv, value) {
		const old = sv.value;
		sv.value = value;
		if (old === value) return;
		later(`mOnProcessValueChange ${sv.name}`, sv.mOnProcessValueChange, host.device, value);
		const cmd = host.commandBindings.find((c) => c.sv === sv);
		if (cmd) {
			later(`Command-Binding ${cmd.key}`, cmd.obj.mOnValueChange, host.device, host.mapping, value, value - old);
			if (old >= 0.5 && value < 0.5) {
				logHost(KNOWN_COMMANDS.has(cmd.key) ? `Befehl ${cmd.key} ausgeführt` : `Befehl ${cmd.key} unbekannt, nichts passiert`);
			}
		}
	}

	/** Ein Surface-Wert ändert sich vom Gerät aus (Note) oder per setProcessValue im Script. */
	function surfaceInput(sv, value, origin) {
		const old = sv.value;
		setSurface(sv, value);
		if (old === value) return;
		for (const b of host.bindings.filter((x) => x.sv === sv)) setHostValue(b.hv.key, value >= 0.5 ? 1 : 0, origin);
	}

	const KNOWN_COMMANDS = new Set(["Preset/Next", "Preset/Previous", "Preset/Open Browser"]);

	function makeSurfaceValue(name) {
		const sv = {
			name,
			value: 0,
			note: null,
			inputPort: null,
			setProcessValue(dev, v) {
				logHost(`setProcessValue ${name} = ${v}`);
				surfaceInput(sv, v, "Script");
			},
		};
		sv.mMidiBinding = {
			setInputPort(port) {
				sv.inputPort = port;
				return sv.mMidiBinding;
			},
			bindToNote(channel, note) {
				sv.note = { channel, note };
				return sv.mMidiBinding;
			},
		};
		host.surfaceValues.push(sv);
		return sv;
	}

	//--------------------------------------------------------------------------
	// DirectAccess
	//--------------------------------------------------------------------------
	/** Fehler auf Bestellung: fail(name, { times, when(args) }) wirft beim nächsten passenden Aufruf. */
	function checkFault(name, args) {
		const f = host.faults.find((x) => x.name === name && x.times > 0 && (!x.when || x.when(args)));
		if (!f) return;
		f.times--;
		throw new Error(`${name} verweigert (Test)`);
	}

	function O(id) {
		const o = host.objects[id];
		if (!o || host.removed.has(id)) throw new Error(`Objekt ${id} unbekannt`);
		return o;
	}

	function P(id, tag) {
		const p = O(id).byTag.get(tag);
		if (!p) throw new Error(`Tag ${tag} an Objekt ${id} unbekannt`);
		return p;
	}

	function makeAccess(channel) {
		const index = channel.index;
		const base = index === 6 ? INPUT_BASE : 1000 + index;
		if (!host.objects[base]) {
			obj(base, "InputChannel", index === 0 ? "Stereo In 1-2" : `Mono In ${index}`, [param(1027, "Mute", { display: onOff })]);
		}
		const a = { _index: index, _base: base, activated: null };
		const api = {
			activate(m) {
				a.activated = m;
				// Wie es ein Host tun könnte: Callbacks mitten in der Aktivierung.
				if (options.objectChangeOnActivate) invoke("mOnObjectChange in activate", a.mOnObjectChange, host.device, m, base);
			},
			getBaseObjectID: (m) => base,
			getNumberOfChildObjects: (m, id) => O(id).kids.length,
			getChildObjectID: (m, id, i) => O(id).kids[i],
			getObjectTypeName: (m, id) => O(id).type,
			getObjectTitle: (m, id) => (host.objects[id] && !host.removed.has(id) ? host.objects[id].title : ""),
			getObjectUniqueName: (m, id) => O(id).uniqueName ?? "uniq" + O(id).id,
			getObjectUniqueIDString: (m, id) => "UID" + O(id).id,
			getMixerChannelIndex: () => index,
			getMixerChannelZone: () => 0,
			isMixerChannelVisible: () => true,
			getNumberOfParameters: (m, id) => O(id).params.length,
			getParameterTagByIndex: (m, id, i) => O(id).params[i].tag,
			getParameterTitle: (m, id, tag, maxLength) => P(id, tag).title.slice(0, maxLength),
			getParameterDisplayValue: (m, id, tag) => {
				const p = P(id, tag);
				return p.textOverride ?? p.display(p.value);
			},
			getParameterDisplayUnits: (m, id, tag) => P(id, tag).units,
			getParameterProcessValue: (m, id, tag) => P(id, tag).value,
			getParameterDefaultProcessValue: (m, id, tag) => P(id, tag).def,
			getParameterProcessValueType: (m, id, tag) => P(id, tag).type,
			isParameterAutomatable: (m, id, tag) => P(id, tag).auto,
			getParameterEditLockState: (m, id, tag) => P(id, tag).lock,
			convertParameterProcessValueToPlain: (m, id, tag, v) => {
				const p = P(id, tag);
				return p.lo + v * (p.hi - p.lo);
			},
			convertParameterPlainToProcessValue: (m, id, tag, plain) => {
				const p = P(id, tag);
				return (plain - p.lo) / (p.hi - p.lo);
			},
			setParameterProcessValue(m, id, tag, v) {
				const p = P(id, tag);
				if (typeof v !== "number" || !(v >= 0 && v <= 1)) throw new Error("ungültiger Wert " + v);
				const previous = Math.round(p.value * 127);
				p.value = v;
				p.textOverride = null;
				logHost(`setParameterProcessValue id=${id} tag=${tag} ${v}`);
				mirrorFromDirectAccess(id, tag, v);
				if (p.onSet) p.onSet(p, v, id, previous);
				if (ownSetNotifies(id, tag)) notifyChange(id, tag);
			},
			setParameterDisplayValue(m, id, tag, text) {
				const p = P(id, tag);
				logHost(`setParameterDisplayValue id=${id} tag=${tag} "${text}"`);
				if (p.fromText) {
					const v = p.fromText(text);
					if (v === null) return; // Host ignoriert Unbekanntes still
					const previous = Math.round(p.value * 127);
					p.value = v;
					if (p.onSet) p.onSet(p, v, id, previous);
				} else {
					p.textOverride = text;
				}
				if (ownSetNotifies(id, tag)) notifyChange(id, tag);
			},
		};
		for (const [name, fn] of Object.entries(api)) {
			a[name] = (...args) => {
				host.calls[name] = (host.calls[name] || 0) + 1;
				host.calls.total++;
				if (name !== "activate" && !args[0]) throw new Error(`${name} ohne activeMapping`);
				if (name !== "activate" && !a.activated) throw new Error(`${name} vor activate()`);
				checkFault(name, args);
				return fn(...args);
			};
		}
		host.accesses.push(a);
		return a;
	}

	/** Bypass eines Slots per DirectAccess gesetzt: auch der Hostwert des Viewers folgt. */
	function mirrorFromDirectAccess(id, tag, v) {
		const n = id - SLOT_BASE;
		if (n < 1 || n > 16 || (tag !== 4101 && tag !== 4102)) return;
		const key = `ch6.slot${n - 1}.${tag === 4101 ? "edit" : "bypass"}`;
		const value = v >= 0.5 ? 1 : 0;
		const h = hv(key);
		if (h.value === value) return;
		h.value = value;
		for (const b of h.bindings) setSurface(b.sv, value);
	}

	//--------------------------------------------------------------------------
	// Kanäle, Viewer, Page, Surface, Treiber
	//--------------------------------------------------------------------------
	function makeViewer(channel, name) {
		const zone = { titleHandler: null, paramValues: 0 };
		const viewer = {
			name,
			channelIndex: channel.index,
			slot: null,
			zone,
			mParameterBankZone: {
				makeParameterValue() {
					zone.paramValues++;
					return { mOnTitleChange: null };
				},
				set mOnTitleChange(fn) {
					zone.titleHandler = fn;
				},
				get mOnTitleChange() {
					return zone.titleHandler;
				},
			},
			accessSlotAtIndex(i) {
				viewer.slot = i;
				return viewer;
			},
			get mEdit() {
				return hv(`ch${channel.index}.slot${viewer.slot}.edit`);
			},
			get mBypass() {
				return hv(`ch${channel.index}.slot${viewer.slot}.bypass`);
			},
			get mOn() {
				return hv(`ch${channel.index}.slot${viewer.slot}.on`);
			},
		};
		host.viewers.push(viewer);
		return viewer;
	}

	function makeChannel(zone) {
		const index = host.channels.length;
		const channel = {
			index,
			zone,
			mOnTitleChange: null,
			mValue: {
				get mMute() {
					return hv(`ch${index}.mute`);
				},
				get mSolo() {
					return hv(`ch${index}.solo`);
				},
			},
			mInsertAndStripEffects: {
				makeInsertEffectViewer: (name) => makeViewer(channel, name),
			},
		};
		host.channels.push(channel);
		return channel;
	}

	const page = {
		mHostAccess: {
			mMixConsole: {
				makeMixerBankZone(name) {
					const zone = { name, inputsOnly: false };
					zone.includeInputChannels = () => {
						zone.inputsOnly = true;
						return zone;
					};
					zone.makeMixerBankChannel = () => makeChannel(zone);
					host.zones.push(zone);
					return zone;
				},
			},
			makeDirectAccess: (channel) => makeAccess(channel),
		},
		makeValueBinding(sv, hostValue) {
			if (!sv || !hostValue || typeof hostValue.key !== "string") throw new Error("makeValueBinding: kein Hostwert");
			const b = { sv, hv: hostValue, toggle: false };
			b.api = {
				setTypeToggle() {
					b.toggle = true;
					return b.api;
				},
				setTypeDefault() {
					return b.api;
				},
			};
			hostValue.bindings.push(b);
			host.bindings.push(b);
			return b.api;
		},
		makeCommandBinding(sv, category, name) {
			const key = `${category}/${name}`;
			const b = { canPerform: (m) => !!m && KNOWN_COMMANDS.has(key), mOnValueChange: null };
			host.commandBindings.push({ sv, key, obj: b });
			return b;
		},
		set mOnActivate(fn) {
			host.activateHandler = fn;
		},
	};

	const surface = {
		makeButton(x, y, w, h) {
			const sv = makeSurfaceValue(`button@${x},${y}`);
			host.buttons.push({ x, y, w, h, sv });
			return { mSurfaceValue: sv };
		},
		makeCustomValueVariable: (name) => makeSurfaceValue("var:" + name),
	};

	const midiOutput = {
		sendMidi(dev, bytes) {
			const frame = Array.from(bytes);
			host.sent.push(frame);
			if (host.onSend) host.onSend(frame);
		},
	};

	host.api = {
		makeDeviceDriver(vendor, device, author) {
			host.driverName = `${vendor}/${device}/${author}`;
			const detection = {
				detectPortPair() {
					return detection;
				},
				expectInputNameEquals(name) {
					host.expectInput = name;
					return detection;
				},
				expectOutputNameEquals(name) {
					host.expectOutput = name;
					return detection;
				},
			};
			return {
				mPorts: {
					makeMidiInput(name) {
						host.midiInput = {
							name,
							set mOnSysex(fn) {
								host.sysexHandler = fn;
							},
						};
						return host.midiInput;
					},
					makeMidiOutput: () => midiOutput,
				},
				makeDetectionUnit: () => detection,
				mSurface: surface,
				mMapping: { makePage: () => page },
			};
		},
	};

	//--------------------------------------------------------------------------
	// Steuerung für die Tests
	//--------------------------------------------------------------------------
	host.TAG = TAG;
	host.PRESETS = PRESETS;
	host.IDS = { INPUT_BASE, INSERTS, SLOT_BASE, TUNER, DELAY, TONE3000 };
	host.logHost = logHost;
	host.invoke = invoke;
	host.notifyChange = notifyChange;
	host.setHostValue = setHostValue;
	host.hostValue = (key) => hv(key).value;
	host.param = (id, tag) => P(id, tag);
	host.makeTone3000 = makeTone3000;
	host.makeSteinbergTuner = makeSteinbergTuner;

	/** Das Script laden; require("midiremote_api_v1") liefert diesen Host. */
	host.load = (scriptPath) => {
		const resolved = require.resolve(scriptPath);
		delete require.cache[resolved];
		const origLoad = Module._load;
		Module._load = function (request, ...rest) {
			if (request === "midiremote_api_v1") return host.api;
			return origLoad.call(this, request, ...rest);
		};
		try {
			require(resolved);
		} finally {
			Module._load = origLoad;
			delete require.cache[resolved];
		}
		return host;
	};

	host.activate = () => invoke("mOnActivate", host.activateHandler, host.device, host.mapping);

	host.setInputTitle = (index, title) => {
		const ch = host.channels[index];
		invoke(`mOnTitleChange Platz ${index}`, ch.mOnTitleChange, host.device, host.mapping, title);
	};

	/** Titel wie in der MixConsole: Platz 0 "Stereo In 1-2", dann "Mono In n". */
	host.setInputTitles = (overrides = {}) => {
		for (let i = 0; i < host.channels.length; i++) {
			const title = overrides[i] ?? (i === 0 ? "Stereo In 1-2" : `Mono In ${i}`);
			host.setInputTitle(i, title);
		}
	};

	/** Plugin-Name eines Slots, wie ihn die Parameter-Bank-Zone jedes passenden Viewers meldet. */
	host.setSlotTitle = (channelIndex, slot, title) => {
		for (const v of host.viewers) {
			if (v.channelIndex === channelIndex && v.slot === slot) {
				invoke(`Zonentitel ${v.name}`, v.zone.titleHandler, host.device, host.mapping, title);
			}
		}
	};

	host.sysex = (bytes) => invoke(`mOnSysex ${bytes[2]}`, host.sysexHandler, host.device, bytes);

	/** Note On auf MIDI-Kanal channel (nullbasiert), wie bindToNote zählt. */
	host.note = (channel, note, velocity) => {
		const sv = host.surfaceValues.find((s) => s.note && s.note.channel === channel && s.note.note === note);
		logHost(`Note Kanal ${channel + 1} Nr. ${note} Vel ${velocity} -> ${sv ? sv.name : "nicht gebunden"}`);
		if (sv) surfaceInput(sv, velocity / 127, "Note");
	};

	/** Ein Parameter ändert sich im Plugin (Hand am Regler) und wird gemeldet. */
	host.setParam = (id, tag, value) => {
		P(id, tag).value = value;
		P(id, tag).textOverride = null;
		notifyChange(id, tag);
	};

	/**
	 * Der Tuner misst einen Durchgang: alle Werte setzen, dann jeden geänderten Parameter
	 * melden (Reihenfolge vom Gerät). spec null = Stille (Oct leer, Note "--", Locked und
	 * In Tune aus, Frequenz 0; Cent bleibt stehen wie am Gerät), sonst
	 * { midi, cent, inTune }. Liefert die Tags, die gemeldet wurden.
	 */
	host.tunerInput = (id, spec) => {
		let pairs;
		if (spec) {
			const oct = Math.floor(spec.midi / 12) - 1;
			const hz = 440 * 2 ** ((spec.midi - 69) / 12) * 2 ** (spec.cent / 1200);
			pairs = [
				[TUNER_TAG.cent, (spec.cent + 50) / 100],
				[TUNER_TAG.oct, (oct + 50) / 100],
				[TUNER_TAG.note, (spec.midi - 2) / 89],
				[TUNER_TAG.locked, 1],
				[TUNER_TAG.frequency, Math.min(1, hz / 4000)],
				[TUNER_TAG.inTune, spec.inTune ? 1 : 0],
			];
		} else {
			pairs = [
				[TUNER_TAG.oct, 0],
				[TUNER_TAG.note, 0],
				[TUNER_TAG.locked, 0],
				[TUNER_TAG.inTune, 0],
				[TUNER_TAG.frequency, 0],
			];
		}
		const changed = [];
		for (const [tag, v] of pairs) {
			const p = P(id, tag);
			if (p.value === v && p.textOverride === null) continue;
			p.value = v;
			p.textOverride = null;
			changed.push(tag);
		}
		for (const tag of changed) notifyChange(id, tag);
		return changed;
	};

	/** Preset im Plugin-Fenster gewählt. */
	host.loadPresetInPlugin = (id, index) => {
		const p = P(id, TAG.program);
		loadPreset(id, index, Math.round(p.value * 127), true);
	};

	host.fail = (name, opts = {}) => host.faults.push({ name, times: opts.times ?? 1, when: opts.when });

	/**
	 * Plugin in einem Slot ersetzen (Plugin neu geladen: neue Objekt-ID). Optionen:
	 *   removeCallback  mOnObjectWillBeRemoved für die alte ID (Vorgabe false)
	 *   objectChange    danach mOnObjectChange an Platz 6 (Vorgabe false)
	 *   title           Titel des neuen Plugins (Vorgabe "TONE3000"); null = Slot leer
	 *   kind            "tuner": Steinbergs Tuner (auch mit anderem Titel); Titel "Tuner" ohne
	 *                   kind ist ebenfalls einer; "plain": immer ein schlichtes Plugin
	 *   moveOldTo       das alte Plugin nicht entfernen, sondern in diesen Slot ziehen
	 */
	host.replacePlugin = (slotNumber, newID, opts = {}) => {
		const slot = host.objects[SLOT_BASE + slotNumber];
		const old = slot.kids[0];
		if (old !== undefined && opts.moveOldTo) {
			host.objects[SLOT_BASE + opts.moveOldTo].kids = [old];
		} else if (old !== undefined) {
			if (opts.removeCallback) {
				for (const a of host.accesses) {
					if (a.mOnObjectWillBeRemoved && contains(a._base, old)) {
						invoke("mOnObjectWillBeRemoved", a.mOnObjectWillBeRemoved, host.device, host.mapping, old);
					}
				}
			}
			host.removed.add(old);
		}
		const title = opts.title === undefined ? "TONE3000" : opts.title;
		if (title === null) {
			slot.kids = [];
		} else {
			if (opts.kind === "tuner" || (title === "Tuner" && opts.kind !== "plain")) makeSteinbergTuner(newID, title);
			else if (/tone3000/i.test(title) && opts.kind !== "plain") makeTone3000(newID, title);
			else obj(newID, "Plugin", title, [param(7, "Gain")]);
			slot.kids = [newID];
		}
		logHost(`Slot ${slotNumber}: Plugin ${old ?? "-"} -> ${title === null ? "leer" : `${newID} "${title}"`}`);
		if (opts.objectChange) host.fireObjectChange(6);
	};

	host.fireObjectChange = (index) => {
		const a = host.accesses[index];
		invoke("mOnObjectChange", a.mOnObjectChange, host.device, host.mapping, a._base);
	};

	host.accessOf = (index) => host.accesses[index];

	return host;
}

//------------------------------------------------------------------------------
// Frames lesen
//------------------------------------------------------------------------------
function hexToText(bytes) {
	const raw = [];
	for (let i = 0; i + 1 < bytes.length; i += 2) raw.push(parseInt(String.fromCharCode(bytes[i], bytes[i + 1]), 16));
	return Buffer.from(raw).toString("utf8");
}

function textToHex(text) {
	return [...Buffer.from(text, "utf8").toString("hex").toUpperCase()].map((c) => c.charCodeAt(0));
}

/** Ein Frame des Scripts in eine Beschreibung; null für Nicht-SysEx. */
function decodeFrame(f) {
	if (f[0] !== 0xf0) return null;
	const type = f[2];
	const body = f.slice(3, f.length - 1);
	switch (type) {
		case 0x20:
			return { type, p: body[0], value: body[1] * 128 + body[2], text: hexToText(body.slice(3)) };
		case 0x21:
			return { type, name: hexToText(body) };
		case 0x22:
			return { type, flags: body[0] };
		case 0x23:
			return { type, slot: body[0], name: hexToText(body.slice(1)) };
		case 0x24:
			return { type, flags: body[0], cent: body[1] - 64, oct: body[2] - 64, note: hexToText(body.slice(3)) };
		case 0x7f:
			return { type, text: hexToText(body) };
		default:
			return { type };
	}
}

/** Debugframes zu Zeilen; Folgeframes ("  ~ ") werden an ihre Zeile gehängt. */
function framesToLines(frames) {
	const lines = [];
	for (const f of frames) {
		if (f[0] !== 0xf0 || f[2] !== 0x7f) continue;
		const text = hexToText(f.slice(3, f.length - 1));
		if (text.startsWith("  ~ ") && lines.length) lines[lines.length - 1] += text.slice(4);
		else lines.push(text);
	}
	return lines;
}

/** Form aller Frames: Datenbytes < 0x80, Länge, Rahmen. */
function frameShape(frames) {
	const res = { maxLen: 0, badByte: 0, badFrame: 0 };
	for (const f of frames) {
		res.maxLen = Math.max(res.maxLen, f.length);
		if (f.some((b, i) => i > 0 && i < f.length - 1 && b > 0x7f)) res.badByte++;
		if (f[0] !== 0xf0 || f[1] !== 0x7d || f[f.length - 1] !== 0xf7) res.badFrame++;
	}
	return res;
}

module.exports = { createHost, decodeFrame, framesToLines, frameShape, hexToText, textToHex, TAG, TUNER_TAG, TUNER_CLASS, PRESETS, LONG_TITLE };
