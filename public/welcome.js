// Welcome page: who is this device and is its network set up correctly (GET /api/whoami,
// src/welcome.ts). The client IP identifies the attendee; `me` also highlights the own row in
// the attendee list, the own seat and the own entry in brackets.
// Uses apiFetch, escapeHtml, icon, lanEvents, formatType, formatDeadline, rankBadge from app.js
// and RANGE_LABELS, clanTag from lan.js.

let me = null;          // answer of /api/whoami, null = not loaded / failed
let meError = '';
let welcomeTestIp = ''; // admins: preview the page as another device
let whoamiPending = null;

// brackets-model Status: Waiting (opponent not known yet), Ready, Running
const OPEN_MATCH_STATUS = [1, 2, 3];

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('welcomeTestForm').addEventListener('submit', testWelcomeIp);
    loadWhoami();
});

function isMe(attendeeId) {
    return me?.status === 'identified' && me.attendee?.id === attendeeId;
}

function welcomeEvent() {
    return lanEvents.find(e => e.id === me?.event_id) || null;
}

// Several callers at startup share one request
function loadWhoami() {
    whoamiPending ??= fetchWhoami().finally(() => { whoamiPending = null; });
    return whoamiPending;
}

async function fetchWhoami() {
    try {
        me = await apiFetch(`/whoami${welcomeTestIp ? `?ip=${encodeURIComponent(welcomeTestIp)}` : ''}`);
        meError = '';
    } catch (error) {
        me = null;
        meError = error.message;
    }
    renderMeChip();
    refreshMeHighlights();
    return me;
}

// Topbar: who this device is
function renderMeChip() {
    const chip = document.getElementById('meChip');
    const identified = me?.status === 'identified';
    chip.hidden = !identified;
    if (!identified) return; // not recognised (or request failed): no attendee to show
    chip.innerHTML = `${icon('users')}<span>${escapeHtml(me.attendee.display_name)}</span>${me.attendee.admin ? '<span class="me-chip-tag">Admin</span>' : ''}${me.tested ? '<span class="me-chip-test">Test</span>' : ''}`;
    chip.title = me.attendee.admin && !me.tested
        ? 'Über die IP-Adresse dieses Geräts erkannt und als Admin angemeldet'
        : 'Erkannt über die IP-Adresse dieses Geräts';
}

// Lists that were rendered before the identification arrived
function refreshMeHighlights() {
    const view = document.body.dataset.view;
    if (view === 'attendees' && typeof renderAttendees === 'function') renderAttendees();
    if (view === 'seating' && typeof renderSeating === 'function') renderSeating();
}

// Called by showView() in app.js whenever the welcome tab opens
async function showWelcomeView() {
    await Promise.all([loadWhoami(), loadEvents()]);
    renderWelcome();
    await loadMyTournaments();
}

/* Page
   ========================================================================== */

function renderWelcome() {
    const box = document.getElementById('welcomeContent');
    document.getElementById('welcomeTestReset').hidden = !welcomeTestIp;
    if (!me) {
        box.innerHTML = `<section class="card welcome-hero"><div class="welcome-hero-main">
            <h2 class="welcome-title">Willkommen!</h2>
            <p class="welcome-lead">Dein Gerät konnte gerade nicht erkannt werden${meError ? `: ${escapeHtml(meError)}` : ''}.</p></div></section>`;
        return;
    }
    const event = welcomeEvent();
    if (!event) {
        box.innerHTML = `<section class="card welcome-hero"><div class="welcome-hero-main">
            <h2 class="welcome-title">Willkommen!</h2>
            <p class="welcome-lead">Es ist noch kein Event angelegt.</p></div></section>`;
        return;
    }
    const withNetwork = ['identified', 'unassigned', 'unknown'].includes(me.status);
    box.innerHTML = [
        heroHtml(event),
        withNetwork ? networkHtml(event) : '',
        me.status === 'identified' ? `
            <section class="card">
                <div class="section-header">
                    <h2><svg class="icon icon-accent"><use href="#i-trophy"/></svg>Deine Turniere</h2>
                </div>
                <div id="welcomeTournamentList" class="my-tournaments"><p class="loading">Lade Turniere…</p></div>
            </section>` : '',
    ].join('');
}

function eventPeriod(event) {
    if (!event.starts_on) return '';
    return event.starts_on === event.ends_on
        ? formatEventDay(event.starts_on)
        : `${formatEventDay(event.starts_on)} – ${formatEventDay(event.ends_on)}`;
}

function heroHtml(event) {
    const period = eventPeriod(event);
    const kicker = `<p class="welcome-event">${icon('flag')}${escapeHtml(event.name)}${period ? `<span class="muted">${escapeHtml(period)}</span>` : ''}</p>`;
    const logo = event.logo ? `<img class="welcome-logo" src="${escapeHtml(event.logo)}" alt="">` : '';
    const ip = `<code>${escapeHtml(me.ip ?? '–')}</code>`;
    const test = me.tested ? `<p class="welcome-test-note">${icon('search')}Testansicht für ${ip}</p>` : '';

    if (me.status !== 'identified') {
        const lead = {
            unassigned: `Dieses Gerät hat die Adresse ${ip}. Sie gehört zum Event, ist aber keinem Teilnehmer zugeordnet — bitte die Adresse von deinem IP-Zettel eintragen.`,
            unknown: `Dieses Gerät konnten wir keinem Teilnehmer zuordnen. Erkannt wurde die Adresse ${ip}.`,
            disabled: 'Schön, dass du da bist! Die Erkennung über die IP-Adresse ist für dieses Event ausgeschaltet.',
        }[me.status] ?? '';
        return `<section class="card welcome-hero">
            <div class="welcome-hero-main">${kicker}<h2 class="welcome-title">Willkommen!</h2><p class="welcome-lead">${lead}</p>${test}</div>
            ${logo}
        </section>`;
    }

    const a = me.attendee;
    const fullName = [a.first_name, a.last_name].filter(Boolean).join(' ');
    const seat = me.seat
        ? `<button type="button" class="welcome-fact is-link" onclick="showMySeat()" title="Im Sitzplan zeigen">
               <span class="welcome-fact-label">${icon('seat')}Sitzplatz</span>
               <strong class="welcome-fact-value">${escapeHtml(me.seat.label)}</strong>
               <span class="welcome-fact-sub">${escapeHtml(me.seat.room)}</span>
           </button>`
        : `<div class="welcome-fact">
               <span class="welcome-fact-label">${icon('seat')}Sitzplatz</span>
               <strong class="welcome-fact-value">–</strong>
               <span class="welcome-fact-sub">noch nicht vergeben</span>
           </div>`;
    return `<section class="card welcome-hero is-identified">
        <div class="welcome-hero-main">
            ${kicker}
            <h2 class="welcome-title">Hallo ${escapeHtml(a.first_name || a.nickname)}!</h2>
            <p class="welcome-identity">${a.clan ? clanTag(a.clan) : ''}<strong>${escapeHtml(a.nickname)}</strong>${fullName ? `<span class="muted">${escapeHtml(fullName)}</span>` : ''}</p>
            <p class="welcome-lead">Dieses Gerät: <strong>${escapeHtml(RANGE_LABELS[me.range_index])}</strong></p>
            ${test}
        </div>
        <div class="welcome-facts">
            ${seat}
            <div class="welcome-fact">
                <span class="welcome-fact-label">${icon('network')}IP-Adresse</span>
                <strong class="welcome-fact-value is-mono">${escapeHtml(me.expected.ip)}</strong>
                <span class="welcome-fact-sub">${escapeHtml(me.expected.dns_name)}</span>
            </div>
        </div>
        ${logo}
    </section>`;
}

// The page was opened via a DNS name of the event's domain: name resolution works on this device
function clientChecks(event) {
    const host = location.hostname.toLowerCase();
    if (!event.domain || !host.endsWith(`.${event.domain}`)) return [];
    return [{ status: 'ok', title: 'Namensauflösung funktioniert', detail: `Du hast diese Seite über ${host} aufgerufen.` }];
}

const CHECK_ICONS = { ok: 'check', warn: 'alert', error: 'x', info: 'info' };

function networkHtml(event) {
    const checks = [...me.checks, ...clientChecks(event)];
    const expected = me.expected;
    const value = v => (v ? `<code>${escapeHtml(v)}</code>` : '<span class="muted">–</span>');
    const settings = [
        ['IP-Adresse', expected ? value(expected.ip) : '<span class="muted">vom IP-Zettel</span>'],
        ['Subnetzmaske', value(event.netmask)],
        ['Router/Gateway', value(event.gateway)],
        ['DNS-Server', value(event.dns_server)],
    ];
    const addresses = me.status === 'identified' ? `
        <div>
            <h3 class="welcome-subhead">Deine Adressen</h3>
            <table class="welcome-addresses">
                <tbody>${me.attendee.ips.map((ip, i) => `
                    <tr${i === me.range_index ? ' class="is-current"' : ''}>
                        <th>${escapeHtml(RANGE_LABELS[i])}${i === me.range_index ? '<span class="current-badge">dieses Gerät</span>' : ''}</th>
                        <td><code>${escapeHtml(ip)}</code><span class="dns">${dnsHtml(me.attendee.dns_names[i])}</span></td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>` : '';
    const wifi = event.wifi_enabled ? `
        <p class="welcome-wifi">${icon('network')}WLAN <strong>${escapeHtml(event.wifi_ssid)}</strong>
            ${event.wifi_password === '' ? '<span class="muted">offen, ohne Passwort</span>' : event.wifi_password ? `<span class="muted">Passwort</span> <code>${escapeHtml(event.wifi_password)}</code>` : '<span class="muted">Passwort steht auf deinem IP-Zettel</span>'}</p>` : '';

    return `<section class="card">
        <div class="section-header">
            <div>
                <h2><svg class="icon icon-accent"><use href="#i-network"/></svg>Netzwerk-Check</h2>
                <p class="section-subtitle">Geprüft über die Verbindung dieses Geräts zum Server. Maske, Gateway und DNS deines Geräts sieht der Server nicht — bitte mit den Werten unten vergleichen.</p>
            </div>
            <div class="section-actions">
                <button class="btn btn-ghost btn-sm" onclick="showWelcomeView()">${icon('refresh')}<span>Erneut prüfen</span></button>
                <button class="btn btn-secondary btn-sm" onclick="exportWelcomeGuide()" title="Feste IP-Adresse unter Windows und macOS einstellen">${icon('file')}<span>Anleitung (PDF)</span></button>
            </div>
        </div>
        <ul class="check-list">${checks.map(c => `
            <li class="check is-${c.status}">
                <span class="check-icon">${icon(CHECK_ICONS[c.status])}</span>
                <div><strong>${escapeHtml(c.title)}</strong><p>${escapeHtml(c.detail)}</p></div>
            </li>`).join('')}
        </ul>
        <div class="welcome-grid">
            <div>
                <h3 class="welcome-subhead">So muss dein Netzwerk eingestellt sein</h3>
                <dl class="welcome-settings">${settings.map(([label, v]) => `<dt>${label}</dt><dd>${v}</dd>`).join('')}</dl>
            </div>
            ${addresses}
        </div>
        ${wifi}
    </section>`;
}

/* Own tournaments: next match, deadline and place
   ========================================================================== */

async function loadMyTournaments() {
    const list = document.getElementById('welcomeTournamentList');
    const event = welcomeEvent();
    if (!list || !event || me?.status !== 'identified') return;
    const name = me.attendee.display_name;
    try {
        const [allStages, allParticipants] = await Promise.all([apiFetch('/stages'), apiFetch('/participants')]);
        const mine = allStages
            .filter(s => s.event_name === event.name)
            .map(stage => ({ stage, participant: allParticipants.find(p => p.tournament_id === stage.tournament_id && p.name === name) }))
            .filter(entry => entry.participant)
            .sort((a, b) => a.stage.tournament_id - b.stage.tournament_id);
        if (!mine.length) {
            list.innerHTML = '<p class="field-hint">Für dieses Event gibt es noch keine Turniere.</p>';
            return;
        }
        const details = await Promise.all(mine.map(async entry => {
            const [stageMatches, schedule, standings] = await Promise.all([
                apiFetch(`/stages/${entry.stage.id}/matches`),
                apiFetch(`/stages/${entry.stage.id}/schedule`).catch(() => ({ rounds: [] })),
                apiFetch(`/standings/${entry.stage.id}`).catch(() => []),
            ]);
            const names = new Map(allParticipants.filter(p => p.tournament_id === entry.stage.tournament_id).map(p => [p.id, p.name]));
            return { ...entry, matches: stageMatches, rounds: schedule.rounds ?? [], names, standing: standings.find(s => s.participant_id === entry.participant.id) };
        }));
        list.innerHTML = details.map(myTournamentHtml).join('');
    } catch (error) {
        list.innerHTML = `<p class="field-hint is-warning">Die Turniere konnten nicht geladen werden: ${escapeHtml(error.message)}</p>`;
    }
}

function myTournamentHtml({ stage, participant, matches: stageMatches, rounds, names, standing }) {
    const own = m => m.opponent1?.id === participant.id || m.opponent2?.id === participant.id;
    const open = stageMatches
        .filter(m => OPEN_MATCH_STATUS.includes(m.status) && own(m))
        .sort((a, b) => a.round_id - b.round_id || a.number - b.number);
    const next = open[0];

    let status;
    if (next) {
        const other = next.opponent1?.id === participant.id ? next.opponent2 : next.opponent1;
        const opponent = other?.id != null ? names.get(other.id) : null;
        const round = rounds.find(r => r.round_id === next.round_id);
        const time = round?.ends_at ? ` · bis ${escapeHtml(formatDeadline(round.ends_at))}` : round?.starts_at ? ` · ab ${escapeHtml(formatDeadline(round.starts_at))}` : '';
        const more = open.length > 1 ? `<span class="muted"> · noch ${open.length - 1} weitere</span>` : '';
        status = opponent
            ? `Nächstes Match gegen <strong>${escapeHtml(opponent)}</strong>`
            : 'Nächstes Match — der Gegner steht noch nicht fest';
        status += `<span class="muted">${round ? ` · ${escapeHtml(round.label)}` : ''}${time}</span>${more}`;
    } else if (standing?.placement != null) {
        status = `Fertig gespielt · ${standing.points} Punkte`;
    } else {
        status = '<span class="muted">Gerade kein offenes Match</span>';
    }

    return `<div class="my-tournament">
        <div class="my-tournament-rank">${standing ? rankBadge(standing) : ''}</div>
        <div class="my-tournament-main">
            <div class="my-tournament-head"><strong>${escapeHtml(stage.name)}</strong><span class="info-badge badge-type">${formatType(stage.type)}</span></div>
            <p class="my-tournament-status">${status}</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-stage="${stage.id}" onclick="openWelcomeBracket(this.dataset.stage)">${icon('bracket')}<span>Bracket</span></button>
    </div>`;
}

function openWelcomeBracket(stageId) {
    location.hash = '#turniere';
    viewBracket(Number(stageId));
}

// Brackets: the own entry (participant of the same event with the own display name)
function markOwnParticipant(stage, list) {
    const event = welcomeEvent();
    if (me?.status !== 'identified' || !stage || !event || stage.event_name !== event.name) return;
    const own = (list ?? []).find(p => p.name === me.attendee.display_name);
    if (!own) return;
    document.querySelectorAll(`.brackets-viewer .participant[data-participant-id="${Number(own.id)}"]`)
        .forEach(el => el.classList.add('is-me'));
}

function showMySeat() {
    if (!me?.seat) return;
    currentEventId = me.event_id;
    currentRoomId = me.seat.room_id;
    try {
        localStorage.setItem('mcd.attendeeEvent', String(currentEventId));
        localStorage.setItem('mcd.seatRoom', String(currentRoomId));
    } catch { /* storage unavailable */ }
    pendingSeatJump = { room: me.seat.room_id, key: me.seat.key };
    location.hash = '#sitzplan';
}

function exportWelcomeGuide() {
    const event = welcomeEvent();
    if (!event) return;
    try {
        buildGuidePdf(event).save(`anleitung-feste-ip-${slipFileSlug(event.name)}.pdf`);
    } catch (error) {
        alert('❌ Fehler beim Erzeugen des PDFs: ' + error.message);
    }
}

/* Admins: preview as another device */

async function testWelcomeIp(e) {
    e.preventDefault();
    welcomeTestIp = document.getElementById('welcomeTestIp').value.trim();
    await showWelcomeView();
}

async function resetWelcomeTest() {
    welcomeTestIp = '';
    document.getElementById('welcomeTestIp').value = '';
    await showWelcomeView();
}
