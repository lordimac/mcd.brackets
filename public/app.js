const API_URL = 'http://localhost:3000/api';

// State
let stages = [];
let matches = [];
let participants = [];

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await loadStages();
    await loadParticipants();
    await loadMatches();
    setupEventListeners();
});

function setupEventListeners() {
    document.getElementById('createTournamentForm').addEventListener('submit', createTournament);
    document.getElementById('editParticipantsForm').addEventListener('submit', saveParticipants);
    document.getElementById('eventName').addEventListener('change', handleEventSelection);
}

function toggleSection(sectionId) {
    const section = document.getElementById(sectionId);
    const icon = document.getElementById(sectionId.replace('Section', 'Icon'));
    
    if (section.style.display === 'none') {
        section.style.display = 'block';
        if (icon) icon.textContent = '▲';
    } else {
        section.style.display = 'none';
        if (icon) icon.textContent = '▼';
    }
}

function handleEventSelection() {
    const eventSelect = document.getElementById('eventName');
    const newEventInput = document.getElementById('newEventName');
    
    if (eventSelect.value === '__new__') {
        newEventInput.style.display = 'block';
        newEventInput.required = true;
        newEventInput.focus();
    } else {
        newEventInput.style.display = 'none';
        newEventInput.required = false;
        newEventInput.value = '';
    }
}

function updateEventDropdown() {
    const eventSelect = document.getElementById('eventName');
    const currentValue = eventSelect.value;
    
    // Get unique event names from stages
    const events = [...new Set(stages.map(s => s.event_name).filter(e => e))];
    
    eventSelect.innerHTML = '<option value="">Event auswählen...</option>' +
        events.map(event => `<option value="${event}">${event}</option>`).join('') +
        '<option value="__new__">+ Neues Event erstellen</option>';
    
    if (currentValue && events.includes(currentValue)) {
        eventSelect.value = currentValue;
    }
    
    // Update event filter
    updateEventFilter();
}

function updateEventFilter() {
    const eventFilter = document.getElementById('eventFilter');
    const currentValue = eventFilter.value;
    
    const events = [...new Set(stages.map(s => s.event_name).filter(e => e))];
    
    eventFilter.innerHTML = '<option value="">Alle Events</option>' +
        events.map(event => `<option value="${event}">${event}</option>`).join('');
    
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
        updateEventDropdown();
    } catch (error) {
        console.error('Error loading stages:', error);
        document.getElementById('stagesList').innerHTML = 
            '<p class="empty-state">❌ Fehler beim Laden der Turniere</p>';
    }
}

async function loadMatches() {
    try {
        const response = await fetch(`${API_URL}/matches`);
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
        participants = await response.json();
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

    container.innerHTML = filteredStages.map(stage => `
        <div class="stage-item">
            <h3>${stage.name}</h3>
            ${stage.event_name ? `<p class="event-name">🎯 ${stage.event_name}</p>` : ''}
            <div class="stage-info">
                <span class="info-badge badge-type">${formatType(stage.type)}</span>
                <span class="info-badge badge-id">Turnier #${stage.tournament_id}</span>
                <span class="info-badge badge-id">Stage #${stage.id}</span>
            </div>
            <div class="stage-actions">
                <button class="btn btn-secondary" onclick="viewStageMatches(${stage.id})">
                    Matches anzeigen
                </button>
                <button class="btn btn-success" onclick="viewBracket(${stage.id})">
                    📊 Bracket anzeigen
                </button>
                <button class="btn btn-info" onclick="viewRankings(${stage.id})">
                    🏆 Rangliste
                </button>
                <button class="btn btn-primary" onclick="editParticipants(${stage.id})">
                    ✏️ Teilnehmer bearbeiten
                </button>
                <button class="btn btn-warning" onclick="resetBracket(${stage.id})">
                    🔄 Bracket neu erzeugen
                </button>
                <button class="btn btn-danger" onclick="deleteStage(${stage.id})">
                    Löschen
                </button>
            </div>
        </div>
    `).join('');
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
                    tournaments: [],
                    tournamentIds: new Set()
                });
            }
            const event = eventMap.get(stage.event_name);
            event.tournaments.push(stage);
            event.tournamentIds.add(stage.tournament_id);
        }
    });
    
    const events = Array.from(eventMap.values());
    
    if (events.length === 0) {
        container.innerHTML = '<p class="empty-state">Keine Events vorhanden. Erstelle ein neues Turnier mit einem Event!</p>';
        return;
    }
    
    container.innerHTML = events.map(event => `
        <div class="event-item">
            <h3>🎯 ${event.name}</h3>
            <div class="event-info">
                <span class="info-badge badge-type">${event.tournaments.length} Turnier${event.tournaments.length !== 1 ? 'e' : ''}</span>
                <span class="info-badge badge-id">${event.tournamentIds.size} Tournament ID${event.tournamentIds.size !== 1 ? 's' : ''}</span>
            </div>
            <div class="event-actions">
                <button class="btn btn-success" onclick="viewEventRankings('${event.name.replace(/'/g, "\\'")}')">🏆 Gesamt-Rangliste</button>
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
        const opponent1 = getParticipantName(match.opponent1?.id);
        const opponent2 = getParticipantName(match.opponent2?.id);
        const status = getMatchStatus(match);
        
        return `
            <div class="match-item">
                <h3>Match #${match.id} - ${match.group_id ? 'Group ' + match.group_id : 'Round ' + match.round_id}</h3>
                <div class="match-info">
                    <span class="info-badge badge-id">Stage #${match.stage_id}</span>
                    <span class="info-badge ${status === 'Completed' ? 'badge-status' : 'badge-pending'}">
                        ${status}
                    </span>
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
                    <button class="btn btn-primary" onclick="showQuickWinnerSelectionById(${match.id})">
                        Ergebnis eingeben
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function updateStageFilter() {
    const filter = document.getElementById('stageFilter');
    const currentValue = filter.value;
    
    filter.innerHTML = '<option value="">Alle Stages</option>' + 
        stages.map(stage => 
            `<option value="${stage.id}">Stage #${stage.id} - ${stage.name}</option>`
        ).join('');
    
    if (currentValue) {
        filter.value = currentValue;
    }
}

// Create tournament
async function createTournament(e) {
    e.preventDefault();
    
    // Auto-generate tournament ID
    const tournamentId = stages.length > 0 
        ? Math.max(...stages.map(s => s.tournament_id)) + 1 
        : 1;
    
    // Get event name
    const eventSelect = document.getElementById('eventName');
    const eventName = eventSelect.value === '__new__' 
        ? document.getElementById('newEventName').value.trim()
        : eventSelect.value;
    
    if (!eventName) {
        alert('❌ Bitte wählen Sie ein Event aus oder erstellen Sie ein neues!');
        return;
    }
    
    const name = document.getElementById('stageName').value;
    const type = document.getElementById('tournamentType').value;
    const participantsText = document.getElementById('participants').value;
    const grandFinalDouble = document.getElementById('grandFinalDouble').checked;
    
    let seeding = participantsText.split('\n').filter(p => p.trim()).map(p => p.trim());
    
    if (seeding.length < 2) {
        alert('Mindestens 2 Teilnehmer erforderlich!');
        return;
    }

    // Shuffle participants randomly
    seeding = shuffleArray(seeding);

    // For elimination tournaments, fill with BYEs to next power of 2
    if (type === 'single_elimination' || type === 'double_elimination') {
        const originalCount = seeding.length;
        const nextPowerOf2 = getNextPowerOfTwo(originalCount);
        
        if (nextPowerOf2 > originalCount) {
            const byesNeeded = nextPowerOf2 - originalCount;
            
            // Add BYEs (null values) to reach power of 2
            for (let i = 0; i < byesNeeded; i++) {
                seeding.push(null);
            }
            
            console.log(`Added ${byesNeeded} BYEs to reach ${nextPowerOf2} participants`);
        }
    }

    const settings = {};
    if (type === 'double_elimination') {
        // Set grand final type based on checkbox
        settings.grandFinal = grandFinalDouble ? 'double' : 'simple';
    }

    try {
        const response = await fetch(`${API_URL}/stages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tournamentId, name, type, seeding, settings, eventName })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create stage');
        }

        alert('✅ Turnier erfolgreich erstellt!');
        document.getElementById('createTournamentForm').reset();
        await loadStages();
        await loadMatches();
        await loadParticipants();
    } catch (error) {
        alert('❌ Fehler beim Erstellen: ' + error.message);
        console.error('Error creating tournament:', error);
    }
}

// Get next power of 2
function getNextPowerOfTwo(n) {
    if (n <= 1) return 2;
    if (isPowerOfTwo(n)) return n;
    
    let power = 1;
    while (power < n) {
        power *= 2;
    }
    return power;
}

function isPowerOfTwo(n) {
    return n > 0 && (n & (n - 1)) === 0;
}

// Shuffle array randomly (Fisher-Yates algorithm)
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Helper function to show winner selection from match list
function showQuickWinnerSelectionById(matchId) {
    const match = matches.find(m => m.id === matchId);
    if (!match) return;
    
    // Convert match format to bracket format if needed
    const bracketMatch = {
        id: match.id,
        opponent1: match.opponent1,
        opponent2: match.opponent2
    };
    
    showQuickWinnerSelection(bracketMatch);
}

// Delete stage
async function deleteStage(stageId) {
    if (!confirm('Möchten Sie diese Stage wirklich löschen?')) {
        return;
    }

    try {
        // Get stage info to find tournament_id
        const stage = stages.find(s => s.id === stageId);
        if (stage) {
            // Delete all participants for this tournament
            const tournamentParticipants = participants.filter(p => p.tournament_id === stage.tournament_id);
            for (const participant of tournamentParticipants) {
                await fetch(`${API_URL}/participants/${participant.id}`, {
                    method: 'DELETE'
                });
            }
        }

        // Delete the stage
        const response = await fetch(`${API_URL}/stages/${stageId}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            throw new Error('Failed to delete stage');
        }

        alert('✅ Stage erfolgreich gelöscht!');
        await loadParticipants();
        await loadStages();
        await loadMatches();
    } catch (error) {
        alert('❌ Fehler beim Löschen: ' + error.message);
        console.error('Error deleting stage:', error);
    }
}

// Reset bracket
async function resetBracket(stageId) {
    if (!confirm('⚠️ Möchten Sie das Bracket wirklich neu erzeugen? Alle Ergebnisse gehen verloren!')) {
        return;
    }

    try {
        // Get stage info
        const stage = stages.find(s => s.id === stageId);
        if (!stage) {
            throw new Error('Stage not found');
        }

        // Get participants for this tournament BEFORE deleting
        const tournamentParticipants = participants.filter(p => p.tournament_id === stage.tournament_id);
        
        // Create seeding array with participant names and shuffle
        let seeding = shuffleArray(tournamentParticipants.map(p => p.name));
        
        // Add BYEs if needed for elimination tournaments
        if (stage.type === 'single_elimination' || stage.type === 'double_elimination') {
            const requiredSize = getNextPowerOfTwo(seeding.length);
            while (seeding.length < requiredSize) {
                seeding.push(null);
            }
        }

        // Delete all participants for this tournament
        for (const participant of tournamentParticipants) {
            await fetch(`${API_URL}/participants/${participant.id}`, {
                method: 'DELETE'
            });
        }

        // Delete the stage
        await fetch(`${API_URL}/stages/${stageId}`, {
            method: 'DELETE'
        });

        const settings = {};
        if (stage.type === 'double_elimination') {
            settings.grandFinal = 'double';
        }

        // Create new stage (this will create new participants)
        const response = await fetch(`${API_URL}/stages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tournamentId: stage.tournament_id,
                name: stage.name,
                type: stage.type,
                seeding,
                settings
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to reset bracket');
        }

        const newStageData = await response.json();

        alert('✅ Bracket erfolgreich neu erzeugt!');
        
        // Close bracket viewer if open
        closeBracketViewer();
        
        await loadParticipants();
        await loadStages();
        await loadMatches();
        
        // Reopen bracket with new stage ID
        if (newStageData && newStageData.id) {
            setTimeout(() => {
                viewBracket(newStageData.id);
            }, 500);
        }
    } catch (error) {
        alert('❌ Fehler beim Neu-Erzeugen: ' + error.message);
        console.error('Error resetting bracket:', error);
    }
}

// Edit participants
function editParticipants(stageId) {
    const stage = stages.find(s => s.id === stageId);
    
    if (!stage) {
        alert('❌ Kein Stage gefunden!');
        return;
    }
    
    const tournamentParticipants = participants.filter(p => p.tournament_id === stage.tournament_id);
    const participantNames = tournamentParticipants.map(p => p.name).join('\n');
    
    const modal = document.getElementById('editParticipantsModal');
    document.getElementById('editTournamentId').value = stage.tournament_id;
    document.getElementById('editStageId').value = stage.id;
    document.getElementById('editParticipantsText').value = participantNames;
    modal.classList.add('show');
}

function closeEditParticipantsModal() {
    document.getElementById('editParticipantsModal').classList.remove('show');
}

async function saveParticipants(e) {
    e.preventDefault();
    
    const tournamentId = parseInt(document.getElementById('editTournamentId').value);
    const stageId = parseInt(document.getElementById('editStageId').value);
    const participantsText = document.getElementById('editParticipantsText').value;
    
    const newNames = participantsText
        .split('\n')
        .map(name => name.trim())
        .filter(name => name.length > 0);
    
    if (newNames.length < 2) {
        alert('❌ Mindestens 2 Teilnehmer erforderlich!');
        return;
    }

    if (isNaN(stageId)) {
        alert('❌ Kein Stage gefunden für dieses Turnier!');
        console.error('Invalid stageId:', stageId, 'tournamentId:', tournamentId);
        return;
    }

    try {
        // Get stage info
        const stage = stages.find(s => s.id === stageId);
        if (!stage) {
            throw new Error('Stage not found');
        }

        // Get existing participants for this tournament
        const existingParticipants = participants.filter(p => p.tournament_id === tournamentId);
        
        // Delete all existing participants
        for (const participant of existingParticipants) {
            await fetch(`${API_URL}/participants/${participant.id}`, {
                method: 'DELETE'
            });
        }

        // Delete the stage
        await fetch(`${API_URL}/stages/${stageId}`, {
            method: 'DELETE'
        });

        // Prepare seeding
        let seeding = shuffleArray([...newNames]);
        
        // Add BYEs if needed for elimination tournaments
        if (stage.type === 'single_elimination' || stage.type === 'double_elimination') {
            const requiredSize = getNextPowerOfTwo(seeding.length);
            while (seeding.length < requiredSize) {
                seeding.push(null);
            }
        }

        const settings = {};
        if (stage.type === 'double_elimination') {
            settings.grandFinal = 'double';
        }

        // Create new stage with new participants
        const response = await fetch(`${API_URL}/stages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tournamentId: stage.tournament_id,
                name: stage.name,
                type: stage.type,
                seeding,
                settings
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to update participants');
        }

        const newStageData = await response.json();

        alert('✅ Teilnehmer erfolgreich aktualisiert und Bracket neu erzeugt!');
        closeEditParticipantsModal();
        
        // Close bracket viewer if open
        closeBracketViewer();
        
        await loadParticipants();
        await loadStages();
        await loadMatches();
        
        // Reopen bracket with new stage ID
        if (newStageData && newStageData.id) {
            setTimeout(() => {
                viewBracket(newStageData.id);
            }, 500);
        }
    } catch (error) {
        alert('❌ Fehler beim Speichern: ' + error.message);
        console.error('Error saving participants:', error);
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
            eventNameElement.textContent = `🎯 ${stage.event_name} - ${stage.name}`;
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

// View rankings
async function viewRankings(stageId) {
    try {
        const stage = stages.find(s => s.id === stageId);
        if (!stage) {
            alert('❌ Stage nicht gefunden!');
            return;
        }

        // Try to fetch proper standings from backend
        let rankings = [];
        try {
            const standingsResponse = await fetch(`${API_URL}/standings/${stageId}`);
            const standings = await standingsResponse.json();
            
            // Convert standings to rankings format
            const pointsSystem = [30, 22, 16, 12, 9, 7, 5, 3, 2, 2, 2, 2, 1, 1, 1, 1];
            rankings = standings.map((standing, index) => ({
                name: standing.participant_name,
                wins: standing.wins,
                losses: standing.losses,
                pending: 0, // Standings only include completed matches
                played: standing.wins + standing.losses,
                winRate: standing.wins + standing.losses > 0 
                    ? (standing.wins / (standing.wins + standing.losses) * 100).toFixed(1) 
                    : 0,
                points: index < pointsSystem.length ? pointsSystem[index] : 1
            }));
        } catch (error) {
            console.error('Error fetching standings, falling back to match-based calculation:', error);
            
            // Fallback to old calculation method
            const stageMatches = matches.filter(m => m.stage_id === stageId);
            const stageParticipants = participants.filter(p => p.tournament_id === stage.tournament_id);
            
            rankings = stageParticipants.map(participant => {
                const participantMatches = stageMatches.filter(m => 
                    m.opponent1?.id === participant.id || m.opponent2?.id === participant.id
                );
                
                let wins = 0;
                let losses = 0;
                let pending = 0;
                
                participantMatches.forEach(match => {
                    const isOpponent1 = match.opponent1?.id === participant.id;
                    const result = isOpponent1 ? match.opponent1?.result : match.opponent2?.result;
                    
                    if (result === 'win') wins++;
                    else if (result === 'loss') losses++;
                    else if (match.opponent1?.id != null && match.opponent2?.id != null) pending++;
                });
                
                return {
                    name: participant.name,
                    wins,
                    losses,
                    pending,
                    played: wins + losses,
                    winRate: wins + losses > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 0
                };
            });
            
            rankings.sort((a, b) => {
                if (b.wins !== a.wins) return b.wins - a.wins;
                return parseFloat(b.winRate) - parseFloat(a.winRate);
            });
            
            const pointsSystem = [30, 22, 16, 12, 9, 7, 5, 3, 2, 2, 2, 2, 1, 1, 1, 1];
            rankings.forEach((ranking, index) => {
                // Award points based on placement, with diminishing returns after top 16
                if (index < pointsSystem.length) {
                    ranking.points = pointsSystem[index];
                } else {
                    // Everyone beyond top 16 gets 1 point
                    ranking.points = 1;
                }
            });
        }
        
        // Show rankings section
        const section = document.getElementById('rankingsSection');
        section.style.display = 'block';
        
        // Set event name
        const eventNameElement = document.getElementById('rankingsEventName');
        if (stage.event_name) {
            eventNameElement.textContent = `🎯 ${stage.event_name} - ${stage.name}`;
        } else {
            eventNameElement.textContent = stage.name;
        }
        
        // Display rankings
        const container = document.getElementById('rankingsList');
        if (rankings.length === 0) {
            container.innerHTML = '<p class="empty-state">Keine Rangliste verfügbar</p>';
        } else {
            container.innerHTML = `
                <div class="rankings-table">
                    <div class="rankings-header">
                        <div class="rank-cell">Platz</div>
                        <div class="name-cell">Teilnehmer</div>
                        <div class="stat-cell">Punkte</div>
                        <div class="stat-cell">Siege</div>
                        <div class="stat-cell">Niederlagen</div>
                        <div class="stat-cell">Gespielt</div>
                        <div class="stat-cell">Ausstehend</div>
                        <div class="stat-cell">Siegrate</div>
                    </div>
                    ${rankings.map((r, index) => `
                        <div class="rankings-row ${index < 3 ? 'top-' + (index + 1) : ''}">
                            <div class="rank-cell">
                                ${index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : index + 1}
                            </div>
                            <div class="name-cell">${r.name}</div>
                            <div class="stat-cell points">${r.points}</div>
                            <div class="stat-cell wins">${r.wins}</div>
                            <div class="stat-cell losses">${r.losses}</div>
                            <div class="stat-cell">${r.played}</div>
                            <div class="stat-cell">${r.pending}</div>
                            <div class="stat-cell">${r.winRate}%</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }
        
        section.scrollIntoView({ behavior: 'smooth' });
    } catch (error) {
        alert('❌ Fehler beim Laden der Rangliste: ' + error.message);
        console.error('Error loading rankings:', error);
    }
}

function closeRankings() {
    document.getElementById('rankingsSection').style.display = 'none';
}

// View overall event rankings
async function viewEventRankings(eventName) {
    try {
        // Get all stages for this event
        const eventStages = stages.filter(s => s.event_name === eventName);
        if (eventStages.length === 0) {
            alert('❌ Keine Turniere für dieses Event gefunden!');
            return;
        }

        const tournamentIds = [...new Set(eventStages.map(s => s.tournament_id))];
        
        // Get all matches for these stages
        const eventMatches = matches.filter(m => 
            eventStages.some(s => s.id === m.stage_id)
        );
        
        // Get all participants for these tournaments
        const eventParticipants = participants.filter(p => 
            tournamentIds.includes(p.tournament_id)
        );
        
        // Points system for placements
        const pointsSystem = [30, 22, 16, 12, 9, 7, 5, 3, 2, 2, 2, 2, 1, 1, 1, 1];
        
        // Calculate overall rankings with points
        const participantStats = new Map();
        
        eventParticipants.forEach(participant => {
            if (!participantStats.has(participant.name)) {
                participantStats.set(participant.name, {
                    name: participant.name,
                    wins: 0,
                    losses: 0,
                    pending: 0,
                    tournaments: new Set(),
                    points: 0
                });
            }
        });
        
        // Process each tournament separately to calculate placements and award points
        for (const stage of eventStages) {
            try {
                // Fetch correct placements from backend
                const standingsResponse = await fetch(`${API_URL}/standings/${stage.id}`);
                const standings = await standingsResponse.json();
                
                // Award points based on placement from backend
                standings.forEach((standing) => {
                    const stats = participantStats.get(standing.participant_name);
                    if (stats) {
                        const placement = standing.placement - 1; // Convert to 0-based index
                        let points;
                        if (placement < pointsSystem.length) {
                            points = pointsSystem[placement];
                        } else {
                            points = 1; // Everyone beyond top 16 gets 1 point
                        }
                        stats.points += points;
                        
                        // Also update wins/losses from standings
                        stats.wins += standing.wins;
                        stats.losses += standing.losses;
                        stats.tournaments.add(stage.tournament_id);
                    }
                });
            } catch (error) {
                console.error(`Error fetching standings for stage ${stage.id}:`, error);
                // Fallback to old win-based calculation if standings endpoint fails
                const tournamentMatches = eventMatches.filter(m => m.stage_id === stage.id);
                const tournamentParticipants = eventParticipants.filter(p => p.tournament_id === stage.tournament_id);
                
                const tournamentRankings = [];
                
                for (const participant of tournamentParticipants) {
                    if (!participant.name) continue;
                    
                    let tournamentWins = 0;
                    let tournamentLosses = 0;
                    let tournamentPending = 0;
                    
                    tournamentMatches.forEach(match => {
                        const isOpponent1 = match.opponent1?.id === participant.id;
                        const isOpponent2 = match.opponent2?.id === participant.id;
                        
                        if (!isOpponent1 && !isOpponent2) return;
                        
                        if (isOpponent1) {
                            if (match.opponent1?.result === 'win') tournamentWins++;
                            else if (match.opponent1?.result === 'loss') tournamentLosses++;
                            else if (match.opponent1?.id != null && match.opponent2?.id != null) tournamentPending++;
                        } else if (isOpponent2) {
                            if (match.opponent2?.result === 'win') tournamentWins++;
                            else if (match.opponent2?.result === 'loss') tournamentLosses++;
                            else if (match.opponent1?.id != null && match.opponent2?.id != null) tournamentPending++;
                        }
                    });
                    
                    const tournamentMatches_played = tournamentWins + tournamentLosses;
                    const tournamentWinRate = tournamentMatches_played > 0 ? tournamentWins / tournamentMatches_played : 0;
                    
                    tournamentRankings.push({
                        name: participant.name,
                        wins: tournamentWins,
                        winRate: tournamentWinRate,
                        matchesPlayed: tournamentMatches_played + tournamentPending
                    });
                    
                    const stats = participantStats.get(participant.name);
                    stats.wins += tournamentWins;
                    stats.losses += tournamentLosses;
                    stats.pending += tournamentPending;
                    stats.tournaments.add(stage.tournament_id);
                }
                
                tournamentRankings.sort((a, b) => {
                    if (b.wins !== a.wins) return b.wins - a.wins;
                    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
                    return b.matchesPlayed - a.matchesPlayed;
                });
                
                tournamentRankings.forEach((ranking, index) => {
                    let points;
                    if (index < pointsSystem.length) {
                        points = pointsSystem[index];
                    } else {
                        points = 1; // Everyone beyond top 16 gets 1 point
                    }
                    const stats = participantStats.get(ranking.name);
                    stats.points += points;
                });
            }
        }
        
        const rankings = Array.from(participantStats.values()).map(stats => ({
            name: stats.name,
            wins: stats.wins,
            losses: stats.losses,
            pending: stats.pending,
            played: stats.wins + stats.losses,
            tournaments: stats.tournaments.size,
            points: stats.points,
            winRate: stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses) * 100).toFixed(1) : 0
        }));
        
        // Sort by points (desc), then wins (desc), then win rate (desc)
        rankings.sort((a, b) => {
            if (b.points !== a.points) return b.points - a.points;
            if (b.wins !== a.wins) return b.wins - a.wins;
            if (parseFloat(b.winRate) !== parseFloat(a.winRate)) return parseFloat(b.winRate) - parseFloat(a.winRate);
            return b.tournaments - a.tournaments;
        });
        
        // Show rankings section
        const section = document.getElementById('rankingsSection');
        section.style.display = 'block';
        
        // Set event name
        const eventNameElement = document.getElementById('rankingsEventName');
        eventNameElement.textContent = `🎯 ${eventName} - Gesamt-Rangliste`;
        
        // Display rankings
        const container = document.getElementById('rankingsList');
        if (rankings.length === 0) {
            container.innerHTML = '<p class="empty-state">Keine Rangliste verfügbar</p>';
        } else {
            container.innerHTML = `
                <div class="rankings-table">
                    <div class="rankings-header">
                        <div class="rank-cell">Platz</div>
                        <div class="name-cell">Teilnehmer</div>
                        <div class="stat-cell">Punkte</div>
                        <div class="stat-cell">Siege</div>
                        <div class="stat-cell">Niederlagen</div>
                        <div class="stat-cell">Gespielt</div>
                        <div class="stat-cell">Ausstehend</div>
                        <div class="stat-cell">Turniere</div>
                        <div class="stat-cell">Siegrate</div>
                    </div>
                    ${rankings.map((r, index) => `
                        <div class="rankings-row ${index < 3 ? 'top-' + (index + 1) : ''}">
                            <div class="rank-cell">
                                ${index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : index + 1}
                            </div>
                            <div class="name-cell">${r.name}</div>
                            <div class="stat-cell points">${r.points}</div>
                            <div class="stat-cell wins">${r.wins}</div>
                            <div class="stat-cell losses">${r.losses}</div>
                            <div class="stat-cell">${r.played}</div>
                            <div class="stat-cell">${r.pending}</div>
                            <div class="stat-cell">${r.tournaments}</div>
                            <div class="stat-cell">${r.winRate}%</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }
        
        section.scrollIntoView({ behavior: 'smooth' });
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
    if (!participantId) return 'TBD';
    const participant = participants.find(p => p.id === participantId);
    return participant ? participant.name : `Participant #${participantId}`;
}

function getMatchStatus(match) {
    if (match.opponent1?.result || match.opponent2?.result) {
        return 'Completed';
    }
    if (!match.opponent1?.id || !match.opponent2?.id) {
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

// Close modal on outside click
window.onclick = function(event) {
    const matchModal = document.getElementById('matchModal');
    const winnerModal = document.getElementById('winnerModal');
    
    if (event.target === matchModal) {
        closeMatchModal();
    }
    
    if (event.target === winnerModal) {
        closeWinnerModal();
    }
}
