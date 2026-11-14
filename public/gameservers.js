// Game servers of an event (#server): status and current players for everyone (polled while the
// view is open), for admins the server list and the administration (quick actions and RCON/WebAdmin
// console). Passwords never come from the server: an empty field keeps the stored one (src/gameservers.ts).
// Shares currentEventId/ensureCurrentEvent with lan.js; uses apiFetch, escapeHtml, icon, openModal,
// closeModal, confirmDialog, notify, isAdmin from app.js, isMe from welcome.js, copyText from shares.js.

const GS_GAMES = {
    ut99: { label: 'Unreal Tournament', short: 'UT99', port: 7777, query: '+1', unreal: true },
    ut2004: { label: 'Unreal Tournament 2004', short: 'UT2004', port: 7777, query: '+1', unreal: true },
    cod2: { label: 'Call of Duty 2', short: 'CoD2', port: 28960 },
    cod4: { label: 'Call of Duty 4', short: 'CoD4', port: 28960 },
    cs2: { label: 'Counter-Strike 2', short: 'CS2', port: 27015 },
    q3: { label: 'Quake III Arena', short: 'Q3', port: 27960 },
};
const GS_POLL_MS = 10000;

let gsServers = [];          // GET /events/:id/gameservers
let gsStatus = new Map();    // server id → status
let gsSeats = new Map();     // attendee id → { room, key, label } (final rooms only)
let gsTimer = null;
let gsLoading = false;
let gsListKey = '';          // re-render the cards only when the list itself changes

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('gsForm').addEventListener('submit', saveGameServer);
    document.getElementById('gsGame').addEventListener('change', updateGameServerForm);
    document.getElementById('dockhandForm').addEventListener('submit', saveDockhandSettings);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && document.body.dataset.view === 'servers') refreshGameServerStatus();
    });
});

// Called by showView() in app.js whenever the server tab opens
async function showGameServerView() {
    await loadEvents();
    ensureCurrentEvent();
    const select = document.getElementById('gsEventSelect');
    const events = [...lanEvents].reverse();
    select.innerHTML = events.length
        ? events.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')
        : '<option value="">Noch kein Event — unter „Teilnehmer“ anlegen</option>';
    if (currentEventId != null) select.value = String(currentEventId);
    await loadGameServers();
    startGameServerPolling();
}

async function selectGameServerEvent(id) {
    currentEventId = Number(id);
    try { localStorage.setItem('mcd.attendeeEvent', String(currentEventId)); } catch { /* storage unavailable */ }
    updateBrandLogo();
    await loadGameServers();
}

function startGameServerPolling() {
    clearInterval(gsTimer);
    gsTimer = setInterval(() => {
        if (document.body.dataset.view !== 'servers') {
            clearInterval(gsTimer);
            gsTimer = null;
            return;
        }
        if (!document.hidden) refreshGameServerStatus();
    }, GS_POLL_MS);
}

async function loadGameServers() {
    gsListKey = '';
    gsStatus = new Map();
    if (currentEventId == null) {
        gsServers = [];
        renderGameServers();
        return;
    }
    const eventId = currentEventId;
    const [servers, rooms] = await Promise.all([
        apiFetch(`/events/${eventId}/gameservers`).catch(error => {
            notify(`Server konnten nicht geladen werden: ${error.message}`, { retry: loadGameServers });
            return [];
        }),
        apiFetch(`/events/${eventId}/rooms`).catch(() => []),
    ]);
    if (eventId !== currentEventId) return;
    gsServers = servers;
    gsSeats = new Map();
    for (const room of rooms.filter(r => !r.alternative)) {
        const labels = new Map((room.layout?.seats ?? []).map(seat => [seat.key, seat.label]));
        for (const [key, attendeeId] of Object.entries(room.seats ?? {})) {
            gsSeats.set(attendeeId, { room: room.id, key, label: labels.get(key) ?? '' });
        }
    }
    renderGameServers();
    await refreshGameServerStatus();
}

async function refreshGameServerStatus(manual = false) {
    if (currentEventId == null || !gsServers.length || gsLoading) return;
    const eventId = currentEventId;
    gsLoading = true;
    const button = document.getElementById('gsRefreshBtn');
    button?.classList.add('is-busy');
    try {
        const statuses = await apiFetch(`/events/${eventId}/gameservers/status`);
        if (eventId !== currentEventId) return;
        gsStatus = new Map(statuses.map(s => [s.id, s]));
        for (const server of gsServers) renderGameServerLive(server);
        renderGameServerSummary();
        if (manual) announce('Serverstatus aktualisiert');
    } catch (error) {
        if (manual) notify(`Status konnte nicht abgefragt werden: ${error.message}`);
    } finally {
        gsLoading = false;
        button?.classList.remove('is-busy');
    }
}

/* Rendering: the card frame (and the admin panel with typed text and console output) stays,
   only the live part is redrawn on every poll
   ========================================================================== */

function renderGameServers() {
    const list = document.getElementById('gsList');
    const key = JSON.stringify(gsServers);
    if (key === gsListKey) return;
    gsListKey = key;
    if (currentEventId == null) {
        list.innerHTML = '<p class="empty-state">Lege zuerst unter „Teilnehmer“ ein Event an.</p>';
        renderGameServerSummary();
        return;
    }
    if (!gsServers.length) {
        list.innerHTML = `<p class="empty-state">Noch keine Server eingetragen.${isAdmin ? ' Über „Server“ oben fügst du UT99, UT2004, CoD2, CoD4, CS2 und Quake 3 hinzu.' : ''}</p>`;
        renderGameServerSummary();
        return;
    }
    list.innerHTML = gsServers.map(server => `
        <article class="card gs-card gs-${escapeHtml(server.game)}" data-id="${escapeHtml(server.id)}">
            <header class="gs-head">
                <span class="gs-game" title="${escapeHtml(server.game_label)}">${escapeHtml(server.game_short)}</span>
                <div class="gs-title">
                    <h2>${escapeHtml(server.name)}</h2>
                    <p class="gs-address">
                        <code>${escapeHtml(gsConnectAddress(server))}</code>
                        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-address="${escapeHtml(gsConnectAddress(server))}" onclick="copyGameServerAddress(this)" title="Adresse kopieren" aria-label="Adresse kopieren">${icon('copy')}</button>
                        ${server.game === 'cs2' ? `<a class="btn btn-ghost btn-sm" href="steam://connect/${encodeURI(gsConnectAddress(server))}">${icon('external')}<span>Verbinden</span></a>` : ''}
                    </p>
                    ${server.info ? `<p class="gs-info">${escapeHtml(server.info)}</p>` : ''}
                </div>
                <button type="button" class="btn btn-ghost btn-icon admin-only" data-id="${escapeHtml(server.id)}" onclick="openGameServerModal(this.dataset.id)" title="Server bearbeiten" aria-label="Server bearbeiten">${icon('edit')}</button>
            </header>
            <div class="gs-live" aria-live="off"><p class="gs-pending">Frage Server ab…</p></div>
            ${gameServerAdminHtml(server)}
        </article>`).join('');
    for (const server of gsServers) renderGameServerLive(server);
    renderGameServerSummary();
}

const gsConnectAddress = server => `${server.host}:${server.port}`;

function renderGameServerSummary() {
    const target = document.getElementById('gsSummary');
    if (!gsServers.length) {
        target.textContent = '';
        return;
    }
    const statuses = gsServers.map(s => gsStatus.get(s.id)).filter(Boolean);
    const online = statuses.filter(s => s.online).length;
    const players = statuses.reduce((sum, s) => sum + (s.player_count ?? 0), 0);
    const time = statuses[0] ? new Date(statuses[0].queried_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    target.textContent = statuses.length
        ? `${online} von ${gsServers.length} online · ${players} ${players === 1 ? 'Spieler' : 'Spieler'} · Stand ${time}`
        : `${gsServers.length} ${gsServers.length === 1 ? 'Server' : 'Server'}`;
}

function renderGameServerLive(server) {
    const card = document.querySelector(`.gs-card[data-id="${CSS.escape(server.id)}"]`);
    if (!card) return;
    const status = gsStatus.get(server.id);
    card.classList.toggle('is-offline', status ? !status.online : false);
    const live = card.querySelector('.gs-live');
    if (!status) return;
    if (!status.online) {
        live.innerHTML = `<p class="gs-state is-offline"><span class="gs-dot"></span>Offline <span class="muted">· ${escapeHtml(status.error ?? '')}</span></p>${gameServerContainerHtml(server, status)}`;
        return;
    }
    const max = status.max_players ? ` / ${status.max_players}` : '';
    const bots = status.bot_count ? ` · ${status.bot_count} ${status.bot_count === 1 ? 'Bot' : 'Bots'}` : '';
    const rconHint = isAdmin && status.rcon === 'error' ? `<p class="gs-warning">${icon('alert')}<span>RCON: ${escapeHtml(status.rcon_error ?? 'Fehler')} — Spieler ohne IP-Zuordnung</span></p>` : '';
    live.innerHTML = `
        <div class="gs-facts">
            <p class="gs-state"><span class="gs-dot"></span>Online</p>
            <p><span class="gs-fact-label">Map</span><strong>${escapeHtml(status.map || '–')}</strong></p>
            ${status.gametype ? `<p><span class="gs-fact-label">Modus</span><span>${escapeHtml(status.gametype)}</span></p>` : ''}
            <p><span class="gs-fact-label">Spieler</span><strong>${status.player_count}${max}</strong><span class="muted">${bots}</span></p>
        </div>
        ${status.hostname && status.hostname !== server.name ? `<p class="gs-hostname">${escapeHtml(status.hostname)}</p>` : ''}
        ${rconHint}
        ${gameServerContainerHtml(server, status)}
        ${gamePlayersHtml(server, status)}`;
}

function gamePlayersHtml(server, status) {
    if (!status.players.length) return '<p class="gs-empty">Gerade spielt niemand.</p>';
    const hasTeams = status.players.some(p => p.team);
    const canKick = isAdmin && server.manageable && server.actions.includes('kick');
    const rows = status.players.map(p => {
        const mine = p.attendee_id != null && typeof isMe === 'function' && isMe(p.attendee_id);
        const seat = p.attendee_id != null ? gsSeats.get(p.attendee_id) : null;
        const shownName = p.display_name ?? p.name;
        const ingame = p.display_name && p.name !== p.display_name && p.name !== p.nickname ? `<span class="gs-ingame">als ${escapeHtml(p.name)}</span>` : '';
        const ip = isAdmin && p.ip ? `<span class="gs-ip">${escapeHtml(p.ip)}</span>` : '';
        const actions = [
            seat ? `<button type="button" class="btn btn-ghost btn-sm" data-attendee="${p.attendee_id}" onclick="showGameServerSeat(Number(this.dataset.attendee))" title="Sitzplatz zeigen">${icon('seat')}<span>${escapeHtml(seat.label || 'Platz')}</span></button>` : '',
            canKick && p.num != null && !p.bot ? `<button type="button" class="btn btn-ghost btn-icon btn-sm gs-kick" data-server="${escapeHtml(server.id)}" data-num="${p.num}" data-name="${escapeHtml(shownName)}" onclick="kickGameServerPlayer(this)" title="Kicken" aria-label="${escapeHtml(shownName)} kicken">${icon('logout')}</button>` : '',
        ].join('');
        return `<tr class="${mine ? 'is-me' : ''}${p.bot ? ' is-bot' : ''}">
            <td class="gs-player">
                <span class="gs-name">${escapeHtml(shownName)}</span>${mine ? '<span class="me-tag">du</span>' : ''}${p.bot ? '<span class="gs-bot">Bot</span>' : ''}
                ${ingame}${ip}
            </td>
            ${hasTeams ? `<td class="gs-team">${p.team ? `<span class="gs-team-tag gs-team-${escapeHtml(p.team.toLowerCase())}">${escapeHtml(p.team)}</span>` : ''}</td>` : ''}
            <td class="num">${p.score ?? '–'}</td>
            <td class="num gs-ping">${p.ping ?? '–'}</td>
            <td class="gs-actions">${actions}</td>
        </tr>`;
    }).join('');
    return `<div class="gs-table-wrap"><table class="gs-players">
        <thead><tr><th scope="col">Spieler</th>${hasTeams ? '<th scope="col">Team</th>' : ''}<th scope="col" class="num">Punkte</th><th scope="col" class="num gs-ping">Ping</th><th scope="col"><span class="sr-only">Aktionen</span></th></tr></thead>
        <tbody>${rows}</tbody>
    </table></div>`;
}

function gameServerAdminHtml(server) {
    if (!isAdmin) return '';
    const unreal = GS_GAMES[server.game]?.unreal;
    if (!server.manageable) {
        return `<p class="gs-admin-missing admin-only">${icon('lock')}<span>${unreal ? 'Für die Verwaltung WebAdmin-Port, Benutzer und Passwort eintragen' : 'Für die Verwaltung das RCON-Passwort eintragen'} (Stift oben rechts).</span></p>`;
    }
    const id = escapeHtml(server.id);
    const has = action => server.actions.includes(action);
    return `<details class="gs-admin admin-only">
        <summary>${icon('settings')}<span>Verwalten</span><span class="muted">${unreal ? 'über WebAdmin' : 'über RCON'}</span></summary>
        <div class="gs-admin-body">
            <form class="gs-action-row" data-server="${id}" data-action="say" onsubmit="runGameServerAction(event)">
                <label class="sr-only" for="gsSay-${id}">Nachricht an alle</label>
                <input type="text" id="gsSay-${id}" name="value" maxlength="150" placeholder="Nachricht an alle" autocomplete="off" required>
                <button type="submit" class="btn btn-secondary btn-sm">Senden</button>
            </form>
            <form class="gs-action-row" data-server="${id}" data-action="map" onsubmit="runGameServerAction(event)">
                <label class="sr-only" for="gsMap-${id}">Map wechseln</label>
                <input type="text" id="gsMap-${id}" name="value" maxlength="64" placeholder="Map, z.B. ${escapeHtml(gsMapExample(server.game))}" autocomplete="off" spellcheck="false" required>
                <button type="submit" class="btn btn-secondary btn-sm">Map wechseln</button>
            </form>
            <div class="gs-action-buttons">
                ${has('restart') ? `<button type="button" class="btn btn-ghost btn-sm" data-server="${id}" data-action="restart" onclick="runGameServerButton(this)">${icon('refresh')}<span>Map neu starten</span></button>` : ''}
                ${has('next') ? `<button type="button" class="btn btn-ghost btn-sm" data-server="${id}" data-action="next" onclick="runGameServerButton(this)">${icon('chevron')}<span>Nächste Map</span></button>` : ''}
            </div>
            <form class="gs-console" data-server="${id}" onsubmit="runGameServerConsole(event)">
                <label for="gsCmd-${id}">Konsole <span class="label-hint">${unreal ? 'Befehl an die Server-Konsole der WebAdmin' : 'RCON-Befehl, z.B. status'}</span></label>
                <div class="gs-action-row">
                    <input type="text" id="gsCmd-${id}" name="command" maxlength="300" autocomplete="off" spellcheck="false" placeholder="${unreal ? 'z.B. say Hallo' : 'z.B. status'}" required>
                    <button type="submit" class="btn btn-primary btn-sm">Ausführen</button>
                </div>
                <pre class="gs-output" hidden></pre>
            </form>
        </div>
    </details>`;
}

const gsMapExample = game => ({ ut99: 'DM-Deck16][', ut2004: 'ONS-Torlan', cod2: 'mp_toujane', cod4: 'mp_crash', cs2: 'de_dust2', q3: 'q3dm17' }[game] ?? '');

async function copyGameServerAddress(button) {
    await copyText(button.dataset.address);
    notify(`${button.dataset.address} kopiert`);
}

function showGameServerSeat(attendeeId) {
    const seat = gsSeats.get(attendeeId);
    if (!seat) return;
    currentRoomId = seat.room;
    try { localStorage.setItem('mcd.seatRoom', String(seat.room)); } catch { /* storage unavailable */ }
    pendingSeatJump = { room: seat.room, key: seat.key };
    location.hash = '#sitzplan';
}

/* Administration
   ========================================================================== */

// Output of the last command below the console of that server
function showGameServerOutput(serverId, text, isError = false) {
    const card = document.querySelector(`.gs-card[data-id="${CSS.escape(serverId)}"]`);
    const output = card?.querySelector('.gs-output');
    if (!output) return;
    output.hidden = false;
    output.classList.toggle('is-error', isError);
    output.textContent = text.replace(/\^\d/g, '') || '(keine Ausgabe)'; // without Quake 3/CoD color codes
    card.querySelector('.gs-admin').open = true;
}

async function postGameServer(serverId, path, body) {
    const result = await apiFetch(`/events/${currentEventId}/gameservers/${encodeURIComponent(serverId)}/${path}`, { method: 'POST', body: JSON.stringify(body) });
    showGameServerOutput(serverId, `> ${result.command}\n${result.output}`);
    setTimeout(() => refreshGameServerStatus(), 1500); // let the server apply it first
    return result;
}

async function runGameServerAction(event) {
    event.preventDefault();
    const form = event.target;
    const input = form.elements.value;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
        await postGameServer(form.dataset.server, 'action', { action: form.dataset.action, value: input.value });
        if (form.dataset.action === 'say') input.value = '';
    } catch (error) {
        showGameServerOutput(form.dataset.server, error.message, true);
    } finally {
        button.disabled = false;
    }
}

async function runGameServerButton(button) {
    const labels = { restart: 'Die laufende Map neu starten?', next: 'Zur nächsten Map der Rotation wechseln?' };
    if (!await confirmDialog(labels[button.dataset.action], { title: 'Server', confirmLabel: 'Ja', danger: false })) return;
    button.disabled = true;
    try {
        await postGameServer(button.dataset.server, 'action', { action: button.dataset.action });
    } catch (error) {
        showGameServerOutput(button.dataset.server, error.message, true);
    } finally {
        button.disabled = false;
    }
}

async function runGameServerConsole(event) {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
        await postGameServer(form.dataset.server, 'rcon', { command: form.elements.command.value });
        form.elements.command.select();
    } catch (error) {
        showGameServerOutput(form.dataset.server, error.message, true);
    } finally {
        button.disabled = false;
    }
}

async function kickGameServerPlayer(button) {
    if (!await confirmDialog(`${button.dataset.name} vom Server werfen?`, { title: 'Spieler kicken', confirmLabel: 'Kicken' })) return;
    try {
        await postGameServer(button.dataset.server, 'action', { action: 'kick', value: button.dataset.num });
        notify(`${button.dataset.name} gekickt`);
    } catch (error) {
        notify(`Kicken fehlgeschlagen: ${error.message}`);
    }
}

/* Server list (admins): dialog, the whole list goes to PUT /events/:id/gameservers
   ========================================================================== */

let gsEditingId = null;

function openGameServerModal(id = null) {
    const server = id ? gsServers.find(s => s.id === id) : null;
    gsEditingId = server?.id ?? null;
    document.getElementById('gsModalTitle').textContent = server ? 'Server bearbeiten' : 'Server hinzufügen';
    document.getElementById('gsGame').value = server?.game ?? 'cs2';
    document.getElementById('gsName').value = server?.name ?? '';
    document.getElementById('gsHost').value = server?.host ?? '';
    document.getElementById('gsPort').value = server?.port ?? '';
    // A query port equal to the default is shown empty (= default)
    const defaultQuery = server ? server.port + (GS_GAMES[server.game]?.unreal ? 1 : 0) : null;
    document.getElementById('gsQueryPort').value = server && server.query_port !== defaultQuery ? server.query_port : '';
    document.getElementById('gsRcon').value = '';
    document.getElementById('gsRconClear').checked = false;
    document.getElementById('gsRconClearRow').hidden = !server?.has_rcon_password;
    document.getElementById('gsRcon').placeholder = server?.has_rcon_password ? 'gespeichert — leer lassen = behalten' : '';
    document.getElementById('gsWebPort').value = server?.webadmin_port ?? '';
    document.getElementById('gsWebPath').value = server?.webadmin_path ?? '/ServerAdmin';
    document.getElementById('gsWebUser').value = server?.webadmin_user ?? '';
    document.getElementById('gsWebPassword').value = '';
    document.getElementById('gsWebPassword').placeholder = server?.has_webadmin_password ? 'gespeichert — leer lassen = behalten' : '';
    document.getElementById('gsWebClear').checked = false;
    document.getElementById('gsWebClearRow').hidden = !server?.has_webadmin_password;
    document.getElementById('gsInfo').value = server?.info ?? '';
    document.getElementById('gsDelete').hidden = !server;
    document.getElementById('gsError').textContent = '';
    updateGameServerForm();
    openModal('gsModal');
}

// Unreal games: WebAdmin instead of RCON; port placeholders per game
function updateGameServerForm() {
    const game = GS_GAMES[document.getElementById('gsGame').value];
    document.getElementById('gsRconFields').hidden = !!game.unreal;
    document.getElementById('gsWebFields').hidden = !game.unreal;
    document.getElementById('gsPort').placeholder = String(game.port);
    document.getElementById('gsQueryPort').placeholder = game.unreal ? '+1' : 'wie Spielport';
    document.getElementById('gsName').placeholder = game.label;
}

// Stored form of a server for the PUT (passwords empty = keep)
const gsStoredForm = server => ({
    id: server.id, name: server.name, game: server.game, host: server.host, port: server.port,
    query_port: server.query_port === server.port + (GS_GAMES[server.game]?.unreal ? 1 : 0) ? null : server.query_port,
    webadmin_port: server.webadmin_port, webadmin_path: server.webadmin_path, webadmin_user: server.webadmin_user, info: server.info,
    container: server.container,
});

async function putGameServers(servers) {
    gsServers = await apiFetch(`/events/${currentEventId}/gameservers`, { method: 'PUT', body: JSON.stringify({ servers }) });
    renderGameServers();
    refreshGameServerStatus();
}

async function saveGameServer(event) {
    event.preventDefault();
    const value = id => document.getElementById(id).value;
    const edited = {
        id: gsEditingId ?? undefined,
        game: value('gsGame'),
        name: value('gsName'),
        host: value('gsHost'),
        port: value('gsPort'),
        query_port: value('gsQueryPort'),
        rcon_password: value('gsRcon'),
        clear_rcon_password: document.getElementById('gsRconClear').checked,
        webadmin_port: value('gsWebPort'),
        webadmin_path: value('gsWebPath'),
        webadmin_user: value('gsWebUser'),
        webadmin_password: value('gsWebPassword'),
        clear_webadmin_password: document.getElementById('gsWebClear').checked,
        info: value('gsInfo'),
        container: gsServers.find(s => s.id === gsEditingId)?.container ?? null,
    };
    const servers = gsEditingId
        ? gsServers.map(s => (s.id === gsEditingId ? edited : gsStoredForm(s)))
        : [...gsServers.map(gsStoredForm), edited];
    try {
        await putGameServers(servers);
        closeModal('gsModal');
    } catch (error) {
        document.getElementById('gsError').textContent = error.message;
    }
}

async function deleteGameServer() {
    const server = gsServers.find(s => s.id === gsEditingId);
    if (!server || !await confirmDialog(`Server „${server.name}“ aus der Liste entfernen?`, { title: 'Server entfernen', confirmLabel: 'Entfernen' })) return;
    try {
        await putGameServers(gsServers.filter(s => s.id !== server.id).map(gsStoredForm));
        closeModal('gsModal');
    } catch (error) {
        document.getElementById('gsError').textContent = error.message;
    }
}

// Login/logout (loadAuth in app.js): admins get more fields and the administration
function onGameServerAuth() {
    if (document.body.dataset.view === 'servers') loadGameServers();
    else gsListKey = '';
}

/* Dockhand (src/dockhand.ts): container state on the card, start/stop/restart, settings and import
   ========================================================================== */

const GS_CONTAINER_STATES = {
    running: 'läuft', exited: 'gestoppt', created: 'nicht gestartet', restarting: 'startet neu', paused: 'pausiert',
    dead: 'abgestürzt', removing: 'wird entfernt', missing: 'fehlt in Dockhand', unknown: 'Dockhand nicht erreichbar',
};

function gameServerContainerHtml(server, status) {
    const container = status.container;
    if (!container) return '';
    const running = container.state === 'running';
    const known = container.state !== 'missing' && container.state !== 'unknown';
    const id = escapeHtml(server.id);
    const buttons = isAdmin && known ? `<span class="gs-container-actions">
        ${running ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-server="${id}" data-action="start" onclick="runContainerAction(this)">${icon('play')}<span>Starten</span></button>`}
        ${running || container.state === 'restarting' ? `<button type="button" class="btn btn-ghost btn-sm" data-server="${id}" data-action="restart" onclick="runContainerAction(this)">${icon('refresh')}<span>Neustart</span></button>
        <button type="button" class="btn btn-ghost btn-sm" data-server="${id}" data-action="stop" onclick="runContainerAction(this)">${icon('stop')}<span>Stoppen</span></button>` : ''}
    </span>` : '';
    const error = isAdmin && status.dockhand_error ? `<span class="gs-container-error">${escapeHtml(status.dockhand_error)}</span>` : '';
    return `<div class="gs-container is-${escapeHtml(container.state)}">
        <p>${icon('server')}<span>Container <code>${escapeHtml(container.name)}</code> · <strong>${escapeHtml(GS_CONTAINER_STATES[container.state] ?? container.state)}</strong>${container.status ? ` <span class="muted">(${escapeHtml(container.status)})</span>` : ''}</span></p>
        ${buttons}${error}
    </div>`;
}

async function runContainerAction(button) {
    const server = gsServers.find(s => s.id === button.dataset.server);
    const action = button.dataset.action;
    const texts = {
        start: { question: `Container von „${server?.name}“ starten?`, label: 'Starten', danger: false, done: 'gestartet' },
        restart: { question: `Container von „${server?.name}“ neu starten? Alle Spieler fliegen kurz raus.`, label: 'Neu starten', danger: true, done: 'neu gestartet' },
        stop: { question: `Container von „${server?.name}“ stoppen? Der Server ist dann offline.`, label: 'Stoppen', danger: true, done: 'gestoppt' },
    }[action];
    if (!server || !await confirmDialog(texts.question, { title: 'Container', confirmLabel: texts.label, danger: texts.danger })) return;
    button.disabled = true;
    try {
        await apiFetch(`/events/${currentEventId}/gameservers/${encodeURIComponent(server.id)}/container`, { method: 'POST', body: JSON.stringify({ action }) });
        notify(`${server.name}: Container ${texts.done}`);
        setTimeout(() => refreshGameServerStatus(), 2500); // the game server needs a moment to answer again
    } catch (error) {
        notify(`Container-Aktion fehlgeschlagen: ${error.message}`);
        button.disabled = false;
    }
}

/* Settings: address, API token (stays on the server), Docker environment */

let dockhandEnvironments = [];

async function openDockhandSettings() {
    document.getElementById('dhError').textContent = '';
    document.getElementById('dhTestResult').textContent = '';
    let settings = { url: '', has_token: false, env_id: null, insecure_tls: false };
    try {
        settings = await apiFetch('/dockhand');
    } catch (error) {
        notify(`Dockhand-Einstellungen nicht lesbar: ${error.message}`);
        return;
    }
    document.getElementById('dhUrl').value = settings.url;
    document.getElementById('dhToken').value = '';
    document.getElementById('dhToken').placeholder = settings.has_token ? 'gespeichert — leer lassen = behalten' : 'dh_…';
    document.getElementById('dhInsecure').checked = settings.insecure_tls;
    dockhandEnvironments = settings.env_id != null ? [{ id: settings.env_id, name: `Umgebung ${settings.env_id}` }] : [];
    renderDockhandEnvironments(settings.env_id);
    openModal('dockhandModal');
    // With stored access: load the names of the environments right away
    if (settings.url && settings.has_token) testDockhand(true);
}

function renderDockhandEnvironments(selected) {
    const select = document.getElementById('dhEnv');
    select.innerHTML = dockhandEnvironments.length
        ? dockhandEnvironments.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')
        : '<option value="">Erst „Verbindung testen“</option>';
    if (selected != null) select.value = String(selected);
}

const dockhandForm = () => ({
    url: document.getElementById('dhUrl').value,
    token: document.getElementById('dhToken').value,
    env_id: document.getElementById('dhEnv').value || null,
    insecure_tls: document.getElementById('dhInsecure').checked,
});

async function testDockhand(quiet = false) {
    const result = document.getElementById('dhTestResult');
    const selected = document.getElementById('dhEnv').value || null;
    result.textContent = 'Verbinde…';
    document.getElementById('dhError').textContent = '';
    try {
        const answer = await apiFetch('/dockhand/test', { method: 'POST', body: JSON.stringify(dockhandForm()) });
        dockhandEnvironments = answer.environments;
        renderDockhandEnvironments(selected ?? answer.environments[0]?.id);
        result.textContent = answer.containers != null
            ? `Verbunden — ${answer.containers} Container in der gewählten Umgebung`
            : `Verbunden — ${answer.environments.length} Docker-Umgebung${answer.environments.length === 1 ? '' : 'en'}, bitte wählen`;
    } catch (error) {
        result.textContent = '';
        if (!quiet) document.getElementById('dhError').textContent = error.message;
        else document.getElementById('dhError').textContent = `Verbindung fehlgeschlagen: ${error.message}`;
    }
}

async function saveDockhandSettings(event) {
    event.preventDefault();
    try {
        const settings = await apiFetch('/dockhand', { method: 'PUT', body: JSON.stringify(dockhandForm()) });
        closeModal('dockhandModal');
        notify(settings.configured ? 'Dockhand verbunden' : 'Gespeichert — für den Import fehlt noch die Docker-Umgebung');
    } catch (error) {
        document.getElementById('dhError').textContent = error.message;
    }
}

/* Import: preview of all containers, recognized game servers preselected */

let dockhandItems = [];

async function openDockhandImport() {
    if (currentEventId == null) return;
    const list = document.getElementById('dhImportList');
    list.innerHTML = '<p class="loading">Lese Container aus Dockhand…</p>';
    document.getElementById('dhImportError').textContent = '';
    openModal('dockhandImportModal');
    try {
        dockhandItems = (await apiFetch(`/events/${currentEventId}/dockhand/preview`, { method: 'POST', body: '{}' })).items;
    } catch (error) {
        list.innerHTML = '';
        document.getElementById('dhImportError').textContent = /nicht eingerichtet/.test(error.message)
            ? `${error.message}. Über das Zahnrad neben „Aus Dockhand“ verbinden.`
            : error.message;
        return;
    }
    renderDockhandImport();
}

const DH_ACTIONS = { create: 'Neu', update: 'Aktualisieren', unchanged: 'Unverändert', 'no-host': 'Keine IP', unknown: 'Kein Gameserver erkannt' };

function dockhandItemHtml(item, index) {
    const c = item.candidate;
    const games = Object.entries(GS_GAMES).map(([id, game]) => `<option value="${id}"${c.game === id ? ' selected' : ''}>${escapeHtml(game.short)}</option>`).join('');
    const checked = item.action === 'create' || item.action === 'update';
    const disabled = item.action === 'no-host';
    const port = c.game ? (c.port ?? GS_GAMES[c.game].port) : null;
    // Found passwords, unless the list of changes already names them
    const secrets = [c.has_rcon_password ? 'RCON-Passwort' : '', c.has_webadmin_password ? 'WebAdmin-Passwort' : '']
        .filter(secret => secret && !item.changes.includes(`${secret} aus dem Container`));
    const details = [
        c.host ? `<code>${escapeHtml(c.host)}${port ? `:${port}` : ''}</code>` : '<span class="is-warning">keine LAN-IP (Label mcd.host setzen)</span>',
        secrets.length ? `${escapeHtml(secrets.join(' + '))} gefunden` : c.game && !c.env_read ? 'Umgebungsvariablen nicht lesbar' : '',
        item.changes.length && item.action !== 'create' ? escapeHtml(item.changes.join(' · ')) : '',
    ].filter(Boolean).join(' · ');
    return `<li class="dh-item is-${item.action}">
        <input type="checkbox" id="dhItem${index}" data-index="${index}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="updateDockhandImportCount()">
        <label for="dhItem${index}" class="dh-item-main">
            <span class="dh-item-name">${escapeHtml(c.container_name)} <span class="dh-badge">${escapeHtml(DH_ACTIONS[item.action])}</span>${c.state !== 'running' ? ` <span class="muted">(${escapeHtml(GS_CONTAINER_STATES[c.state] ?? c.state)})</span>` : ''}</span>
            <span class="dh-item-image">${escapeHtml(c.image)}</span>
            ${details ? `<span class="dh-item-details">${details}</span>` : ''}
        </label>
        <select data-index="${index}" aria-label="Spiel für ${escapeHtml(c.container_name)}" onchange="dockhandGameChanged(this)">
            ${c.game ? '' : '<option value="" selected>Spiel…</option>'}${games}
        </select>
    </li>`;
}

function renderDockhandImport() {
    const list = document.getElementById('dhImportList');
    const relevant = dockhandItems.map((item, i) => [item, i]).filter(([item]) => item.action !== 'unknown');
    const others = dockhandItems.map((item, i) => [item, i]).filter(([item]) => item.action === 'unknown');
    list.innerHTML = `
        ${relevant.length ? `<ul class="dh-list">${relevant.map(([item, i]) => dockhandItemHtml(item, i)).join('')}</ul>` : '<p class="empty-state">Kein Container als Gameserver erkannt. Setze am Container das Label <code>mcd.game</code> oder wähle unten das Spiel von Hand.</p>'}
        ${others.length ? `<details class="dh-others"><summary>Andere Container (${others.length})</summary><ul class="dh-list">${others.map(([item, i]) => dockhandItemHtml(item, i)).join('')}</ul></details>` : ''}`;
    updateDockhandImportCount();
}

// Choosing a game for an unrecognized container selects it
function dockhandGameChanged(select) {
    const box = document.getElementById(`dhItem${select.dataset.index}`);
    if (select.value && !box.disabled) box.checked = true;
    updateDockhandImportCount();
}

function chosenDockhandItems() {
    return [...document.querySelectorAll('#dhImportList input[type=checkbox]:checked')].map(box => {
        const index = Number(box.dataset.index);
        return { container_id: dockhandItems[index].candidate.container_id, game: document.querySelector(`#dhImportList select[data-index="${index}"]`).value };
    });
}

function updateDockhandImportCount() {
    const count = chosenDockhandItems().length;
    const button = document.getElementById('dhImportApply');
    button.disabled = count === 0;
    setButtonLabel(button, count ? `${count} übernehmen` : 'Übernehmen');
}

async function applyDockhandImport() {
    const items = chosenDockhandItems();
    if (items.some(item => !item.game)) {
        document.getElementById('dhImportError').textContent = 'Für jeden gewählten Container ein Spiel wählen';
        return;
    }
    const button = document.getElementById('dhImportApply');
    button.disabled = true;
    try {
        const result = await apiFetch(`/events/${currentEventId}/dockhand/apply`, { method: 'POST', body: JSON.stringify({ items }) });
        closeModal('dockhandImportModal');
        const parts = [result.created ? `${result.created} neu` : '', result.updated ? `${result.updated} aktualisiert` : ''].filter(Boolean);
        notify(`Aus Dockhand übernommen: ${parts.join(', ') || 'nichts geändert'}${result.skipped.length ? ` — ohne IP übersprungen: ${result.skipped.join(', ')}` : ''}`);
        await loadGameServers();
    } catch (error) {
        document.getElementById('dhImportError').textContent = error.message;
        button.disabled = false;
    }
}
