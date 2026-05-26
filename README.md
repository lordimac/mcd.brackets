# MCD Brackets — Tournament Management System

Ein vollständiges Turnierverwaltungssystem mit Event-basiertem Meisterschafts-Punktesystem, entwickelt mit [brackets-manager](https://www.npmjs.com/package/brackets-manager).

**Version:** 0.9.1-beta

---

## Features

### 🏆 Turnier-Formate
- **Single Elimination** — K.O.-System
- **Double Elimination** — Doppel-K.O. mit Winner & Loser Bracket
  - Optional: Grand Final (Simple oder Double)
  - Automatische BYE-Generierung für Power-of-2
- **Round-Robin** — Jeder gegen Jeden

### 🎯 Event-Management
- **Multi-Turnier Events** — Mehrere Turniere pro Event
- **Zufällige Paarungen** — Fisher-Yates Shuffle beim Turnier-Start
- **Event-Filter** — Turniere nach Events filtern
- **Gesamt-Rankings** — Event-übergreifende Ranglisten

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

---

## Webinterface

### Turnier erstellen
1. Event auswählen oder neues erstellen
2. Turnier-Name eingeben
3. Typ wählen (Single/Double Elimination oder Round Robin)
4. Teilnehmer eingeben (einer pro Zeile)
5. Optional: Grand Final Type für Double Elimination

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
| POST   | `/api/stages` | Neue Stage erstellen |
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
| GET    | `/api/standings/:stageId` | Platzierungen (DE/SE korrekt) |

### Backup & Restore
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/backup` | `db.json` als Download |
| POST   | `/api/restore` | Backup einspielen (JSON body) |

---

## Technologien

**Backend:** Node.js 18+, Express 5, TypeScript 5  
**Frontend:** Vanilla JavaScript, HTML5, CSS3  
**Engine:** brackets-manager 1.8.1, brackets-json-db 1.0.2  
**Visualisierung:** brackets-viewer.js  
**Export:** html2canvas, jsPDF  

---

## Datenstruktur

Die Daten werden in `data/db.json` gespeichert (per Docker Volume persistent):

- `participant` — `{id, tournament_id, name}`
- `stage` — `{id, tournament_id, name, type, event_name, settings}`
- `match` — `{id, stage_id, round_id, group_id, opponent1, opponent2}`
- `group` — Bracket-Gruppen (Winner / Loser / Finals)
- `round` — Runden innerhalb der Gruppen
- `match_game` — Einzelspiele

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

---

## Projekt-Struktur

```
mcd.brackets/
├── src/
│   └── server.ts       # Express Server + REST API
├── public/
│   ├── index.html      # Webinterface
│   ├── app.js          # Frontend-Logik
│   └── styles.css      # Dark Theme Styling
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
