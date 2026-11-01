// Welcome page: who is this device and is its network set up correctly (GET /api/whoami,
// src/welcome.ts). The client IP identifies the attendee; `me` also highlights the own row in
// the attendee list, the own seat and the own entry in brackets.
// Uses apiFetch, escapeHtml, icon, lanEvents, formatType, formatDeadline, rankBadge from app.js
// and RANGE_LABELS, clanTag from lan.js, welcomeSharesHtml from shares.js.

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
    chip.innerHTML = `<span class="tape-wrap"><span class="tape tape-orange">${escapeHtml(me.attendee.nickname)}</span></span>${me.attendee.admin ? '<span class="me-chip-tag">Admin</span>' : ''}${me.tested ? '<span class="me-chip-test" title="Testansicht für eine andere IP-Adresse">Testansicht</span>' : ''}`;
    chip.title = me.attendee.admin && !me.tested
        ? 'Über die IP-Adresse dieses Geräts erkannt und als Admin angemeldet'
        : 'Erkannt über die IP-Adresse dieses Geräts';
}

// Lists that were rendered before the identification arrived
function refreshMeHighlights() {
    const view = document.body.dataset.view;
    if (view === 'attendees' && typeof renderAttendees === 'function') renderAttendees();
    if (view === 'seating' && typeof renderSeating === 'function') renderSeating();
    // Tournament cards are rendered once and only refreshed on data changes: always bring them up to date
    if (typeof displayStages === 'function' && stages.length) displayStages();
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
    if (welcomeTestIp) document.getElementById('welcomeTestBox').open = true;
    if (!me) {
        box.innerHTML = `<section class="card welcome-hero"><div class="welcome-hero-main">
            <h1 class="welcome-title">Willkommen!</h1>
            <p class="welcome-lead">Dein Gerät konnte gerade nicht erkannt werden${meError ? `: ${escapeHtml(meError)}` : ''}.</p></div></section>`;
        return;
    }
    const event = welcomeEvent();
    if (!event) {
        box.innerHTML = `<section class="card welcome-hero"><div class="welcome-hero-main">
            <h1 class="welcome-title">Willkommen!</h1>
            <p class="welcome-lead">Es ist noch kein Event angelegt.</p></div></section>`;
        return;
    }
    const withNetwork = ['identified', 'unassigned', 'unknown'].includes(me.status);
    // During the event the own matches matter most; the network setup is done after the first hour
    const side = [
        me.status === 'identified' ? `
            <section class="card">
                <div class="section-header">
                    <h2><svg class="icon icon-accent"><use href="#i-trophy"/></svg>Deine Turniere</h2>
                </div>
                <div id="welcomeTournamentList" class="my-tournaments"><p class="loading">Lade Turniere…</p></div>
            </section>` : '',
        withNetwork ? networkHtml(event) : '',
        welcomeSharesHtml(event),
    ].join('');
    // The card on the left third, the other blocks beside it (stacked on narrow screens)
    box.innerHTML = side.trim()
        ? `<div class="welcome-columns"><div class="welcome-main">${heroHtml(event)}</div><div class="welcome-side">${side}</div></div>`
        : heroHtml(event);
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
    const ip = `<code>${escapeHtml(me.ip ?? '–')}</code>`;
    const test = me.tested ? `<p class="welcome-test-note">${icon('search')}Testansicht für ${ip}</p>` : '';

    // Not recognised yet: a check-in desk, not an error report. Three steps to being recognised,
    // and the rest of the event to look at in the meantime
    if (me.status === 'unknown' || me.status === 'unassigned') {
        const now = me.status === 'unassigned'
            ? `Dieses Gerät hat schon eine Adresse aus dem Event-Netz (${ip}), sie gehört aber noch niemandem.`
            : `Dein Gerät ist noch nicht im Event-Netz${/^\d+\.\d+\.\d+\.\d+$/.test(me.ip ?? '') ? ` (es hat gerade ${ip})` : ''}.`;
        return `<section class="card welcome-hero welcome-checkin">
            <div class="welcome-hero-main">${kicker}
                <h1 class="welcome-title">Willkommen bei ${escapeHtml(event.name)}!</h1>
                <p class="welcome-lead">Schön, dass du da bist. ${now} So kommst du rein:</p>
                <ol class="checkin-steps">
                    <li><strong>IP-Zettel holen</strong><span>Liegt am Einlass bzw. bei der Orga. Darauf steht deine feste Adresse.</span></li>
                    <li><strong>Adresse einstellen</strong><span>Maske, Gateway und DNS stehen <a href="#welcomeSetup" onclick="event.preventDefault(); document.getElementById('welcomeSetup')?.scrollIntoView({ behavior: 'smooth' })">unten</a>.
                        <button type="button" class="link-button" onclick="exportIpGuide()">Anleitung für Windows und macOS (PDF)</button></span></li>
                    <li><strong>Seite neu laden</strong><span>Dann begrüßt dich die Seite mit Namen, Platz und nächstem Match.
                        <button type="button" class="link-button" onclick="location.reload()">Jetzt neu laden</button></span></li>
                </ol>
                <p class="checkin-browse">Schon mal stöbern: <a href="#zeitplan">Zeitplan</a> · <a href="#sitzplan">Sitzplan</a> · <a href="#turniere">Turniere</a> · <a href="#burger">Burger bestellen</a></p>
                ${test}
            </div>
        </section>`;
    }

    if (me.status !== 'identified') {
        const lead = {
            unassigned: `Dieses Gerät hat die Adresse ${ip}. Sie gehört zum Event, aber noch zu niemandem. Trag die feste Adresse von deinem IP-Zettel ein, dann erkennt dich die Seite.`,
            // A loopback or IPv6 address means nothing to an attendee; only an IPv4 address is worth showing
            unknown: `Dieses Gerät ist noch nicht im Event-Netz${/^\d+\.\d+\.\d+\.\d+$/.test(me.ip ?? '') ? ` (es hat gerade ${ip})` : ''}. Stell die feste Adresse von deinem IP-Zettel ein, die Schritte stehen unten. Kein Zettel zur Hand? Frag die Orga.`,
            disabled: 'Schön, dass du da bist! Die Erkennung über die IP-Adresse ist für dieses Event ausgeschaltet.',
        }[me.status] ?? '';
        return `<section class="card welcome-hero">
            <div class="welcome-hero-main">${kicker}<h1 class="welcome-title">Willkommen!</h1><p class="welcome-lead">${lead}</p>${test}</div>
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
            <h1 class="welcome-title">Hallo ${escapeHtml(a.first_name || a.nickname)}!</h1>
            <p class="welcome-identity"><span class="tape-wrap welcome-tape"><span class="tape-print"><span class="tape tape-white">${escapeHtml(a.display_name)}</span></span></span>${fullName ? `<span class="muted">${escapeHtml(fullName)}</span>` : ''}</p>
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
            <div class="welcome-fact is-next" id="welcomeNextMatch">
                <span class="welcome-fact-label">${icon('bracket')}Nächstes Match</span>
                <strong class="welcome-fact-value is-text">…</strong>
                <span class="welcome-fact-sub">wird geladen</span>
            </div>
        </div>
    </section>`;
}

// The page was opened via a DNS name of the event's domain: name resolution works on this device
function clientChecks(event) {
    const host = location.hostname.toLowerCase();
    if (!event.domain || !host.endsWith(`.${event.domain}`)) return [];
    return [{ status: 'ok', title: 'Namensauflösung funktioniert', detail: `Du hast diese Seite über ${host} aufgerufen.` }];
}

const CHECK_ICONS = { ok: 'check', warn: 'alert', error: 'x', info: 'info', todo: 'chevron' };

function networkHtml(event) {
    // A device that is not set up yet gets steps to do, not a wall of red errors
    const setup = me.status !== 'identified';
    const checks = [...me.checks, ...clientChecks(event)]
        .map(c => (setup && c.status === 'error' ? { ...c, status: 'todo' } : c));
    const failed = checks.filter(c => ['warn', 'error', 'todo'].includes(c.status));
    announce(failed.length
        ? `Netzwerk-Check: ${failed.length} ${failed.length === 1 ? 'Punkt braucht' : 'Punkte brauchen'} Aufmerksamkeit: ${failed.map(c => c.title).join(', ')}.`
        : 'Netzwerk-Check: alles in Ordnung.');
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

    const actions = `<div class="section-actions">
                <button class="btn btn-ghost btn-sm" onclick="showWelcomeView()">${icon('refresh')}<span>Erneut prüfen</span></button>
                <button class="btn btn-secondary btn-sm" onclick="exportWelcomeGuide()" title="Feste IP-Adresse unter Windows und macOS einstellen">${icon('file')}<span>Anleitung (PDF)</span></button>
            </div>`;
    const hint = '<p class="section-subtitle">Geprüft über die Verbindung dieses Geräts zum Server. Maske, Gateway und DNS deines Geräts sieht der Server nicht, vergleich sie mit den Werten unten.</p>';
    const body = `<ul class="check-list">${checks.map(c => `
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
        ${wifi}`;

    // Everything passed: one line, the values stay one tap away
    if (!failed.length) {
        return `<details class="card welcome-network">
            <summary class="welcome-test-summary">
                <span>
                    <span class="welcome-test-title"><span class="check-icon is-ok">${icon('check')}</span>Netzwerk ok</span>
                    <span class="section-subtitle">${checks.length === 1 ? 'Die Prüfung ist bestanden' : `Alle ${checks.length} Prüfungen bestanden`}. Einstellungen, Adressen${event.wifi_enabled ? ' und WLAN' : ''} anzeigen</span>
                </span>
                <span class="collapse-icon"><svg class="icon"><use href="#i-chevron"/></svg></span>
            </summary>
            <div class="welcome-network-body">
                <div class="section-header">${hint}${actions}</div>
                ${body}
            </div>
        </details>`;
    }
    return `<section class="card"${setup ? ' id="welcomeSetup"' : ''}>
        <div class="section-header">
            <div>
                <h2><svg class="icon icon-accent"><use href="#i-network"/></svg>${setup ? 'So richtest du dein Gerät ein' : 'Netzwerk-Check'}</h2>
                ${hint}
            </div>
            ${actions}
        </div>
        ${body}
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
            renderNextMatchFact(null);
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
        // What needs the attendee comes first: playable matches, then waiting ones, then the rest
        const next = new Map(details.map(entry => [entry, nextMatchOf(entry)]));
        details.sort((a, b) => {
            const na = next.get(a), nb = next.get(b);
            if (na && nb) return compareNextMatches(na, nb);
            return (nb ? 1 : 0) - (na ? 1 : 0) || a.stage.tournament_id - b.stage.tournament_id;
        });
        list.innerHTML = details.map(myTournamentHtml).join('');
        renderNextMatchFact(next.get(details[0]) ?? null);
    } catch (error) {
        list.innerHTML = `<p class="field-hint is-warning">Die Turniere konnten nicht geladen werden: ${escapeHtml(error.message)}</p>`;
        renderNextMatchFact(null, 'nicht geladen');
    }
}

// The own open match of one tournament: opponent, round and its time
function nextMatchOf({ stage, participant, matches: stageMatches, rounds, names }) {
    const own = m => m.opponent1?.id === participant.id || m.opponent2?.id === participant.id;
    const open = stageMatches
        .filter(m => OPEN_MATCH_STATUS.includes(m.status) && own(m))
        .sort((a, b) => a.round_id - b.round_id || a.number - b.number);
    const match = open[0];
    if (!match) return null;
    const other = match.opponent1?.id === participant.id ? match.opponent2 : match.opponent1;
    const round = rounds.find(r => r.round_id === match.round_id);
    return {
        stage,
        match,
        more: open.length - 1,
        opponent: other?.id != null ? names.get(other.id) ?? null : null,
        round,
        time: round?.ends_at ?? round?.starts_at ?? null,
    };
}

// Playable first (opponent known), then by time; without a time last
function compareNextMatches(a, b) {
    return (b.opponent ? 1 : 0) - (a.opponent ? 1 : 0)
        || (a.time ? Date.parse(a.time) : Infinity) - (b.time ? Date.parse(b.time) : Infinity)
        || a.stage.tournament_id - b.stage.tournament_id;
}

function renderNextMatchFact(next, failure = '') {
    const fact = document.getElementById('welcomeNextMatch');
    if (!fact) return;
    const label = `<span class="welcome-fact-label">${icon('bracket')}Nächstes Match</span>`;
    if (!next) {
        fact.className = 'welcome-fact is-next';
        fact.innerHTML = `${label}<strong class="welcome-fact-value is-text">–</strong><span class="welcome-fact-sub">${failure || 'gerade keins offen'}</span>`;
        return;
    }
    const when = next.round?.ends_at ? `bis ${formatDeadline(next.round.ends_at)}` : next.round?.starts_at ? `ab ${formatDeadline(next.round.starts_at)}` : '';
    const replacement = document.createElement('button');
    replacement.type = 'button';
    replacement.id = 'welcomeNextMatch';
    replacement.className = 'welcome-fact is-next is-link';
    replacement.dataset.stage = next.stage.id;
    replacement.title = 'Im Bracket zeigen';
    replacement.setAttribute('onclick', 'openMyMatch(this.dataset.stage)');
    replacement.innerHTML = `${label}
        <strong class="welcome-fact-value is-text">${next.opponent ? `gegen ${escapeHtml(next.opponent)}` : 'Gegner offen'}</strong>
        <span class="welcome-fact-sub">${escapeHtml(next.stage.name)}${when ? ` · ${escapeHtml(when)}` : ''}</span>`;
    fact.replaceWith(replacement);
}

function myTournamentHtml(entry) {
    const { stage, standing } = entry;
    const next = nextMatchOf(entry);

    let status;
    if (next) {
        const { opponent, round } = next;
        const time = round?.ends_at ? ` · bis ${escapeHtml(formatDeadline(round.ends_at))}` : round?.starts_at ? ` · ab ${escapeHtml(formatDeadline(round.starts_at))}` : '';
        const more = next.more > 0 ? `<span class="muted"> · noch ${next.more} weitere</span>` : '';
        status = opponent
            ? `Nächstes Match gegen <strong>${escapeHtml(opponent)}</strong>`
            : 'Nächstes Match — der Gegner steht noch nicht fest';
        status += `<span class="muted">${round ? ` · ${escapeHtml(round.label)}` : ''}${time}</span>${more}`;
    } else if (standing?.placement != null) {
        status = `Fertig gespielt · ${standing.points} ${standing.points === 1 ? 'Punkt' : 'Punkte'}`;
    } else {
        status = '<span class="muted">Gerade kein offenes Match</span>';
    }

    // Playable now (opponent known): marked and sorted first; orange stays with the "Nächstes Match"
    // tile at the top, so the page has one orange thing for one fact
    const playable = Boolean(next?.opponent);
    return `<div class="my-tournament type-${escapeHtml(stage.type)}${playable ? ' is-mine' : ''}">
        ${standing?.placement != null ? `<div class="my-tournament-rank"><span class="my-tournament-rank-label">Platz</span>${rankBadge(standing)}</div>` : ''}
        <div class="my-tournament-main">
            <div class="my-tournament-head"><strong>${escapeHtml(stage.name)}</strong><span class="info-badge badge-type">${formatType(stage.type)}</span></div>
            <p class="my-tournament-status">${status}</p>
        </div>
        <button class="btn ${playable ? 'btn-secondary' : 'btn-ghost'} btn-sm" data-stage="${stage.id}" onclick="${next ? 'openMyMatch' : 'openWelcomeBracket'}(this.dataset.stage)">${icon('bracket')}<span>${playable ? 'Zu meinem Match' : 'Bracket'}</span></button>
    </div>`;
}

function openWelcomeBracket(stageId) {
    location.hash = `#turniere/bracket/${Number(stageId)}`;
}

// "Zu meinem Match": open the bracket and, once it is drawn (viewBracket → takeMyMatchJump), go
// straight to the own open match instead of round 1
let myMatchJumpPending = false;

function openMyMatch(stageId) {
    myMatchJumpPending = true;
    openWelcomeBracket(stageId);
}

function takeMyMatchJump() {
    if (!myMatchJumpPending) return;
    myMatchJumpPending = false;
    scrollToMyMatch();
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

// The own match that still has to be played: framed orange, "Zu meinem Match" jumps to it
function markMyOpenMatch() {
    const button = document.getElementById('myMatchBtn');
    const open = [...document.querySelectorAll('.brackets-viewer .participant.is-me')]
        .map(el => el.closest('.match'))
        .find(match => match && !match.querySelector('.participant.win, .participant.loss'));
    document.querySelectorAll('.brackets-viewer .match.is-my-match').forEach(el => el.classList.remove('is-my-match'));
    open?.classList.add('is-my-match');
    if (button) button.hidden = !open;
}

function scrollToMyMatch() {
    const match = document.querySelector('.brackets-viewer .match.is-my-match');
    if (!match) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    match.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center', inline: 'center' });
    // Keyboard and screen readers land there too (.opponents carries the match name)
    const target = match.querySelector('.opponents') ?? match;
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
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
        notify('❌ Fehler beim Erzeugen des PDFs: ' + error.message);
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
