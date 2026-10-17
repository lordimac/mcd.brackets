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
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
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
    showView();
    await loadEvents();
    await loadStages();
    await loadParticipants();
    await loadMatches();
});

function setupEventListeners() {
    document.getElementById('createTournamentForm').addEventListener('submit', createTournament);
    document.getElementById('eventName').addEventListener('change', updateEventPlayersHint);
    window.addEventListener('hashchange', showView);
}

// Views: #turniere (default) and #teilnehmer
function showView() {
    const view = location.hash === '#teilnehmer' ? 'attendees' : 'tournaments';
    document.getElementById('view-tournaments').style.display = view === 'tournaments' ? '' : 'none';
    document.getElementById('view-attendees').style.display = view === 'attendees' ? '' : 'none';
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
    if (view === 'attendees' && typeof showAttendeeView === 'function') showAttendeeView();
}

// Events with attendee counts (also used by the attendee view in lan.js)
async function loadEvents() {
    try {
        lanEvents = await apiFetch('/events');
    } catch (error) {
        console.error('Error loading events:', error);
        lanEvents = [];
    }
    updateEventDropdown();
}

// Collapsible cards; the open/closed state is remembered per browser
const COLLAPSIBLE_SECTIONS = ['createTournamentSection', 'eventConfigSection'];

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
    
    let filteredStages = stages;
    if (eventFilter) {
        filteredStages = stages.filter(s => s.event_name === eventFilter);
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
                <button class="btn btn-ghost btn-icon" onclick="resetBracket(${stage.id})" title="Neu auslosen (mit allen aktuellen Teilnehmern)" aria-label="Neu auslosen">
                    ${icon('shuffle')}
                </button>
                <button class="btn btn-danger btn-icon" onclick="deleteStage(${stage.id})" title="Turnier löschen" aria-label="Turnier löschen">
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
            <button class="btn btn-secondary btn-sm" data-event="${escapeHtml(event.name)}" onclick="viewEventRankings(this.dataset.event)">
                ${icon('trophy')}<span>Gesamtwertung</span>
            </button>
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
                    <button class="btn btn-secondary btn-sm" onclick="showQuickWinnerSelectionById(${match.id})">
                        ${icon('trophy')}<span>Ergebnis eingeben</span>
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

    // The server takes all attendees of the event, assigns the tournament ID, shuffles and adds BYEs
    const settings = {};
    if (type === 'double_elimination') {
        settings.grandFinal = grandFinalDouble ? 'double' : 'simple';
    }

    try {
        await apiFetch('/stages', {
            method: 'POST',
            body: JSON.stringify({ name, type, settings, eventName })
        });

        alert('✅ Turnier erfolgreich erstellt!');
        document.getElementById('createTournamentForm').reset();
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
            onMatchClick: (match) => {
                // Show quick winner selection instead of full modal
                showQuickWinnerSelection(match);
            }
        });
        
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
                ${rankings.map((r, index) => `
                    <div class="rankings-row ${index < 3 ? 'top-' + (index + 1) : ''}">
                        <div class="rank-cell">
                            <span class="rank-badge ${index < 3 ? 'rank-' + (index + 1) : ''}">${index + 1}</span>
                        </div>
                        <div class="name-cell">${escapeHtml(r.name)}</div>
                        <div class="stat-cell points">${r.points}</div>
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

    section.scrollIntoView({ behavior: 'smooth' });
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
            name: s.participant_name,
            wins: s.wins,
            losses: s.losses,
            pending: s.pending,
            points: s.points
        }));

        const title = stage.event_name ? `${stage.event_name} · ${stage.name}` : stage.name;
        showRankings(title, rankings);
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

        showRankings(`${eventName} · Gesamtwertung`, rankings, true);
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
            `⚠️ Match bereits abgeschlossen! Gewinner: ${winnerName}`;
    } else {
        document.getElementById('winnerModalInfo').textContent = 
            'Klicke auf den Gewinner des Matches:';
    }
    
    // Show modal
    document.getElementById('winnerModal').classList.add('show');
}

function selectWinner(winnerNum) {
    // Directly update match with selected winner
    updateMatchQuick(currentMatchForWinner.id, winnerNum === 1);
    closeWinnerModal();
}

function closeWinnerModal() {
    document.getElementById('winnerModal').classList.remove('show');
    currentMatchForWinner = null;
}

async function updateMatchQuick(matchId, opponent1Wins) {
    const opponent1 = {
        result: opponent1Wins ? 'win' : 'loss'
    };
    
    const opponent2 = {
        result: opponent1Wins ? 'loss' : 'win'
    };

    try {
        const response = await fetch(`${API_URL}/matches/${matchId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ opponent1, opponent2 })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to update match');
        }

        // Reload matches and re-render bracket
        await loadMatches();
        
        // Find the stage ID from the current bracket and re-render
        const bracketSection = document.getElementById('bracketViewerSection');
        if (bracketSection.style.display !== 'none') {
            // Get stage ID from the first match in the current view
            const match = matches.find(m => m.id === matchId);
            if (match) {
                await viewBracket(match.stage_id, true); // Preserve scroll position
            }
        }
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
const EXPORT_BACKGROUND = '#0b0f17';

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
