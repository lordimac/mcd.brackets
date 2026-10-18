# CLAUDE.md

Turnierverwaltung (Single/Double Elimination, Round Robin) mit Event-basiertem Meisterschafts-Punktesystem. Express-Backend auf Basis von `brackets-manager`, Vanilla-JS-Frontend mit `brackets-viewer`.

## Befehle

```bash
npm install
npm run server         # Dev-Server (tsx src/server.ts) → http://localhost:3000
npm run server:watch   # Dev mit tsx watch Auto-Reload
npm test               # Node-Testrunner über tsx (src/**/*.test.ts)
npm run build          # tsc (TypeScript 7, nativ) → dist/ — Typprüfung inkl. Tests
npm start              # node dist/server.js
npm run vendor         # kopiert brackets-viewer, html2canvas, jsPDF aus node_modules nach public/lib/
npm run docker:rebuild # Image bauen + Container mcd-brackets neu erstellen (Port 3001, ./data)
```

- **Nach jeder abgeschlossenen Änderung `npm run docker:rebuild` ausführen** (Wunsch des Users). Port 3000 ist durch einen anderen Container belegt. Das Skript baut über den buildx-Builder `mcd-dns` mit festen DNS-Servern (`scripts/buildkitd.toml`), weil die DNS-Auflösung in Docker Desktop hier nicht funktioniert und `docker build`/`docker compose build` bei `npm ci` hängen bleiben.

- Umgebungsvariablen: `PORT` (3000), `DATA_DIR` (`./data`). Für manuelle Tests einen Server mit eigenem `DATA_DIR` und Port starten, nie gegen die echte `data/db.json` schreiben.
- Nach jedem Update von brackets-viewer/html2canvas/jspdf `npm run vendor` ausführen — der Browser lädt nur die Kopien in `public/lib/`.
- TypeScript 7 hat keine JS-Compiler-API mehr → kein `ts-node`; Ausführung von TS-Dateien über `tsx`.
- `package.json` erzwingt per `overrides` `uuid@^11.1.1` (Sicherheitsfix für brackets-manager).
- `brackets-model` ist devDependency, nur für Typen (`import type`); Ausnahme: Tests importieren `Status`.

## Architektur

**Backend** (`src/`):
- `db.ts`: `JsonDatabase` (brackets-json-db → node-json-db, hält Daten **im Speicher**) auf `DATA_DIR/db.json`, typisiert als `CrudInterface` (die eigenen Typen von JsonDatabase sind zu lose). Immer über `getStorage()`/`getManager()` zugreifen, nie Instanzen cachen — `replaceDatabase()` erzeugt sie neu. `withLock()` serialisiert alle schreibenden Routen, `withRollback()` stellt bei Fehlern den Snapshot wieder her.
- `server.ts`: Routen. Fehler per `throw new HttpError(status, msg)`; Express 5 leitet abgelehnte Promises an den JSON-Error-Handler am Ende weiter (keine try/catch in Routen nötig).
- `stages.ts`: `createStage()`/`deleteStage()`/`findStage()` — gemeinsame Bausteine für Anlegen, Neu-Erzeugen und Löschen. Beim Ergänzen von `event_name` die Stage **frisch aus dem Storage lesen**: das Rückgabeobjekt von `create.stage` hat kein `settings.seedOrdering`, ein Zurückschreiben würde es löschen und Double Elimination unspielbar machen (Regressionstest `stages.test.ts`).
- `lan.ts` (reine Logik), `lan-store.ts` (Persistenz), `lan-routes.ts` (Router unter `/api`): Events mit Domain, DNS-Server und 3 IP-Bereichen; Teilnehmer (`attendee`) mit `slot` → IP *i* = `ranges[i].start + slot`, DNS-Namen `hostname`, `hostname2`, `hostname3` (+ `.domain`). Nickname und alle abgeleiteten DNS-Namen sind je Event eindeutig. Tabellen `event`/`attendee` liegen in derselben `db.json` (über `getAppStore()`, `ensureAppTables()` legt sie an). `syncEventsFromStages()` erzeugt Event-Datensätze für alte Turniere (beim Start und nach Restore).
- Bulk-Import `importBulk()`: Zeilen `Nachname, Vorname // Clan-Nickname` (`parseBulkLine`), jede Zeile gegen Bestand und vorherige Zeilen geprüft (bei Doppelten gewinnt die frühere Zeile), danach die gültigen Zeilen per `compareByLastName()` sortiert (Nachname, Vorname, Nickname; deutsche Sortierung; ohne Nachname zuletzt) und erst dann die Slots vergeben — die Antwort listet sie in dieser Reihenfolge, Fehlerzeilen danach; `dryRun` für die Vorschau im Frontend — Vorschau und Import nutzen denselben Server-Code.
- Teilnehmer haben `clan` als eigenes Feld; Anzeige- und Spielername ist `displayName()` = `Clan-Nickname` (ohne Clan nur Nickname). DNS-Namen kommen nur aus dem Nickname. Beim Bulk-Import trennt `splitClanNickname()` am ersten Bindestrich. Alte Datensätze ohne `clan` werden als leerer Clan behandelt (`?? ''`).
- **Admin-Login** (`src/auth.ts`): `ADMIN_PASSWORD` gesetzt → `requireAdminForChanges` lässt unter `/api` nur GET/HEAD (außer `/backup`) sowie `/auth`, `/login`, `/logout` ohne Sitzung durch. Sitzung = signiertes Cookie `mcd_admin` (`<ablauf>.<hmac>`, 7 Tage, HMAC-Schlüssel aus dem Passwort). Frontend: `loadAuth()` setzt `body.read-only`, Elemente mit Klasse `admin-only` werden dann ausgeblendet — neue Bearbeiten-Elemente immer mit `admin-only` markieren. `.env` (gitignored) liefert das Passwort für `docker:rebuild`/compose.
- **OPNsense** (`src/opnsense.ts` Logik + HTTP-Client, `src/opnsense-routes.ts`, `public/opnsense.js`): Zugangsdaten als ein Datensatz in Tabelle `opnsense` (Weboberfläche, gilt für alle Events). Das Secret verlässt den Server nie (`settingsView()`), leeres Secret beim Speichern = beibehalten. `/api/opnsense*` ist auch für GET admin-pflichtig (`isProtectedRead` in `auth.ts`). `desiredRecords()` → 3 A-Records pro Teilnehmer, Beschreibung `mcd-brackets #<eventId>: <Anzeigename> (<Bereich>)`; `planSync()` vergleicht mit `search_host_override` (inkl. Aliase in `_children`) → create/update/delete/conflict/unchanged. Nur markierte Einträge werden geändert/gelöscht, Einträge anderer mcd-Events mit gleichem Namen werden übernommen, fremde sind Konflikte. `applyPlan()` ruft danach `unbound/service/reconfigure`. API-Pfade in snake_case wie in den OPNsense-ACLs; geprüft gegen den Quellcode von OPNsense 26.7 (Felder `enabled`, `hostname`, `domain`, `rr`, `server`, `description`). `OpnsenseError` → HTTP 502. Tests mit nachgebautem API-Server in `opnsense.test.ts`.
- **In Gedenken**: Event-Feld `memorial` (Namen). Sie werden beim Anlegen/Neu-Auslosen nach den Spielern (vor den BYEs) gelost und an der Stage als `memorial_names` gespeichert. `resolveMemorialMatches()` (nach Anlegen und nach jedem Ergebnis) lässt sie jedes spielbare Match per Forfeit verlieren; zwei Gedenk-Einträge gegeneinander → der erste kommt weiter. Ranglisten schließen sie aus. Namen dürfen nicht mit Teilnehmer-Anzeigenamen kollidieren (`assertNotMemorial`).
- Spieler eines Turniers = alle Teilnehmer seines Events als `displayName` (`playerNamesForEvent` liefert `{ players, memorial }`). Änderungen an Clan, Nickname oder Event-Name werden in die Turniere übernommen. `ValidationError` → HTTP 400.
- `seeding.ts`: `buildSeeding()` mischt (Fisher-Yates) und füllt SE/DE mit `null` (BYE) auf die nächste Zweierpotenz.
- `standings.ts`: `getStandings()` → Platzierung + `pending` + `points`. DE/SE über `calculatePlacements()` (DE: höchste erreichte Gruppe → letztes Match gewonnen/verloren → Runde → Wins → Losses), RR über `manager.get.finalStandings` mit 3/1/0.
- Routen: `GET/POST /api/stages`, `GET/DELETE /api/stages/:id`, `POST /api/stages/:id/regenerate`, `GET /api/stages/:id/matches`, `GET /api/matches`, `PUT /api/matches/:id`, `GET/POST /api/participants`, `DELETE /api/participants/:id`, `GET /api/viewer-data/:stageId`, `GET /api/standings/:stageId`, `GET /api/backup`, `POST /api/restore`.

**Frontend** — `public/index.html`, `public/app.js`, `public/styles.css`. Kein Build-Step, keine Module; Funktionen sind global und werden per `onclick` im HTML aufgerufen. Drittlibs liegen lokal in `public/lib/` (bewusst kein CDN).
- **Jede Nutzerangabe in `innerHTML`-Templates durch `escapeHtml()`**. Strings für `onclick` über `data-*`-Attribute übergeben, nicht in JS-String-Literale einbetten.
- Icons: SVG-Sprite am Anfang von `index.html` (`<symbol id="i-…">`), im JS per `icon('name')`. Keine Emojis als Icons.
- Styling: Design-Tokens als CSS-Variablen in `:root` von `styles.css` (Orange `--primary-color` = einzige Akzentfarbe für Hauptaktionen). Nur hex/rgba-Farben — html2canvas (Export) versteht kein `color-mix()`/`oklch()`. Export-Hintergrund `EXPORT_BACKGROUND` in `app.js` muss zu `--bg-color` passen.
- Buttons mit Icon: veränderlichen Text in `<span class="btn-label">` legen und per `setButtonLabel()` ändern, nie `textContent` des Buttons setzen.
- Layout: einspaltig. Oben einklappbare Karten („Neues Turnier“ bzw. Event-Leiste mit „Konfiguration“) über `toggleSection(id, open?)`; der Zustand wird in `localStorage` gemerkt (`COLLAPSIBLE_SECTIONS` in `app.js`).
- Teilnehmerliste: getrennte Spalten Vorname/Nachname/Clan/Nickname, sortierbar über `th.sortable[data-sort]` (`attendeeSort`), Filter per Suche und Clan-Auswahl (`__all__` = alle, `''` = ohne Clan).
- Cache-Busting: `server.ts` liefert `index.html` selbst aus (`no-store`) und hängt an alle JS/CSS-URLs `?v=<version>-<startzeit>` — neue Script-/CSS-Dateien in `index.html` werden automatisch erfasst, solange sie als `src="datei.js"` bzw. `href="datei.css"` (optional unter `lib/`) eingebunden sind.
- Globaler State: `stages`, `matches`, `participants` (via `loadStages/loadMatches/loadParticipants`).
- Zwei Ansichten per Hash: `#turniere` (Standard) und `#teilnehmer` (`showView()`). Teilnehmer-Verwaltung in `public/lan.js`, nutzt `apiFetch`, `escapeHtml`, `icon`, `openModal`/`closeModal` und `lanEvents` aus `app.js`.
- IP-Zettel: `public/ip-slips.js` zeichnet per jsPDF ein Vektor-PDF (A4, eine Seite pro Teilnehmer; `buildSlipsPdf(event, attendees)`). Nur jsPDF-Standardschriften (helvetica/courier, WinAnsi: Umlaute ok, keine Emojis/Sonderzeichen außerhalb Latin-1). Subnetzmaske, Router/Gateway und DNS stehen immer drauf (leer = Linie zum Ausfüllen), die Domain nur wenn gesetzt. Optionales Event-Logo (`logo`, PNG/JPEG-Data-URL, Upload im Browser zu PNG ≤1000 px konvertiert) oben rechts in einem Hochformat-Rahmen.
- **Druckrand:** Alle PDFs halten mind. 5 mm Abstand zur Blattkante (nicht randlos druckbar). Zettel-Inhalte liegen innerhalb `SLIP.margin` (18 mm); Bracket/Rangliste über `addCanvasToPdf()` in `app.js` (`PRINT_MARGIN_MM`, A4, Rangliste ggf. mehrseitig).
- Mit `let` deklarierte Globals (z.B. `attendees`) hängen nicht an `window` — in Tests per `iframe.contentWindow.eval(...)` ansprechen.
- `createTournament` schickt nur Event + Modus (Spieler kommen vom Server); `resetBracket` → `regenerateStage()` → `POST /api/stages/:id/regenerate`.
- `viewBracket` (brackets-viewer, Click-to-Win → `showQuickWinnerSelection` → `updateMatchQuick`), `viewRankings`/`viewEventRankings` → `fetchStandings()` + `showRankings()`.
- Export: `exportBracketAsImage/Pdf`, `exportRankingsAsImage/Pdf` (html2canvas + jsPDF).

## Domänenlogik

- **Punktesystem** nur in `src/standings.ts` (`POINTS_SYSTEM`, Platz 1–16, danach 1 Punkt). Bei Änderungen die README-Tabelle mitpflegen.
- **Event-Rankings** aggregiert der Browser: alle Stages mit gleichem `event_name` → je `/api/standings` → `points` pro Teilnehmername summieren.
- `event_name` ist ein **eigenes Feld** an der Stage (nicht Teil von brackets-manager) und wird nach `manager.create.stage` per `storage.update` ergänzt.
- Ein Turnier = eine Stage; Participants hängen per `tournament_id` daran. Die Turnier-ID vergibt der Server (`max+1` im Lock). Stage-IDs werden von brackets-manager nach dem Löschen wiederverwendet.
- Round Robin braucht `groupCount`; `createStage()` setzt standardmäßig 1.
- Datenmodell `db.json`: `participant`, `stage`, `group`, `round`, `match`, `match_game`.

## Konventionen

- UI-Texte, README und Commit-Messages auf Deutsch. Commit-Stil: `chore: …`, `fix: …` bzw. Release-Commits `vX.Y.Z-beta: …`.
- Version steht in `package.json` **und** README (`**Version:**`) — beide aktualisieren.
- Deployment: GitHub Action baut Multi-Arch-Image nach `ghcr.io/lordimac/mcd.brackets` bei Push auf `main` und `v*`-Tags.
- Laufzeitdaten liegen in `data/` (gitignored, Docker-Volume `/app/data`). Nie echte `db.json` committen.
- Die `db.json` im Repo-Root (gitignored) enthält echte Altdaten (Event „mcd.lan 2025“), nicht löschen.

## Bekannte Grenzen

- OPNsense-Abgleich ist nur gegen eine nachgebaute API getestet, nicht gegen eine echte Firewall.
- Zugriffskontrolle nur über ein gemeinsames Admin-Passwort (keine Benutzerkonten); Lesen ist immer öffentlich. HTTPS übernimmt ggf. ein Reverse-Proxy.
- Event-Rankings fassen Teilnehmer über den Namen zusammen; Tippfehler ergeben getrennte Einträge.
