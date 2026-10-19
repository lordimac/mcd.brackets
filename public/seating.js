// Seating plan: rooms of the current event with freely placed table groups (rows, U shapes, areas).
// The server computes each group's cells and the seat numbers (room.layout); the editor only moves,
// rotates, duplicates and deletes groups and sends the complete group list back.
// Uses apiFetch, escapeHtml, openModal/closeModal, toggleSection, isAdmin, lanEvents/loadEvents
// from app.js and currentEventId/ensureCurrentEvent from lan.js.

let seatRooms = [];
let seatAttendees = [];   // attendees of the current event (with display_name)
let currentRoomId = null;
let seatMode = 'assign';  // 'assign' or 'layout' (admins only)
let seatPick = null;      // attendee chosen in "Ohne Platz", placed by the next seat click
let seatModalKey = null;
let selectedGroups = new Set();
let selectedDoors = new Set();
let seatTemplate = 'row';
let placeAt = null;       // cell clicked on the empty canvas: the next building block goes there
let pointerAction = null; // drag or rubber-band selection in progress
let moveSaveTimer = null;
let editQueue = Promise.resolve(); // edits run one after another, each on the latest saved state

const ZOOM_STEPS = [28, 34, 40, 48, 56, 64, 74, 86, 100];
let seatUnit = 56;
let seatZoomAuto = true; // fit the room to the visible width until someone zooms by hand

const TEMPLATE_PARAMS = {
    row: [
        { name: 'length', label: 'Tische', type: 'number', value: 6, min: 1, max: 60 },
        { name: 'sides', label: 'Tische an', type: 'select', value: 'both', options: [['both', 'beiden Seiten'], ['one', 'einer Seite'], ['none', 'keiner Seite']] },
    ],
    double: [{ name: 'length', label: 'Tische je Seite', type: 'number', value: 6, min: 1, max: 60 }],
    u: [
        { name: 'length', label: 'Tische unten', type: 'number', value: 6, min: 2, max: 60 },
        { name: 'arm', label: 'Tische je Seite', type: 'number', value: 4, min: 1, max: 60 },
    ],
    block: [
        { name: 'rows', label: 'Doppelreihen', type: 'number', value: 3, min: 1, max: 20 },
        { name: 'length', label: 'Tische je Seite', type: 'number', value: 6, min: 1, max: 60 },
    ],
    area: [
        { name: 'label', label: 'Beschriftung', type: 'text', value: 'Bühne' },
        { name: 'width', label: 'Breite', type: 'number', value: 4, min: 1, max: 80 },
        { name: 'height', label: 'Tiefe', type: 'number', value: 2, min: 1, max: 80 },
    ],
    // Without a fixed wall the door goes to the wall nearest the clicked spot
    door: [
        { name: 'side', label: 'Wand', type: 'select', value: 'auto', options: [['auto', 'nächste zum Ziel'], ['top', 'oben'], ['right', 'rechts'], ['bottom', 'unten'], ['left', 'links']] },
        { name: 'width', label: 'Breite', type: 'number', value: 2, min: 1, max: 6 },
        { name: 'swing', label: 'Öffnet nach', type: 'select', value: 'in', options: [['in', 'innen'], ['out', 'außen']] },
        { name: 'hinge', label: 'Anschlag', type: 'select', value: 'start', options: [['start', 'links / oben'], ['end', 'rechts / unten']] },
    ],
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('newRoomForm').addEventListener('submit', createRoom);
    document.getElementById('duplicateRoomForm').addEventListener('submit', duplicateRoom);
    document.getElementById('duplicateRoomEvent').addEventListener('change', suggestDuplicateName);
    document.getElementById('roomSettingsForm').addEventListener('submit', saveRoomSettings);
    const canvas = document.getElementById('roomCanvas');
    canvas.addEventListener('pointerdown', onCanvasPointerDown);
    canvas.addEventListener('pointerover', e => {
        const target = e.target.closest('.cell-seat, .chair');
        if (target && !pointerAction) showSeatTooltip(target);
        else if (!target) hideSeatTooltip();
    });
    canvas.addEventListener('pointerleave', hideSeatTooltip);
    document.getElementById('seatGridWrap').addEventListener('scroll', hideSeatTooltip);
    window.addEventListener('scroll', hideSeatTooltip, { passive: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('keydown', onLayoutKey);
    try {
        const stored = Number(localStorage.getItem('mcd.seatZoom'));
        if (ZOOM_STEPS.includes(stored)) {
            seatUnit = stored;
            seatZoomAuto = false;
        }
    } catch { /* storage unavailable */ }
    window.addEventListener('resize', () => {
        if (seatZoomAuto && currentRoom() && document.getElementById('view-seating').offsetParent) renderSeating();
    });
    renderTemplateParams();
});

/* Loading
   ========================================================================== */

// Called by showView() in app.js whenever the seating tab opens
async function showSeatingView() {
    await loadEvents();
    ensureCurrentEvent();
    renderSeatEventSelect();
    await loadSeating();
}

function renderSeatEventSelect() {
    const select = document.getElementById('seatEventSelect');
    const events = [...lanEvents].reverse();
    select.innerHTML = events.length
        ? events.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')
        : '<option value="">Noch kein Event — unter „Teilnehmer“ anlegen</option>';
    if (currentEventId != null) select.value = String(currentEventId);
}

async function selectSeatEvent(id) {
    currentEventId = Number(id);
    try { localStorage.setItem('mcd.attendeeEvent', String(currentEventId)); } catch { /* storage unavailable */ }
    currentRoomId = null;
    await loadSeating();
}

async function loadSeating() {
    if (currentEventId == null) {
        seatRooms = [];
        seatAttendees = [];
    } else {
        [seatRooms, seatAttendees] = await Promise.all([
            apiFetch(`/events/${currentEventId}/rooms`).catch(() => []),
            apiFetch(`/events/${currentEventId}/attendees`).catch(() => []),
        ]);
    }
    if (!seatRooms.some(r => r.id === currentRoomId)) {
        let saved = null;
        try { saved = Number(localStorage.getItem('mcd.seatRoom')); } catch { /* storage unavailable */ }
        currentRoomId = seatRooms.some(r => r.id === saved) ? saved : seatRooms[0]?.id ?? null;
    }
    seatPick = null;
    placeAt = null;
    clearSelection();
    fillRoomSettings();
    renderSeating();
}

function selectRoom(id) {
    currentRoomId = Number(id);
    try { localStorage.setItem('mcd.seatRoom', String(currentRoomId)); } catch { /* storage unavailable */ }
    clearSelection();
    placeAt = null;
    fillRoomSettings();
    renderSeating();
}

function replaceRoom(updated) {
    seatRooms = seatRooms.map(r => (r.id === updated.id ? updated : r));
}

/* Helpers
   ========================================================================== */

function currentRoom() {
    return seatRooms.find(r => r.id === currentRoomId) || null;
}

function attendeeMap() {
    return new Map(seatAttendees.map(a => [a.id, a]));
}

function seatNumber(room, key) {
    return room.layout.seats.find(s => s.key === key)?.label;
}

// Where an attendee sits: { room, key, number } or null
// Seats count against each other within the final rooms; an alternative only against itself
function competingRooms(room = currentRoom()) {
    if (room?.alternative) return [room];
    return seatRooms.filter(r => !r.alternative);
}

// Where an attendee sits, seen from a room (final plan, or within an alternative): { room, key, number } or null
function seatOfAttendee(attendeeId, from = currentRoom()) {
    for (const room of competingRooms(from)) {
        const entry = Object.entries(room.seats).find(([, id]) => id === attendeeId);
        if (entry) return { room, key: entry[0], number: seatNumber(room, entry[0]) };
    }
    return null;
}

function seatedIds(room = currentRoom()) {
    return new Set(competingRooms(room).flatMap(r => Object.values(r.seats)));
}

function fullName(a) {
    return [a.first_name, a.last_name].filter(Boolean).join(' ');
}

function attendeeMatches(a, query) {
    return [a.display_name, a.nickname, a.clan, a.first_name, a.last_name, fullName(a)]
        .some(value => (value || '').toLowerCase().includes(query));
}

const canEdit = () => isAdmin;
const searchQuery = () => document.getElementById('seatSearch').value.trim().toLowerCase();

// Size of a group after rotation, from the server layout
function groupSize(room, id) {
    const g = room.layout.groups.find(l => l.id === id);
    return g ? { w: g.w, h: g.h } : { w: 1, h: 1 };
}

/* Rendering
   ========================================================================== */

function renderRoomTabs() {
    const tabs = document.getElementById('roomTabs');
    tabs.innerHTML = seatRooms.map(room => {
        const total = room.layout.seats.length;
        const taken = Object.keys(room.seats).length;
        return `<button type="button" role="tab" class="room-tab${room.id === currentRoomId ? ' active' : ''}${room.alternative ? ' is-alternative' : ''}" data-room="${room.id}" onclick="selectRoom(this.dataset.room)" title="${room.alternative ? 'Alternative (Entwurf)' : 'Finaler Sitzplan'}">
            ${escapeHtml(room.name)}${room.alternative ? ' <span class="room-tab-flag">Alternative</span>' : ''} <span class="room-tab-count">${taken}/${total}</span></button>`;
    }).join('');
    document.getElementById('roomConfigToggle').style.display = currentRoom() ? '' : 'none';
    document.getElementById('duplicateRoomBtn').style.display = currentRoom() ? '' : 'none';
    document.getElementById('newRoomBtn').style.display = currentEventId != null ? '' : 'none';
}

function renderSeating() {
    renderRoomTabs();
    const room = currentRoom();
    const editable = canEdit();
    if (!editable) seatMode = 'assign';

    document.getElementById('seatExportActions').style.display = room ? '' : 'none';
    document.querySelectorAll('.seat-toolbar .segmented button').forEach(b => b.classList.toggle('active', b.dataset.mode === seatMode));
    document.getElementById('seatAssignTools').style.display = room && seatMode === 'assign' ? '' : 'none';
    document.getElementById('seatLayoutTools').style.display = room && seatMode === 'layout' ? '' : 'none';
    document.getElementById('unseatedPanel').style.display = room && seatMode === 'assign' ? '' : 'none';
    document.getElementById('seatPlanCard').classList.toggle('is-layout', seatMode === 'layout');

    const canvas = document.getElementById('roomCanvas');
    if (!room) {
        document.getElementById('seatRoomTitle').textContent = 'Sitzplan';
        document.getElementById('seatSummary').textContent = '';
        document.getElementById('seatResults').innerHTML = '';
        canvas.style.width = '';
        canvas.style.height = '';
        canvas.innerHTML = `<p class="empty-state">${currentEventId == null
            ? 'Noch kein Event vorhanden.'
            : editable ? 'Noch kein Raum — mit „+ Raum“ den ersten anlegen.' : 'Für dieses Event gibt es noch keinen Sitzplan.'}</p>`;
        return;
    }

    const total = room.layout.seats.length;
    const taken = Object.keys(room.seats).length;
    const unseated = seatAttendees.length - seatedIds().size;
    document.getElementById('seatRoomTitle').textContent = room.alternative ? `${room.name} (Alternative)` : room.name;
    document.getElementById('seatSummary').textContent = `${total} Plätze · ${taken} belegt · ${total - taken} frei`
        + (unseated > 0 ? ` · ${unseated} Teilnehmer ohne Platz` : '')
        + (room.layout.duplicates.length ? ` · doppelte Nummern: ${room.layout.duplicates.join(', ')}` : '');

    renderCanvas(room);
    renderSeatResults();
    if (seatMode === 'assign' && editable) renderUnseated();
    if (seatMode === 'layout') renderSelectionBar();
}

/* Chairs (seen from above) in the seating cells, each facing the numbered table it belongs to
   ========================================================================== */

// Directions from a seating cell to the numbered tables next to it (same group)
function chairDirections(cell, shape) {
    return chairTables(cell, shape).map(t => t.dir);
}

// Like chairDirections, with the key of the table each chair belongs to
function chairTables(cell, shape) {
    const at = new Map(shape.cells.map(c => [`${c.dx},${c.dy}`, c]));
    const result = [];
    for (const [dir, dx, dy] of [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]]) {
        const next = at.get(`${cell.dx + dx},${cell.dy + dy}`);
        if (next?.kind === 'seat') result.push({ dir, key: next.key });
    }
    return result;
}

// Chair parts in a 100 × 100 cell: seat close to the table, backrest away from it. With two
// chairs in one cell (tables on both sides) each gets the half towards its table.
function chairRects(dirs) {
    const half = dirs.length > 1;
    // Drawn for a table above the cell, then turned towards the real direction
    const up = half
        ? [{ x: 30, y: 5, w: 40, h: 24, r: 5, part: 'seat' }, { x: 27, y: 31, w: 46, h: 8, r: 3, part: 'back' }]
        : [{ x: 26, y: 8, w: 48, h: 40, r: 7, part: 'seat' }, { x: 22, y: 52, w: 56, h: 12, r: 4, part: 'back' }];
    const turn = (r, dir) => {
        if (dir === 'down') return { ...r, x: 100 - r.x - r.w, y: 100 - r.y - r.h };
        if (dir === 'left') return { ...r, x: r.y, y: 100 - r.x - r.w, w: r.h, h: r.w };
        if (dir === 'right') return { ...r, x: 100 - r.y - r.h, y: r.x, w: r.h, h: r.w };
        return r;
    };
    return dirs.flatMap(dir => up.map(r => turn(r, dir)));
}

// Each chair is a <g data-key> so hovering it shows the tooltip of its table
function chairSvg(tables) {
    if (tables.length === 0) return '';
    const dirs = tables.map(t => t.dir);
    const rects = chairRects(dirs); // two parts per chair, in the order of dirs
    return `<svg class="chairs" viewBox="0 0 100 100" aria-hidden="true">${tables.map((t, i) =>
        `<g class="chair" data-key="${t.key}">${rects.slice(i * 2, i * 2 + 2)
            .map(r => `<rect class="chair-${r.part}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${r.r}"/>`).join('')}</g>`).join('')}</svg>`;
}

// Margin around the room per side: at least one cell, more where a wider door opens outwards
function doorMargins(room) {
    const m = { top: 1, right: 1, bottom: 1, left: 1 };
    for (const d of room.doors) if (d.swing === 'out') m[d.side] = Math.max(m[d.side], d.width);
    return m;
}

// Door geometry in room cells: hinge point, open leaf end, free end of the opening.
// Inward doors swing into the room, outward ones into the margin around it.
function doorGeometry(door, room) {
    const a = door.offset, b = door.offset + door.width;
    const [hingeAlong, freeAlong] = door.hinge === 'end' ? [b, a] : [a, b];
    const inward = door.swing === 'in' ? 1 : -1;
    const w = door.width;
    if (door.side === 'top') return { hinge: [hingeAlong, 0], leaf: [hingeAlong, inward * w], free: [freeAlong, 0] };
    if (door.side === 'bottom') return { hinge: [hingeAlong, room.height], leaf: [hingeAlong, room.height - inward * w], free: [freeAlong, room.height] };
    if (door.side === 'left') return { hinge: [0, hingeAlong], leaf: [inward * w, hingeAlong], free: [0, freeAlong] };
    return { hinge: [room.width, hingeAlong], leaf: [room.width - inward * w, hingeAlong], free: [room.width, freeAlong] };
}

// Sweep direction of the quarter circle from the leaf end to the free end (y axis points down)
function doorSweep({ hinge, leaf, free }) {
    const cross = (leaf[0] - hinge[0]) * (free[1] - hinge[1]) - (leaf[1] - hinge[1]) * (free[0] - hinge[0]);
    return cross > 0 ? 1 : 0;
}

function renderDoors(room) {
    if (!room.doors.length) return '';
    const parts = room.doors.map(door => {
        const g = doorGeometry(door, room);
        const r = door.width;
        const xs = [g.hinge[0], g.leaf[0], g.free[0]], ys = [g.hinge[1], g.leaf[1], g.free[1]];
        const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) || 0.4, h: Math.max(...ys) - Math.min(...ys) || 0.4 };
        const selected = selectedDoors.has(door.id) ? ' is-selected' : '';
        return `<g class="room-door${selected}" data-door="${door.id}">
            <line class="door-gap" x1="${g.hinge[0]}" y1="${g.hinge[1]}" x2="${g.free[0]}" y2="${g.free[1]}"/>
            <path class="door-arc" d="M ${g.leaf[0]} ${g.leaf[1]} A ${r} ${r} 0 0 ${doorSweep(g)} ${g.free[0]} ${g.free[1]}"/>
            <line class="door-leaf" x1="${g.hinge[0]}" y1="${g.hinge[1]}" x2="${g.leaf[0]}" y2="${g.leaf[1]}"/>
            <rect class="door-hit" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"><title>Tür${door.swing === 'out' ? ' (öffnet nach außen)' : ''}</title></rect>
        </g>`;
    }).join('');
    const m = doorMargins(room);
    return `<svg class="room-doors" viewBox="${-m.left} ${-m.top} ${room.width + m.left + m.right} ${room.height + m.top + m.bottom}" preserveAspectRatio="none" aria-hidden="true">${parts}</svg>`;
}

function renderCanvas(room) {
    const canvas = document.getElementById('roomCanvas');
    if (seatZoomAuto) seatUnit = fitZoom(room);
    const people = attendeeMap();
    const query = searchQuery();
    const numbers = new Map(room.layout.seats.map(s => [s.key, s.label]));
    const duplicates = new Set(room.layout.duplicates.map(l => l.toLowerCase()));
    const shapes = new Map(room.layout.groups.map(g => [g.id, g]));
    // Margin around the room for doors that open outwards
    const m = doorMargins(room);
    canvas.style.setProperty('--u', `${seatUnit}px`);
    canvas.style.width = `${(room.width + m.left + m.right) * seatUnit}px`;
    canvas.style.height = `${(room.height + m.top + m.bottom) * seatUnit}px`;
    canvas.classList.toggle('is-compact', seatUnit < 48);

    const html = [];
    for (const group of room.groups) {
        const shape = shapes.get(group.id);
        if (!shape) continue;
        const selected = selectedGroups.has(group.id) ? ' is-selected' : '';
        const box = `left:${group.x * seatUnit}px;top:${group.y * seatUnit}px;width:${shape.w * seatUnit}px;height:${shape.h * seatUnit}px`;
        if (group.type === 'area') {
            html.push(`<div class="room-group group-area${selected}" data-group="${group.id}" style="${box}"><span>${escapeHtml(group.label)}</span></div>`);
            continue;
        }
        const cells = shape.cells.map(cell => {
            const pos = `left:${cell.dx * seatUnit}px;top:${cell.dy * seatUnit}px`;
            if (cell.kind === 'table') return `<div class="cell cell-table" style="${pos}">${chairSvg(chairTables(cell, shape))}</div>`;
            const number = numbers.get(cell.key);
            const person = people.get(room.seats[cell.key]);
            const match = query && (number.toLowerCase() === query || (person && attendeeMatches(person, query)));
            const classes = ['cell', 'cell-seat', person ? 'is-taken' : 'is-free'];
            if (duplicates.has(number.toLowerCase())) classes.push('is-duplicate');
            if (query) classes.push(match ? 'is-match' : 'is-dimmed');
            // On the table only the nickname; number, clan and name are in the tooltip.
            // While designing the room the number is what matters.
            const content = seatMode === 'layout'
                ? `<span class="seat-no">${escapeHtml(number)}</span>`
                : person ? `<span class="seat-name">${escapeHtml(person.nickname)}</span>` : '';
            return `<div class="${classes.join(' ')}" style="${pos}" data-key="${cell.key}" aria-label="${escapeHtml(seatTooltipText(room, cell.key))}">${content}</div>`;
        }).join('');
        html.push(`<div class="room-group${selected}" data-group="${group.id}" style="${box}">${cells}</div>`);
    }
    for (const [x, y] of room.layout.overlaps) {
        html.push(`<div class="cell-overlap" style="left:${x * seatUnit}px;top:${y * seatUnit}px" title="Überlappung"></div>`);
    }
    if (placeAt && seatMode === 'layout') {
        html.push(`<div class="place-marker" style="left:${placeAt.x * seatUnit}px;top:${placeAt.y * seatUnit}px" title="Hier wird der nächste Baustein eingefügt"></div>`);
    }
    if (room.groups.length === 0) {
        html.push(`<p class="canvas-empty">${canEdit() ? 'Leerer Raum — unter „Raum gestalten“ Tischreihen, U-Formen, Flächen oder Türen hinzufügen.' : 'Für diesen Raum gibt es noch keinen Plan.'}</p>`);
    }
    canvas.innerHTML = `<div class="room-floor" id="roomFloor" style="left:${m.left * seatUnit}px;top:${m.top * seatUnit}px;width:${room.width * seatUnit}px;height:${room.height * seatUnit}px">${html.join('')}</div>${renderDoors(room)}`;
}

/* Tooltip for tables and chairs
   ========================================================================== */

function seatTooltipText(room, key) {
    const person = attendeeMap().get(room.seats[key]);
    const place = `Platz ${seatNumber(room, key)}`;
    return person ? `${place}: ${person.display_name}${fullName(person) ? ` (${fullName(person)})` : ''}` : `${place}: frei`;
}

function showSeatTooltip(target) {
    const room = currentRoom();
    const key = target.dataset.key;
    if (!room || !key) return;
    const person = attendeeMap().get(room.seats[key]);
    const tip = document.getElementById('seatTooltip');
    const roomName = seatRooms.length > 1 ? ` · ${escapeHtml(room.name)}${room.alternative ? ' (Alternative)' : ''}` : '';
    tip.innerHTML = `<span class="tip-place">Platz ${escapeHtml(seatNumber(room, key))}${roomName}</span>`
        + (person
            ? `<strong class="tip-name">${escapeHtml(person.display_name)}</strong>${fullName(person) ? `<span class="tip-sub">${escapeHtml(fullName(person))}</span>` : ''}`
            : '<span class="tip-sub">frei</span>');
    // Above the table (below it if there is no room at the top of the window)
    const tableEl = document.querySelector(`#roomCanvas .cell-seat[data-key="${CSS.escape(key)}"]`) || target;
    const box = tableEl.getBoundingClientRect();
    tip.hidden = false;
    const tipBox = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - tipBox.width - 8, box.left + box.width / 2 - tipBox.width / 2));
    const above = box.top - tipBox.height - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${above > 70 ? above : box.bottom + 8}px`;
}

function hideSeatTooltip() {
    document.getElementById('seatTooltip').hidden = true;
}

// Search results across all rooms; a click jumps to the seat
function renderSeatResults() {
    const box = document.getElementById('seatResults');
    const query = searchQuery();
    if (!query) {
        box.innerHTML = '';
        return;
    }
    const people = attendeeMap();
    const results = seatAttendees.filter(a => attendeeMatches(a, query))
        .map(a => ({ label: a.display_name, sub: fullName(a), seat: seatOfAttendee(a.id) }));
    // Seat numbers (exact, ignoring case), in every room
    for (const room of seatRooms) {
        for (const seat of room.layout.seats.filter(s => s.label.toLowerCase() === query)) {
            const person = people.get(room.seats[seat.key]);
            if (!person || !results.some(r => r.label === person.display_name)) {
                results.push({ label: person ? person.display_name : 'frei', sub: '', seat: { room, key: seat.key, number: seat.label } });
            }
        }
    }
    const place = seat => `${seatRooms.length > 1 ? `${escapeHtml(seat.room.name)} · ` : ''}Platz ${escapeHtml(seat.number)}`;
    box.innerHTML = results.length === 0
        ? '<p class="field-hint">Niemand gefunden.</p>'
        : results.slice(0, 12).map(r => r.seat
            ? `<button type="button" class="seat-result" data-room="${r.seat.room.id}" data-key="${r.seat.key}" onclick="jumpToSeat(this.dataset.room, this.dataset.key)">
                <strong>${escapeHtml(r.label)}</strong>${r.sub ? ` <span class="muted">${escapeHtml(r.sub)}</span>` : ''}
                <span class="seat-result-place">${place(r.seat)}</span></button>`
            : `<span class="seat-result is-unseated"><strong>${escapeHtml(r.label)}</strong>${r.sub ? ` <span class="muted">${escapeHtml(r.sub)}</span>` : ''}
                <span class="seat-result-place">noch kein Platz</span></span>`).join('')
          + (results.length > 12 ? `<span class="field-hint">… und ${results.length - 12} weitere</span>` : '');
}

function jumpToSeat(roomId, key) {
    if (Number(roomId) !== currentRoomId) selectRoom(roomId);
    const cell = document.querySelector(`#roomCanvas .cell-seat[data-key="${CSS.escape(key)}"]`);
    if (!cell) return;
    cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    cell.classList.remove('is-flash');
    void cell.offsetWidth; // restart the animation
    cell.classList.add('is-flash');
}

function renderUnseated() {
    const seated = seatedIds();
    const query = searchQuery();
    const list = seatAttendees
        .filter(a => !seated.has(a.id))
        .sort((a, b) => a.display_name.localeCompare(b.display_name, 'de', { sensitivity: 'base' }));
    document.getElementById('unseatedCount').textContent = list.length;
    const shown = query ? list.filter(a => attendeeMatches(a, query)) : list;
    document.getElementById('unseatedList').innerHTML = list.length === 0
        ? '<p class="field-hint">Alle Teilnehmer haben einen Platz.</p>'
        : shown.map(a => `<button type="button" class="unseated-item${a.id === seatPick ? ' active' : ''}" data-id="${a.id}" onclick="pickAttendee(this.dataset.id)">
            <strong>${escapeHtml(a.display_name)}</strong>${fullName(a) ? `<span class="muted">${escapeHtml(fullName(a))}</span>` : ''}</button>`).join('')
          || '<p class="field-hint">Keine Treffer.</p>';
}

function pickAttendee(id) {
    seatPick = seatPick === Number(id) ? null : Number(id);
    renderUnseated();
    document.getElementById('roomCanvas').classList.toggle('is-picking', seatPick !== null);
}

// Largest step (at most the default) at which the room fits the visible width
function fitZoom(room) {
    const available = document.getElementById('seatGridWrap').clientWidth - 26;
    if (available <= 0) return seatUnit;
    const m = doorMargins(room);
    return [...ZOOM_STEPS].reverse().find(u => u <= 64 && u * (room.width + m.left + m.right) <= available) ?? ZOOM_STEPS[0];
}

// direction 0 = fit to width (and keep fitting), ±1 = one step smaller/larger (remembered)
function zoomSeating(direction) {
    seatZoomAuto = direction === 0;
    if (!seatZoomAuto) {
        const index = ZOOM_STEPS.indexOf(seatUnit);
        seatUnit = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (index < 0 ? 4 : index) + direction))];
    }
    try {
        if (seatZoomAuto) localStorage.removeItem('mcd.seatZoom');
        else localStorage.setItem('mcd.seatZoom', String(seatUnit));
    } catch { /* storage unavailable */ }
    renderSeating();
}

function setSeatMode(mode) {
    seatMode = mode;
    seatPick = null;
    clearSelection();
    document.getElementById('roomCanvas').classList.remove('is-picking');
    renderSeating();
}

/* Room editor: templates
   ========================================================================== */

function setTemplate(name) {
    seatTemplate = name;
    renderTemplateParams();
}

function paramInput(param, idPrefix) {
    const id = `${idPrefix}-${param.name}`;
    const field = param.type === 'select'
        ? `<select id="${id}" class="select-sm">${param.options.map(([v, l]) => `<option value="${v}"${v === param.value ? ' selected' : ''}>${l}</option>`).join('')}</select>`
        : `<input id="${id}" type="${param.type}" value="${escapeHtml(String(param.value))}"${param.min !== undefined ? ` min="${param.min}" max="${param.max}"` : ' maxlength="40"'}${param.placeholder ? ` placeholder="${param.placeholder}"` : ''}>`;
    return `<label class="param" for="${id}"><span>${param.label}</span>${field}</label>`;
}

function renderTemplateParams() {
    document.querySelectorAll('.template-bar .segmented button').forEach(b => b.classList.toggle('active', b.dataset.template === seatTemplate));
    document.getElementById('templateParams').innerHTML = TEMPLATE_PARAMS[seatTemplate].map(p => paramInput(p, 'tpl')).join('');
    renderPlaceTarget();
}

function renderPlaceTarget() {
    document.getElementById('placeTarget').innerHTML = placeAt
        ? `Ziel: Feld ${placeAt.x + 1} / ${placeAt.y + 1} <button type="button" class="link-button" onclick="clearPlaceAt()">aufheben</button>`
        : 'Ziel: erster freier Platz — oder vorher auf eine freie Stelle im Raum klicken';
}

function clearPlaceAt() {
    placeAt = null;
    renderPlaceTarget();
    renderSeating();
}

async function addTemplate() {
    const params = {};
    for (const p of TEMPLATE_PARAMS[seatTemplate]) {
        const value = document.getElementById(`tpl-${p.name}`).value;
        params[p.name] = p.type === 'number' ? Number(value) : value;
        p.value = params[p.name]; // remember for the next one
    }
    const before = new Set([...currentRoom().groups.map(g => g.id), ...currentRoom().doors.map(d => d.id)]);
    try {
        const updated = await apiFetch(`/rooms/${currentRoomId}/templates`, {
            method: 'POST', body: JSON.stringify({ template: seatTemplate, params, at: placeAt })
        });
        placeAt = null;
        renderPlaceTarget();
        replaceRoom(updated);
        selectedGroups = new Set(updated.groups.filter(g => !before.has(g.id)).map(g => g.id));
        selectedDoors = new Set(updated.doors.filter(d => !before.has(d.id)).map(d => d.id));
        renderSeating();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

/* Room editor: selection, moving, rotating
   ========================================================================== */

const NUMBERING_OPTIONS = [['forward', '→ der Reihe nach'], ['backward', '← rückwärts'], ['around', '↻ rundherum'], ['around-back', '↺ rundherum rückwärts']];
const WALL_OPTIONS = [['top', 'oben'], ['right', 'rechts'], ['bottom', 'unten'], ['left', 'links']];
const REVERSED_NUMBERING = { forward: 'backward', backward: 'forward', around: 'around-back', 'around-back': 'around' };

function selectedList(room = currentRoom()) {
    return room ? room.groups.filter(g => selectedGroups.has(g.id)) : [];
}

function selectedDoorList(room = currentRoom()) {
    return room ? room.doors.filter(d => selectedDoors.has(d.id)) : [];
}

function clearSelection() {
    selectedGroups.clear();
    selectedDoors.clear();
}

function renderSelectionBar() {
    const bar = document.getElementById('selectionBar');
    const room = currentRoom();
    const list = selectedList(room);
    const doors = selectedDoorList(room);
    if (list.length === 0 && doors.length === 0) {
        bar.innerHTML = `<span class="field-hint">Nichts markiert.</span>
            <button type="button" class="btn btn-ghost btn-sm" onclick="sortGroups()" title="Gruppen von oben links nach unten rechts sortieren und die Plätze neu nummerieren">Nach Position nummerieren</button>`;
        return;
    }
    if (list.length === 0 && doors.length === 1) {
        const d = doors[0];
        const vertical = d.side === 'left' || d.side === 'right';
        bar.innerHTML = `<strong class="selection-name">Tür<span class="muted">${d.swing === 'out' ? 'öffnet nach außen' : 'öffnet nach innen'}</span></strong>
            ${paramInput({ name: 'side', label: 'Wand', type: 'select', value: d.side, options: WALL_OPTIONS }, 'sel')}
            ${paramInput({ name: 'width', label: 'Breite', type: 'number', value: d.width, min: 1, max: 6 }, 'sel')}
            ${paramInput({ name: 'swing', label: 'Öffnet nach', type: 'select', value: d.swing, options: [['in', 'innen'], ['out', 'außen']] }, 'sel')}
            ${paramInput({ name: 'hinge', label: 'Anschlag', type: 'select', value: d.hinge, options: [['start', vertical ? 'oben' : 'links'], ['end', vertical ? 'unten' : 'rechts']] }, 'sel')}
            <button type="button" class="btn btn-secondary btn-sm" onclick="applyDoorFields()">Übernehmen</button>
            <span class="selection-actions">
                <button type="button" class="btn btn-danger btn-sm" onclick="deleteSelection()" title="Löschen (Entf)"><svg class="icon"><use href="#i-trash"/></svg><span>Löschen</span></button>
            </span>`;
        return;
    }

    const seats = room.layout.seats.filter(s => selectedGroups.has(s.group));
    const range = seats.length ? ` · Platz ${escapeHtml(seats[0].label)}${seats.length > 1 ? `–${escapeHtml(seats.at(-1).label)}` : ''}` : '';
    let fields = '';
    if (list.length === 1 && doors.length === 0) {
        const g = list[0];
        fields = g.type === 'row'
            ? paramInput({ name: 'length', label: 'Tische', type: 'number', value: g.length, min: 1, max: 60 }, 'sel')
              + paramInput({ name: 'sides', label: 'Tische an', type: 'select', value: g.sides, options: [['both', 'beiden Seiten'], ['one', 'einer Seite'], ['none', 'keiner Seite']] }, 'sel')
              + paramInput({ name: 'numbering', label: 'Nummern', type: 'select', value: g.numbering ?? 'forward', options: NUMBERING_OPTIONS }, 'sel')
              + paramInput({ name: 'start_label', label: 'Start-Nr.', type: 'text', value: g.start_label ?? '', placeholder: 'auto' }, 'sel')
            : paramInput({ name: 'label', label: 'Beschriftung', type: 'text', value: g.label }, 'sel')
              + paramInput({ name: 'width', label: 'Breite', type: 'number', value: g.width, min: 1, max: 80 }, 'sel')
              + paramInput({ name: 'height', label: 'Tiefe', type: 'number', value: g.height, min: 1, max: 80 }, 'sel');
    }
    const parts = [];
    if (list.length) parts.push(list.length === 1 ? (list[0].type === 'row' ? 'Tischreihe' : 'Fläche') : `${list.length} Gruppen`);
    if (doors.length) parts.push(doors.length === 1 ? '1 Tür' : `${doors.length} Türen`);
    const hasRows = list.some(g => g.type === 'row');
    bar.innerHTML = `<strong class="selection-name">${parts.join(' + ')}<span class="muted">${range}</span></strong>
        ${fields}
        ${fields ? '<button type="button" class="btn btn-secondary btn-sm" onclick="applySelectionFields()">Übernehmen</button>' : ''}
        <span class="selection-actions">
            ${list.length ? '<button type="button" class="btn btn-ghost btn-sm" onclick="rotateSelection()" title="90° im Uhrzeigersinn drehen (R)"><svg class="icon"><use href="#i-refresh"/></svg><span>Drehen</span></button>' : ''}
            ${list.length ? '<button type="button" class="btn btn-ghost btn-sm" onclick="duplicateSelection()" title="Duplizieren"><svg class="icon"><use href="#i-copy"/></svg><span>Duplizieren</span></button>' : ''}
            ${hasRows ? '<button type="button" class="btn btn-ghost btn-sm" onclick="reverseNumbering()" title="Nummern innerhalb der markierten Reihen umdrehen">Nummern ⇄</button>' : ''}
            ${list.length ? '<button type="button" class="btn btn-ghost btn-sm" onclick="moveSelectionInOrder(-1)" title="Diese Gruppen früher nummerieren">Nr. ↑</button>' : ''}
            ${list.length ? '<button type="button" class="btn btn-ghost btn-sm" onclick="moveSelectionInOrder(1)" title="Diese Gruppen später nummerieren">Nr. ↓</button>' : ''}
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteSelection()" title="Löschen (Entf)"><svg class="icon"><use href="#i-trash"/></svg><span>Löschen</span></button>
        </span>`;
}

// Runs an edit after the previous ones are saved, so quick clicks never work on a stale layout
function queueEdit(fn) {
    editQueue = editQueue.then(fn).catch(error => console.error(error));
    return editQueue;
}

// Sends groups and/or doors; the server answers with the new layout
async function saveLayout(changes) {
    clearTimeout(moveSaveTimer);
    try {
        replaceRoom(await apiFetch(`/rooms/${currentRoomId}`, { method: 'PUT', body: JSON.stringify(changes) }));
    } catch (error) {
        alert('❌ ' + error.message);
        await loadSeating();
        return;
    }
    renderSeating();
}

const saveGroups = groups => saveLayout({ groups });

function applySelectionFields() {
    queueEdit(() => {
        const room = currentRoom();
        const [selected] = selectedList(room);
        if (!selected) return;
        const value = name => document.getElementById(`sel-${name}`).value;
        const updated = selected.type === 'row'
            ? { ...selected, length: Number(value('length')), sides: value('sides'), numbering: value('numbering'), start_label: value('start_label').trim() || undefined }
            : { ...selected, label: value('label'), width: Number(value('width')), height: Number(value('height')) };
        return saveGroups(room.groups.map(g => (g.id === selected.id ? updated : g)));
    });
}

function applyDoorFields() {
    queueEdit(() => {
        const room = currentRoom();
        const [door] = selectedDoorList(room);
        if (!door) return;
        const value = name => document.getElementById(`sel-${name}`).value;
        const side = value('side');
        const width = Number(value('width'));
        const wall = side === 'top' || side === 'bottom' ? room.width : room.height;
        const updated = { ...door, side, width, swing: value('swing'), hinge: value('hinge'), offset: Math.max(0, Math.min(door.offset, wall - width)) };
        return saveLayout({ doors: room.doors.map(d => (d.id === door.id ? updated : d)) });
    });
}

function reverseNumbering() {
    queueEdit(() => {
        const room = currentRoom();
        return saveGroups(room.groups.map(g => (selectedGroups.has(g.id) && g.type === 'row'
            ? { ...g, numbering: REVERSED_NUMBERING[g.numbering ?? 'forward'] } : g)));
    });
}

// Moves the selection by whole cells, kept inside the room; doors only slide along their wall.
// Saved after a short pause (arrow keys) or right away (drag).
function moveSelection(dx, dy, saveNow) {
    const room = currentRoom();
    const list = selectedList(room);
    const doors = selectedDoorList(room);
    if (list.length === 0 && doors.length === 0) return;
    if (list.length) {
        const boxes = list.map(g => ({ g, ...groupSize(room, g.id) }));
        const minX = Math.min(...boxes.map(b => b.g.x)), minY = Math.min(...boxes.map(b => b.g.y));
        const maxX = Math.max(...boxes.map(b => b.g.x + b.w)), maxY = Math.max(...boxes.map(b => b.g.y + b.h));
        dx = Math.max(-minX, Math.min(room.width - maxX, dx));
        dy = Math.max(-minY, Math.min(room.height - maxY, dy));
        room.groups = room.groups.map(g => (selectedGroups.has(g.id) ? { ...g, x: g.x + dx, y: g.y + dy } : g));
    }
    room.doors = room.doors.map(d => {
        if (!selectedDoors.has(d.id)) return d;
        const vertical = d.side === 'left' || d.side === 'right';
        const wall = vertical ? room.height : room.width;
        return { ...d, offset: Math.max(0, Math.min(wall - d.width, d.offset + (vertical ? dy : dx))) };
    });
    renderCanvas(room);
    const save = () => queueEdit(() => saveLayout({ groups: currentRoom().groups, doors: currentRoom().doors }));
    clearTimeout(moveSaveTimer);
    if (saveNow) save();
    else moveSaveTimer = setTimeout(save, 500);
}

// Rotates the selected groups as a whole by 90° clockwise around their bounding box
function rotateSelection() {
    queueEdit(rotateSelectionNow);
}

function rotateSelectionNow() {
    const room = currentRoom();
    const list = selectedList(room);
    if (list.length === 0) return;
    const boxes = list.map(g => ({ g, ...groupSize(room, g.id) }));
    const minX = Math.min(...boxes.map(b => b.g.x)), minY = Math.min(...boxes.map(b => b.g.y));
    const height = Math.max(...boxes.map(b => b.g.y + b.h)) - minY;
    const rotated = new Map(boxes.map(({ g, w, h }) => {
        const x = minX + (height - (g.y - minY) - h);
        const y = minY + (g.x - minX);
        const turned = g.type === 'row'
            ? { ...g, rotation: (g.rotation + 90) % 360 }
            : { ...g, width: g.height, height: g.width };
        return [g.id, { ...turned, x, y, w: h, h: w }];
    }));
    // Keep the rotated selection inside the room
    const all = [...rotated.values()];
    const shiftX = Math.min(0, room.width - Math.max(...all.map(g => g.x + g.w)));
    const shiftY = Math.min(0, room.height - Math.max(...all.map(g => g.y + g.h)));
    return saveGroups(room.groups.map(g => {
        const r = rotated.get(g.id);
        if (!r) return g;
        const { w, h, ...group } = r;
        return { ...group, x: Math.max(0, group.x + shiftX), y: Math.max(0, group.y + shiftY) };
    }));
}

function nextIds(groups, count) {
    const max = groups.reduce((m, g) => Math.max(m, Number(g.id.slice(1))), 0);
    return Array.from({ length: count }, (_, i) => `g${max + 1 + i}`);
}

// Offset for copies of the selection: the free position (copies' boxes touch nothing) closest to it;
// falls back to the same place (then shown as overlap) if the room is full
function freeOffset(room, boxes) {
    const minX = Math.min(...boxes.map(b => b.g.x)), minY = Math.min(...boxes.map(b => b.g.y));
    const w = Math.max(...boxes.map(b => b.g.x + b.w)) - minX, h = Math.max(...boxes.map(b => b.g.y + b.h)) - minY;
    const others = room.groups.map(g => ({ g, ...groupSize(room, g.id) }));
    const touches = (a, ax, ay, b) => ax < b.g.x + b.w && ax + a.w > b.g.x && ay < b.g.y + b.h && ay + a.h > b.g.y;
    let best = null;
    for (let y = 0; y + h <= room.height; y++) {
        for (let x = 0; x + w <= room.width; x++) {
            const dx = x - minX, dy = y - minY;
            if (dx === 0 && dy === 0) continue;
            const free = boxes.every(a => others.every(b => !touches(a, a.g.x + dx, a.g.y + dy, b)));
            const distance = Math.abs(dx) + Math.abs(dy);
            if (free && (!best || distance < best.distance)) best = { dx, dy, distance };
        }
    }
    return best ?? { dx: 0, dy: 0 };
}

// Copies at the nearest free spot, selected afterwards
function duplicateSelection() {
    queueEdit(() => {
        const room = currentRoom();
        const list = selectedList(room);
        if (list.length === 0) return;
        const { dx, dy } = freeOffset(room, list.map(g => ({ g, ...groupSize(room, g.id) })));
        const ids = nextIds(room.groups, list.length);
        const copies = list.map((g, i) => ({ ...g, id: ids[i], x: g.x + dx, y: g.y + dy }));
        selectedGroups = new Set(ids);
        selectedDoors.clear();
        return saveGroups([...room.groups, ...copies]);
    });
}

function deleteSelection() {
    const room = currentRoom();
    if (selectedGroups.size === 0 && selectedDoors.size === 0) return;
    const taken = room.layout.seats.filter(s => selectedGroups.has(s.group) && room.seats[s.key] !== undefined).length;
    if (taken > 0 && !confirm(`${taken} vergebene Plätze werden frei. Trotzdem löschen?`)) return;
    const groupIds = new Set(selectedGroups), doorIds = new Set(selectedDoors);
    clearSelection();
    queueEdit(() => saveLayout({
        groups: currentRoom().groups.filter(g => !groupIds.has(g.id)),
        doors: currentRoom().doors.filter(d => !doorIds.has(d.id)),
    }));
}

// Earlier/later in the group list = lower/higher seat numbers
function moveSelectionInOrder(direction) {
    queueEdit(() => {
        const groups = [...currentRoom().groups];
        const indices = groups.map((g, i) => (selectedGroups.has(g.id) ? i : -1)).filter(i => i >= 0);
        if (indices.length === 0) return;
        for (const i of direction < 0 ? indices : [...indices].reverse()) {
            const j = i + direction;
            if (j < 0 || j >= groups.length || selectedGroups.has(groups[j].id)) continue;
            [groups[i], groups[j]] = [groups[j], groups[i]];
        }
        return saveGroups(groups);
    });
}

async function sortGroups() {
    try {
        replaceRoom(await apiFetch(`/rooms/${currentRoomId}/sort`, { method: 'POST', body: '{}' }));
        renderSeating();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

/* Pointer: seat clicks (assign), dragging groups/doors and rubber-band selection (layout)
   ========================================================================== */

// Position in room cells relative to the floor (the margin for doors lies outside 0…width)
function floorPoint(e) {
    const box = document.getElementById('roomFloor').getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
}

function onCanvasPointerDown(e) {
    const room = currentRoom();
    hideSeatTooltip();
    if (!room || e.button > 0) return;
    if (!canEdit()) {
        const target = e.target.closest('.cell-seat, .chair');
        if (target) showSeatTooltip(target);
        return;
    }

    if (seatMode === 'assign') {
        const seat = e.target.closest('.cell-seat');
        if (!seat) return;
        if (seatPick !== null) assignSeat(seat.dataset.key, seatPick);
        else openSeatModal(seat.dataset.key);
        return;
    }

    e.preventDefault();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const doorEl = e.target.closest('.room-door');
    const groupEl = doorEl ? null : e.target.closest('.room-group');
    const target = doorEl ? { set: selectedDoors, id: doorEl.dataset.door } : groupEl ? { set: selectedGroups, id: groupEl.dataset.group } : null;
    if (target) {
        if (additive) {
            if (target.set.has(target.id)) target.set.delete(target.id);
            else target.set.add(target.id);
            renderSeating();
            return;
        }
        if (!target.set.has(target.id)) {
            clearSelection();
            target.set.add(target.id);
            renderSeating();
        }
        pointerAction = { type: 'drag', startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 };
        return;
    }
    if (!additive) clearSelection();
    const p = floorPoint(e);
    pointerAction = { type: 'select', x0: p.x, y0: p.y, additive: new Set(selectedGroups), moved: false };
    renderSeating();
}

function onPointerMove(e) {
    if (!pointerAction) return;
    const canvas = document.getElementById('roomCanvas');
    if (pointerAction.type === 'drag') {
        const dx = Math.round((e.clientX - pointerAction.startX) / seatUnit);
        const dy = Math.round((e.clientY - pointerAction.startY) / seatUnit);
        if (dx === pointerAction.dx && dy === pointerAction.dy) return;
        pointerAction.dx = dx;
        pointerAction.dy = dy;
        canvas.querySelectorAll('.room-group.is-selected').forEach(el => {
            el.style.transform = `translate(${dx * seatUnit}px, ${dy * seatUnit}px)`;
        });
        canvas.querySelectorAll('.room-door.is-selected').forEach(el => {
            el.setAttribute('transform', `translate(${dx} ${dy})`);
        });
        return;
    }
    const { x: x1, y: y1 } = floorPoint(e);
    if (!pointerAction.moved && Math.abs(x1 - pointerAction.x0) + Math.abs(y1 - pointerAction.y0) < 6) return;
    pointerAction.moved = true;
    const floor = document.getElementById('roomFloor');
    const rect = { left: Math.min(pointerAction.x0, x1), top: Math.min(pointerAction.y0, y1), right: Math.max(pointerAction.x0, x1), bottom: Math.max(pointerAction.y0, y1) };
    let band = floor.querySelector('.select-band');
    if (!band) {
        band = document.createElement('div');
        band.className = 'select-band';
        floor.appendChild(band);
    }
    Object.assign(band.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
    const room = currentRoom();
    selectedGroups = new Set(pointerAction.additive);
    for (const g of room.groups) {
        const { w, h } = groupSize(room, g.id);
        const gx = g.x * seatUnit, gy = g.y * seatUnit;
        if (gx < rect.right && gx + w * seatUnit > rect.left && gy < rect.bottom && gy + h * seatUnit > rect.top) selectedGroups.add(g.id);
    }
    canvas.querySelectorAll('.room-group').forEach(el => el.classList.toggle('is-selected', selectedGroups.has(el.dataset.group)));
}

function onPointerUp() {
    if (!pointerAction) return;
    const action = pointerAction;
    pointerAction = null;
    if (action.type === 'drag') {
        if (action.dx !== 0 || action.dy !== 0) moveSelection(action.dx, action.dy, true);
        else renderSeating();
        return;
    }
    // A plain click on the empty floor (or the margin next to a wall) marks where the next block goes
    if (!action.moved) {
        const room = currentRoom();
        const x = Math.floor(action.x0 / seatUnit), y = Math.floor(action.y0 / seatUnit);
        placeAt = room ? { x: Math.max(0, Math.min(room.width - 1, x)), y: Math.max(0, Math.min(room.height - 1, y)) } : null;
        renderPlaceTarget();
    }
    renderSeating();
}

function onLayoutKey(e) {
    if (seatMode !== 'layout' || (selectedGroups.size === 0 && selectedDoors.size === 0) || !document.getElementById('view-seating').offsetParent) return;
    if (e.target.closest('input, textarea, select') || document.querySelector('.modal.show')) return;
    const step = e.shiftKey ? 5 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
        e.preventDefault();
        moveSelection(...moves[e.key], false);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
    } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        rotateSelection();
    } else if (e.key === 'Escape') {
        clearSelection();
        renderSeating();
    }
}

/* Seat assignment
   ========================================================================== */

function openSeatModal(key) {
    const room = currentRoom();
    seatModalKey = key;
    const number = seatNumber(room, key);
    const person = attendeeMap().get(room.seats[key]);
    document.getElementById('seatModalTitle').textContent = `Platz ${number}${seatRooms.length > 1 ? ` · ${room.name}` : ''}`;
    document.getElementById('seatModalCurrent').innerHTML = person
        ? `Belegt von <strong>${escapeHtml(person.display_name)}</strong>${fullName(person) ? ` (${escapeHtml(fullName(person))})` : ''}`
        : 'Frei';
    document.getElementById('seatFreeBtn').disabled = !person;
    document.getElementById('seatModalSearch').value = '';
    renderSeatModalList();
    openModal('seatModal');
    document.getElementById('seatModalSearch').focus();
}

// Without a seat first, then everyone else (choosing them moves them here)
function renderSeatModalList() {
    const room = currentRoom();
    const query = document.getElementById('seatModalSearch').value.trim().toLowerCase();
    const current = room.seats[seatModalKey];
    const entries = seatAttendees
        .filter(a => a.id !== current && (!query || attendeeMatches(a, query)))
        .map(a => ({ a, seat: seatOfAttendee(a.id) }))
        .sort((x, y) => (!!x.seat - !!y.seat) || x.a.display_name.localeCompare(y.a.display_name, 'de', { sensitivity: 'base' }));
    document.getElementById('seatModalList').innerHTML = entries.length === 0
        ? '<p class="field-hint">Keine Treffer.</p>'
        : entries.map(({ a, seat }) => `<button type="button" class="unseated-item" data-id="${a.id}" onclick="assignSeat(seatModalKey, Number(this.dataset.id))">
            <strong>${escapeHtml(a.display_name)}</strong>
            <span class="muted">${escapeHtml(fullName(a))}${seat ? `${fullName(a) ? ' · ' : ''}sitzt auf ${seatRooms.length > 1 ? `${escapeHtml(seat.room.name)} ` : ''}Platz ${seat.number} — wird umgesetzt` : ''}</span></button>`).join('');
}

async function assignSeat(key, attendeeId) {
    try {
        seatRooms = await apiFetch(`/rooms/${currentRoomId}/seats/${encodeURIComponent(key)}`, {
            method: 'PUT', body: JSON.stringify({ attendee_id: attendeeId })
        });
        seatPick = null;
        document.getElementById('roomCanvas').classList.remove('is-picking');
        closeModal('seatModal');
        renderSeating();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function clearRoomSeats() {
    const room = currentRoom();
    const taken = Object.keys(room.seats).length;
    if (taken === 0) {
        alert('In diesem Raum ist kein Platz vergeben.');
        return;
    }
    if (!confirm(`Alle ${taken} vergebenen Plätze in „${room.name}“ freigeben?`)) return;
    try {
        seatRooms = await apiFetch(`/rooms/${room.id}/clear`, { method: 'POST', body: '{}' });
        renderSeating();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function autofillRoom() {
    try {
        const result = await apiFetch(`/rooms/${currentRoomId}/autofill`, { method: 'POST', body: '{}' });
        seatRooms = result.rooms;
        renderSeating();
        if (result.seated === 0) alert(result.remaining ? 'Keine freien Plätze in diesem Raum.' : 'Alle Teilnehmer haben schon einen Platz.');
        else if (result.remaining > 0) alert(`✅ ${result.seated} Teilnehmer gesetzt. ${result.remaining} haben noch keinen Platz — der Raum ist voll.`);
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

/* Rooms
   ========================================================================== */

function openRoomModal() {
    document.getElementById('newRoomName').value = seatRooms.length ? '' : 'Halle';
    openModal('roomModal');
    document.getElementById('newRoomName').focus();
}

async function createRoom(e) {
    e.preventDefault();
    try {
        const room = await apiFetch(`/events/${currentEventId}/rooms`, {
            method: 'POST',
            body: JSON.stringify({
                name: document.getElementById('newRoomName').value,
                width: Number(document.getElementById('newRoomWidth').value),
                height: Number(document.getElementById('newRoomHeight').value),
            })
        });
        closeModal('roomModal');
        currentRoomId = room.id;
        try { localStorage.setItem('mcd.seatRoom', String(room.id)); } catch { /* storage unavailable */ }
        await loadSeating();
        setSeatMode('layout');
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

// Name suggestion for the copy: free in the target event ("Halle", "Halle (Kopie)", "Halle (Kopie 2)" …)
async function suggestDuplicateName() {
    const room = currentRoom();
    if (!room) return;
    const eventId = Number(document.getElementById('duplicateRoomEvent').value);
    let names = seatRooms.map(r => r.name.toLowerCase());
    if (eventId !== currentEventId) {
        names = (await apiFetch(`/events/${eventId}/rooms`).catch(() => [])).map(r => r.name.toLowerCase());
    }
    let name = eventId !== currentEventId && !names.includes(room.name.toLowerCase()) ? room.name : `${room.name} (Kopie)`;
    for (let n = 2; names.includes(name.toLowerCase()); n++) name = `${room.name} (Kopie ${n})`;
    document.getElementById('duplicateRoomName').value = name.slice(0, 60);
}

async function openDuplicateRoomModal() {
    if (!currentRoom()) return;
    document.getElementById('duplicateRoomAlternative').checked = true;
    const select = document.getElementById('duplicateRoomEvent');
    select.innerHTML = [...lanEvents].reverse()
        .map(e => `<option value="${e.id}">${escapeHtml(e.name)}${e.id === currentEventId ? ' (dieses Event)' : ''}</option>`).join('');
    select.value = String(currentEventId);
    await suggestDuplicateName();
    openModal('duplicateRoomModal');
    document.getElementById('duplicateRoomName').select();
}

async function duplicateRoom(e) {
    e.preventDefault();
    const eventId = Number(document.getElementById('duplicateRoomEvent').value);
    try {
        const copy = await apiFetch(`/rooms/${currentRoomId}/duplicate`, {
            method: 'POST',
            body: JSON.stringify({
                name: document.getElementById('duplicateRoomName').value,
                event_id: eventId,
                alternative: document.getElementById('duplicateRoomAlternative').checked,
            }),
        });
        closeModal('duplicateRoomModal');
        // Show the copy, switching to the target event if needed
        try { localStorage.setItem('mcd.seatRoom', String(copy.id)); } catch { /* storage unavailable */ }
        if (eventId !== currentEventId) {
            currentEventId = eventId;
            try { localStorage.setItem('mcd.attendeeEvent', String(eventId)); } catch { /* storage unavailable */ }
            renderSeatEventSelect();
        }
        currentRoomId = copy.id;
        await loadSeating();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

function fillRoomSettings() {
    const room = currentRoom();
    document.getElementById('roomName').value = room ? room.name : '';
    document.getElementById('roomAlternative').checked = !!room?.alternative;
    document.getElementById('roomWidth').value = room ? room.width : '';
    document.getElementById('roomHeight').value = room ? room.height : '';
    if (!room) toggleSection('roomConfigSection', false);
}

async function saveRoomSettings(e) {
    e.preventDefault();
    const room = currentRoom();
    const alternative = document.getElementById('roomAlternative').checked;
    if (room.alternative && !alternative) {
        // This room becomes the final plan: its attendees leave the other final rooms
        const ids = new Set(Object.values(room.seats));
        const moved = seatRooms.filter(r => r.id !== room.id && !r.alternative)
            .reduce((n, r) => n + Object.values(r.seats).filter(id => ids.has(id)).length, 0);
        const question = moved > 0
            ? `„${room.name}“ wird zum finalen Plan. ${moved} Teilnehmer sitzen auch in einem anderen finalen Raum und werden dort freigegeben. Fortfahren?`
            : `„${room.name}“ wird zum finalen Plan. Fortfahren?`;
        if (!confirm(question)) return;
    }
    try {
        await apiFetch(`/rooms/${currentRoomId}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: document.getElementById('roomName').value,
                width: Number(document.getElementById('roomWidth').value),
                height: Number(document.getElementById('roomHeight').value),
                alternative,
            })
        });
        await loadSeating(); // other rooms may have changed too
        renderSeating();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function deleteRoom() {
    const room = currentRoom();
    if (!room) return;
    const taken = Object.keys(room.seats).length;
    if (!confirm(`Raum „${room.name}“${taken ? ` mit ${taken} vergebenen Plätzen` : ''} löschen?`)) return;
    try {
        await apiFetch(`/rooms/${room.id}`, { method: 'DELETE' });
        currentRoomId = null;
        await loadSeating();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}
