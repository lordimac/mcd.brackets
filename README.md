# MCD Brackets - Tournament Management System

Ein vollständiges Turnierverwaltungssystem mit Event-basiertem Meisterschafts-Punktesystem, entwickelt mit [brackets-manager](https://www.npmjs.com/package/brackets-manager).

## Features

### 🏆 Turnier-Formate
- **Single Elimination** - K.O.-System
- **Double Elimination** - Doppel-K.O. mit Winner & Loser Bracket
  - Optional: Grand Final (Simple oder Double)
  - Automatische BYE-Generierung für Power-of-2
- **Round-Robin** - Jeder gegen Jeden

### 🎯 Event-Management
- **Multi-Turnier Events** - Mehrere Turniere pro Event
- **Zufällige Paarungen** - Fisher-Yates Shuffle beim Turnier-Start
- **Event-Filter** - Turniere nach Events filtern
- **Gesamt-Rankings** - Event-übergreifende Ranglisten

### 🏅 Punktesystem & Rankings
- **Platzierungsbasierte Punkte:**
  - Platz 1: 30 Punkte
  - Platz 2: 22 Punkte
  - Platz 3: 16 Punkte
  - Platz 4: 12 Punkte
  - Platz 5: 9 Punkte
  - Platz 6: 7 Punkte
  - Platz 7: 5 Punkte
  - Platz 8: 3 Punkte
  - Platz 9-12: 2 Punkte
  - Platz 13-16: 1 Punkt
  - Platz 17+: 1 Punkt
- **Korrekte Double Elimination Platzierung** - Basierend auf erreichten Runden, nicht nur Wins/Losses
- **Event-Meisterschaft** - Gesamtpunkte über alle Turniere eines Events
- **Einzelturnier-Rankings** - Detaillierte Statistiken pro Turnier

### 📊 Bracket-Visualisierung
- **Interactive Brackets** mit [brackets-viewer.js](https://github.com/Drarig29/brackets-viewer.js)
- **Dark Theme** - Vollständig angepasstes Farbschema
- **Click-to-Win** - Gewinner direkt im Bracket auswählen
- **Smart Validierung** - Unterscheidung zwischen BYE und TBD Matches
- **Scroll-Preservation** - Position bleibt bei Updates erhalten

### ⚙️ Turnierverwaltung
- **Auto-IDs** - Automatische Turnier-ID-Vergabe
- **Teilnehmer bearbeiten** - Mit automatischer Bracket-Regeneration
- **Bracket zurücksetzen** - Mit neuer zufälliger Auslosung
- **Match-Filter** - Nur offene Matches, TBD ausblenden
- **Collapsible Sections** - Aufgeräumte Benutzeroberfläche

## Installation

### Option 1: NPM (Development)

```bash
npm install
```

### Option 2: Docker (Production)

**Mit vorgebautem Image von GitHub Container Registry:**
```bash
docker pull ghcr.io/lordimac/mcd.brackets:latest
docker run -d -p 3000:3000 -v $(pwd)/db.json:/app/db.json ghcr.io/lordimac/mcd.brackets:latest
```

**Mit Docker Compose:**
```bash
# Bearbeite docker-compose.yml und kommentiere die image-Zeile ein
docker-compose up -d
```

**Lokales Build:**
```bash
docker build -t mcd-brackets .
docker run -d -p 3000:3000 -v $(pwd)/db.json:/app/db.json mcd-brackets
```

## Verwendung

### Web-Server starten

```bash
npm run server
```

Öffne [http://localhost:3000](http://localhost:3000) im Browser.

### Development Mode mit Auto-Reload

```bash
npm run server:watch
```

## Webinterface

### Turnier erstellen
1. Event auswählen oder neues erstellen
2. Turnier-Name eingeben
3. Typ wählen (Single/Double Elimination)
4. Teilnehmer eingeben (einer pro Zeile)
5. Optional: Grand Final Type für Double Elimination

**Features:**
- ✅ Automatische BYE-Generierung für Power-of-2
- ✅ Zufällige Paarungen (Fisher-Yates Shuffle)
- ✅ Auto-generierte Turnier-IDs

### Bracket anzeigen & bearbeiten
- **Gewinner auswählen**: Klick auf Match → Wähle Gewinner
- **Smart Validierung**:
  - 🚫 BYE-Matches: "Dieses Match hat einen BYE und wird automatisch entschieden"
  - ⏳ TBD-Matches: "Dieses Match ist noch nicht spielbar. Warte auf die vorherigen Matches"

### Rankings anzeigen
- **Einzelturnier**: Rangliste für ein spezifisches Turnier
- **Event-Gesamt**: Kombinierte Rangliste über alle Turniere eines Events
- **Top-3 Highlighting**: Gold/Silber/Bronze Hintergrund und Medaillen

### Matches verwalten
- **Filter**: Nach Stage/Event filtern
- **Nur offene Matches**: Zeige nur spielbare Matches
- **TBD ausblenden**: Verstecke noch nicht bestimmte Paarungen

## REST API Endpoints

### Stages (Turniere)
- `GET /api/stages` - Alle Stages abrufen
- `POST /api/stages` - Neue Stage erstellen (mit Event-Namen)
- `DELETE /api/stages/:id` - Stage löschen (inkl. Teilnehmer-Cleanup)

### Matches
- `GET /api/matches` - Alle Matches abrufen
- `PUT /api/matches/:id` - Match-Ergebnis aktualisieren

### Participants
- `GET /api/participants` - Alle Teilnehmer abrufen
- `DELETE /api/participants/:id` - Teilnehmer löschen

### Viewer Data
- `GET /api/viewer-data/:stageId` - Komplette Turnierdaten für Bracket-Viewer
  - Enthält: stage, matches, participants (gefiltert nach tournament_id)

### Standings (NEU)
- `GET /api/standings/:stageId` - Korrekte Platzierungen basierend auf Bracket-Struktur
  - Berücksichtigt Double Elimination korrekt
  - Sortiert nach erreichter Runde und Ergebnis

### Beispiel: Stage mit Event erstellen

```bash
curl -X POST http://localhost:3000/api/stages \
  -H "Content-Type: application/json" \
  -d '{
    "tournamentId": 1,
    "name": "Woche 1",
    "type": "double_elimination",
    "seeding": ["Player1", "Player2", "Player3", "Player4", "Player5"],
    "settings": { "grandFinal": "simple" },
    "eventName": "Herbst Liga 2025"
  }'
```

## Technologien

### Backend
- **Node.js** 18+
- **Express** 5.1.0
- **TypeScript** 5.3.2
- **ts-node** für Development
- **nodemon** für Auto-Reload

### Frontend
- **Vanilla JavaScript** - Keine Frameworks
- **HTML5** & **CSS3**
- **brackets-viewer.js** für Visualisierung

### Tournament Engine
- **brackets-manager** 1.8.1
- **brackets-json-db** 1.0.2

### Styling
- **Dark Theme** (#0f172a Background)
- **Custom CSS** (1089 Zeilen)
- **Responsive Design**
- **Collapsible Sections**

## Datenstruktur

Die Daten werden in `db.json` gespeichert mit folgenden Tabellen:

- **participant**: `{id, tournament_id, name}`
- **stage**: `{id, tournament_id, name, type, event_name, settings}`
- **match**: `{id, stage_id, round_id, group_id, opponent1, opponent2}`
- **group**: Bracket-Gruppen (Winner/Loser/Finals)
- **round**: Runden innerhalb der Gruppen

## Platzierungsberechnung

### Double Elimination
Die Platzierung wird **nicht** nur durch Wins/Losses bestimmt, sondern durch:
1. **Erreichte Gruppe** (Finals > Loser Bracket > Winner Bracket erste Runde)
2. **Gewonnen/Verloren** in der letzten Runde
3. **Gesamte Wins** als Tiebreaker
4. **Gesamte Losses** (weniger = besser) als finaler Tiebreaker

**Beispiel:**
- Grand Final Gewinner (kam aus LB mit 2 Losses) = **Platz 1** ✅
- Grand Final Verlierer (kam aus WB mit 1 Loss) = **Platz 2**
- LB Final Verlierer = **Platz 3**

### Single Elimination
Einfache Sortierung nach Wins → Losses.

## Projekt-Struktur

```
mcd.brackets/
├── src/
│   └── server.ts          # Express Server mit REST API
├── public/
│   ├── index.html         # Webinterface (243 Zeilen)
│   ├── app.js            # Frontend-Logik (1162 Zeilen)
│   └── styles.css        # Dark Theme Styling (1089 Zeilen)
├── db.json               # Turnierdaten (JSON-Datenbank)
├── package.json
└── README.md
```

## Development

### Code-Stil
- **TypeScript** für Backend
- **ES6+** für Frontend
- **Kein Framework** - Pure Vanilla JS
- **Modularer Aufbau** mit klaren Funktionen

### Key Functions (Frontend)

**Turniere:**
- `createTournament()` - Turnier mit Random Seeding erstellen
- `resetBracket()` - Bracket neu auslosen
- `editParticipants()` - Teilnehmer bearbeiten + regenerieren
- `deleteStage()` - Turnier inkl. Participants löschen

**Visualisierung:**
- `viewBracket()` - Bracket anzeigen mit Scroll-Preservation
- `showQuickWinnerSelection()` - Gewinner-Modal mit Validierung

**Rankings:**
- `viewRankings()` - Einzelturnier-Rangliste
- `viewEventRankings()` - Event-Gesamt-Rangliste mit Punkten

**Events:**
- `displayEvents()` - Events-Übersicht
- `updateEventDropdown()` - Event-Auswahl aktualisieren

### Key Functions (Backend)

**Platzierungsberechnung:**
- `calculatePlacements()` - Korrekte Platzierung für DE/SE
- Trackt letzte gespielte Runde und Ergebnis
- Berücksichtigt Bracket-Struktur (Groups/Rounds)

## Lizenz

ISC
