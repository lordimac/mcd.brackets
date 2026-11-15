// Game servers of an event (#server). Two modes like the seat plan: "Ansehen" (default, everyone) is a
// live board — who plays where, joining with one tap; "Verwalten" (admins) adds IPs, the container
// state, quick actions and the RCON/WebAdmin console. The card frame stays, only the live part is
// redrawn on every poll (typed text and console output survive). Passwords never come from the
// server: an empty field keeps the stored one (src/gameservers.ts).
// Shares currentEventId/ensureCurrentEvent with lan.js; uses apiFetch, escapeHtml, icon, openModal,
// closeModal, confirmDialog, notify, announce, isAdmin from app.js, me/isMe from welcome.js, copyText from shares.js.

const GS_GAMES = {
    ut99: { label: 'Unreal Tournament', short: 'UT99', port: 7777, unreal: true, link: 'unreal' },
    ut2004: { label: 'Unreal Tournament 2004', short: 'UT2004', port: 7777, unreal: true, link: 'ut2004' },
    cod2: { label: 'Call of Duty 2', short: 'CoD2', port: 28960 },
    cod4: { label: 'Call of Duty 4', short: 'CoD4', port: 28960 },
    cs2: { label: 'Counter-Strike 2', short: 'CS2', port: 27015, link: 'steam' },
    q3: { label: 'Quake III Arena', short: 'Q3', port: 27960 },
};
// Readable names for the short game types the servers report
const GS_GAMETYPES = {
    cod: { sd: 'Search & Destroy', dm: 'Deathmatch', tdm: 'Team Deathmatch', war: 'Team Deathmatch', ctf: 'Capture the Flag', dom: 'Domination', koth: 'Hauptquartier', hq: 'Hauptquartier', sab: 'Sabotage', bel: 'Behind Enemy Lines' },
    q3: { 0: 'Free for All', 1: 'Turnier', 2: 'Einzelspieler', 3: 'Team Deathmatch', 4: 'Capture the Flag' },
};
const GS_TEAMS = { rot: 'red', red: 'red', blau: 'blue', blue: 'blue', grün: 'green', green: 'green', gold: 'gold' };
const GS_POLL_MS = 10000;
const GS_OUTPUT_ENTRIES = 15;

let gsServers = [];          // GET /events/:id/gameservers
let gsStatus = new Map();    // server id → status
let gsSeats = new Map();     // attendee id → { room, key, label } (final rooms only)
let gsTimer = null;
let gsLoading = false;
let gsStale = false;         // last poll failed: the shown state is old
let gsListKey = '';          // re-render the cards only when the list itself changes
let gsMode = 'view';         // 'view' or 'manage' (admins)
const gsWasOnline = new Map(); // server id → online at the last poll (announce changes)
const gsIconMissing = new Set(); // games without an icon file (img/games/<game>.png): neutral symbol instead
let gsJumpHtml = '';         // the overview is only replaced when it changes (icons do not reload)
const gsHistory = new Map();   // server id → { list: [commands], pos }

try { if (localStorage.getItem('mcd.gsMode') === 'manage') gsMode = 'manage'; } catch { /* storage unavailable */ }

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
    applyGameServerMode();
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

/* Modes: the admin parts are always rendered for admins and only shown in "Verwalten"
   ========================================================================== */

function setGameServerMode(mode) {
    gsMode = mode === 'manage' && isAdmin ? 'manage' : 'view';
    try { localStorage.setItem('mcd.gsMode', gsMode); } catch { /* storage unavailable */ }
    applyGameServerMode();
    orderGameServerCards();
}

function applyGameServerMode() {
    if (!isAdmin) gsMode = 'view';
    document.getElementById('view-servers').classList.toggle('is-manage', gsMode === 'manage');
    document.querySelectorAll('#gsModeSwitch button').forEach(button => {
        const active = button.dataset.mode === gsMode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

async function loadGameServers() {
    gsListKey = '';
    gsStatus = new Map();
    gsWasOnline.clear();
    gsStale = false;
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
        gsStale = false;
        announceGameServerChanges();
        for (const server of gsServers) renderGameServerLive(server);
        orderGameServerCards();
        filterGameServerPlayers();
        if (manual) announce('Serverstatus aktualisiert');
    } catch (error) {
        gsStale = true;
        if (manual) notify(`Status konnte nicht abgefragt werden: ${error.message}`);
    } finally {
        gsLoading = false;
        button?.classList.remove('is-busy');
        renderGameServerSummary();
    }
}

// Screen readers hear when a server goes offline or comes back (not on the first poll)
function announceGameServerChanges() {
    const changes = [];
    for (const server of gsServers) {
        const status = gsStatus.get(server.id);
        if (!status) continue;
        const before = gsWasOnline.get(server.id);
        if (before !== undefined && before !== status.online) changes.push(`${server.name} ist ${status.online ? 'wieder online' : 'offline'}`);
        gsWasOnline.set(server.id, status.online);
    }
    if (changes.length) announce(changes.join('. '));
}

/* Rendering
   ========================================================================== */

const gsConnectAddress = server => `${server.host}:${server.port}`;

// Join: games that register a URL scheme get a link, the others the console command to copy
function gsJoin(server) {
    const address = gsConnectAddress(server);
    const link = { steam: `steam://connect/${address}`, unreal: `unreal://${address}`, ut2004: `ut2004://${address}` }[GS_GAMES[server.game]?.link];
    return link ? { link } : { command: `/connect ${address}` };
}

function gameServerJoinHtml(server) {
    const join = gsJoin(server);
    const address = escapeHtml(gsConnectAddress(server));
    const button = join.link
        ? `<a class="btn btn-sm gs-join" href="${escapeHtml(encodeURI(join.link))}" title="Startet das Spiel und verbindet mit ${address}">${icon('login')}<span>Beitreten</span></a>`
        : `<button type="button" class="btn btn-sm gs-join" data-command="${escapeHtml(join.command)}" onclick="copyGameServerJoin(this)" title="Kopiert ${escapeHtml(join.command)} für die Spielkonsole">${icon('login')}<span>Beitreten</span></button>`;
    return `<div class="gs-join-row">
        ${button}
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-address="${address}" onclick="copyGameServerAddress(this)" title="Adresse ${address} kopieren" aria-label="Adresse ${address} kopieren">${icon('copy')}</button>
    </div>`;
}

function renderGameServers() {
    const list = document.getElementById('gsList');
    const key = JSON.stringify(gsServers);
    if (key === gsListKey) return;
    gsListKey = key;
    if (currentEventId == null) {
        list.innerHTML = '<p class="empty-state">Lege zuerst unter „Teilnehmer“ ein Event an.</p>';
        renderGameServerJump();
        renderGameServerSummary();
        return;
    }
    if (!gsServers.length) {
        list.innerHTML = `<p class="empty-state">Noch keine Server eingetragen.${isAdmin ? ' Unter „Verwalten“ trägst du sie von Hand ein oder übernimmst sie aus Dockhand.' : ''}</p>`;
        renderGameServerJump();
        renderGameServerSummary();
        return;
    }
    const heads = gameServerGroups().map(group => `
        <h2 class="gs-group-head" id="gsGroup-${escapeHtml(group.game)}" data-game="${escapeHtml(group.game)}" tabindex="-1">
            ${gameIcon(group.game)}<span class="gs-group-name">${escapeHtml(group.label)}</span><span class="gs-group-count"></span>
        </h2>`).join('');
    list.innerHTML = heads + gsServers.map(server => `
        <article class="card gs-card" data-id="${escapeHtml(server.id)}" data-game="${escapeHtml(server.game)}" id="gs-${escapeHtml(server.id)}" aria-labelledby="gsName-${escapeHtml(server.id)}">
            <header class="gs-head">
                <div class="gs-title">
                    <h3 id="gsName-${escapeHtml(server.id)}" tabindex="-1">${escapeHtml(server.name)}</h3>
                    <p class="gs-meta"><span class="gs-game" title="${escapeHtml(server.game_label)}">${escapeHtml(server.game_short)}</span> <code>${escapeHtml(gsConnectAddress(server))}</code></p>
                </div>
                ${gameServerJoinHtml(server)}
                <button type="button" class="btn btn-ghost btn-icon gs-manage-only" data-id="${escapeHtml(server.id)}" onclick="openGameServerModal(this.dataset.id)" title="Server bearbeiten" aria-label="${escapeHtml(server.name)} bearbeiten">${icon('edit')}</button>
            </header>
            ${server.info ? `<p class="gs-info">${escapeHtml(server.info)}</p>` : ''}
            <div class="gs-live"><p class="gs-pending">Frage Server ab…</p></div>
            ${gameServerAdminHtml(server)}
        </article>`).join('');
    for (const server of gsServers) renderGameServerLive(server);
    orderGameServerCards();
    renderGameServerSummary();
}

// Problems an admin should see first (manage mode sorts them to the top)
function gsProblem(server, status) {
    if (!status) return 0;
    if (!status.online) return 3;
    if (status.container && status.container.state !== 'running') return 2;
    if (status.rcon === 'error') return 1;
    return 0;
}

// Board order: busy servers first, offline last; in "Verwalten" broken ones first
function sortedGameServers() {
    const index = new Map(gsServers.map((s, i) => [s.id, i]));
    return [...gsServers].sort((a, b) => {
        const sa = gsStatus.get(a.id);
        const sb = gsStatus.get(b.id);
        if (gsMode === 'manage') {
            const problem = gsProblem(b, sb) - gsProblem(a, sa);
            if (problem) return problem;
        } else if (sa && sb && sa.online !== sb.online) {
            return sa.online ? -1 : 1;
        }
        return (sb?.player_count ?? 0) - (sa?.player_count ?? 0) || index.get(a.id) - index.get(b.id);
    });
}

// The original icon of a game (public/img/games/<game>.png); without a file a neutral symbol
function gameIcon(game) {
    if (gsIconMissing.has(game)) return `<span class="gs-icon is-missing" aria-hidden="true">${icon('server')}</span>`;
    return `<span class="gs-icon" aria-hidden="true"><img src="img/games/${escapeHtml(game)}.png" alt="" width="64" height="64" data-game="${escapeHtml(game)}" onerror="gameIconFailed(this)"></span>`;
}

function gameIconFailed(img) {
    gsIconMissing.add(img.dataset.game);
    img.parentElement.classList.add('is-missing');
    img.outerHTML = icon('server');
}

// Servers by game: the games keep a fixed order (the board does not jump around), inside a game
// the board order of sortedGameServers()
function gameServerGroups(order = sortedGameServers()) {
    const games = Object.keys(GS_GAMES);
    const rank = game => (games.includes(game) ? games.indexOf(game) : games.length);
    return [...new Set(gsServers.map(s => s.game))]
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
        .map(game => {
            const servers = order.filter(s => s.game === game);
            const statuses = servers.map(s => gsStatus.get(s.id)).filter(Boolean);
            return {
                game,
                servers,
                label: GS_GAMES[game]?.label ?? servers[0].game_label,
                short: GS_GAMES[game]?.short ?? servers[0].game_short,
                known: statuses.length > 0,
                players: statuses.reduce((sum, s) => sum + (s.online ? s.player_count ?? 0 : 0), 0),
                offline: statuses.filter(s => !s.online).length,
            };
        });
}

// "6 Server · 12 Spieler · 1 offline" for a game
function gameGroupCountHtml(group) {
    return [
        `${group.servers.length} Server`,
        group.known ? `${group.players} Spieler` : '',
        group.offline ? `<span class="gs-group-offline">${group.offline} offline</span>` : '',
    ].filter(Boolean).join(' · ');
}

// Moves the group headings and cards (keeps their DOM, so open forms and console output stay)
// and redraws the overview
function orderGameServerCards() {
    const list = document.getElementById('gsList');
    const groups = gameServerGroups();
    const nodes = [];
    for (const group of groups) {
        const head = list.querySelector(`.gs-group-head[data-game="${CSS.escape(group.game)}"]`);
        if (head) {
            head.querySelector('.gs-group-count').innerHTML = gameGroupCountHtml(group);
            nodes.push(head);
        }
        for (const server of group.servers) {
            const card = list.querySelector(`.gs-card[data-id="${CSS.escape(server.id)}"]`);
            if (card) nodes.push(card);
        }
    }
    const current = [...list.querySelectorAll('.gs-group-head, .gs-card')];
    if (nodes.some((node, i) => current[i] !== node)) nodes.forEach(node => list.appendChild(node));
    renderGameServerJump(groups);
}

// Overview above the list (from three servers): one row per game — icon, name, players — with its
// servers as chips; a tap jumps to the game or the card. On a phone only the games.
function renderGameServerJump(groups = gameServerGroups()) {
    const nav = document.getElementById('gsJump');
    const html = gsServers.length < 3 ? '' : groups.map(group => {
        const chips = group.servers.map(server => {
            const status = gsStatus.get(server.id);
            const count = status?.online
                ? `<span class="gs-jump-count${status.player_count ? ' is-busy' : ''}">${status.player_count}<span class="sr-only"> Spieler</span></span>`
                : status ? '<span class="gs-jump-count is-offline">offline</span>' : '';
            return `<li><button type="button" class="gs-jump-chip${status && !status.online ? ' is-offline' : ''}" data-id="${escapeHtml(server.id)}" onclick="jumpToGameServer(this.dataset.id)"><span class="gs-jump-name">${escapeHtml(server.name)}</span> ${count}</button></li>`;
        }).join('');
        return `<div class="gs-jump-group" role="group" aria-label="${escapeHtml(group.label)}">
            <button type="button" class="gs-jump-game${group.offline ? ' has-offline' : ''}" data-game="${escapeHtml(group.game)}" onclick="jumpToGameGroup(this.dataset.game)" title="Zu den ${escapeHtml(group.label)}-Servern springen">
                ${gameIcon(group.game)}
                <span class="gs-jump-game-text">
                    <span class="gs-jump-game-name"><span class="label-long">${escapeHtml(group.label)}</span><span class="label-short">${escapeHtml(group.short)}</span></span>
                    <span class="gs-jump-game-count">${gameGroupCountHtml(group)}</span>
                </span>
            </button>
            <ul class="gs-jump-servers">${chips}</ul>
        </div>`;
    }).join('');
    if (html === gsJumpHtml) return;
    gsJumpHtml = html;
    nav.hidden = !html;
    nav.innerHTML = html;
}

function scrollToGameServerNode(node, focus) {
    node.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    focus.focus({ preventScroll: true });
}

function jumpToGameServer(id) {
    const card = document.getElementById(`gs-${id}`);
    if (card) scrollToGameServerNode(card, card.querySelector('h3'));
}

function jumpToGameGroup(game) {
    const head = document.getElementById(`gsGroup-${game}`);
    if (head) scrollToGameServerNode(head, head);
}

const gsClock = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function renderGameServerSummary() {
    const target = document.getElementById('gsSummary');
    renderGameServerMeHint();
    if (!gsServers.length) {
        target.innerHTML = '';
        return;
    }
    const statuses = gsServers.map(s => gsStatus.get(s.id)).filter(Boolean);
    if (!statuses.length) {
        target.textContent = `${gsServers.length} Server · frage ab…`;
        return;
    }
    const online = statuses.filter(s => s.online).length;
    const offline = gsServers.filter(s => gsStatus.get(s.id) && !gsStatus.get(s.id).online);
    const players = statuses.reduce((sum, s) => sum + (s.player_count ?? 0), 0);
    const latest = statuses.reduce((max, s) => (s.queried_at > max ? s.queried_at : max), statuses[0].queried_at);
    target.innerHTML = [
        `<span>${online} von ${gsServers.length} online</span>`,
        offline.length ? `<button type="button" class="gs-summary-alert" data-id="${escapeHtml(offline[0].id)}" onclick="jumpToGameServer(this.dataset.id)">${icon('alert')}<span>${offline.length} offline</span></button>` : '',
        `<span>${players} Spieler</span>`,
        `<span class="${gsStale ? 'gs-stale' : ''}">Stand ${gsClock(latest)}${gsStale ? ' · veraltet, Abfrage fehlgeschlagen' : ''}</span>`,
    ].filter(Boolean).join('<span class="gs-sep" aria-hidden="true">·</span>');
}

// Unrecognized devices never see "du": say so once and point to the check-in on the start page
function renderGameServerMeHint() {
    const hint = document.getElementById('gsMeHint');
    hint.hidden = !(gsServers.length && (me?.status === 'unknown' || me?.status === 'unassigned'));
}

const gsSame = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

function gameTypeLabel(server, status) {
    const type = String(status.gametype ?? '').trim();
    if (!type || gsSame(type, server.game_label) || gsSame(type, server.game_short) || gsSame(type, GS_GAMES[server.game]?.label)) return '';
    const family = server.game.startsWith('cod') ? 'cod' : server.game;
    return GS_GAMETYPES[family]?.[type.toLowerCase()] ?? type;
}

function renderGameServerLive(server) {
    const card = document.querySelector(`.gs-card[data-id="${CSS.escape(server.id)}"]`);
    if (!card) return;
    const status = gsStatus.get(server.id);
    card.classList.toggle('is-offline', status ? !status.online : false);
    card.classList.toggle('has-problem', gsProblem(server, status) > 0);
    const live = card.querySelector('.gs-live');
    if (!status) return;
    if (!status.online) {
        live.innerHTML = `<p class="gs-state is-offline"><span class="gs-online"><span class="gs-dot" aria-hidden="true"></span>Offline</span> <span class="gs-reason">${escapeHtml(status.error ?? 'antwortet nicht')}</span></p>${gameServerContainerHtml(server, status)}`;
        return;
    }
    const max = status.max_players ? `<span class="muted"> / ${status.max_players}</span>` : '';
    const bots = status.bot_count ? `<span class="muted"> · ${status.bot_count} ${status.bot_count === 1 ? 'Bot' : 'Bots'}</span>` : '';
    const type = gameTypeLabel(server, status);
    const rconHint = isAdmin && status.rcon === 'error' ? `<p class="gs-warning gs-manage-only">${icon('alert')}<span>RCON: ${escapeHtml(status.rcon_error ?? 'Fehler')} — Spieler ohne IP-Zuordnung</span></p>` : '';
    live.innerHTML = `
        <p class="gs-state">
            <span class="gs-online"><span class="gs-dot" aria-hidden="true"></span>Online</span>
            <span class="gs-fact"><span class="gs-fact-label">Map</span><span class="gs-map">${escapeHtml(status.map || '–')}</span></span>
            ${type ? `<span class="gs-fact">${escapeHtml(type)}</span>` : ''}
            <span class="gs-fact"><strong class="gs-count">${status.player_count}</strong>${max} Spieler${bots}</span>
        </p>
        ${status.hostname && status.hostname !== server.name ? `<p class="gs-hostname gs-manage-only">Name im Spiel: ${escapeHtml(status.hostname)}</p>` : ''}
        ${rconHint}
        ${gameServerContainerHtml(server, status)}
        ${gamePlayersHtml(server, status)}`;
}

function gamePlayersHtml(server, status) {
    if (!status.players.length) return '<p class="gs-empty">Gerade spielt niemand — sei der Erste.</p>';
    const hasTeams = status.players.some(p => p.team);
    const canKick = isAdmin && server.manageable && server.actions.includes('kick');
    const rows = status.players.map(p => {
        const mine = p.attendee_id != null && typeof isMe === 'function' && isMe(p.attendee_id);
        const seat = p.attendee_id != null ? gsSeats.get(p.attendee_id) : null;
        const shownName = p.display_name ?? p.name;
        const ingame = p.display_name && p.name !== p.display_name && p.name !== p.nickname ? `<span class="gs-ingame">als ${escapeHtml(p.name)}</span>` : '';
        const ip = isAdmin && p.ip ? `<span class="gs-ip gs-manage-only">${escapeHtml(p.ip)}</span>` : '';
        const team = GS_TEAMS[String(p.team ?? '').toLowerCase()];
        const actions = [
            seat ? `<button type="button" class="btn btn-ghost btn-sm" data-attendee="${p.attendee_id}" onclick="showGameServerSeat(Number(this.dataset.attendee))" title="Sitzplatz zeigen" aria-label="Sitzplatz ${escapeHtml(seat.label || '')} von ${escapeHtml(shownName)} zeigen">${icon('seat')}<span>${escapeHtml(seat.label || 'Platz')}</span></button>` : '',
            canKick && p.num != null && !p.bot ? `<button type="button" class="btn btn-ghost btn-sm gs-kick gs-manage-only" data-server="${escapeHtml(server.id)}" data-num="${p.num}" data-name="${escapeHtml(shownName)}" onclick="kickGameServerPlayer(this)" title="Vom Server werfen" aria-label="${escapeHtml(shownName)} kicken">${icon('user-x')}<span class="gs-kick-label">Kicken</span></button>` : '',
        ].join('');
        return `<tr class="${mine ? 'is-me' : ''}${p.bot ? ' is-bot' : ''}" data-search="${escapeHtml([shownName, p.name, p.nickname].filter(Boolean).join(' ').toLowerCase())}">
            <td class="gs-player">
                <span class="gs-name">${escapeHtml(shownName)}</span>${mine ? '<span class="me-tag"><span class="sr-only">, </span>du</span>' : ''}${p.bot ? '<span class="gs-bot"><span class="sr-only">, </span>Bot</span>' : ''}
                ${ingame}${ip}
            </td>
            ${hasTeams ? `<td class="gs-team">${p.team ? `<span class="gs-team-tag${team ? ` gs-team-${team}` : ''}">${escapeHtml(p.team)}</span>` : ''}</td>` : ''}
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

// Search across all servers ("/" focuses it): rows and cards without a match are hidden
function filterGameServerPlayers() {
    const query = document.getElementById('gsSearch').value.trim().toLowerCase();
    let matches = 0;
    document.querySelectorAll('#gsList .gs-card').forEach(card => {
        let found = 0;
        card.querySelectorAll('.gs-players tbody tr').forEach(row => {
            const hit = !query || row.dataset.search.includes(query);
            row.hidden = !hit;
            if (hit) found += 1;
        });
        card.hidden = !!query && found === 0;
        matches += found;
    });
    document.querySelectorAll('#gsList .gs-group-head').forEach(head => {
        head.hidden = !document.querySelector(`#gsList .gs-card[data-game="${CSS.escape(head.dataset.game)}"]:not([hidden])`);
    });
    const result = document.getElementById('gsSearchResult');
    result.hidden = !query;
    result.textContent = query ? (matches ? `${matches} Spieler gefunden` : `Niemand namens „${query}“ spielt gerade.`) : '';
}

function gameServerAdminHtml(server) {
    if (!isAdmin) return '';
    const unreal = GS_GAMES[server.game]?.unreal;
    const id = escapeHtml(server.id);
    if (!server.manageable) {
        return `<div class="gs-admin-missing gs-manage-only">${icon('lock')}<span>${unreal ? 'Für die Verwaltung fehlen WebAdmin-Port, Benutzer und Passwort.' : 'Für die Verwaltung fehlt das RCON-Passwort.'}</span>
            <button type="button" class="btn btn-secondary btn-sm" data-id="${id}" onclick="openGameServerModal(this.dataset.id)">${unreal ? 'WebAdmin eintragen' : 'RCON-Passwort eintragen'}</button></div>`;
    }
    const has = action => server.actions.includes(action);
    return `<section class="gs-admin gs-manage-only" aria-label="${escapeHtml(server.name)} verwalten">
        <h3 class="gs-admin-title">${icon('settings')}<span>Verwalten</span> <span class="muted">${unreal ? 'über WebAdmin' : 'über RCON'}</span></h3>
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
        ${has('restart') || has('next') ? `<div class="gs-action-buttons">
            ${has('restart') ? `<button type="button" class="btn btn-ghost btn-sm" data-server="${id}" data-action="restart" onclick="runGameServerButton(this)">${icon('refresh')}<span>Map neu starten</span></button>` : ''}
            ${has('next') ? `<button type="button" class="btn btn-ghost btn-sm" data-server="${id}" data-action="next" onclick="runGameServerButton(this)">${icon('skip')}<span>Nächste Map</span></button>` : ''}
        </div>` : ''}
        <details class="gs-console">
            <summary>${icon('chevron')}<span>Konsole</span> <span class="muted">${unreal ? 'Befehl an die WebAdmin-Konsole' : 'freier RCON-Befehl'}</span></summary>
            <form data-server="${id}" onsubmit="runGameServerConsole(event)">
                <label class="sr-only" for="gsCmd-${id}">Befehl</label>
                <div class="gs-action-row">
                    <input type="text" id="gsCmd-${id}" name="command" maxlength="300" autocomplete="off" spellcheck="false" placeholder="${unreal ? 'z.B. say Hallo' : 'z.B. status'}" data-server="${id}" onkeydown="gameServerHistoryKey(event)" required>
                    <button type="submit" class="btn btn-secondary btn-sm">Ausführen</button>
                </div>
                <p class="field-hint">Pfeil hoch/runter holt frühere Befehle zurück.</p>
            </form>
            <div class="gs-output-box" hidden>
                <div class="gs-output" role="log" aria-label="Ausgabe"></div>
                <button type="button" class="btn btn-ghost btn-sm" onclick="clearGameServerOutput(this)">${icon('x')}<span>Ausgabe leeren</span></button>
            </div>
        </details>
    </section>`;
}

const gsMapExample = game => ({ ut99: 'DM-Deck16][', ut2004: 'ONS-Torlan', cod2: 'mp_toujane', cod4: 'mp_crash', cs2: 'de_dust2', q3: 'q3dm17' }[game] ?? '');

async function copyGameServerAddress(button) {
    await copyText(button.dataset.address);
    notify(`${button.dataset.address} kopiert`);
}

async function copyGameServerJoin(button) {
    await copyText(button.dataset.command);
    notify(`„${button.dataset.command}“ kopiert — im Spiel die Konsole öffnen (Taste ^ bzw. ~) und einfügen.`);
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

// Console output of a server: the last entries stay, newest at the bottom
function showGameServerOutput(serverId, text, isError = false) {
    const card = document.querySelector(`.gs-card[data-id="${CSS.escape(serverId)}"]`);
    const output = card?.querySelector('.gs-output');
    if (!output) return;
    const entry = document.createElement('pre');
    entry.className = `gs-output-entry${isError ? ' is-error' : ''}`;
    entry.textContent = text.replace(/\^\d/g, '') || '(keine Ausgabe)'; // without Quake 3/CoD color codes
    output.appendChild(entry);
    while (output.children.length > GS_OUTPUT_ENTRIES) output.firstElementChild.remove();
    output.closest('.gs-output-box').hidden = false;
    card.querySelector('.gs-console').open = true;
    output.scrollTop = output.scrollHeight;
}

function clearGameServerOutput(button) {
    const box = button.closest('.gs-output-box');
    box.querySelector('.gs-output').innerHTML = '';
    box.hidden = true;
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
    const button = form.querySelector('button[type=submit]');
    const input = form.elements.command;
    const serverId = form.dataset.server;
    const history = gsHistory.get(serverId) ?? { list: [], pos: 0 };
    if (history.list.at(-1) !== input.value) history.list.push(input.value);
    history.list = history.list.slice(-30);
    history.pos = history.list.length;
    gsHistory.set(serverId, history);
    button.disabled = true;
    try {
        await postGameServer(serverId, 'rcon', { command: input.value });
        input.value = '';
    } catch (error) {
        showGameServerOutput(serverId, error.message, true);
    } finally {
        button.disabled = false;
        input.focus();
    }
}

// Arrow up/down in the console input walks through the commands sent before
function gameServerHistoryKey(event) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const history = gsHistory.get(event.target.dataset.server);
    if (!history?.list.length) return;
    event.preventDefault();
    history.pos = Math.max(0, Math.min(history.list.length, history.pos + (event.key === 'ArrowUp' ? -1 : 1)));
    event.target.value = history.list[history.pos] ?? '';
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
    const containerInfo = document.getElementById('gsContainerInfo');
    containerInfo.hidden = !server?.container;
    containerInfo.innerHTML = server?.container
        ? `${icon('server')}<span>Verknüpft mit Container <code>${escapeHtml(server.container.name)}</code> — Adresse, Port und Passwörter kommen bei „Aus Dockhand“ von dort.</span>`
        : '';
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
    document.getElementById('gsQueryPort').placeholder = game.unreal ? 'Spielport+1' : 'Spielport';
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
    applyGameServerMode();
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
    return `<div class="gs-container gs-manage-only is-${escapeHtml(container.state)}">
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
        secrets.length ? `${escapeHtml(secrets.join(' + '))} gefunden` : c.game && !c.env_read ? 'Port und Passwörter nicht lesbar — der Token braucht das Recht, Container zu inspizieren' : '',
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
