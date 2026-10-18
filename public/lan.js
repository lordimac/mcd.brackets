// Attendee management: events with domain/IP ranges and their attendees.
// Uses apiFetch, escapeHtml, icon, openModal/closeModal and lanEvents from app.js.

const RANGE_LABELS = ['Haupt-PC', 'Zweiter PC', 'Dritter PC'];

let currentEventId = null;
let attendees = [];

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('eventSettingsForm').addEventListener('submit', saveEventSettings);
    document.getElementById('addAttendeeForm').addEventListener('submit', addAttendee);
    document.getElementById('editAttendeeForm').addEventListener('submit', saveAttendee);
    document.getElementById('newEventForm').addEventListener('submit', createLanEvent);
    document.getElementById('rangeInputs').addEventListener('input', updateCapacityHint);
    document.getElementById('bulkImportText').addEventListener('input', resetBulkPreview);
    document.querySelectorAll('#attendeeHead th.sortable').forEach(th => {
        th.addEventListener('click', () => sortAttendeesBy(th.dataset.sort));
    });
    for (const id of ['editClan', 'editNickname']) {
        document.getElementById(id).addEventListener('input', updateEditDisplayPreview);
    }
});

function currentEvent() {
    return lanEvents.find(e => e.id === currentEventId) || null;
}

// Called by showView() in app.js whenever the attendee tab opens
async function showAttendeeView() {
    await loadEvents();
    if (!lanEvents.some(e => e.id === currentEventId)) {
        let saved = null;
        try {
            const stored = localStorage.getItem('mcd.attendeeEvent');
            if (stored !== null) saved = Number(stored);
        } catch { /* storage unavailable */ }
        const fallback = lanEvents[lanEvents.length - 1];
        currentEventId = lanEvents.some(e => e.id === saved) ? saved : fallback ? fallback.id : null;
    }
    renderEventSelect();
    await loadAttendees();
}

async function selectLanEvent(id) {
    currentEventId = Number(id);
    try { localStorage.setItem('mcd.attendeeEvent', String(currentEventId)); } catch { /* storage unavailable */ }
    renderEventSelect();
    await loadAttendees();
}

function renderEventSelect() {
    const select = document.getElementById('lanEventSelect');
    const events = [...lanEvents].reverse();
    select.innerHTML = events.length
        ? events.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')
        : '<option value="">Noch kein Event — „Neu“ klicken</option>';
    if (currentEventId != null) select.value = String(currentEventId);

    const event = currentEvent();
    document.getElementById('eventSettingsForm').style.display = event ? '' : 'none';
    document.getElementById('addAttendeeForm').style.display = event ? '' : 'none';
    document.getElementById('exportActions').style.display = event ? '' : 'none';

    const sources = lanEvents.filter(e => e.id !== currentEventId && e.attendee_count > 0).reverse();
    document.getElementById('importCard').style.display = event && sources.length ? '' : 'none';
    document.getElementById('importSourceSelect').innerHTML = sources
        .map(e => `<option value="${e.id}">${escapeHtml(e.name)} (${e.attendee_count})</option>`).join('');

    if (event) fillEventSettings(event);
}

function fillEventSettings(event) {
    document.getElementById('eventSettingName').value = event.name;
    document.getElementById('eventSettingDomain').value = event.domain;
    document.getElementById('eventSettingDns').value = event.dns_server;
    document.getElementById('eventSettingNetmask').value = event.netmask ?? '';
    document.getElementById('eventSettingGateway').value = event.gateway ?? '';
    document.getElementById('eventSettingMemorial').value = (event.memorial ?? []).join('\n');
    document.getElementById('rangeInputs').innerHTML = event.ranges.map((range, i) => `
        <span class="range-label">${RANGE_LABELS[i]}</span>
        <input type="text" class="range-start" value="${escapeHtml(range.start)}" aria-label="${RANGE_LABELS[i]} Start" spellcheck="false">
        <span class="range-sep">–</span>
        <input type="text" class="range-end" value="${escapeHtml(range.end)}" aria-label="${RANGE_LABELS[i]} Ende" spellcheck="false">
    `).join('');
    updateCapacityHint();
    renderLogoPreview(event);

    for (const [id, format] of [['exportCsv', 'csv'], ['exportHosts', 'hosts'], ['exportZone', 'zone']]) {
        document.getElementById(id).href = `${API_URL}/events/${event.id}/export/${format}`;
    }
    const zoneLink = document.getElementById('exportZone');
    zoneLink.classList.toggle('is-disabled', !event.domain);
    zoneLink.title = event.domain ? 'BIND-Zonendatei herunterladen' : 'Für die BIND-Zone zuerst eine Domain eintragen';
}

/* IP helpers (mirror of src/lan.ts, for live feedback only) */

function parseIPv4(value) {
    const parts = value.trim().split('.');
    if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
    return parts.reduce((acc, p) => acc * 256 + Number(p), 0);
}

function readRanges() {
    const starts = document.querySelectorAll('#rangeInputs .range-start');
    const ends = document.querySelectorAll('#rangeInputs .range-end');
    return [...starts].map((start, i) => ({ start: start.value.trim(), end: ends[i].value.trim() }));
}

// Only warns about invalid ranges; capacity itself is not shown
function updateCapacityHint() {
    const valid = readRanges().every(r => {
        const start = parseIPv4(r.start), end = parseIPv4(r.end);
        return start !== null && end !== null && end >= start;
    });
    document.getElementById('capacityHint').textContent = valid ? '' : 'Ungültiger Bereich: Start und Ende müssen gültige IPs sein, Ende ≥ Start.';
}

/* Events */

async function saveEventSettings(e) {
    e.preventDefault();
    const event = currentEvent();
    if (!event) return;
    try {
        await apiFetch(`/events/${event.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: document.getElementById('eventSettingName').value,
                domain: document.getElementById('eventSettingDomain').value,
                dns_server: document.getElementById('eventSettingDns').value,
                netmask: document.getElementById('eventSettingNetmask').value,
                gateway: document.getElementById('eventSettingGateway').value,
                memorial: document.getElementById('eventSettingMemorial').value,
                ranges: readRanges()
            })
        });
        await loadEvents();
        renderEventSelect();
        await loadAttendees();
        await loadStages(); // event name may have changed on tournaments
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

function openNewEventModal() {
    document.getElementById('newEventNameInput').value = '';
    openModal('newEventModal');
    document.getElementById('newEventNameInput').focus();
}

async function createLanEvent(e) {
    e.preventDefault();
    try {
        const event = await apiFetch('/events', {
            method: 'POST',
            body: JSON.stringify({ name: document.getElementById('newEventNameInput').value })
        });
        closeModal('newEventModal');
        await loadEvents();
        await selectLanEvent(event.id);
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function deleteLanEvent() {
    const event = currentEvent();
    if (!event) return;
    if (!confirm(`Event „${event.name}“ mit allen ${event.attendee_count} Teilnehmern löschen?`)) return;
    try {
        await apiFetch(`/events/${event.id}`, { method: 'DELETE' });
        currentEventId = null;
        await showAttendeeView();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function importFromEvent() {
    const fromEventId = Number(document.getElementById('importSourceSelect').value);
    const source = lanEvents.find(e => e.id === fromEventId);
    if (!source || !confirm(`Teilnehmer aus „${source.name}“ übernehmen?`)) return;
    try {
        const result = await apiFetch(`/events/${currentEventId}/attendees/import`, {
            method: 'POST',
            body: JSON.stringify({ fromEventId })
        });
        await loadEvents();
        renderEventSelect();
        await loadAttendees();
        const skipped = result.skipped.length ? `\nÜbersprungen (schon vorhanden oder kein Platz): ${result.skipped.join(', ')}` : '';
        alert(`✅ ${result.added} Teilnehmer übernommen.${skipped}`);
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

/* Attendees */

// "In Gedenken" below the list (they play as byes in every tournament of the event)
function renderMemorialNote(event) {
    const note = document.getElementById('memorialNote');
    const names = event?.memorial ?? [];
    note.style.display = names.length ? '' : 'none';
    note.innerHTML = names.length
        ? `<strong>In Gedenken</strong> ${names.map(escapeHtml).join(' · ')} <span class="muted">— spielen in jedem Turnier als Freilos mit</span>`
        : '';
}

// DNS name with line-break opportunities after the dots
function dnsHtml(name) {
    return escapeHtml(name).replace(/\./g, '.<wbr>');
}

function updateEditDisplayPreview() {
    const clan = document.getElementById('editClan').value.trim();
    const nickname = document.getElementById('editNickname').value.trim();
    document.getElementById('editDisplayPreview').textContent = clan ? `${clan}-${nickname}` : nickname;
}

async function loadAttendees() {
    attendees = currentEventId != null ? await apiFetch(`/events/${currentEventId}/attendees`).catch(() => []) : [];
    renderClanFilter();
    renderAttendees();
}

// Clan filter: all, without clan, and every clan of the event (keeps the selection if still present)
function renderClanFilter() {
    const select = document.getElementById('clanFilter');
    // An empty select reports '' — which would be "Ohne Clan"; start with "Alle Clans" instead
    const current = select.options.length ? select.value : '__all__';
    const counts = new Map();
    attendees.forEach(a => counts.set(a.clan, (counts.get(a.clan) || 0) + 1));
    const clans = [...counts.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));

    select.innerHTML = '<option value="__all__">Alle Clans</option>'
        + (counts.has('') ? `<option value="">Ohne Clan (${counts.get('')})</option>` : '')
        + clans.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)} (${counts.get(c)})</option>`).join('');
    select.value = [...select.options].some(o => o.value === current) ? current : '__all__';
}

// Sorting by clicking a column header; clicking again reverses the direction
let attendeeSort = { key: 'slot', dir: 1 };

function sortAttendeesBy(key) {
    attendeeSort = { key, dir: attendeeSort.key === key ? -attendeeSort.dir : 1 };
    renderAttendees();
}

function compareAttendees(a, b) {
    const { key, dir } = attendeeSort;
    if (key === 'slot') return (a.slot - b.slot) * dir;
    const x = a[key] || '', y = b[key] || '';
    // Empty values always last, ties by slot
    if (!x !== !y) return x ? -1 : 1;
    return (x.localeCompare(y, 'de', { sensitivity: 'base', numeric: true }) || a.slot - b.slot) * (x ? dir : 1);
}

function renderAttendees() {
    const event = currentEvent();
    const tbody = document.getElementById('attendeeRows');
    const summary = document.getElementById('attendeeSummary');

    document.querySelectorAll('#attendeeHead th.sortable').forEach(th => {
        th.classList.toggle('sort-asc', th.dataset.sort === attendeeSort.key && attendeeSort.dir === 1);
        th.classList.toggle('sort-desc', th.dataset.sort === attendeeSort.key && attendeeSort.dir === -1);
    });

    if (!event) {
        summary.textContent = '';
        tbody.innerHTML = '<tr><td colspan="9" class="empty-cell">Lege zuerst ein Event an.</td></tr>';
        return;
    }

    const query = document.getElementById('attendeeSearch').value.trim().toLowerCase();
    const clan = document.getElementById('clanFilter').value;
    const rows = attendees
        .filter(a => clan === '__all__' || a.clan === clan)
        .filter(a => !query || [a.display_name, a.first_name, a.last_name, ...a.ips, ...a.dns_names]
            .some(value => value.toLowerCase().includes(query)))
        .sort(compareAttendees);

    renderMemorialNote(event);
    const filtered = rows.length !== attendees.length ? ` · ${rows.length} angezeigt` : '';
    summary.textContent = `${event.name} · ${attendees.length} Teilnehmer${filtered}`;

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">${attendees.length ? 'Keine Treffer.' : 'Noch keine Teilnehmer — oben hinzufügen.'}</td></tr>`;
        return;
    }

    const cell = value => escapeHtml(value) || '<span class="muted">–</span>';
    tbody.innerHTML = rows.map(a => `
        <tr>
            <td class="col-slot">${a.slot + 1}</td>
            <td class="col-name">${cell(a.first_name)}</td>
            <td class="col-name">${cell(a.last_name)}</td>
            <td class="col-clan">${cell(a.clan)}</td>
            <td class="col-nick">${escapeHtml(a.nickname)}</td>
            ${a.ips.map((ip, i) => `
                <td class="col-ip">
                    <span class="ip">${ip}</span>
                    <span class="dns">${dnsHtml(a.dns_names[i])}</span>
                </td>`).join('')}
            <td class="col-actions">
                <button class="btn btn-ghost btn-icon" onclick="exportSlip(${a.id})" title="IP-Zettel (PDF)" aria-label="IP-Zettel als PDF">${icon('file')}</button>
                <button class="btn btn-ghost btn-icon admin-only" onclick="editAttendee(${a.id})" title="Bearbeiten" aria-label="Bearbeiten">${icon('edit')}</button>
                <button class="btn btn-danger btn-icon admin-only" onclick="deleteAttendee(${a.id})" title="Löschen" aria-label="Löschen">${icon('trash')}</button>
            </td>
        </tr>
    `).join('');
}

async function addAttendee(e) {
    e.preventDefault();
    const fields = ['newFirstName', 'newLastName', 'newClan', 'newNickname'].map(id => document.getElementById(id));
    try {
        await apiFetch(`/events/${currentEventId}/attendees`, {
            method: 'POST',
            body: JSON.stringify({ first_name: fields[0].value, last_name: fields[1].value, clan: fields[2].value, nickname: fields[3].value })
        });
        fields.forEach(f => { f.value = ''; });
        fields[0].focus();
        await loadEvents();
        renderEventSelect();
        await loadAttendees();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

function editAttendee(id) {
    const attendee = attendees.find(a => a.id === id);
    if (!attendee) return;
    document.getElementById('editAttendeeId').value = id;
    document.getElementById('editFirstName').value = attendee.first_name;
    document.getElementById('editLastName').value = attendee.last_name;
    document.getElementById('editClan').value = attendee.clan;
    document.getElementById('editNickname').value = attendee.nickname;
    updateEditDisplayPreview();
    openModal('attendeeModal');
}

async function saveAttendee(e) {
    e.preventDefault();
    const id = Number(document.getElementById('editAttendeeId').value);
    try {
        await apiFetch(`/attendees/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
                first_name: document.getElementById('editFirstName').value,
                last_name: document.getElementById('editLastName').value,
                clan: document.getElementById('editClan').value,
                nickname: document.getElementById('editNickname').value
            })
        });
        closeModal('attendeeModal');
        await loadAttendees();
        await loadParticipants(); // nickname may have changed in tournaments
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function deleteAttendee(id) {
    const attendee = attendees.find(a => a.id === id);
    if (!attendee || !confirm(`Teilnehmer „${attendee.display_name}“ löschen? Die IP-Adressen werden wieder frei.`)) return;
    try {
        await apiFetch(`/attendees/${id}`, { method: 'DELETE' });
        await loadEvents();
        renderEventSelect();
        await loadAttendees();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

/* Bulk import: "Nachname, Vorname // Clan-Nickname" per line, previewed by the server first */

function openBulkImport() {
    document.getElementById('bulkImportText').value = '';
    resetBulkPreview();
    openModal('bulkImportModal');
    document.getElementById('bulkImportText').focus();
}

// The preview is only valid for the text it was made for
function resetBulkPreview() {
    document.getElementById('bulkPreview').innerHTML = '';
    const button = document.getElementById('bulkImportButton');
    button.disabled = true;
    button.textContent = 'Importieren';
}

async function requestBulkImport(dryRun) {
    return apiFetch(`/events/${currentEventId}/attendees/bulk`, {
        method: 'POST',
        body: JSON.stringify({ text: document.getElementById('bulkImportText').value, dryRun })
    });
}

async function previewBulkImport() {
    try {
        const { rows } = await requestBulkImport(true);
        const valid = rows.filter(r => r.ok).length;
        const preview = document.getElementById('bulkPreview');

        preview.innerHTML = rows.length === 0 ? '<p class="field-hint">Keine Zeilen gefunden.</p>' : `
            <p class="bulk-summary">
                <span class="info-badge badge-status">${valid} gültig</span>
                ${rows.length - valid ? `<span class="info-badge badge-error">${rows.length - valid} fehlerhaft — werden übersprungen</span>` : ''}
            </p>
            <div class="table-wrap">
                <table class="attendee-table bulk-table">
                    <thead><tr><th>Zeile</th><th>Vorname</th><th>Nachname</th><th>Clan</th><th>Nickname</th><th>Haupt-PC</th><th>Status</th></tr></thead>
                    <tbody>
                        ${rows.map(r => r.ok ? `
                            <tr>
                                <td class="col-slot">${r.line}</td>
                                <td class="col-name">${escapeHtml(r.attendee.first_name) || '<span class="muted">–</span>'}</td>
                                <td class="col-name">${escapeHtml(r.attendee.last_name) || '<span class="muted">–</span>'}</td>
                                <td class="col-clan">${escapeHtml(r.attendee.clan) || '<span class="muted">–</span>'}</td>
                                <td class="col-nick">${escapeHtml(r.attendee.nickname)}</td>
                                <td class="col-ip"><span class="ip">${r.attendee.ips[0]}</span><span class="dns">${dnsHtml(r.attendee.dns_names[0])}</span></td>
                                <td class="status-ok">OK</td>
                            </tr>` : `
                            <tr class="row-error">
                                <td class="col-slot">${r.line}</td>
                                <td colspan="5" class="col-raw">${escapeHtml(r.text)}</td>
                                <td class="status-error">${escapeHtml(r.error)}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>`;

        const button = document.getElementById('bulkImportButton');
        button.disabled = valid === 0;
        button.textContent = valid ? `${valid} importieren` : 'Importieren';
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function runBulkImport() {
    try {
        const { rows, added } = await requestBulkImport(false);
        const failed = rows.filter(r => !r.ok);
        closeModal('bulkImportModal');
        await loadEvents();
        renderEventSelect();
        await loadAttendees();
        const details = failed.length
            ? `\n\nÜbersprungen:\n${failed.map(r => `Zeile ${r.line}: ${r.error}`).join('\n')}`
            : '';
        alert(`✅ ${added} Teilnehmer importiert.${details}`);
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

/* Logo for the IP slips (stored on the event as PNG/JPEG data URL) */

function renderLogoPreview(event) {
    const preview = document.getElementById('logoPreview');
    preview.innerHTML = event.logo
        ? `<img src="${event.logo}" alt="Logo">`
        : '<span>Kein Logo</span>';
    preview.classList.toggle('is-empty', !event.logo);
    document.getElementById('logoRemoveBtn').style.display = event.logo ? '' : 'none';
}

// Any image the browser can display (incl. SVG) → PNG, at most 1000 px on the long side
function imageFileToPng(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, 1000 / Math.max(img.naturalWidth || 1000, img.naturalHeight || 1000));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round((img.naturalWidth || 1000) * scale));
            canvas.height = Math.max(1, Math.round((img.naturalHeight || 1000) * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Die Datei konnte nicht als Bild gelesen werden'));
        };
        img.src = url;
    });
}

async function saveLogo(logo) {
    const event = currentEvent();
    if (!event) return;
    await apiFetch(`/events/${event.id}`, { method: 'PUT', body: JSON.stringify({ logo }) });
    await loadEvents();
    renderEventSelect();
}

async function uploadLogo(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
        await saveLogo(await imageFileToPng(file));
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function removeLogo() {
    if (!confirm('Logo entfernen?')) return;
    try {
        await saveLogo('');
    } catch (error) {
        alert('❌ ' + error.message);
    }
}
