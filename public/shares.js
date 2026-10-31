// SMB shares (src/shares.ts): attendees share folders of their PCs, admins add fixed shares of the
// event (welcome page). macOS opens smb:// links in the Finder; Windows browsers don't open SMB at
// all, so Windows gets a .cmd (net use with the credentials, then Explorer) and the UNC path to copy.
// Uses apiFetch, escapeHtml, icon, openModal/closeModal, setButtonLabel, isAdmin, lanEvents from
// app.js, RANGE_LABELS, attendees, currentEvent, loadAttendees, dnsHtml from lan.js and me, isMe from welcome.js.

// Rendered shares by key, so buttons only carry the key (data-share-key)
const shareEntries = new Map();
let shareEditTarget = null; // { kind: 'attendee' | 'event', id }

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('shareEditForm').addEventListener('submit', saveShares);
});

const sharePathParts = share => share.path.split('/');

// "\\192.168.120.100\games\steam"
function uncPath(host, share) {
    return `\\\\${host}\\${sharePathParts(share).join('\\')}`;
}

// smb://user:pass@host/games/steam — a domain user "WORKGROUP\gast" becomes "WORKGROUP;gast"
function smbUrl(host, share) {
    const user = share.username
        ? `${encodeURIComponent(share.username.replace('\\', ';')).replace('%3B', ';')}${share.password ? `:${encodeURIComponent(share.password)}` : ''}@`
        : '';
    return `smb://${user}${host}/${sharePathParts(share).map(encodeURIComponent).join('/')}`;
}

// Windows: net use connects the share root with the credentials, then Explorer opens the folder.
// The server forbids '"' and '%' in path, user and password, so the quoting holds.
function connectCmd(host, share) {
    const root = `\\\\${host}\\${sharePathParts(share)[0]}`;
    const title = (share.label || share.path).replace(/[^\p{L}\p{N} ._/-]/gu, ''); // the label is not checked for cmd
    const lines = ['@echo off', 'chcp 65001 >nul', `rem SMB-Share ${title} auf ${host} verbinden (mcd-brackets)`];
    if (share.username) {
        lines.push(
            `net use "${root}" "${share.password}" /user:"${share.username}" /persistent:no`,
            'if errorlevel 1 pause',
        );
    }
    lines.push(`start "" explorer "${uncPath(host, share)}"`);
    return lines.join('\r\n') + '\r\n';
}

function downloadShareCmd(button) {
    const entry = shareEntries.get(button.dataset.shareKey);
    if (!entry) return;
    const slug = `${entry.host}-${entry.share.path}`.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
    const url = URL.createObjectURL(new Blob([connectCmd(entry.host, entry.share)], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `verbinden-${slug}.cmd`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// navigator.clipboard only exists on HTTPS and localhost; in the LAN the page runs on plain HTTP
async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('Kopieren nicht möglich');
}

async function copyShareValue(button) {
    try {
        await copyText(button.dataset.copy);
        const label = button.querySelector('.btn-label');
        const before = label?.textContent;
        button.classList.add('is-copied');
        if (label) setButtonLabel(button, 'Kopiert');
        setTimeout(() => {
            button.classList.remove('is-copied');
            if (label) setButtonLabel(button, before);
        }, 1500);
    } catch {
        prompt('Zum Kopieren markieren:', button.dataset.copy);
    }
}

/* Lists
   ========================================================================== */

// entries: [{ host, dns, share }]
function shareListHtml(entries, empty = 'Keine Shares.') {
    if (!entries.length) return `<p class="muted share-empty">${escapeHtml(empty)}</p>`;
    return `<ul class="share-list">${entries.map(({ host, dns, share }) => {
        const key = `${host}|${share.id}`;
        shareEntries.set(key, { host, share });
        const path = uncPath(host, share);
        const copy = (value, label) => `<button type="button" class="btn btn-ghost btn-icon btn-copy" data-copy="${escapeHtml(value)}" onclick="copyShareValue(this)" title="${label} kopieren" aria-label="${label} kopieren">${icon('copy')}</button>`;
        const credentials = share.username ? `
            <dl class="share-credentials">
                <dt>Benutzer</dt><dd><code>${escapeHtml(share.username)}</code>${copy(share.username, 'Benutzer')}</dd>
                ${share.password ? `<dt>Passwort</dt><dd><code>${escapeHtml(share.password)}</code>${copy(share.password, 'Passwort')}</dd>` : ''}
            </dl>` : '<p class="share-guest muted">Ohne Anmeldung (Gast)</p>';
        return `
            <li class="share-item">
                <div class="share-main">
                    <strong class="share-title">${icon('folder')}${escapeHtml(share.label || share.path)}</strong>
                    <code class="share-path">${escapeHtml(path)}</code>
                    ${dns ? `<span class="dns">${dnsHtml(dns)}</span>` : ''}
                    ${credentials}
                </div>
                <div class="share-actions">
                    <a class="btn btn-secondary btn-sm" href="${escapeHtml(smbUrl(host, share))}" title="Im Finder öffnen (macOS)">${icon('external')}<span>macOS</span></a>
                    <button type="button" class="btn btn-secondary btn-sm" data-share-key="${escapeHtml(key)}" onclick="downloadShareCmd(this)" title="Skript zum Verbinden herunterladen und doppelklicken (Windows)">${icon('download')}<span>Windows</span></button>
                    <button type="button" class="btn btn-ghost btn-sm" data-copy="${escapeHtml(path)}" onclick="copyShareValue(this)" title="Pfad für den Explorer (Windows) bzw. Win+R kopieren">${icon('copy')}<span class="btn-label">Pfad kopieren</span></button>
                </div>
            </li>`;
    }).join('')}</ul>`;
}

function attendeeShareEntries(attendee) {
    return (attendee.shares ?? []).map(share => ({
        host: attendee.ips[share.range_index],
        dns: attendee.dns_names[share.range_index],
        share,
    }));
}

function eventShareEntries(event) {
    return (event?.shares ?? []).map(share => ({ host: share.host, dns: '', share }));
}

const SHARE_HINT = 'macOS öffnet den Share direkt im Finder. Unter Windows das Skript herunterladen und doppelklicken — oder den Pfad in die Adresszeile des Explorers einfügen.';

/* Attendee shares: view and edit
   ========================================================================== */

function findShareOwner(id) {
    return (typeof attendees !== 'undefined' && attendees.find(a => a.id === id))
        || (me?.attendee?.id === id ? me.attendee : null);
}

const canEditAttendeeShares = id => isAdmin || isMe(id);

function openAttendeeShares(id) {
    const attendee = findShareOwner(id);
    if (!attendee) return;
    document.getElementById('shareViewTitle').textContent = `Shares von ${attendee.display_name}`;
    document.getElementById('shareViewBody').innerHTML =
        shareListHtml(attendeeShareEntries(attendee), 'Noch keine Shares freigegeben.')
        + `<p class="field-hint">${escapeHtml(SHARE_HINT)}</p>`;
    const edit = document.getElementById('shareViewEdit');
    edit.hidden = !canEditAttendeeShares(id);
    edit.onclick = () => {
        closeModal('shareViewModal');
        openShareEditor('attendee', id);
    };
    openModal('shareViewModal');
}

function openShareEditor(kind, id) {
    const owner = kind === 'attendee' ? findShareOwner(id) : lanEvents.find(e => e.id === id);
    if (!owner) return;
    shareEditTarget = { kind, id, owner };
    document.getElementById('shareEditTitle').textContent = kind === 'attendee'
        ? `Shares von ${owner.display_name}`
        : `Netzwerk-Shares von ${owner.name}`;
    document.getElementById('shareEditIntro').textContent = kind === 'attendee'
        ? 'Freigaben (SMB 3) auf deinen PCs, die andere Teilnehmer öffnen dürfen. Benutzer und Passwort sehen alle, die die Seite öffnen — nur einen eigenen Gast-Benutzer verwenden.'
        : 'Feste Freigaben (SMB 3) des Events, z. B. ein Spiele-Server. Sie stehen auf der Willkommens-Seite, Benutzer und Passwort sehen alle.';
    document.getElementById('shareEditRows').innerHTML = '';
    (owner.shares ?? []).forEach(addShareRow);
    if (!owner.shares?.length) addShareRow();
    openModal('shareEditModal');
}

function addShareRow(share = {}) {
    const { kind, owner } = shareEditTarget;
    const where = kind === 'attendee'
        ? `<div class="form-group">
                <label>PC</label>
                <select data-field="range_index">${owner.ips.map((ip, i) => `
                    <option value="${i}"${i === (share.range_index ?? 0) ? ' selected' : ''}>${escapeHtml(RANGE_LABELS[i])} · ${escapeHtml(ip)}</option>`).join('')}
                </select>
            </div>`
        : `<div class="form-group">
                <label>Server <span class="label-hint">IP oder DNS-Name</span></label>
                <input type="text" data-field="host" value="${escapeHtml(share.host ?? '')}" required autocomplete="off" spellcheck="false" placeholder="192.168.120.5">
            </div>`;
    const row = document.createElement('fieldset');
    row.className = 'share-edit-row';
    row.dataset.id = share.id ?? '';
    row.innerHTML = `
        <div class="share-edit-grid">
            ${where}
            <div class="form-group">
                <label>Freigabe <span class="label-hint">Ordner mit /</span></label>
                <input type="text" data-field="path" value="${escapeHtml(share.path ?? '')}" required autocomplete="off" spellcheck="false" placeholder="games">
            </div>
            <div class="form-group">
                <label>Bezeichnung <span class="label-hint">optional</span></label>
                <input type="text" data-field="label" value="${escapeHtml(share.label ?? '')}" maxlength="60" autocomplete="off" placeholder="Spiele">
            </div>
            <div class="form-group">
                <label>Benutzer <span class="label-hint">leer = Gast</span></label>
                <input type="text" data-field="username" value="${escapeHtml(share.username ?? '')}" maxlength="64" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-group">
                <label>Passwort</label>
                <input type="text" data-field="password" value="${escapeHtml(share.password ?? '')}" maxlength="128" autocomplete="off" spellcheck="false">
            </div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon share-edit-remove" onclick="this.closest('.share-edit-row').remove()" title="Share entfernen" aria-label="Share entfernen">${icon('trash')}</button>`;
    document.getElementById('shareEditRows').appendChild(row);
}

async function saveShares(e) {
    e.preventDefault();
    const { kind, id } = shareEditTarget;
    const shares = [...document.querySelectorAll('#shareEditRows .share-edit-row')].map(row => {
        const share = { id: row.dataset.id || undefined };
        row.querySelectorAll('[data-field]').forEach(field => {
            share[field.dataset.field] = field.dataset.field === 'range_index' ? Number(field.value) : field.value;
        });
        return share;
    });
    try {
        await apiFetch(kind === 'attendee' ? `/attendees/${id}/shares` : `/events/${id}/shares`, {
            method: 'PUT',
            body: JSON.stringify({ shares }),
        });
        closeModal('shareEditModal');
        if (kind === 'event') {
            await loadEvents();
            const event = lanEvents.find(ev => ev.id === id);
            if (event) renderEventShares(event);
        } else {
            if (me?.attendee?.id === id) await loadWhoami();
            if (document.body.dataset.view === 'attendees') await loadAttendees();
        }
        if (document.body.dataset.view === 'welcome') renderWelcome();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

/* Event configuration: fixed shares
   ========================================================================== */

function renderEventShares(event) {
    const shares = event.shares ?? [];
    document.getElementById('eventShareList').innerHTML = shares.length
        ? `<ul class="event-share-summary">${shares.map(s => `<li>${icon('folder')}<code>${escapeHtml(uncPath(s.host, s))}</code>${s.label ? ` <span class="muted">${escapeHtml(s.label)}</span>` : ''}</li>`).join('')}</ul>`
        : '<p class="field-hint">Noch keine Shares.</p>';
}

function editEventShares() {
    const event = currentEvent();
    if (event) openShareEditor('event', event.id);
}

/* Welcome page
   ========================================================================== */

function welcomeSharesHtml(event) {
    const eventEntries = eventShareEntries(event);
    const own = me?.status === 'identified' ? me.attendee : null;
    if (!eventEntries.length && !own) return '';
    const ownBlock = own ? `
        <div class="welcome-shares-own">
            <div class="welcome-subhead-row">
                <h3 class="welcome-subhead">Deine Shares</h3>
                <button class="btn btn-ghost btn-sm" onclick="openShareEditor('attendee', ${own.id})">${icon('edit')}<span>${own.shares?.length ? 'Bearbeiten' : 'Shares festlegen'}</span></button>
            </div>
            ${shareListHtml(attendeeShareEntries(own), 'Gib Ordner deiner PCs frei, damit andere sie per Klick öffnen können.')}
        </div>` : '';
    return `<section class="card">
        <div class="section-header">
            <div>
                <h2><svg class="icon icon-accent"><use href="#i-folder"/></svg>Netzwerk-Shares</h2>
                <p class="section-subtitle">${escapeHtml(SHARE_HINT)}</p>
            </div>
        </div>
        ${eventEntries.length ? shareListHtml(eventEntries) : ''}
        ${ownBlock}
    </section>`;
}
