// OPNsense connection (global settings) and transfer of the current event's DNS names
// to Unbound host overrides. Uses apiFetch, escapeHtml, setButtonLabel, openModal/closeModal
// from app.js and currentEventId/currentEvent from lan.js.

let opnsenseSettings = null;
let opnsenseMode = 'sync'; // 'sync' = transfer, 'remove' = delete the event's entries

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('opnsenseForm').addEventListener('submit', saveOpnsenseSettings);
});

// Called by showAttendeeView(); the settings are only readable for admins
async function loadOpnsenseSettings() {
    if (!isAdmin) return;
    try {
        opnsenseSettings = await apiFetch('/opnsense');
        document.getElementById('opnsenseUrl').value = opnsenseSettings.url;
        document.getElementById('opnsenseKey').value = opnsenseSettings.api_key;
        document.getElementById('opnsenseSecret').value = '';
        document.getElementById('opnsenseSecret').placeholder = opnsenseSettings.has_secret ? 'gespeichert — leer lassen zum Beibehalten' : '';
        document.getElementById('opnsenseInsecure').checked = opnsenseSettings.insecure_tls;
        setOpnsenseStatus(opnsenseSettings.configured ? '' : 'Noch nicht eingerichtet.');
    } catch (error) {
        setOpnsenseStatus(error.message, 'error');
    }
}

// After logout nothing of the connection stays in the page
function clearOpnsenseSettings() {
    opnsenseSettings = null;
    for (const id of ['opnsenseUrl', 'opnsenseKey', 'opnsenseSecret']) document.getElementById(id).value = '';
    document.getElementById('opnsenseInsecure').checked = false;
}

function readOpnsenseForm() {
    return {
        url: document.getElementById('opnsenseUrl').value,
        api_key: document.getElementById('opnsenseKey').value,
        api_secret: document.getElementById('opnsenseSecret').value,
        insecure_tls: document.getElementById('opnsenseInsecure').checked,
    };
}

function setOpnsenseStatus(text, kind = '') {
    const status = document.getElementById('opnsenseStatus');
    status.textContent = text;
    status.className = `field-hint opnsense-status${kind ? ` is-${kind}` : ''}`;
}

async function saveOpnsenseSettings(e) {
    e.preventDefault();
    try {
        await apiFetch('/opnsense', { method: 'PUT', body: JSON.stringify(readOpnsenseForm()) });
        await loadOpnsenseSettings();
        setOpnsenseStatus('Gespeichert.', 'ok');
    } catch (error) {
        setOpnsenseStatus(error.message, 'error');
    }
}

// Tests the values in the form, saved or not
async function testOpnsense() {
    const button = document.getElementById('opnsenseTestBtn');
    button.disabled = true;
    setButtonLabel(button, 'Teste…');
    setOpnsenseStatus('');
    try {
        const result = await apiFetch('/opnsense/test', { method: 'POST', body: JSON.stringify(readOpnsenseForm()) });
        setOpnsenseStatus(`Verbindung ok — ${result.host_count} Host Override${result.host_count === 1 ? '' : 's'} in Unbound.`, 'ok');
    } catch (error) {
        setOpnsenseStatus(error.message, 'error');
    } finally {
        button.disabled = false;
        setButtonLabel(button, 'Verbindung testen');
    }
}

/* Transfer: preview first, then apply (the server plans again against the current state) */

async function openOpnsenseSync() {
    const event = currentEvent();
    if (!event) return;
    if (!opnsenseSettings?.configured) {
        alert('OPNsense ist noch nicht eingerichtet: unter „Konfiguration“ Adresse, API-Key und Secret eintragen.');
        toggleSection('eventConfigSection', true);
        document.getElementById('opnsenseUrl').focus();
        return;
    }
    if (!event.domain) {
        alert('Für OPNsense muss beim Event zuerst eine Domain eingetragen werden (Konfiguration → Allgemein).');
        return;
    }
    opnsenseMode = 'sync';
    openModal('opnsenseModal');
    await previewOpnsense();
}

async function toggleOpnsenseMode() {
    opnsenseMode = opnsenseMode === 'sync' ? 'remove' : 'sync';
    await previewOpnsense();
}

function renderOpnsenseModeTexts() {
    const event = currentEvent();
    const removing = opnsenseMode === 'remove';
    document.getElementById('opnsenseModalTitle').textContent = removing ? 'Aus OPNsense entfernen' : 'Zu OPNsense übertragen';
    document.getElementById('opnsenseModalIntro').innerHTML = removing
        ? `Löscht alle Host Overrides, die MCD Brackets für <strong>${escapeHtml(event.name)}</strong> angelegt hat. Andere Einträge bleiben unverändert.`
        : `Gleicht die DNS-Namen von <strong>${escapeHtml(event.name)}</strong> mit den Host Overrides in Unbound ab. Es werden nur Einträge mit MCD-Markierung geändert oder gelöscht.`;
    const modeButton = document.getElementById('opnsenseModeBtn');
    modeButton.textContent = removing ? 'Zurück zum Übertragen' : 'Einträge entfernen…';
    modeButton.className = `btn btn-sm modal-action-left ${removing ? 'btn-ghost' : 'btn-danger'}`;
}

const OPNSENSE_ACTIONS = {
    create: { label: 'Neu', badge: 'badge-status' },
    update: { label: 'Ändern', badge: 'badge-pending' },
    delete: { label: 'Löschen', badge: 'badge-error' },
    conflict: { label: 'Konflikt', badge: 'badge-waiting' },
};

async function previewOpnsense() {
    renderOpnsenseModeTexts();
    const preview = document.getElementById('opnsensePreview');
    const applyButton = document.getElementById('opnsenseApplyBtn');
    applyButton.disabled = true;
    preview.innerHTML = '<p class="field-hint">Lese Host Overrides von OPNsense…</p>';
    try {
        const plan = await apiFetch(`/events/${currentEventId}/opnsense/preview`, {
            method: 'POST', body: JSON.stringify({ mode: opnsenseMode })
        });
        const { counts } = plan;
        const changes = counts.create + counts.update + counts.delete;
        const rows = plan.items.filter(item => item.action !== 'unchanged');

        preview.innerHTML = `
            <p class="bulk-summary">
                ${counts.create ? `<span class="info-badge badge-status">+ ${counts.create} neu</span>` : ''}
                ${counts.update ? `<span class="info-badge badge-pending">~ ${counts.update} geändert</span>` : ''}
                ${counts.delete ? `<span class="info-badge badge-error">− ${counts.delete} gelöscht</span>` : ''}
                ${counts.conflict ? `<span class="info-badge badge-waiting">! ${counts.conflict} Konflikt${counts.conflict === 1 ? '' : 'e'}</span>` : ''}
                ${counts.unchanged ? `<span class="info-badge">${counts.unchanged} aktuell</span>` : ''}
            </p>
            ${rows.length === 0 ? `<p class="field-hint">${changes || counts.unchanged ? 'Alles ist auf dem aktuellen Stand.' : 'Keine Einträge vorhanden.'}</p>` : `
            <div class="table-wrap">
                <table class="attendee-table bulk-table">
                    <thead><tr><th>Aktion</th><th>DNS-Name</th><th>IP</th><th>Hinweis</th></tr></thead>
                    <tbody>
                        ${rows.map(item => `
                            <tr class="${item.action === 'conflict' ? 'row-error' : ''}">
                                <td><span class="info-badge ${OPNSENSE_ACTIONS[item.action].badge}">${OPNSENSE_ACTIONS[item.action].label}</span></td>
                                <td class="col-nick"><span class="dns">${dnsHtml(item.name)}</span></td>
                                <td class="col-ip"><span class="ip">${escapeHtml(item.server)}</span></td>
                                <td class="col-raw">${escapeHtml(item.note || '')}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>`}`;

        applyButton.disabled = changes === 0;
        setButtonLabel(applyButton, changes === 0 ? 'Übertragen'
            : opnsenseMode === 'remove' ? `${changes} löschen` : `${changes} Änderung${changes === 1 ? '' : 'en'} übertragen`);
        applyButton.className = `btn ${opnsenseMode === 'remove' ? 'btn-danger-solid' : 'btn-primary'}`;
    } catch (error) {
        preview.innerHTML = `<p class="field-hint is-error">${escapeHtml(error.message)}</p>`;
    }
}

async function applyOpnsense() {
    const button = document.getElementById('opnsenseApplyBtn');
    if (opnsenseMode === 'remove' && !confirm('Alle Einträge dieses Events in OPNsense löschen?')) return;
    button.disabled = true;
    setButtonLabel(button, 'Übertrage…');
    try {
        const result = await apiFetch(`/events/${currentEventId}/opnsense/apply`, {
            method: 'POST', body: JSON.stringify({ mode: opnsenseMode })
        });
        const lines = [`✅ ${result.created} neu, ${result.updated} geändert, ${result.deleted} gelöscht.`];
        if (result.reconfigured) lines.push('Unbound wurde neu geladen.');
        if (result.conflicts) lines.push(`${result.conflicts} Konflikt(e) wurden übersprungen.`);
        if (result.errors.length) lines.push('', 'Fehler:', ...result.errors.map(e => `${e.name}: ${e.error}`));
        alert(lines.join('\n'));
        await previewOpnsense();
    } catch (error) {
        alert('❌ ' + error.message);
        await previewOpnsense();
    }
}
