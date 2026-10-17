# MCD Brackets — Tournament Management System

Ein vollständiges Turnierverwaltungssystem mit Event-basiertem Meisterschafts-Punktesystem, entwickelt mit [brackets-manager](https://www.npmjs.com/package/brackets-manager).

**Version:** 0.15.0-beta

---

## Features

### 🏆 Turnier-Formate
- **Single Elimination** — K.O.-System
- **Double Elimination** — Doppel-K.O. mit Winner & Loser Bracket
  - Optional: Grand Final (Simple oder Double)
  - Automatische BYE-Generierung für Power-of-2
- **Round-Robin** — Jeder gegen Jeden (Ranking nach 3/1/0 Punkten)

### 🎯 Event-Management
- **Multi-Turnier Events** — Mehrere Turniere pro Event
- **Zufällige Paarungen** — Fisher-Yates Shuffle beim Turnier-Start (serverseitig)
- **Event-Filter** — Turniere nach Events filtern
- **Gesamt-Rankings** — Event-übergreifende Ranglisten

### 👥 Teilnehmer-Verwaltung
- **Teilnehmer pro Event** — Vorname, Name, Clan und Nickname; angezeigt und in Turnieren gespielt als `Clan-Nickname`; aus einem anderen Event (z.B. Vorjahr) übernehmbar
- **Liste filtern & sortieren** — Suche, Clan-Filter, Sortieren per Klick auf Vorname, Nachname, Clan, Nickname oder #
- **Bulk-Import** — Liste im Format `Nachname, Vorname // Clan-Nickname` einfügen (Clan endet am ersten Bindestrich), mit Vorschau (IPs und Fehler pro Zeile) vor dem Import
- **3 IP-Adressen pro Teilnehmer** — aus drei einstellbaren Bereichen (Haupt-PC, Zweiter PC, Dritter PC) mit gleichem Versatz, z.B. `.100` / `.150` / `.200`; freie Plätze werden wiederverwendet
- **DNS-Namen** — `nickname`, `nickname2`, `nickname3` (ohne Clan) unter der einstellbaren Domain (Umlaute und Sonderzeichen werden DNS-tauglich umgewandelt)
- **IP-Zettel (PDF)** — ein DIN-A4-Blatt pro Teilnehmer mit Logo (Hochformat, oben rechts), Clan-Nickname, Name, den 3 IPs samt DNS-Namen und den Netzwerk-Einstellungen; einzeln (Icon in der Liste) oder für alle als ein PDF. Alle PDFs halten einen Druckrand von mind. 5 mm ein
- **Exporte** — CSV (Excel), hosts-Datei (dnsmasq/Pi-hole), BIND-Zone
- **Automatische Spieler** — Turniere nehmen alle Teilnehmer ihres Events (per Nickname); „Neu auslosen“ übernimmt neu hinzugekommene

### 🏅 Punktesystem & Rankings
Platzierungsbasierte Punkte:

| Platz | Punkte |
|-------|--------|
| 1     | 30     |
| 2     | 22     |
| 3     | 16     |
| 4     | 12     |
| 5     | 9      |
| 6     | 7      |
| 7     | 5      |
| 8     | 3      |
| 9–12  | 2      |
| 13+   | 1      |

- **Korrekte Double Elimination Platzierung** — Basierend auf erreichter Bracket-Runde
- **Event-Meisterschaft** — Gesamtpunkte über alle Turniere eines Events
- **Einzelturnier-Rankings** — Detaillierte Statistiken pro Turnier

### 📊 Bracket-Visualisierung
- **Interactive Brackets** mit [brackets-viewer.js](https://github.com/Drarig29/brackets-viewer.js)
- **Dark Theme** — Vollständig angepasstes Farbschema
- **Click-to-Win** — Gewinner direkt im Bracket auswählen
- **Smart Validierung** — Unterscheidung zwischen BYE und TBD Matches
- **Export** — Bracket & Rankings als JPG oder PDF

### ⚙️ Turnierverwaltung
- **Teilnehmer bearbeiten** — Mit automatischer Bracket-Regeneration
- **Bracket zurücksetzen** — Mit neuer zufälliger Auslosung
- **Cascade Delete** — Stage-Löschung entfernt alle Participants serverseitig
- **Match-Filter** — Nur offene Matches, TBD ausblenden
- **Collapsible Sections** — Aufgeräumte Benutzeroberfläche

### 💾 Datenbank-Backup & Restore
- **Backup herunterladen** — `db.json` als timestamped JSON-Datei exportieren
- **Backup einlesen** — JSON-Backup validieren und wiederherstellen
- Vor jedem Restore wird automatisch eine Sicherheitskopie der aktuellen DB angelegt

---

## Installation

### Docker (empfohlen)

```bash
docker compose up -d --build
```

Öffne [http://localhost:3000](http://localhost:3000) im Browser.

**Mit vorgebautem Image von GitHub Container Registry:**
```bash
docker pull ghcr.io/lordimac/mcd.brackets:latest
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data ghcr.io/lordimac/mcd.brackets:latest
```

### NPM (Development)

```bash
npm install
npm run server
```

Development Mode mit Auto-Reload:
```bash
npm run server:watch
```

Tests und Build:
```bash
npm test
npm run build && npm start
```

Umgebungsvariablen:

| Variable   | Standard | Beschreibung |
|------------|----------|--------------|
| `PORT`     | `3000`   | HTTP-Port |
| `DATA_DIR` | `./data` | Verzeichnis für `db.json` und Restore-Sicherungen |

---

## Webinterface

### Teilnehmer verwalten (Reiter „Teilnehmer“, erster Reiter)
1. Event anlegen („Neu“) — Domain und IP-Bereiche werden vom letzten Event übernommen
2. Unter „Konfiguration“ (einklappbar) Domain, Logo, Netzwerk (Subnetzmaske, Router/Gateway, DNS — stehen auf den IP-Zetteln) und die drei IP-Bereiche einstellen
3. Teilnehmer mit Vorname, Name und Nickname hinzufügen — einzeln oder per „Mehrere auf einmal importieren…“ (`Nachname, Vorname // Clan-Nickname`, eine Zeile pro Teilnehmer). IPs und DNS-Namen werden automatisch vergeben
4. IP-Zettel als PDF drucken („IP-Zettel (PDF)“ für alle, Datei-Icon in der Zeile für einzelne) und bei Bedarf CSV, hosts-Datei oder BIND-Zone herunterladen

### Turnier erstellen (Reiter „Turniere“)
1. Event auswählen — alle Teilnehmer des Events spielen mit
2. Turnier-Name eingeben
3. Typ wählen (Single/Double Elimination oder Round Robin)
4. Optional: Grand Final mit Rückspiel für Double Elimination

### Bracket anzeigen & bearbeiten
- **Gewinner auswählen**: Klick auf Match → Gewinner wählen
- **BYE-Matches**: Werden automatisch entschieden
- **TBD-Matches**: Noch nicht spielbar, warte auf vorherige Matches

### Rankings
- **Einzelturnier**: Rangliste mit Platzierung und Statistiken
- **Event-Gesamt**: Kombinierte Rangliste über alle Turniere
- **Top-3 Highlighting**: Gold / Silber / Bronze

### Backup & Restore
Im Footer der Seite:
- **💾 Backup herunterladen** — Lädt die aktuelle `db.json` herunter
- **📂 Backup einlesen** — Stellt eine gesicherte `db.json` wieder her

---

## REST API

### Stages
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/stages` | Alle Stages abrufen |
| POST   | `/api/stages` | Neue Stage erstellen — Body: `{ name, type, eventName, settings?, participants? }`; ohne `participants` spielen alle Teilnehmer des Events. Turnier-ID, Auslosung und BYEs vergibt der Server |
| POST   | `/api/stages/:id/regenerate` | Stage neu auslosen mit den aktuellen Teilnehmern des Events (oder `{ participants: string[] }`); Einstellungen und Event bleiben erhalten, bei Fehlern wird zurückgerollt |
| DELETE | `/api/stages/:id` | Stage + Participants löschen |

### Matches
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/matches` | Alle Matches abrufen |
| PUT    | `/api/matches/:id` | Match-Ergebnis aktualisieren |

### Participants
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/participants` | Alle Teilnehmer abrufen |
| DELETE | `/api/participants/:id` | Teilnehmer löschen |

### Viewer & Standings
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/viewer-data/:stageId` | Turnierdaten für Bracket-Viewer |
| GET    | `/api/standings/:stageId` | Platzierungen inkl. Punkten: `{ placement, participant_id, participant_name, wins, losses, pending, points }` |

### Events & Teilnehmer
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/events` | Events inkl. Anzahl Teilnehmer, Plätze und Turniere |
| POST   | `/api/events` | Event anlegen `{ name, domain?, dns_server?, netmask?, gateway?, ranges? }` (fehlende Werte vom letzten Event) |
| PUT    | `/api/events/:id` | Event ändern; Umbenennen wirkt auch auf die Turniere |
| DELETE | `/api/events/:id` | Event mit Teilnehmern löschen (nur ohne Turniere) |
| GET    | `/api/events/:id/attendees` | Teilnehmer inkl. `ips` und `dns_names` |
| POST   | `/api/events/:id/attendees` | Teilnehmer anlegen `{ first_name, last_name, clan, nickname }` |
| POST   | `/api/events/:id/attendees/import` | Teilnehmer aus `{ fromEventId }` übernehmen |
| POST   | `/api/events/:id/attendees/bulk` | Bulk-Import `{ text, dryRun? }` — Zeilen `Nachname, Vorname // Clan-Nickname`; liefert pro Zeile Ergebnis oder Fehler, `dryRun: true` schreibt nichts |
| PUT    | `/api/attendees/:id` | Teilnehmer ändern; neuer Clan/Nickname wird in den Turnieren übernommen |
| DELETE | `/api/attendees/:id` | Teilnehmer löschen (IPs werden frei) |
| GET    | `/api/events/:id/export/csv\|hosts\|zone` | Export als CSV, hosts-Datei oder BIND-Zone |

### Backup & Restore
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/backup` | `db.json` als Download |
| POST   | `/api/restore` | Backup einspielen (JSON body) |

---

## Technologien

**Backend:** Node.js 22+ (Docker: Node 24), Express 5, TypeScript 7  
**Frontend:** Vanilla JavaScript, HTML5, CSS3  
**Engine:** brackets-manager 1.11, brackets-json-db 1.0  
**Visualisierung:** brackets-viewer.js 1.9  
**Export:** html2canvas 1.4, jsPDF 4  

---

## Datenstruktur

Die Daten werden in `data/db.json` gespeichert (per Docker Volume persistent):

- `participant` — `{id, tournament_id, name}`
- `stage` — `{id, tournament_id, name, type, event_name, settings}`
- `match` — `{id, stage_id, round_id, group_id, opponent1, opponent2}`
- `group` — Bracket-Gruppen (Winner / Loser / Finals)
- `round` — Runden innerhalb der Gruppen
- `match_game` — Einzelspiele
- `event` — `{id, name, domain, dns_server, netmask, gateway, logo, ranges: [{start, end} ×3]}` — `logo` ist eine PNG/JPEG-Data-URL
- `attendee` — `{id, event_id, first_name, last_name, clan, nickname, hostname, slot}` — IPs ergeben sich aus `ranges[i].start + slot`

---

## Platzierungsberechnung

### Double Elimination
Die Platzierung basiert auf:
1. Erreichter Gruppe (Finals > Loser Bracket > Winner Bracket)
2. Gewonnen/Verloren in der letzten Runde
3. Gesamte Wins als Tiebreaker
4. Gesamte Losses (weniger = besser) als finaler Tiebreaker

### Single Elimination
Sortierung nach Wins → Losses.

### Round Robin
3 Punkte pro Sieg, 1 pro Unentschieden; Gleichstände löst brackets-manager über die Score-Differenz. Bei mehreren Gruppen kommen alle Gruppenersten vor allen Gruppenzweiten usw.

---

## Projekt-Struktur

```
mcd.brackets/
├── src/
│   ├── server.ts       # Express Server + REST API
│   ├── db.ts           # Storage, Restore, Schreib-Lock, Rollback
│   ├── stages.ts       # Turniere anlegen, neu auslosen, löschen
│   ├── lan.ts          # IP-Vergabe, DNS-Namen, Exporte (reine Logik)
│   ├── lan-store.ts    # Events & Teilnehmer in der Datenbank
│   ├── lan-routes.ts   # REST-Routen für Events & Teilnehmer
│   ├── standings.ts    # Platzierungen + Punktesystem
│   ├── seeding.ts      # Auslosung + BYEs
│   └── *.test.ts       # Tests (npm test)
├── public/
│   ├── index.html      # Webinterface
│   ├── app.js          # Frontend-Logik (Turniere)
│   ├── lan.js          # Frontend-Logik (Teilnehmer-Verwaltung)
│   ├── ip-slips.js     # IP-Zettel als PDF (jsPDF)
│   ├── styles.css      # Dark Theme Styling
│   └── lib/            # Lokale Kopien der Browser-Libs (npm run vendor)
├── data/
│   └── db.json         # Turnierdaten (Docker Volume)
├── docker-compose.yml
├── Dockerfile
├── package.json
└── README.md
```

---

## Lizenz

ISC
