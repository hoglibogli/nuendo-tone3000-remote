# Nuendo TONE3000 Remote

Stream-Deck-Steuerung für **Input 6** in Nuendo 15, getrennt von der FaderBank:

- **TONE3000** in Insert-Slot 3: Input Level und EQ auf den Drehreglern des
  Stream Deck + XL, TONE3000-eigene Presets auf Tasten (über Nuendo-Presets
  als Rückfall)
- **Delay** in Insert-Slot 2: Bypass an/aus
- **Mute** von Input 6

Eigenes Portpaar (Basic Loopback der Windows MIDI Services), eigenes
Nuendo-Script, eigenes Stream-Deck-Plugin. Ein Neustart dieser Strecke lässt die
FaderBank unberührt.

```
Stream Deck  ──sd_tone3000──►  Nuendo-Script Vincent_Tone3000
             ◄──tone3000_sd──
```

Die Betriebsregeln aus dem FaderBank-Projekt gelten hier unverändert, vor allem:
**erst Nuendo, dann das Plugin**, und nach jeder Script-Änderung Nuendo neu
starten statt „Skript neu laden". Hintergrund steht dort in
`docs/entscheidungen.md` und `docs/erbe-trackinfo.md`.

## Stand

**Schritt 1: Suchlauf** — erledigt. Auf Anfrage listet das Script die
Eingangskanäle, die Insert-Slots von Input 6 und alle Parameter von Delay und
TONE3000. Befunde in `docs/befunde.md` (Stand 0.0.7); der Lauf mit TONE3000 0.0.11
(`suchlauf/2026-10-01_234944.txt`) zeigt Gain, EQ und „Program" als Host-Parameter,
und ein Preset lässt sich per Namen wählen.

**Schritt 2: Betrieb (Protokoll 3)** — im Script gebaut und gegen die nachgebaute API
getestet, am Gerät noch nicht. Das Stream-Deck-Plugin fehlt noch.

## Betrieb mit dem Stream Deck

Das Script nimmt vom Deck Regler (Gain, Bass, Mid, Treble von TONE3000), Presets per
Namen und Tasten (Mute, Delay-Bypass, Fenster von Tuner, Delay und TONE3000) an und
meldet Werte, Presetnamen, Zustände und Plugin-Namen zurück. Ab Protokoll 4 dazu eine
Stimmanzeige: Im Tuner-Modus des Decks schaltet es den Ausgang von Steinbergs „Tuner" in
Slot 1 stumm und reicht Note, Oktave und Cent weiter (`docs/protokoll.md` Abschnitt 5).
Ab Protokoll 5 die Kette: Verlässt das Deck den Tuner-Modus, lädt das Script H-Delay Mono
in Slot 2 (im Bypass) und TONE3000 in Slot 3, falls sie fehlen — ein anderes Plugin dort
wird ersetzt —, und das Deck holt danach das zuletzt aktive Preset zurück
(`docs/protokoll.md` Abschnitt 6).
Das vollständige
Protokoll — Bytes, Bits, Kodierung, Grenzen, Beispielsitzung — steht in
[`docs/protokoll.md`](docs/protokoll.md); das Plugin wird genau dagegen gebaut.

Wichtig fürs Deck: Nach dem Pong erst den eigenen Tuner-Modus schicken (`F0 7D 13 00 F7`
beim Start — hebt eine liegengebliebene Tuner-Mute auf), dann mit `F0 7D 10 F7` abfragen
und im Leerlauf regelmäßig wieder. Meldet eine Antwort danach eine Tuner-Mute ohne Modus
(0x24 mit bit2 = 0, bit4 = 1), schickt das Deck einmal `F0 7D 13 00 F7` (`docs/protokoll.md`
5.5). Unverlangt sendet das Script nur Änderungen, die Nuendo meldet, und
das jederzeit, auch vor der ersten Abfrage. Nach einem gedrehten Regler kommt
womöglich keine Rückmeldung. Den Klartext rechnet das Deck dann selbst aus. Regler und
Presets wirken nur, wenn der Deck-Kanal „Mono In 6" heißt (bit5) und TONE3000 in Slot 3
steckt (bit6). Die genauen Regeln stehen in `docs/protokoll.md` 4.4.

**Der Betrieb folgt „Mono In 6" über den Namen** (seit 2026-10-06, `docs/protokoll.md` 4.7):
Eingangskanäle gehören zum Projekt; im aktuellen ist „Mono In 6" der einzige Eingang
(Platz 0), früher lag er auf Platz 6. Alles hängt an einer eigenen Zone mit einem Platz,
die das Script im Leerlauf dorthin schiebt, wo „Mono In 6" steht — auch nach Einfügen,
Löschen oder Umbenennen von Eingängen. Fehlt der Kanal, bleibt bit5 = 0, und nichts wird
dauernd verschoben. Der Suchlauf zeigt den Stand in der Zeile `Deck-Kanal: …`.

Test ohne Nuendo und ohne MIDI-Ports: `node test/script.test.cjs` — prüft Protokoll 2
bis 4 und die Deck-Suche gegen eine nachgebaute API (änderbare Eingangsliste,
verschiebbare Zonen, Leerlauf mit simulierter Zeit), lässt `tools/suchlauf.cjs` über ein
Portpaar im Speicher laufen und spielt die Beispielsitzung aus `docs/protokoll.md` nach.

## Eigenes Stimmgerät

Vorgabe an der Tuner-Taste ist der **eigene Tuner** im Stream-Deck-Plugin; Steinbergs
„Tuner" in Slot 1 bleibt als wählbare Quelle. Der eigene Tuner liest den Gitarreneingang
direkt am Audio-Interface mit, an Nuendo vorbei: WASAPI im geteilten Modus, genau ein
Mono-Kanal (Vorgabe MADI 6 aus dem Windows-Paar „MADI (5+6)"). RME erlaubt das parallel
zu Nuendos ASIO; das Paar muss in den RME-Einstellungen unter „WDM Devices" freigegeben
sein. Er läuft in einem eigenen Kindprozess (`bin/tuner-worker.js`), solange die
Tuner-Taste auf dem Deck liegt (oder der Tuner-Modus an ist); ein Absturz dort berührt
die MIDI-Verbindung nicht.

Tuner-Taste: Sie zeigt die Stimmanzeige immer. Ein kurzer Druck schaltet den Tuner-Modus
(beim Loslassen): große Anzeige in der Touch-Leiste, Regler ruhen, Input 6 stumm, heller
Rahmen. Ein langer Druck ab 0,5 s schaltet die automatische Stummschaltung von Input 6
(Setting `muteChannel`, Vorgabe an). Roter statt goldener Rahmen heißt: Stummschaltung
an. Beim Ausschalten des Modus wird Input 6 immer wieder offen geschaltet, und das Script
lädt H-Delay Mono (Slot 2) und TONE3000 (Slot 3) nach, falls sie fehlen; die Taste zeigt
dann ein Häkchen, bei einem Fehler ein Warndreieck.

Verfahren (`streamdeck-plugin/src/tuner`): YIN findet die Note (zwei Fenster, 26 Hz bis
1,4 kHz, Oktavprüfung für Bass), danach verfolgt ein schmalbandiger Heterodyn-Empfänger
Grundton und Obertöne wie ein Strobe-Tuner; Schwellen nur relativ zum Rauschen. Ist der
Ton verklungen, bleibt die Anzeige 3 s gedimmt stehen. Notennamen englisch (B), Kammerton
einstellbar.

Gemessen an `aufnahmen/saiten-1.wav` (Gitarre über MADI 6, Anschläge -21…-30 dBFS,
Rauschen -106 dBFS): hohe E 7,5–24,8 s verfolgt, ein Tuner mit fester Schwelle bei
-55 dBFS hält sie 0,5–2 s; Anzeige nach 0,1–0,13 s; Rechenlast etwa 1 % eines Kerns.

Ansprechen (2026-10-08, gemessen an `aufnahmen/schnell-gitarre.wav`, Saiten im
Halbsekundentakt): Nach einem Anschlag steht die neue Note nach etwa 50 ms gedimmt
(Vorschau aus Stufe 1), der gemessene Wert nach etwa 100 ms (90 % binnen 120 ms); beim
Saitenwechsel bleibt die alte Note gedimmt stehen, kein „--“ dazwischen. Ohne Anschlag
(Griffgeräusche) gelten weiter die strengen Regeln, damit keine Phantomnote erscheint.
Beim 5-Saiter (`aufnahmen/schnell-bass.wav`) gilt das für D und G genauso; B, E und A
sinken nach einem kräftigen Anschlag in 0,4 s um 15–25 Cent ab, der genaue Wert steht dort
erst, wenn die Tonhöhe ruhig ist (die Note gedimmt schon nach etwa 90 ms). Weicher
anschlagen und knapp eine Sekunde klingen lassen hilft.

Werkzeuge: `node tools/audio-probe.cjs` (Eingänge, Pegel, Aufnahme als WAV),
`node tools/tuner-eval.cjs datei.wav` (Zeitleiste und Tabelle je Anschlag) und
`node tools/ansprech-eval.cjs datei.wav` (Ansprechzeit je Anschlag, Lücken, Fehlnoten).

**Falle:** Stream Deck startet Plugins mit seinem eigenen Node 20. Die im npm-Paket
audify mitgelieferte Binärdatei stürzte darunter ab (0xC0000005), unter Node 24 lief sie.
`postinstall` holt deshalb die Fassung für N-API 9 (`npm run fix:audify`), und
`npm test` prüft das Laden mit Stream Decks Node.

## Suchlauf ausführen

1. Script ausrollen nach
   `%USERPROFILE%\Documents\Steinberg\Nuendo\MIDI Remote\Driver Scripts\Local\Vincent\Tone3000\Vincent_Tone3000.js`
   (Dateiname muss den beiden Elternordnern entsprechen).
2. Nuendo neu starten, Projekt mit Input 6 laden. Im MIDI Remote Manager muss
   „Tone3000" mit `sd_tone3000` / `tone3000_sd` erscheinen.
3. `node tools/suchlauf.cjs` — Ausgabe landet in `suchlauf/<Zeit>.txt`.
   Mit `--beobachten 900` schreibt es danach bis zu 15 Minuten jede
   Parameteränderung an Input 6 mit; die Datei `suchlauf/stopp` beendet das
   vorzeitig.

Nach einer Script-Änderung muss Nuendo neu starten — sonst antwortet weiter die
alte Fassung (am 2026-10-01 genau so passiert: der Lauf kam, aber vom alten
Script). Die erste Zeile des Laufs nennt die Protokollfassung, etwa
`--- Suchlauf TONE3000 Remote, Protokoll 5, Ziel "Mono In 6" ---`. Fehlt sie oder
steht dort weniger als 2, läuft noch eine alte Fassung; das Werkzeug lässt dann alle
Aktionen aus und meldet „Script veraltet". Für das Deck braucht es Protokoll 3, für die Stimmanzeige 4, für die Kette 5.

## Presetwechsel prüfen (TONE3000 ab 0.0.9)

Nach dem Suchlauf kann das Werkzeug Aktionen ausführen; die Beobachtung läuft
dabei automatisch mit, jede Aktion beginnt in der Datei mit `>>>`:

```
node tools/suchlauf.cjs --setzen "3;Program;plain;2" --setzen "3;Program;plain;4"
node tools/suchlauf.cjs --puls "3;MIDI CC 0|20"
node tools/suchlauf.cjs --befehl next --befehl next/taste --befehl next/note
```

Vor `--befehl` in Nuendo das TONE3000-Fenster von Slot 3 öffnen und hineinklicken,
erst dann starten: Preset/Next, Previous und Open Browser wirken auf das
Plugin-Fenster mit Fokus. Ohne Fenster kann auch ein richtiger Befehlsname
`canPerform=false` melden. Maßgeblich ist die BEFEHL-Zeile zum Auslösezeitpunkt.
`next/note` schickt eine echte Note (Kanal 2), wie die FaderBank ihre Befehle
auslöst; nur dieser Weg ist belegt. Alle Optionen stehen im Kopfkommentar von
`tools/suchlauf.cjs`.
