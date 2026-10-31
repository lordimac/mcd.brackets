# MCD Brackets — Tournament Management System

Ein vollständiges Turnierverwaltungssystem mit Event-basiertem Meisterschafts-Punktesystem, entwickelt mit [brackets-manager](https://www.npmjs.com/package/brackets-manager).

**Version:** 0.27.0-beta

---

## Screenshots

**Teilnehmer-Verwaltung** — Teilnehmer mit Clan, Nickname, drei IP-Adressen und DNS-Namen; sortier- und filterbar, Export als IP-Zettel (PDF), CSV, hosts oder BIND-Zone; Kurzanleitung „feste IP-Adresse“ für Windows und macOS als PDF

![Teilnehmer-Verwaltung](docs/screenshots/teilnehmer.png)

**Sitzplan** — Räume frei aus Tischreihen, U-Formen und Flächen zusammenstellen, Plätze per Klick vergeben; die Suche zeigt, wer wo sitzt

![Sitzplan](docs/screenshots/sitzplan.png)

**Bracket** — Double Elimination mit Click-to-Win; ein Eintrag „In Gedenken“ steht an Stelle eines BYE, sein Gegner kommt automatisch weiter

![Bracket](docs/screenshots/bracket.png)

<table>
  <tr>
    <td width="62%" valign="top"><b>Gesamtwertung eines Events</b><br><img src="docs/screenshots/rangliste.png" alt="Rangliste"></td>
    <td width="38%" valign="top"><b>IP-Zettel (A4-PDF pro Teilnehmer)</b><br><img src="docs/screenshots/ip-zettel.png" alt="IP-Zettel"></td>
  </tr>
</table>

<sub>Alle Namen in den Screenshots sind Demo-Daten.</sub>

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
- **IP-Zettel (PDF)** — ein DIN-A4-Blatt pro Teilnehmer mit Logo (oben rechts, Hoch- oder Querformat je nach Bild), Clan-Nickname, Name, den 3 IPs samt DNS-Namen, den Netzwerk-Einstellungen und optional dem WLAN (SSID und Passwort); einzeln (Icon in der Liste) oder für alle als ein PDF. Alle PDFs halten einen Druckrand von mind. 5 mm ein
- **Anleitung (PDF)** — je eine Seite für Windows (10/11) und macOS (ab 13): feste IP-Adresse einstellen, mit Subnetzmaske, Gateway und DNS des Events in nachgezeichneten Dialogen, Test per ping und Rückstellung nach der LAN
- **Exporte** — CSV (Excel), hosts-Datei (dnsmasq/Pi-hole), BIND-Zone
- **Automatische Spieler** — Turniere nehmen alle Teilnehmer ihres Events (per Nickname). Kommen Teilnehmer hinzu oder fallen weg, passen sich die Turniere des Events sofort an, ohne dass gespielte Ergebnisse verloren gehen:
  - *Noch nicht begonnen:* Neue Spieler bekommen einen freien Platz (BYE), Weggefallene machen ihren Platz frei; die Auslosung bleibt. Muss das Bracket größer oder kleiner werden, wird neu ausgelost
  - *Läuft schon:* Neue Spieler bekommen einen freien Platz in Runde 1, solange dessen Folge-Matches noch nicht gespielt sind; alle Ergebnisse bleiben erhalten. Bei Round Robin bekommen sie Matches gegen alle. Gibt es keinen freien Platz mehr, können sie nicht mehr einsteigen (Hinweis; „Neu auslosen“ nimmt alle auf, verwirft aber die Ergebnisse)
  - *Weggefallene in laufenden Turnieren* verschwinden ebenfalls aus dem Bracket: Ihr Platz wird ein BYE, oder ein neu hinzugekommener Teilnehmer übernimmt ihn. Ergebnisse, an denen sie beteiligt waren, und was darauf aufbaute, werden verworfen (der Hinweis nennt die Anzahl)
  - Das gilt auch für Änderungen an der Liste „In Gedenken“

### 🕒 Zeitplan (Reiter „Zeitplan“)
- Zeitplan je Event, für alle lesbar, für Admins bearbeitbar: eigene Einträge mit Uhrzeit (Beginn, optional Ende — ein früheres Ende ist der nächste Morgen), Titel, Info (z. B. Ort) und Kategorie (Essen, Programm, Turnier, Sonstiges — je eine Farbe)
- Wiederholungen: Im Eintrag die Tage ankreuzen, an denen er gilt (z. B. Frühstück Sa–Mo) — ein Eintrag, der an jedem gewählten Tag erscheint. Zur Auswahl stehen die Tage des Event-Zeitraums
- Die Turnierrunden kommen automatisch aus den Spielzeiten der Turniere, gleiche Zeiten zusammengefasst („Spielrunde 2 — bis 21:00: Jenga Runde 2 · UNO Winner Bracket Runde 2 …“)
- Beliebig viele Hinweise (Überschrift optional, Text), z. B. Nachtruhe, Notfallnummer
- Nach Tagen gegliedert, Vergangenes abgeblendet; Tage außerhalb des Event-Zeitraums (z. B. alte Spielzeiten) sind markiert
- „Zeitplan (PDF)“: A4 zum Aushängen mit Logo, allen Tagen des Zeitraums und den Hinweisen (mehrseitig, wenn nötig)

### 🍔 Burger-Designer (Reiter „Burger“)
- Jeder stellt sich seinen Burger per Klick zusammen (Größe, Patty, Käse, Belag, Sauce mit „extra viel“, Brötchen) und sieht ihn dabei als gezeichneten Burger wachsen; dazu „für wen“ (vorausgewählt, wenn das Gerät über seine IP erkannt wird) und eine Anmerkung
- Eigene Bestellungen lassen sich ändern oder stornieren, solange sie noch nicht gedruckt sind (der Browser merkt sich die Bestellung; ein über die IP erkanntes Gerät darf auch so). Höchstens 3 offene Bestellungen je Teilnehmer
- Admins: Liste aller Bestellungen mit Zusammenfassung für den Grill (z. B. „5× Patty Fleisch, 2× Cheddar …“), Schalter „Bestellung offen“, Zutaten bearbeiten (eigene Kategorien und Zutaten mit Kurzform fürs Etikett, Farbe und Form für die Zeichnung, „da“ zum Ausschalten, wenn etwas aus ist)
- Etiketten für den DYMO LabelWriter 450 (DYMO 11354, 57 × 32 mm): „Neue drucken“ druckt alle noch nicht gedruckten Bestellungen — Nummer, Name, Kurzfassung („Einfach, Fleisch, Blauschimmel, Zwiebeln, Bacon, extra viel Burgersauce“) und Anmerkung. Gedruckte werden nicht noch einmal gedruckt; einzeln nachdrucken oder zurück in die Warteschlange geht über die Liste. Mit „Neue automatisch drucken“ druckt der Grill-PC neue Bestellungen von selbst (ganz ohne Druckdialog mit Chrome `--kiosk-printing`)
- Ausgabe wählbar: Bestellungen gehen an den **Etikettendrucker**, an die **Tablet-Anzeige** oder an beides (Schalter in der Bestellliste)
- Tablet-Anzeige für den Grill: Vollbild mit den Spalten „Neu“ und „In Arbeit“, große Karten mit Nummer, Name, gezeichnetem Burger, Kurzfassung und Anmerkung; „Zubereiten“ → „Fertig“ (rückgängig über „Zuletzt fertig“). Ton bei neuen Bestellungen, länger als 20 Minuten wartende werden rot, der Bildschirm bleibt an. Das Tablet merkt sich die Anzeige und öffnet sie beim nächsten Aufruf von selbst. Teilnehmer sehen „beim Grill“ bzw. „fertig“

### 🏅 Punktesystem & Rankings
Platzierungsbasierte Punkte, gleich für alle Turniere. Unter „Turniere“ › „Punktesystem“ lassen sich die Punkte für Platz 1–10 und „ab Platz 11“ anpassen (nur Admin). Unter jedem Feld steht der Standardwert, „Standardwerte eintragen“ setzt alle zurück. Die Punkte werden bei jedem Abruf einer Rangliste aus der Platzierung berechnet. Eine Änderung gilt deshalb sofort für alle Turniere, auch für laufende und abgeschlossene.

Standardwerte:

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
| 9–10  | 2      |
| 11+   | 1      |

- **Geteilte Plätze** — Wer in derselben Runde ausscheidet, teilt sich den Platz (z. B. „5–6“) und bekommt den gerundeten Durchschnitt der Punkte dieser Plätze (5–6 → 8, 9–12 → 2)
- **Punkte erst bei feststehendem Platz** — Wer noch im Turnier ist, steht als „offen“ ohne Punkte in der Liste; ein noch nicht gespieltes Turnier vergibt keine Punkte
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

### 🔒 Admin-Passwort
- Mit der Umgebungsvariable `ADMIN_PASSWORD` dürfen nur angemeldete Admins Turniere, Ergebnisse, Teilnehmer und Event-Einstellungen ändern sowie Backups laden/einspielen
- Ansehen (Brackets, Ranglisten, Teilnehmerliste, Exporte) bleibt ohne Anmeldung möglich; Bearbeiten-Elemente und die IP-Zettel werden dann ausgeblendet
- Anmeldung über „Anmelden“ in der Fußleiste, gültig 7 Tage (signiertes HttpOnly-Cookie); ein neues Passwort beendet alle Sitzungen
- Ohne `ADMIN_PASSWORD` darf jeder bearbeiten (wie bisher)
- Nach 10 falschen Passwörtern innerhalb von 15 Minuten ist die Anmeldung für diese IP-Adresse vorübergehend gesperrt (`429`)
- Änderungen werden nur von den Seiten der App selbst angenommen: Ein Browser auf einer fremden Seite (auch einer anderen App auf demselben Host) bekommt `403` (Schutz gegen CSRF)
- Sicherheits-Header (Content-Security-Policy, kein Einbetten in Frames, `nosniff`); hinter einem HTTPS-Reverse-Proxy mit `TRUST_PROXY=true` bekommt das Sitzungs-Cookie das `Secure`-Flag
- Einrichtung siehe [Admin-Passwort einrichten](#admin-passwort-einrichten)

### 👋 Willkommens-Seite (Startseite)
- Reiter „Willkommen“ (auf dem Handy „Start“) ist die Startseite: erkennt das Gerät an seiner **IP-Adresse** — IP = Teilnehmer — und begrüßt mit Name, Clan, Nickname, Sitzplatz und welcher der drei PCs das Gerät ist
- **Netzwerk-Check:** IP-Adresse passt / liegt im Event-Bereich, ist aber niemandem zugeordnet / gehört nicht zum Event (z.B. noch DHCP); Gateway im selben Netz; DNS-Name beim DNS-Server des Events eingetragen (der Server fragt den DNS-Server direkt, wenn er ihn erreicht); Namensauflösung, wenn die Seite über einen Namen der Event-Domain aufgerufen wurde. Daneben die Soll-Werte (IP, Maske, Gateway, DNS), alle Adressen des Teilnehmers, WLAN und die Anleitung „feste IP“ als PDF
- **Deine Turniere:** nächstes Match mit Gegner, Runde und Spielzeit, Platzierung, Sprung ins Bracket
- Das erkannte Gerät ist auch sonst markiert: Name oben rechts in der Leiste, eigene Zeile in der Teilnehmerliste, eigener Platz im Sitzplan, eigener Name im Bracket
- Je Event in der Konfiguration (Block „Netzwerk“) mit „IP-Erkennung“ ein-/ausschaltbar, Standard: ein. Gibt es mehrere Events, gilt ein laufendes (Zeitraum) vor dem neuesten
- Admins können unter „Ansicht testen“ die Seite für eine beliebige IP ansehen
- **Admin per IP:** Im Dialog „Teilnehmer bearbeiten“ gibt es den Haken „Admin“. Ein so markierter Teilnehmer ist von seinen IP-Adressen aus automatisch als Admin angemeldet, ohne Passwort (nur solange die IP-Erkennung des Events an ist). Das Admin-Passwort bleibt daneben gültig. Abmelden geht dann nicht, der Haken wird nicht in andere Events übernommen, und wer Admin ist, sehen nur Admins. **Achtung:** Eine IP-Adresse kann sich jeder im LAN selbst eintragen. Wer die IP eines Admins übernimmt (z. B. wenn dessen PC aus ist), ist Admin. Den Haken deshalb sparsam setzen
- **Voraussetzung:** Der Server muss die echte Client-IP sehen. Hinter einem Reverse-Proxy `TRUST_PROXY` setzen. Docker unter Linux mit Port-Mapping reicht die Client-IP durch; Docker Desktop (macOS/Windows) nicht — dort sehen alle Geräte gleich aus

### 🪑 Sitzplan
- Reiter „Sitzplan“: pro Event beliebig viele Räume (z.B. Halle, Nebenraum), jeweils eine freie Fläche (Breite × Tiefe in Feldern, 1 Feld ≈ ein Platz)
- **Baukasten:** Tischreihe (Plätze beidseitig, einseitig oder keine), Doppelreihe (Tische Rücken an Rücken), U-Form (Plätze innen), Reihenblock (mehrere Doppelreihen), beschriftete Flächen (Bühne, Orga, Eingang …) und **Türen** in der Wand — mit Breite, Anschlag und Öffnungsrichtung nach innen oder außen (der Rand um den Raum ist nur für nach außen öffnende Türen da; der Schwenkbereich nach innen bleibt frei, Tische darin werden rot markiert)
- Gruppen frei **verschieben** (ziehen oder Pfeiltasten), in 90°-Schritten **drehen**, duplizieren, löschen; mehrere per Shift-Klick oder Rahmen markieren und gemeinsam bewegen/drehen — so entstehen U-Formen, Tische nur in der Raummitte oder beliebige Kombinationen. Überlappungen werden rot markiert
- **Platznummern frei gestaltbar:**
  - automatisch 1, 2, 3 … in der Reihenfolge der Gruppen („Nr. ↑/↓“, „Nach Position nummerieren“), innerhalb einer Reihe der Reihe nach, rückwärts, rundherum oder rundherum rückwärts („Nummern ⇄“)
  - **eigener Bereich pro Reihe** über „Start-Nr.“ (z.B. 101, M1 oder A-01) — die Reihe zählt in ihrer Richtung davon aus hoch (Ziffer am Ende)
  - automatische Nummern überspringen die Startbereiche, doppelte Nummern werden rot markiert und oben genannt
  - Belegungen hängen am Platz und bleiben beim Verschieben, Drehen und Umnummerieren erhalten
- Darstellung: auf den Tischen steht nur der Nickname (bis zu zwei Zeilen, sonst am Ende mit „…“ gekürzt); Platznummer, Clan-Nickname und Name zeigt ein Tooltip über Tisch oder Stuhl (auf dem Handy per Tippen). Im Modus „Raum gestalten“ zeigen die Tische ihre Nummer. Nummerierte Felder sind die Tische (ein Tisch = ein Platz, belegt orange umrandet), daneben stehen Stühle (von oben gesehen), die zum jeweiligen Tisch zeigen — bei Tischen Rücken an Rücken zwei Stühle pro Feld; Legende unter dem Plan
- Admins vergeben Plätze per Klick auf den Platz oder erst Teilnehmer aus „Ohne Platz“ wählen, dann Platz anklicken. „Freie Plätze automatisch belegen“ setzt alle ohne Platz, Clans zusammen
- Jeder kann suchen, wer wo sitzt (Name, Clan, Nickname oder Platznummer) — Treffer werden im Plan hervorgehoben, ein Klick springt zum Platz. Der Plan passt sich automatisch an die Fensterbreite an (Zoom mit −/+)
- PDF: **Sitzplan** (A4/A3, Raumplan mit Namen + alphabetische Liste „Wer sitzt wo?“) und **Platz-Schilder** (Tischaufsteller zum Falten, zwei pro A4-Blatt, von beiden Seiten lesbar)
- **Alternativen:** Räume lassen sich als Alternative (Entwurf) kennzeichnen — beim Duplizieren oder unter „Raum bearbeiten“. Dort darf jeder Teilnehmer zusätzlich zu seinem Platz im finalen Plan sitzen (innerhalb der Alternative einmal); „Ohne Platz“ und „automatisch belegen“ beziehen sich nur auf diesen Raum. Nimmt man das Häkchen weg, wird die Alternative final und ihre Teilnehmer werden aus den anderen finalen Räumen freigegeben. Alternativen sind nur angemeldet sichtbar
- **Alle Plätze freigeben** leert die Belegung eines Raums (mit Rückfrage)
- Räume **duplizieren** („Duplizieren“ neben „+ Raum“): Kopie mit Tischgruppen, Türen und Startnummern — ins selbe oder ein anderes Event, ohne Belegung
- Ein neues Event übernimmt die Räume des letzten Events (ohne Belegung)

### 🔥 OPNsense / Unbound
- Überträgt die DNS-Namen eines Events per OPNsense-API als **Host Overrides** nach Unbound (getestet gegen die API von OPNsense 26.7)
- Erst Vorschau (neu / geändert / gelöscht / Konflikt), dann „Übertragen“; danach wird Unbound automatisch neu geladen
- Ändert und löscht nur eigene Einträge (Beschreibung beginnt mit `mcd-brackets #<Event>`), von Hand angelegte Einträge mit gleichem Namen werden als Konflikt angezeigt und nicht überschrieben
- „Einträge entfernen…“ löscht nach der LAN alle Einträge des Events wieder

### 🕯️ In Gedenken
- Pro Event eine Liste von Namen (Konfiguration → „In Gedenken“), z.B. für verstorbene Mitglieder
- Single/Double Elimination: Sie ersetzen ein BYE — in Runde 1 steht ihr Name dort, wo ein Spieler ein Freilos bekommt; der Spieler kommt automatisch weiter. Bei Double Elimination steht ihr Name auch in Runde 1 des Loser Brackets, dort wo ihr „Verlierer“ hinkäme; der Verlierer, der dort ankommt, kommt ebenfalls automatisch weiter. Sie gewinnen nie und spielen sonst nirgends mit. Die Plätze sind so gewählt, dass jeder Gedenk-Eintrag einem Spieler gegenübersteht und sich zwei Gedenk-Einträge auch im Loser Bracket nicht begegnen
- Round Robin: Sie stehen in der Tabelle und verlieren jedes Match kampflos (gegeneinander verlieren beide)
- Brackets aus älteren Versionen, in denen sie noch mitgespielt haben, werden beim Start mit derselben Auslosung umgestellt (echte Ergebnisse bleiben)
- Unter der Teilnehmerliste stehen sie als „Never forget … — immer dabei“
- Keine IP-Adressen, keine Platzierung/Punkte in den Ranglisten

### ℹ️ Footer
- Feste Leiste am unteren Fensterrand, immer sichtbar
- Aktuelle Version (Link zum Quellcode dieser Version), Links zu GitHub und „Fehler melden“
- Kurze Statistik: Events, Teilnehmer, Turniere, gespielte Matches (ohne Freilose)
- Hinweis „Neue Version … verfügbar“, wenn auf GitHub ein neuerer Versions-Tag existiert

### 💾 Datenbank-Backup & Restore
- **Backup herunterladen** — `db.json` als timestamped JSON-Datei exportieren
- **Backup einlesen** — JSON-Backup validieren und wiederherstellen
- Vor jedem Restore wird automatisch eine Sicherheitskopie der aktuellen DB angelegt

---

## Installation

### Docker (empfohlen)

Die `docker-compose.yml` nutzt das fertige Image `ghcr.io/lordimac/mcd.brackets:latest`, das die GitHub Action bei jedem Push auf `main` baut. Es reichen `docker-compose.yml` und `.env`, der Quellcode wird nicht gebraucht:

```bash
echo "ADMIN_PASSWORD=mein-passwort" > .env   # siehe „Admin-Passwort einrichten“
docker compose up -d
```

Öffne [http://localhost:3000](http://localhost:3000) im Browser.

**Update auf die neueste Version:**
```bash
docker compose pull && docker compose up -d
```

**Aus dem Quellcode bauen mit `npm run docker:rebuild`** (Image `mcd-brackets` + Container auf Port 3001, Daten in `./data`): Das Skript liest `.env`, sichert vor dem Neustart `data/db.json` als `data/db-before-rebuild-<zeit>.json` (die letzten 10 bleiben) und wartet, bis der Container healthy ist.

**Update von Versionen vor 0.20.1:** Der Container läuft jetzt als Benutzer `node` (UID 1000) statt als root. Unter Linux gehört ein bestehendes `./data` danach evtl. noch root; dann einmalig `sudo chown -R 1000:1000 ./data` ausführen. Docker Desktop (macOS/Windows) braucht das nicht.

**Ohne Compose:**
```bash
docker pull ghcr.io/lordimac/mcd.brackets:latest
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data -e ADMIN_PASSWORD='geheim' ghcr.io/lordimac/mcd.brackets:latest
```

### Admin-Passwort einrichten

Das Passwort steht in der Datei `.env` im Projektordner (von Git und vom Docker-Image ausgeschlossen, Vorlage: `.env.example`):

```bash
ADMIN_PASSWORD=mein-geheimes-passwort
```

- `docker compose` und `npm run docker:rebuild` lesen `.env` automatisch; nach einer Änderung den Container neu erstellen (`docker compose up -d` bzw. `npm run docker:rebuild`)
- Ohne Compose: `docker run … -e ADMIN_PASSWORD='…'` (siehe oben)
- Development: `ADMIN_PASSWORD='…' npm run server`
- Leer oder nicht gesetzt = keine Anmeldung nötig, jeder darf bearbeiten. Der Server meldet das beim Start als Warnung
- Ein neues Passwort meldet alle angemeldeten Browser ab

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
| `ADMIN_PASSWORD` | *(leer)* | Passwort zum Bearbeiten; leer = jeder darf bearbeiten. Für `docker compose` und `npm run docker:rebuild` in `.env` eintragen (`ADMIN_PASSWORD=…`, nicht im Git) |
| `TRUST_PROXY` | *(aus)* | Hinter einem Reverse-Proxy auf `true` setzen (oder Anzahl der Proxys bzw. deren Adressen), damit Client-IP (Login-Sperre), HTTPS (`Secure`-Cookie) und Host aus den `X-Forwarded-*`-Headern kommen. Ohne Proxy aus lassen, sonst lassen sich die Header fälschen |
| `UPDATE_CHECK` | `true` | Prüft beim Start und alle 6 Stunden auf GitHub, ob es eine neuere Version gibt (Hinweis im Footer). Ohne Internet passiert einfach nichts; `false` schaltet den Check ab |

---

## Webinterface

### Teilnehmer verwalten (Reiter „Teilnehmer“)
1. Event anlegen („Neu“) — Domain und IP-Bereiche werden vom letzten Event übernommen
2. Unter „Konfiguration“ (einklappbar) Zeitraum des Events (Beginn/Ende — Spielzeiten und Zeitplan bieten nur diese Tage an), Domain, Logo, Netzwerk (Subnetzmaske, Router/Gateway, DNS — stehen auf den IP-Zetteln) und die drei IP-Bereiche einstellen. Mit dem Haken „WLAN vorhanden“ lassen sich SSID und Passwort eintragen; nur dann steht auf den IP-Zetteln eine Rubrik „WLAN“. Passwort leer = offenes WLAN. IP-Zettel und WLAN-Passwort gibt es nur für angemeldete Admins
3. Teilnehmer mit Vorname, Name und Nickname hinzufügen — einzeln oder per „Mehrere auf einmal importieren…“ (`Nachname, Vorname // Clan-Nickname`, eine Zeile pro Teilnehmer). IPs und DNS-Namen werden automatisch vergeben, beim Import in der Reihenfolge der Nachnamen
4. IP-Zettel als PDF drucken („IP-Zettel (PDF)“ für alle, Datei-Icon in der Zeile für einzelne) und bei Bedarf CSV, hosts-Datei oder BIND-Zone herunterladen
5. Optional: DNS-Namen mit „OPNsense“ nach Unbound übertragen (siehe unten)

### Sitzplan (Reiter „Sitzplan“)
1. Event wählen, mit „+ Raum“ einen Raum anlegen (Breite und Tiefe in Feldern, unter „Raum bearbeiten“ änderbar)
2. „Raum gestalten“: Baustein wählen (Tischreihe, Doppelreihe, U-Form, Reihenblock, Fläche), Größe einstellen, „Hinzufügen“ — vorher auf eine freie Stelle im Raum klicken, dann landet er dort (oder an der nächsten freien Stelle), sonst am ersten freien Platz. Freie Flächen innerhalb einer U-Form zählen mit
3. Gruppen an die richtige Stelle ziehen, mit „Drehen“ (<kbd>R</kbd>) ausrichten, mit „Duplizieren“ vervielfachen; Türen per Baustein „Tür“ an die nächste Wand setzen und entlang der Wand verschieben
4. „Plätze vergeben“: Plätze anklicken und Teilnehmer wählen — oder „Freie Plätze automatisch belegen“
5. „Sitzplan (PDF)“ zum Aushängen, „Platz-Schilder (PDF)“ für die Tische

### OPNsense anbinden
1. In OPNsense unter **System → Zugang → Benutzer** einen eigenen Benutzer für die API anlegen und ihm die Berechtigung **„Services: Unbound“** geben (enthält Host Overrides und das Neuladen von Unbound)
2. Beim Benutzer unter **API-Schlüssel** einen Schlüssel erzeugen — OPNsense lädt eine Datei mit `key` und `secret` herunter
3. In MCD Brackets unter **Teilnehmer → Konfiguration → OPNsense** Adresse der Firewall (z.B. `https://192.168.120.1`), API-Key und Secret eintragen. Beim Standard-Zertifikat der OPNsense „Zertifikat nicht prüfen“ aktivieren. „Verbindung testen“, dann „Speichern“
4. Beim Event muss eine **Domain** eingetragen sein. Der Button **„OPNsense“** über der Teilnehmerliste zeigt die Vorschau, „Übertragen“ schreibt die Einträge

Die Zugangsdaten gelten für alle Events und liegen in der Datenbank (`db.json`, damit auch im Backup). Das Secret wird nach dem Speichern nie wieder an den Browser geschickt; die Einstellungen sind nur angemeldet sichtbar. Der Container muss die Firewall im Netz erreichen können.

### Turnier erstellen (Reiter „Turniere“)
1. Event auswählen — alle Teilnehmer des Events spielen mit
2. Turnier-Name eingeben
3. Typ wählen (Single/Double Elimination oder Round Robin)
4. Optional: Grand Final mit Rückspiel (Double Elimination) bzw. Spiel um Platz 3 (Single Elimination). Beides lässt sich auch später auf der Turnierkarte ein- und ausschalten — das Bracket wird dann mit derselben Auslosung neu aufgebaut, alle Ergebnisse bleiben (beim Ausschalten nur das des Platz-3-Spiels bzw. des Rückspiels nicht)

### Bracket anzeigen & bearbeiten
- **Gewinner auswählen**: Klick auf Match → Gewinner wählen
- **Ergebnisse korrigieren**: Jedes Ergebnis lässt sich ändern, im Bracket per Klick oder in der Match-Liste über „Ergebnis ändern“. Hängen schon Folgeergebnisse davon ab (Winner- und Loser-Pfad bis zum Finale), zeigt eine Vorschau über dem Bracket alle betroffenen Matches. Im Bracket ist das geänderte Match orange markiert, die betroffenen Folge-Matches gelb gestrichelt. Das Bracket zeigt dabei noch den bisherigen Stand. Erst „Änderung übernehmen“ setzt die Folgeergebnisse zurück; sie müssen dann neu eingetragen werden. Nicht betroffene Matches behalten ihr Ergebnis, Gedenk-Matches werden wieder automatisch entschieden. Round-Robin-Ergebnisse lassen sich direkt ändern
- **BYE-Matches**: Werden automatisch entschieden
- **Spielzeiten**: Über das Uhr-Symbol am Turnier lässt sich festlegen, bis wann eine Runde gespielt sein muss — nur bei Single Elimination und im Winner Bracket von Double Elimination (Tag aus dem Event-Zeitraum + Uhrzeit; ohne Zeitraum Datum frei wählbar; nur eine Uhrzeit übernimmt den Tag der Zeile darüber). Das Loser Bracket und Round Robin haben keine Spielzeiten. „Spielzeiten“ beim Event setzt dieselben Zeiten für alle Turniere des Events über gemeinsame Spielrunden (Runde n → Spielrunde n); einzelne Turniere lassen sich danach noch anpassen, Spielrunden mit unterschiedlichen Zeiten bleiben unverändert, solange man dort nichts einträgt. Die Spiele um Platz 1–3 — Halbfinale, Finale und Spiel um Platz 3, bei Double Elimination Grand Final und Loser-Bracket-Finale (dessen Verlierer wird Dritter) — haben stattdessen eine Beginn-Zeit („ab …“, im Event-Dialog je Turnier unter „Finalspiele“) und werden nie ausgelost. Die Zeit steht im Bracket unter dem Rundennamen, die nächste auch auf der Turnierkarte. Nach Rundenschluss entscheidet für jedes noch offene Match der Runde das Los (geprüft alle 30 Sekunden, sobald beide Gegner feststehen). Solche Ergebnisse sind mit „Los“ markiert und lassen sich über „Ergebnis ändern“ korrigieren; wählt man dort denselben Gewinner, gilt das Ergebnis als bestätigt und die Markierung verschwindet. Ein offenes Bracket mit Spielzeiten lädt jede Minute neu. Nach Schluss von Runde 1 können keine neuen Spieler mehr einsteigen
- **TBD-Matches**: Noch nicht spielbar, warte auf vorherige Matches

### Rankings
- **Einzelturnier**: Rangliste mit Platzierung und Statistiken
- **Event-Gesamt**: Kombinierte Rangliste über alle Turniere
- **Top-3 Highlighting**: Gold / Silber / Bronze

### Anmelden
Ist ein Admin-Passwort gesetzt, sieht man ohne Anmeldung nur die Ansicht. In der Fußleiste „Anmelden“ → Passwort eingeben → alle Bearbeiten-Funktionen erscheinen. „Abmelden“ (ebenfalls in der Fußleiste) beendet die Sitzung. Dort liegen für Admins auch „Backup herunterladen“ und „Backup einlesen“.

### Backup & Restore
Oben rechts in der Kopfleiste (nur angemeldet):
- **💾 Backup herunterladen** — Lädt die aktuelle `db.json` herunter
- **📂 Backup einlesen** — Stellt eine gesicherte `db.json` wieder her

---

## REST API

Ist `ADMIN_PASSWORD` gesetzt, sind alle Anfragen außer GET/HEAD (und `GET /api/backup`) nur mit Admin-Sitzung erlaubt, sonst `401`. Ändernde Anfragen, die ein Browser von einer fremden Seite schickt (`Sec-Fetch-Site: cross-site`/`same-site` oder fremder `Origin`), werden mit `403` abgelehnt; Werkzeuge wie curl ohne diese Header sind nicht betroffen. JSON-Bodies dürfen höchstens 3 MB groß sein (`/api/restore`: 10 MB).

### Willkommens-Seite
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/whoami` | Erkennung über die Client-IP: `{ ip, status (identified/unassigned/unknown/disabled/no-event), event_id, attendee, range_index, expected, seat, checks }`; `?ip=…` nur für Admins (Testansicht) |

### Anmeldung
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/auth` | `{ required, admin, via }` — ist ein Passwort gesetzt, ist der Browser angemeldet; `via`: `open` (kein Passwort), `session` (Login), `ip` (Admin-Teilnehmer) |
| POST   | `/api/login` | Anmelden `{ password }` → setzt das Cookie `mcd_admin` (7 Tage) |
| POST   | `/api/logout` | Abmelden (Cookie löschen) |

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
| PUT    | `/api/matches/:id` | Match-Ergebnis setzen/ändern: `{ opponent1, opponent2, resetFollowing? }`. Gibt es schon Folgeergebnisse, ist `resetFollowing: true` nötig (sonst `409`); sie werden dann zurückgesetzt |
| GET    | `/api/events/:id/timetable` | Zeitplan: `{ entries: [{ id, days: ["YYYY-MM-DD"], start: "HH:MM", end: "HH:MM" \| null, title, info, category }], notes: [{ id, title, text }], tournament_rounds: [{ ends_at, title, rounds: [{ stage_name, label }] }] }` (Zeiten = Ortszeit des Events) |
| PUT    | `/api/events/:id/timetable` | Zeitplan speichern: `{ entries, notes }` (immer vollständig; `category`: meal, program, tournament, other) |
| GET    | `/api/burger/menu` | Burger-Speisekarte: `{ open, print_labels, kitchen_display, categories: [{ id, name, visual, multiple, extra, empty_label, options: [{ id, name, short, color, shape, count, available }] }], defaults }` |
| PUT    | `/api/burger/menu` | Speisekarte speichern (Admin, immer vollständig) |
| GET    | `/api/events/:id/burger-orders` | Bestellungen eines Events: `{ orders: [{ id, number, attendee_id, name, choices, extra, note, summary, created_at, printed_at, started_at, done_at }], me }` |
| POST   | `/api/events/:id/burger-orders` | Bestellen (öffentlich, solange offen): `{ attendee_id, choices: { <kategorie>: [<zutat>] }, extra: [<zutat>], note }`; Admins alternativ `{ name }`. Antwort enthält einmalig `token` |
| PUT/DELETE | `/api/burger-orders/:id` | Eigene Bestellung ändern/stornieren bis zum Druck bzw. zur Zubereitung (Header `X-Burger-Token` oder per IP erkanntes Gerät), Admins immer |
| POST   | `/api/events/:id/burger-orders/print` | Admin: `{ ids? }` — ohne `ids` alle noch nicht gedruckten, markiert sie als gedruckt und liefert sie fürs Etikett |
| POST   | `/api/burger-orders/:id/unprint` | Admin: zurück in die Warteschlange |
| POST   | `/api/burger-orders/:id/kitchen` | Admin (Tablet-Anzeige): `{ state: waiting \| started \| done }` |
| GET    | `/api/events/:id/schedule` | Gemeinsame Zeiten aller Turniere eines Events: `{ slots: [{ slot, ends_at, mixed, rounds: [{ stage_id, stage_name, label }] }], finals: [{ stage_id, stage_name, group, round, label, starts_at }] }` |
| PUT    | `/api/events/:id/schedule` | `{ slots: [{ slot, ends_at }], finals: [{ stage_id, group, round, starts_at }] }`: jede Runde mit Spielzeit (SE, Winner Bracket) aller Turniere bekommt die Zeit ihrer Spielrunde, die Spiele um Platz 1–3 ihren Beginn; nicht genannte bleiben unverändert. Antwort `{ slots, finals, decided }` |
| PUT    | `/api/stages/:id/settings` | Nachträglich änderbare Einstellungen: `{ consolationFinal: boolean }` (Spiel um Platz 3, nur Single Elimination) oder `{ grandFinalDouble: boolean }` (Grand Final mit Rückspiel, nur Double Elimination); Neuaufbau mit gleicher Auslosung. Antwort `{ stage_id, dropped }` |
| GET    | `/api/stages/:id/schedule` | Runden mit Zeiten: `{ rounds: [{ round_id, group, round, label, slot, kind, ends_at, starts_at }] }` (`kind`: `deadline` oder `start` für die Spiele um Platz 1–3) |
| PUT    | `/api/stages/:id/schedule` | Zeiten speichern: `{ rounds: [{ group, round, ends_at \| starts_at }] }` (ISO-Zeit, leer = keine); schon geschlossene Runden werden sofort ausgelost, Antwort `{ rounds, decided }` |
| GET    | `/api/matches/:id/following` | Vorschau einer Korrektur: `{ label, following: [{ id, label, opponent1, opponent2 }] }`, die gespielten Matches, die von diesem Ergebnis abhängen |

### Participants
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/participants` | Alle Teilnehmer abrufen |
| DELETE | `/api/participants/:id` | Teilnehmer löschen |

### Viewer & Standings
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/viewer-data/:stageId` | Turnierdaten für Bracket-Viewer |
| GET    | `/api/standings/:stageId` | Platzierungen inkl. Punkten: `{ placement, placement_to, participant_id, participant_name, wins, losses, pending, points }` — geteilter Platz = `placement`…`placement_to`, `null` = noch offen (0 Punkte) |
| GET    | `/api/points` | Punktesystem: `{ places: [10 Werte für Platz 1–10], rest, defaults: { places, rest } }` |
| PUT    | `/api/points` | Punktesystem speichern: `{ places: [10 ganze Zahlen 0–1000], rest }` |

### Events & Teilnehmer
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/events` | Events inkl. Anzahl Teilnehmer, Plätze und Turniere |
| POST   | `/api/events` | Event anlegen `{ name, domain?, dns_server?, netmask?, gateway?, ranges? }` (fehlende Werte vom letzten Event) |
| PUT    | `/api/events/:id` | Event ändern (inkl. `logo`, `memorial: string[]`); Umbenennen wirkt auch auf die Turniere |
| DELETE | `/api/events/:id` | Event mit Teilnehmern löschen (nur ohne Turniere) |
| GET    | `/api/events/:id/attendees` | Teilnehmer inkl. `ips` und `dns_names` |
| POST   | `/api/events/:id/attendees` | Teilnehmer anlegen `{ first_name, last_name, clan, nickname }` |
| POST   | `/api/events/:id/attendees/import` | Teilnehmer aus `{ fromEventId }` übernehmen |
| POST   | `/api/events/:id/attendees/bulk` | Bulk-Import `{ text, dryRun? }` — Zeilen `Nachname, Vorname // Clan-Nickname`; liefert pro Zeile Ergebnis oder Fehler, `dryRun: true` schreibt nichts |
| PUT    | `/api/attendees/:id` | Teilnehmer ändern; neuer Clan/Nickname wird in den Turnieren übernommen |
| DELETE | `/api/attendees/:id` | Teilnehmer löschen (IPs werden frei) |
| GET    | `/api/events/:id/export/csv\|hosts\|zone` | Export als CSV, hosts-Datei oder BIND-Zone |

### Sitzplan
Lesen ist öffentlich, Ändern nur mit Admin-Sitzung. Ein Raum hat `width` × `height` Felder und `groups`: Tischreihen `{ id, type: "row", x, y, rotation: 0|90|180|270, length, sides: "both"|"one"|"none", numbering?: "forward"|"backward"|"around"|"around-back", start_label?: string }` und Flächen `{ id, type: "area", x, y, width, height, label }`; dazu `doors`: `{ id, side: "top"|"right"|"bottom"|"left", offset, width, swing: "in"|"out", hinge: "start"|"end" }`. Platz-Schlüssel `"<gruppe>.<b|f><index>"` (z.B. `g3.f2`). Antworten enthalten zusätzlich `layout` mit den Zellen jeder Gruppe, allen Plätzen (`key`, `number` = Reihenfolge, `label` = angezeigte Platznummer, `x`, `y`), Überlappungen und doppelten Nummern (`duplicates`).

| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/events/:id/rooms` | Räume inkl. `layout`, `alternative` und `seats: { "<platz>": attendeeId }` — Alternativen nur mit Admin-Sitzung |
| POST   | `/api/events/:id/rooms` | Raum anlegen `{ name, width?, height? }` (Standard 24 × 14) |
| PUT    | `/api/rooms/:id` | Name, Größe, Gruppen, Türen und/oder Alternative-Kennzeichen `{ name?, width?, height?, groups?, doors?, alternative? }` (`alternative: false` macht den Raum final und gibt seine Teilnehmer in anderen finalen Räumen frei); Gruppen müssen im Raum, Türen in ihrer Wand liegen; Plätze entfernter Gruppen werden frei |
| POST   | `/api/rooms/:id/templates` | Baustein einfügen `{ template: "row"\|"double"\|"u"\|"block"\|"area"\|"door", params, at?: { x, y } }` (Tür: an die Wand nächst `at`) — an `at` bzw. der nächsten freien Stelle, sonst am ersten freien Platz |
| POST   | `/api/rooms/:id/sort` | Gruppen nach Position sortieren (nummeriert die Plätze neu) |
| POST   | `/api/rooms/:id/duplicate` | Raum kopieren `{ name?, event_id?, alternative? }` — Layout, Türen, Startnummern; ohne Belegung. Ohne Name: „<Name> (Kopie)“ bzw. der Originalname, wenn er im Ziel-Event frei ist |
| DELETE | `/api/rooms/:id` | Raum löschen |
| PUT    | `/api/rooms/:id/seats/:key` | Platz vergeben `{ attendee_id }` oder freigeben `{ attendee_id: null }`; ein Teilnehmer hat höchstens einen Platz je Event → alle Räume |
| POST   | `/api/rooms/:id/clear` | Alle Plätze des Raums freigeben |
| POST   | `/api/rooms/:id/autofill` | Alle ohne Platz auf freie Plätze dieses Raums setzen → `{ rooms, seated, remaining }` |

### OPNsense
Alle Endpunkte nur mit Admin-Sitzung (auch GET). Fehler der Firewall kommen als `502` mit lesbarer Meldung.

| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/opnsense` | Verbindung `{ url, api_key, has_secret, insecure_tls, configured }` (ohne Secret) |
| PUT    | `/api/opnsense` | Speichern `{ url, api_key, api_secret?, insecure_tls }` — leeres Secret behält das gespeicherte |
| POST   | `/api/opnsense/test` | Verbindung mit den übergebenen (oder gespeicherten) Werten testen → `{ ok, host_count }` |
| POST   | `/api/events/:id/opnsense/preview` | Vorschau `{ mode: "sync" \| "remove" }` → `{ items, counts }` |
| POST   | `/api/events/:id/opnsense/apply` | Ausführen (plant gegen den aktuellen Stand neu) → `{ created, updated, deleted, conflicts, errors, reconfigured }` |

### Info
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/info` | `{ version, repo_url, update: { latest, url, checked_at, available } \| null, stats: { events, attendees, tournaments, matches_played } }` |

### Backup & Restore
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET    | `/api/backup` | `db.json` als Download |
| POST   | `/api/restore` | Backup einspielen (JSON body) |

---

## Technologien

**Backend:** Node.js 24 LTS, Express 5, TypeScript 7  
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

### Single und Double Elimination
Die Platzierung ergibt sich nur aus der Runde, in der jemand ausscheidet (bei Double Elimination: Niederlage im Loser Bracket bzw. im Grand Final). Alle, die in derselben Runde ausscheiden, teilen sich den Platz — Siege und Niederlagen entscheiden nichts, sonst wäre ein Freilos ein Nachteil. Ohne Spiel um Platz 3 teilen sich die Halbfinal-Verlierer Platz 3–4. Wie viele Spieler in einer Runde ausscheiden, steht durch das Bracket fest; der Platz ist deshalb schon während des Turniers endgültig, sobald jemand raus ist. Beim Grand Final mit Rückspiel entscheidet das erste Spiel, wenn es der Sieger des Winner Brackets gewinnt, sonst das Rückspiel.

### Round Robin
3 Punkte pro Sieg, 1 pro Unentschieden; Gleichstände löst brackets-manager über die Score-Differenz. Bei mehreren Gruppen kommen alle Gruppenersten vor allen Gruppenzweiten usw. Die Plätze (und damit Punkte) stehen erst fest, wenn alle Spiele gespielt sind; bis dahin ist die Reihenfolge vorläufig.

### Gesamtwertung
Summe der Punkte aus allen Turnieren eines Events; bei Gleichstand entscheiden Siege, Siegrate und Anzahl Turniere, sind auch die gleich, teilen sich die Spieler den Platz.

---

## Projekt-Struktur

```
mcd.brackets/
├── src/
│   ├── server.ts       # Express Server + REST API
│   ├── auth.ts         # Admin-Passwort, Sitzungs-Cookie
│   ├── db.ts           # Storage, Restore, Schreib-Lock, Rollback
│   ├── stages.ts       # Turniere anlegen, neu auslosen, löschen
│   ├── lan.ts          # IP-Vergabe, DNS-Namen, Exporte (reine Logik)
│   ├── lan-store.ts    # Events & Teilnehmer in der Datenbank
│   ├── lan-routes.ts   # REST-Routen für Events & Teilnehmer
│   ├── opnsense.ts     # Abgleich mit Unbound + OPNsense-API-Client
│   ├── opnsense-routes.ts # REST-Routen für OPNsense
│   ├── info.ts         # Footer: Versionscheck (GitHub-Tags) + Statistik
│   ├── seating.ts      # Sitzplan: Tischgruppen, Geometrie, Bausteine, Nummerierung (reine Logik)
│   ├── seating-store.ts # Räume & Platzvergabe in der Datenbank
│   ├── seating-routes.ts # REST-Routen für den Sitzplan
│   ├── standings.ts    # Platzierungen + Punkte
│   ├── points.ts       # Punktesystem (Standardwerte, Prüfung), points-routes.ts: /api/points
│   ├── seeding.ts      # Auslosung + BYEs
│   └── *.test.ts       # Tests (npm test)
├── public/
│   ├── index.html      # Webinterface
│   ├── app.js          # Frontend-Logik (Turniere)
│   ├── lan.js          # Frontend-Logik (Teilnehmer-Verwaltung)
│   ├── ip-slips.js     # IP-Zettel als PDF (jsPDF)
│   ├── opnsense.js     # OPNsense-Einstellungen + Übertragen-Dialog
│   ├── seating.js      # Sitzplan-Ansicht (Raum-Editor, Vergabe, Suche)
│   ├── seating-pdf.js  # Sitzplan und Platz-Schilder als PDF
│   ├── timetable.js    # Zeitplan-Ansicht (Einträge, Hinweise)
│   ├── timetable-pdf.js # Zeitplan als PDF
│   ├── styles.css      # Dark Theme Styling
│   └── lib/            # Lokale Kopien der Browser-Libs (npm run vendor)
├── data/
│   └── db.json         # Turnierdaten (Docker Volume)
├── docs/screenshots/   # Bilder für diese README
├── scripts/
│   └── docker-rebuild.sh  # Image + Container lokal neu bauen (npm run docker:rebuild)
├── .env.example        # Vorlage für .env (ADMIN_PASSWORD)
├── docker-compose.yml
├── Dockerfile
├── package.json
└── README.md
```

---

## Lizenz

ISC
