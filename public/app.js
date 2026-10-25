const API_URL = '/api';

// Escape user-provided text before inserting it into HTML templates
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Inline SVG icon from the sprite in index.html
function icon(name) {
    return `<svg class="icon"><use href="#i-${name}"/></svg>`;
}

// Shared helpers for fetch calls: parse JSON and turn API errors into exceptions
async function apiFetch(path, options = {}) {
    const response = await fetch(`${API_URL}${path}`, {
        ...options,
        headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== '/login') {
        await loadAuth();
        openLoginModal();
    }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

/* Admin login (ADMIN_PASSWORD on the server): without it everything is editable */

let isAdmin = true;

async function loadAuth() {
    let auth = { required: false, admin: true };
    try {
        auth = await (await fetch(`${API_URL}/auth`)).json();
    } catch (error) {
        console.error('Error loading auth state:', error);
    }
    isAdmin = auth.admin;
    document.body.classList.toggle('read-only', !auth.admin);
    document.getElementById('loginButton').style.display = auth.required && !auth.admin ? '' : 'none';
    document.getElementById('logoutButton').style.display = auth.required && auth.admin ? '' : 'none';
    renderPoints(); // fields are editable only for admins
}

function openLoginModal() {
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginError').textContent = '';
    openModal('loginModal');
    document.getElementById('loginPassword').focus();
}

async function login(e) {
    e.preventDefault();
    try {
        await apiFetch('/login', {
            method: 'POST',
            body: JSON.stringify({ password: document.getElementById('loginPassword').value })
        });
        closeModal('loginModal');
        await loadAuth();
        await reloadEventsForAuth();
        await loadOpnsenseSettings();
        if (typeof renderSeating === 'function') renderSeating();
    } catch (error) {
        document.getElementById('loginError').textContent = error.message;
        document.getElementById('loginPassword').select();
    }
}

async function logout() {
    await apiFetch('/logout', { method: 'POST', body: '{}' }).catch(() => null);
    await loadAuth();
    await reloadEventsForAuth();
    clearOpnsenseSettings();
    if (typeof renderSeating === 'function') renderSeating();
}

function openModal(id) {
    document.getElementById(id).classList.add('show');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('show');
}

// State
let stages = [];
let matches = [];
let participants = [];
let lanEvents = []; // events incl. attendee_count, shared with lan.js

// Import/Restore backup
async function importBackup(input) {
    const file = input.files[0];
    if (!file) return;
    const statusEl = document.getElementById('importStatus');
    statusEl.textContent = '⏳ Wird eingelesen...';
    try {
        const text = await file.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw new Error('Ungültiges JSON'); }
        const response = await fetch(`${API_URL}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Fehler beim Import');
        statusEl.textContent = '✅ ' + result.message;
        setTimeout(() => location.reload(), 1500);
    } catch (err) {
        statusEl.textContent = '❌ ' + err.message;
    }
    input.value = '';
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    restoreSections();
    await loadAuth();
    showView();
    await loadPoints();
    await loadEvents();
    await loadStages();
    await loadParticipants();
    await loadMatches();
});

function setupEventListeners() {
    document.getElementById('createTournamentForm').addEventListener('submit', createTournament);
    document.getElementById('loginForm').addEventListener('submit', login);
    document.getElementById('pointsForm').addEventListener('submit', savePoints);
    document.getElementById('scheduleForm').addEventListener('submit', saveSchedule);
    document.getElementById('pointsGrid').addEventListener('input', markChangedPoints);
    document.getElementById('eventName').addEventListener('change', updateEventPlayersHint);
    document.getElementById('tournamentType').addEventListener('change', updateTypeSettings);
    updateTypeSettings();
    window.addEventListener('hashchange', showView);
}

// Views: #turniere (default), #teilnehmer, #sitzplan and #zeitplan
const VIEWS = { '#teilnehmer': 'attendees', '#sitzplan': 'seating', '#zeitplan': 'timetable' };

function showView() {
    const view = VIEWS[location.hash] ?? 'tournaments';
    document.getElementById('view-tournaments').style.display = view === 'tournaments' ? '' : 'none';
    document.getElementById('view-attendees').style.display = view === 'attendees' ? '' : 'none';
    document.getElementById('view-seating').style.display = view === 'seating' ? '' : 'none';
    document.getElementById('view-timetable').style.display = view === 'timetable' ? '' : 'none';
    document.body.dataset.view = view;
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
    if (view === 'attendees' && typeof showAttendeeView === 'function') showAttendeeView();
    if (view === 'seating' && typeof showSeatingView === 'function') showSeatingView();
    if (view === 'timetable' && typeof showTimetableView === 'function') showTimetableView();
}

/* Footer: short statistics and the hint on a newer version (GET /api/info) */

let footerTimer = null;

// The footer is fixed at the bottom; reserve its (wrapping-dependent) height below the content
document.addEventListener('DOMContentLoaded', () => {
    const footer = document.querySelector('.site-footer');
    if (!footer || typeof ResizeObserver === 'undefined') return;
    new ResizeObserver(() => {
        document.documentElement.style.setProperty('--footer-height', `${footer.offsetHeight}px`);
    }).observe(footer);
});

// Debounced: several lists reload together after a change
function refreshFooter() {
    clearTimeout(footerTimer);
    footerTimer = setTimeout(loadFooterInfo, 300);
}

async function loadFooterInfo() {
    let info;
    try {
        info = await apiFetch('/info');
    } catch {
        return; // the footer just keeps its last state
    }
    const { stats, update } = info;
    const count = (n, one, many) => `<span><strong>${n}</strong> ${n === 1 ? one : many}</span>`;
    document.getElementById('footerStats').innerHTML = [
        count(stats.events, 'Event', 'Events'),
        count(stats.attendees, 'Teilnehmer', 'Teilnehmer'),
        count(stats.tournaments, 'Turnier', 'Turniere'),
        count(stats.matches_played, 'Match gespielt', 'Matches gespielt'),
    ].join('<span class="footer-sep" aria-hidden="true">·</span>');

    const link = document.getElementById('footerUpdate');
    link.hidden = !update?.available;
    if (update?.available) {
        link.href = update.url;
        link.textContent = `Neue Version ${update.latest} verfügbar`;
        link.title = `Auf GitHub ansehen (geprüft ${new Date(update.checked_at).toLocaleString('de-DE')})`;
    }
}

// Events with attendee counts (also used by the attendee view in lan.js)
// The WLAN password only comes with the admin session: after login/logout load the
// events again, otherwise the settings form would show (and save) an empty password
async function reloadEventsForAuth() {
    await loadEvents();
    if (typeof renderEventSelect === 'function') renderEventSelect();
}

async function loadEvents() {
    try {
        lanEvents = await apiFetch('/events');
    } catch (error) {
        console.error('Error loading events:', error);
        lanEvents = [];
    }
    updateEventDropdown();
    updateBrandLogo();
}

// Topbar: logo of the selected event (as on the IP slips), generic icon without one
function updateBrandLogo() {
    if (typeof ensureCurrentEvent === 'function') ensureCurrentEvent();
    const event = typeof currentEvent === 'function' ? currentEvent() : null;
    const mark = document.querySelector('.brand-mark');
    const img = mark.querySelector('img');
    mark.classList.toggle('has-logo', Boolean(event?.logo));
    if (event?.logo) {
        img.src = event.logo;
        img.alt = event.name;
    } else {
        img.removeAttribute('src');
    }
}

// Collapsible cards; the open/closed state is remembered per browser
const COLLAPSIBLE_SECTIONS = ['createTournamentSection', 'pointsSection', 'eventConfigSection', 'roomConfigSection'];

function toggleSection(sectionId, open) {
    const section = document.getElementById(sectionId);
    const iconEl = document.getElementById(sectionId.replace('Section', 'Icon'));

    const shouldOpen = open ?? section.style.display === 'none';
    section.style.display = shouldOpen ? 'block' : 'none';
    if (iconEl) iconEl.classList.toggle('is-open', shouldOpen);
    try { localStorage.setItem(`mcd.open.${sectionId}`, shouldOpen ? '1' : '0'); } catch { /* storage unavailable */ }
}

function restoreSections() {
    for (const id of COLLAPSIBLE_SECTIONS) {
        let stored = null;
        try { stored = localStorage.getItem(`mcd.open.${id}`); } catch { /* storage unavailable */ }
        if (stored === '1') toggleSection(id, true);
    }
}

// Event dropdown of the create form: events from the attendee management, newest first
function updateEventDropdown() {
    const eventSelect = document.getElementById('eventName');
    const currentValue = eventSelect.value;
    const events = [...lanEvents].reverse();

    eventSelect.innerHTML = '<option value="">Event auswählen...</option>' +
        events.map(event => `<option value="${escapeHtml(event.name)}">${escapeHtml(event.name)} (${event.attendee_count} Teilnehmer)</option>`).join('');

    if (events.some(e => e.name === currentValue)) {
        eventSelect.value = currentValue;
    } else if (events.length > 0) {
        eventSelect.value = events[0].name;
    }
    updateEventPlayersHint();
}

function updateEventPlayersHint() {
    const hint = document.getElementById('eventPlayersHint');
    const event = lanEvents.find(e => e.name === document.getElementById('eventName').value);
    if (!event) {
        hint.innerHTML = lanEvents.length
            ? 'Spieler sind automatisch alle Teilnehmer des Events.'
            : 'Noch kein Event vorhanden — unter <a href="#teilnehmer">Teilnehmer</a> anlegen.';
        hint.classList.remove('is-warning');
        return;
    }
    const enough = event.attendee_count >= 2;
    hint.innerHTML = enough
        ? `Es spielen alle <strong>${event.attendee_count}</strong> Teilnehmer des Events mit.`
        : `Das Event hat erst ${event.attendee_count} Teilnehmer — unter <a href="#teilnehmer">Teilnehmer</a> ergänzen.`;
    hint.classList.toggle('is-warning', !enough);
}

function updateEventFilter() {
    const eventFilter = document.getElementById('eventFilter');
    const currentValue = eventFilter.value;
    
    const events = [...new Set(stages.map(s => s.event_name).filter(e => e))];
    
    eventFilter.innerHTML = '<option value="">Alle Events</option>' +
        events.map(event => `<option value="${escapeHtml(event)}">${escapeHtml(event)}</option>`).join('');
    
    if (currentValue && events.includes(currentValue)) {
        eventFilter.value = currentValue;
    }
}

function filterStages() {
    displayStages();
}

// Load data
async function loadStages() {
    try {
        const response = await fetch(`${API_URL}/stages`);
        stages = await response.json();
        displayStages();
        displayEvents();
        updateStageFilter();
        updateEventFilter();
        refreshFooter();
    } catch (error) {
        console.error('Error loading stages:', error);
        document.getElementById('stagesList').innerHTML = 
            '<p class="empty-state">❌ Fehler beim Laden der Turniere</p>';
    }
}

async function loadMatches() {
    try {
        const response = await fetch(`${API_URL}/matches`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        matches = await response.json();
        displayMatches();
        refreshFooter();
    } catch (error) {
        console.error('Error loading matches:', error);
        document.getElementById('matchesList').innerHTML = 
            '<p class="empty-state">❌ Fehler beim Laden der Matches</p>';
    }
}

async function loadParticipants() {
    try {
        const response = await fetch(`${API_URL}/participants`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        participants = await response.json();
        displayStages(); // participant counts on the tournament cards
    } catch (error) {
        console.error('Error loading participants:', error);
    }
}

// Display functions
function displayStages() {
    const container = document.getElementById('stagesList');
    const eventFilter = document.getElementById('eventFilter').value;
    
    // By tournament number: a rebuilt stage gets a new ID but keeps its place in the list
    let filteredStages = [...stages].sort((a, b) => Number(a.tournament_id) - Number(b.tournament_id));
    if (eventFilter) {
        filteredStages = filteredStages.filter(s => s.event_name === eventFilter);
    }
    
    if (!filteredStages || filteredStages.length === 0) {
        container.innerHTML = '<p class="empty-state">Keine Turniere vorhanden. Erstelle ein neues Turnier!</p>';
        return;
    }

    container.innerHTML = filteredStages.map(stage => {
        const participantCount = participants.filter(p => p.tournament_id === stage.tournament_id && p.name).length;
        return `
        <div class="stage-item type-${escapeHtml(stage.type)}">
            <div class="stage-head">
                <div>
                    <h3>${escapeHtml(stage.name)}</h3>
                    ${stage.event_name ? `<p class="event-name">${icon('flag')}${escapeHtml(stage.event_name)}</p>` : ''}
                </div>
            </div>
            <div class="stage-info">
                <span class="info-badge badge-type">${formatType(stage.type)}</span>
                <span class="info-badge badge-id">${icon('users')}${participantCount}</span>
                <span class="info-badge badge-id">#${stage.tournament_id}</span>
            </div>
            ${stage.type === 'single_elimination' ? `
                <label class="toggle toggle-sm admin-only stage-option">
                    <input type="checkbox" ${stage.settings?.consolationFinal ? 'checked' : ''} onchange="setConsolationFinal(${stage.id}, this.checked, this)">
                    <span>Spiel um Platz 3</span>
                </label>
                ${stage.settings?.consolationFinal ? '<p class="stage-option-info read-only-only">mit Spiel um Platz 3</p>' : ''}
            ` : ''}
            ${stage.type === 'double_elimination' ? `
                <label class="toggle toggle-sm admin-only stage-option">
                    <input type="checkbox" ${stage.settings?.grandFinal === 'double' ? 'checked' : ''} onchange="setGrandFinalDouble(${stage.id}, this.checked, this)">
                    <span>Grand Final mit Rückspiel</span>
                </label>
                ${stage.settings?.grandFinal === 'double' ? '<p class="stage-option-info read-only-only">Grand Final mit Rückspiel</p>' : ''}
            ` : ''}
            ${nextDeadlineHtml(stage)}
            <div class="stage-actions">
                <button class="btn btn-primary btn-sm" onclick="viewBracket(${stage.id})">
                    ${icon('bracket')}<span>Bracket</span>
                </button>
                <button class="btn btn-secondary btn-sm" onclick="viewRankings(${stage.id})">
                    ${icon('chart')}<span>Rangliste</span>
                </button>
                <span class="spacer"></span>
                <button class="btn btn-ghost btn-icon" onclick="viewStageMatches(${stage.id})" title="Matches anzeigen" aria-label="Matches anzeigen">
                    ${icon('list')}
                </button>
                ${stage.type !== 'round_robin' ? `
                    <button class="btn btn-ghost btn-icon admin-only" onclick="openScheduleModal(${stage.id})" title="Spielzeiten: bis wann jede Runde gespielt sein muss" aria-label="Spielzeiten">
                        ${icon('clock')}
                    </button>
                ` : ''}
                <button class="btn btn-ghost btn-icon admin-only" onclick="resetBracket(${stage.id})" title="Neu auslosen (mit allen aktuellen Teilnehmern)" aria-label="Neu auslosen">
                    ${icon('shuffle')}
                </button>
                <button class="btn btn-danger btn-icon admin-only" onclick="deleteStage(${stage.id})" title="Turnier löschen" aria-label="Turnier löschen">
                    ${icon('trash')}
                </button>
            </div>
        </div>
    `;
    }).join('');
}

function displayEvents() {
    const container = document.getElementById('eventsList');
    
    // Get unique events with their tournament counts
    const eventMap = new Map();
    stages.forEach(stage => {
        if (stage.event_name) {
            if (!eventMap.has(stage.event_name)) {
                eventMap.set(stage.event_name, {
                    name: stage.event_name,
                    tournaments: []
                });
            }
            eventMap.get(stage.event_name).tournaments.push(stage);
        }
    });
    
    const events = Array.from(eventMap.values());
    
    if (events.length === 0) {
        container.innerHTML = '<p class="empty-state">Keine Events vorhanden. Erstelle ein neues Turnier mit einem Event!</p>';
        return;
    }
    
    container.innerHTML = events.map(event => `
        <div class="event-item">
            <div class="event-main">
                <h3>${escapeHtml(event.name)}</h3>
                <p class="event-meta">${event.tournaments.length} Turnier${event.tournaments.length !== 1 ? 'e' : ''}</p>
            </div>
            <div class="event-actions">
                <button class="btn btn-ghost btn-sm admin-only" data-event="${escapeHtml(event.name)}" onclick="openEventScheduleModal(this.dataset.event)" title="Spielzeiten für alle Turniere dieses Events">
                    ${icon('clock')}<span>Spielzeiten</span>
                </button>
                <button class="btn btn-secondary btn-sm" data-event="${escapeHtml(event.name)}" onclick="viewEventRankings(this.dataset.event)">
                    ${icon('trophy')}<span>Gesamtwertung</span>
                </button>
            </div>
        </div>
    `).join('');
}

function displayMatches() {
    const container = document.getElementById('matchesList');
    const filterValue = document.getElementById('stageFilter').value;
    const showOpenOnly = document.getElementById('showOpenOnly').checked;
    const hideTBD = document.getElementById('hideTBD').checked;
    
    let filteredMatches = matches;
    if (filterValue) {
        filteredMatches = matches.filter(m => m.stage_id === parseInt(filterValue));
    }
    
    // Filter for open matches only (no result set yet)
    if (showOpenOnly) {
        filteredMatches = filteredMatches.filter(m => {
            const hasResult = m.opponent1?.result || m.opponent2?.result;
            const hasBothOpponents = m.opponent1 && m.opponent2;
            return !hasResult && hasBothOpponents;
        });
    }
    
    // Filter out matches with TBD (missing opponents)
    if (hideTBD) {
        filteredMatches = filteredMatches.filter(m => {
            return m.opponent1?.id != null && m.opponent2?.id != null;
        });
    }

    if (!filteredMatches || filteredMatches.length === 0) {
        container.innerHTML = '<p class="empty-state">Keine Matches vorhanden</p>';
        return;
    }

    container.innerHTML = filteredMatches.map(match => {
        const opponent1 = escapeHtml(getParticipantName(match.opponent1?.id));
        const opponent2 = escapeHtml(getParticipantName(match.opponent2?.id));
        const status = getMatchStatus(match);
        const stage = stages.find(s => s.id === match.stage_id);
        const statusBadge = {
            Completed: ['badge-status', 'Abgeschlossen'],
            Pending: ['badge-pending', 'Offen'],
            Waiting: ['badge-waiting', 'Wartet']
        }[status];

        return `
            <div class="match-item">
                <h3>Match #${match.id}</h3>
                <div class="match-info">
                    ${stage ? `<span class="info-badge badge-id">${escapeHtml(stage.name)}</span>` : ''}
                    <span class="info-badge ${statusBadge[0]}">${statusBadge[1]}</span>
                    ${match.drawn ? '<span class="info-badge badge-drawn" title="Nach Rundenschluss per Los entschieden">per Los</span>' : ''}
                </div>
                <div class="match-opponents">
                    <div class="opponent ${match.opponent1?.result === 'win' ? 'winner' : ''}">
                        <div class="opponent-name">${opponent1}</div>
                    </div>
                    <div class="vs">VS</div>
                    <div class="opponent ${match.opponent2?.result === 'win' ? 'winner' : ''}">
                        <div class="opponent-name">${opponent2}</div>
                    </div>
                </div>
                <div class="match-actions">
                    <button class="btn btn-secondary btn-sm admin-only" onclick="showQuickWinnerSelectionById(${match.id})">
                        ${icon('trophy')}<span>${match.opponent1?.result || match.opponent2?.result ? 'Ergebnis ändern' : 'Ergebnis eingeben'}</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function updateStageFilter() {
    const filter = document.getElementById('stageFilter');
    const currentValue = filter.value;
    
    filter.innerHTML = '<option value="">Alle Turniere</option>' +
        stages.map(stage => 
            `<option value="${stage.id}">${escapeHtml(stage.name)}</option>`
        ).join('');
    
    if (currentValue) {
        filter.value = currentValue;
    }
}

// Create tournament
async function createTournament(e) {
    e.preventDefault();

    const eventName = document.getElementById('eventName').value;
    const event = lanEvents.find(ev => ev.name === eventName);
    if (!event) {
        alert('❌ Bitte ein Event auswählen. Events werden unter „Teilnehmer“ angelegt.');
        return;
    }
    if (event.attendee_count < 2) {
        alert(`❌ Das Event „${eventName}“ hat erst ${event.attendee_count} Teilnehmer — mindestens 2 nötig.`);
        return;
    }

    const name = document.getElementById('stageName').value;
    const type = document.getElementById('tournamentType').value;
    const grandFinalDouble = document.getElementById('grandFinalDouble').checked;
    const consolationFinal = document.getElementById('consolationFinal').checked;

    // The server takes all attendees of the event, assigns the tournament ID, shuffles and adds BYEs
    const settings = {};
    if (type === 'double_elimination') {
        settings.grandFinal = grandFinalDouble ? 'double' : 'simple';
    }
    if (type === 'single_elimination') {
        settings.consolationFinal = consolationFinal;
    }

    try {
        await apiFetch('/stages', {
            method: 'POST',
            body: JSON.stringify({ name, type, settings, eventName })
        });

        alert('✅ Turnier erfolgreich erstellt!');
        document.getElementById('createTournamentForm').reset();
        updateTypeSettings();
        await loadEvents();
        await loadStages();
        await loadMatches();
        await loadParticipants();
    } catch (error) {
        alert('❌ Fehler beim Erstellen: ' + error.message);
        console.error('Error creating tournament:', error);
    }
}

// Re-create a stage on the server with a new random draw (keeps settings, event and tournament).
// Players are the event's current attendees, so newly registered attendees join.
async function regenerateStage(stageId) {
    const newStageData = await apiFetch(`/stages/${stageId}/regenerate`, { method: 'POST', body: '{}' });

    // Close bracket viewer if open
    closeBracketViewer();

    await loadParticipants();
    await loadStages();
    await loadMatches();

    // Reopen bracket with new stage ID
    if (newStageData && newStageData.id != null) {
        viewBracket(newStageData.id);
    }
}

// Reset bracket
async function resetBracket(stageId) {
    if (!confirm('⚠️ Bracket neu auslosen? Es spielen alle aktuellen Teilnehmer des Events mit, bisherige Ergebnisse gehen verloren!')) {
        return;
    }

    try {
        await regenerateStage(stageId);
        alert('✅ Bracket erfolgreich neu erzeugt!');
    } catch (error) {
        alert('❌ Fehler beim Neu-Erzeugen: ' + error.message);
        console.error('Error resetting bracket:', error);
    }
}

// Delete a tournament; the server removes its participants and matches as well
async function deleteStage(stageId) {
    const stage = stages.find(s => s.id === stageId);
    if (!confirm(`Turnier „${stage?.name ?? stageId}“ mit allen Ergebnissen löschen?`)) return;

    try {
        await apiFetch(`/stages/${stageId}`, { method: 'DELETE' });
        // Bracket or rankings on screen may belong to the deleted tournament
        closeBracketViewer();
        closeRankings();
        await loadParticipants();
        await loadStages();
        await loadMatches();
    } catch (error) {
        alert('❌ Fehler beim Löschen: ' + error.message);
        console.error('Error deleting stage:', error);
    }
}


// "Neues Turnier": only the options of the chosen mode
function updateTypeSettings() {
    const type = document.getElementById('tournamentType').value;
    document.getElementById('grandFinalToggle').style.display = type === 'double_elimination' ? '' : 'none';
    document.getElementById('consolationToggle').style.display = type === 'single_elimination' ? '' : 'none';
}

// Settings that can change later (match for 3rd place, grand final with a second match): the server
// rebuilds the bracket with the same draw and keeps the results (switching off drops the result
// of the removed match)
async function changeStageSetting(stageId, setting, enabled, input, matchName) {
    const stage = stages.find(s => s.id === stageId);
    if (!enabled && !confirm(`${matchName} bei „${stage?.name ?? ''}“ entfernen? Ein schon eingetragenes Ergebnis dieses Spiels geht verloren.`)) {
        input.checked = true;
        return;
    }
    try {
        const { stage_id, dropped } = await apiFetch(`/stages/${stageId}/settings`, { method: 'PUT', body: JSON.stringify({ [setting]: enabled }) });
        await loadParticipants();
        await loadStages();
        await loadMatches();
        if (document.getElementById('bracketViewerSection').style.display !== 'none' && currentBracketStageId === stageId) {
            await viewBracket(stage_id, true);
        }
        if (dropped > 0) alert(`Das Ergebnis von „${matchName}“ wurde verworfen.`);
    } catch (error) {
        input.checked = !enabled;
        alert('❌ ' + error.message);
    }
}

function setConsolationFinal(stageId, enabled, input) {
    return changeStageSetting(stageId, 'consolationFinal', enabled, input, 'Spiel um Platz 3');
}

function setGrandFinalDouble(stageId, enabled, input) {
    return changeStageSetting(stageId, 'grandFinalDouble', enabled, input, 'Grand-Final-Rückspiel');
}

// View stage matches
function viewStageMatches(stageId) {
    const section = document.getElementById('matchesSection');
    section.style.display = 'block';
    document.getElementById('stageFilter').value = stageId;
    filterMatches();
    section.scrollIntoView({ behavior: 'smooth' });
}

function closeMatchesSection() {
    document.getElementById('matchesSection').style.display = 'none';
}

// View bracket visualization
async function viewBracket(stageId, preserveScroll = false) {
    try {
        const response = await fetch(`${API_URL}/viewer-data/${stageId}`);
        if (!response.ok) {
            throw new Error('Failed to load bracket data');
        }
        
        const data = await response.json();
        
        // Show event name if available
        const stage = data.stage?.[0];
        const eventNameElement = document.getElementById('bracketEventName');
        if (stage?.event_name) {
            eventNameElement.textContent = `${stage.event_name} · ${stage.name}`;
            eventNameElement.style.display = 'block';
        } else {
            eventNameElement.textContent = stage?.name || '';
            eventNameElement.style.display = stage?.name ? 'block' : 'none';
        }
        
        // Show the bracket viewer section
        const section = document.getElementById('bracketViewerSection');
        const wasHidden = section.style.display === 'none';
        section.style.display = 'block';
        
        // Only scroll into view if the section was previously hidden
        if (wasHidden && !preserveScroll) {
            section.scrollIntoView({ behavior: 'smooth' });
        }
        
        // Save current scroll position if preserving
        const scrollY = preserveScroll ? window.scrollY : null;
        
        // Render the bracket
        window.bracketsViewer.render({
            stages: data.stage,
            matches: data.match,
            matchGames: data.match_game,
            participants: data.participant,
        }, {
            clear: true,
            participantOriginPlacement: 'before',
            customRoundName: grandFinalRoundName,
            onMatchClick: (match) => {
                // Entering results needs the admin login
                if (!isAdmin) return;
                showQuickWinnerSelection(match);
            }
        });
        
        markDeadlines(data.round_deadlines ?? {}, data.round_starts ?? {});
        markDrawnMatches(data.match);
        markMemorialByes(data.memorial_byes ?? []);
        scheduleBracketRefresh(stageId, Object.keys(data.round_deadlines ?? {}).length > 0);

        // A correction prepared for another tournament no longer applies
        currentBracketStageId = stageId;
        if (pendingCorrection && pendingCorrection.stageId !== stageId) pendingCorrection = null;
        renderCorrection();
        highlightCorrection();

        // Restore scroll position if preserving
        if (preserveScroll && scrollY !== null) {
            window.scrollTo(0, scrollY);
        }
    } catch (error) {
        alert('❌ Fehler beim Laden des Brackets: ' + error.message);
        console.error('Error loading bracket:', error);
    }
}

function closeBracketViewer() {
    document.getElementById('bracketViewerSection').style.display = 'none';
    cancelCorrection();
    scheduleBracketRefresh(null, false);
}

/* Deadlines per round (src/schedule.ts): after a deadline the server decides open matches of the
   round by lot (drawn: true). Shown under the round names and on the tournament cards; an open
   bracket with deadlines reloads every minute, so decisions by lot show up. */

function formatDeadline(iso) {
    return new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Next deadline ("bis …") or start of a match for places 1–3 ("ab …") on the tournament card
function nextDeadlineHtml(stage) {
    const now = Date.now();
    const next = (stage.schedule ?? [])
        .map(d => ({ ...d, at: d.ends_at ?? d.starts_at }))
        .filter(d => d.at && Date.parse(d.at) > now)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (!next) return '';
    return `<p class="stage-deadline">${icon('clock')}${escapeHtml(next.label)} ${next.starts_at ? 'ab' : 'bis'} ${escapeHtml(formatDeadline(next.at))}</p>`;
}

// Under the round names: until when the round is played ("bis …", after that "Runde geschlossen …")
// or start ("Beginn …")
function markDeadlines(deadlines, starts = {}) {
    const now = Date.now();
    for (const round of document.querySelectorAll('.brackets-viewer article.round[data-round-id]')) {
        round.querySelector('.round-deadline')?.remove();
        const endsAt = deadlines[round.dataset.roundId];
        const startsAt = starts[round.dataset.roundId];
        if (!endsAt && !startsAt) continue;
        const note = document.createElement('p');
        const overdue = endsAt && Date.parse(endsAt) <= now;
        note.className = `round-deadline${overdue ? ' is-overdue' : ''}${startsAt ? ' is-start' : ''}`;
        note.textContent = startsAt
            ? `Beginn ${formatDeadline(startsAt)}`
            : `${overdue ? 'Runde geschlossen ·' : 'bis'} ${formatDeadline(endsAt)}`;
        round.querySelector('h3')?.after(note);
    }
    // Rounds without a time in a row with times (e.g. the grand final next to the winner bracket)
    // get an empty line instead, so their matches stay level with the connectors
    for (const row of document.querySelectorAll('.brackets-viewer .rounds')) {
        if (!row.querySelector('.round-deadline')) continue;
        for (const round of row.querySelectorAll('article.round')) {
            if (round.querySelector('.round-deadline')) continue;
            const spacer = document.createElement('p');
            spacer.className = 'round-deadline is-empty';
            spacer.textContent = '\u00a0';
            round.querySelector('h3')?.after(spacer);
        }
    }
}

// Grand final headings: "Grand Final" and, when it is played, "Rückspiel" (instead of "GF Round 1/2");
// all other rounds keep the names of brackets-viewer
function grandFinalRoundName(info) {
    if (info.groupType !== 'final-group' || info.finalType !== 'grand-final') return '';
    return info.roundNumber === 1 ? 'Grand Final' : 'Rückspiel';
}

// Memorial entries in elimination brackets are BYEs with a name: show the name instead of "BYE"
function markMemorialByes(byes) {
    for (const { match_id, side, name } of byes) {
        const sides = document.querySelectorAll(`.brackets-viewer .match[data-match-id="${Number(match_id)}"] .opponents .participant`);
        const label = sides[side - 1]?.querySelector('.name');
        if (!label) continue;
        label.textContent = name;
        label.classList.add('memorial-bye');
        label.title = 'In Gedenken';
    }
}

function markDrawnMatches(list) {
    for (const match of list.filter(m => m.drawn)) {
        const el = document.querySelector(`.brackets-viewer .match[data-match-id="${Number(match.id)}"]`);
        if (!el) continue;
        el.classList.add('is-drawn');
        el.title = 'Nach Rundenschluss per Los entschieden';
    }
}

let bracketRefreshTimer = null;

function scheduleBracketRefresh(stageId, enabled) {
    clearInterval(bracketRefreshTimer);
    bracketRefreshTimer = null;
    if (!enabled || stageId == null) return;
    bracketRefreshTimer = setInterval(async () => {
        const busy = pendingCorrection || document.querySelector('.modal.show');
        if (busy || document.getElementById('bracketViewerSection').style.display === 'none') return;
        await loadMatches();
        await viewBracket(currentBracketStageId, true);
    }, 60_000);
}

// What the deadline modal edits: { type: 'stage', id } or { type: 'event', id } (shared play slots)
let scheduleTarget = null;

/* Event period ("YYYY-MM-DD" days, local): deadlines and the timetable offer only these days */

const pad2 = n => String(n).padStart(2, '0');
const localDay = date => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

// All days of the event, or [] without a period
function eventDays(event) {
    if (!event?.starts_on || !event?.ends_on) return [];
    const days = [];
    for (let date = new Date(`${event.starts_on}T12:00`); localDay(date) <= event.ends_on; date.setDate(date.getDate() + 1)) {
        days.push(localDay(date));
    }
    return days;
}

// "Sa., 21.11."
function formatEventDay(day) {
    return new Date(`${day}T12:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

// ISO timestamp ↔ local day + "HH:MM"
function splitLocal(iso) {
    if (!iso) return { day: '', time: '' };
    const date = new Date(iso);
    return { day: localDay(date), time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}` };
}

const joinLocal = (day, time) => (day && time ? new Date(`${day}T${time}`).toISOString() : null);

// "YYYY-MM-DDTHH:MM" in local time for <input type="datetime-local">
function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Days offered in the deadline modal: the event's period (empty: free date and time input)
let scheduleDays = [];

const periodTip = () => (scheduleDays.length ? '' : 'Tipp: Mit einem Zeitraum beim Event (Teilnehmer › Konfiguration) stehen hier nur dessen Tage zur Auswahl.');

// One row: with an event period a day selection + time, otherwise date and time in one field.
// A day outside the period (set before the period changed) stays selectable.
function scheduleRow(i, label, detail, value, data) {
    const { day, time } = splitLocal(value);
    const days = day && !scheduleDays.includes(day) ? [...scheduleDays, day].sort() : scheduleDays;
    const inputs = scheduleDays.length
        ? `<span class="deadline-inputs">
               <select id="deadline-day-${i}" aria-label="Tag" onchange="markDeadlineTouched(${i})">
                   <option value="">–</option>
                   ${days.map(d => `<option value="${d}"${d === day ? ' selected' : ''}>${escapeHtml(formatEventDay(d))}</option>`).join('')}
               </select>
               <input type="time" id="deadline-time-${i}" value="${time}" aria-label="Uhrzeit" oninput="suggestDeadlineDay(${i})">
           </span>`
        : `<input type="datetime-local" id="deadline-${i}" value="${toLocalInput(value)}" oninput="markDeadlineTouched(${i})">`;
    return `
        <div class="schedule-row" id="deadline-row-${i}" ${data}>
            <span class="schedule-label">${escapeHtml(label)}${detail ? `<small>${detail}</small>` : ''}</span>
            ${inputs}
            <button type="button" class="btn btn-ghost btn-icon" onclick="clearDeadlineInput(${i})" title="Zeit entfernen" aria-label="Zeit entfernen">${icon('x')}</button>
        </div>
    `;
}

function markDeadlineTouched(i) {
    document.getElementById(`deadline-row-${i}`).dataset.touched = '1';
}

// A time without day: take the day of the row above (or the first day of the event)
function suggestDeadlineDay(i) {
    markDeadlineTouched(i);
    const day = document.getElementById(`deadline-day-${i}`);
    if (day.value || !document.getElementById(`deadline-time-${i}`).value) return;
    let previous = '';
    for (let j = i - 1; j >= 0 && !previous; j--) previous = document.getElementById(`deadline-day-${j}`)?.value ?? '';
    day.value = previous || scheduleDays[0] || '';
}

function clearDeadlineInput(i) {
    for (const id of [`deadline-${i}`, `deadline-day-${i}`, `deadline-time-${i}`]) {
        const input = document.getElementById(id);
        if (input) input.value = '';
    }
    markDeadlineTouched(i);
}

// ISO deadline of a row, null = none; a day without time (or the reverse) is an error
function deadlineOf(row) {
    const i = row.id.replace('deadline-row-', '');
    const free = document.getElementById(`deadline-${i}`);
    if (free) return free.value ? new Date(free.value).toISOString() : null;
    const day = document.getElementById(`deadline-day-${i}`).value;
    const time = document.getElementById(`deadline-time-${i}`).value;
    if (!day && !time) return null;
    if (!day || !time) throw new Error(`${row.querySelector('.schedule-label').firstChild.textContent}: Tag und Uhrzeit angeben`);
    return joinLocal(day, time);
}

// Deadlines of one tournament (round by round)
async function openScheduleModal(stageId) {
    try {
        const { rounds } = await apiFetch(`/stages/${stageId}/schedule`);
        const stage = stages.find(s => s.id === stageId);
        scheduleTarget = { type: 'stage', id: stageId };
        scheduleDays = eventDays(lanEvents.find(e => e.name === stage?.event_name));
        document.getElementById('scheduleStageName').textContent = stage?.name ?? '';
        document.getElementById('scheduleModeHint').textContent = (stage?.event_name
            ? `Gleiche Zeiten für alle Turniere: „Spielzeiten“ beim Event „${stage.event_name}“. `
            : '') + periodTip();
        // Loser bracket rounds (except its final) have no time
        document.getElementById('scheduleList').innerHTML = rounds.filter(r => r.kind !== 'none').map((r, i) => r.kind === 'start'
            ? scheduleRow(i, r.label, 'Beginn — wird nie ausgelost', r.starts_at, `data-group="${r.group}" data-round="${r.round}" data-kind="start"`)
            : scheduleRow(i, r.label, `Spielrunde ${r.slot}`, r.ends_at, `data-group="${r.group}" data-round="${r.round}"`)
        ).join('');
        openModal('scheduleModal');
    } catch (error) {
        alert('❌ Fehler beim Laden der Spielzeiten: ' + error.message);
    }
}

// Shared deadlines for all tournaments of an event, by play slot ("Spielrunde")
async function openEventScheduleModal(eventName) {
    const event = lanEvents.find(e => e.name === eventName);
    if (!event) return;
    try {
        const { slots, finals } = await apiFetch(`/events/${event.id}/schedule`);
        scheduleTarget = { type: 'event', id: event.id };
        scheduleDays = eventDays(event);
        document.getElementById('scheduleStageName').textContent = `${eventName} · alle Turniere`;
        document.getElementById('scheduleModeHint').textContent = 'Runde n aller Turniere gehört zur Spielrunde n und bekommt deren Zeit. Einzelne Turniere lassen sich danach über ihr Uhr-Symbol noch anpassen. ' + periodTip();
        document.getElementById('scheduleList').innerHTML = slots.map((slot, i) => {
            const detail = slot.rounds.map(r => `${escapeHtml(r.stage_name)}: ${escapeHtml(r.label)}`).join(' · ')
                + (slot.mixed ? ' — <em>derzeit unterschiedlich, leer lassen = so lassen</em>' : '');
            return scheduleRow(i, `Spielrunde ${slot.slot}`, detail, slot.ends_at, `data-slot="${slot.slot}" data-mixed="${slot.mixed ? 1 : 0}"`);
        }).join('') + (finals.length ? `
            <h3 class="schedule-section">Finalspiele <small>Beginn je Turnier — wird nie ausgelost</small></h3>
            ${finals.map((f, j) => scheduleRow(slots.length + j, `${f.stage_name}: ${f.label}`, '', f.starts_at,
                `data-stage="${f.stage_id}" data-group="${f.group}" data-round="${f.round}" data-kind="start"`)).join('')}
        ` : '');
        openModal('scheduleModal');
    } catch (error) {
        alert('❌ Fehler beim Laden der Spielzeiten: ' + error.message);
    }
}

async function saveSchedule(e) {
    e.preventDefault();
    const rows = [...document.querySelectorAll('#scheduleList .schedule-row')];
    const isEvent = scheduleTarget.type === 'event';
    let entries;
    let finals;
    try {
        // Rows of the matches for places 1–3 carry a start time instead of a deadline
        const round = row => {
            const base = { group: Number(row.dataset.group), round: Number(row.dataset.round) };
            return row.dataset.kind === 'start' ? { ...base, starts_at: deadlineOf(row) } : { ...base, ends_at: deadlineOf(row) };
        };
        entries = isEvent
            // Slots with different deadlines per tournament stay as they are unless something was entered
            ? rows.filter(row => row.dataset.slot && (row.dataset.mixed !== '1' || row.dataset.touched))
                .map(row => ({ slot: Number(row.dataset.slot), ends_at: deadlineOf(row) }))
            : rows.map(round);
        finals = isEvent ? rows.filter(row => row.dataset.stage).map(row => ({ stage_id: Number(row.dataset.stage), ...round(row) })) : [];
    } catch (error) {
        alert('❌ ' + error.message);
        return;
    }
    const past = entries.filter(r => r.ends_at && Date.parse(r.ends_at) <= Date.now());
    if (past.length && !confirm('Mindestens eine Runde ist damit schon geschlossen. Ihre offenen Matches werden sofort per Los entschieden. Fortfahren?')) return;

    try {
        const { decided } = isEvent
            ? await apiFetch(`/events/${scheduleTarget.id}/schedule`, { method: 'PUT', body: JSON.stringify({ slots: entries, finals }) })
            : await apiFetch(`/stages/${scheduleTarget.id}/schedule`, { method: 'PUT', body: JSON.stringify({ rounds: entries }) });
        closeModal('scheduleModal');
        await loadStages();
        await loadMatches();
        if (document.getElementById('bracketViewerSection').style.display !== 'none' && currentBracketStageId != null) {
            await viewBracket(currentBracketStageId, true);
        }
        if (decided > 0) alert(`🎲 ${decided} Match(es) per Los entschieden.`);
    } catch (error) {
        alert('❌ Fehler beim Speichern der Spielzeiten: ' + error.message);
    }
}

/* Punktesystem: global championship points for 1st–10th place and "ab Platz 11".
   The server calculates the points on every standings request, so after saving
   only the rankings on screen have to be loaded again. */

let pointsConfig = null; // { places: [10], rest, defaults: { places, rest } }

async function loadPoints() {
    try {
        pointsConfig = await apiFetch('/points');
    } catch (error) {
        console.error('Error loading points:', error);
    }
    renderPoints();
}

// Fields: label, input id, current and default value
function pointsFields(config) {
    return [
        ...config.places.map((value, i) => ({ label: `Platz ${i + 1}`, id: `points-${i}`, value, def: config.defaults.places[i] })),
        { label: `ab Platz ${config.places.length + 1}`, id: 'points-rest', value: config.rest, def: config.defaults.rest }
    ];
}

function renderPoints() {
    const grid = document.getElementById('pointsGrid');
    if (!grid || !pointsConfig) return;
    grid.innerHTML = pointsFields(pointsConfig).map(f => `
        <div class="form-group" data-default="${f.def}">
            <label for="${f.id}">${f.label}</label>
            <input type="number" id="${f.id}" min="0" max="1000" step="1" required value="${f.value}" ${isAdmin ? '' : 'disabled'}>
            <div class="points-default">Standard: ${f.def}</div>
        </div>
    `).join('');
    markChangedPoints();
}

// Highlights fields that differ from the default
function markChangedPoints() {
    for (const group of document.querySelectorAll('#pointsGrid .form-group')) {
        const input = group.querySelector('input');
        group.classList.toggle('is-changed', input.value !== '' && Number(input.value) !== Number(group.dataset.default));
    }
}

function resetPointsToDefault() {
    if (!pointsConfig) return;
    for (const f of pointsFields(pointsConfig)) document.getElementById(f.id).value = f.def;
    markChangedPoints();
}

async function savePoints(e) {
    e.preventDefault();
    const value = id => document.getElementById(id).value;
    const places = pointsConfig.places.map((_, i) => value(`points-${i}`));
    try {
        pointsConfig = await apiFetch('/points', {
            method: 'PUT',
            body: JSON.stringify({ places, rest: value('points-rest') })
        });
        renderPoints();
        await refreshOpenRankings();
        alert('✅ Punkte gespeichert. Alle Ranglisten werden mit den neuen Werten berechnet.');
    } catch (error) {
        alert('❌ Fehler beim Speichern: ' + error.message);
    }
}

// The rankings on screen (single tournament or event) are loaded again with the new points
let reloadRankings = null;
let rankingsRefreshing = false;

async function refreshOpenRankings() {
    if (!reloadRankings || document.getElementById('rankingsSection').style.display === 'none') return;
    rankingsRefreshing = true;
    try {
        await reloadRankings();
    } finally {
        rankingsRefreshing = false;
    }
}

// Fetch placements incl. championship points from the server
async function fetchStandings(stageId) {
    const response = await fetch(`${API_URL}/standings/${stageId}`);
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response.json();
}

function formatWinRate(wins, losses) {
    return wins + losses > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 0;
}

// Show the rankings section with a title and a table; showTournaments adds the "Turniere" column
function showRankings(title, rankings, showTournaments = false) {
    const section = document.getElementById('rankingsSection');
    section.style.display = 'block';
    document.getElementById('rankingsEventName').textContent = title;

    const container = document.getElementById('rankingsList');
    if (rankings.length === 0) {
        container.innerHTML = '<p class="empty-state">Keine Rangliste verfügbar</p>';
    } else {
        container.innerHTML = `
            <div class="rankings-table${showTournaments ? ' with-tournaments' : ''}">
                <div class="rankings-header">
                    <div class="rank-cell">Platz</div>
                    <div class="name-cell">Teilnehmer</div>
                    <div class="stat-cell">Punkte</div>
                    <div class="stat-cell">Siege</div>
                    <div class="stat-cell">Niederlagen</div>
                    <div class="stat-cell">Gespielt</div>
                    <div class="stat-cell">Ausstehend</div>
                    ${showTournaments ? '<div class="stat-cell">Turniere</div>' : ''}
                    <div class="stat-cell">Siegrate</div>
                </div>
                ${rankings.map(r => `
                    <div class="rankings-row ${r.placement && r.placement <= 3 ? 'top-' + r.placement : ''}">
                        <div class="rank-cell">${rankBadge(r)}</div>
                        <div class="name-cell">${escapeHtml(r.name)}</div>
                        <div class="stat-cell points${r.placement == null ? ' is-open' : ''}">${r.placement == null ? '–' : r.points}</div>
                        <div class="stat-cell wins">${r.wins}</div>
                        <div class="stat-cell losses">${r.losses}</div>
                        <div class="stat-cell">${r.wins + r.losses}</div>
                        <div class="stat-cell">${r.pending}</div>
                        ${showTournaments ? `<div class="stat-cell">${r.tournaments}</div>` : ''}
                        <div class="stat-cell">${formatWinRate(r.wins, r.losses)}%</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    if (!rankingsRefreshing) section.scrollIntoView({ behavior: 'smooth' });
}

// Place as badge: "5" or shared "5–6"; an open place (player still in the tournament) as "–"
function rankBadge(r) {
    if (r.placement == null) return '<span class="rank-badge rank-open" title="Platz noch offen – noch im Turnier">–</span>';
    const shared = r.placement_to != null && r.placement_to !== r.placement;
    const label = shared ? `${r.placement}–${r.placement_to}` : `${r.placement}`;
    const title = shared ? ` title="Geteilter Platz ${label}"` : '';
    return `<span class="rank-badge${r.placement <= 3 ? ' rank-' + r.placement : ''}${shared ? ' is-shared' : ''}"${title}>${label}</span>`;
}

// View rankings
async function viewRankings(stageId) {
    try {
        const stage = stages.find(s => s.id === stageId);
        if (!stage) {
            alert('❌ Stage nicht gefunden!');
            return;
        }

        const standings = await fetchStandings(stageId);
        const rankings = standings.map(s => ({
            placement: s.placement,
            placement_to: s.placement_to,
            name: s.participant_name,
            wins: s.wins,
            losses: s.losses,
            pending: s.pending,
            points: s.points
        }));

        const title = stage.event_name ? `${stage.event_name} · ${stage.name}` : stage.name;
        showRankings(title, rankings);
        reloadRankings = () => viewRankings(stageId);
    } catch (error) {
        alert('❌ Fehler beim Laden der Rangliste: ' + error.message);
        console.error('Error loading rankings:', error);
    }
}

function closeRankings() {
    document.getElementById('rankingsSection').style.display = 'none';
}

// View overall event rankings: sum up the points of all tournaments of the event per participant name
async function viewEventRankings(eventName) {
    try {
        const eventStages = stages.filter(s => s.event_name === eventName);
        if (eventStages.length === 0) {
            alert('❌ Keine Turniere für dieses Event gefunden!');
            return;
        }

        const allStandings = await Promise.all(eventStages.map(stage => fetchStandings(stage.id)));

        const participantStats = new Map();
        allStandings.forEach((standings, i) => {
            standings.forEach(standing => {
                if (!participantStats.has(standing.participant_name)) {
                    participantStats.set(standing.participant_name, {
                        name: standing.participant_name,
                        wins: 0,
                        losses: 0,
                        pending: 0,
                        points: 0,
                        tournamentIds: new Set()
                    });
                }
                const stats = participantStats.get(standing.participant_name);
                stats.points += standing.points;
                stats.wins += standing.wins;
                stats.losses += standing.losses;
                stats.pending += standing.pending;
                stats.tournamentIds.add(eventStages[i].tournament_id);
            });
        });

        const rankings = Array.from(participantStats.values()).map(stats => ({
            ...stats,
            tournaments: stats.tournamentIds.size
        }));

        // Sort by points (desc), then wins (desc), then win rate (desc)
        rankings.sort((a, b) => {
            if (b.points !== a.points) return b.points - a.points;
            if (b.wins !== a.wins) return b.wins - a.wins;
            const winRateDiff = parseFloat(formatWinRate(b.wins, b.losses)) - parseFloat(formatWinRate(a.wins, a.losses));
            if (winRateDiff !== 0) return winRateDiff;
            return b.tournaments - a.tournaments;
        });
        // Same points, wins, win rate and tournaments = same place
        const sameAs = (a, b) => a.points === b.points && a.wins === b.wins && a.losses === b.losses && a.tournaments === b.tournaments;
        rankings.forEach((r, index) => {
            r.placement = index > 0 && sameAs(r, rankings[index - 1]) ? rankings[index - 1].placement : index + 1;
            r.placement_to = r.placement;
        });

        showRankings(`${eventName} · Gesamtwertung`, rankings, true);
        reloadRankings = () => viewEventRankings(eventName);
    } catch (error) {
        alert('❌ Fehler beim Laden der Event-Rangliste: ' + error.message);
        console.error('Error loading event rankings:', error);
    }
}

// Quick winner selection in bracket
let currentMatchForWinner = null;

function showQuickWinnerSelection(match) {
    const opponent1Name = getParticipantName(match.opponent1?.id);
    const opponent2Name = getParticipantName(match.opponent2?.id);
    
    // Check if any opponent is completely null (BYE)
    if (match.opponent1 === null || match.opponent2 === null) {
        alert('🚫 Dieses Match hat einen BYE und wird automatisch entschieden.');
        return;
    }
    
    // Check if opponents exist but have null id (TBD - not yet determined from previous matches)
    if (match.opponent1 === undefined || match.opponent2 === undefined ||
        match.opponent1.id === null || match.opponent2.id === null ||
        match.opponent1.id === undefined || match.opponent2.id === undefined) {
        alert('⏳ Dieses Match ist noch nicht spielbar. Warte auf die vorherigen Matches.');
        return;
    }
    
    currentMatchForWinner = match;
    
    // Update modal content
    document.getElementById('winner1Name').textContent = opponent1Name;
    document.getElementById('winner2Name').textContent = opponent2Name;
    
    // Check if match is already completed
    if (match.opponent1?.result || match.opponent2?.result) {
        const winnerName = match.opponent1?.result === 'win' ? opponent1Name : opponent2Name;
        document.getElementById('winnerModalInfo').textContent =
            `Bisheriger Gewinner: ${winnerName}. Zum Korrigieren den neuen Gewinner wählen — vor dem Übernehmen siehst du, welche Folgeergebnisse sich ändern.`;
    } else {
        document.getElementById('winnerModalInfo').textContent = 
            'Klicke auf den Gewinner des Matches:';
    }
    
    // Show modal
    document.getElementById('winnerModal').classList.add('show');
}

// "Ergebnis eingeben" in the match list (outside the bracket viewer)
function showQuickWinnerSelectionById(matchId) {
    const match = matches.find(m => m.id === matchId);
    if (match) showQuickWinnerSelection(match);
}

function selectWinner(winnerNum) {
    const match = currentMatchForWinner;
    closeWinnerModal();
    if (!match) return;

    const currentWinner = match.opponent1?.result === 'win' ? 1 : match.opponent2?.result === 'win' ? 2 : null;
    if (currentWinner === winnerNum) {
        // Same winner again: nothing changes, unless the lot decided it, then this confirms it by hand
        const drawn = match.drawn ?? matches.find(m => m.id === match.id)?.drawn;
        if (drawn) updateMatchQuick(match.id, winnerNum === 1);
        return;
    }
    if (currentWinner === null) {
        // First result: enter it directly
        cancelCorrection();
        updateMatchQuick(match.id, winnerNum === 1);
        return;
    }
    prepareCorrection(match, winnerNum);
}

/* Correcting a result: the server lists the following matches that already have results
   (they are reset and have to be entered again). The bracket keeps showing the current
   state with those matches marked, until the change is confirmed. */

let pendingCorrection = null; // { match, stageId, winnerNum, preview: { label, following } }
let currentBracketStageId = null;

async function prepareCorrection(match, winnerNum) {
    try {
        const preview = await apiFetch(`/matches/${match.id}/following`);
        if (preview.following.length === 0) {
            // Nothing depends on it: change it right away, no preview needed
            cancelCorrection();
            await updateMatchQuick(match.id, winnerNum === 1, true);
            return;
        }
        const stageId = match.stage_id ?? matches.find(m => m.id === match.id)?.stage_id;
        pendingCorrection = { match, stageId, winnerNum, preview };

        const bracketOpen = document.getElementById('bracketViewerSection').style.display !== 'none';
        if (bracketOpen && currentBracketStageId === stageId) {
            renderCorrection();
            highlightCorrection();
        } else {
            await viewBracket(stageId); // e.g. from the match list: show the bracket with the marks
        }
        document.getElementById('correctionPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        alert('❌ Fehler beim Prüfen der Folgeergebnisse: ' + error.message);
    }
}

function resultText(match) {
    const winner = match.opponent1?.result === 'win' ? match.opponent1 : match.opponent2?.result === 'win' ? match.opponent2 : null;
    if (!winner) return 'läuft';
    const forfeit = match.opponent1?.forfeit || match.opponent2?.forfeit;
    return `Sieger ${escapeHtml(getParticipantName(winner.id))}${forfeit ? ' (kampflos)' : ''}`;
}

function renderCorrection() {
    const panel = document.getElementById('correctionPanel');
    if (!pendingCorrection) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }
    const { match, winnerNum, preview } = pendingCorrection;
    const name = side => escapeHtml(getParticipantName(match[`opponent${side}`]?.id));
    const following = preview.following;

    panel.innerHTML = `
        <h3>${icon('edit')}Ergebnis korrigieren</h3>
        <p class="correction-match">${escapeHtml(preview.label)}: ${name(1)} vs ${name(2)}</p>
        <div class="correction-change">
            <span class="correction-old">Bisher: <strong>${name(winnerNum === 1 ? 2 : 1)}</strong> gewinnt</span>
            <span class="correction-arrow">→</span>
            <span class="correction-new">Neu: <strong>${name(winnerNum)}</strong> gewinnt</span>
        </div>
        ${following.length ? `
            <p class="field-hint is-warning">${following.length === 1 ? 'Ein Folgeergebnis hängt' : `${following.length} Folgeergebnisse hängen`} von diesem Match ab. Beim Übernehmen werden sie zurückgesetzt und müssen neu eingetragen werden:</p>
            <ul class="correction-list">
                ${following.map(f => `
                    <li><span class="correction-label">${escapeHtml(f.label)}</span>${escapeHtml(getParticipantName(f.opponent1?.id))} vs ${escapeHtml(getParticipantName(f.opponent2?.id))} — ${resultText(f)}</li>
                `).join('')}
            </ul>
        ` : '<p class="field-hint">Keine Folgeergebnisse betroffen.</p>'}
        <p class="field-hint">Das Bracket zeigt noch den aktuellen Stand: orange das geänderte Match, gelb gestrichelt die betroffenen Folge-Matches. Erst „Änderung übernehmen“ ändert etwas.</p>
        <div class="form-actions form-actions-end">
            <button type="button" class="btn btn-ghost btn-sm" onclick="cancelCorrection()">Abbrechen</button>
            <button type="button" class="btn btn-primary btn-sm" onclick="applyCorrection()">${icon('edit')}<span>Änderung übernehmen</span></button>
        </div>
    `;
    panel.style.display = '';
}

function highlightCorrection() {
    for (const el of document.querySelectorAll('.brackets-viewer .is-correction-target, .brackets-viewer .is-correction-affected')) {
        el.classList.remove('is-correction-target', 'is-correction-affected');
    }
    if (!pendingCorrection) return;
    const mark = (id, className) => document.querySelector(`.brackets-viewer .match[data-match-id="${Number(id)}"]`)?.classList.add(className);
    mark(pendingCorrection.match.id, 'is-correction-target');
    for (const f of pendingCorrection.preview.following) mark(f.id, 'is-correction-affected');
}

function cancelCorrection() {
    pendingCorrection = null;
    renderCorrection();
    highlightCorrection();
}

async function applyCorrection() {
    if (!pendingCorrection) return;
    const { match, winnerNum } = pendingCorrection;
    await updateMatchQuick(match.id, winnerNum === 1, true);
}

function closeWinnerModal() {
    document.getElementById('winnerModal').classList.remove('show');
    currentMatchForWinner = null;
}

// resetFollowing: correction confirmed, the server may reset the following results
async function updateMatchQuick(matchId, opponent1Wins, resetFollowing = false) {
    const opponent1 = { result: opponent1Wins ? 'win' : 'loss' };
    const opponent2 = { result: opponent1Wins ? 'loss' : 'win' };

    try {
        const updated = await apiFetch(`/matches/${matchId}`, {
            method: 'PUT',
            body: JSON.stringify({ opponent1, opponent2, resetFollowing })
        });
        pendingCorrection = null;

        // Reload matches and re-render the bracket (keeping the scroll position)
        await loadMatches();
        const stageId = updated?.stage_id ?? matches.find(m => m.id === matchId)?.stage_id;
        if (document.getElementById('bracketViewerSection').style.display !== 'none' && stageId != null) {
            await viewBracket(stageId, true);
        } else {
            renderCorrection();
        }
        await refreshOpenRankings(); // placements and points may have changed
    } catch (error) {
        alert('❌ Fehler beim Aktualisieren: ' + error.message);
        console.error('Error updating match:', error);
    }
}

function filterMatches() {
    displayMatches();
}

// Helper functions
function getParticipantName(participantId) {
    if (participantId == null) return 'TBD';
    const participant = participants.find(p => p.id === participantId);
    return participant ? participant.name : `Participant #${participantId}`;
}

function getMatchStatus(match) {
    if (match.opponent1?.result || match.opponent2?.result) {
        return 'Completed';
    }
    if (match.opponent1?.id == null || match.opponent2?.id == null) {
        return 'Waiting';
    }
    return 'Pending';
}

function formatType(type) {
    const types = {
        'single_elimination': 'Single Elimination',
        'double_elimination': 'Double Elimination',
        'round_robin': 'Round Robin'
    };
    return types[type] || type;
}

// Background of exported images/PDFs (matches --bg-color)
const EXPORT_BACKGROUND = '#141519';

// Printers can't print borderless: everything in PDFs stays this far from the paper edge
const PRINT_MARGIN_MM = 5;

// Places a canvas inside the printable area of the PDF's pages, centered horizontally.
// paginate: scale to the page width and continue on new pages if too tall;
// otherwise shrink until it fits onto one page.
function addCanvasToPdf(pdf, canvas, { paginate }) {
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const maxW = pageW - 2 * PRINT_MARGIN_MM;
    const maxH = pageH - 2 * PRINT_MARGIN_MM;
    const mmPerPx = Math.min(maxW / canvas.width, paginate ? Infinity : maxH / canvas.height);
    const width = canvas.width * mmPerPx;
    const x = (pageW - width) / 2;

    const sliceHeightPx = Math.floor(maxH / mmPerPx);
    for (let top = 0, page = 0; top < canvas.height; top += sliceHeightPx, page++) {
        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = Math.min(sliceHeightPx, canvas.height - top);
        slice.getContext('2d').drawImage(canvas, 0, top, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
        if (page > 0) pdf.addPage();
        pdf.addImage(slice.toDataURL('image/jpeg', 0.95), 'JPEG', x, PRINT_MARGIN_MM, width, slice.height * mmPerPx);
    }
}

// Export buttons keep their icon; only the .btn-label text changes
function getButtonLabel(button) {
    return button.querySelector('.btn-label')?.textContent ?? button.textContent;
}

function setButtonLabel(button, text) {
    const label = button.querySelector('.btn-label');
    if (label) label.textContent = text;
    else button.textContent = text;
}

// Export bracket as image
async function exportBracketAsImage() {
    const exportButton = document.getElementById('exportBracketBtn');
    const bracketSection = document.getElementById('bracketViewerSection');
    const bracketContainer = document.querySelector('.brackets-viewer');
    const eventName = document.getElementById('bracketEventName').textContent;
    
    if (!bracketContainer) {
        alert('❌ Kein Bracket zum Exportieren vorhanden!');
        return;
    }
    
    try {
        // Show loading indicator
        const originalText = getButtonLabel(exportButton);
        setButtonLabel(exportButton, 'Exportiere…');
        exportButton.disabled = true;
        
        // Save original styles
        const originalOverflow = bracketContainer.style.overflow;
        const originalMaxHeight = bracketContainer.style.maxHeight;
        const originalMaxWidth = bracketContainer.style.maxWidth;
        const originalSectionOverflow = bracketSection.style.overflow;
        const originalBorder = bracketContainer.style.border;
        const originalBoxShadow = bracketContainer.style.boxShadow;
        const originalOutline = bracketContainer.style.outline;
        const originalPadding = bracketContainer.style.padding;
        
        // Temporarily remove overflow, size constraints, and visual boundaries
        // Add padding for better export
        bracketContainer.style.overflow = 'visible';
        bracketContainer.style.maxHeight = 'none';
        bracketContainer.style.maxWidth = 'none';
        bracketContainer.style.border = 'none';
        bracketContainer.style.boxShadow = 'none';
        bracketContainer.style.outline = 'none';
        bracketContainer.style.padding = '2rem';
        bracketSection.style.overflow = 'visible';
        
        // Wait for layout to update
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Get the full dimensions with extra padding
        const scrollWidth = bracketContainer.scrollWidth;
        const scrollHeight = bracketContainer.scrollHeight;
        const paddingExtra = 64; // Extra padding in pixels
        
        // Create canvas from bracket with full dimensions plus padding
        const canvas = await html2canvas(bracketContainer, {
            backgroundColor: EXPORT_BACKGROUND,
            scale: 2,
            logging: false,
            allowTaint: true,
            useCORS: true,
            width: scrollWidth + paddingExtra,
            height: scrollHeight + paddingExtra,
            x: -32, // Offset to center content
            y: -32
        });
        
        // Restore original styles
        bracketContainer.style.overflow = originalOverflow;
        bracketContainer.style.maxHeight = originalMaxHeight;
        bracketContainer.style.maxWidth = originalMaxWidth;
        bracketContainer.style.border = originalBorder;
        bracketContainer.style.boxShadow = originalBoxShadow;
        bracketContainer.style.outline = originalOutline;
        bracketContainer.style.padding = originalPadding;
        bracketSection.style.overflow = originalSectionOverflow;
        
        // Convert to JPG and download
        canvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const filename = `bracket-${eventName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${Date.now()}.jpg`;
            link.href = url;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(url);
            
            // Restore button
            setButtonLabel(exportButton, originalText);
            exportButton.disabled = false;
        }, 'image/jpeg', 0.95);
        
    } catch (error) {
        alert('❌ Fehler beim Exportieren: ' + error.message);
        console.error('Export error:', error);
        // Restore button
        setButtonLabel(exportButton, 'JPG');
        exportButton.disabled = false;
    }
}

// Export rankings as image
async function exportRankingsAsImage() {
    const exportButton = document.getElementById('exportRankingsBtn');
    const rankingsContainer = document.getElementById('rankingsList');
    const eventName = document.getElementById('rankingsEventName').textContent;
    
    if (!rankingsContainer) {
        alert('❌ Keine Rangliste zum Exportieren vorhanden!');
        return;
    }
    
    try {
        // Show loading indicator
        const originalText = getButtonLabel(exportButton);
        setButtonLabel(exportButton, 'Exportiere…');
        exportButton.disabled = true;
        
        // Create a wrapper with padding and title for better export
        const exportWrapper = document.createElement('div');
        exportWrapper.style.cssText = `background: ${EXPORT_BACKGROUND}; padding: 2rem; border-radius: 8px;`;
        
        const title = document.createElement('h2');
        title.textContent = eventName;
        title.style.cssText = 'color: white; margin-bottom: 1.5rem; text-align: center;';
        
        exportWrapper.appendChild(title);
        exportWrapper.appendChild(rankingsContainer.cloneNode(true));
        document.body.appendChild(exportWrapper);
        
        // Create canvas from rankings
        const canvas = await html2canvas(exportWrapper, {
            backgroundColor: EXPORT_BACKGROUND,
            scale: 2,
            logging: false,
            allowTaint: true,
            useCORS: true
        });
        
        // Remove temporary wrapper
        document.body.removeChild(exportWrapper);
        
        // Convert to JPG and download
        canvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const filename = `rankings-${eventName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${Date.now()}.jpg`;
            link.href = url;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(url);
            
            // Restore button
            setButtonLabel(exportButton, originalText);
            exportButton.disabled = false;
        }, 'image/jpeg', 0.95);
        
    } catch (error) {
        alert('❌ Fehler beim Exportieren: ' + error.message);
        console.error('Export error:', error);
        // Restore button
        setButtonLabel(exportButton, 'JPG');
        exportButton.disabled = false;
    }
}

// Export bracket as PDF
async function exportBracketAsPdf() {
    const exportButton = document.getElementById('exportBracketPdfBtn');
    const bracketSection = document.getElementById('bracketViewerSection');
    const bracketContainer = document.querySelector('.brackets-viewer');
    const eventName = document.getElementById('bracketEventName').textContent;
    
    if (!bracketContainer) {
        alert('❌ Kein Bracket zum Exportieren vorhanden!');
        return;
    }
    
    try {
        // Show loading indicator
        const originalText = getButtonLabel(exportButton);
        setButtonLabel(exportButton, 'Exportiere…');
        exportButton.disabled = true;
        
        // Save original styles
        const originalOverflow = bracketContainer.style.overflow;
        const originalMaxHeight = bracketContainer.style.maxHeight;
        const originalMaxWidth = bracketContainer.style.maxWidth;
        const originalSectionOverflow = bracketSection.style.overflow;
        const originalBorder = bracketContainer.style.border;
        const originalBoxShadow = bracketContainer.style.boxShadow;
        const originalOutline = bracketContainer.style.outline;
        const originalPadding = bracketContainer.style.padding;
        
        // Temporarily remove overflow, size constraints, and visual boundaries
        bracketContainer.style.overflow = 'visible';
        bracketContainer.style.maxHeight = 'none';
        bracketContainer.style.maxWidth = 'none';
        bracketContainer.style.border = 'none';
        bracketContainer.style.boxShadow = 'none';
        bracketContainer.style.outline = 'none';
        bracketContainer.style.padding = '2rem';
        bracketSection.style.overflow = 'visible';
        
        // Wait for layout to update
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Get the full dimensions with extra padding
        const scrollWidth = bracketContainer.scrollWidth;
        const scrollHeight = bracketContainer.scrollHeight;
        const paddingExtra = 64;
        
        // Create canvas from bracket
        const canvas = await html2canvas(bracketContainer, {
            backgroundColor: EXPORT_BACKGROUND,
            scale: 2,
            logging: false,
            allowTaint: true,
            useCORS: true,
            width: scrollWidth + paddingExtra,
            height: scrollHeight + paddingExtra,
            x: -32,
            y: -32
        });
        
        // Restore original styles
        bracketContainer.style.overflow = originalOverflow;
        bracketContainer.style.maxHeight = originalMaxHeight;
        bracketContainer.style.maxWidth = originalMaxWidth;
        bracketContainer.style.border = originalBorder;
        bracketContainer.style.boxShadow = originalBoxShadow;
        bracketContainer.style.outline = originalOutline;
        bracketContainer.style.padding = originalPadding;
        bracketSection.style.overflow = originalSectionOverflow;
        
        // A4 landscape, whole bracket fitted onto one page inside the printable area
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        addCanvasToPdf(pdf, canvas, { paginate: false });
        
        // Download PDF
        const filename = `bracket-${eventName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${Date.now()}.pdf`;
        pdf.save(filename);
        
        // Restore button
        setButtonLabel(exportButton, originalText);
        exportButton.disabled = false;
        
    } catch (error) {
        alert('❌ Fehler beim Exportieren: ' + error.message);
        console.error('Export error:', error);
        // Restore button
        setButtonLabel(exportButton, 'PDF');
        exportButton.disabled = false;
    }
}

// Export rankings as PDF
async function exportRankingsAsPdf() {
    const exportButton = document.getElementById('exportRankingsPdfBtn');
    const rankingsContainer = document.getElementById('rankingsList');
    const eventName = document.getElementById('rankingsEventName').textContent;
    
    if (!rankingsContainer) {
        alert('❌ Keine Rangliste zum Exportieren vorhanden!');
        return;
    }
    
    try {
        // Show loading indicator
        const originalText = getButtonLabel(exportButton);
        setButtonLabel(exportButton, 'Exportiere…');
        exportButton.disabled = true;
        
        // Create a wrapper with padding and title
        const exportWrapper = document.createElement('div');
        exportWrapper.style.cssText = `background: ${EXPORT_BACKGROUND}; padding: 2rem; border-radius: 8px;`;
        
        const title = document.createElement('h2');
        title.textContent = eventName;
        title.style.cssText = 'color: white; margin-bottom: 1.5rem; text-align: center;';
        
        exportWrapper.appendChild(title);
        exportWrapper.appendChild(rankingsContainer.cloneNode(true));
        document.body.appendChild(exportWrapper);
        
        // Create canvas from rankings
        const canvas = await html2canvas(exportWrapper, {
            backgroundColor: EXPORT_BACKGROUND,
            scale: 2,
            logging: false,
            allowTaint: true,
            useCORS: true
        });
        
        // Remove temporary wrapper
        document.body.removeChild(exportWrapper);
        
        // A4 portrait at full printable width; long rankings continue on further pages
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        addCanvasToPdf(pdf, canvas, { paginate: true });
        
        // Download PDF
        const filename = `rankings-${eventName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${Date.now()}.pdf`;
        pdf.save(filename);
        
        // Restore button
        setButtonLabel(exportButton, originalText);
        exportButton.disabled = false;
        
    } catch (error) {
        alert('❌ Fehler beim Exportieren: ' + error.message);
        console.error('Export error:', error);
        // Restore button
        setButtonLabel(exportButton, 'PDF');
        exportButton.disabled = false;
    }
}

// Close modals on backdrop click
window.onclick = function(event) {
    if (!event.target.classList?.contains('modal')) return;
    if (event.target.id === 'winnerModal') closeWinnerModal();
    else event.target.classList.remove('show');
};
