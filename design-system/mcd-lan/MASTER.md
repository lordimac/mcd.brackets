# Design-Richtung „Patchkabel & Etikett“

Neue Gestaltung für das mcd.lan-Intranet (Start, Teilnehmer, Sitzplan, Zeitplan, Burger, Turniere). Ersetzt den bisherigen Anthrazit-Look mit Chakra Petch und Vier-Farben-Streifen. Pflicht aus dem alten Stand bleibt nur das Logo-Orange `#ff4500`.

Status: umgesetzt in `public/styles.css`, `public/index.html`, `public/welcome.js` (nur ein dunkles Farbschema).

## Idee

Eine LAN-Party besteht physisch aus Patchkabeln, Netzwerkschränken und Etiketten — die App druckt selbst schon DYMO-Etiketten für Burger. Daraus kommt alles:

- **Farben = Kabelfarben.** Das Logo-Orange ist die orange Ader eines Netzwerkkabels; Blau, Grün, Braun und Weiß sind die übrigen Aderfarben, Violett eine übliche Patchkabel-Farbe. Alle Bereichsfarben sind feste Vollfarben, nichts ist gestreift.
- **Fläche = Netzwerkschrank in RAL 7016 Anthrazitgrau.** Es gibt nur diesen einen dunklen Modus — keinen hellen Modus, keinen Schalter, kein `prefers-color-scheme`. Die Halle ist abends dunkel, und ein einziges Farbschema hält Oberfläche, Exporte und PDFs einfach.
- **Ein markantes Element: Etikettenband.** Bereichstitel, eigener Nickname (oben rechts und auf dem Ausweis), Burger-Nummer sitzen auf geprägtem Label-Tape. Alles andere bleibt ruhig.

## Farben

Flächen und Text:

| Token | Wert | Rolle |
|---|---|---|
| `--panel` | `#1d2023` | Navigationspanel oben (Schrankfront) |
| `--rack` (Schrankgrau) | `#2f3437` | Seitenhintergrund |
| `--zebra` | `#353b3e` | jede zweite Tabellenzeile |
| `--label` (Etikett) | `#3b4145` | Flächen, Tabellen, Dialoge |
| `--badge` | `#454c51` | Ausweis auf der Startseite (hebt sich von den Flächen ab) |
| `--line` (Kabelgrau) | `#6b7276` | Linien, Rahmen |
| `--ink` | `#eef0ec` | Text |
| `--ink-2` | `#b9c0bb` | Sekundärtext |
| `--me` | `#2c3a52` | eigene Zeile in Listen |

Adern — zwei Stufen: **Band** (Fläche, Etikettenband, Clan-Tag, Reiter-Linie; immer gleich, wie echtes Material) und **Text** (aufgehellt, damit er auf `--label` ≥ 4.5:1 erreicht):

| Ader | Band | Text | Bereich |
|---|---|---|---|
| Orange | `#ff4500` | `#ff9466` | Marke, Hauptaktion, Turniere |
| Blau | `#1f5fbf` (Reiter `#4f8be0`) | `#8db6f2` | Teilnehmer |
| Grün | `#2e7d38` (Reiter `#4fb35f`) | `#7fd18c` | Sitzplan |
| Braun | `#7a4a26` (Reiter `#b98251`) | `#d9a77c` | Burger |

Status (Punkt / Text): ok `#5cc06c` / `#7fd18c`, Warnung `#e0b52e` / `#e8c25a`, Fehler `#ff6b5e` / `#ffa49c`.

Regeln:
- Auf Orange steht `#1d2023`, nicht Weiß (Weiß auf `#ff4500` hat nur 3.4:1). Auf Blau, Grün, Braun steht `#f7f8f5`.
- Kein reines Schwarz und kein fast-schwarzer Seitengrund: die Seite ist anthrazitgrau, nur das Panel ist dunkler.
- Status immer mit Symbol + Text (wie Port-LEDs: Punkt, Halbkreis, Ring), nie nur Farbe.
- Nur hex/rgba — html2canvas kann kein `color-mix()`/`oklch()`.

### Bereich → Farbe

| Bereich | Farbe | Band | Reiter-Linie | Text |
|---|---|---|---|---|
| Start | Weiß | `#f7f8f5` (Schrift `#1d2023`) | `#f7f8f5` | `--ink` |
| Teilnehmer | Blau | `#1f5fbf` | `#4f8be0` | `#8db6f2` |
| Sitzplan | Grün | `#2e7d38` | `#4fb35f` | `#7fd18c` |
| Zeitplan | Violett | `#6a4fb3` | `#9b84e8` | `#c3b4f5` |
| Burger | Braun | `#7a4a26` | `#b98251` | `#d9a77c` |
| Turniere | Orange | `#ff4500` (Schrift `#1d2023`) | `#ff4500` | `#ff9466` |

Keine gestreiften Farben — weder auf Reitern noch auf dem Etikettenband.

## Typografie

- **Barlow Condensed** 600/700: Titel, Etikettenband, große Zahlen (Sitzplatz, Burger-Nummer).
- **Barlow Semi Condensed** 500/600: Reiter, Buttons, Tabellenköpfe.
- **Barlow** 400/500: Fließtext, Formulare.
- **IBM Plex Mono** 400/500: nur echte Netzwerkwerte — IP, DNS-Namen, Maske, Gateway, SMB-Pfade. Nie für Labels.
- Skala 1.25: 13 (nur Tabellen-Meta) / 16 / 20 / 25 / 31 / 39 px. Fließtext 16 px, Zeilenhöhe 1.5, Zeilen < 75 Zeichen.
- Satzschreibung überall, auch auf dem Etikettenband. Keine Versal-Mini-Labels, keine Eyebrows über Überschriften.
- Einbindung lokal über `@fontsource/barlow`, `@fontsource/barlow-condensed`, `@fontsource/barlow-semi-condensed`, `@fontsource/ibm-plex-mono` → `npm run vendor` (kein CDN, CSP).

## Form und Tiefe

- Radius 2 px für Flächen und Buttons, 1 px für Etiketten und Chips.
- Keine weichen Schatten, kein Blur, keine Verläufe. Tiefe nur über 1-px-Kanten in `--line` und den harten 2-px-Versatz unter dem Etikettenband.
- Hintergrund ohne Punktraster — die Fläche ist das Blech des Schranks.

## Layout

Linksbündig, eine Spalte, max. 1280 px, Seitenrand 32 px (mobil 16 px).

```
┌────────────────────────────────────────────────────────────────────────┐
│ [Logo] mcd.lan 2026   Start  Teilnehmer  Sitzplan  Zeitplan  …  [Kaltlicht] │
│ ═══ aktive Ader als 4-px-Linie unter dem aktiven Reiter ═══            │
├────────────────────────────────────────────────────────────────────────┤
│ ▌Teilnehmer▐  (Etikettenband in Bereichsfarbe)          [Aktionen]     │
│ Suche · Clan-Filter                                                    │
│ Tabelle: Zebra Etikett/Schrankgrau, IP und DNS in Plex Mono            │
└────────────────────────────────────────────────────────────────────────┘
```

Start-Seite als Einlass-Ausweis:

```
┌──── Ausweis ──────────────┐  ┌──── Dein Anschluss ────────────────┐
│ ▌Clan-Nickname▐ (Tape)    │  │ ● IP 10.10.1.14         ok         │
│ Vorname Nachname          │  │ ● Gateway im Subnetz    ok         │
│ Platz 14 (groß)           │  │ ◐ DNS antwortet nicht   prüfen     │
│ IPs / DNS-Namen (Mono)    │  └────────────────────────────────────┘
└───────────────────────────┘  Deine Turniere · Zeitplan heute
```

Mobil (< 520 px): Reiter nur als Icons mit `aria-label`, Ausweis über den Checks, Touch-Ziele ≥ 44 px, keine horizontale Seiten-Scrollbar.

## Komponenten

- **Reiter:** Semi Condensed 600, Text `--ink-2`; aktiv: Text `--ink`, darunter 4-px-Linie in der Bereichsader (immer Vollfarbe). Kein gefüllter Reiter-Hintergrund.
- **Etikettenband:** Condensed 700, Hintergrund Bereichsader, Text hell (`#f7f8f5`; bei Orange `#1d2023`), Innenabstand 4/12 px, rechte Kante 6° schräg angeschnitten (`clip-path`), 2-px-Versatz in `rgba(0,0,0,.35)`. Höchstens eins pro Bildschirmbereich.
- **Eigenes Etikett oben rechts:** oranges Band mit dem Nickname ohne Clan (z. B. „Kaltlicht“), führt zur Startseite. Clan und Platz stehen auf dem Ausweis.
- **Buttons:** primär Orange mit `#1d2023`-Text und 1-px-Kante `#1d2023`; sekundär Etikett mit 1-px-Kante `--ink`; ghost nur Text. Höhe 40 px (mobil 44 px). Fokus: 2-px-Ring in `--ink` mit 2 px Abstand.
- **Ausweis:** Fläche `--badge`, 1-px-Rand `--line`, Lanyard-Schlitz oben in `--rack`, Nickname als Etikettenband, Platz in Condensed 96 px.
- **Tabelle:** Kopf Semi Condensed auf `--label` mit Trennlinie in `--ink-2`, Zeilen 48 px, Zebra, eigene Zeile hervorgehoben durch 4-px-Linksrand in Blau.
- **Port-Status-Zeile:** Symbol (● ok, ◐ Warnung, ○ Fehler) + Prüfung + Wert in Mono + Status-Text.
- **Chip** (eigener Platz, Share): 1-px-Rand, Radius 1 px, Mono nur für Werte.
- **Clan-Tag:** sechs gedeckte Töne aus den Adern (Orange, Blau, Grün, Braun, Violett, Grau), Text immer ≥ 4.5:1.
- **Dialog:** Etikett-Fläche, 1-px-Rand `--line`, harter Versatz 4 px `rgba(0,0,0,.35)`, Titel als Condensed 25 px, Overlay `rgba(15,17,19,.6)`.

## Bereiche

- **Sitzplan:** Raum als Fläche mit 20-px-Raster, Wände 3 px in `--ink-2`, Tür als Lücke mit gestricheltem Schwenkbogen. Tische 72 × 44 mit Platznummer und Nickname, Stühle als graue Balken. Eigener Platz orange umrandet, Suchtreffer grün, freie Tische gestrichelt. Daneben Suche, „Ohne Platz“ und Legende.
- **Zeitplan:** Tage als Umschalter (aktiver Tag hell mit violetter Unterkante). Einträge an einem senkrechten Kabelstrang, der Knoten in der Farbe der Kategorie (Essen Braun, Programm Grün, Turnier Orange, Sonstiges Grau), Kategorie zusätzlich als Text-Tag. „Jetzt“ als kleines orangefarbenes Etikett mit Linie; Vergangenes in `--ink-2`.
- **Burger:** Links der Burger als gestapelte Schichten, die sich beim Wählen sofort ändern, darunter Zusammenfassung, Hinweis und „Burger bestellen“. Rechts Kategorien mit Optionen als 44-px-Schaltern (gewählt = braunes Band, nicht verfügbar = durchgestrichen). Bestellnummern als braunes Etikett, Status als Text.
- **Turniere:** Turniere als Auswahlkacheln (aktiv mit oranger Unterkante), Modus als Text-Tag (DE Orange, SE Blau, RR Braun). Bracket mit 2-px-Leitungen in `--line`, abgeschlossene Matches mit grüner Kante, offenes eigenes Match orange umrandet, eigene Zeile `--me`, ausgeloste Matches mit Tag „Los“. Spielzeit je Runde unter der Rundenüberschrift. Daneben die Gesamtwertung mit geteilten Plätzen („4–5“).

## Bewegung

Ein einziger Moment: Das Ausweis-Etikett „druckt“ beim ersten Laden heraus (Band schiebt sich in ≈ 400 ms von links ein). `prefers-reduced-motion` = statisch. Sonst Bewegung nur als Antwort auf Aktionen (Dialog öffnen 150 ms, Zustandswechsel 120 ms).

## Prinzipien

1. Kühnheit nur im Etikettenband — Karten, Tabellen, Dialoge sind schlicht.
2. Jede Farbe bedeutet etwas (Bereich oder Status), nichts ist Deko.
3. Netzwerkwerte sehen aus wie Netzwerkwerte, alles andere wie Beschilderung.
4. PDFs (IP-Zettel, Sitzplan, Zeitplan, Etiketten) bleiben weiß auf Papier und übernehmen nur Orange und die Band-Töne der Adern.

## Abgrenzung

- Der Vorschlag der UI-UX-Pro-Max-Datenbank für „Gaming LAN“ (Neon-Violett, 3D, Russo One/Chakra Petch) wurde bewusst verworfen: generischer Gaming-Look, widerspricht „kein Glow, keine Standard-AI-Optik“.
- Kein Creme + Serif, kein Schwarz + ein Neon-Akzent, keine identischen Rundkarten.
- DYMO-Band in Satzschreibung statt Versalien; Mono nur für Netzwerkwerte.

## Umsetzung später

`public/styles.css` (Tokens in `:root`, `body[data-view]`, `@font-face`, nur ein dunkles Farbschema, `color-scheme: dark`), `public/index.html` (Brand, Reiter), `public/welcome.js` (Ausweis-Markup), `EXPORT_BACKGROUND` in `app.js`, `SLIP.accent` in `ip-slips.js`, `package.json` (Font-Pakete, `vendor`-Skript).
