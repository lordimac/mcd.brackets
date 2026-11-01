// Timetable of an event (#zeitplan): own entries and notes (editable by admins) plus the
// tournament rounds, which come from the deadlines of the event's tournaments (src/timetable.ts).
// Shares currentEventId/ensureCurrentEvent with lan.js; uses apiFetch, escapeHtml, icon,
// openModal/closeModal, toLocalInput and isAdmin from app.js.

const TT_CATEGORIES = {
    meal: { label: 'Essen', className: 'tt-meal' },
    program: { label: 'Programm', className: 'tt-program' },
    tournament: { label: 'Turnier', className: 'tt-tournament' },
    other: { label: 'Sonstiges', className: 'tt-other' },
};

let ttData = { entries: [], notes: [], tournament_rounds: [] };

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('ttEntryForm').addEventListener('submit', saveTimetableEntry);
    document.getElementById('ttNoteForm').addEventListener('submit', saveTimetableNote);
});

async function showTimetableView() {
    await loadEvents();
    ensureCurrentEvent();
    const select = document.getElementById('ttEventSelect');
    const events = [...lanEvents].reverse();
    select.innerHTML = events.length
        ? events.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')
        : '<option value="">Noch kein Event — unter „Teilnehmer“ anlegen</option>';
    if (currentEventId != null) select.value = String(currentEventId);
    ttSelectedDay = null; // opening the timetable starts with today (or the first day)
    await loadTimetable();
}

async function selectTimetableEvent(id) {
    currentEventId = Number(id);
    try { localStorage.setItem('mcd.attendeeEvent', String(currentEventId)); } catch { /* storage unavailable */ }
    updateBrandLogo();
    ttSelectedDay = null;
    await loadTimetable();
}

async function loadTimetable() {
    ttData = currentEventId == null
        ? { entries: [], notes: [], tournament_rounds: [] }
        : await apiFetch(`/events/${currentEventId}/timetable`).catch(() => ({ entries: [], notes: [], tournament_rounds: [] }));
    renderTimetable();
}

/* Items in time order: own entries on each of their days at their start (local time),
   tournament rounds at their deadline */

function timetableItems(data = ttData) {
    const own = data.entries.flatMap(entry => entry.days.map(day => ({ kind: 'entry', at: joinLocal(day, entry.start), day, entry })));
    const rounds = data.tournament_rounds.map(item => ({ kind: 'rounds', at: item.at, item }));
    // At the same time a round closing comes first: it ends what was before, the entry starts anew
    return [...own, ...rounds].sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'rounds' ? -1 : 0) - (b.kind === 'rounds' ? -1 : 0));
}

// Items grouped by local day: [{ day: Date, items }]
function timetableDays(data = ttData) {
    const days = [];
    for (const item of timetableItems(data)) {
        const date = new Date(item.at);
        const key = date.toDateString();
        if (days.at(-1)?.key !== key) days.push({ key, day: date, items: [] });
        days.at(-1).items.push(item);
    }
    return days;
}

const ttTime = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const ttDay = date => date.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });

// "09:00", "18:00–19:30", "bis 21:00" (deadline) or "20:00" (start of a final)
function ttTimeRange(item) {
    if (item.kind === 'rounds') return item.item.kind === 'start' ? ttTime(item.item.at) : `bis ${ttTime(item.item.at)}`;
    const { start, end } = item.entry;
    return end ? `${start}–${end}` : start;
}

// When an item is over: its end (an end before the start is the next morning), else its start
function ttEndOf(item) {
    if (item.kind === 'rounds') return item.item.at;
    const { start, end } = item.entry;
    if (!end) return item.at;
    const date = new Date(`${item.day}T12:00`);
    if (end < start) date.setDate(date.getDate() + 1);
    return joinLocal(localDay(date), end);
}

const ttEvent = () => lanEvents.find(e => e.id === currentEventId);

/* Day view: one tab per day, the chosen day as a vertical time line (entries in order along one
   rail, a "Jetzt" mark between them on the current day); the clock above shows date and time */

let ttSelectedDay = null;
let ttClockTimer = null;
let ttClockMinute = '';

// Event days plus days that have items (an entry outside the period still shows up)
function timetableDayList(event, groups) {
    return [...new Set([...eventDays(event), ...groups.map(g => localDay(g.day))])].sort();
}

// Start with today; before (or after) the event with the first day
function defaultTimetableDay(days) {
    const today = localDay(new Date());
    return days.includes(today) ? today : days[0] ?? null;
}

function selectTimetableDay(day) {
    ttSelectedDay = day;
    renderTimetable();
    document.querySelector(`.tt-day-tab[data-day="${CSS.escape(day)}"]`)?.focus();
}

function renderTimetable() {
    const event = ttEvent();
    const period = eventDays(event);
    document.getElementById('ttPeriod').textContent = period.length
        ? `${formatEventDay(period[0])} bis ${formatEventDay(period.at(-1))}`
        : (isAdmin && event ? 'Tipp: Zeitraum des Events unter „Teilnehmer“ › Konfiguration festlegen' : '');
    const list = document.getElementById('ttList');
    const groups = timetableDays();
    const days = timetableDayList(event, groups);
    if (!days.includes(ttSelectedDay)) ttSelectedDay = defaultTimetableDay(days);
    startTimetableClock();
    if (currentEventId == null) {
        list.innerHTML = '<p class="empty-state">Noch kein Event — unter „Teilnehmer“ anlegen.</p>';
    } else if (days.length === 0) {
        list.innerHTML = `<p class="empty-state">Noch nichts geplant.${isAdmin ? ' Oben „Eintrag“ hinzufügen; Turnierrunden erscheinen, sobald sie Spielzeiten haben.' : ''}</p>`;
    } else {
        const today = localDay(new Date());
        const tabs = `<div class="tt-days" role="group" aria-label="Tag wählen">${days.map(day => {
            const date = new Date(`${day}T12:00`);
            return `<button type="button" class="tt-day-tab${day === ttSelectedDay ? ' is-active' : ''}${period.length && !period.includes(day) ? ' is-outside' : ''}" data-day="${day}" aria-pressed="${day === ttSelectedDay}" onclick="selectTimetableDay(this.dataset.day)">
                <span class="tt-day-name">${escapeHtml(date.toLocaleDateString('de-DE', { weekday: 'long' }))}</span>
                <span class="tt-day-date">${escapeHtml(date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }))}${day === today ? '<span class="tt-today">heute</span>' : ''}</span>
            </button>`;
        }).join('')}</div>`;
        const outside = period.length && !period.includes(ttSelectedDay)
            ? '<p class="tt-outside">Dieser Tag liegt außerhalb des Event-Zeitraums.</p>' : '';
        list.innerHTML = tabs + outside + timelineHtml(ttSelectedDay, groups.find(g => localDay(g.day) === ttSelectedDay)?.items ?? [], timetableNowNext(groups.flatMap(g => g.items), Date.now()));
        // On narrow screens the tabs scroll sideways: bring the chosen day into sight
        const tabsBox = list.querySelector('.tt-days');
        const active = tabsBox.querySelector('.is-active');
        if (active && tabsBox.scrollWidth > tabsBox.clientWidth) tabsBox.scrollLeft = active.offsetLeft - tabsBox.offsetLeft - 8;
    }

    // "Gut zu wissen" beside the time line; without notes the time line takes the whole width
    const notesCard = document.getElementById('ttNotesCard');
    notesCard.style.display = ttData.notes.length ? '' : 'none';
    document.getElementById('ttLayout').classList.toggle('has-notes', ttData.notes.length > 0);
    document.getElementById('ttNotes').innerHTML = ttData.notes.map(note => `
        <div class="tt-note">
            <div class="tt-note-body">
                ${note.title ? `<strong>${escapeHtml(note.title)}</strong>` : ''}
                <p>${escapeHtml(note.text)}</p>
            </div>
            <button class="btn btn-ghost btn-icon admin-only" data-id="${escapeHtml(note.id)}" onclick="openTimetableNoteModal(this.dataset.id)" title="Bearbeiten" aria-label="Bearbeiten">${icon('edit')}</button>
        </div>
    `).join('');
}

// Running now: started and not over yet; otherwise the first one still to come (on any day) is "next"
function timetableNowNext(all, now) {
    const running = new Set(all.filter(item => item.kind === 'entry' && Date.parse(item.at) <= now && Date.parse(ttEndOf(item)) > now));
    const next = running.size ? null : all.find(item => Date.parse(item.kind === 'rounds' ? item.item.at : item.at) > now);
    return { running, next };
}

const ttStartOf = item => (item.kind === 'rounds' ? item.item.at : item.at);

function timelineHtml(day, items, { running, next }) {
    if (!items.length) return '<p class="empty-state">An diesem Tag ist nichts geplant.</p>';
    const now = Date.now();
    const rows = items.map(item => {
        const category = item.kind === 'rounds' ? TT_CATEGORIES.tournament : TT_CATEGORIES[item.entry.category] ?? TT_CATEGORIES.other;
        const past = Date.parse(ttEndOf(item)) < now;
        const marker = running.has(item) ? '<span class="tt-now">läuft gerade</span>' : item === next ? '<span class="tt-now is-next">als Nächstes</span>' : '';
        const title = item.kind === 'rounds' ? item.item.title : item.entry.title;
        const info = item.kind === 'rounds'
            ? item.item.rounds.map(r => `${r.stage_name}: ${r.label}`).join(' · ')
            : item.entry.info;
        const repeat = item.kind === 'entry' && item.entry.days.length > 1
            ? `<span class="tt-repeat" title="${escapeHtml(item.entry.days.map(formatEventDay).join(', '))}">${item.entry.days.length} Tage</span>`
            : '';
        return `<li class="tt-item ${category.className}${past ? ' is-past' : ''}${running.has(item) ? ' is-now' : item === next ? ' is-next' : ''}">
            <span class="tt-time">${escapeHtml(ttTimeRange(item))}</span>
            <span class="tt-node" aria-hidden="true"></span>
            <div class="tt-body">
                <span class="tt-title">${escapeHtml(title)}${repeat}${marker}</span>
                ${info ? `<span class="tt-info">${escapeHtml(info)}</span>` : ''}
            </div>
            <span class="tt-category">${category.label}</span>
            ${item.kind === 'entry'
                ? `<button class="btn btn-ghost btn-icon admin-only" data-id="${escapeHtml(item.entry.id)}" onclick="openTimetableEntryModal(this.dataset.id)" title="Bearbeiten" aria-label="${escapeHtml(title)} bearbeiten">${icon('edit')}</button>`
                : `<span class="tt-auto admin-only" title="Kommt aus den Spielzeiten der Turniere" role="img" aria-label="Kommt aus den Spielzeiten der Turniere">${icon('clock')}</span>`}
        </li>`;
    });
    // On the current day the "Jetzt" mark stands after everything that has started already
    if (localDay(new Date(now)) === day) {
        const at = items.filter(item => Date.parse(ttStartOf(item)) <= now).length;
        const time = new Date(now).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        rows.splice(at, 0, `<li class="tt-now-mark">
            <span class="tt-time">${time}</span>
            <span class="tt-node" aria-hidden="true"></span>
            <span class="tt-now-label">Jetzt</span>
        </li>`);
    }
    return `<ol class="tt-stream">${rows.join('')}</ol>`;
}

/* Clock: date and time in the head of "Ablauf"; once a minute it also moves the "Jetzt" mark
   (not while something in the time line has the focus or a dialog is open) */

function startTimetableClock() {
    clearInterval(ttClockTimer);
    ttClockMinute = '';
    tickTimetableClock();
    ttClockTimer = setInterval(tickTimetableClock, 10000);
}

function tickTimetableClock() {
    if (document.body.dataset.view !== 'timetable') {
        clearInterval(ttClockTimer);
        return;
    }
    const now = new Date();
    const minute = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (minute === ttClockMinute) return;
    const first = ttClockMinute === '';
    ttClockMinute = minute;
    document.getElementById('ttClockDate').textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    document.getElementById('ttClockTime').textContent = minute;
    const busy = document.querySelector('.modal.show') || document.getElementById('ttList').contains(document.activeElement);
    if (!first && !busy) renderTimetable();
}

// The server always gets the whole timetable
async function storeTimetable(entries, notes) {
    ttData = await apiFetch(`/events/${currentEventId}/timetable`, { method: 'PUT', body: JSON.stringify({ entries, notes }) });
    renderTimetable();
}

/* Entries */

// Day picker: the event's days as checkboxes (plus days of the entry outside the period);
// without a period a single date field
function renderDayPicker(selected) {
    const days = [...new Set([...eventDays(ttEvent()), ...selected])].sort();
    const picker = document.getElementById('ttEntryDays');
    if (!eventDays(ttEvent()).length) {
        picker.innerHTML = `
            <input type="date" id="ttEntrySingleDay" value="${selected[0] ?? ''}">
            <p class="field-hint">Mit einem Zeitraum beim Event (Teilnehmer › Konfiguration) lassen sich hier mehrere Tage ankreuzen.</p>`;
        return;
    }
    picker.innerHTML = days.map(day => `
        <label class="day-chip">
            <input type="checkbox" value="${day}"${selected.includes(day) ? ' checked' : ''}>
            <span>${escapeHtml(formatEventDay(day))}</span>
        </label>
    `).join('') + '<button type="button" class="btn btn-ghost btn-sm" onclick="toggleAllDays()">alle</button>';
}

function toggleAllDays() {
    const boxes = [...document.querySelectorAll('#ttEntryDays input[type="checkbox"]')];
    const check = boxes.some(box => !box.checked);
    boxes.forEach(box => { box.checked = check; });
}

function selectedDays() {
    const single = document.getElementById('ttEntrySingleDay');
    if (single) return single.value ? [single.value] : [];
    return [...document.querySelectorAll('#ttEntryDays input[type="checkbox"]:checked')].map(box => box.value);
}

function openTimetableEntryModal(id) {
    if (currentEventId == null) return;
    const entry = ttData.entries.find(e => e.id === id);
    document.getElementById('ttEntryTitle').textContent = entry ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
    document.getElementById('ttEntryId').value = entry?.id ?? '';
    document.getElementById('ttEntryName').value = entry?.title ?? '';
    document.getElementById('ttEntryStart').value = entry?.start ?? '';
    document.getElementById('ttEntryEnd').value = entry?.end ?? '';
    document.getElementById('ttEntryCategory').value = entry?.category ?? 'meal';
    document.getElementById('ttEntryInfo').value = entry?.info ?? '';
    document.getElementById('ttEntryDelete').style.display = entry ? '' : 'none';
    renderDayPicker(entry?.days ?? []);
    openModal('ttEntryModal');
    document.getElementById('ttEntryName').focus();
}

async function saveTimetableEntry(e) {
    e.preventDefault();
    const id = document.getElementById('ttEntryId').value;
    const value = field => document.getElementById(field).value;
    const days = selectedDays();
    if (days.length === 0) {
        notify('Bitte mindestens einen Tag wählen.');
        return;
    }
    const entry = {
        id: id || undefined,
        title: value('ttEntryName'),
        days,
        start: value('ttEntryStart'),
        end: value('ttEntryEnd') || null,
        category: value('ttEntryCategory'),
        info: value('ttEntryInfo'),
    };
    const entries = id ? ttData.entries.map(existing => (existing.id === id ? entry : existing)) : [...ttData.entries, entry];
    try {
        await storeTimetable(entries, ttData.notes);
        closeModal('ttEntryModal');
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

async function deleteTimetableEntry() {
    const id = document.getElementById('ttEntryId').value;
    const entry = ttData.entries.find(e => e.id === id);
    if (!entry || !(await confirmDialog(`„${entry.title}“ aus dem Zeitplan löschen?`, { title: 'Eintrag löschen?' }))) return;
    try {
        await storeTimetable(ttData.entries.filter(e => e.id !== id), ttData.notes);
        closeModal('ttEntryModal');
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

/* Notes */

function openTimetableNoteModal(id) {
    if (currentEventId == null) return;
    const note = ttData.notes.find(n => n.id === id);
    document.getElementById('ttNoteHeading').textContent = note ? 'Hinweis bearbeiten' : 'Neuer Hinweis';
    document.getElementById('ttNoteId').value = note?.id ?? '';
    document.getElementById('ttNoteTitle').value = note?.title ?? '';
    document.getElementById('ttNoteText').value = note?.text ?? '';
    document.getElementById('ttNoteDelete').style.display = note ? '' : 'none';
    openModal('ttNoteModal');
    document.getElementById('ttNoteTitle').focus();
}

async function saveTimetableNote(e) {
    e.preventDefault();
    const id = document.getElementById('ttNoteId').value;
    const note = { id: id || undefined, title: document.getElementById('ttNoteTitle').value, text: document.getElementById('ttNoteText').value };
    const notes = id ? ttData.notes.map(existing => (existing.id === id ? note : existing)) : [...ttData.notes, note];
    try {
        await storeTimetable(ttData.entries, notes);
        closeModal('ttNoteModal');
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

async function deleteTimetableNote() {
    const id = document.getElementById('ttNoteId').value;
    if (!(await confirmDialog('Diesen Hinweis löschen?', { title: 'Hinweis löschen?' }))) return;
    try {
        await storeTimetable(ttData.entries, ttData.notes.filter(n => n.id !== id));
        closeModal('ttNoteModal');
    } catch (error) {
        notify('❌ ' + error.message);
    }
}
