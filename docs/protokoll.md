# Protokoll Stream Deck ↔ Nuendo (TONE3000 Remote)

Stand: **Protokoll 4**, 2026-10-02; seit 2026-10-06 folgt der Betrieb dem Kanal
„Mono In 6" über seinen Namen statt über Platz 6 ([4.7](#47-deck-kanal-folgt-dem-namen)),
die Bytes sind dieselben. Gegenstück ist das Nuendo-Script
`nuendo-script/Vincent_Tone3000.js` (`PROTOCOL_VERSION = 4`). Das Stream-Deck-Plugin
wird gegen diese Datei gebaut; ändert sich das Script, ändert sich diese Datei mit.
Die Beispielsitzung in [Abschnitt 8](#8-beispielsitzung) spielt `node test/script.test.cjs`
Byte für Byte gegen das Script nach.

Protokoll 3 = Protokoll 2 (Suchlauf, unverändert) + Betrieb fürs Stream Deck. Protokoll 4
= Protokoll 3 (unverändert) + Stimmanzeige ([Abschnitt 5](#5-stimmanzeige-protokoll-4)):
`0x13` herein, `0x24` hinaus, und die Abfrage `0x10` endet mit einem `0x24`. Alles läuft
über dasselbe Portpaar und dieselben Rahmen; die Typbytes überschneiden sich nicht.

## 1 Verbindung

| Richtung | Portname | Das Deck … |
| --- | --- | --- |
| Deck → Nuendo | `sd_tone3000` | öffnet ihn als **Ausgang** und sendet hinein |
| Nuendo → Deck | `tone3000_sd` | öffnet ihn als **Eingang** und liest |

Basic Loopback der Windows MIDI Services, benannt aus Sicht von Nuendo. Portnamen
**exakt** vergleichen — beide enthalten „tone3000", ein Teilstring wäre mehrdeutig.

Das Werkzeug `tools/suchlauf.cjs` benutzt dasselbe Paar. Läuft es neben dem Deck, sieht
das Deck auch dessen Debugzeilen, und das Werkzeug sieht die Betriebsframes (es übergeht
sie). Beides ist harmlos.

## 2 Rahmen und Kodierung

### 2.1 SysEx-Rahmen

Jede Nachricht außer den Noten ist ein SysEx-Frame:

```
F0 7D <Typ> <Daten …> F7
```

- `7D` ist die Hersteller-ID „non-commercial". Frames mit anderer ID oder unbekanntem
  Typ werden **auf beiden Seiten still übergangen**.
- **Jedes Datenbyte ist kleiner als 0x80** (7 Bit), in beide Richtungen.

### 2.2 Text

Text ist **UTF-8, jedes Byte als zwei ASCII-Hex-Ziffern** (`0`–`9`, `A`–`F`). Das
Script sendet Großbuchstaben und nimmt auch Kleinbuchstaben an.

| Text | UTF-8 | im Frame |
| --- | --- | --- |
| `HMT` | `48 4D 54` | `34 38 34 44 35 34` (ASCII „484D54") |
| `5.00` | `35 2E 30 30` | `33 35 32 45 33 30 33 30` |
| `Ä` | `C3 84` | `43 33 38 34` |
| leer | — | keine Bytes |

Eingehender Text in 0x05, 0x06 und 0x12 mit ungerader Hexlänge, fremden Zeichen oder
ohne abschließendes `F7` wird abgelehnt (Debugzeile), nicht geraten. (0x02 prüft nicht;
das Werkzeug schickt dort nur geprüften Text.)

Das Script kodiert und dekodiert UTF-8 **bis 4 Byte je Zeichen**, also auch Emoji: Ein
Presetname wie `Lead 🔥` (`… F0 9F 94 A5`) kommt als 0x21 heraus und lässt sich mit
denselben Bytes per 0x12 wählen. Ungültige Folgen (etwa ein Lead-Byte ohne
Fortsetzungsbytes) werden beim Dekodieren still ausgelassen.

### 2.3 14-Bit-Werte

Reglerwerte sind 14 Bit, als zwei Datenbytes, höherwertiges zuerst:

```
Wert = v1 · 128 + v0          0 … 16383
v1   = Wert >> 7              v0 = Wert & 0x7F
```

| Richtung | Umrechnung |
| --- | --- |
| Deck → Nuendo (0x11) | normiert = Wert / 16383 (0 → 0,0; 16383 → 1,0) |
| Nuendo → Deck (0x20) | Wert = round(normiert · 16383), auf 0 … 16383 begrenzt |

**Mitte ist 8192** (`v1 = 0x40`, `v0 = 0x00`), normiert 0,50003 — hörbar nicht von
0,5 zu unterscheiden; der Host zeigt dafür „5.00" (EQ) bzw. „0.5000" (Gain). Ein vom
Host gemeldetes 0,5 kommt als 8192 zurück.

### 2.4 Längen

| Frame | Text höchstens | Frame höchstens |
| --- | --- | --- |
| 0x20 Klartext | 32 Byte UTF-8 | 71 Byte |
| 0x21 Presetname | 100 Byte | 204 Byte |
| 0x23 Plugin-Name | 100 Byte | 205 Byte |
| 0x24 Note | 8 Byte | 23 Byte |
| 0x7F Debugzeile | 100 Byte je Frame | 204 Byte |
| Text zum Script (0x02, 0x05, 0x06, 0x12) | 100 Byte | 204 Byte |

Längerer Text vom Script wird **an einer Zeichengrenze gekürzt**, nie mitten in einem
UTF-8-Zeichen. **Kein Frame ist länger als 205 Byte.** Längere Frames zum Script sind
am Loopback nicht erprobt; das Deck schickt keine.

## 3 Alle Nachrichten auf einen Blick

| Bytes | Richtung | Bedeutung | Fassung |
| --- | --- | --- | --- |
| `F0 7D 01 F7` | ↔ | Ping, Antwort identisch | 2 |
| `F0 7D 02 [Text] F7` | → Nuendo | Suchlauf | 2 |
| `F0 7D 03 F7` / `04` | → Nuendo | Beobachtung an / aus | 2 |
| `F0 7D 05 <Text> F7` | → Nuendo | Parameter setzen (Werkzeug) | 2 |
| `F0 7D 06 <Text> F7` | → Nuendo | Nuendo-Befehl auslösen (Werkzeug) | 2 |
| `90 <n> <vel>` | → Nuendo | Kanal 1: Mute von Platz n (nicht vom Deck benutzen) | 2 |
| `91 <n> <vel>` | → Nuendo | Kanal 2: Preset-Befehl n | 2 |
| `F0 7D 10 F7` | → Nuendo | **Abfrage** | 3 |
| `F0 7D 11 <p> <v1> <v0> F7` | → Nuendo | **TONE3000-Regler setzen** | 3 |
| `F0 7D 12 <Name> F7` | → Nuendo | **Preset per Namen wählen** | 3 |
| `F0 7D 13 <m> F7` | → Nuendo | **Tuner-Modus an/aus** | 4 |
| `92 <n> <vel>` | → Nuendo | **Kanal 3: Taste n, Zielzustand** | 3 |
| `F0 7D 20 <p> <v1> <v0> <Klartext> F7` | → Deck | **Reglerwert** | 3 |
| `F0 7D 21 <Name> F7` | → Deck | **aktives Preset** | 3 |
| `F0 7D 22 <flags> F7` | → Deck | **Zustände** | 3 |
| `F0 7D 23 <s> <Name> F7` | → Deck | **Plugin-Name in Slot s** | 3 |
| `F0 7D 24 <flags> <cent> <oct> <Note> F7` | → Deck | **Stimmanzeige** | 4 |
| `F0 7D 7F <Text> F7` | → Deck | Debugzeile | 2 |

## 4 Betrieb (Protokoll 3)

Gesteuert wird **Input 6**, der Eingangskanal, der in der MixConsole „Mono In 6" heißt —
gleich, auf welchem Platz er steht. Eingangskanäle gehören zum Projekt; im Projekt vom
2026-10-01 lag er auf Platz 6, in dem vom 2026-10-06 ist er der einzige Eingang (Platz 0).
Alle Bindungen des Betriebs hängen am **Deck-Kanal**, einer eigenen Zone mit einem Platz,
die das Script auf „Mono In 6" schiebt (4.7). Ob er dort steht, sagt bit5 von 0x22. Auf
dem Deck-Kanal erwartet es:

| Slot (Nuendo) | s / Note | Plugin | Was das Deck damit tut |
| --- | --- | --- | --- |
| 1 | s = 0, Note 1 | Tuner (Steinberg) | Fenster auf/zu; Stimmanzeige (5) |
| 2 | s = 1, Note 2 und 3 | H-Delay Mono | Bypass an/aus, Fenster auf/zu |
| 3 | s = 2, Note 4 | TONE3000 | Fenster auf/zu, Regler p 0–3, Presets |
| — | Note 0 | Kanal selbst | Mute |

### 4.1 Deck → Nuendo

#### `F0 7D 10 F7` — Abfrage

Das Script antwortet **ohne Dedup** mit allem, in genau dieser Reihenfolge:

1. `0x20` für p = 0, 1, 2, 3 — **nur für Regler, die sich lesen lassen**. Fehlt
   TONE3000 in Slot 3 (bit6 = 0) oder ein Parametertitel, entfällt das jeweilige 0x20.
2. `0x21` — aktives Preset, leer wenn unbekannt (4.2)
3. `0x22` — Zustände
4. `0x23` für s = 0, 1, 2 — immer alle drei
5. `0x24` — Stimmanzeige (ab Protokoll 4, 5.3), **immer, auch bei Tuner-Modus aus**; entfällt
   nur, wenn der Host beim Lesen zweimal eine Ausnahme wirft (Debugzeile, 5.6)

**Die Antwort hat kein Endframe.** Unverlangte Frames (4.3) können jederzeit kommen —
davor, dazwischen, danach, auch direkt nach dem Start von Nuendo, wenn der Host seine
Startwerte über die Callbacks liefert. Ein 0x23 mit s = 2 kann also auch unverlangt
kommen und kennzeichnet das Ende einer Antwort **nicht** — ebenso wenig ein 0x24, das im
Tuner-Modus jederzeit unverlangt kommt. Das Deck braucht dieses Ende
nicht: Jedes Frame ist für sich gültig und wird einfach übernommen (4.3). Ob die
Verbindung steht, sagt der Pong (4.4), nicht die Antwort auf 0x10.

Die Abfrage sucht TONE3000 frisch (Kanal → Inserts → Slot 3), findet es also auch, wenn
es seit dem letzten Mal neu geladen oder verschoben wurde.

**Vor der ersten Aktivierung der Script-Seite** (Nuendo startet noch) kann das Script
nichts lesen. Es sendet dann einmal die Debugzeile `ABFRAGE vor der Aktivierung: Antwort
folgt mit der Aktivierung`, merkt sich die Abfrage und beantwortet sie vollständig, sobald
der Deck-Kanal das erste Mal positioniert ist: gleich mit der Aktivierung, wenn er schon
„Mono In 6" zeigt, sonst am Ende der ersten Deck-Suche (4.7, im Leerlauf, gewöhnlich
150–300 ms später). Bis dahin gemerkt werden auch Abfragen, die nach der Aktivierung
kommen (ohne Debugzeile); weitere Abfragen ergeben keine weitere Zeile.

#### `F0 7D 11 <p> <v1> <v0> F7` — TONE3000-Regler setzen

Genau 7 Byte.

| p | Regler | TONE3000-Parameter (Titel, exakt) | Klartext des Hosts |
| --- | --- | --- | --- |
| 0 | Gain | `inputLevel` | normiert, 4 Stellen, z. B. „0.4992" |
| 1 | Bass | `toneBass` | 0 … 10, z. B. „5.00" |
| 2 | Mid | `toneMid` | 0 … 10 |
| 3 | Treble | `toneTreble` | 0 … 10 |

Das Script setzt `setParameterProcessValue(…, Wert / 16383)` auf TONE3000 in Slot 3.

- **Nur wenn bit5 und bit6 gelten** (und die Seite aktiv ist). Sonst passiert nichts,
  und eine Debugzeile nennt den Grund. Dieselbe Ablehnung mehrfach hintereinander (beim
  Drehen) erscheint nur einmal, bis wieder ein Setzen gelingt.
- **Es kommt keine direkte Antwort.** Ein `0x20` für p sendet das Script nur, wenn der
  Host eine Änderung von p meldet (Parameter-Callback).
- **Ob der Host den vom Deck gesetzten Wert zurückmeldet, ist am Gerät ungeprüft — das
  Deck rechnet damit, dass nichts kommt.** Nach dem Quelltext von JUCE (dem Rahmen von
  TONE3000) meldet ein Plugin Werte, die der Host setzt, nicht zurück, und im Suchlauf
  2026-10-01 kam für das vom Script gesetzte `Program` kein Callback. Ohne Rückmeldung
  bleibt das Deck mit seinem Wert führend und **bildet den Klartext selbst**, genau wie
  der Host ihn zeigt:

  | p | Klartext aus dem Wert | Beispiel |
  | --- | --- | --- |
  | 0 Gain | Wert / 16383, vier Nachkommastellen | 8192 → „0.5000", 8178 → „0.4992" |
  | 1–3 Bass, Mid, Treble | Wert / 16383 · 10, zwei Nachkommastellen | 12000 → „7.32", 8192 → „5.00" |

  Kommt doch ein 0x20, gilt die Regel „Regler drehen" in 4.4.
- **Nach jedem 0x11 vergisst das Script seinen Dedup für p** (4.3): Die nächste Meldung
  des Hosts für p — Echo, Hand am Plugin, Automation, Preset — geht in jedem Fall hinaus,
  auch wenn sie dem zuletzt gesendeten Stand gleicht. So bleibt das Deck nicht auf seinem
  Wert stehen, wenn der Host auf einen früheren zurückspringt (etwa ein Preset mit
  „5.00", nachdem das Deck Mid auf „7.32" gedreht hat).
- Eine Ausnahme des Hosts beim Setzen: Das Script löst TONE3000 neu auf und versucht es
  **einmal** erneut; erst dann eine Debugzeile.
- Stellt sich beim Auflösen heraus, dass TONE3000 inzwischen fehlt oder eine andere
  Objekt-ID hat, meldet das Script das zusätzlich als 0x22 (bit6), 0x20 und 0x21 nach
  (mit Dedup, ohne den eben gesetzten Regler) — nicht nur als Debugzeile.

#### `F0 7D 12 <Name hex-ascii> F7` — Preset per Namen

Der Name ist der Presetname, wie TONE3000 ihn in seiner Liste führt (Groß/klein zählt),
etwa `HMT`, `JCM 2000`, `Einstein Vollgas`. Das Script setzt ihn als Klartext auf den
TONE3000-Parameter `Program` (`setParameterDisplayValue`), liest danach den Klartext
von `Program` und

- sendet `0x21` mit dem dann aktiven Namen, **wenn er sich gegenüber dem zuletzt
  gesendeten geändert hat** (Dedup),
- sendet die Debugzeile `Preset <Name> nicht übernommen, aktiv <x>`, wenn der Klartext
  danach nicht dem Wunsch entspricht (unbekannter Name),
- sendet die Debugzeile `Preset <Name> laut Host schon aktiv, ohne aktives Preset in
  TONE3000 wirkungslos`, wenn der Klartext **schon vor dem Setzen** der Wunschname war.

Wählt das Deck das **schon aktive** Preset, kommt also nur diese Debugzeile (TONE3000
lädt nicht neu, 0x21 wäre unverändert). Dieselbe Lage entsteht auf einer Instanz **ohne
aktives Preset** beim ersten Preset der Liste — dort ist der Wechsel wirkungslos, und das
Script kann beides nicht unterscheiden (4.6). Die Regler, die ein Preset verstellt,
kommen danach als `0x20` aus den Callbacks des Hosts.

Abgelehnt (Debugzeile, nichts gesetzt) bei leerem Namen, kaputtem Frame, vor der
Aktivierung, bei bit5 = 0, bit6 = 0 oder fehlendem `Program`. Fehlt TONE3000 inzwischen
(oder hat es eine neue Objekt-ID), kommen wie bei 0x11 auch 0x22 und 0x21 nach.

#### `92 <n> <vel>` — Tasten auf MIDI-Kanal 3

Note On auf **MIDI-Kanal 3** (Statusbyte `0x92`). Die **Velocity ist der Zielzustand**:
`7F` = an, `00` = aus. **Kein Note Off hinterher** — ein Note Off (`82 …`) oder eine
zweite Note mit Velocity 0 schaltet wieder aus. Andere Velocities nicht senden.

| n | Wirkung | an (`7F`) | Bit in 0x22 |
| --- | --- | --- | --- |
| 0 | Mute von Input 6 | gemutet | bit0 |
| 1 | Fenster Slot 1 (Tuner) | offen | bit1 |
| 2 | Bypass Slot 2 (Delay) | **Bypass an** (Delay aus dem Signalweg) | bit2 |
| 3 | Fenster Slot 2 (Delay) | offen | bit3 |
| 4 | Fenster Slot 3 (TONE3000) | offen | bit4 |

Ein Umschalter auf dem Deck sendet also `92 n 00`, wenn bit n gesetzt ist, sonst
`92 n 7F`. Den Zustand kennt das Deck aus dem letzten 0x22.

Die Tasten hängen als Value-Bindings an Nuendos Hostwerten des Deck-Kanals (Mute,
`mEdit` und `mBypass` je Insert-Slot). Sie **wirken immer**, auch wenn bit5 = 0 — dann
eben auf den Kanal, auf dem der Deck-Kanal gerade steht. Das Deck sollte sie in diesem
Fall sperren oder deutlich markieren.

Noten auf Kanal 1 (`90`) und Kanal 2 (`91`) gehören zu Protokoll 2 und sind kein Weg
für den Betrieb: Kanal 1 Note n schaltet **wirklich** die Mute von Platz n.

### 4.2 Nuendo → Deck

#### `F0 7D 20 <p> <v1> <v0> <Klartext> F7` — Reglerwert

`p` wie bei 0x11, Wert 14 Bit nach 2.3, Klartext so, wie Nuendo ihn anzeigt (höchstens
32 Byte). Gedacht zur Anzeige: Das Deck zeigt den Klartext des Hosts, sobald einer da
ist; nach einem eigenen 0x11 ohne Rückmeldung seine eigene Umrechnung (4.1). Ob es Wert
und Klartext übernimmt, während es den Regler selbst dreht, regelt 4.4.

#### `F0 7D 21 <Name> F7` — aktives Preset

Klartext von `Program`, also der Presetname. **Leer** (keine Datenbytes), wenn er nicht
bekannt ist: kein TONE3000 in Slot 3 oder kein Parameter `Program`.

**Ohne aktives Preset ist er nicht leer**: Auf einer Instanz, auf der noch nie ein
Preset gewählt wurde, meldet TONE3000 Programm 0, und der Klartext ist der Name des
**ersten Presets der Liste** (TONE3000-Quelltext, `ProcessorPresets.cpp`). Das Script
kann das von einem wirklich aktiven ersten Preset nicht unterscheiden (4.6).

#### `F0 7D 22 <flags> F7` — Zustände

Ein Datenbyte:

| Bit | Wert | Bedeutung, wenn gesetzt |
| --- | --- | --- |
| 0 | `0x01` | Input 6 gemutet |
| 1 | `0x02` | Tuner-Fenster (Slot 1) offen |
| 2 | `0x04` | Delay (Slot 2) im Bypass |
| 3 | `0x08` | Delay-Fenster (Slot 2) offen |
| 4 | `0x10` | TONE3000-Fenster (Slot 3) offen |
| 5 | `0x20` | **Zielkanal stimmt**: Der Deck-Kanal heißt „Mono In 6" (er folgt dem Namen, 4.7) |
| 6 | `0x40` | **TONE3000 in Slot 3 gefunden** (Objekttitel enthält „tone3000", ohne Groß/klein) |
| 7 | — | immer 0 |

bit 0 … 4 gehören zu Note 0 … 4 auf Kanal 3. Beispiel `0x64` = Delay im Bypass, Zielkanal
stimmt, TONE3000 gefunden, sonst alles aus.

Regler und Presets wirken nur mit bit5 **und** bit6. Ohne bit6 gibt es keine 0x20.

**Fällt bit6, gelten Reglerwerte und Preset als unbekannt.** Das Deck verwirft sie oder
zeigt sie als ungültig. Das Script vergisst dann seinen Dedup-Stand. Sobald es TONE3000
wieder findet, sendet es **alle vier 0x20 und 0x21 neu**, auch wenn sich die Werte nicht
geändert haben. Das Deck muss also nichts über bit6 = 0 hinweg aufheben.

#### `F0 7D 23 <s> <Name> F7` — Plugin-Name in Slot s

`s` = 0, 1, 2 für die Slots 1, 2, 3. Name wie im Insert-Viewer von Nuendo (z. B.
„H-Delay Mono"), **leer bei leerem Slot**, höchstens 100 Byte.

#### `F0 7D 7F <Text> F7` — Debugzeile

Eine Zeile Text für das Protokoll des Decks. Lange Zeilen verteilt das Script auf mehrere
Frames; jeder Folgeframe beginnt mit `  ~ ` (zwei Leerzeichen, Tilde, Leerzeichen) und
gehört an die vorige Zeile. **Das Deck wertet Debugzeilen nicht aus**, es zeigt oder
speichert sie höchstens. Die Zeilen des Betriebs stehen in 4.5.

### 4.3 Wann das Script unverlangt sendet

- **Nur bei echten Änderungen**, die ein Callback des Hosts meldet, **immer mit Dedup**:
  gesendet wird nur, was sich gegenüber dem zuletzt gesendeten Frame desselben Typs (bei
  0x20 je p, bei 0x23 je s) unterscheidet. Auch die Antwort auf eine Abfrage zählt als
  „zuletzt gesendet".
- Der Dedup-Stand spiegelt, was das Deck hat. Er wird vergessen, wenn das Deck selbst
  einen Wert setzt (0x11 für p) oder einen Wert nicht bekommen hat (kein 0x20 in der
  Abfrage, bit6 = 0). Die nächste Meldung geht dann in jedem Fall hinaus.
- **Nie beim Aktivieren an sich**, und vor der Aktivierung gar nicht (die einzigen Ausnahmen
  sind die Antworten auf eine vorher gemerkte Abfrage, 4.1, und ein vorher gemerktes 0x13,
  5.2).
- **Aber jederzeit danach, auch gleich nach dem Start:** Liefert Nuendo die Startwerte
  (Kanal- und Slot-Titel, Mute, Fenster) erst nach der Aktivierung über die Callbacks, sind
  das Änderungen wie alle anderen und gehen unverlangt hinaus — womöglich, bevor das Deck
  überhaupt abgefragt hat. Das Deck darf nicht annehmen, vor seiner Abfrage käme nichts.
- Auslöser im Einzelnen:

| Ereignis in Nuendo | Frames |
| --- | --- |
| Mute, Fenster, Delay-Bypass geändert (vom Deck oder von Hand) | 0x22 |
| Titel des Deck-Kanals geändert (umbenannt, Kanal davor eingefügt oder entfernt) | 0x22 (bit5) |
| Deck-Suche hat den Deck-Kanal verschoben (4.7) | 0x23, 0x22, 0x20, 0x21, im Tuner-Modus 0x24 — soweit geändert |
| Plugin-Name in Slot 1–3 geändert | 0x23; bei Slot 3 zusätzlich 0x22, 0x20, 0x21, soweit geändert |
| TONE3000-Regler geändert (Echo eines 0x11, falls der Host es meldet, von Hand, durch Automation, durch ein Preset) | 0x20 |
| irgendein TONE3000-Parameter gemeldet und der Presetname ist ein anderer | 0x21, dazu alle vier 0x20, soweit geändert |
| Kanal-Objekt gewechselt (`mOnObjectChange`, etwa beim Projektwechsel) | 0x22, 0x20, 0x21, soweit geändert |
| TONE3000 neu geladen (neue Objekt-ID, gleicher Name): erste Meldung des neuen Objekts | 0x22, 0x20, 0x21, soweit geändert |
| TONE3000 fehlt oder ist neu, entdeckt bei einem Zustandsbyte, einem 0x11/0x12 oder einer Meldung des Hosts | 0x22, 0x20, 0x21, soweit geändert |
| Messwerte des Tuners, Tuner in Slot 1 gewechselt — **nur im Tuner-Modus** | 0x24, soweit geändert (5.4) |

Auf eine Meldung für `Program` ist kein Verlass: Im Suchlauf 2026-10-01 setzte das Script
`Program` dreimal selbst, und für diesen Parameter kam kein Callback (JUCE meldet Werte,
die der Host setzt, nicht zurück). Ob ein im Plugin-Fenster gewähltes Preset `Program`
meldet, ist nicht beobachtet. Ein Presetwechsel meldet aber alle übrigen Parameter
einmal, und bei jeder Meldung vom TONE3000-Objekt liest das Script den Presetnamen nach —
so kommt ein gewechseltes Preset in jedem Fall als 0x21 an. Ist der Name neu, liest das
Script zusätzlich alle vier Regler nach. Das hilft, wenn Nuendo einen Plugin-State lädt
(`.vstpreset`, anderes Projekt): JUCE unterdrückt dabei die Meldungen der einzelnen
Parameter. Ob dann überhaupt etwas gemeldet wird, ist offen; deshalb fragt das Deck
regelmäßig ab (4.4).

Die Reihenfolge unverlangter Frames ist nicht festgelegt. **Jedes Frame ist für sich
gültig**: Das Deck übernimmt einfach den mitgeteilten Zustand.

### 4.4 Abläufe für das Deck

- **Verbinden:** Ports öffnen, `F0 7D 01 F7` senden (etwa alle 2 s), bis der Pong kommt.
  Mit dem Pong gilt die Verbindung als hergestellt. Dann **zuerst `F0 7D 13 <m> F7` mit dem
  eigenen Tuner-Modus** (beim Start des Plugins `00`, 5.5), danach `F0 7D 10 F7`. Die
  Antwort liefert den Ausgangszustand, hat aber kein Endframe (4.1). Frames, die vor oder
  während der Antwort unverlangt kommen, übernimmt das Deck genauso (4.3).
- **Wiederverbinden:** Weiter regelmäßig pingen. Bleiben mehrere Pongs aus (Nuendo neu
  gestartet, Script neu geladen), beim nächsten Pong wie beim Verbinden: erst 0x13 mit dem
  eigenen Modus, dann abfragen.
- **Tuner-Mute ohne Modus:** Meldet ein 0x24 bei stehender Verbindung bit2 = 0, bit3 = 1
  und bit4 = 1, einmal `F0 7D 13 00 F7` senden und „stumm" zeigen (5.5).
- **Regelmäßig abfragen:** Im Leerlauf alle 5 s `F0 7D 10 F7` senden. Leerlauf heißt:
  seit 2 s kein 0x11 und kein Druck auf eine Preset-Taste. Eine Antwort umfasst
  höchstens 10 Frames. Manche Wechsel meldet Nuendo womöglich gar nicht, etwa ein
  Plugin-State aus Nuendos Preset-Browser (`.vstpreset`) oder ein Projektwechsel mit
  gleicher Belegung (4.3, 4.6). Spätestens die nächste Abfrage stellt den Stand richtig.
- **Sofort abfragen**, wenn sich bit5 oder bit6 ändert oder ein 0x23 für s = 2 einen anderen
  Namen bringt. Das Script meldet dabei selbst nach (4.3); die Abfrage sichert ab.
- **Regler drehen:** bei jeder Änderung `F0 7D 11 p v1 v0 F7`. Die Anzeige rechnet den
  Klartext sofort selbst aus dem Wert (Tabelle in 4.1); ein 0x20 ist dafür nicht nötig
  und kommt womöglich nie.
- **0x20 für einen Regler, den das Deck gerade selbst dreht:** Hat das Deck für p in den
  letzten **300 ms** ein 0x11 gesendet, übernimmt es aus einem 0x20 für p **nur dann
  etwas, wenn der Wert gleich seinem eigenen ist — und dann nur den Klartext**. Sonst
  verwirft es das Frame: Es ist ein verspätetes Echo eines Zwischenwerts. Außerhalb dieser
  300 ms übernimmt es aus jedem 0x20 **Wert und Klartext** (Hand am Plugin, Automation,
  Preset, Abfrage).
- **Regler drücken = Mitte:** `F0 7D 11 p 40 00 F7` (8192), Anzeige wie beim Drehen.
- **Preset-Taste:** `F0 7D 12 <Name> F7`. Das aktive Preset erst mit 0x21 anzeigen,
  nicht vorab. Kommt kein 0x21, war es schon aktiv oder unbekannt (Debugzeile, 4.1).
- **Umschalt-Taste:** Zielzustand aus dem letzten 0x22 ableiten (4.1), keine eigene
  Annahme über den Zustand.
- **bit5 = 0:** Regler, Presets und Tasten sperren oder warnen — der Deck-Kanal ist
  (noch) nicht Input 6: „Mono In 6" fehlt im Projekt, oder die Deck-Suche läuft gerade
  (4.7). **bit6 = 0:** Regler und Presets sperren, Reglerwerte und Preset als
  unbekannt zeigen (4.2); Slot-3-Name aus 0x23 zeigt, was dort stattdessen steckt.

### 4.5 Debugzeilen des Betriebs

Zum Protokollieren; exakter Wortlaut, `<…>` sind Platzhalter.

| Zeile | Anlass |
| --- | --- |
| `ABFRAGE vor der Aktivierung: Antwort folgt mit der Aktivierung` | 0x10 vor der ersten Aktivierung |
| `TONE3000 <Gain/Bass/Mid/Treble> abgelehnt: noch kein activeMapping (Seite nie aktiviert)` | 0x11 vor der Aktivierung |
| `TONE3000 <…> abgelehnt: Deck-Kanal heißt "<Titel>", nicht "Mono In 6"` | 0x11 bei bit5 = 0 |
| `TONE3000 <…> abgelehnt: kein TONE3000 in Slot 3` | 0x11 bei bit6 = 0 |
| `TONE3000 <…> abgelehnt: Titel "<titel>" nicht gefunden` | Parameter fehlt in TONE3000 |
| `TONE3000 setzen abgelehnt: Frame mit <n> Byte, erwartet F0 7D 11 <p> <v1> <v0> F7` | 0x11 falsch lang |
| `TONE3000 setzen abgelehnt: Regler <p> unbekannt (0..3)` | p > 3 |
| `Preset abgelehnt: kein Name` / `Preset abgelehnt: <Frameproblem>` | 0x12 leer oder kaputt |
| `Preset <Name> abgelehnt: <Grund wie bei 0x11>` | 0x12 bei bit5/bit6 = 0, `Program` fehlt |
| `Preset <Name> nicht übernommen, aktiv <x>` | Klartext nach dem Setzen ≠ Wunsch |
| `Preset <Name> laut Host schon aktiv, ohne aktives Preset in TONE3000 wirkungslos` | Klartext schon vor dem Setzen = Wunsch (4.1, 4.6) |
| `ABFRAGE <…> Fehler: …`, `TONE3000 setzen Fehler: …`, `Preset Fehler: …` | Ausnahme des Hosts, auch nach dem Wiederholen |
| `<Ort> Fehler: …` | Ausnahme in einem Callback, auch `Deck-Suche Fehler: …` (die Suche gibt dann auf, 4.7); höchstens 20 je Sitzung als Zeile |
| `TUNER …`, `ABFRAGE Tuner Fehler: …` | Stimmanzeige, Liste in 5.6 |

### 4.6 Bekannte Eigenheiten und Grenzen

- **Instanz ohne aktives Preset** (frisch eingesetzt, nie ein Preset gewählt): TONE3000
  meldet dann Programm 0 (TONE3000-Quelltext, `ProcessorPresets.cpp`). Der Klartext von
  `Program` und damit 0x21 zeigt den Namen des **ersten Presets der Liste**, obwohl es
  nicht geladen ist. Ein 0x12 auf genau diesen Namen bleibt **wirkungslos**: JUCE
  verwirft einen Wechsel auf das Programm, das schon als aktuell gilt. Es kommt kein 0x21,
  nur die Debugzeile `Preset <Name> laut Host schon aktiv, …`. Abhilfe: einmal ein
  anderes Preset wählen, danach wirkt auch das erste. Das Script kann diesen Fall nicht
  von einem wirklich aktiven ersten Preset unterscheiden.
- Ein erneuter Druck auf das **aktive Preset lädt nicht neu** (TONE3000); auch hier
  kommt nur diese Debugzeile.
- **Rückmeldung eigener Werte:** Ob Nuendo nach einem 0x11 ein 0x20 liefert, ist am Gerät
  ungeprüft; eher nicht (4.1). Das Deck behandelt beides gleich (4.4).
- Die Tasten auf Kanal 3 wirken **ohne Titelprüfung** auf den Deck-Kanal (4.1).
- Wie schnell ein Wechsel in Slot 3 erkannt wird: Ein **anderes Plugin oder ein leerer
  Slot** ändert den Slot-Namen und wird sofort gemeldet. Kommt der Name, bevor Nuendo
  den DirectAccess-Baum umgebaut hat, liest das Script beim nächsten Bedarf noch einmal
  nach. Bedarf ist ein Zustandsbyte, ein Zugriff des Decks oder eine Meldung des Hosts.
  Ein **neu geladenes TONE3000** (neue Objekt-ID, gleicher Name) erkennt das Script beim
  nächsten Zugriff des Decks (0x10, 0x11, 0x12), beim nächsten Zustandsbyte oder bei der
  ersten Meldung des neuen Objekts. Ein **Projektwechsel** kommt über `mOnObjectChange`,
  am Gerät noch nicht beobachtet. Lädt Nuendo dabei nur Plugin-States, meldet JUCE
  womöglich gar nichts. Den Stand stellt dann die regelmäßige Abfrage des Decks richtig
  (4.4).
- Wird TONE3000 **ohne jeden Callback** in einen anderen Slot gezogen und ein zweites in
  Slot 3 eingesetzt, steuert das Script das alte bis zur nächsten Abfrage weiter; die
  Abfrage findet das richtige.
- Eine Taste auf einen **leeren Slot** (Fenster eines nicht vorhandenen Plugins) ändert
  in Nuendo nichts; was das Deck dann als Zustand bekommt, ist nicht erprobt.

### 4.7 Deck-Kanal folgt dem Namen

Seit 2026-10-06. Davor band das Script fest an Platz 6 der Eingänge; im Projekt vom
2026-10-06 ist „Mono In 6" aber der einzige Eingang, also Platz 0, und bit5 blieb 0
(`suchlauf/2026-10-06_114528.txt`). Am Protokoll ändert sich kein Byte, nur woran bit5
hängt und wann es kommt.

**Zwei Zonen** über dieselbe Liste aller Eingangskanäle, beide ohne Sichtbarkeitsfilter
(ausgeblendete Kanäle zählen mit), Platz k ist in beiden derselbe Kanal:

| Zone | Plätze | wird verschoben | trägt |
| --- | --- | --- | --- |
| Such-Zone „Eingaenge" | 32 | nie | Titel aller Eingänge (daraus der Platz von „Mono In 6"), Kanal-1-Mute, Suchlauf |
| Deck-Zone „Tone3000 Ziel" | 1 | von der Deck-Suche | den ganzen Betrieb: Mute, Slots 1–3, TONE3000, Tuner, Beobachtung |

**Wann gesucht wird** — die Deck-Suche läuft in Nuendos Leerlauf, nur mit Anlass:

- die Aktivierung der Script-Seite,
- ein geänderter Titel in der Such-Zone (Eingang eingefügt, entfernt, umbenannt),
- der Deck-Kanal verlässt „Mono In 6" (sein Titel wechselt von „Mono In 6" weg).

Ohne Anlass kostet der Leerlauf nichts; mit Anlass läuft höchstens alle 150 ms ein
Durchgang.

**Wie:**

1. Heißt der Deck-Kanal schon „Mono In 6": fertig, nichts bewegt.
2. Steht „Mono In 6" auf Platz k der Such-Zone: die Deck-Zone an den Anfang
   (`mResetBank`), dann k-mal einen Platz weiter (`mShiftRight`), alles in einem
   Durchgang. Danach bis zu vier Durchgänge auf den Titel warten; kommt er nicht, die
   nächste Runde, nach drei Runden aufgeben.
3. Sonst, wenn alle 32 Plätze der Such-Zone belegt sind (das Projekt hat womöglich mehr
   Eingänge): **Rückfall** — auf Platz 32 springen und je Durchgang einen Platz weiter, bis
   der Titel stimmt oder sich nichts mehr bewegt (am Ende der Liste läuft der Schub ins
   Leere; erkannt an der Objekt-ID, zwei Durchgänge ohne Bewegung), höchstens 256 Schritte.
4. Sonst gibt es „Mono In 6" nicht: aufgeben, **ohne die Zone anzufassen**. bit5 bleibt 0.

„Angekommen" heißt: Der Titel-Callback meldet „Mono In 6", oder — falls er noch aussteht
— das Basisobjekt des Deck-Kanals heißt per DirectAccess so; dann übernimmt das Script
diesen Namen. Nach dem Ende, gefunden oder aufgegeben, ruht die Suche bis zum nächsten
Anlass. Ein neuer Anlass mitten in der Suche beginnt sie neu, höchstens achtmal.

**Keine Dauer-Schieberei:** Die Zonen-Aktionen lösen selbst Titel- und Objektmeldungen
aus, keine davon ist ein Anlass. Die Such-Zone bewegt sich nie, und der Deck-Kanal wird
nur geschoben, solange er nicht „Mono In 6" heißt — die Suche führt ihn also nie vom Ziel
weg. Fehlt „Mono In 6", gibt es in einem Projekt mit weniger als 32 Eingängen keine einzige
Zonen-Aktion, mit 32 oder mehr einen Rückfall bis zum Ende (rund 35 Aktionen), danach Ruhe.

**Was das Deck sieht:**

- Verlässt der Deck-Kanal „Mono In 6" (etwa: Kanal davor eingefügt), kommt sofort ein 0x22
  ohne bit5 (dazu, was der Kanal dort zeigt: 0x23, bit6 …). Nach der Suche, gewöhnlich
  150–300 ms später, meldet das Script mit Dedup, was der Deck-Kanal jetzt zeigt: 0x23 für
  die drei Slots, 0x22 mit bit5, 0x20 und 0x21, im Tuner-Modus 0x24. Das Deck fragt bei
  einem Wechsel von bit5 ohnehin selbst ab (4.4). Mitten in der Suche sendet das Script
  nichts über die Zwischenstände.
- **Vor der ersten Positionierung** werden 0x10 und 0x13 gemerkt (4.1, 5.2) und mit dem
  Ende der ersten Suche beantwortet — mit der Aktivierung, wenn der Deck-Kanal schon
  richtig steht, und spätestens beim Sprung des Rückfalls, damit ein langer Rückfall das
  Deck nicht aufhält (dann zunächst mit bit5 = 0).
- 0x11 und 0x12 wirken nur bei bit5; die Tasten auf Kanal 3 und 0x13 wirken auf den Kanal,
  auf dem der Deck-Kanal gerade steht (4.1, 5.2).
- Im Tuner-Modus folgt der Tuner dem Deck-Kanal: Ein Tuner in Slot 1 des neuen Kanals wird
  stumm geschaltet; einer, dem der Modus die Mute schon gab, nicht noch einmal (5.4).

**Diagnose:** Der Suchlauf (Protokoll 2) nennt in einer Zeile `Deck-Kanal: "<Titel>"
(bit5=<0|1>), Deck-Suche: <Ergebnis der letzten Suche>, <n> Zonen-Aktionen seit dem
Laden`. Steht der Zähler nach der ersten Positionierung still, schiebt nichts mehr.

**Grenzen:**

- Verglichen wird der Titel exakt (Groß/klein zählt), es gilt der erste Platz mit diesem
  Namen.
- In Projekten mit mehr als 32 Eingängen sieht das Script Änderungen hinter Platz 31 nur
  am Deck-Kanal selbst. Hat ein Rückfall dort aufgegeben (Ziel fehlte), sucht es erst nach
  einer Änderung unter den ersten 32 Plätzen oder einer neuen Aktivierung wieder.

## 5 Stimmanzeige (Protokoll 4)

Steinbergs „Tuner" (Nuendo Plug-in Set) in Insert-Slot 1 von Input 6 legt seine Messwerte
als Parameter an und meldet sie live (`docs/befunde.md`, Abschnitt „Tuner"). Das Script
reicht sie als 0x24 ans Deck weiter, solange der **Tuner-Modus** an ist. Der Modus gehört
dem Deck: Es schaltet ihn mit 0x13, das Script führt ihn nur aus.

Im Modus ist der **Ausgang des Tuners stumm** (sein Parameter `Mute`), damit beim Stimmen
nichts aus TONE3000 und Delay kommt. Das ist **nicht die Mute des Kanals** (Note 0, bit0
von 0x22) — die berührt 0x13 nie.

### 5.1 Welcher Tuner

Erkannt wird das Plugin in Slot 1 am Objekttitel `Tuner` (exakt, ohne umgebende
Leerzeichen) oder, falls der übersetzt sein sollte, an seiner Klassenkennung
(`getObjectUniqueName` beginnt mit `6B9B08D2CA294270BF092A62865521BF`). Es gilt als
**gefunden** (bit3), wenn es außerdem die Parameter `Mute`, `Note` und `Cent` hat. `Oct`,
`Locked` und `In Tune` dürfen fehlen (dann 0 bzw. aus). Der GTR Tuner von Waves zählt
nicht, er meldet keine Messwerte.

| Parameter (Titel, exakt) | Tag laut Suchlauf | Klartext am Gerät | im 0x24 |
| --- | --- | --- | --- |
| `Mute` | 4201 | „On"/„Off" | bit4; das Script setzt ihn |
| `Note` | 4203 | „E " (mit Leerzeichen), „F#", Stille „--" | Note |
| `Cent` | 4204 | „-16", -50 … 50 | cent |
| `Oct` | 4205 | „1", Stille leer | oct |
| `Locked` | 4209 | „On", solange ein Ton erkannt ist | bit0 |
| `In Tune` | 4210 | „On" nahe der Mitte, flackert | bit1 |

Aufgelöst wird über die Titel, die Tags sind nur die Erwartung. `Frequency` (4202) und
`Base` (4211) braucht das Deck nicht; ihre Meldungen übergeht das Script, ohne etwas zu
lesen.

### 5.2 `F0 7D 13 <m> F7` — Tuner-Modus

Genau 5 Byte; `m` = `01` an, `00` aus.

- **An (`01`):** Das Script sucht den Tuner frisch (Kanal → Inserts → Slot 1), setzt `Mute`
  auf On, leitet ab jetzt die Messwerte weiter (5.4) und schickt **sofort ein 0x24** (ohne
  Dedup).
- **Aus (`00`):** `Mute` auf Off, Weiterleitung aus, sofort ein 0x24 mit bit2 = 0. Die Mute
  wird auch an jedem anderen Tuner aufgehoben, dem der Modus sie gesetzt hat und den es
  noch gibt — etwa einem, der im Modus aus Slot 1 in einen anderen Slot gezogen wurde.
- **Gesetzt wird nur, was abweicht.** Dasselbe `m` mehrfach ist harmlos: kein zweites
  Setzen, aber jedes Mal ein 0x24. Ein `00` hebt eine Mute **auch dann auf, wenn das Script
  sie nie gesetzt hat** (im Projekt gespeichert, von Hand) — das ist die Sicherung aus 5.5.
- **Ohne Tuner in Slot 1** wird nichts gesetzt; das 0x24 kommt trotzdem, mit bit3 = 0. Der
  Modus gilt dennoch: Taucht danach ein Tuner in Slot 1 auf, schaltet das Script ihn stumm
  und meldet ihn (5.4).
- **Keine Titelprüfung:** 0x13 wirkt wie die Tasten auch bei bit5 = 0, auf den Tuner in
  Slot 1 des Kanals, auf dem der Deck-Kanal gerade steht. Ein `00` soll eine Mute immer
  aufheben können.
- **Vor der ersten Aktivierung** der Script-Seite (Nuendo startet noch) merkt sich das Script
  das zuletzt empfangene `m`, sendet einmal die Debugzeile `TUNER vor der Aktivierung: Modus
  folgt mit der Aktivierung` und führt es aus, sobald der Deck-Kanal das erste Mal
  positioniert ist (4.7; bis dahin wird auch ein `m` nach der Aktivierung gemerkt, ohne
  Zeile) — noch vor einer ebenfalls ausstehenden Abfrage, deren 0x24 also schon den neuen
  Stand zeigt. So hebt ein `00` beim Start die Mute am Tuner von „Mono In 6" auf, nicht an
  dem des Kanals, auf dem die Deck-Zone beim Laden steht.
- Wirft der Host eine Ausnahme, löst das Script neu auf und versucht es **einmal** erneut;
  scheitert auch das, kommt `TUNER Fehler: …` statt des 0x24. Der Modus ist dann trotzdem
  umgeschaltet.

Kaputte Frames (andere Länge, kein `F7` an Byte 5, `m` weder 0 noch 1) werden mit einer
Debugzeile abgelehnt (5.6): nichts gesetzt, kein 0x24, Modus unverändert.

### 5.3 `F0 7D 24 <flags> <cent+64> <oct+64> <Note> F7` — Stimmanzeige

| Byte | Inhalt |
| --- | --- |
| `flags` | 7 Bit, Tabelle unten |
| `cent+64` | Cent als ganze Zahl -50 … 50, plus 64: `0E` … `72`; `40` = 0 Cent |
| `oct+64` | Oktave als ganze Zahl, plus 64 (auf 0 … 127 begrenzt): `41` = Oktave 1, `40` = 0 |
| `Note` | Klartext von `Note` ohne umgebende Leerzeichen, Hex-ASCII nach 2.2, höchstens 8 Byte UTF-8 (an der Zeichengrenze gekürzt): „E", „F#", „--"; leer ohne Tuner |

| Bit | Wert | gesetzt, wenn |
| --- | --- | --- |
| 0 | `0x01` | **Ton erkannt** (`Locked` = On) |
| 1 | `0x02` | **gestimmt** (`In Tune` = On) |
| 2 | `0x04` | **Tuner-Modus an** |
| 3 | `0x08` | **Steinberg-Tuner in Slot 1 gefunden** (5.1) |
| 4 | `0x10` | **Tuner-Mute an** (Ausgang des Tuners stumm) |
| 5 … 7 | — | immer 0 |

- **Cent** kommt aus dem Klartext von `Cent`, der ersten Zahl darin („-16", „+3", auch mit
  Dezimalkomma). Ist er unlesbar, aus dem Rohwert: `roh · 100 − 50` (am Gerät „-16" bei roh
  0,34). Gerundet und auf -50 … 50 begrenzt.
- **Oktave** aus dem Klartext von `Oct`; leer (Stille) oder unlesbar ergibt 0.
- **Bei Stille** (bit0 = 0) ist die Note „--", die Oktave 0, und **Cent bleibt auf dem
  letzten Wert stehen** (am Gerät nach dem Abklingen etwa „-49") — er ist dann bedeutungslos.
  Das Deck zeigt bei bit0 = 0 keine Nadel und keinen Centwert; maßgeblich ist bit0, nicht
  die Note.
- **Ohne Tuner** (bit3 = 0): Cent 0, Oktave 0, Note leer; nur bit2 kann gesetzt sein.
- Die Bits werden aus dem Rohwert gelesen (≥ 0,5 = an), nicht aus dem Klartext.

Beispiele:

| Frame | Bedeutung |
| --- | --- |
| `F0 7D 24 08 0F 40 32 44 32 44 F7` | Modus aus, Tuner gefunden, Stille („--"; Cent -49 bedeutungslos) |
| `F0 7D 24 1C 0F 40 32 44 32 44 F7` | Modus an, Mute an, Stille |
| `F0 7D 24 1D 30 41 34 35 F7` | Ton erkannt: E, Oktave 1, -16 Cent |
| `F0 7D 24 1F 42 41 34 35 F7` | gestimmt: E1, +2 Cent |
| `F0 7D 24 1F 40 42 34 36 32 33 F7` | gestimmt: F#2, 0 Cent |
| `F0 7D 24 0C 0F 40 32 44 32 44 F7` | Modus an, Mute im Plugin von Hand aufgehoben |
| `F0 7D 24 18 0F 40 32 44 32 44 F7` | Modus aus, **Mute trotzdem an** (etwa im Projekt gespeichert): Das Deck schickt einmal 0x13 00 (5.5) |
| `F0 7D 24 04 40 40 F7` | Modus an, **kein Tuner in Slot 1** (Note leer) |
| `F0 7D 24 00 40 40 F7` | Modus aus, kein Tuner |

### 5.4 Wann 0x24 kommt

| Anlass | Dedup | Tuner-Modus |
| --- | --- | --- |
| Antwort auf 0x13 | nein, immer | an und aus |
| letztes Frame jeder Abfrage 0x10 (4.1) | nein, immer | an und aus |
| Meldung eines der Parameter `Mute`, `Note`, `Cent`, `Oct`, `Locked`, `In Tune` | ja | **nur an** |
| Tuner in Slot 1 gewechselt: anderer Slot-Name, Objektwechsel (`mOnObjectChange`), erste Meldung eines neu geladenen Tuners | ja | **nur an** |
| vor der Aktivierung gemerktes 0x13, mit der Aktivierung | nein | an und aus |

- **Dedup** vergleicht das ganze Frame mit dem zuletzt gesendeten 0x24, auch dem aus 0x13
  oder 0x10. Ein Messdurchgang des Tuners meldet mehrere Parameter nacheinander (Cent, Oct,
  Note, Locked, Frequency, …). Das Script liest bei jeder relevanten Meldung alle sechs
  Werte; meist bringt die erste das neue Frame und die übrigen nichts.
- **Rate:** Beim Spielen meldet der Tuner Cent etwa 10-mal je Sekunde (Suchlauf
  2026-10-02). Im Modus kommen entsprechend viele 0x24, beim Anschlagen auch ein paar mehr.
  Das Deck drosselt die Anzeige selbst (Elgato: höchstens etwa 10 Bilder je Sekunde und
  Aktion). Jedes 0x24 ist vollständig, es gilt das letzte.
- **Außerhalb des Modus** sendet das Script nie unverlangt ein 0x24 und liest dafür nichts:
  Die Meldungen des Tuners kosten dort im Callback keinen einzigen DirectAccess-Zugriff.
  Den Stand außerhalb des Modus erfährt das Deck aus der Abfrage.
- **Neuer Tuner im Modus:** Wird der Tuner in Slot 1 im Modus ersetzt oder neu geladen
  (neue Objekt-ID), schaltet das Script auch den neuen stumm, denn der Modus heißt „Ausgang
  des Tuners stumm". Einen Tuner, dem es die Mute schon gesetzt hat, schaltet es nicht noch
  einmal: Hebt man sie im Plugin von Hand auf, bleibt das so (bit4 = 0 im nächsten 0x24).
  Erst ein neues 0x13 01 setzt sie wieder.

### 5.5 Sicherheit: Modus bei jedem Verbindungsaufbau

Hängt der Modus, wenn das Deck verschwindet (Plugin beendet, Stream-Deck-Software neu
gestartet, Rechner schläft), bliebe der Ausgang des Tuners stumm — und mit ihm die
Gitarre. Die Mute ist ein Plugin-Parameter und wird mit dem Projekt gespeichert. Deshalb:

- Das Deck schickt **bei jedem Verbindungsaufbau** — erster Pong nach dem Start, erster Pong
  nach einer Unterbrechung (4.4) — **seinen Modus als 0x13**, vor der Abfrage. Beim Start des
  Plugins ist das `F0 7D 13 00 F7`.
- **Bis zu diesem Pong übernimmt das Deck aus einem 0x24 nichts**, auch nicht den Modus aus
  bit2. Ein hängender Modus sendet weiter 0x24 mit bit2 = 1 (5.4), auch an ein Deck, das
  gerade startet oder dessen Frames nicht ankommen. Würde das Deck daraus seinen Modus
  übernehmen, schickte es beim Pong `13 01` statt `13 00`, und die Mute bliebe. Erst nach
  dem Pong zeigt das Deck den Modus aus bit2 jedes 0x24.
- Ein 0x13 00 hebt die Mute des Tuners in Slot 1 auf, wenn sie an ist, gleich wer sie
  gesetzt hat (5.2).
- Kommt es vor der Aktivierung der Script-Seite, führt das Script es mit ihr aus (5.2).
- **Bei stehender Verbindung** hilft das 0x13 des Verbindungsaufbaus nicht. Meldet ein 0x24
  nach dem Pong eine **Tuner-Mute ohne Modus** — bit2 = 0, bit3 = 1, bit4 = 1, und auch das
  Deck ist nicht im Modus —, schickt das Deck **einmal `F0 7D 13 00 F7`** und zeigt auf der
  Tuner-Taste „stumm", solange der Zustand anhält. Einmal heißt: beim Eintreten des
  Zustands, nicht je Frame. Wirkt das Aufheben nicht (5.7), entstünde sonst eine Schleife
  aus 0x13 00 und 0x24. Ein weiteres 0x13 00 geht erst hinaus, nachdem der Zustand einmal
  vorbei war (Mute aufgehoben, Modus an, Verbindung weg). Anlässe:
  - ein Projekt mit gespeicherter Mute wird geöffnet; außerhalb des Modus meldet das Script
    das mit der nächsten Abfrage (5.4);
  - das Script wird im Modus neu geladen und ist zurück, bevor Pongs ausbleiben; es meldet
    dann bit2 = 0 bei noch anliegender Mute, das Deck übernimmt „Modus aus" (5.7);
  - das Aufheben auf 0x13 00 scheiterte (`TUNER Fehler`, 5.6);
  - beim Wechsel zwischen zwei offenen Projekten steht der Tuner des anderen noch stumm.

Ein Rest bleibt: Solange kein Deck verbindet, bleibt die Mute an. Abhilfe ohne Deck: im
Fenster des Tuners `Mute` ausschalten. Umgekehrt gehört die Mute des Tuners bei verbundenem
Deck außerhalb des Modus dem Deck: Wer sie dann von Hand im Fenster des Tuners setzt, dem
hebt das Deck sie mit der nächsten Abfrage einmal wieder auf.

### 5.6 Debugzeilen der Stimmanzeige

| Zeile | Anlass |
| --- | --- |
| `TUNER vor der Aktivierung: Modus folgt mit der Aktivierung` | erstes 0x13 vor der Aktivierung |
| `TUNER abgelehnt: Frame mit <n> Byte, erwartet F0 7D 13 <m> F7` | 0x13 falsch lang oder ohne `F7` |
| `TUNER abgelehnt: Modus <m> unbekannt (0 aus, 1 an)` | `m` weder 0 noch 1 |
| `TUNER Fehler: …` | Ausnahme des Hosts beim 0x13, auch nach dem Wiederholen; kein 0x24 |
| `ABFRAGE Tuner Fehler: …` | Ausnahme beim Lesen des Tuners in der Abfrage; die Antwort endet dann ohne 0x24 |
| `Tuner Fehler: …`, `Tuner-Objektwechsel Fehler: …` | Ausnahme in einem Callback; zählt zu den höchstens 20 aus 4.5 |

### 5.7 Bekannte Eigenheiten und Grenzen

- **Am Gerät noch zu prüfen:** ob `setParameterProcessValue` auf `Mute` des Tuners wirkt
  (laut Suchlauf `discrete auto`, also wie ein gewöhnlicher Schalter) und ob der Tuner die
  vom Script gesetzte Mute zurückmeldet. Beides ist abgedeckt: Ein Echo ergibt dasselbe 0x24
  und wird vom Dedup geschluckt.
- Wie schnell ein Wechsel in Slot 1 erkannt wird: wie bei TONE3000 (4.6). Ein anderer
  Slot-Name sofort, ein still neu geladener Tuner mit seiner ersten Meldung, spätestens die
  nächste Abfrage. Außerhalb des Modus erst mit der Abfrage.
- Der Modus überlebt kein Neuladen des Scripts (Nuendo-Neustart): Danach ist er aus, bis das
  Deck 0x13 schickt — was es beim Wiederverbinden tut (5.5). Ist das Script zurück, bevor
  Pongs ausbleiben (unter 7 s), verbindet das Deck nicht neu; die nächste Abfrage meldet
  bit2 = 0 bei noch anliegender Mute. Das Deck übernimmt „Modus aus" und hebt die Mute mit
  einem 0x13 00 auf (5.5, Tuner-Mute ohne Modus).
- Ein Tuner, den man im Modus in einen anderen Slot zieht, bleibt stumm, bis 0x13 00 kommt;
  das hebt seine Mute auch dort auf. Nach einem Neustart des Scripts kennt es ihn nicht mehr:
  Dann hilft nur der Slot 1.

## 6 Suchlauf (Protokoll 2)

Bytes unverändert seit Protokoll 2; benutzt von `tools/suchlauf.cjs`. Nicht für das Deck.

| Bytes | Bedeutung |
| --- | --- |
| `F0 7D 01 F7` | Ping, Antwort `F0 7D 01 F7` |
| `F0 7D 02 [Kanal hex] F7` | Suchlauf; ohne Text Ziel „Mono In 6", sonst der Kanalname |
| `F0 7D 03 F7` | Beobachtung an (Ziel des letzten Suchlaufs, nur wenn es der Deck-Kanal war) |
| `F0 7D 04 F7` | Beobachtung aus, mit Zusammenfassung |
| `F0 7D 05 <Text> F7` | Setzen, Text `<ziel>;<titel>;<modus>;<wert>` (siehe unten) |
| `F0 7D 06 <Text> F7` | Befehl, Text `<schlüssel>;<zustand>` |
| `91 <n> 7F`, dann `91 <n> 00` | Note auf Kanal 2 an der Taste des Befehls n |
| `90 <n> <vel>` | Kanal 1: Mute von Platz n (0–31), Gegenprobe des Suchlaufs |
| `F0 7D 7F <Text> F7` | Ausgabezeile (Nuendo → Werkzeug) |

**Setzen** (`0x05`): `ziel` `3` = Plugin in Insert-Slot 3, `3/slot` = der Slot selbst;
`titel` exakter Parametertitel (Leerzeichen und `|` erlaubt, kein `;`); `modus` `norm`
(0..1), `plain` (Plain-Wert, wird umgerechnet) oder `text` (Klartext über
`setParameterDisplayValue`); `wert` ist alles nach dem dritten `;`. Endet immer mit der
Zeile `--- Setzen fertig ---`.

**Befehl** (`0x06`): `schlüssel` `next`, `prev`, `browser`, `browser2` (Kategorie
„Preset", Befehle Next, Previous, Open Browser, Open/Close Browser), wahlweise mit
`/taste`; `zustand` `1` oder `0` — ein Command-Binding braucht beide Flanken. Die
Notennummer auf Kanal 2 folgt derselben Reihenfolge (0 next … 3 browser2).

**Feste Zeilen**, auf die das Werkzeug wartet:

| Zeile | Bedeutung |
| --- | --- |
| `--- Suchlauf TONE3000 Remote, Protokoll 4, Ziel "<Titel>" ---` | erste Zeile jedes Suchlaufs; nennt die Protokollfassung, das Werkzeug verlangt mindestens 2 |
| `--- Suchlauf beendet ---` | letzte Zeile jedes Suchlaufs, auch nach einem Fehler |
| `--- Beobachtung läuft ---` / `--- Beobachtung beendet ---` | Beobachtung an / aus |
| `--- Setzen fertig ---` | Ende jedes Setzens, auch nach einem Fehler |

Die Beobachtung meldet `ÄNDERUNG <Objekt> tag=<n> "<titel>" = "<klartext>" roh <wert>`
für Parameter der Objekte aus dem letzten Suchlauf, je Parameter und Runde höchstens 6
Zeilen, je Sitzung höchstens 600.

**Zielkanal seit 2026-10-06 (4.7):** Heißt der Deck-Kanal wie das Ziel, läuft der Suchlauf
über dessen DirectAccess — dort hängt der Parameter-Callback, den die Beobachtung braucht.
Sonst über den Platz der Such-Zone; dann lehnt 0x03 ab (`Beobachtung nur auf dem
Deck-Kanal ("<Titel>") möglich, der Suchlauf traf Platz <k>`), ebenso, wenn die Deck-Zone
seit dem Suchlauf weitergezogen ist (`Beobachtung nicht möglich: Der Deck-Kanal zeigt seit
dem Suchlauf einen anderen Kanal …`). Neue Zeilen im Suchlauf:

| Zeile | Bedeutung |
| --- | --- |
| `Deck-Kanal: "<Titel>" (bit5=<0\|1>), Deck-Suche: <Ergebnis>, <n> Zonen-Aktionen seit dem Laden` | Stand des Deck-Kanals |
| `Ziel: Platz <k> "<Titel>" (per Name, Deck-Kanal)` | Ziel in der Such-Zone, gelesen über den Deck-Kanal |
| `Ziel: Deck-Kanal "<Titel>" (per Name, nicht unter den 32 Plätzen)` | Ziel hinter der Such-Zone, nur über den Deck-Kanal erreichbar |
| `Ziel: Platz <k> "<Titel>" (per Name)` | ein anderer Kanal der Such-Zone (keine Beobachtung) |
| `Ziel: Deck-Kanal "<Titel>" (RÜCKFALL: "<gesucht>" nicht gefunden)` | nicht gefunden; der Lauf zeigt den Deck-Kanal (bisher Platz 6) |

## 7 Protokollfassung

| Fassung | Inhalt |
| --- | --- |
| 1 | Ping, Suchlauf, Beobachtung |
| 2 | dazu Setzen (0x05) und Befehl (0x06) |
| 3 | dazu der Betrieb: 0x10–0x12, Noten auf Kanal 3, 0x20–0x23 |
| 4 | dazu die Stimmanzeige: 0x13, 0x24; die Abfrage endet mit 0x24 |

Die Fassung steht in der ersten Zeile jedes Suchlaufs. Fürs Deck: Antwortet Nuendo auf
eine Abfrage gar nicht, läuft dort vermutlich noch eine Fassung vor 3 — Script ausrollen
und Nuendo neu starten. Fehlt in der Antwort das 0x24 (und kommt auf 0x13 nichts), läuft
noch Fassung 3: Die Stimmanzeige geht dann nicht, alles andere schon.

## 8 Beispielsitzung

Ausgangslage: Der Deck-Kanal steht auf „Mono In 6" (die Deck-Suche ist durch, 4.7); Slots „Tuner" (Steinberg), „H-Delay Mono",
„TONE3000"; TONE3000 auf Preset „Calfinornia", Gain 0.4992, Bass/Mid/Treble 5.00;
Delay im Bypass; Mute aus, alle Fenster zu; der Tuner hört Stille (zuletzt „-49" Cent),
seine Mute ist aus. Die Zeilen nach `Nuendo` sind alles, was das Script auf die Zeile davor
sendet; der Test spielt sie gegen die nachgebaute API nach, in der ein Plugin Werte, die
das Script setzt, nicht zurückmeldet (wie JUCE, 4.1). In Nuendo kommen die 0x20 nach einem
0x12 etwas später, aus dem Callback des Hosts, und die Reihenfolge innerhalb einer Antwort
kann eine andere sein (4.3). Zeilen mit `Gitarre` sind ein Ereignis in Nuendo, kein Frame:
ein Ton am Eingang, den der Tuner misst (Note mit Oktave, Abweichung in Cent, „gestimmt",
wenn `In Tune` angeht), oder Stille. Zeilen mit `#` am Anfang sind Erläuterung.

```text
Deck   F0 7D 01 F7                     # Ping
Nuendo F0 7D 01 F7                     # Pong
Deck   F0 7D 13 00 F7                  # Verbindung steht: eigener Tuner-Modus zuerst (beim Start aus, 5.5)
Nuendo F0 7D 24 08 0F 40 32 44 32 44 F7   # Tuner gefunden, Mute schon aus (nichts gesetzt); Stille: "--", Cent -49 bedeutungslos
Deck   F0 7D 10 F7                     # Abfrage
Nuendo F0 7D 20 00 3F 72 33 30 32 45 33 34 33 39 33 39 33 32 F7   # p0 Gain 8178 "0.4992"
Nuendo F0 7D 20 01 40 00 33 35 32 45 33 30 33 30 F7               # p1 Bass 8192 "5.00"
Nuendo F0 7D 20 02 40 00 33 35 32 45 33 30 33 30 F7               # p2 Mid 8192 "5.00"
Nuendo F0 7D 20 03 40 00 33 35 32 45 33 30 33 30 F7               # p3 Treble 8192 "5.00"
Nuendo F0 7D 21 34 33 36 31 36 43 36 36 36 39 36 45 36 46 37 32 36 45 36 39 36 31 F7   # Preset "Calfinornia"
Nuendo F0 7D 22 64 F7                                             # Delay-Bypass, bit5, bit6
Nuendo F0 7D 23 00 35 34 37 35 36 45 36 35 37 32 F7                  # s0 "Tuner"
Nuendo F0 7D 23 01 34 38 32 44 34 34 36 35 36 43 36 31 37 39 32 30 34 44 36 46 36 45 36 46 F7   # s1 "H-Delay Mono"
Nuendo F0 7D 23 02 35 34 34 46 34 45 34 35 33 33 33 30 33 30 33 30 F7   # s2 "TONE3000"
Nuendo F0 7D 24 08 0F 40 32 44 32 44 F7                           # Stimmanzeige, immer zuletzt (kein Endframe, 4.1)
Deck   F0 7D 11 01 5D 60 F7            # Bass auf 12000 (93 * 128 + 96); keine Antwort, Deck zeigt "7.32" selbst
#      Meldete der Host den eigenen Wert zurück, käme: F0 7D 20 01 5D 60 33 37 32 45 33 33 33 32 F7  (p1 12000 "7.32")
Deck   F0 7D 11 00 40 00 F7            # Gain auf Mitte (Regler gedrückt); keine Antwort, Deck zeigt "0.5000"
Deck   F0 7D 12 34 38 34 44 35 34 F7   # Preset "HMT"
Nuendo F0 7D 20 00 40 00 33 30 32 45 33 35 33 30 33 30 33 30 F7   # p0 8192 "0.5000": erste Meldung des Hosts nach dem eigenen 0x11 (Dedup vergessen)
Nuendo F0 7D 21 34 38 34 44 35 34 F7                              # Preset "HMT"
Nuendo F0 7D 20 01 39 4C 33 34 32 45 33 35 33 30 F7               # p1 7372 "4.50" (das Preset verstellt den Bass)
Deck   F0 7D 12 34 37 36 39 36 32 37 34 37 33 36 45 36 39 36 33 36 38 37 34 F7   # Preset "Gibtsnicht"
Nuendo F0 7D 7F 35 30 37 32 36 35 37 33 36 35 37 34 32 30 34 37 36 39 36 32 37 34 37 33 36 45 36 39 36 33 36 38 37 34 32 30 36 45 36 39 36 33 36 38 37 34 32 30 43 33 42 43 36 32 36 35 37 32 36 45 36 46 36 44 36 44 36 35 36 45 32 43 32 30 36 31 36 42 37 34 36 39 37 36 32 30 34 38 34 44 35 34 F7   # "Preset Gibtsnicht nicht übernommen, aktiv HMT"
Deck   92 00 7F                        # Mute an
Nuendo F0 7D 22 65 F7                                             # bit0 dazu
Deck   92 04 7F                        # TONE3000-Fenster auf
Nuendo F0 7D 22 75 F7                                             # bit4 dazu
Deck   92 00 00                        # Mute aus
Nuendo F0 7D 22 74 F7                                             # bit0 weg
Gitarre E1 -16                         # Modus aus: der Tuner misst, das Script sendet nichts
Deck   F0 7D 13 01 F7                  # Tuner-Taste: Modus an, Script setzt "Mute" des Tuners auf On
Nuendo F0 7D 24 1D 30 41 34 35 F7      # bit0 Ton, bit2 Modus, bit3 gefunden, bit4 Mute; -16 Cent (0x30), Oktave 1 (0x41), "E"
Gitarre E1 +2 gestimmt
Nuendo F0 7D 24 1F 42 41 34 35 F7      # bit1 gestimmt dazu, +2 Cent (0x42)
Gitarre A2 -5
Nuendo F0 7D 24 1D 3B 42 34 31 F7      # A, Oktave 2 (0x42), -5 Cent (0x3B)
Gitarre F#2 +0 gestimmt
Nuendo F0 7D 24 1F 40 42 34 36 32 33 F7   # "F#" (Hex-ASCII 46 23), 0 Cent
Gitarre Stille
Nuendo F0 7D 24 1C 40 40 32 44 32 44 F7   # bit0/bit1 aus, Oktave 0, "--"; Cent bleibt stehen (bedeutungslos)
Deck   F0 7D 13 00 F7                  # Tuner-Taste: Modus aus, "Mute" des Tuners wieder Off
Nuendo F0 7D 24 08 40 40 32 44 32 44 F7   # bit2 und bit4 weg
Gitarre A2 +1 gestimmt                 # Modus aus: nichts
```
