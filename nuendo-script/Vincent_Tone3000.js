//------------------------------------------------------------------------------
// Nuendo MIDI Remote script — TONE3000 Remote
//
// Zwei Aufgaben auf einem Portpaar:
//
// Betrieb (Protokoll 3 und 4): Das Stream Deck steuert den Eingangskanal
// "Mono In 6" (Input 6) — Gain und EQ von TONE3000 in Insert-Slot 3, dessen
// Presets per Namen, Mute, den Bypass des Delays in Slot 2 und die Fenster von
// Tuner (Slot 1), Delay und TONE3000. Das Script meldet Werte, Presetnamen,
// Zustände und Plugin-Namen zurück, im Tuner-Modus dazu Note und Cent des
// Steinberg-Tuners in Slot 1. Vollständig beschrieben in docs/protokoll.md; das
// Stream-Deck-Plugin wird gegen diese Datei gebaut, Änderungen am Protokoll also
// immer dort mitziehen.
//
// Der Betrieb folgt dem Kanal über seinen NAMEN, nicht über seinen Platz:
// Eingangskanäle gehören zum Projekt, Zahl und Reihenfolge wechseln also (Befund
// 2026-10-06: "Mono In 6" als einziger Eingang auf Platz 0). Alles hängt an einer
// eigenen Zone mit genau einem Platz, dem Deck-Kanal; das Script schiebt sie im
// Leerlauf dorthin, wo "Mono In 6" steht (Abschnitte "Deck-Kanal" und
// "Deck-Suche", docs/protokoll.md 4.7).
//
// Suchlauf (Protokoll 2, unverändert): Das Script listet auf Anfrage, was Nuendo
// über Input 6 preisgibt:
//   - alle Eingangskanäle mit Namen und Mute-Zustand
//   - Kanalparameter, Unterobjekte und Insert-Slots des Zielkanals
//   - für Slot 2 (Delay), Slot 3 (TONE3000) und jeden Slot mit TONE3000 alle
//     Parameter mit Titel, Klartextwert, Wertebereich und Typ
// Daraus wird entschieden, was auf die Drehregler und Tasten kommt — vor allem,
// ob TONE3000 seinen EQ und seine Presets überhaupt an den Host herausgibt.
//
// Dazu ein Beobachtungsmodus: Er meldet jede Parameteränderung an Plugins und
// Slots des Zielkanals, während man in TONE3000 Presets wechselt oder an Reglern
// dreht. So zeigt sich, ob ein Presetwechsel überhaupt beim Host ankommt. Er geht
// nur, wenn der Suchlauf den Deck-Kanal traf (dort hängt der Parameter-Callback).
//
// Und zwei Prüfbefehle für den Presetwechsel (TONE3000 ab 0.0.9): einen
// Parameter eines Insert-Slots über seinen Titel setzen ("Program", "MIDI CC 0|20",
// Bypass am Slot) und Nuendos Tastaturbefehle der Kategorie "Preset" auslösen.
// Was daraufhin passiert, schreibt die laufende Beobachtung mit.
//
// Ausgabe doppelt: in Nuendos Script-Konsole (hört immer zu, lässt sich aber
// nicht kopieren) und als Debugzeilen über MIDI an tools/suchlauf.cjs, das sie
// in eine Datei schreibt.
//
// Eigenes Portpaar, getrennt von der FaderBank: Ein Script belegt sein Paar
// exklusiv, und ein Neustart dieser Strecke soll die FaderBank nicht berühren.
//
// Protokoll:
//   Deck -> Nuendo   F0 7D 01 F7                  Ping, Antwort F0 7D 01 F7
//   Deck -> Nuendo   F0 7D 02 [Kanal hex] F7      Suchlauf, ohne Kanal TARGET_TITLE
//   Deck -> Nuendo   F0 7D 03 F7                  Beobachtung an (Ziel des letzten Laufs,
//                    nur wenn es der Deck-Kanal war)
//   Deck -> Nuendo   F0 7D 04 F7                  Beobachtung aus, mit Zusammenfassung
//   Deck -> Nuendo   F0 7D 05 <Text hex-ascii> F7 Setzen, Text "<ziel>;<titel>;<modus>;<wert>"
//                    ziel  "3" = Plugin in Insert-Slot 3, "3/slot" = der Slot selbst
//                    titel exakter Parametertitel, Leerzeichen und "|" erlaubt, kein ";"
//                    modus "norm" (0..1), "plain" (Plain-Wert, wird umgerechnet),
//                          "text" (Klartext über setParameterDisplayValue)
//                    Endet immer mit der Zeile "--- Setzen fertig ---".
//                    Ziel wird aus dem letzten Suchlauf genommen, IDs frisch aufgelöst.
//   Deck -> Nuendo   F0 7D 06 <Text hex-ascii> F7 Befehl, Text "<schlüssel>;<zustand>"
//                    schlüssel next / prev / browser / browser2 (Kategorie "Preset",
//                          Befehl Next / Previous / Open Browser / Open/Close Browser),
//                          mit "/taste" derselbe Befehl über ein Button-Element
//                    zustand 1 oder 0 — ein Command-Binding braucht beide Flanken
//   Deck -> Nuendo   91 <n> 7F, dann 91 <n> 00      Note auf MIDI-Kanal 2 an der Taste
//                    desselben Befehls (n = 0 next, 1 prev, 2 browser, 3 browser2) —
//                    der Weg, auf dem die FaderBank ihre Befehle auslöst. Kanal 1 ist
//                    tabu: Dort hängen die Mute-Tasten der Eingänge.
//   Nuendo -> Deck   F0 7D 7F <Text hex-ascii> F7 eine Zeile Ausgabe
//
// Protokoll 3, Betrieb fürs Stream Deck (zusätzlich, docs/protokoll.md):
//   Deck -> Nuendo   F0 7D 10 F7                  Abfrage: alles ohne Dedup, in dieser
//                    Reihenfolge 0x20 für p = 0..3, 0x21, 0x22, 0x23 für s = 0..2,
//                    ab Protokoll 4 zuletzt 0x24.
//                    0x20 entfällt für Parameter, die sich nicht lesen lassen (kein
//                    TONE3000, Titel nicht gefunden). Vor der ersten Aktivierung der
//                    Seite wird die Abfrage gemerkt und beantwortet, sobald der
//                    Deck-Kanal das erste Mal positioniert ist (mit der Aktivierung,
//                    wenn er schon richtig steht, sonst am Ende der ersten Suche).
//   Deck -> Nuendo   F0 7D 11 <p> <v1> <v0> F7    TONE3000-Parameter setzen; p 0 Gain
//                    (inputLevel), 1 Bass (toneBass), 2 Mid (toneMid), 3 Treble
//                    (toneTreble); Wert v1*128+v0 = 0..16383, normiert Wert/16383.
//                    Nur mit bit5 und bit6, sonst eine Debugzeile. Zurück kommt nur,
//                    was der Host per Parameter-Callback meldet (0x20). Ob er den
//                    eigenen Wert zurückmeldet, ist am Gerät ungeprüft (JUCE unterdrückt
//                    es); der Dedup für p wird deshalb zurückgesetzt, die nächste
//                    Meldung des Hosts für p geht immer hinaus.
//   Deck -> Nuendo   F0 7D 12 <Name hex-ascii> F7 Preset per Namen wählen (Klartext
//                    von "Program"); danach 0x21 (Dedup), bei Abweichung Debugzeile
//                    "Preset <Name> nicht übernommen, aktiv <x>", stand der Name schon
//                    vorher da, "Preset <Name> laut Host schon aktiv, ..."
//   Deck -> Nuendo   92 <n> <vel>                 Note On MIDI-Kanal 3, Velocity =
//                    Zielzustand (127 an, 0 aus), KEIN Note Off hinterher, alles am
//                    Deck-Kanal: n = 0 Mute, 1 Tuner-Fenster (Slot 1), 2 Delay-Bypass
//                    (Slot 2, 127 = Bypass an), 3 Delay-Fenster, 4 TONE3000-Fenster (Slot 3)
//   Nuendo -> Deck   F0 7D 20 <p> <v1> <v0> <Klartext hex-ascii> F7
//                    Parameterwert 14 Bit und Klartext des Hosts (z. B. "5.00")
//   Nuendo -> Deck   F0 7D 21 <Name hex-ascii> F7 aktives Preset, leer = unbekannt
//                    (ohne aktives Preset zeigt TONE3000 den Namen von Programm 0)
//   Nuendo -> Deck   F0 7D 22 <flags> F7          bit n = Zustand von Note n (n = 0..4),
//                    bit5 Deck-Kanal heißt TARGET_TITLE, bit6 TONE3000 in Slot 3 gefunden
//   Nuendo -> Deck   F0 7D 23 <s> <Name hex-ascii> F7  Plugin-Name in Slot s (0..2)
//   Unverlangt sendet das Script nur, wenn ein Callback des Hosts eine Änderung
//   meldet, immer mit Dedup, und erst nach der Aktivierung — beim Aktivieren an sich
//   nie. Das kann auch direkt nach dem Start sein, wenn Nuendo die Startwerte über
//   die Callbacks liefert; die Antwort auf 0x10 hat kein eigenes Endframe.
//   Text: UTF-8 als Hex-ASCII (herein bis 4 Byte je Zeichen), Klartext in 0x20
//   höchstens 32 Byte, Namen höchstens 100 Byte (an Zeichengrenzen gekürzt); kein
//   Frame wird länger als 205 Byte.
//
// Protokoll 4, Stimmanzeige (zusätzlich, docs/protokoll.md Abschnitt 5): Steinbergs
// "Tuner" in Insert-Slot 1 legt seine Messwerte als Parameter an; das Script reicht
// sie ans Deck weiter, solange dessen Tuner-Modus an ist.
//   Deck -> Nuendo   F0 7D 13 <m> F7              Tuner-Modus, m = 1 an, 0 aus. An: Tuner
//                    in Slot 1 frisch auflösen, seinen Parameter "Mute" auf On (Ausgang
//                    stumm), Werte ab jetzt weiterleiten. Aus: "Mute" auf Off, Weiter-
//                    leitung aus. Beides gefolgt von einem 0x24 ohne Dedup. Gesetzt wird
//                    nur, was abweicht; dasselbe m mehrfach ist harmlos. Ohne Tuner in
//                    Slot 1 wird nichts gesetzt (0x24 mit bit3 = 0). Das Deck schickt
//                    seinen Modus bei jedem Verbindungsaufbau — so hebt ein 0x13 0 eine
//                    liegengebliebene Tuner-Mute auf —, und einmal 0x13 0, wenn ein 0x24
//                    außerhalb des Modus bit4 meldet. Vor der Aktivierung gemerkt und
//                    ausgeführt wie eine Abfrage (vor ihr, wenn beide ausstehen).
//   Nuendo -> Deck   F0 7D 24 <flags> <cent+64> <oct+64> <Note hex-ascii> F7
//                    flags bit0 Ton erkannt (Locked), bit1 gestimmt (In Tune), bit2 Modus
//                    an, bit3 Tuner in Slot 1 gefunden, bit4 Tuner-Mute an. cent -50..50
//                    aus dem Klartext von "Cent" (Rückfall roh*100-50), oct aus dem
//                    Klartext von "Oct" (leer = 0), Note = Klartext von "Note" ohne
//                    umgebende Leerzeichen, höchstens 8 Byte.
//                    Gesendet auf 0x13 (sofort), als letztes Frame jeder Abfrage 0x10
//                    (auch bei Modus aus) und unverlangt NUR im Modus: bei Meldungen der
//                    Tuner-Parameter und wenn sich der Tuner in Slot 1 ändert, mit Dedup.
//
// Protokollfassung: Die erste Zeile jedes Suchlaufs nennt "Protokoll <n>". Das
// Werkzeug verlangt sie, bevor es Setzen oder Befehle schickt — eine ältere,
// noch ausgerollte Fassung verwirft 0x05 und 0x06 sonst still.
//
// Deploy-Name MUSS den beiden Elternordnern entsprechen:
//   ...\Driver Scripts\Local\Vincent\Tone3000\Vincent_Tone3000.js
// Nuendo scannt Scripts nur beim Start — nach dem Ausrollen Nuendo neu starten.
//------------------------------------------------------------------------------

var midiremote_api = require('midiremote_api_v1')

//==============================================================================
// CONFIG
//==============================================================================

// Basic Loopback der Windows MIDI Services, aus Sicht von Nuendo benannt:
// vom Deck herein, zum Deck hinaus.
var PORTS = { from: 'sd_tone3000', to: 'tone3000_sd' }

// Der Zielkanal wird über seinen Namen gesucht, nicht über die Position —
// Eingangskanäle gehören zum Projekt, ihre Zahl und Reihenfolge wechseln. "Input 6"
// heißt in der MixConsole "Mono In 6". Im Projekt vom 2026-10-01 lag er auf Platz 6
// (Platz 0 "Stereo In 1-2", belegt durch die Mute-Gegenprobe), im Projekt vom
// 2026-10-06 ist er der einzige Eingang, also Platz 0. Der Betrieb folgt diesem
// Namen über die Deck-Zone (Deck-Suche); bit5 heißt "Deck-Kanal heißt so".
var TARGET_TITLE = 'Mono In 6'

// Beobachtung: je Parameter die ersten Änderungen einzeln, danach nur noch
// gezählt; dazu eine Obergrenze für die ganze Sitzung.
var WATCH_LINES_PER_PARAM = 6
var WATCH_MAX_LINES = 600

// Plätze der Such-Zone. Steht TARGET_TITLE dahinter (Projekt mit mehr Eingängen),
// findet ihn der Rückfall der Deck-Suche schrittweise; der Suchlauf nennt ihn dann
// nur, wenn der Deck-Kanal schon dort steht.
var NUM_INPUTS = 32

// Deck-Suche im Leerlauf (page.mOnIdle, Abschnitt "Deck-Suche"). Abstand zweier
// Durchgänge, solange es etwas zu tun gibt; ohne Anlass kehrt der Leerlauf sofort
// zurück. Wie die FaderBank (60 ms im Sync, 500 ms sonst), hier dazwischen: Jeder
// Durchgang bewegt höchstens einmal, und zu dicht geraten wartet er nur auf Titel.
var SEEK_PASS_MS = 150
// Runden über die Such-Zone (mResetBank, dann k-mal mShiftRight; der Sprung des
// Rückfalls zählt auch als Runde). Je Runde so viele Durchgänge Warten auf den Titel
// des Ziels, dann die nächste Runde, nach der letzten aufgeben bis zum nächsten Anlass.
var SEEK_MAX_ROUNDS = 3
var SEEK_VERIFY_PASSES = 4
// Neue Anlässe mitten in einer Suche (Eingänge ändern sich weiter) beginnen sie mit
// frischen Runden neu, höchstens so oft — danach aufgeben. Die letzte Sicherung gegen
// eine Suche, die sich über Meldungen des Hosts selbst anstößt.
var SEEK_MAX_RESTARTS = 8
// Rückfall jenseits der Such-Zone: höchstens so viele Einzelschritte. So viele
// Durchgänge ohne Bewegung (der Schub läuft am Ende der Liste ins Leere) gelten als
// Ende der Eingänge.
var SEEK_MAX_STEPS = 256
var SEEK_STEP_WAIT = 2

// Slots, deren Plugin vollständig ausgegeben wird, nullbasiert: Slot 1 trägt den
// Tuner, Slot 2 das Delay, Slot 3 TONE3000. Dazu jeder Slot, dessen Plugin-Titel
// DEEP_MATCH enthält. Slot 1 seit 2026-10-02: Der Steinberg-Tuner legt Note, Cent
// und Frequenz als schreibgeschützte Parameter an — der Suchlauf soll zeigen, ob
// DirectAccess sie listet.
var DEEP_SLOTS = [0, 1, 2]
var DEEP_MATCH = 'tone3000'

// Obergrenze gelisteter Zeilen je Objekt. Durchlaufen werden immer ALLE
// Parameter; JUCE-Plugins legen tausende versteckte "MIDI CC"-Parameter an
// (TONE3000: 2080), die nur gezählt werden. Ab 0.0.9 kann zwischen ihnen ein
// "Program" stehen — deshalb darf die Schleife nicht vorher abbrechen.
var MAX_PARAMS = 400

// Begriffe, die am Ende als Fundliste zusammengefasst werden.
var FIND_WORDS = ['preset', 'program', 'input', 'eq', 'bass', 'low', 'mid', 'high',
    'treble', 'presence', 'gain', 'level', 'bypass', 'gate', 'output']

// Ein Frame trägt höchstens so viele Bytes Text; hex-kodiert sind es doppelt so
// viele. Dieselbe Grenze wie im FaderBank-Script, dort am Loopback erprobt.
var MAX_LINE_BYTES = 100

// 1 = Ping, Suchlauf, Beobachtung; 2 = dazu Setzen (0x05) und Befehl (0x06);
// 3 = dazu der Betrieb fürs Stream Deck (0x10..0x12 herein, 0x20..0x23 hinaus,
// Noten auf MIDI-Kanal 3); 4 = dazu die Stimmanzeige (0x13 herein, 0x24 hinaus).
// tools/suchlauf.cjs prüft diese Zahl in der ersten Zeile des Suchlaufs
// (mindestens 2).
var PROTOCOL_VERSION = 4

var MANUFACTURER_ID = 0x7D // non-commercial / educational SysEx ID
var MSG_PING      = 0x01
var MSG_PROBE     = 0x02
var MSG_WATCH_ON  = 0x03
var MSG_WATCH_OFF = 0x04
var MSG_SET       = 0x05
var MSG_COMMAND   = 0x06
var MSG_DEBUG     = 0x7F

// Protokoll 3, Deck -> Nuendo
var MSG_QUERY        = 0x10
var MSG_PARAM_SET    = 0x11
var MSG_PRESET_SET   = 0x12
// Protokoll 3, Nuendo -> Deck
var MSG_PARAM        = 0x20
var MSG_PRESET       = 0x21
var MSG_FLAGS        = 0x22
var MSG_SLOT_NAME    = 0x23
// Protokoll 4, Deck -> Nuendo
var MSG_TUNER_MODE   = 0x13
// Protokoll 4, Nuendo -> Deck
var MSG_TUNER        = 0x24

// TONE3000-Parameter auf den Reglern des Decks, p = Index. Aufgelöst wird immer
// über den exakten Titel; der Tag ist nur die Erwartung aus dem Suchlauf
// 2026-10-01 (TONE3000 0.0.11) und wird bei Abweichung in der Konsole vermerkt.
var T3K_PARAMS = [
    { title: 'inputLevel', label: 'Gain', tag: 1368699459 },
    { title: 'toneBass', label: 'Bass', tag: 1128262618 },
    { title: 'toneMid', label: 'Mid', tag: 1006241759 },
    { title: 'toneTreble', label: 'Treble', tag: 307695311 }
]
// discrete 0..127, Klartext = Presetname; setParameterDisplayValue mit dem Namen
// wählt das Preset (belegt 2026-10-01).
var T3K_PROGRAM = { title: 'Program', tag: 1886553053 }
// Ein Plugin-Objekt gilt als TONE3000, wenn sein Titel das enthält (ohne Groß/klein).
var T3K_MATCH = 'tone3000'
// Insert-Slots des Decks, nullbasiert, und Kanal/Zeile seiner Tasten.
var SLOT_TUNER = 0
var SLOT_DELAY = 1
var SLOT_T3K = 2
var DECK_SLOTS = 3
// MIDI-Kanal 3. Kanal 1 tragen die Mute-Tasten der Such-Zone, Kanal 2 die
// Preset-Befehle des Suchlaufs.
var DECK_CHANNEL = 2
// Surface-Zeile der Deck-Tasten; 0 und 1 (Mute) und 3 (Preset-Befehle) sind belegt.
var DECK_ROW = 5
// Notennummern auf DECK_CHANNEL; zugleich die Bitnummer im Zustandsbyte (0x22).
var NOTE_MUTE = 0
var NOTE_TUNER_EDIT = 1
var NOTE_DELAY_BYPASS = 2
var NOTE_DELAY_EDIT = 3
var NOTE_T3K_EDIT = 4
var DECK_NOTES = 5
var FLAG_TARGET_OK = 0x20
var FLAG_T3K_FOUND = 0x40
// Reglerwert 14 Bit: 0..VALUE_MAX entspricht normiert 0..1.
var VALUE_MAX = 16383
// Höchstlängen für Text in Frames nach außen (UTF-8-Bytes vor der Hex-Kodierung).
// Mit 100 Byte Namen wird 0x23 genau 205 Byte lang, das längste Frame überhaupt.
var MAX_VALUE_TEXT_BYTES = 32
var MAX_NAME_BYTES = 100
// Fehler in Callbacks gehen in die Konsole, als Debugzeile nur die ersten so viele.
var MAX_ERROR_LINES = 20

// Stimmanzeige (Protokoll 4): Steinbergs "Tuner" aus dem Nuendo Plug-in Set in
// Slot SLOT_TUNER. Er legt seine Messwerte als Parameter an und meldet sie live
// über mOnParameterChange (Suchlauf 2026-10-02_125415; der GTR Tuner von Waves und
// der Tuner in TONE3000 tun das nicht, docs/befunde.md). Erkannt am Objekttitel
// oder, falls der übersetzt sein sollte, am Anfang der Klassenkennung
// (getObjectUniqueName "6B9B08D2…-0").
var TUNER_TITLE = 'Tuner'
var TUNER_CLASS = '6B9B08D2CA294270BF092A62865521BF'
// Seine Parameter, aufgelöst über den exakten Titel; der Tag ist nur die Erwartung
// aus dem Suchlauf. Fehlt ein required-Titel, gilt der Tuner als nicht gefunden.
// Frequency (4202) und Base (4211) braucht das Deck nicht: Ihre Meldungen werden
// übergangen, ohne etwas zu lesen.
var TUNER_PARAMS = [
    { key: 'mute', title: 'Mute', tag: 4201, required: true },
    { key: 'note', title: 'Note', tag: 4203, required: true },
    { key: 'cent', title: 'Cent', tag: 4204, required: true },
    { key: 'oct', title: 'Oct', tag: 4205, required: false },
    { key: 'locked', title: 'Locked', tag: 4209, required: false },
    { key: 'inTune', title: 'In Tune', tag: 4210, required: false }
]
// Flagbyte von 0x24
var TUNER_LOCKED = 0x01
var TUNER_IN_TUNE = 0x02
var TUNER_MODE_ON = 0x04
var TUNER_FOUND = 0x08
var TUNER_MUTED = 0x10
// Cent und Oktave gehen um 64 verschoben hinaus, damit jedes Byte < 0x80 bleibt.
var TUNER_OFFSET = 64
var TUNER_CENT_MAX = 50
var MAX_NOTE_BYTES = 8

// Schlusszeile jedes Setzen-Aufrufs; tools/suchlauf.cjs wartet darauf.
var SET_END = '--- Setzen fertig ---'

// Nuendos Tastaturbefehle für Presets, interne Namen laut Key Commands.xml
// (Nuendo 15). "Open/Close Browser" ist nur der Anzeigename von "Open Browser"
// (Remote-Befehlstabelle) und als interner Name falsch — er ist als Gegenprobe
// dabei.
//
// canPerform(activeMapping) ist in der API nicht beschrieben. Es kann "Name
// unbekannt" heißen, aber ebenso "gerade nicht ausführbar": Next, Previous und
// Open Browser wirken auf das Plugin-Fenster mit Fokus. Ohne offenes
// TONE3000-Fenster kann also auch ein richtiger Name false melden. Aussagekräftig
// ist nur der Vergleich mit browser2 bei offenem, angeklicktem Fenster, und
// maßgeblich ist der Wert in der BEFEHL-Zeile zum Auslösezeitpunkt, nicht der aus
// dem Suchlauf.
var COMMAND_CATEGORY = 'Preset'
var PRESET_COMMANDS = [
    { key: 'next', name: 'Next' },
    { key: 'prev', name: 'Previous' },
    { key: 'browser', name: 'Open Browser' },
    { key: 'browser2', name: 'Open/Close Browser' }
]

// Kanalparameter, die die Beobachtung meldet — alles andere auf Kanalebene sind
// vor allem Pegelanzeigen. 1027 = Mute (Suchlauf 2026-10-01).
var WATCH_CHANNEL_TAGS = [1027]
//==============================================================================

var driver = midiremote_api.makeDeviceDriver('Vincent', 'Tone3000', 'sorg')

var midiInput = driver.mPorts.makeMidiInput('Stream Deck')
var midiOutput = driver.mPorts.makeMidiOutput('Stream Deck')

// Genau EINE Erkennungseinheit (Lehre aus E-28 der FaderBank: jede passende
// Einheit wird zu einer eigenen Controller-Instanz).
driver.makeDetectionUnit().detectPortPair(midiInput, midiOutput)
    .expectInputNameEquals(PORTS.from)
    .expectOutputNameEquals(PORTS.to)

var surface = driver.mSurface
var page = driver.mMapping.makePage('Tone3000')

//------------------------------------------------------------------------------
// Kodierung (die Script-Engine kennt kein TextEncoder)
//------------------------------------------------------------------------------
var HEX_DIGITS = '0123456789ABCDEF'

function utf8Bytes(str) {
    var out = []
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i)
        if (c < 0x80) {
            out.push(c)
        } else if (c < 0x800) {
            out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F))
        } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
            var low = str.charCodeAt(++i)
            var cp = 0x10000 + ((c & 0x3FF) << 10) + (low & 0x3FF)
            out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
        } else {
            out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F))
        }
    }
    return out
}

/** Jedes Byte wird zu zwei ASCII-Hex-Zeichen, damit jedes SysEx-Byte < 0x80 bleibt. */
function hexAscii(bytes) {
    var out = []
    for (var i = 0; i < bytes.length; i++) {
        out.push(HEX_DIGITS.charCodeAt((bytes[i] >> 4) & 0x0F))
        out.push(HEX_DIGITS.charCodeAt(bytes[i] & 0x0F))
    }
    return out
}

/**
 * Hex-ASCII aus einer Nachricht zurück in einen String, UTF-8 bis vier Byte — so
 * weit, wie utf8Bytes hinaus kodiert. Ein Presetname mit Emoji kommt sonst als 0x21
 * hinaus, ließe sich per 0x12 aber nie wählen. Vier Byte werden ein Surrogatpaar.
 */
function decodeHexText(message, start, end) {
    var bytes = []
    for (var i = start; i + 1 < end; i += 2) {
        bytes.push(parseInt(String.fromCharCode(message[i], message[i + 1]), 16))
    }
    var out = ''
    for (var b = 0; b < bytes.length; b++) {
        var c = bytes[b]
        if (c < 0x80) {
            out += String.fromCharCode(c)
        } else if ((c & 0xE0) === 0xC0 && b + 1 < bytes.length) {
            out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[++b] & 0x3F))
        } else if ((c & 0xF0) === 0xE0 && b + 2 < bytes.length) {
            var c2 = bytes[++b]
            var c3 = bytes[++b]
            out += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F))
        } else if (c >= 0xF0 && c <= 0xF4 && b + 3 < bytes.length) {
            var cp = ((c & 0x07) << 18) | ((bytes[++b] & 0x3F) << 12) | ((bytes[++b] & 0x3F) << 6) | (bytes[++b] & 0x3F)
            if (cp >= 0x10000 && cp <= 0x10FFFF) {
                cp -= 0x10000
                out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF))
            }
        }
    }
    return out
}

/**
 * Prüft einen eingehenden Frame mit Text, bevor er dekodiert wird. Wie lange
 * Frames vom Werkzeug hereinkommen, ist nicht erprobt (bisher nie über 4 Byte).
 * Würde einer gekappt, fehlte das F7, und decodeHexText würfe ein echtes
 * Zeichen weg — der Wert käme still verstümmelt an. Liefert den Grund oder ''.
 */
function payloadProblem(message) {
    if (message[message.length - 1] !== 0xF7) return 'Frame ohne F7 am Ende (' + message.length + ' Byte, gekappt?)'
    if ((message.length - 4) % 2 !== 0) return 'Nutzlast mit ungerader Länge (' + (message.length - 4) + ' Byte)'
    for (var i = 3; i < message.length - 1; i++) {
        if (HEX_DIGITS.indexOf(String.fromCharCode(message[i]).toUpperCase()) < 0) {
            return 'Nutzlast ist kein Hex-Text (Byte ' + i + ' = ' + message[i] + ')'
        }
    }
    return ''
}

/** Länge eines Mehrbyte-Zeichens nie zerschneiden: Fortsetzungsbytes zurückspulen. */
function utf8CutPoint(bytes, maxBytes) {
    if (bytes.length <= maxBytes) return bytes.length
    var end = maxBytes
    while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--
    return end
}

//------------------------------------------------------------------------------
// Ausgabe
//------------------------------------------------------------------------------
/**
 * Eine Zeile in die Konsole und als Debugframe(s) hinaus. Lange Zeilen werden
 * auf mehrere Frames verteilt; Folgeframes beginnen mit "  ~ ".
 */
function line(activeDevice, text) {
    console.log(text)
    if (!activeDevice) return
    var bytes = utf8Bytes(text)
    var first = true
    while (first || bytes.length > 0) {
        var chunk = bytes
        if (!first) chunk = utf8Bytes('  ~ ').concat(chunk)
        var cut = utf8CutPoint(chunk, MAX_LINE_BYTES)
        var frame = [0xF0, MANUFACTURER_ID, MSG_DEBUG].concat(hexAscii(chunk.slice(0, cut)))
        frame.push(0xF7)
        midiOutput.sendMidi(activeDevice, frame)
        bytes = chunk.slice(cut)
        first = false
    }
}

/** Kurzform für Werte, die der Host als undefined oder leer liefern kann. */
function show(value) {
    if (value === undefined || value === null) return '?'
    return String(value)
}

/** Zahlen auf vier Nachkommastellen, damit die Zeilen lesbar bleiben. */
function num(value) {
    if (typeof value !== 'number') return show(value)
    return String(Math.round(value * 10000) / 10000)
}

//------------------------------------------------------------------------------
// Eingangskanäle
//------------------------------------------------------------------------------
// Zwei Zonen über dieselbe Liste aller Eingänge. Beide sind reine Typzonen ohne
// setFollowVisibility: Sie listen auch ausgeblendete Eingänge (E-16 der FaderBank)
// und zählen gleich, Platz k ist in beiden derselbe Kanal.
//
//   Such-Zone "Eingaenge"       NUM_INPUTS Plätze, wird nie verschoben. Liefert die
//                               Titel aller Eingänge (daraus der Platz von
//                               TARGET_TITLE), die Mute-Tasten auf MIDI-Kanal 1 und
//                               den Suchlauf (Protokoll 2).
//   Deck-Zone "Tone3000 Ziel"   genau ein Platz, der Deck-Kanal. An ihm hängt der
//                               ganze Betrieb (Protokoll 3 und 4); die Deck-Suche
//                               schiebt ihn im Leerlauf auf TARGET_TITLE.
//
// Bindungen entstehen beim Laden, wenn noch kein Titel bekannt ist. Fest an einen
// Platz gebunden, hing der Betrieb an der Reihenfolge der Eingänge, und die gehört
// zum Projekt: Am 2026-10-06 war "Mono In 6" der einzige Eingang (Platz 0), das
// Script band an Platz 6, bit5 blieb 0. Die Bindungen einer Zone folgen dagegen
// ihrer Position — Mute, Viewer und DirectAccess des Deck-Kanals zeigen also immer
// auf den Kanal, auf den die Deck-Zone gerade geschoben ist.
var inputZone = page.mHostAccess.mMixConsole.makeMixerBankZone('Eingaenge')
    .includeInputChannels()

var inputs = []
var inputTitles = []
var inputMuted = []
var inputAccess = []

/**
 * Je Platz der Such-Zone: Titel, Mute-Zustand und ein DirectAccess-Objekt (für den
 * Suchlauf auf einen anderen als den Deck-Kanal).
 *
 * Das Mute-Binding hält den Kanal mit einer echten Zuordnung lebendig und liefert
 * im Suchlauf eine Gegenprobe — Input 6 von Hand muten, der Lauf muss es zeigen.
 * Die Taste hängt an einer Note, die niemand sendet; sie verändert also nichts.
 * Callback am SurfaceValue, nicht am Binding (Lehre aus dem Meter der FaderBank).
 *
 * Ein geänderter Titel ist ein Anlass für die Deck-Suche: Eingänge wurden
 * eingefügt, entfernt oder umbenannt. Keine Parameter-Callbacks hier — an allen
 * Plätzen liefe jede Pegelbewegung ins Script (beim Meter der FaderBank war genau
 * das der Verdacht, als Nuendo träge wurde). Sie hängen nur am Deck-Kanal.
 */
function bindInput(index) {
    var channel = inputZone.makeMixerBankChannel()
    inputs.push(channel)
    inputTitles.push('')
    inputMuted.push(false)

    channel.mOnTitleChange = function (activeDevice, activeMapping, title) {
        if (inputTitles[index] === title) return
        inputTitles[index] = title
        seekReason = true
    }

    var button = surface.makeButton(index % 16, Math.floor(index / 16), 1, 1)
    button.mSurfaceValue.mMidiBinding
        .setInputPort(midiInput)
        .bindToNote(0, index)
    page.makeValueBinding(button.mSurfaceValue, channel.mValue.mMute)
    button.mSurfaceValue.mOnProcessValueChange = function (activeDevice, value) {
        inputMuted[index] = value > 0
    }

    inputAccess.push(page.mHostAccess.makeDirectAccess(channel))
}
for (var i = 0; i < NUM_INPUTS; i++) bindInput(i)

//------------------------------------------------------------------------------
// Deck-Kanal
//------------------------------------------------------------------------------
// Eine Zone mit genau einem Platz. Ihr Kanal trägt alle Bindungen des Betriebs:
// Mute (Kanal 3 Note 0), die Viewer der Slots 1–3 (weiter unten) und ein eigenes
// DirectAccess-Objekt mit den Callbacks für TONE3000, Tuner und Beobachtung.
var deckZone = page.mHostAccess.mMixConsole.makeMixerBankZone('Tone3000 Ziel')
    .includeInputChannels()
var deckChannel = deckZone.makeMixerBankChannel()
var deckAccess = page.mHostAccess.makeDirectAccess(deckChannel)
// Titel laut mOnTitleChange. bit5 heißt: er ist TARGET_TITLE.
var deckTitle = ''

/**
 * Der Titel entscheidet über bit5. Verlässt der Deck-Kanal TARGET_TITLE (Kanal
 * davor eingefügt oder entfernt, Ziel umbenannt), ist das ein Anlass für die
 * Deck-Suche — nur dieser Übergang. Titel, die die Suche beim Schieben selbst
 * auslöst, führen nie vom Ziel weg (sie schiebt nur, solange es nicht stimmt);
 * so stößt sie sich nicht selbst wieder an.
 *
 * Während der Suche wird nur gemerkt: Ihr Ende meldet den neuen Stand.
 */
deckChannel.mOnTitleChange = function (activeDevice, activeMapping, title) {
    var previous = deckTitle
    if (previous === title) return
    deckTitle = title
    if (previous === TARGET_TITLE) seekReason = true
    if (seekBusy()) return
    guarded(activeDevice, 'Titel Deck-Kanal', function () {
        sendFlagsAndSync(activeDevice)
    })
}

// Beobachtung und Betrieb getrennt abgesichert: Wirft der eine, läuft der andere
// trotzdem, und keine Ausnahme verlässt den Callback.
deckAccess.mOnParameterChange = function (activeDevice, activeMapping, objectID, tag) {
    guarded(activeDevice, 'Beobachtung', function () {
        onWatchedChange(activeDevice, activeMapping, deckAccess, objectID, tag)
    })
    // Mitten in der Deck-Suche zeigt der Deck-Kanal womöglich einen fremden Kanal;
    // ihr Ende liest TONE3000 und Tuner ohnehin frisch.
    if (seekBusy()) return
    guarded(activeDevice, 'TONE3000-Rückmeldung', function () {
        onDeckParameterChange(activeDevice, activeMapping, objectID, tag)
    })
    // Außerhalb des Tuner-Modus kostet der Tuner hier nichts: Der Tuner meldet
    // beim Spielen rund zehnmal je Sekunde (Cent), auch wenn niemand hinsieht.
    if (tunerMode) {
        guarded(activeDevice, 'Tuner', function () {
            onTunerParameterChange(activeDevice, activeMapping, objectID, tag)
        })
    }
}

// Projekt gewechselt, Kanal neu belegt, Deck-Zone verschoben: gemerkte Objekt-IDs
// und Tags gelten nicht mehr. Neu aufgelöst und gemeldet wird, was sich wirklich
// geändert hat — sofort und beim nächsten Bedarf noch einmal (refreshT3k,
// refreshTuner). Die Deck-Suche löst selbst Objektwechsel aus (mResetBank meldet
// sie sogar ohne Bewegung, FaderBank POLL_RESET_BANK); während sie läuft, wird nur
// vergessen, aufgelöst wird an ihrem Ende.
deckAccess.mOnObjectChange = function (activeDevice, activeMapping, objectID) {
    if (seekBusy()) {
        forgetDeckObjects()
        return
    }
    guarded(activeDevice, 'Objektwechsel', function () {
        refreshT3k(activeDevice)
    })
    guarded(activeDevice, 'Tuner-Objektwechsel', function () {
        refreshTuner(activeDevice)
    })
}

// Verschwindet ein Objekt (etwa TONE3000 aus Slot 3), nur vergessen; aufgelöst
// wird beim nächsten Bedarf, gemeldet über den Titel des Slots.
deckAccess.mOnObjectWillBeRemoved = function (activeDevice, activeMapping, objectID) {
    if (t3k && t3k.objectID === objectID) t3k = null
    if (tuner && tuner.objectID === objectID) tuner = null
}

//------------------------------------------------------------------------------
// Preset-Befehle
//------------------------------------------------------------------------------
// makeCommandBinding gehört zum Aufbau der Page, ausgelöst wird zur Laufzeit über
// setProcessValue auf dem gebundenen Surface-Wert: erst 1, dann 0 — mit nur der
// steigenden Flanke feuert ein Command-Binding sichtbar, der Befehl passiert aber
// nicht (FaderBank, docs/entscheidungen.md).
//
// Je Befehl drei Wege:
//   "<schlüssel>"        setProcessValue der CustomValueVariable 'cmd_<schlüssel>'
//   "<schlüssel>/taste"  setProcessValue eines Button-Elements
//   "<schlüssel>/note"   echte Note an genau diesem Button (MIDI-Kanal 2, Note =
//                        Index in PRESET_COMMANDS), vom Werkzeug direkt gesendet —
//                        das Script sieht dafür keinen SysEx
// Belegt ist nur der dritte: So löst die FaderBank ihre Befehle aus (bindAction,
// Note On und danach Velocity 0). Für setProcessValue gibt es keinen Beleg bei
// Command-Bindings, bei einer CustomValueVariable erreichte es den Host in der
// FaderBank sogar nicht (Send an/aus, 2026-09-29), beim Button schon.
//
// Diagnose wie bindAction der FaderBank: Je Auslöser meldet "WERT", dass der
// Surface-Wert sich bewegt hat, und "BINDING", dass das Command-Binding feuert.
// Ob der Befehl dann etwas bewirkt, zeigen die ÄNDERUNG-Zeilen der Beobachtung.
// Beide Zeilen nur bei laufender Beobachtung — so sendet das Script nie
// ungefragt, etwa wenn der Host beim Aktivieren Startwerte meldet.
// Der Binding-Callback ist hier unbedenklich: Die Regel "Callback an den
// SurfaceValue, nicht ans Binding" stammt vom Pegel, der dauernd feuert; ein
// Command-Binding feuert nur bei einem Tastendruck.
var commandTriggers = {}
var commandOrder = []

function addCommandTrigger(key, name, kind, surfaceValue) {
    var binding = page.makeCommandBinding(surfaceValue, COMMAND_CATEGORY, name)
    commandTriggers[key] = {
        name: name,
        kind: kind,
        value: surfaceValue,
        binding: binding
    }
    commandOrder.push(key)

    surfaceValue.mOnProcessValueChange = function (activeDevice, value) {
        if (watch) line(activeDevice, 'WERT ' + key + ' = ' + num(value))
    }
    binding.mOnValueChange = function (activeDevice, activeMapping, value, diff) {
        if (watch) line(activeDevice, 'BINDING ' + key + ' feuert value=' + num(value) + ' diff=' + num(diff))
    }
}

function bindPresetCommand(index) {
    var cmd = PRESET_COMMANDS[index]
    addCommandTrigger(cmd.key, cmd.name, 'Variable', surface.makeCustomValueVariable('cmd_' + cmd.key))

    // Die Note bedient der Weg "/note" des Werkzeugs; ihre WERT- und
    // BINDING-Zeilen tragen den Schlüssel "<schlüssel>/taste". Die Reihenfolge von
    // PRESET_COMMANDS legt die Notennummer fest — das Werkzeug zählt genauso.
    var button = surface.makeButton(index, 3, 1, 1)
    button.mSurfaceValue.mMidiBinding
        .setInputPort(midiInput)
        .bindToNote(1, index)
    addCommandTrigger(cmd.key + '/taste', cmd.name, 'Taste', button.mSurfaceValue)
}
for (var k = 0; k < PRESET_COMMANDS.length; k++) bindPresetCommand(k)

/** canPerform eines Auslösers als Text; Fehler des Hosts landen in der Zeile. */
function canPerformText(trigger, activeMapping) {
    if (!activeMapping) return '? (kein activeMapping)'
    try {
        return show(trigger.binding.canPerform(activeMapping))
    } catch (e) {
        return 'Fehler: ' + e
    }
}

//------------------------------------------------------------------------------
// Suchlauf
//------------------------------------------------------------------------------
/** Erstes Unterobjekt des gesuchten Typs, sonst -1. */
function findChildByType(activeMapping, access, parentID, typeName) {
    var count = access.getNumberOfChildObjects(activeMapping, parentID)
    for (var c = 0; c < count; c++) {
        var childID = access.getChildObjectID(activeMapping, parentID, c)
        if (access.getObjectTypeName(activeMapping, childID) === typeName) return childID
    }
    return -1
}

/**
 * Zielkanal des Suchlaufs, ohne Groß/klein: { access, index, byName, deck }. Heißt
 * der Deck-Kanal so, läuft der Suchlauf über dessen DirectAccess — dort hängt der
 * Parameter-Callback, also auch die Beobachtung, und die Objekt-IDs stammen aus
 * demselben Objekt, das später meldet. index ist der Platz in der Such-Zone, -1
 * jenseits davon. Sonst ein Platz der Such-Zone; ohne Treffer der Deck-Kanal als
 * Rückfall.
 */
function findTarget(title) {
    var wanted = title.toLowerCase()
    var index = -1
    for (var i = 0; i < NUM_INPUTS; i++) {
        if (String(inputTitles[i] || '').toLowerCase() === wanted) {
            index = i
            break
        }
    }
    if (String(deckTitle || '').toLowerCase() === wanted) {
        return { access: deckAccess, index: index, byName: true, deck: true }
    }
    if (index >= 0) return { access: inputAccess[index], index: index, byName: true, deck: false }
    return { access: deckAccess, index: -1, byName: false, deck: true }
}

function describeTarget(target, title) {
    if (!target.byName) return 'Deck-Kanal "' + show(deckTitle) + '" (RÜCKFALL: "' + title + '" nicht gefunden)'
    if (target.index < 0) return 'Deck-Kanal "' + show(deckTitle) + '" (per Name, nicht unter den ' + NUM_INPUTS + ' Plätzen)'
    return 'Platz ' + target.index + ' "' + show(inputTitles[target.index]) + '" (per Name' + (target.deck ? ', Deck-Kanal)' : ')')
}

// Was der letzte Suchlauf gefunden hat: DirectAccess-Objekt, Platz, ob es der
// Deck-Kanal war, Kanal-ID und die Objekte, deren Änderungen die Beobachtung meldet
// (Inserts, Slots, Plugins samt Unterobjekten).
var lastProbe = null

function watchObject(objectID, label) {
    if (lastProbe) lastProbe.objects[objectID] = label
}

/** Kurzliste: Tag, Titel und Klartextwert, mehrere je Zeile. */
function dumpParamsShort(activeDevice, activeMapping, access, objectID, label) {
    var count = access.getNumberOfParameters(activeMapping, objectID)
    line(activeDevice, '== ' + label + ' id=' + objectID + ' params=' + count)
    var buffer = ''
    for (var p = 0; p < count && p < MAX_PARAMS; p++) {
        var tag = access.getParameterTagByIndex(activeMapping, objectID, p)
        var title = access.getParameterTitle(activeMapping, objectID, tag, 40)
        var shown = access.getParameterDisplayValue(activeMapping, objectID, tag)
        var item = tag + ':' + title + '=' + show(shown)
        if (buffer.length + item.length > 90) {
            line(activeDevice, '   ' + buffer)
            buffer = ''
        }
        buffer += (buffer === '' ? '' : ' | ') + item
    }
    if (buffer !== '') line(activeDevice, '   ' + buffer)
}

var findings = []

function noteFinding(label, tag, title, shown) {
    var lower = String(title || '').toLowerCase()
    for (var w = 0; w < FIND_WORDS.length; w++) {
        if (lower.indexOf(FIND_WORDS[w]) >= 0) {
            findings.push(label + ' tag=' + tag + ' "' + title + '" = ' + show(shown))
            return
        }
    }
}

/**
 * Vollständige Ausgabe eines Plugin-Objekts: je Parameter eine Zeile mit
 * Klartextwert, Einheit, Rohwert, Vorgabe, Wertebereich und Typ. Der Bereich
 * (plain bei 0 und 1) zeigt etwa die dB-Spanne eines EQ-Bands oder die Zahl der
 * Einträge einer Programmliste.
 *
 * Läuft über ALLE Parameter. "MIDI CC"-Parameter werden nur gezählt (mit erstem
 * und letztem Index), alle anderen gelistet, höchstens MAX_PARAMS Zeilen; der
 * Rest wird gezählt. Steht ein anderer Parameter mitten im MIDI-CC-Block (so
 * erwartet für "Program" ab TONE3000 0.0.9), wird er am Ende eigens genannt.
 */
function dumpParamsFull(activeDevice, activeMapping, access, objectID, label) {
    var count = access.getNumberOfParameters(activeMapping, objectID)
    line(activeDevice, '== ' + label + ' id=' + objectID + ' params=' + count)
    var midiCC = 0
    var firstCC = -1
    var lastCC = -1
    var listed = 0
    var unlisted = 0
    var afterFirstCC = []
    var failed = 0
    for (var p = 0; p < count; p++) {
        // Je Parameter abgesichert: Wirft eine Abfrage (etwa auf dem neuen
        // "Program" mit kIsProgramChange), kostet das eine Zeile, nicht den Lauf.
        var tag = '?'
        var title = '?'
        try {
            tag = access.getParameterTagByIndex(activeMapping, objectID, p)
            title = access.getParameterTitle(activeMapping, objectID, tag, 40)
            if (String(title).indexOf('MIDI CC') === 0) {
                midiCC++
                if (firstCC < 0) firstCC = p
                lastCC = p
                continue
            }
            if (firstCC >= 0) afterFirstCC.push({ index: p, tag: tag, title: title })
            if (listed >= MAX_PARAMS) {
                unlisted++
                continue
            }
            listed++
            var shown = access.getParameterDisplayValue(activeMapping, objectID, tag)
            var units = access.getParameterDisplayUnits(activeMapping, objectID, tag)
            var raw = access.getParameterProcessValue(activeMapping, objectID, tag)
            var def = access.getParameterDefaultProcessValue(activeMapping, objectID, tag)
            var type = access.getParameterProcessValueType(activeMapping, objectID, tag)
            var auto = access.isParameterAutomatable(activeMapping, objectID, tag)
            var lo = access.convertParameterProcessValueToPlain(activeMapping, objectID, tag, 0)
            var hi = access.convertParameterProcessValueToPlain(activeMapping, objectID, tag, 1)
            line(activeDevice, '   ' + p + ' tag=' + tag + ' "' + title + '" = "' + show(shown) + '" ' + show(units) +
                ' | roh ' + num(raw) + ' vorg ' + num(def) + ' | plain ' + num(lo) + '..' + num(hi) +
                ' | ' + show(type) + (auto ? ' auto' : ''))
            noteFinding(label, tag, title, shown)
        } catch (e) {
            failed++
            if (failed <= 20) line(activeDevice, '   ' + p + ' tag=' + tag + ' "' + title + '" Fehler: ' + e)
        }
    }
    if (failed > 20) {
        line(activeDevice, '   ... ' + (failed - 20) + ' weitere Parameter mit Fehler')
    }
    if (unlisted > 0) {
        line(activeDevice, '   ... ' + unlisted + ' weitere nicht gelistet (Obergrenze ' + MAX_PARAMS + ' Zeilen)')
    }
    if (midiCC > 0) {
        line(activeDevice, '   (' + midiCC + ' "MIDI CC"-Parameter übersprungen, Index ' + firstCC + '..' + lastCC + ')')
    }
    for (var a = 0; a < afterFirstCC.length && a < 32; a++) {
        var inside = afterFirstCC[a]
        if (inside.index > lastCC) break
        line(activeDevice, '   innerhalb des MIDI-CC-Blocks: Index ' + inside.index + ' tag=' + inside.tag +
            ' "' + inside.title + '"')
    }
}

/** Plugin samt Unterobjekten (zwei Ebenen) vollständig ausgeben. */
function dumpPluginTree(activeDevice, activeMapping, access, objectID, label, depth) {
    dumpParamsFull(activeDevice, activeMapping, access, objectID, label)
    if (depth <= 0) return
    var children = access.getNumberOfChildObjects(activeMapping, objectID)
    for (var c = 0; c < children && c < 16; c++) {
        var childID = access.getChildObjectID(activeMapping, objectID, c)
        var childLabel = label + '/' + access.getObjectTypeName(activeMapping, childID) + '#' + c +
            ' "' + access.getObjectTitle(activeMapping, childID) + '"'
        watchObject(childID, childLabel)
        dumpPluginTree(activeDevice, activeMapping, access, childID, childLabel, depth - 1)
    }
}

function isDeepSlot(slot, pluginTitle) {
    for (var d = 0; d < DEEP_SLOTS.length; d++) {
        if (DEEP_SLOTS[d] === slot) return true
    }
    return String(pluginTitle || '').toLowerCase().indexOf(DEEP_MATCH) >= 0
}

function dumpInserts(activeDevice, activeMapping, access, baseID) {
    var insertsID = findChildByType(activeMapping, access, baseID, 'Inserts')
    if (insertsID < 0) {
        line(activeDevice, '--- kein Unterobjekt "Inserts" gefunden ---')
        return
    }
    var slots = access.getNumberOfChildObjects(activeMapping, insertsID)
    watchObject(insertsID, 'Inserts')
    line(activeDevice, '--- Inserts id=' + insertsID + ', ' + slots + ' Slots ---')
    dumpParamsShort(activeDevice, activeMapping, access, insertsID, 'Inserts')

    for (var s = 0; s < slots; s++) {
        var slotID = access.getChildObjectID(activeMapping, insertsID, s)
        var kids = access.getNumberOfChildObjects(activeMapping, slotID)
        var pluginID = kids > 0 ? access.getChildObjectID(activeMapping, slotID, 0) : -1
        var pluginTitle = pluginID >= 0 ? access.getObjectTitle(activeMapping, pluginID) : ''
        var slotLabel = 'Slot ' + (s + 1)
        watchObject(slotID, slotLabel)
        if (pluginID >= 0) watchObject(pluginID, slotLabel + ' "' + pluginTitle + '"')

        line(activeDevice, '-- ' + slotLabel + ' id=' + slotID + ' typ=' + access.getObjectTypeName(activeMapping, slotID) +
            ' titel="' + access.getObjectTitle(activeMapping, slotID) + '" kinder=' + kids +
            (pluginID >= 0 ? ' plugin="' + pluginTitle + '"' : ' (leer)'))
        if (pluginID >= 0) {
            line(activeDevice, '   klasse="' + access.getObjectUniqueName(activeMapping, pluginID) +
                '" uid="' + access.getObjectUniqueIDString(activeMapping, pluginID) +
                '" typ=' + access.getObjectTypeName(activeMapping, pluginID))
        }

        // Die Parameter des Slots selbst — dort werden Bypass und Ein/Aus vermutet.
        dumpParamsShort(activeDevice, activeMapping, access, slotID, slotLabel)

        if (pluginID >= 0 && isDeepSlot(s, pluginTitle)) {
            dumpPluginTree(activeDevice, activeMapping, access, pluginID, slotLabel + ' "' + pluginTitle + '"', 2)
        }
    }
}

function runProbe(activeDevice, activeMapping, title) {
    findings = []
    line(activeDevice, '--- Suchlauf TONE3000 Remote, Protokoll ' + PROTOCOL_VERSION + ', Ziel "' + title + '" ---')

    // Jeder Lauf des Werkzeugs beginnt mit einem Suchlauf. Läuft hier noch eine
    // Beobachtung, stammt sie aus einem abgebrochenen Lauf und schreibt in einen
    // Port, den niemand mehr liest — also beenden.
    if (watch) {
        line(activeDevice, '(Beobachtung aus einem früheren Lauf beendet: ' + watch.order.length + ' Parameter, ' +
            watch.lines + ' Zeilen)')
        watch = null
    }

    var used = 0
    for (var i = 0; i < NUM_INPUTS; i++) {
        if (!inputTitles[i]) continue
        used++
        line(activeDevice, 'Eingang ' + i + ': "' + inputTitles[i] + '" mute=' + (inputMuted[i] ? 1 : 0))
    }
    line(activeDevice, used + ' von ' + NUM_INPUTS + ' Plätzen belegt')
    line(activeDevice, 'Deck-Kanal: "' + deckTitle + '" (bit5=' + (targetOk() ? 1 : 0) + '), Deck-Suche: ' +
        seekStatus + ', ' + seekActions + ' Zonen-Aktionen seit dem Laden')

    var target = findTarget(title)
    line(activeDevice, 'Ziel: ' + describeTarget(target, title))

    var access = target.access
    var baseID = access.getBaseObjectID(activeMapping)
    lastProbe = { access: access, index: target.index, deck: target.deck, baseID: baseID, objects: {} }
    line(activeDevice, 'DA Basis id=' + baseID + ' typ=' + access.getObjectTypeName(activeMapping, baseID) +
        ' titel="' + access.getObjectTitle(activeMapping, baseID) +
        '" mixerIndex=' + access.getMixerChannelIndex(activeMapping, baseID) +
        ' zone=' + access.getMixerChannelZone(activeMapping, baseID) +
        ' sichtbar=' + access.isMixerChannelVisible(activeMapping, baseID))

    dumpParamsShort(activeDevice, activeMapping, access, baseID, 'Kanal')

    var children = access.getNumberOfChildObjects(activeMapping, baseID)
    line(activeDevice, '--- Unterobjekte des Kanals: ' + children + ' ---')
    for (var c = 0; c < children && c < 32; c++) {
        var childID = access.getChildObjectID(activeMapping, baseID, c)
        line(activeDevice, '   ' + c + ' typ=' + access.getObjectTypeName(activeMapping, childID) +
            ' titel="' + access.getObjectTitle(activeMapping, childID) +
            '" name="' + access.getObjectUniqueName(activeMapping, childID) +
            '" params=' + access.getNumberOfParameters(activeMapping, childID) +
            ' kinder=' + access.getNumberOfChildObjects(activeMapping, childID))
    }

    dumpInserts(activeDevice, activeMapping, access, baseID)

    // Ein falscher Befehlsname schlägt bei makeCommandBinding still fehl. canPerform
    // false heißt aber "falscher Name ODER gerade nicht ausführbar" (siehe
    // PRESET_COMMANDS); erst der Vergleich mit browser2 bei offenem TONE3000-Fenster
    // sagt etwas über die Namen.
    line(activeDevice, '--- Befehle ---')
    for (var k = 0; k < commandOrder.length; k++) {
        var trigger = commandTriggers[commandOrder[k]]
        line(activeDevice, 'Befehl ' + COMMAND_CATEGORY + '/' + trigger.name +
            (trigger.kind === 'Taste' ? ' (Taste)' : '') +
            ' canPerform=' + canPerformText(trigger, activeMapping))
    }

    line(activeDevice, '--- Fundliste (' + findings.length + ') ---')
    for (var f = 0; f < findings.length; f++) line(activeDevice, '   ' + findings[f])

    line(activeDevice, '--- Suchlauf beendet ---')
}

//------------------------------------------------------------------------------
// Beobachtung
//------------------------------------------------------------------------------
// Meldet Änderungen an den Objekten, die der letzte Suchlauf gesammelt hat, und
// auf Kanalebene nur WATCH_CHANNEL_TAGS. Je Parameter zählt eine Änderung nur,
// wenn sich Klartext oder Rohwert bewegt — leere Klartexte (die Slot-Schalter
// zeigten im ersten Lauf keinen) würden sonst alles verschlucken.
//
// WATCH_LINES_PER_PARAM gilt je Runde: Jedes Setzen und jeder Befehl beginnt eine
// neue (nextWatchRound). Sonst wären nach sechs Presetwechseln die Folgen jedes
// weiteren Wechsels nur noch gezählt, nicht mehr zu sehen.
var watch = null

function nextWatchRound() {
    if (watch) watch.round++
}

function onWatchedChange(activeDevice, activeMapping, access, objectID, tag) {
    if (!watch || !lastProbe) return

    var label
    if (objectID === lastProbe.baseID) {
        if (WATCH_CHANNEL_TAGS.indexOf(tag) < 0) return
        label = 'Kanal'
    } else {
        label = lastProbe.objects[objectID]
        if (label === undefined) return
    }

    var shown = access.getParameterDisplayValue(activeMapping, objectID, tag)
    var raw = access.getParameterProcessValue(activeMapping, objectID, tag)
    var stamp = show(shown) + '|' + num(raw)

    var key = objectID + ':' + tag
    var entry = watch.params[key]
    if (!entry) {
        entry = {
            label: label,
            tag: tag,
            title: access.getParameterTitle(activeMapping, objectID, tag, 40),
            count: 0,
            round: watch.round,
            roundCount: 0,
            stamp: null,
            shown: ''
        }
        watch.params[key] = entry
        watch.order.push(key)
    }
    if (entry.stamp === stamp) return
    entry.stamp = stamp
    entry.shown = show(shown)
    entry.count++
    if (entry.round !== watch.round) {
        entry.round = watch.round
        entry.roundCount = 0
    }
    entry.roundCount++

    if (entry.roundCount > WATCH_LINES_PER_PARAM) return
    if (watch.lines >= WATCH_MAX_LINES) {
        if (!watch.capped) line(activeDevice, '(Obergrenze erreicht, ab jetzt nur noch gezählt)')
        watch.capped = true
        return
    }
    watch.lines++
    line(activeDevice, 'ÄNDERUNG ' + label + ' tag=' + tag + ' "' + entry.title + '" = "' + entry.shown + '" roh ' + num(raw))
}

/**
 * Die Beobachtung hängt am Parameter-Callback des Deck-Kanals; sie geht also nur,
 * wenn der Suchlauf den Deck-Kanal traf, und nur, solange die Deck-Zone seitdem
 * nicht weitergezogen ist (sonst meldet der Callback einen anderen Kanal).
 */
function startWatch(activeDevice) {
    if (!lastProbe) {
        line(activeDevice, 'Beobachtung nicht möglich: erst einen Suchlauf ausführen')
        return
    }
    if (!lastProbe.deck) {
        line(activeDevice, 'Beobachtung nur auf dem Deck-Kanal ("' + deckTitle + '") möglich, der Suchlauf traf Platz ' + lastProbe.index)
        return
    }
    var nowID = -1
    try {
        nowID = deckAccess.getBaseObjectID(currentMapping)
    } catch (e) {
        console.log('Beobachtung: Deck-Kanal nicht lesbar (' + e + ')')
    }
    if (nowID !== lastProbe.baseID) {
        line(activeDevice, 'Beobachtung nicht möglich: Der Deck-Kanal zeigt seit dem Suchlauf einen anderen Kanal (id=' +
            nowID + ' statt ' + lastProbe.baseID + '), erst neu suchen')
        return
    }
    watch = { params: {}, order: [], lines: 0, capped: false, round: 0 }
    line(activeDevice, '--- Beobachtung läuft ---')
}

function stopWatch(activeDevice) {
    var finished = watch
    watch = null
    if (finished) {
        line(activeDevice, '--- Zusammenfassung: ' + finished.order.length + ' Parameter geändert ---')
        for (var k = 0; k < finished.order.length; k++) {
            var e = finished.params[finished.order[k]]
            line(activeDevice, '   ' + e.label + ' tag=' + e.tag + ' "' + e.title + '" ' + e.count + 'x, zuletzt "' + e.shown + '"')
        }
    }
    line(activeDevice, '--- Beobachtung beendet ---')
}

//------------------------------------------------------------------------------
// Setzen
//------------------------------------------------------------------------------
// Ein Parameter eines Insert-Slots wird über seinen exakten Titel gesetzt. Ziel,
// Objekte und Tag werden bei jedem Aufruf frisch aufgelöst: Lädt Nuendo ein Plugin
// neu, bekommt es neue Objekt-IDs, und gemerkte IDs zielten ins Leere.

/** Zahl aus Text; Dezimalkomma wird akzeptiert. Sonst NaN. */
function parseNumber(text) {
    var t = String(text).replace(/^\s+|\s+$/g, '').replace(',', '.')
    if (t === '') return NaN
    var n = Number(t)
    return isFinite(n) ? n : NaN
}

/**
 * "3" -> Plugin in Insert-Slot 3, "3/slot" -> das Slot-Objekt selbst. Liefert
 * { access, objectID, slotID, slotLabel, label } oder { error }.
 */
function resolveSetTarget(activeMapping, target) {
    var m = /^\s*(\d+)\s*(\/\s*slot)?\s*$/i.exec(target)
    if (!m) return { error: 'Ziel "' + target + '" unverständlich (erwartet z. B. "3" oder "3/slot")' }
    var n = parseInt(m[1], 10)
    var wantSlot = !!m[2]
    if (!lastProbe) return { error: 'erst einen Suchlauf ausführen (Zielkanal unbekannt)' }

    var access = lastProbe.access
    var baseID = access.getBaseObjectID(activeMapping)
    var insertsID = findChildByType(activeMapping, access, baseID, 'Inserts')
    if (insertsID < 0) return { error: 'kein Unterobjekt "Inserts" am Kanal id=' + baseID }

    var slots = access.getNumberOfChildObjects(activeMapping, insertsID)
    if (n < 1 || n > slots) return { error: 'Slot ' + n + ' nicht vorhanden (' + slots + ' Slots)' }
    var slotID = access.getChildObjectID(activeMapping, insertsID, n - 1)
    var slotLabel = 'Slot ' + n
    if (wantSlot) return { access: access, objectID: slotID, slotID: slotID, slotLabel: slotLabel, label: slotLabel }

    if (access.getNumberOfChildObjects(activeMapping, slotID) < 1) return { error: slotLabel + ' ist leer' }
    var pluginID = access.getChildObjectID(activeMapping, slotID, 0)
    return {
        access: access,
        objectID: pluginID,
        slotID: slotID,
        slotLabel: slotLabel,
        label: slotLabel + ' "' + access.getObjectTitle(activeMapping, pluginID) + '"'
    }
}

/** Parameter über den exakten Titel, über alle Parameter des Objekts. */
function findParamByTitle(activeMapping, access, objectID, title) {
    var count = access.getNumberOfParameters(activeMapping, objectID)
    for (var p = 0; p < count; p++) {
        var tag = access.getParameterTagByIndex(activeMapping, objectID, p)
        if (String(access.getParameterTitle(activeMapping, objectID, tag, 80)) === title) {
            return { found: true, tag: tag, index: p, count: count }
        }
    }
    return { found: false, count: count }
}

/**
 * Nutzlast "<ziel>;<titel>;<modus>;<wert>". Der Wert ist alles nach dem dritten
 * ";", ein Klartext darf also selbst ";" enthalten. Die Schlusszeile SET_END
 * schreibt der Aufrufer, auch nach einer Ausnahme.
 */
function runSet(activeDevice, activeMapping, payload) {
    var parts = payload.split(';')
    if (parts.length < 4) {
        line(activeDevice, 'SETZEN abgelehnt: erwartet "<ziel>;<titel>;<modus>;<wert>", bekommen "' + payload + '"')
        return
    }
    var target = parts[0].replace(/^\s+|\s+$/g, '')
    var title = parts[1]
    var mode = parts[2].replace(/^\s+|\s+$/g, '').toLowerCase()
    var valueText = parts.slice(3).join(';')

    if (mode !== 'norm' && mode !== 'plain' && mode !== 'text') {
        line(activeDevice, 'SETZEN ' + target + ' abgelehnt: Modus "' + mode + '" unbekannt (norm, plain, text)')
        return
    }
    var value = NaN
    if (mode !== 'text') {
        value = parseNumber(valueText)
        if (isNaN(value)) {
            line(activeDevice, 'SETZEN ' + target + ' abgelehnt: Wert "' + valueText + '" ist keine Zahl')
            return
        }
    }
    if (!activeMapping) {
        line(activeDevice, 'SETZEN ' + target + ' abgelehnt: noch kein activeMapping (Seite nie aktiviert)')
        return
    }

    var resolved = resolveSetTarget(activeMapping, target)
    if (resolved.error) {
        line(activeDevice, 'SETZEN ' + target + ' abgelehnt: ' + resolved.error)
        return
    }
    var access = resolved.access
    var objectID = resolved.objectID

    var param = findParamByTitle(activeMapping, access, objectID, title)
    if (!param.found) {
        line(activeDevice, 'SETZEN ' + target + ' abgelehnt: Titel "' + title + '" nicht gefunden in ' +
            resolved.label + ' id=' + objectID + ' (' + param.count + ' Parameter durchsucht)')
        return
    }
    var tag = param.tag

    var normalized = NaN
    if (mode === 'norm') normalized = value
    if (mode === 'plain') normalized = access.convertParameterPlainToProcessValue(activeMapping, objectID, tag, value)
    if (mode !== 'text' && !(normalized >= 0 && normalized <= 1)) {
        line(activeDevice, 'SETZEN ' + target + ' abgelehnt: "' + title + '" ' + mode + ' ' + valueText +
            ' ergibt normiert ' + num(normalized) + ', außerhalb 0..1')
        return
    }

    // Die Beobachtung meldet nur Objekte aus dem letzten Suchlauf. Wurde das
    // Plugin seither neu geladen, kommen die neuen IDs hier dazu.
    var fresh = lastProbe.objects[objectID] === undefined
    if (lastProbe.objects[resolved.slotID] === undefined) watchObject(resolved.slotID, resolved.slotLabel)
    if (lastProbe.objects[objectID] === undefined) watchObject(objectID, resolved.label)
    if (fresh) line(activeDevice, '   (id=' + objectID + ' war seit dem Suchlauf neu, jetzt in der Beobachtung)')

    nextWatchRound()
    var auto = access.isParameterAutomatable(activeMapping, objectID, tag)
    var lock = access.getParameterEditLockState(activeMapping, objectID, tag)
    var shownBefore = access.getParameterDisplayValue(activeMapping, objectID, tag)
    var rawBefore = access.getParameterProcessValue(activeMapping, objectID, tag)
    line(activeDevice, 'SETZEN ' + target + ' id=' + objectID + ' tag=' + tag + ' "' + title + '" auto=' + (auto ? 1 : 0) +
        ' lock=' + (lock ? 1 : 0) + ' vorher "' + show(shownBefore) + '" roh ' + num(rawBefore) +
        ' -> ' + mode + ' ' + (mode === 'text' ? '"' + valueText + '"' : num(value) + ' (normiert ' + num(normalized) + ')'))

    if (mode === 'text') {
        access.setParameterDisplayValue(activeMapping, objectID, tag, valueText)
    } else {
        access.setParameterProcessValue(activeMapping, objectID, tag, normalized)
    }

    // Sofort gelesen; übernimmt der Host den Wert erst später, zeigt das die
    // Beobachtung als ÄNDERUNG-Zeile.
    var shownAfter = access.getParameterDisplayValue(activeMapping, objectID, tag)
    var rawAfter = access.getParameterProcessValue(activeMapping, objectID, tag)
    line(activeDevice, 'NACHHER "' + show(shownAfter) + '" roh ' + num(rawAfter))
}

//------------------------------------------------------------------------------
// Befehl
//------------------------------------------------------------------------------
/** Nutzlast "<schlüssel>;<zustand>", Zustand 1 oder 0. */
function runCommand(activeDevice, activeMapping, payload) {
    var parts = payload.split(';')
    var key = parts[0].replace(/^\s+|\s+$/g, '').toLowerCase()
    var stateText = parts.length > 1 ? parts[1] : ''
    if (!Object.prototype.hasOwnProperty.call(commandTriggers, key)) {
        line(activeDevice, 'BEFEHL abgelehnt: Schlüssel "' + key + '" unbekannt (next, prev, browser, browser2, je auch mit /taste)')
        return
    }
    var state = parseNumber(stateText)
    if (state !== 0 && state !== 1) {
        line(activeDevice, 'BEFEHL ' + key + ' abgelehnt: Zustand "' + stateText + '" (erwartet 1 oder 0)')
        return
    }
    var trigger = commandTriggers[key]
    if (state === 1) nextWatchRound()
    line(activeDevice, 'BEFEHL ' + key + ' ' + state + ' (' + COMMAND_CATEGORY + '/' + trigger.name +
        ', canPerform=' + canPerformText(trigger, activeMapping) + ')')
    trigger.value.setProcessValue(activeDevice, state)
}

//------------------------------------------------------------------------------
// Betrieb fürs Stream Deck (Protokoll 3)
//------------------------------------------------------------------------------
// Alles hängt am Deck-Kanal (Abschnitt "Deck-Kanal"), den die Deck-Suche auf
// TARGET_TITLE schiebt. Ob er dort steht, sagt sein Titel — gemeldet als bit5;
// Regler und Presets wirken nur, wenn er stimmt. Mute und die Slot-Tasten hängen
// an Value-Bindings und wirken immer, auf den Kanal, auf dem die Deck-Zone gerade
// steht; ihr Zustand steht in bit0..bit4.
//
// Unverlangt gesendet wird nur, was ein Callback des Hosts als Änderung meldet,
// und nur nach der Aktivierung (deckLive): Vorher fehlt das activeMapping, ohne
// das bit6 nicht zu bestimmen ist. Bis dahin werden Zustände nur gemerkt; das Deck
// holt sie mit der Abfrage 0x10. Dazu das Ende einer Deck-Suche, die den Kanal
// verschoben hat: Es meldet den neuen Stand (reportDeck), während der Suche selbst
// merken die Callbacks des Deck-Kanals nur.
//
// Der Dedup-Stand (last...Sent) soll genau spiegeln, was das Deck hat: Was nicht
// gesendet werden kann (kein TONE3000, Lesefehler), setzt ihn zurück, ebenso ein
// 0x11 für seinen Regler — danach geht die nächste Meldung des Hosts immer hinaus.

var lastParamSent = [null, null, null, null] // "<14 Bit>|<Klartext>" je Regler, null = Deck hat keinen Hostwert
var lastPresetSent = null
var lastFlagsSent = null
var lastSlotSent = [null, null, null]
var lastRejection = '' // gegen eine Flut gleicher Debugzeilen beim Drehen
var slotNames = ['', '', '']
var deckOn = [false, false, false, false, false] // Zustand je Note = Bit im Zustandsbyte
var queryPending = false
var activating = false
var callbackErrors = 0

/**
 * Callbacks laufen hierüber: Eine Ausnahme des Hosts darf keinen Callback
 * verlassen. Sie landet in der Konsole und, begrenzt, als Debugzeile.
 */
function guarded(activeDevice, where, fn) {
    try {
        fn()
    } catch (e) {
        callbackErrors++
        console.log(where + ' Fehler: ' + e)
        if (callbackErrors > MAX_ERROR_LINES) return
        try {
            line(activeDevice, where + ' Fehler: ' + e)
        } catch (ignored) {
            // Senden gescheitert: die Konsole hat es schon
        }
    }
}

/** Unverlangt senden erst nach der Aktivierung, und nicht mitten in ihr. */
function deckLive() {
    return !!currentMapping && !activating
}

/** Höchstens maxBytes UTF-8, an einer Zeichengrenze gekürzt. */
function textBytes(text, maxBytes) {
    var bytes = utf8Bytes(text)
    return bytes.slice(0, utf8CutPoint(bytes, maxBytes))
}

/** Klartext des Hosts als String; undefined und null werden leer. */
function hostText(value) {
    if (value === undefined || value === null) return ''
    return String(value)
}

function sendFrame(activeDevice, type, data) {
    var frame = [0xF0, MANUFACTURER_ID, type].concat(data)
    frame.push(0xF7)
    midiOutput.sendMidi(activeDevice, frame)
}

/** Normierter Wert 0..1 auf 14 Bit; -1, wenn der Host keine Zahl liefert. */
function toValue14(normalized) {
    if (typeof normalized !== 'number' || !isFinite(normalized)) return -1
    if (normalized < 0) normalized = 0
    if (normalized > 1) normalized = 1
    return Math.round(normalized * VALUE_MAX)
}

/** bit5: Der Deck-Kanal heißt so, wie Input 6 in der MixConsole heißt. */
function targetOk() {
    return deckTitle === TARGET_TITLE
}

//--- TONE3000 auflösen ---------------------------------------------------------
// Gemerktes TONE3000: null = nicht (oder nicht mehr) aufgelöst, sonst
// { found, objectID, tags[p], program, foreign }. tags[p] und program sind null,
// wenn der Titel fehlt. foreign merkt fremde Objekt-IDs aus dem Parameter-
// Callback, damit jede höchstens einmal nachgesehen wird.
//
// Objekt-IDs ändern sich, wenn Nuendo das Plugin neu lädt oder das Projekt
// wechselt. Deshalb lazy: aufgelöst wird beim ersten Bedarf (Abfrage, Setzen,
// Preset, Zustandsbyte, erster Parameter-Callback), verworfen bei mOnObjectChange,
// bei einem neuen Plugin in Slot 3, wenn ein Zugriff scheitert oder das gemerkte
// Objekt nicht mehr TONE3000 heißt.
//
// mOnObjectChange und der Slot-Titel kommen womöglich, bevor Nuendo den
// DirectAccess-Baum umgebaut hat (FaderBank, mOnObjectChange beim Ein- und
// Ausblenden). Was dort sofort gelesen wird, gilt deshalb nur bis zum nächsten
// Bedarf (t3kRecheck), und ein "nicht gefunden" wird fürs Zustandsbyte jedes Mal
// neu geprüft.
var t3k = null
var t3kRecheck = false
// Stand, den das Deck zuletzt mitgeteilt bekam ("none" oder "id<Objekt-ID>"),
// null = noch nie. Weicht das aufgelöste TONE3000 davon ab, meldet syncT3k nach.
var t3kReported = null

function isT3kTitle(title) {
    return hostText(title).toLowerCase().indexOf(T3K_MATCH) >= 0
}

/**
 * Kanal -> "Inserts" -> Slot SLOT_T3K -> erstes Kind. Gültig nur, wenn dessen
 * Titel T3K_MATCH enthält. Die Tags werden über alle Parameter per exaktem Titel
 * gesucht (2125 Parameter, die gesuchten stehen vorn; die Schleife endet, sobald
 * alle gefunden sind). Ist es dasselbe Objekt wie zuvor, bleiben Tags und
 * Fremdliste. Ausnahmen des Hosts gehen an den Aufrufer, t3k bleibt dann null.
 */
/**
 * Kanal -> "Inserts" -> Slot slot (nullbasiert) -> erstes Kind, das Plugin. -1, wenn
 * es den Slot nicht gibt oder er leer ist.
 */
function pluginInSlot(activeMapping, access, slot) {
    var baseID = access.getBaseObjectID(activeMapping)
    var insertsID = findChildByType(activeMapping, access, baseID, 'Inserts')
    if (insertsID < 0 || access.getNumberOfChildObjects(activeMapping, insertsID) <= slot) return -1
    var slotID = access.getChildObjectID(activeMapping, insertsID, slot)
    if (access.getNumberOfChildObjects(activeMapping, slotID) < 1) return -1
    return access.getChildObjectID(activeMapping, slotID, 0)
}

function resolveT3k(activeMapping) {
    var previous = t3k
    t3k = null
    var access = deckAccess
    var result = { found: false, objectID: -1, tags: [null, null, null, null], program: null, foreign: {} }

    var pluginID = pluginInSlot(activeMapping, access, SLOT_T3K)
    if (pluginID >= 0 && isT3kTitle(access.getObjectTitle(activeMapping, pluginID))) {
        result.found = true
        result.objectID = pluginID
    }

    if (result.found && previous && previous.found && previous.objectID === result.objectID) {
        result.tags = previous.tags
        result.program = previous.program
        result.foreign = previous.foreign
    } else if (result.found) {
        findT3kTags(activeMapping, access, result)
    }
    t3k = result
    return result
}

function findT3kTags(activeMapping, access, result) {
    var wanted = T3K_PARAMS.length + 1
    var got = 0
    var count = access.getNumberOfParameters(activeMapping, result.objectID)
    for (var i = 0; i < count && got < wanted; i++) {
        var tag = access.getParameterTagByIndex(activeMapping, result.objectID, i)
        var title = hostText(access.getParameterTitle(activeMapping, result.objectID, tag, 80))
        if (title === T3K_PROGRAM.title && result.program === null) {
            result.program = tag
            got++
            continue
        }
        for (var p = 0; p < T3K_PARAMS.length; p++) {
            if (result.tags[p] === null && title === T3K_PARAMS[p].title) {
                result.tags[p] = tag
                got++
                break
            }
        }
    }
    // Nur Konsole: Eine Debugzeile hier wäre ungefragt gesendet.
    for (var q = 0; q < T3K_PARAMS.length; q++) {
        if (result.tags[q] === null) {
            console.log('TONE3000: Titel "' + T3K_PARAMS[q].title + '" nicht gefunden (' + count + ' Parameter)')
        } else if (result.tags[q] !== T3K_PARAMS[q].tag) {
            console.log('TONE3000: "' + T3K_PARAMS[q].title + '" hat Tag ' + result.tags[q] + ', erwartet ' + T3K_PARAMS[q].tag)
        }
    }
    if (result.program === null) console.log('TONE3000: Titel "' + T3K_PROGRAM.title + '" nicht gefunden')
}

/**
 * Das gemerkte TONE3000, falls noch gültig, sonst frisch aufgelöst. Gültig heißt:
 * das gemerkte Objekt trägt noch einen TONE3000-Titel (ein Aufruf), und kein
 * Objektwechsel steht aus (t3kRecheck). Ein gemerktes "nicht gefunden" gilt bis
 * zur nächsten Verwerfung — außer recheckMissing, dann wird neu gesucht (Anfragen
 * vom Deck und Zustandsbyte: TONE3000 kann inzwischen eingesetzt sein).
 */
function lookupT3k(activeMapping, recheckMissing) {
    if (t3kRecheck) {
        t3kRecheck = false
        return resolveT3k(activeMapping)
    }
    if (t3k && t3k.found) {
        var stillThere = false
        try {
            stillThere = isT3kTitle(deckAccess.getObjectTitle(activeMapping, t3k.objectID))
        } catch (e) {
            console.log('TONE3000: gemerktes Objekt ' + t3k.objectID + ' nicht lesbar (' + e + ')')
        }
        if (stillThere) return t3k
        return resolveT3k(activeMapping)
    }
    if (t3k && !recheckMissing) return t3k
    return resolveT3k(activeMapping)
}

/**
 * fn einmal wiederholen, wenn ein Zugriff scheitert: Die gemerkte Objekt-ID kann
 * veraltet sein (Plugin neu geladen). fn löst selbst über lookupT3k auf, nach dem
 * Verwerfen also frisch. Scheitert auch der zweite Versuch, geht die Ausnahme an
 * den Aufrufer.
 */
function retryOnce(fn) {
    try {
        return fn()
    } catch (e) {
        console.log('TONE3000: Zugriff gescheitert (' + e + '), neu auflösen')
        t3k = null
        return fn()
    }
}

/**
 * bit6 für das Zustandsbyte; ein Fehler des Hosts zählt als "nicht gefunden".
 * "Nicht gefunden" wird jedes Mal neu geprüft: Kam der Slot-Titel vor dem neuen
 * Objekt im DirectAccess-Baum, bliebe bit6 sonst auf 0 hängen. Zustandsbytes sind
 * selten (Tasten, Titel), die rund zehn Aufrufe des Suchwegs also billig.
 */
function t3kFound() {
    if (!currentMapping) return false
    try {
        return lookupT3k(currentMapping, true).found
    } catch (e) {
        t3k = null
        return false
    }
}

function t3kKey(t) {
    return t && t.found ? 'id' + t.objectID : 'none'
}

//--- Senden ----------------------------------------------------------------------
// force = ohne Dedup (Abfrage). Auch erzwungenes Senden merkt sich den Stand, damit
// der Dedup danach gegen das vergleicht, was das Deck wirklich hat.

/**
 * 0x20: Wert und Klartext eines Reglers. Lässt er sich nicht lesen, geht nichts
 * hinaus, und der Dedup vergisst ihn: Kommt TONE3000 mit denselben Werten zurück,
 * muss das Deck sie trotzdem bekommen.
 */
function sendParam(activeDevice, activeMapping, t, p, force) {
    if (!t || !t.found || t.tags[p] === null) {
        lastParamSent[p] = null
        return
    }
    var tag = t.tags[p]
    var access = deckAccess
    var value = toValue14(access.getParameterProcessValue(activeMapping, t.objectID, tag))
    if (value < 0) {
        lastParamSent[p] = null
        console.log('TONE3000: ' + T3K_PARAMS[p].title + ' liefert keinen Zahlenwert')
        return
    }
    var text = hostText(access.getParameterDisplayValue(activeMapping, t.objectID, tag))
    var key = value + '|' + text
    if (!force && lastParamSent[p] === key) return
    lastParamSent[p] = key
    sendFrame(activeDevice, MSG_PARAM, [p, (value >> 7) & 0x7F, value & 0x7F]
        .concat(hexAscii(textBytes(text, MAX_VALUE_TEXT_BYTES))))
}

/**
 * 0x21: Klartext von "Program"; leer, wenn TONE3000 oder der Parameter fehlt.
 * Liefert true, wenn ein Frame hinausging.
 */
function sendPreset(activeDevice, activeMapping, t, force) {
    var name = ''
    if (t && t.found && t.program !== null) {
        name = hostText(deckAccess.getParameterDisplayValue(activeMapping, t.objectID, t.program))
    }
    if (!force && lastPresetSent === name) return false
    lastPresetSent = name
    sendFrame(activeDevice, MSG_PRESET, hexAscii(textBytes(name, MAX_NAME_BYTES)))
    return true
}

function currentFlags() {
    var flags = 0
    for (var n = 0; n < DECK_NOTES; n++) {
        if (deckOn[n]) flags |= 1 << n
    }
    if (targetOk()) flags |= FLAG_TARGET_OK
    if (t3kFound()) flags |= FLAG_T3K_FOUND
    return flags
}

/**
 * 0x22: Zustandsbyte. Geht es ohne bit6 hinaus, gelten Reglerwerte und Preset beim
 * Deck als unbekannt (docs/protokoll.md 4.2): Der Dedup vergisst sie, damit sie mit
 * TONE3000 vollständig zurückkommen — auch mit unveränderten Werten.
 */
function sendFlags(activeDevice, force) {
    var flags = currentFlags()
    if (!force && lastFlagsSent === flags) return
    lastFlagsSent = flags
    if (!(flags & FLAG_T3K_FOUND)) {
        for (var p = 0; p < T3K_PARAMS.length; p++) lastParamSent[p] = null
        // Ein leeres 0x21 hat das Deck schon; jeder andere Name gilt als vergessen.
        if (lastPresetSent !== '') lastPresetSent = null
    }
    sendFrame(activeDevice, MSG_FLAGS, [flags])
}

/** 0x23: Plugin-Name eines Slots laut Viewer, leer für einen leeren Slot. */
function sendSlotName(activeDevice, slot, force) {
    var name = hostText(slotNames[slot])
    if (!force && lastSlotSent[slot] === name) return
    lastSlotSent[slot] = name
    sendFrame(activeDevice, MSG_SLOT_NAME, [slot].concat(hexAscii(textBytes(name, MAX_NAME_BYTES))))
}

/** 0x22 mit Dedup; stellt sich TONE3000 dabei als anders heraus, auch der Rest. */
function sendFlagsAndSync(activeDevice) {
    if (!deckLive()) return
    sendFlags(activeDevice, false)
    syncT3k(activeDevice, -1)
}

/**
 * Zustandsbyte, vier Regler und Preset, alles mit Dedup, und den gemeldeten Stand
 * merken. Das Zustandsbyte zuerst: Es kann selbst neu auflösen, die übrigen Frames
 * lesen danach das, was dabei herauskam. skip: dieser Regler nicht (das Deck hat
 * ihn eben selbst gesetzt), sonst -1.
 */
function reportT3k(activeDevice, skip) {
    sendFlags(activeDevice, false)
    var t = t3k
    t3kReported = t3kKey(t)
    for (var p = 0; p < T3K_PARAMS.length; p++) {
        if (p !== skip) sendParam(activeDevice, currentMapping, t, p, false)
    }
    sendPreset(activeDevice, currentMapping, t, false)
}

/**
 * Meldet nach, wenn das zuletzt aufgelöste TONE3000 nicht mehr dem gemeldeten Stand
 * entspricht (gefunden oder nicht, andere Objekt-ID) — gleich, wo aufgelöst wurde:
 * beim Zustandsbyte, bei 0x11/0x12 oder im Parameter-Callback. Sonst fände das Deck
 * nie heraus, dass bit6 gefallen ist; Debugzeilen wertet es nicht aus.
 */
function syncT3k(activeDevice, skip) {
    if (!t3k || !deckLive()) return
    if (t3kKey(t3k) === t3kReported) return
    reportT3k(activeDevice, skip)
}

/**
 * Das gemerkte TONE3000 verwerfen, neu auflösen und melden, was sich geändert hat
 * (Zustandsbyte, Regler, Preset — alles mit Dedup). Nach einem Objektwechsel und
 * wenn in Slot 3 ein anderes Plugin steht. Wie die FaderBank zweimal: sofort und
 * beim nächsten Bedarf noch einmal (t3kRecheck), falls Nuendo den Baum erst nach
 * dem Callback umbaut.
 */
function refreshT3k(activeDevice) {
    t3k = null
    t3kRecheck = false
    if (!deckLive()) return
    resolveT3k(currentMapping)
    reportT3k(activeDevice, -1)
    t3kRecheck = true
}

//--- Rückmeldung aus dem Host ------------------------------------------------------
/**
 * Hängt am Parameter-Callback des Deck-Kanals, neben der Beobachtung.
 * Meldet die vier Regler als 0x20 und das Preset als 0x21, beides mit Dedup.
 *
 * Auf "Program" ist kein Verlass: Im Suchlauf 2026-10-01 setzte das Script ihn
 * dreimal selbst, und es kam kein Callback für ihn, wohl aber für die übrigen
 * Parameter, die der Wechsel verstellt (JUCE meldet Werte, die der Host setzt,
 * nicht zurück). Deshalb wird sein Klartext bei JEDER Änderung am TONE3000-Objekt
 * nachgelesen; der Dedup hält Unverändertes zurück. Ein Callback für "Program"
 * selbst nimmt denselben Weg.
 *
 * Ist der Presetname neu, werden alle vier Regler nachgelesen (mit Dedup): Lädt
 * Nuendo einen Plugin-State (.vstpreset, Projekt), unterdrückt JUCE die Meldungen
 * der einzelnen Parameter; kommt dann nur eine, sollen die übrigen nicht fehlen.
 */
function onDeckParameterChange(activeDevice, activeMapping, objectID, tag) {
    if (!deckLive()) return
    var mapping = activeMapping || currentMapping
    var t = t3k
    if (t === null || t3kRecheck) t = lookupT3k(mapping, false)
    if (!t.found || objectID !== t.objectID) {
        checkForeignObject(activeDevice, mapping, t, objectID)
        syncT3k(activeDevice, -1)
        return
    }
    for (var p = 0; p < T3K_PARAMS.length; p++) {
        if (t.tags[p] === tag) sendParam(activeDevice, mapping, t, p, false)
    }
    if (sendPreset(activeDevice, mapping, t, false)) {
        for (var q = 0; q < T3K_PARAMS.length; q++) sendParam(activeDevice, mapping, t, q, false)
    }
    syncT3k(activeDevice, -1)
}

/**
 * Ein Callback von einem Objekt, das nicht das gemerkte TONE3000 ist. Heißt es
 * TONE3000, wurde das Plugin womöglich neu geladen oder eingesetzt, ohne dass
 * mOnObjectChange kam — dann neu auflösen. Jede fremde ID wird nur einmal
 * nachgesehen (ein Aufruf), damit etwa das Delay nicht bei jeder Bewegung kostet.
 */
function checkForeignObject(activeDevice, activeMapping, t, objectID) {
    if (t.foreign[objectID]) return
    t.foreign[objectID] = true
    if (!isT3kTitle(deckAccess.getObjectTitle(activeMapping, objectID))) return
    var fresh = resolveT3k(activeMapping)
    fresh.foreign[objectID] = fresh.objectID !== objectID
    if (fresh.objectID !== objectID) return
    reportT3k(activeDevice, -1)
}

//--- Slots und Tasten ------------------------------------------------------------
// Je Slot ein Viewer am Deck-Kanal wie bindInsertSlot der FaderBank: Den
// Plugin-Namen liefert der Titel der Parameter-Bank-Zone (der Identitäts-Callback
// schweigt, FaderBank E-29), ein Parameterwert der Zone hält sie lebendig. Die
// Viewer folgen der Deck-Zone von selbst; während der Deck-Suche wird ihr Titel nur
// gemerkt, ihr Ende meldet ihn (reportDeck).
var deckViewers = []

function bindDeckSlot(slot) {
    var viewer = deckChannel.mInsertAndStripEffects
        .makeInsertEffectViewer('deckSlot' + slot)
        .accessSlotAtIndex(slot)
    viewer.mParameterBankZone.makeParameterValue()
    viewer.mParameterBankZone.mOnTitleChange = function (activeDevice, activeMapping, title) {
        var changed = slotNames[slot] !== title
        slotNames[slot] = title
        if (!changed || seekBusy()) return
        guarded(activeDevice, 'Slot ' + (slot + 1), function () {
            if (!deckLive()) return
            sendSlotName(activeDevice, slot, false)
            // Anderes Plugin in Slot 3: Das gemerkte TONE3000 gilt nicht mehr.
            if (slot === SLOT_T3K) refreshT3k(activeDevice)
            // Anderes Plugin in Slot 1: ebenso der gemerkte Tuner.
            if (slot === SLOT_TUNER) refreshTuner(activeDevice)
        })
    }
    deckViewers.push(viewer)
}
for (var ds = 0; ds < DECK_SLOTS; ds++) bindDeckSlot(ds)

/**
 * Eine Taste auf MIDI-Kanal 3 an einem Hostwert. Wie Solo und Select der FaderBank:
 * kein setTypeToggle, das Deck schickt den Zielzustand als Velocity (127 an, 0 aus)
 * und kein Note Off hinterher. Der Callback hängt am SurfaceValue, nicht am
 * Binding; er meldet auch Änderungen, die in Nuendo von Hand passieren — und die
 * Werte des neuen Kanals, wenn die Deck-Zone weiterzieht (während der Deck-Suche
 * nur gemerkt, ihr Ende meldet das Zustandsbyte).
 */
function bindDeckButton(note, hostValue) {
    var button = surface.makeButton(note, DECK_ROW, 1, 1)
    button.mSurfaceValue.mMidiBinding
        .setInputPort(midiInput)
        .bindToNote(DECK_CHANNEL, note)
    page.makeValueBinding(button.mSurfaceValue, hostValue)
    button.mSurfaceValue.mOnProcessValueChange = function (activeDevice, value) {
        deckOn[note] = value > 0
        if (seekBusy()) return
        guarded(activeDevice, 'Taste ' + note, function () {
            sendFlagsAndSync(activeDevice)
        })
    }
}
// Mute zusätzlich zur Kanal-1-Taste aus bindInput: Steht die Deck-Zone auf dem
// Kanal von Platz n der Such-Zone, hängen beide am selben Hostwert.
bindDeckButton(NOTE_MUTE, deckChannel.mValue.mMute)
bindDeckButton(NOTE_TUNER_EDIT, deckViewers[SLOT_TUNER].mEdit)
bindDeckButton(NOTE_DELAY_BYPASS, deckViewers[SLOT_DELAY].mBypass)
bindDeckButton(NOTE_DELAY_EDIT, deckViewers[SLOT_DELAY].mEdit)
bindDeckButton(NOTE_T3K_EDIT, deckViewers[SLOT_T3K].mEdit)

//--- Aufträge vom Deck -------------------------------------------------------------
/** Gleiche Ablehnungen hintereinander nur einmal — beim Drehen kommen viele. */
function reject(activeDevice, text) {
    if (text === lastRejection) return
    lastRejection = text
    line(activeDevice, text)
}

/** Grund, warum Regler und Presets gerade nicht wirken dürfen, sonst ''. */
function deckBlocked() {
    if (!currentMapping) return 'noch kein activeMapping (Seite nie aktiviert)'
    if (!targetOk()) return 'Deck-Kanal heißt "' + hostText(deckTitle) + '", nicht "' + TARGET_TITLE + '"'
    return ''
}

/**
 * 0x10: alles ohne Dedup, in fester Reihenfolge. Jedes Frame einzeln abgesichert,
 * damit ein Fehler beim Lesen eines Reglers die übrige Antwort nicht verhindert.
 *
 * Vor der Aktivierung und bis der Deck-Kanal das erste Mal positioniert ist
 * (deckReady), wird sie nur gemerkt: Eine Antwort davor zeigte den Kanal, auf dem
 * die Deck-Zone beim Laden steht (Platz 0), nicht Input 6.
 */
function runQuery(activeDevice) {
    if (!currentMapping || !deckReady) {
        if (!currentMapping && !queryPending) line(activeDevice, 'ABFRAGE vor der Aktivierung: Antwort folgt mit der Aktivierung')
        queryPending = true
        return
    }
    queryPending = false
    // Die Abfrage geht den Weg Kanal -> Slot 3 ganz ab, statt nur den Titel des
    // gemerkten Objekts zu prüfen: Sie ist selten und soll die Wahrheit liefern, auch
    // wenn TONE3000 etwa in einen anderen Slot gezogen wurde. Gleiche Objekt-ID
    // behält die Tags. Danach lesen die Frames das gemerkte Ergebnis.
    t3kRecheck = false
    try {
        retryOnce(function () {
            resolveT3k(currentMapping)
        })
    } catch (e) {
        t3k = null
        console.log('ABFRAGE: TONE3000 nicht auflösbar (' + e + ')')
    }
    for (var p = 0; p < T3K_PARAMS.length; p++) queryParam(activeDevice, p)
    try {
        retryOnce(function () {
            sendPreset(activeDevice, currentMapping, lookupT3k(currentMapping, false), true)
        })
    } catch (e2) {
        lastPresetSent = null
        line(activeDevice, 'ABFRAGE Preset Fehler: ' + e2)
    }
    sendFlags(activeDevice, true)
    t3kReported = t3kKey(t3k)
    for (var s = 0; s < DECK_SLOTS; s++) sendSlotName(activeDevice, s, true)
    queryTuner(activeDevice)
}

/** Ein Regler der Abfrage; scheitert er, hat das Deck keinen Wert, der Dedup auch nicht. */
function queryParam(activeDevice, p) {
    try {
        retryOnce(function () {
            sendParam(activeDevice, currentMapping, lookupT3k(currentMapping, false), p, true)
        })
    } catch (e) {
        lastParamSent[p] = null
        line(activeDevice, 'ABFRAGE ' + T3K_PARAMS[p].label + ' Fehler: ' + e)
    }
}

/**
 * 0x11: Regler setzen. Zurückgeschickt wird nichts; der Host meldet die Änderung
 * über den Parameter-Callback, daraus wird 0x20. Ob er den eigenen Wert meldet, ist
 * am Gerät ungeprüft — nach dem JUCE-Quelltext eher nicht (paramChanged übergeht
 * Werte, die der Host gesetzt hat; im Suchlauf 2026-10-01 kam für das selbst
 * gesetzte "Program" kein Callback). Kommt keiner, bleibt das Deck mit seinem Wert
 * führend. Der Dedup für p wird deshalb vor dem Setzen vergessen: Das Deck hat jetzt
 * einen eigenen Wert, und die nächste Meldung des Hosts für p — Echo, Hand am
 * Plugin, Preset — muss hinaus, auch wenn sie dem zuletzt gesendeten Stand gleicht.
 *
 * Stellt sich TONE3000 beim Auflösen als anders heraus (fehlt, neue Objekt-ID),
 * meldet syncT3k das nach; der eben gesetzte Regler bleibt dabei außen vor.
 */
function runParamSet(activeDevice, message) {
    if (message.length !== 7 || message[6] !== 0xF7) {
        reject(activeDevice, 'TONE3000 setzen abgelehnt: Frame mit ' + message.length + ' Byte, erwartet F0 7D 11 <p> <v1> <v0> F7')
        return
    }
    var p = message[3]
    if (p >= T3K_PARAMS.length) {
        reject(activeDevice, 'TONE3000 setzen abgelehnt: Regler ' + p + ' unbekannt (0..' + (T3K_PARAMS.length - 1) + ')')
        return
    }
    var value = message[4] * 128 + message[5]
    if (message[4] > 0x7F || message[5] > 0x7F) {
        reject(activeDevice, 'TONE3000 ' + T3K_PARAMS[p].label + ' abgelehnt: Datenbyte über 0x7F')
        return
    }
    var blocked = deckBlocked()
    if (blocked) {
        reject(activeDevice, 'TONE3000 ' + T3K_PARAMS[p].label + ' abgelehnt: ' + blocked)
        return
    }
    var normalized = value / VALUE_MAX
    var problem = retryOnce(function () {
        var t = lookupT3k(currentMapping, true)
        if (!t.found) return 'kein TONE3000 in Slot ' + (SLOT_T3K + 1)
        if (t.tags[p] === null) return 'Titel "' + T3K_PARAMS[p].title + '" nicht gefunden'
        lastParamSent[p] = null
        deckAccess.setParameterProcessValue(currentMapping, t.objectID, t.tags[p], normalized)
        return ''
    })
    if (problem) {
        reject(activeDevice, 'TONE3000 ' + T3K_PARAMS[p].label + ' abgelehnt: ' + problem)
        syncT3k(activeDevice, -1)
        return
    }
    lastRejection = ''
    syncT3k(activeDevice, p)
}

/**
 * 0x12: Preset per Namen. setParameterDisplayValue auf "Program" wählt es (belegt
 * 2026-10-01 mit "HMT"), danach wird der Klartext gelesen und als 0x21 gemeldet.
 *
 * Bekannt (TONE3000-Quelltext, ProcessorPresets.cpp): Ohne aktives Preset meldet
 * TONE3000 getCurrentProgram() = 0, und der Klartext von "Program" zeigt schon den
 * Namen von Programm 0 (dem ersten Preset der Liste). Ein Wechsel auf Programm 0
 * wird dann verschluckt — der Klartext stimmt aber schon vorher, "nicht
 * übernommen" kann das also nicht erkennen. Stand der Name schon vor dem Setzen
 * da, sagt es eine eigene Debugzeile; sie kommt ebenso, wenn das Preset wirklich
 * aktiv ist (das Script kann beides nicht unterscheiden). Abhilfe am Deck: einmal
 * ein anderes Preset wählen.
 */
function runPresetSet(activeDevice, message) {
    var problem = payloadProblem(message)
    if (problem) {
        line(activeDevice, 'Preset abgelehnt: ' + problem)
        return
    }
    var name = decodeHexText(message, 3, message.length - 1)
    if (name === '') {
        line(activeDevice, 'Preset abgelehnt: kein Name')
        return
    }
    var blocked = deckBlocked()
    if (blocked) {
        line(activeDevice, 'Preset ' + name + ' abgelehnt: ' + blocked)
        return
    }
    var access = deckAccess
    var t = null
    var before = ''
    problem = retryOnce(function () {
        t = lookupT3k(currentMapping, true)
        if (!t.found) return 'kein TONE3000 in Slot ' + (SLOT_T3K + 1)
        if (t.program === null) return 'Titel "' + T3K_PROGRAM.title + '" nicht gefunden'
        before = hostText(access.getParameterDisplayValue(currentMapping, t.objectID, t.program))
        access.setParameterDisplayValue(currentMapping, t.objectID, t.program, name)
        return ''
    })
    if (problem) {
        line(activeDevice, 'Preset ' + name + ' abgelehnt: ' + problem)
        syncT3k(activeDevice, -1)
        return
    }
    var active = hostText(access.getParameterDisplayValue(currentMapping, t.objectID, t.program))
    sendPreset(activeDevice, currentMapping, t, false)
    if (active !== name) {
        line(activeDevice, 'Preset ' + name + ' nicht übernommen, aktiv ' + active)
    } else if (before === name) {
        line(activeDevice, 'Preset ' + name + ' laut Host schon aktiv, ohne aktives Preset in TONE3000 wirkungslos')
    }
    syncT3k(activeDevice, -1)
}

//------------------------------------------------------------------------------
// Stimmanzeige (Protokoll 4)
//------------------------------------------------------------------------------
// Der Tuner-Modus gehört dem Deck: 0x13 schaltet ihn, und nur in ihm sendet das
// Script unverlangt 0x24. Er schaltet den AUSGANG des Tuners stumm (Parameter
// "Mute" des Plugins, nicht die Mute des Kanals), damit beim Stimmen nichts aus
// TONE3000 kommt. Hängt der Modus, weil das Deck verschwindet, bliebe die Gitarre
// stumm — dagegen schickt das Deck bei jedem Verbindungsaufbau seinen Modus, beim
// Start des Plugins 0. Ein 0x13 0 hebt die Mute deshalb auch dann auf, wenn dieses
// Script sie nie gesetzt hat (etwa gespeichert im Projekt). Bei stehender Verbindung
// sieht das Deck eine solche Mute im 0x24 der Abfrage (bit2 = 0, bit4 = 1) und
// schickt einmal 0x13 0 (docs/protokoll.md 5.5). Das Script selbst setzt außerhalb
// des Modus nichts von sich aus.
//
// Gemerkter Tuner wie TONE3000: null = nicht aufgelöst, sonst { found, objectID,
// tags, relevant, foreign }. objectID ist auch gesetzt, wenn das Objekt ein Tuner
// ist, ihm aber ein required-Parameter fehlt (found = false). relevant: die Tags,
// deren Meldung ein 0x24 auslösen kann. foreign: fremde Objekt-IDs aus dem
// Parameter-Callback, jede höchstens einmal nachgesehen.
//
// Aufgelöst wird frisch bei 0x13 und 0x10, sonst nur nach einer Verwerfung
// (Objektwechsel, anderes Plugin in Slot 1, Objekt entfernt) — im Callback also
// höchstens einmal, nie je Meldung. Die Tags hängen an der Objekt-ID
// (tunerTagCache) und werden für dasselbe Objekt nie zweimal gesucht.
var tuner = null
var tunerRecheck = false
var tunerTagCache = null
var tunerMode = false
// 0x13 vor der ersten Aktivierung: gewünschter Modus (0 oder 1), -1 = keiner.
var tunerModePending = -1
// Objekt-IDs, denen der Modus die Mute gesetzt hat. Beim Ausschalten wird sie an
// allen aufgehoben, die es noch gibt — auch an einem Tuner, der inzwischen aus
// Slot 1 gezogen wurde und dort weiter den Ausgang stummschaltet.
var tunerMuted = []
// Während das Script selbst "Mute" setzt: Meldungen daraus senden nichts, das 0x24
// danach sagt alles (synchrones Echo des Hosts, sonst doppelt).
var tunerApplying = false
// Datenbytes des zuletzt gesendeten 0x24, null = noch keins.
var lastTunerSent = null

function trimText(value) {
    return hostText(value).replace(/^\s+|\s+$/g, '')
}

function tunerTitle(key) {
    for (var i = 0; i < TUNER_PARAMS.length; i++) {
        if (TUNER_PARAMS[i].key === key) return TUNER_PARAMS[i].title
    }
    return ''
}

/** Steinbergs Tuner: Titel "Tuner" oder seine Klassenkennung. */
function isSteinbergTuner(activeMapping, access, objectID) {
    if (trimText(access.getObjectTitle(activeMapping, objectID)) === TUNER_TITLE) return true
    return hostText(access.getObjectUniqueName(activeMapping, objectID)).toUpperCase().indexOf(TUNER_CLASS) === 0
}

/**
 * Tags über den exakten Titel (12 Parameter). Liefert { objectID, found, tags,
 * relevant }; found = alle required-Titel da. Abweichungen nur in die Konsole —
 * eine Debugzeile hier wäre ungefragt gesendet.
 */
function findTunerTags(activeMapping, access, objectID) {
    var entry = { objectID: objectID, found: true, tags: {}, relevant: {} }
    var d
    for (d = 0; d < TUNER_PARAMS.length; d++) entry.tags[TUNER_PARAMS[d].key] = null
    var count = access.getNumberOfParameters(activeMapping, objectID)
    var got = 0
    for (var i = 0; i < count && got < TUNER_PARAMS.length; i++) {
        var tag = access.getParameterTagByIndex(activeMapping, objectID, i)
        var title = hostText(access.getParameterTitle(activeMapping, objectID, tag, 80))
        for (d = 0; d < TUNER_PARAMS.length; d++) {
            if (entry.tags[TUNER_PARAMS[d].key] === null && title === TUNER_PARAMS[d].title) {
                entry.tags[TUNER_PARAMS[d].key] = tag
                entry.relevant[tag] = true
                got++
                break
            }
        }
    }
    for (d = 0; d < TUNER_PARAMS.length; d++) {
        var def = TUNER_PARAMS[d]
        var have = entry.tags[def.key]
        if (have === null) {
            console.log('Tuner: Titel "' + def.title + '" nicht gefunden (' + count + ' Parameter)' +
                (def.required ? ', Tuner unbrauchbar' : ''))
            if (def.required) entry.found = false
        } else if (have !== def.tag) {
            console.log('Tuner: "' + def.title + '" hat Tag ' + have + ', erwartet ' + def.tag)
        }
    }
    return entry
}

/**
 * Kanal -> "Inserts" -> Slot SLOT_TUNER -> erstes Kind, gültig, wenn es Steinbergs
 * Tuner ist. Gleiche Objekt-ID wie zuvor behält die Fremdliste. Ausnahmen des Hosts
 * gehen an den Aufrufer, tuner bleibt dann null.
 */
function resolveTuner(activeMapping) {
    var previous = tuner
    tuner = null
    var access = deckAccess
    var result = { found: false, objectID: -1, tags: {}, relevant: {}, foreign: {} }
    var pluginID = pluginInSlot(activeMapping, access, SLOT_TUNER)
    if (pluginID >= 0 && isSteinbergTuner(activeMapping, access, pluginID)) {
        if (!tunerTagCache || tunerTagCache.objectID !== pluginID) {
            tunerTagCache = findTunerTags(activeMapping, access, pluginID)
        }
        result.objectID = pluginID
        result.found = tunerTagCache.found
        result.tags = tunerTagCache.tags
        result.relevant = tunerTagCache.relevant
    }
    if (previous && previous.objectID === result.objectID) result.foreign = previous.foreign
    tuner = result
    return result
}

/** Wie retryOnce, für den Tuner: einmal frisch aufgelöst wiederholen. */
function retryTuner(fn) {
    try {
        return fn()
    } catch (e) {
        console.log('Tuner: Zugriff gescheitert (' + e + '), neu auflösen')
        tuner = null
        return fn()
    }
}

//--- Lesen und senden --------------------------------------------------------------
function tunerSwitch(mapping, t, key) {
    if (t.tags[key] === null) return false
    return deckAccess.getParameterProcessValue(mapping, t.objectID, t.tags[key]) >= 0.5
}

/** Erste Zahl im Text ("-16", "+3", "12 ct"); NaN, wenn keine. */
function leadingNumber(text) {
    var n = parseFloat(trimText(text).replace(',', '.'))
    return isFinite(n) ? n : NaN
}

function clampRound(n, lo, hi) {
    n = Math.round(n)
    if (n < lo) return lo
    if (n > hi) return hi
    return n
}

/**
 * Datenbytes von 0x24: flags, cent+64, oct+64, Note. Ohne Tuner nur bit2 (Modus),
 * Cent und Oktave 0, Note leer. Mit Tuner sechs Lesezugriffe, kein Baum.
 */
function tunerData(mapping, t) {
    var flags = tunerMode ? TUNER_MODE_ON : 0
    var cent = 0
    var oct = 0
    var note = ''
    if (t && t.found) {
        var access = deckAccess
        flags |= TUNER_FOUND
        if (tunerSwitch(mapping, t, 'locked')) flags |= TUNER_LOCKED
        if (tunerSwitch(mapping, t, 'inTune')) flags |= TUNER_IN_TUNE
        if (tunerSwitch(mapping, t, 'mute')) flags |= TUNER_MUTED
        cent = leadingNumber(access.getParameterDisplayValue(mapping, t.objectID, t.tags.cent))
        if (isNaN(cent)) {
            // Klartext unlesbar: roh 0..1 entspricht -50..50 Cent (Suchlauf: "-16" bei 0.34)
            var raw = access.getParameterProcessValue(mapping, t.objectID, t.tags.cent)
            cent = typeof raw === 'number' && isFinite(raw) ? raw * 2 * TUNER_CENT_MAX - TUNER_CENT_MAX : 0
        }
        cent = clampRound(cent, -TUNER_CENT_MAX, TUNER_CENT_MAX)
        if (t.tags.oct !== null) {
            // Bei Stille leer: dann 0, das Deck richtet sich nach bit0
            oct = leadingNumber(access.getParameterDisplayValue(mapping, t.objectID, t.tags.oct))
            oct = isNaN(oct) ? 0 : clampRound(oct, -TUNER_OFFSET, 127 - TUNER_OFFSET)
        }
        note = trimText(access.getParameterDisplayValue(mapping, t.objectID, t.tags.note))
    }
    return [flags, cent + TUNER_OFFSET, oct + TUNER_OFFSET].concat(hexAscii(textBytes(note, MAX_NOTE_BYTES)))
}

/** 0x24; force = ohne Dedup. Auch erzwungenes Senden merkt sich den Stand. */
function sendTuner(activeDevice, mapping, t, force) {
    var data = tunerData(mapping, t)
    var key = data.join(',')
    if (!force && key === lastTunerSent) return false
    lastTunerSent = key
    sendFrame(activeDevice, MSG_TUNER, data)
    return true
}

//--- Mute des Tuners ----------------------------------------------------------------
/**
 * "Mute" eines Tuner-Objekts auf den Zielzustand. Gesetzt wird nur, was abweicht:
 * Ein 0x13 bei jedem Verbindungsaufbau soll das Projekt nicht anfassen, wenn alles
 * schon stimmt. Liefert true, wenn gesetzt wurde.
 */
function applyTunerMute(mapping, objectID, tag, on) {
    var access = deckAccess
    if ((access.getParameterProcessValue(mapping, objectID, tag) >= 0.5) === on) return false
    tunerApplying = true
    try {
        access.setParameterProcessValue(mapping, objectID, tag, on ? 1 : 0)
    } finally {
        tunerApplying = false
    }
    return true
}

function rememberMuted(objectID) {
    if (tunerMuted.indexOf(objectID) < 0) tunerMuted.push(objectID)
}

/**
 * Im Modus: ein Tuner, der neu in Slot 1 auftaucht (anderes Projekt, neu geladen,
 * erst jetzt eingesetzt), wird ebenfalls stummgeschaltet — der Modus heißt "Ausgang
 * des Tuners stumm". Einer, dem der Modus die Mute schon gesetzt hat, nicht noch
 * einmal: Hebt man sie im Plugin von Hand auf, bleibt das so.
 */
function followTuner(mapping, t) {
    if (!tunerMode || !t.found || tunerMuted.indexOf(t.objectID) >= 0) return
    applyTunerMute(mapping, t.objectID, t.tags.mute, true)
    rememberMuted(t.objectID)
}

/** Modus aus: Mute am Tuner in Slot 1 aufheben und an jedem, dem der Modus sie gab. */
function releaseTunerMute(mapping, t) {
    var muted = tunerMuted
    if (t.found) applyTunerMute(mapping, t.objectID, t.tags.mute, false)
    tunerMuted = []
    for (var i = 0; i < muted.length; i++) {
        if (muted[i] !== t.objectID) releaseOtherTuner(mapping, muted[i])
    }
}

/**
 * Ein Tuner, dem der Modus die Mute gesetzt hat und der nicht mehr in Slot 1
 * steckt. Gibt es ihn noch, wird auch seine Mute aufgehoben. Fehler nur in die
 * Konsole: Das Objekt kann längst entfernt sein.
 */
function releaseOtherTuner(mapping, objectID) {
    var access = deckAccess
    try {
        if (!isSteinbergTuner(mapping, access, objectID)) return
        var param = findParamByTitle(mapping, access, objectID, tunerTitle('mute'))
        if (param.found) applyTunerMute(mapping, objectID, param.tag, false)
    } catch (e) {
        console.log('Tuner: Objekt ' + objectID + ' nicht mehr erreichbar (' + e + ')')
    }
}

//--- Aufträge und Meldungen -----------------------------------------------------------
/**
 * 0x13: genau F0 7D 13 <m> F7 mit m = 0 oder 1. Wie die Abfrage bis zur ersten
 * Positionierung des Deck-Kanals nur gemerkt — sonst hübe ein 0x13 0 beim Start
 * die Mute am Tuner des falschen Kanals auf.
 */
function runTunerMode(activeDevice, message) {
    if (message.length !== 5 || message[4] !== 0xF7) {
        line(activeDevice, 'TUNER abgelehnt: Frame mit ' + message.length + ' Byte, erwartet F0 7D 13 <m> F7')
        return
    }
    var m = message[3]
    if (m !== 0 && m !== 1) {
        line(activeDevice, 'TUNER abgelehnt: Modus ' + m + ' unbekannt (0 aus, 1 an)')
        return
    }
    if (!currentMapping || !deckReady) {
        if (!currentMapping && tunerModePending < 0) line(activeDevice, 'TUNER vor der Aktivierung: Modus folgt mit der Aktivierung')
        tunerModePending = m
        return
    }
    applyTunerMode(activeDevice, m === 1)
}

/**
 * Modus setzen: Tuner frisch auflösen, Mute setzen bzw. aufheben, dann 0x24 ohne
 * Dedup. Wirkt wie die Tasten ohne Titelprüfung (bit5) — ein 0x13 0 soll eine Mute
 * immer aufheben können. Scheitert der Zugriff auch beim zweiten Versuch, geht die
 * Ausnahme an den Aufrufer (Debugzeile), der Modus ist dann trotzdem umgeschaltet.
 */
function applyTunerMode(activeDevice, on) {
    tunerModePending = -1
    tunerMode = on
    tunerRecheck = false
    var t = retryTuner(function () {
        var fresh = resolveTuner(currentMapping)
        if (on && fresh.found) {
            applyTunerMute(currentMapping, fresh.objectID, fresh.tags.mute, true)
            rememberMuted(fresh.objectID)
        } else if (!on) {
            releaseTunerMute(currentMapping, fresh)
        }
        return fresh
    })
    sendTuner(activeDevice, currentMapping, t, true)
}

/** Letztes Frame der Abfrage, ohne Dedup, auch bei Modus aus. */
function queryTuner(activeDevice) {
    tunerRecheck = false
    try {
        retryTuner(function () {
            var t = resolveTuner(currentMapping)
            followTuner(currentMapping, t)
            sendTuner(activeDevice, currentMapping, t, true)
        })
    } catch (e) {
        tuner = null
        lastTunerSent = null
        line(activeDevice, 'ABFRAGE Tuner Fehler: ' + e)
    }
}

/**
 * Am Parameter-Callback des Deck-Kanals, nur im Modus (der Aufrufer prüft
 * tunerMode schon vorher). Billig: Objekt-ID und Tag vergleichen, dann sechs
 * Lesezugriffe und Dedup. Meldungen anderer Objekte und irrelevanter Tags
 * (Frequency, Base) lesen nichts. Aufgelöst wird nur nach einer Verwerfung, einmal.
 */
function onTunerParameterChange(activeDevice, activeMapping, objectID, tag) {
    if (!tunerMode || tunerApplying || !deckLive()) return
    var mapping = activeMapping || currentMapping
    var t = tuner
    var fresh = false
    if (t === null || tunerRecheck) {
        tunerRecheck = false
        t = resolveTuner(mapping)
        followTuner(mapping, t)
        fresh = true
    }
    if (t.found && objectID === t.objectID) {
        if (fresh || t.relevant[tag]) sendTuner(activeDevice, mapping, t, false)
        return
    }
    if (fresh) sendTuner(activeDevice, mapping, t, false)
    checkForeignTuner(activeDevice, mapping, t, objectID)
}

/**
 * Meldung von einem Objekt, das nicht der gemerkte Tuner ist. Ist es ein Tuner,
 * wurde er womöglich still in Slot 1 neu geladen — dann neu auflösen. Jede fremde
 * ID wird nur einmal nachgesehen (zwei Aufrufe), damit Delay und TONE3000 nicht bei
 * jeder Bewegung kosten.
 */
function checkForeignTuner(activeDevice, mapping, t, objectID) {
    if (t.foreign[objectID]) return
    t.foreign[objectID] = true
    if (!isSteinbergTuner(mapping, deckAccess, objectID)) return
    var fresh = resolveTuner(mapping)
    if (!fresh.found || fresh.objectID !== objectID) {
        fresh.foreign[objectID] = true
        return
    }
    followTuner(mapping, fresh)
    sendTuner(activeDevice, mapping, fresh, false)
}

/**
 * Den gemerkten Tuner verwerfen (Objektwechsel, anderes Plugin in Slot 1). Im Modus
 * sofort neu auflösen, einen neuen Tuner stummschalten und 0x24 mit Dedup melden;
 * wie bei TONE3000 beim nächsten Bedarf noch einmal (tunerRecheck), falls Nuendo
 * den Baum erst nach dem Callback umbaut. Außerhalb des Modus nur vergessen.
 */
function refreshTuner(activeDevice) {
    tuner = null
    tunerRecheck = false
    if (!tunerMode || !deckLive()) return
    var t = resolveTuner(currentMapping)
    followTuner(currentMapping, t)
    sendTuner(activeDevice, currentMapping, t, false)
    tunerRecheck = true
}

//------------------------------------------------------------------------------
// Deck-Suche
//------------------------------------------------------------------------------
// Schiebt die Deck-Zone auf den Platz von TARGET_TITLE, wie die FaderBank ihre Bank
// bewegt (E-19 dort): im Leerlauf — page.mOnIdle läuft im Host und bekommt ein
// frisches activeMapping —, mit Zonen-Aktionen und einem Rundenbudget.
//
// Anlässe (seekReason): die Aktivierung, ein geänderter Titel in der Such-Zone
// (Eingänge eingefügt, entfernt, umbenannt) und der Deck-Kanal, wenn er
// TARGET_TITLE verlässt. Ohne Anlass kehrt der Leerlauf sofort zurück; mit Anlass
// läuft höchstens alle SEEK_PASS_MS ein Durchgang:
//   1. Heißt der Deck-Kanal schon TARGET_TITLE: fertig, nichts bewegt.
//   2. Steht TARGET_TITLE auf Platz k der Such-Zone: mResetBank, dann k-mal
//      mShiftRight (die Zone ist einen Platz breit, ein Schub ist also ein Platz
//      wie mNextBank; mResetBank verrutscht als einziger Bankbefehl nicht am Rand,
//      FaderBank). Danach bis zu SEEK_VERIFY_PASSES Durchgänge auf den Titel
//      warten, sonst die nächste Runde, nach SEEK_MAX_ROUNDS aufgeben.
//   3. Sonst, wenn alle NUM_INPUTS Plätze belegt sind (das Projekt hat womöglich
//      mehr Eingänge), der Rückfall: auf Platz NUM_INPUTS springen und je
//      Durchgang einen Platz weiter, bis der Titel stimmt oder sich nichts mehr
//      bewegt — am Ende der Liste läuft der Schub ins Leere —, höchstens
//      SEEK_MAX_STEPS Schritte.
//   4. Sonst gibt es TARGET_TITLE nicht: aufgeben, ohne die Zone anzufassen.
// Nach dem Ende, gefunden oder aufgegeben, ruht die Suche bis zum nächsten Anlass.
// Ein neuer Anlass mitten in der Suche beginnt sie neu (SEEK_MAX_RESTARTS).
//
// Keine Dauer-Schieberei: Die Zonen-Aktionen lösen selbst Titel- und Objekt-
// meldungen aus (mResetBank auch ohne Bewegung, FaderBank POLL_RESET_BANK), aber
// keine davon ist ein Anlass. Die Such-Zone bewegt sich nie (Zonen sind unabhängig;
// Steinbergs eigene Scripts banken eine Zone neben einer festen "Stereo Out"-Zone),
// und der Deck-Kanal wird nur geschoben, solange er nicht TARGET_TITLE heißt — die
// Suche führt ihn also nie vom Ziel weg, und nur dieser Übergang zählt beim
// Deck-Kanal als Anlass. Hielte eine dieser Annahmen am Gerät nicht, begrenzen
// SEEK_MAX_RESTARTS und die Runden jede einzelne Suche, und ihr Aufgeben schiebt nicht.
//
// "Angekommen" sagt der Titel aus mOnTitleChange oder, solange der noch aussteht,
// der Titel des Basisobjekts per DirectAccess — er ist der Kanalname (Suchlauf
// 2026-10-06: Basis "Mono In 6", Parameter 1024 "Name"); dann übernimmt das Script
// ihn als Titel (seekEnd). Bewegung erkennt der Rückfall an der Objekt-ID des
// Basisobjekts, also auch zwischen zwei gleichnamigen Kanälen; ein leerer Platz
// meldet -1 (FaderBank E-19).
//
// Während der Suche merken die Callbacks des Deck-Kanals (Titel, Slots, Tasten,
// Objektwechsel, Parameter) nur, und gemerkte TONE3000- und Tuner-Objekte gelten
// nicht mehr. Hat sie den Kanal bewegt, meldet ihr Ende, was er jetzt zeigt
// (reportDeck, mit Dedup) — das Deck fragt bei einem Wechsel von bit5 selbst nach.
var SEEK_IDLE = 0
var SEEK_VERIFY = 1
var SEEK_STEP = 2

var seekPhase = SEEK_IDLE
var seekReason = false
var seekRounds = 0
var seekRestarts = 0
var seekWait = 0
var seekSteps = 0
var seekMoved = false // in dieser Suche geschoben, ihr Ende meldet den neuen Stand
var seekPlace = -1 // Platz, auf den zuletzt geschoben wurde
var seekLastBase = -1 // Basisobjekt vor dem letzten Schub (Rückfall)
var seekActions = 0 // Zonen-Aktionen seit dem Laden, für den Suchlauf
var seekStatus = 'noch nicht gelaufen'
var lastSeekPass = -1000000
// Der Deck-Kanal war seit der Aktivierung einmal positioniert (oder die Suche gab
// auf). Bis dahin warten Abfrage und Tuner-Modus vom Deck (runPending).
var deckReady = false

function seekBusy() {
    return seekPhase !== SEEK_IDLE
}

/** Gemerktes TONE3000 und gemerkten Tuner vergessen; aufgelöst wird beim nächsten Bedarf. */
function forgetDeckObjects() {
    t3k = null
    t3kRecheck = false
    tuner = null
    tunerRecheck = false
}

/** Erster Platz der Such-Zone mit TARGET_TITLE, sonst -1. */
function inputPlace() {
    for (var i = 0; i < NUM_INPUTS; i++) {
        if (inputTitles[i] === TARGET_TITLE) return i
    }
    return -1
}

/** Alle Plätze der Such-Zone belegt: Dahinter kann es weitere Eingänge geben. */
function inputsFull() {
    for (var i = 0; i < NUM_INPUTS; i++) {
        if (!inputTitles[i]) return false
    }
    return true
}

/**
 * Basisobjekt des Deck-Kanals und sein Titel per DirectAccess: { base, title }; ein
 * leerer Platz meldet -1 und ''. Wirft der Host, gilt der Stand als unbekannt
 * (base wie vor dem letzten Schub, also "nicht bewegt").
 */
function deckHere(mapping) {
    try {
        var base = deckAccess.getBaseObjectID(mapping)
        if (typeof base !== 'number' || base < 0) return { base: -1, title: '' }
        return { base: base, title: hostText(deckAccess.getObjectTitle(mapping, base)) }
    } catch (e) {
        console.log('Deck: Basisobjekt nicht lesbar (' + e + ')')
        return { base: seekLastBase, title: '' }
    }
}

/**
 * Die Deck-Zone auf Platz place: mResetBank, dann place-mal mShiftRight. Die Phase
 * muss vorher stehen — die Callbacks können noch während der Aktionen kommen.
 */
function seekMoveTo(mapping, place) {
    forgetDeckObjects()
    seekMoved = true
    seekPlace = place
    seekLastBase = deckHere(mapping).base
    deckZone.mAction.mResetBank.trigger(mapping)
    for (var i = 0; i < place; i++) deckZone.mAction.mShiftRight.trigger(mapping)
    seekActions += place + 1
}

/**
 * Eine Runde: auf Platz place schieben (Such-Zone k, oder NUM_INPUTS für den
 * Rückfall), dann prüfen. Liefert false, wenn die Runden aufgebraucht sind (die
 * Suche ist dann beendet).
 */
function seekRound(activeDevice, mapping, phase, place) {
    if (seekRounds <= 0) {
        seekEnd(activeDevice, false, '"' + TARGET_TITLE + '" nach ' + SEEK_MAX_ROUNDS + ' Runden nicht erreicht (zuletzt Platz ' + seekPlace + ')')
        return false
    }
    seekRounds--
    seekPhase = phase
    seekWait = phase === SEEK_STEP ? SEEK_STEP_WAIT : SEEK_VERIFY_PASSES
    seekMoveTo(mapping, place)
    return true
}

/**
 * Ein Anlass: Stimmt der Deck-Kanal, fertig; sonst eine Runde zum Platz aus der
 * Such-Zone oder der Rückfall. Mitten in einer Suche (die Eingänge ändern sich
 * weiter) beginnt sie mit frischen Runden neu, aber höchstens SEEK_MAX_RESTARTS-mal:
 * So bleibt jede Suche begrenzt, was auch immer sie anstößt, und das Aufgeben selbst
 * schiebt nichts mehr, stößt also auch nichts mehr an.
 */
function seekStart(activeDevice, mapping) {
    if (seekBusy()) {
        seekRestarts++
        if (seekRestarts > SEEK_MAX_RESTARTS) {
            seekEnd(activeDevice, false, 'nach ' + SEEK_MAX_RESTARTS + ' neuen Anlässen in derselben Suche aufgegeben')
            return
        }
    } else {
        seekMoved = false
        seekRestarts = 0
        seekSteps = SEEK_MAX_STEPS
    }
    seekRounds = SEEK_MAX_ROUNDS
    // Steht er schon dort, nichts bewegen — auch wenn sein Titel noch aussteht.
    if (deckOnTarget(mapping)) {
        seekEnd(activeDevice, true, 'Deck-Kanal heißt "' + TARGET_TITLE + '"')
        return
    }
    var k = inputPlace()
    if (k >= 0) {
        seekRound(activeDevice, mapping, SEEK_VERIFY, k)
        return
    }
    if (!inputsFull()) {
        seekEnd(activeDevice, false, '"' + TARGET_TITLE + '" nicht unter den Eingängen')
        return
    }
    // Der Rückfall kann dauern: Abfrage und Tuner-Modus vom Deck nicht so lange
    // aufhalten. Findet er das Ziel, meldet sein Ende bit5, und das Deck fragt nach.
    if (seekRound(activeDevice, mapping, SEEK_STEP, NUM_INPUTS)) makeDeckReady(activeDevice)
}

/** Nach einer Runde: angekommen? Sonst warten, dann die nächste Runde. */
function seekVerify(activeDevice, mapping) {
    if (deckOnTarget(mapping)) {
        seekEnd(activeDevice, true, 'auf Platz ' + seekPlace + ' geschoben')
        return
    }
    seekWait--
    if (seekWait > 0) return
    var k = inputPlace()
    if (k < 0) {
        seekEnd(activeDevice, false, '"' + TARGET_TITLE + '" während der Suche aus der Such-Zone verschwunden')
        return
    }
    seekRound(activeDevice, mapping, SEEK_VERIFY, k)
}

/** Rückfall: je Durchgang prüfen und einen Platz weiter, bis Ziel oder Ende. */
function seekStepOn(activeDevice, mapping) {
    var here = deckHere(mapping)
    if (deckTitle === TARGET_TITLE || here.title === TARGET_TITLE) {
        seekEnd(activeDevice, true, 'Rückfall: auf Platz ' + seekPlace + ' gefunden, hinter der Such-Zone')
        return
    }
    if (here.base === seekLastBase) {
        // Nicht bewegt: am Ende der Liste, oder Nuendo ist noch nicht so weit.
        seekWait--
        if (seekWait > 0) return
        seekEnd(activeDevice, false, 'Rückfall: "' + TARGET_TITLE + '" bis zum Ende der Eingänge nicht gefunden')
        return
    }
    if (here.base < 0 || here.title === '') {
        seekEnd(activeDevice, false, 'Rückfall: "' + TARGET_TITLE + '" nicht gefunden, Platz ' + seekPlace + ' leer')
        return
    }
    seekSteps--
    if (seekSteps <= 0) {
        seekEnd(activeDevice, false, 'Rückfall: nach ' + SEEK_MAX_STEPS + ' Schritten aufgegeben')
        return
    }
    seekLastBase = here.base
    seekWait = SEEK_STEP_WAIT
    seekPlace++
    forgetDeckObjects()
    deckZone.mAction.mShiftRight.trigger(mapping)
    seekActions++
}

/** Angekommen: laut mOnTitleChange, oder laut Basisobjekt, solange der Titel aussteht. */
function deckOnTarget(mapping) {
    return deckTitle === TARGET_TITLE || deckHere(mapping).title === TARGET_TITLE
}

/**
 * Ende der Suche, gefunden oder nicht; sie ruht bis zum nächsten Anlass.
 *
 * Gefunden, aber der Titel-Callback steht noch aus: Der Name des Basisobjekts gilt
 * (wie die FaderBank Name und Farbe nach einem Wechsel per DirectAccess liest, weil
 * die Callbacks nachhinken). Sonst bliebe bit5 auf 0, bis Nuendo den Titel meldet —
 * oder für immer, falls es das beim Schieben nicht tut. Kommt er später, ist er
 * derselbe und ändert nichts.
 *
 * Ausstehendes vom Deck zuerst (ohne Dedup), danach der Bericht über den neuen Kanal
 * (mit Dedup, findet nach einer Abfrage also nichts Neues).
 */
function seekEnd(activeDevice, found, text) {
    var moved = seekMoved
    var adopted = found && deckTitle !== TARGET_TITLE
    seekPhase = SEEK_IDLE
    seekMoved = false
    if (adopted) deckTitle = TARGET_TITLE
    seekStatus = text + (adopted ? ' (Titel per DirectAccess)' : '')
    console.log('Deck: ' + seekStatus + (found ? '' : ', bit5 bleibt 0'))
    makeDeckReady(activeDevice)
    if (moved) {
        reportDeck(activeDevice)
    } else if (adopted && deckLive()) {
        guarded(activeDevice, 'Titel Deck-Kanal', function () {
            sendFlagsAndSync(activeDevice)
        })
    }
}

/**
 * Was der Deck-Kanal nach dem Schieben zeigt, mit Dedup: die Plugin-Namen der drei
 * Slots, das Zustandsbyte mit TONE3000 (Regler, Preset) und im Tuner-Modus die
 * Stimmanzeige. TONE3000 und Tuner werden dabei frisch aufgelöst — derselbe Weg wie
 * nach einem Objektwechsel.
 */
function reportDeck(activeDevice) {
    if (!deckLive()) return
    for (var s = 0; s < DECK_SLOTS; s++) sendSlotName(activeDevice, s, false)
    guarded(activeDevice, 'Deck-Kanal', function () {
        refreshT3k(activeDevice)
    })
    guarded(activeDevice, 'Deck-Kanal Tuner', function () {
        refreshTuner(activeDevice)
    })
}

/** Der Deck-Kanal gilt als positioniert: Ausstehendes vom Deck jetzt beantworten. */
function makeDeckReady(activeDevice) {
    if (deckReady) return
    deckReady = true
    runPending(activeDevice)
}

/**
 * Vor der Aktivierung oder vor der ersten Positionierung gemerkt: Tuner-Modus
 * zuerst — das Deck schickt ihn beim Verbinden vor seiner Abfrage, und deren 0x24
 * soll den neuen Stand zeigen —, dann die Abfrage.
 */
function runPending(activeDevice) {
    if (tunerModePending >= 0) {
        var wantTuner = tunerModePending === 1
        guarded(activeDevice, 'TUNER', function () {
            applyTunerMode(activeDevice, wantTuner)
        })
    }
    if (queryPending) {
        guarded(activeDevice, 'ABFRAGE', function () {
            runQuery(activeDevice)
        })
    }
}

/** Ein Durchgang: neuer Anlass zuerst, sonst die laufende Phase weiter. */
function seekPass(activeDevice, mapping) {
    if (seekReason) {
        seekReason = false
        seekStart(activeDevice, mapping)
    } else if (seekPhase === SEEK_VERIFY) {
        seekVerify(activeDevice, mapping)
    } else if (seekPhase === SEEK_STEP) {
        seekStepOn(activeDevice, mapping)
    }
}

/**
 * Leerlauf des Hosts. Ohne Anlass und ohne laufende Suche kehrt er sofort zurück —
 * er feuert sehr oft. Sonst gedrosselt auf SEEK_PASS_MS; performance.now() ist
 * vorhanden (FaderBank, Behringers X-Touch-Script). Eine Ausnahme beendet die Suche,
 * statt in jedem Durchgang neu zu werfen.
 */
page.mOnIdle = function (activeDevice, activeMapping) {
    if (!currentMapping || (seekPhase === SEEK_IDLE && !seekReason)) return
    var now = performance.now()
    if (now - lastSeekPass < SEEK_PASS_MS) return
    lastSeekPass = now
    var mapping = activeMapping || currentMapping
    var failed = true
    guarded(activeDevice, 'Deck-Suche', function () {
        seekPass(activeDevice, mapping)
        failed = false
    })
    if (failed) {
        guarded(activeDevice, 'Deck-Suche', function () {
            seekEnd(activeDevice, false, 'nach einem Fehler aufgegeben')
        })
    }
}

//------------------------------------------------------------------------------
// Aktivierung und Eingang
//------------------------------------------------------------------------------
// DirectAccess braucht ein activeMapping, das nur mOnActivate liefert; der
// Suchlauf kommt dagegen als SysEx herein, wo es fehlt — also wird es gemerkt.
var currentMapping = null

// Beim Aktivieren an sich wird nichts gesendet; Callbacks, die der Host mitten
// darin auslöst, merken nur (activating). Ein gemerktes TONE3000 und ein gemerkter
// Tuner gelten danach nicht mehr, und die Deck-Suche prüft im nächsten Leerlauf, ob
// der Deck-Kanal stimmt. Einzige Ausnahmen beim Senden: die Antwort auf eine
// Abfrage und auf ein 0x13, die vor der Aktivierung kamen und deshalb noch
// ausstehen — aber nur, wenn der Deck-Kanal schon richtig steht (etwa "Mono In 6"
// als einziger Eingang, Platz 0). Sonst beantwortet sie das Ende der ersten Suche.
//
// Liefert Nuendo die Startwerte (Titel, Mute, Fenster) erst NACH mOnActivate über
// die Callbacks, sind das Änderungen wie jede andere und gehen unverlangt hinaus.
// Das Deck darf deshalb nicht annehmen, vor seiner Abfrage käme nichts.
//
// Bewusst NICHT: nach einer erneuten Aktivierung von sich aus nachlesen und
// Abweichungen melden. Das wäre Senden beim Aktivieren an sich; das Deck fragt
// stattdessen regelmäßig ab (docs/protokoll.md 4.4).
page.mOnActivate = function (activeDevice, activeMapping) {
    currentMapping = activeMapping
    activating = true
    try {
        deckAccess.activate(activeMapping)
        for (var i = 0; i < NUM_INPUTS; i++) inputAccess[i].activate(activeMapping)
    } catch (e) {
        console.log('Aktivierung Fehler: ' + e)
    } finally {
        activating = false
    }
    forgetDeckObjects()
    seekReason = true
    if (deckTitle === TARGET_TITLE) deckReady = true
    if (deckReady) runPending(activeDevice)
    console.log('TONE3000 Remote aktiv')
}

midiInput.mOnSysex = function (activeDevice, message) {
    if (message.length < 4 || message[1] !== MANUFACTURER_ID) return

    if (message[2] === MSG_PING) {
        midiOutput.sendMidi(activeDevice, [0xF0, MANUFACTURER_ID, MSG_PING, 0xF7])
        return
    }

    // Auch der Suchlauf endet IMMER mit seiner Schlusszeile: Ohne sie wartet das
    // Werkzeug 30 s und lässt danach alle Aktionen aus. runProbe schreibt sie im
    // Normalfall selbst als letzte Zeile, im catch kommt sie also nur einmal.
    if (message[2] === MSG_PROBE) {
        if (!currentMapping) {
            line(activeDevice, 'Suchlauf abgebrochen: noch kein activeMapping (Seite nie aktiviert)')
            line(activeDevice, '--- Suchlauf beendet ---')
            return
        }
        try {
            var title = message.length > 4 ? decodeHexText(message, 3, message.length - 1) : TARGET_TITLE
            runProbe(activeDevice, currentMapping, title)
        } catch (e) {
            line(activeDevice, 'Suchlauf Fehler: ' + e)
            line(activeDevice, '--- Suchlauf beendet ---')
        }
        return
    }

    if (message[2] === MSG_WATCH_ON) {
        startWatch(activeDevice)
        return
    }

    if (message[2] === MSG_WATCH_OFF) {
        stopWatch(activeDevice)
        return
    }

    // Setzen endet IMMER mit SET_END, auch nach einer Ausnahme des Hosts —
    // das Werkzeug wartet auf diese Zeile.
    if (message[2] === MSG_SET) {
        try {
            var setProblem = payloadProblem(message)
            if (setProblem) {
                line(activeDevice, 'SETZEN abgelehnt: ' + setProblem)
            } else {
                runSet(activeDevice, currentMapping, decodeHexText(message, 3, message.length - 1))
            }
        } catch (e) {
            line(activeDevice, 'SETZEN Fehler: ' + e)
        }
        line(activeDevice, SET_END)
        return
    }

    if (message[2] === MSG_COMMAND) {
        try {
            var commandProblem = payloadProblem(message)
            if (commandProblem) {
                line(activeDevice, 'BEFEHL abgelehnt: ' + commandProblem)
            } else {
                runCommand(activeDevice, currentMapping, decodeHexText(message, 3, message.length - 1))
            }
        } catch (e) {
            line(activeDevice, 'BEFEHL Fehler: ' + e)
        }
        return
    }

    // Protokoll 3: Betrieb fürs Stream Deck
    if (message[2] === MSG_QUERY) {
        try {
            runQuery(activeDevice)
        } catch (e) {
            line(activeDevice, 'ABFRAGE Fehler: ' + e)
        }
        return
    }

    if (message[2] === MSG_PARAM_SET) {
        try {
            runParamSet(activeDevice, message)
        } catch (e) {
            line(activeDevice, 'TONE3000 setzen Fehler: ' + e)
        }
        return
    }

    if (message[2] === MSG_PRESET_SET) {
        try {
            runPresetSet(activeDevice, message)
        } catch (e) {
            line(activeDevice, 'Preset Fehler: ' + e)
        }
        return
    }

    // Protokoll 4: Stimmanzeige
    if (message[2] === MSG_TUNER_MODE) {
        try {
            runTunerMode(activeDevice, message)
        } catch (e) {
            line(activeDevice, 'TUNER Fehler: ' + e)
        }
    }
}
