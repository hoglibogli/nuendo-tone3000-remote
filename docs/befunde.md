# Befunde aus den Suchläufen

Rohdaten in `suchlauf/`. Stand 2026-10-01, TONE3000 0.0.7, Nuendo 15; Nachträge 2026-10-02
(Tuner) und 2026-10-06 (Platz von Input 6).

## Input 6

- In der MixConsole heißt er **„Mono In 6"**, Typ `InputChannel`. In einer reinen
  Eingangszone (`includeInputChannels()`, ohne `setFollowVisibility`) lag er im Projekt
  vom 2026-10-01 auf **Platz 6**; Platz 0 ist „Stereo In 1-2". Belegt über die
  Mute-Gegenprobe.
- **2026-10-06: Der Platz gehört zum Projekt.** Im aktuellen Projekt gibt es nur einen
  Eingangskanal, „Mono In 6", also auf **Platz 0** („1 von 32 Plätzen belegt",
  `suchlauf/2026-10-06_114528.txt`; Basis id=2066, Slot 1 leer, Slot 2 H-Delay Mono,
  Slot 3 TONE3000 auf „Matchless"). Das Script band fest an Platz 6: bit5 = 0, das Deck
  zeigte „Kanal?". Seitdem folgt der Betrieb dem Namen über eine eigene Zone mit einem
  Platz (`docs/protokoll.md` 4.7). Das Basisobjekt per DirectAccess trägt den Kanalnamen
  (Titel „Mono In 6", Parameter 1024 „Name") — daran erkennt die Suche das Ziel, auch wenn
  der Titel-Callback nachhinkt.
- **2026-10-06, am Gerät bestätigt:** Nach dem Ausrollen stand „Mono In 6" in einem
  Projekt auf **Platz 5**; die Deck-Suche schob die Ein-Platz-Zone mit `mResetBank` und
  fünfmal `mShiftRight` dorthin — 6 Zonen-Aktionen seit dem Laden, danach Ruhe, bit5 = 1,
  Deck in Betrieb (`suchlauf/2026-10-06_142037.txt`). Damit sind Zonen-Aktionen per
  `trigger()` aus `page.mOnIdle` und die Unabhängigkeit der beiden Zonen am Gerät belegt.
- Objekt-IDs: Die Rohdaten belegen nicht, dass zwei DirectAccess-Objekte dieselbe ID für
  dasselbe Objekt liefern — jeder Lauf las über genau eines, und die IDs wechseln zwischen
  Nuendo-Sitzungen (Basis 1881/1895/1917/…/2066). Die FaderBank vergleicht sie mit Erfolg
  über verschiedene Kanalzüge (ihre E-19). Der Suchlauf liest den Zielkanal deshalb über
  dasselbe DirectAccess-Objekt, an dem die Beobachtung hängt (den Deck-Kanal).
- **Mute** lässt sich über `mValue.mMute` lesen (Value-Binding, Callback am
  SurfaceValue). DirectAccess führt ihn als Tag 1027 am Kanal.
- In der Beobachtung tauchte kein Mute-Wechsel auf — ob er nicht umgeschaltet
  wurde oder Kanalparameter dort nicht ankommen, ist offen. Für den Bau egal:
  Mute läuft über `mValue.mMute`.

## Insert-Slots

Je Slot ein Objekt mit eigenen Parametern: `4098 On`, `4101 Edit`, `4102 Bypass`,
`4125 Effect Type` (= Plugin-Name), `4103 Input MIDI Signal`. Das Plugin ist das
einzige Kind des Slots.

- **Slot 1:** GTR Tuner Mono
- **Slot 2:** **H-Delay Mono** (Waves). Bypass am Plugin als Tag 10004202,
  „On"/„Off", in der Beobachtung sauber gemeldet.
- **Slot 3:** **TONE3000**

## TONE3000

2116 Parameter, davon **2080 „MIDI CC"-Platzhalter** (JUCE, 16 Kanäle × 130) —
es bleiben 36 echte. Die für das Deck:

| Titel | Tag | Klartext | Bereich laut Hersteller |
| --- | --- | --- | --- |
| inputLevel | 1368699459 | 0..1 roh („0.5000") | ±24 dB |
| toneBass | 1128262618 | „5.00" | 0..10 |
| toneMid | 1006241759 | „5.00" | 0..10 |
| toneTreble | 307695311 | „5.00" | 0..10 |
| outputLevel | 1305090924 | 0..1 roh | ±24 dB |
| gateThreshold | 1425407049 | „-94.58" | -100..0 dB |
| gateEnabled | 637074527 | On/Off | |
| toneEqEnabled | 415433740 | On/Off | |
| Bypass | 1652130012 | On/Off | |

Tags sind Hashes der JUCE-Parameter-IDs; trotzdem über den Titel suchen.

**In 0.0.7 sind Presets kein Host-Parameter.** Unter den 36 ist keine Programm-
oder Presetauswahl; `getNumPrograms()` liefert dort 1, und JUCE legt den
Parameter „Program" erst ab zwei Programmen an. Deshalb war auch der
Program-Change-Test über die MIDI-Spur wirkungslos. Ein Presetwechsel im Plugin
meldet einmal **alle** Parameter auf einen Schlag — erkennbar, dass gewechselt
wurde, aber nicht wohin.

**Ab TONE3000 0.0.9 gibt es 128 Host-Programme.** Bug
[#38](https://github.com/tone-3000/tone3000-plugin/issues/38) ist am 2026-09-14
geschlossen („fixed in v0.0.9", vom Melder in Cubase 12 bestätigt). Programm n
ist das n-te Preset der Liste: eigene alphabetisch, dann Werkspresets — also
1 Calfinornia, 2 Einstein Halbgas, 3 Einstein Vollgas, 4 HMT, 5 JCM 2000,
6 Matchless, 7 Vox AC 30. JUCE legt dafür den Parameter „Program" an
(kIsProgramChange, 0..127, Klartext = Presetname), hinter den echten und vor den
MIDI-CC-Parametern. Erwarteter Tag 1886553053 (VST3-ID 'prst' + 4201 — diese
Verschiebung gilt für alle Tags hier). In Nuendo 15 noch ungeprüft:
ob DirectAccess ihn listet und `setParameterProcessValue` ihn schreibt.
Kanten: Programm 1 wird auf einer Instanz ohne aktives Preset verschluckt; ein
erneuter Druck auf das aktive Preset lädt nicht neu. Auf GitHub ist 0.0.11 vom
2026-10-01 die neueste (frisch, große Umbauten); die TONE3000-Website scheint
aber nur 0.0.9 anzubieten (Vincent, 2026-10-01). Für die Prüfung genügt 0.0.9:
„Program" gibt es ab dort. 0.0.7 verwirft State neuerer Fassungen —
vor dem Update Projekt und `TONE3000.vst3` sichern.

**Weitere Wege, alle am Gerät ungeprüft:**
- Die 2080 „MIDI CC c|n"-Parameter sind JUCEs Brücke für MIDI-Controller: Kommt
  eine Änderung im Prozessor an, wird daraus CC n auf Kanal c+1. TONE3000 kann
  „Next/Previous Preset" auf einen CC lernen. Offen ist, ob Nuendo per DirectAccess
  gesetzte Werte dieser Parameter (Flags 0) an den Prozessor weiterreicht. Nur
  schrittweise, ohne Rückmeldung; Bypass am Slot schneidet MIDI ab; geladene
  .vstpresets löschen die Mappings.
- Nuendo hat die Kategorie **„Preset" mit den Befehlen „Next", „Previous",
  „Open Browser"** (Key Commands.xml, Remote-Befehlstabelle). Die erste Suche hat
  sie übersehen, weil nur „Preset" im Kategorienamen steht. Blättert durch
  .vstpresets im Fenster mit Fokus — nicht gezielt auf Slot 3.

Eigene Presets (Dateien in `%APPDATA%\TONE3000\Presets`): JCM 2000, Calfinornia,
Vox AC 30, Einstein Vollgas, Einstein Halbgas, Matchless, HMT.

## Tuner (2026-10-02)

Frage: Lässt sich eine Stimmanzeige aufs Deck bringen?

- **Waves GTR Tuner: nein.** Beobachtung mit offenem Fenster und angeschlagenen
  Saiten: 0 Parameteränderungen (suchlauf/2026-10-02_123001.txt). In seiner
  GUI-Beschreibung (`Waves\Plug-Ins V16\GTRTuner.bundle\…\GUIXML\1000.xml`) ist kein
  Control für den Host freigegeben; die Nadel ist ein reiner Anzeigewert.
- **TONE3000-Tuner: nein.** Laut Quelltext 0.0.11 läuft der `TunerDetector` nur bei
  sichtbarem Tuner-Bildschirm und liefert nur an die eigene Oberfläche
  (`Processor.h`, `getTunerReading()`); kein MIDI-Ausgang (`producesMidi()` = false).
- **Steinberg „Tuner" (Nuendo Plug-in Set): ja.** Er legt seine Messwerte als
  schreibgeschützte Parameter an (Steinbergs eigene Remote-Beschreibung
  `VST XMLs\Tuner\Generic 8 Cells.xml`, für Nuage-Hardware). DirectAccess listet sie,
  und `mOnParameterChange` meldet sie live (suchlauf/2026-10-02_125415.txt):

  | Titel | Tag | Bereich | Klartext |
  | --- | --- | --- | --- |
  | Mute | 4201 | Schalter, schaltet den Ausgang des Tuners | „Off" |
  | Frequency | 4202 | 0..4000 Hz | „82.7" |
  | Note | 4203 | 0..89 | „E " (mit Leerzeichen), Stille „--" |
  | Cent | 4204 | -50..50 | „-16" |
  | Oct | 4205 | | „1", Stille leer |
  | Locked | 4209 | Schalter | On, solange ein Ton erkannt ist |
  | In Tune | 4210 | Schalter | flackert nahe der Mitte |
  | Base | 4211 | 425..455 Hz | „440.0" |

  Rate: Cent 377 Änderungen, Frequenz 72, Note/Oktave/Locked je 16 (8 Anschläge)
  in rund einer Minute Spielzeit — Cent etwa 10 je Sekunde. Auch der Slot-Parameter
  4101 Edit (Fenster) kam diesmal als Änderung an.

## Betrieb

- Nach einem beendeten Lauf (Ports geschlossen) antwortete Nuendo sieben Minuten
  später erneut, ohne Neustart. Die FaderBank-Lehre „Plugin-Prozess stirbt →
  Nuendos Ausgang tot" hat sich hier nicht gezeigt.
- Nach einer Script-Änderung antwortet ohne Nuendo-Neustart die alte Fassung.
