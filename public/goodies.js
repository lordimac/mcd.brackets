// Goodies settlement (src/goodies.ts): who gets which goodie, who paid the shop for it, and who
// sends whom how much at the end (fewest transfers, with PayPal.me links). Amounts are cents.
// Uses apiFetch, escapeHtml, icon, actionMenu, confirmDialog, notify, openModal/closeModal,
// lanEvents and isAdmin from app.js, currentEventId/ensureCurrentEvent from lan.js, isMe from welcome.js.

let goodiesData = null; // answer of GET /events/:id/goodies
let goodiesArticleDraft = null; // catalog being edited (null = not changed)

const GOODIES_PAYER_KEY = 'mcd.goodiesPayer';
const euroFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('goodiesAddForm').addEventListener('submit', addGoodiesItem);
    document.getElementById('goodiesEditForm').addEventListener('submit', saveGoodiesItem);
    document.getElementById('goodiesPaymentForm').addEventListener('submit', saveGoodiesPayment);
    document.getElementById('goodiesPaypalForm').addEventListener('submit', saveGoodiesPaypal);
    document.getElementById('goodiesArticles').addEventListener('input', readGoodiesArticleRows);
    document.getElementById('goodiesArticles').addEventListener('change', readGoodiesArticleRows);
    for (const id of ['giNewPayer', 'giEditPayer']) {
        document.getElementById(id).addEventListener('change', e => { delete e.target.dataset.fromArticle; });
    }
});

function formatEuro(cents) {
    return euroFormat.format(cents / 100);
}

// "45", "45,5", "45,50 €", "1.234,56", "12.5" → cents; null = not a valid amount
function parseEuro(text) {
    let value = String(text ?? '').replace(/[€\s]/g, '');
    if (!value) return null;
    if (value.includes(',')) value = value.replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
    return Math.round(Number(value) * 100);
}

function euroInputValue(cents) {
    return (cents / 100).toFixed(2).replace('.', ',');
}

// PayPal.me fills in the amount; the decimal point has to be a dot
function paypalUrl(name, cents) {
    return `https://paypal.me/${encodeURIComponent(name)}/${(cents / 100).toFixed(2)}EUR`;
}

/* Loading
   ========================================================================== */

// Called by showView() in app.js whenever the goodies tab opens
async function showGoodiesView() {
    await loadEvents();
    ensureCurrentEvent();
    const select = document.getElementById('goodiesEventSelect');
    const events = [...lanEvents].reverse();
    select.innerHTML = events.length
        ? events.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')
        : '<option value="">Noch kein Event — unter „Teilnehmer“ anlegen</option>';
    if (currentEventId != null) select.value = String(currentEventId);
    await loadGoodies();
}

async function selectGoodiesEvent(id) {
    currentEventId = Number(id);
    try { localStorage.setItem('mcd.attendeeEvent', String(currentEventId)); } catch { /* storage unavailable */ }
    updateBrandLogo();
    goodiesArticleDraft = null;
    await loadGoodies();
}

async function loadGoodies() {
    goodiesData = currentEventId != null ? await apiFetch(`/events/${currentEventId}/goodies`).catch(error => {
        notify('❌ Goodies konnten nicht geladen werden: ' + error.message, { retry: loadGoodies });
        return null;
    }) : null;
    renderGoodies();
}

// Every change answers with the whole state
function applyGoodies(data) {
    goodiesData = data;
    document.body.classList.toggle('has-goodies', data.items.length > 0 || lanEvents.some(e => e.id !== currentEventId && e.goodies_count > 0));
    renderGoodies();
}

function renderGoodies() {
    renderGoodiesForms();
    renderGoodiesSettlement();
    renderGoodiesSettle();
    renderGoodiesItems();
    renderGoodiesOrderSummary();
    renderGoodiesArticles();
}

/* People
   ========================================================================== */

function goodiesPerson(id) {
    return goodiesData?.people.find(p => p.id === id) ?? null;
}

function goodiesName(id) {
    return goodiesPerson(id)?.name ?? 'Unbekannt';
}

// Name with "du" for the own person (IP identification)
function goodiesNameHtml(id) {
    return `${escapeHtml(goodiesName(id))}${isMe(id) ? '<span class="me-tag">du</span>' : ''}`;
}

// Attendees first, guests in their own group
function goodiesPersonOptions(selected, emptyLabel) {
    const people = goodiesData?.people ?? [];
    const option = p => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${escapeHtml(p.name)}</option>`;
    const guests = people.filter(p => p.guest);
    return (emptyLabel != null ? `<option value=""${selected == null ? ' selected' : ''}>${escapeHtml(emptyLabel)}</option>` : '')
        + people.filter(p => !p.guest).map(option).join('')
        + (guests.length ? `<optgroup label="Gäste">${guests.map(option).join('')}</optgroup>` : '');
}

function goodiesArticleOptions(selected) {
    const articles = goodiesData?.articles ?? [];
    return articles.map(a => `<option value="${escapeHtml(a.id)}"${a.id === selected ? ' selected' : ''}>${escapeHtml(a.name)} · ${formatEuro(a.price)}</option>`).join('')
        + `<option value=""${!selected ? ' selected' : ''}>Anderer Artikel …</option>`;
}

/* Forms (add inline, edit in a dialog): same fields with the prefixes giNew / giEdit
   ========================================================================== */

function renderGoodiesForms() {
    const has = !!goodiesData;
    document.getElementById('goodiesAddForm').style.display = has && goodiesData.people.length ? '' : 'none';
    if (!has) return;
    const recipient = document.getElementById('giNewRecipient');
    const previousRecipient = recipient.value ? Number(recipient.value) : null;
    recipient.innerHTML = goodiesPersonOptions(previousRecipient, '— bitte wählen —');

    // Articles name their payer; for the others the last payer is remembered per browser
    const payer = document.getElementById('giNewPayer');
    let previousPayer = payer.value ? Number(payer.value) : null;
    if (!payer.options.length) {
        try { previousPayer = Number(localStorage.getItem(GOODIES_PAYER_KEY)) || null; } catch { /* storage unavailable */ }
    }
    payer.innerHTML = goodiesPersonOptions(goodiesPerson(previousPayer) ? previousPayer : null, '— noch niemand —');

    const article = document.getElementById('giNewArticle');
    const previousArticle = article.value;
    article.innerHTML = goodiesArticleOptions(previousArticle || goodiesData.articles[0]?.id);
    if (previousArticle !== article.value || !document.getElementById('giNewPrice').value) applyGoodiesArticle('giNew');
    else fillVariantList('giNew');
}

// Article chosen: name field only for "Anderer Artikel", price and variant suggestions from the catalog
function applyGoodiesArticle(prefix) {
    const id = document.getElementById(`${prefix}Article`).value;
    const article = goodiesData?.articles.find(a => a.id === id);
    const nameInput = document.getElementById(`${prefix}Name`);
    nameInput.hidden = !!article;
    nameInput.required = !article;
    if (article) document.getElementById(`${prefix}Price`).value = euroInputValue(article.price);
    else if (prefix === 'giNew') nameInput.focus();
    // Who paid for the article is known in advance (can still be changed per entry)
    // A payer taken from the previous article does not carry over to one without payer
    const payer = document.getElementById(`${prefix}Payer`);
    if (article?.payer_id != null && goodiesPerson(article.payer_id)) {
        payer.value = String(article.payer_id);
        payer.dataset.fromArticle = '1';
    } else if (payer.dataset.fromArticle) {
        payer.value = '';
        delete payer.dataset.fromArticle;
    }
    // A size of another article does not fit ("XXL" on a mouse pad)
    const variant = document.getElementById(`${prefix}Variant`);
    if (article?.variants.length && !article.variants.includes(variant.value)) variant.value = article.variants.length === 1 ? article.variants[0] : '';
    fillVariantList(prefix);
}

function fillVariantList(prefix) {
    const article = goodiesData?.articles.find(a => a.id === document.getElementById(`${prefix}Article`).value);
    document.getElementById(`${prefix}VariantList`).innerHTML = (article?.variants ?? [])
        .map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
    document.getElementById(`${prefix}Variant`).placeholder = article?.variants.length ? article.variants.join(', ') : 'z.B. XL';
}

function readGoodiesForm(prefix) {
    const price = parseEuro(document.getElementById(`${prefix}Price`).value);
    if (price === null) throw new Error('Preis: bitte als Betrag angeben, z.B. 45,00');
    const articleId = document.getElementById(`${prefix}Article`).value || null;
    const payer = document.getElementById(`${prefix}Payer`).value;
    return {
        article_id: articleId,
        name: articleId ? undefined : document.getElementById(`${prefix}Name`).value,
        variant: document.getElementById(`${prefix}Variant`).value,
        quantity: Number(document.getElementById(`${prefix}Quantity`).value),
        price,
        recipient_id: Number(document.getElementById(`${prefix}Recipient`).value),
        payer_id: payer ? Number(payer) : null,
    };
}

async function addGoodiesItem(e) {
    e.preventDefault();
    try {
        const item = readGoodiesForm('giNew');
        const data = await apiFetch(`/events/${currentEventId}/goodies/items`, { method: 'POST', body: JSON.stringify(item) });
        try { localStorage.setItem(GOODIES_PAYER_KEY, item.payer_id == null ? '' : String(item.payer_id)); } catch { /* storage unavailable */ }
        // Article, price and payer stay for the next person; only who and how many reset
        document.getElementById('giNewRecipient').value = '';
        document.getElementById('giNewQuantity').value = '1';
        applyGoodies(data);
        announce(`${item.quantity}× ${item.name ?? goodiesData.articles.find(a => a.id === item.article_id)?.name ?? ''} für ${goodiesName(item.recipient_id)} eingetragen`);
        document.getElementById('giNewRecipient').focus();
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

function editGoodiesItem(id) {
    const item = goodiesData?.items.find(i => i.id === id);
    if (!item) return;
    document.getElementById('giEditId').value = id;
    // An article that left the catalog stays selectable as free entry
    const known = goodiesData.articles.some(a => a.id === item.article_id);
    document.getElementById('giEditArticle').innerHTML = goodiesArticleOptions(known ? item.article_id : null);
    const name = document.getElementById('giEditName');
    name.value = item.name;
    name.hidden = known;
    name.required = !known;
    fillVariantList('giEdit');
    document.getElementById('giEditVariant').value = item.variant;
    document.getElementById('giEditQuantity').value = item.quantity;
    document.getElementById('giEditPrice').value = euroInputValue(item.price);
    document.getElementById('giEditRecipient').innerHTML = goodiesPersonOptions(item.recipient_id);
    document.getElementById('giEditPayer').innerHTML = goodiesPersonOptions(item.payer_id, '— noch niemand —');
    delete document.getElementById('giEditPayer').dataset.fromArticle;
    document.getElementById('giEditNote').value = item.note;
    document.getElementById('giEditHandedOut').checked = item.handed_out;
    openModal('goodiesItemModal');
}

async function saveGoodiesItem(e) {
    e.preventDefault();
    const id = document.getElementById('giEditId').value;
    try {
        const item = readGoodiesForm('giEdit');
        if (!item.article_id) item.name = document.getElementById('giEditName').value;
        item.note = document.getElementById('giEditNote').value;
        item.handed_out = document.getElementById('giEditHandedOut').checked;
        const data = await apiFetch(`/events/${currentEventId}/goodies/items/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(item) });
        closeModal('goodiesItemModal');
        applyGoodies(data);
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

async function deleteGoodiesItem(id) {
    const item = goodiesData?.items.find(i => i.id === id);
    if (!item || !(await confirmDialog(`${item.quantity}× ${item.name}${item.variant ? ` (${item.variant})` : ''} für ${goodiesName(item.recipient_id)} löschen?`, { title: 'Eintrag löschen?' }))) return;
    try {
        applyGoodies(await apiFetch(`/events/${currentEventId}/goodies/items/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

async function toggleGoodiesHandedOut(input) {
    const id = input.closest('[data-item]').dataset.item;
    try {
        applyGoodies(await apiFetch(`/events/${currentEventId}/goodies/items/${encodeURIComponent(id)}`, {
            method: 'PUT', body: JSON.stringify({ handed_out: input.checked })
        }));
    } catch (error) {
        input.checked = !input.checked;
        notify('❌ ' + error.message);
    }
}

/* Settlement: transfers, balances, payments
   ========================================================================== */

function renderGoodiesSettle() {
    const box = document.getElementById('goodiesTransfers');
    const totals = document.getElementById('goodiesTotals');
    if (!goodiesData) {
        box.innerHTML = currentEventId == null ? '<p class="empty-state">Lege zuerst unter „Teilnehmer“ ein Event an.</p>' : '';
        totals.textContent = '';
        return;
    }
    const { items, transfers, balances, payments } = goodiesData;
    const pieces = items.reduce((sum, i) => sum + i.quantity, 0);
    const value = items.reduce((sum, i) => sum + i.quantity * i.price, 0);
    const unpaid = items.filter(i => i.payer_id == null);
    const unpaidValue = unpaid.reduce((sum, i) => sum + i.quantity * i.price, 0);
    totals.textContent = items.length
        ? `${pieces} ${pieces === 1 ? 'Goodie' : 'Goodies'} für ${formatEuro(value)}${unpaid.length ? ` · ${formatEuro(unpaidValue)} noch von niemandem bezahlt` : ''}`
        : '';

    if (!items.length) {
        box.innerHTML = `<p class="empty-state">Noch keine Goodies eingetragen.${isAdmin ? ' Unten unter „Artikel“ anlegen, was es gibt, dann bei „Wer bekommt was“ eintragen.' : ''}</p>`;
    } else if (!transfers.length) {
        box.innerHTML = `<p class="goodies-settled">${icon('check')}<span>Alles ausgeglichen — niemand schuldet jemandem etwas.${unpaid.length ? ' Goodies ohne Zahler zählen erst, wenn jemand sie bezahlt hat.' : ''}</span></p>`;
    } else {
        // Own transfers first, then the biggest
        const sorted = [...transfers].sort((a, b) => Number(isMe(b.from_id) || isMe(b.to_id)) - Number(isMe(a.from_id) || isMe(a.to_id)) || b.amount - a.amount);
        box.innerHTML = `<ul class="goodies-transfer-list">${sorted.map(transferHtml).join('')}</ul>`;
    }

    const shown = balances.filter(b => b.received || b.paid || b.sent || b.got)
        .sort((a, b) => a.balance - b.balance || goodiesName(a.person_id).localeCompare(goodiesName(b.person_id), 'de'));
    document.getElementById('goodiesBalanceBox').hidden = !shown.length;
    document.getElementById('goodiesBalances').innerHTML = `<ul class="goodies-balance-list">${shown.map(balanceHtml).join('')}</ul>`;

    document.getElementById('goodiesPaymentBox').hidden = !payments.length;
    document.getElementById('goodiesPaymentTitle').textContent = `Erledigte Zahlungen (${payments.length})`;
    document.getElementById('goodiesPayments').innerHTML = `<ul class="goodies-payment-list">${[...payments].reverse().map(paymentHtml).join('')}</ul>`;
}

// How transfers are suggested: for everybody the same (stored with the goodies)
const SETTLEMENT_HINTS = {
    simplified: 'So wenige Überweisungen wie möglich. Dabei kann es sein, dass du jemand anderem zahlst als dem, der deine Goodies ausgelegt hat — am Ende geht es für alle auf.',
    direct: 'Jeder zahlt an den, der seine Goodies ausgelegt hat. Wer selbst etwas ausgelegt und bekommen hat, verrechnet nur mit derselben Person.',
};

function renderGoodiesSettlement() {
    const mode = goodiesData?.settlement ?? 'simplified';
    document.querySelectorAll('#goodiesSettlementSwitch button').forEach(button => {
        const active = button.dataset.settlement === mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    const hint = document.getElementById('goodiesSettlementHint');
    hint.textContent = goodiesData?.transfers.length ? SETTLEMENT_HINTS[mode] : '';
    hint.hidden = !hint.textContent;
}

async function setGoodiesSettlement(mode) {
    if (!goodiesData || goodiesData.settlement === mode) return;
    // Payments made for the other way can look odd now (e.g. someone owes money back): say so
    if (goodiesData.payments.length && !(await confirmDialog(
        `Es sind schon ${goodiesData.payments.length} Zahlungen eingetragen. Sie bleiben gültig und die Summen stimmen weiter, aber Zahlungen, die nach der anderen Art geflossen sind, können jetzt als Rückzahlung oder Umweg auftauchen. Trotzdem umstellen?`,
        { title: 'Abrechnung umstellen?', confirmLabel: 'Umstellen', danger: false }))) return;
    try {
        applyGoodies(await apiFetch(`/events/${currentEventId}/goodies/settings`, { method: 'PUT', body: JSON.stringify({ settlement: mode }) }));
        announce(mode === 'direct' ? 'Abrechnung: direkt an den Zahler' : 'Abrechnung: wenigste Überweisungen');
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

function transferHtml(t) {
    const receiver = goodiesPerson(t.to_id);
    const mine = isMe(t.from_id) || isMe(t.to_id);
    const paypal = receiver?.paypal
        ? `<a class="btn btn-sm ${isMe(t.from_id) ? 'btn-primary' : 'btn-secondary'}" href="${escapeHtml(paypalUrl(receiver.paypal, t.amount))}" target="_blank" rel="noopener noreferrer" title="Öffnet paypal.me/${escapeHtml(receiver.paypal)} mit ${formatEuro(t.amount)}">${icon('external')}<span>Mit PayPal zahlen</span></a>`
        : (isAdmin ? `<button type="button" class="btn btn-ghost btn-sm admin-only" onclick="openGoodiesPaypal(${t.to_id})">${icon('plus')}<span>PayPal.me von ${escapeHtml(receiver?.name ?? '')}</span></button>` : '');
    return `<li class="goodies-transfer${mine ? ' is-mine' : ''}">
        <span class="goodies-transfer-who">
            <span class="goodies-from">${goodiesNameHtml(t.from_id)}</span>
            <span class="goodies-arrow" aria-label="zahlt an">${icon('arrow')}</span>
            <span class="goodies-to">${goodiesNameHtml(t.to_id)}</span>
        </span>
        <strong class="goodies-amount">${formatEuro(t.amount)}</strong>
        <span class="goodies-transfer-actions">
            ${paypal}
            <button type="button" class="btn btn-secondary btn-sm admin-only" onclick="markGoodiesTransferPaid(${t.from_id}, ${t.to_id}, ${t.amount})" title="Als bezahlt eintragen">${icon('check')}<span>Bezahlt</span></button>
        </span>
    </li>`;
}

function balanceHtml(b) {
    const person = goodiesPerson(b.person_id);
    const state = b.balance > 0 ? `bekommt ${formatEuro(b.balance)}` : b.balance < 0 ? `zahlt ${formatEuro(-b.balance)}` : 'ausgeglichen';
    const details = [
        b.received ? `Goodies für ${formatEuro(b.received)}` : '',
        b.paid ? `ausgelegt ${formatEuro(b.paid)}` : '',
        b.sent ? `gezahlt ${formatEuro(b.sent)}` : '',
        b.got ? `erhalten ${formatEuro(b.got)}` : '',
        b.open ? `${formatEuro(b.open)} noch ohne Zahler` : '',
        person?.paypal ? `paypal.me/${person.paypal}` : '',
    ].filter(Boolean).map(escapeHtml).join(' · ');
    return `<li class="goodies-balance${isMe(b.person_id) ? ' is-me' : ''}">
        <span class="goodies-balance-name">${goodiesNameHtml(b.person_id)}<span class="goodies-balance-details">${details}</span></span>
        <span class="goodies-balance-state ${b.balance > 0 ? 'is-plus' : b.balance < 0 ? 'is-minus' : ''}">${state}</span>
        <span class="goodies-paypal admin-only">
            <button type="button" class="btn btn-ghost btn-icon admin-only" onclick="openGoodiesPaypal(${b.person_id})" title="PayPal.me bearbeiten" aria-label="PayPal.me von ${escapeHtml(person?.name ?? '')} bearbeiten">${icon('edit')}</button>
        </span>
    </li>`;
}

function paymentHtml(p) {
    const date = new Date(p.at);
    const when = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<li class="goodies-payment">
        <span>${goodiesNameHtml(p.from_id)} ${icon('arrow')} ${goodiesNameHtml(p.to_id)}</span>
        <strong>${formatEuro(p.amount)}</strong>
        <span class="muted">${escapeHtml(when)}${p.note ? ` · ${escapeHtml(p.note)}` : ''}</span>
        ${actionMenu([{ icon: 'trash', label: 'Zahlung löschen', onclick: `deleteGoodiesPayment('${p.id}')`, adminOnly: true, danger: true }], 'Zahlung bearbeiten')}
    </li>`;
}

async function markGoodiesTransferPaid(fromId, toId, amount) {
    if (!(await confirmDialog(`${goodiesName(fromId)} hat ${formatEuro(amount)} an ${goodiesName(toId)} gezahlt?`, { title: 'Als bezahlt eintragen?', confirmLabel: 'Bezahlt', danger: false }))) return;
    await postGoodiesPayment({ from_id: fromId, to_id: toId, amount, note: '' });
}

async function postGoodiesPayment(payment) {
    try {
        applyGoodies(await apiFetch(`/events/${currentEventId}/goodies/payments`, { method: 'POST', body: JSON.stringify(payment) }));
        announce(`Zahlung von ${goodiesName(payment.from_id)} an ${goodiesName(payment.to_id)} eingetragen`);
        return true;
    } catch (error) {
        notify('❌ ' + error.message);
        return false;
    }
}

function openGoodiesPayment() {
    if (!goodiesData) return;
    document.getElementById('gpFrom').innerHTML = goodiesPersonOptions(null, '— bitte wählen —');
    document.getElementById('gpTo').innerHTML = goodiesPersonOptions(null, '— bitte wählen —');
    document.getElementById('gpAmount').value = '';
    document.getElementById('gpNote').value = '';
    openModal('goodiesPaymentModal');
}

async function saveGoodiesPayment(e) {
    e.preventDefault();
    const amount = parseEuro(document.getElementById('gpAmount').value);
    if (!amount) {
        notify('❌ Betrag: bitte als Betrag angeben, z.B. 20,00');
        return;
    }
    const ok = await postGoodiesPayment({
        from_id: Number(document.getElementById('gpFrom').value),
        to_id: Number(document.getElementById('gpTo').value),
        amount,
        note: document.getElementById('gpNote').value,
    });
    if (ok) closeModal('goodiesPaymentModal');
}

async function deleteGoodiesPayment(id) {
    const payment = goodiesData?.payments.find(p => p.id === id);
    if (!payment || !(await confirmDialog(`Zahlung von ${goodiesName(payment.from_id)} an ${goodiesName(payment.to_id)} über ${formatEuro(payment.amount)} löschen? Der Betrag ist dann wieder offen.`, { title: 'Zahlung löschen?' }))) return;
    try {
        applyGoodies(await apiFetch(`/events/${currentEventId}/goodies/payments/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

function openGoodiesPaypal(personId) {
    const person = goodiesPerson(personId);
    if (!person) return;
    document.getElementById('gppPerson').value = personId;
    document.getElementById('gppName').textContent = person.name;
    document.getElementById('gppInput').value = person.paypal;
    openModal('goodiesPaypalModal');
}

async function saveGoodiesPaypal(e) {
    e.preventDefault();
    try {
        applyGoodies(await apiFetch(`/events/${currentEventId}/goodies/paypal`, {
            method: 'PUT',
            body: JSON.stringify({ person_id: Number(document.getElementById('gppPerson').value), paypal: document.getElementById('gppInput').value })
        }));
        closeModal('goodiesPaypalModal');
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

/* Who gets what: one block per person
   ========================================================================== */

function goodiesItemLabel(item) {
    return `${item.quantity}× ${escapeHtml(item.name)}${item.variant ? ` <span class="goodies-variant">${escapeHtml(item.variant)}</span>` : ''}`;
}

function renderGoodiesItems() {
    const box = document.getElementById('goodiesItems');
    const summary = document.getElementById('goodiesItemSummary');
    if (!goodiesData) {
        box.innerHTML = '';
        summary.textContent = '';
        return;
    }
    const query = document.getElementById('goodiesSearch').value.trim().toLowerCase();
    const byPerson = new Map();
    for (const item of goodiesData.items) {
        if (!byPerson.has(item.recipient_id)) byPerson.set(item.recipient_id, []);
        byPerson.get(item.recipient_id).push(item);
    }
    const handed = goodiesData.items.filter(i => i.handed_out).length;
    summary.textContent = goodiesData.items.length
        ? `${byPerson.size} ${byPerson.size === 1 ? 'Person' : 'Personen'} · ${handed} von ${goodiesData.items.length} Einträgen ausgegeben`
        : '';

    const blocks = [...byPerson.entries()]
        .map(([personId, items]) => ({ personId, items, name: goodiesName(personId) }))
        .filter(({ personId, name, items }) => !query || `${name} ${goodiesPerson(personId)?.display_name ?? ''}`.toLowerCase().includes(query)
            || items.some(i => `${i.name} ${i.variant} ${i.note}`.toLowerCase().includes(query)))
        .sort((a, b) => Number(isMe(b.personId)) - Number(isMe(a.personId)) || a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));

    if (!blocks.length) {
        box.innerHTML = `<p class="empty-state">${goodiesData.items.length ? 'Keine Treffer.' : (goodiesData.people.length ? 'Noch nichts eingetragen.' : 'Das Event hat noch keine Teilnehmer oder Gäste.')}</p>`;
        return;
    }

    box.innerHTML = blocks.map(({ personId, items }) => {
        const total = items.reduce((sum, i) => sum + i.quantity * i.price, 0);
        const done = items.every(i => i.handed_out);
        return `<section class="goodies-person${isMe(personId) ? ' is-me' : ''}">
            <h3 class="goodies-person-head">
                <span>${goodiesNameHtml(personId)}${goodiesPerson(personId)?.guest ? '<span class="guest-tag">Gast</span>' : ''}</span>
                <span class="goodies-person-total">${done ? `<span class="goodies-done">${icon('check')}alles ausgegeben</span>` : ''}${formatEuro(total)}</span>
            </h3>
            <ul class="goodies-item-list">${items.map(goodiesItemHtml).join('')}</ul>
        </section>`;
    }).join('');
}

function goodiesItemHtml(item) {
    const payer = item.payer_id == null
        ? '<span class="goodies-unpaid">noch nicht bezahlt</span>'
        : item.payer_id === item.recipient_id ? 'selbst bezahlt' : `bezahlt von ${escapeHtml(goodiesName(item.payer_id))}`;
    const handedOut = isAdmin
        ? `<label class="goodies-check" title="Ausgegeben"><input type="checkbox" ${item.handed_out ? 'checked' : ''} onchange="toggleGoodiesHandedOut(this)"><span class="sr-only">ausgegeben</span></label>`
        : `<span class="goodies-check-static${item.handed_out ? ' is-done' : ''}" title="${item.handed_out ? 'Ausgegeben' : 'Noch nicht ausgegeben'}">${item.handed_out ? icon('check') : ''}</span>`;
    return `<li class="goodies-item${item.handed_out ? ' is-handed-out' : ''}" data-item="${escapeHtml(item.id)}">
        ${handedOut}
        <span class="goodies-item-main">
            <span class="goodies-item-name">${goodiesItemLabel(item)}</span>
            <span class="goodies-item-meta">${payer}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</span>
        </span>
        <span class="goodies-item-price">${formatEuro(item.quantity * item.price)}</span>
        <span class="goodies-item-actions admin-only">
            <button type="button" class="btn btn-ghost btn-icon" onclick="editGoodiesItem(this.closest('[data-item]').dataset.item)" title="Bearbeiten" aria-label="Bearbeiten">${icon('edit')}</button>
            ${actionMenu([{ icon: 'trash', label: 'Löschen', onclick: `deleteGoodiesItem(this.closest('[data-item]').dataset.item)`, adminOnly: true, danger: true }], 'Weitere Aktionen')}
        </span>
    </li>`;
}

/* Bulk order: pieces per article and variant
   ========================================================================== */

function renderGoodiesOrderSummary() {
    const box = document.getElementById('goodiesOrderSummary');
    const card = document.getElementById('goodiesOrderCard');
    const items = goodiesData?.items ?? [];
    card.hidden = !items.length;
    if (!items.length) {
        box.innerHTML = '';
        return;
    }
    const articles = new Map();
    for (const item of items) {
        if (!articles.has(item.name)) articles.set(item.name, new Map());
        const variants = articles.get(item.name);
        const entry = variants.get(item.variant) ?? { pieces: 0, handed: 0 };
        entry.pieces += item.quantity;
        if (item.handed_out) entry.handed += item.quantity;
        variants.set(item.variant, entry);
    }
    // Variants in catalog order (S, M, L, XL …), unknown ones alphabetically after them
    const variantOrder = name => goodiesData.articles.find(a => a.name === name)?.variants ?? [];
    const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
    box.innerHTML = `<div class="goodies-order-grid">${[...articles.entries()]
        .sort((a, b) => collator.compare(a[0], b[0]))
        .map(([name, variants]) => {
            const order = variantOrder(name);
            const rank = v => (order.indexOf(v) === -1 ? order.length : order.indexOf(v));
            const rows = [...variants.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || collator.compare(a[0], b[0]));
            const pieces = rows.reduce((sum, [, e]) => sum + e.pieces, 0);
            return `<div class="goodies-order">
                <h3>${escapeHtml(name)} <span class="muted">${pieces} Stück</span></h3>
                <ul>${rows.map(([variant, e]) => `<li><span>${variant ? escapeHtml(variant) : '<span class="muted">ohne Variante</span>'}</span><strong>${e.pieces}×</strong>${e.handed ? `<span class="muted">${e.handed} ausgegeben</span>` : '<span></span>'}</li>`).join('')}</ul>
            </div>`;
        }).join('')}</div>`;
}

/* Catalog editor (admins): rows of inputs, saved as a whole
   ========================================================================== */

function renderGoodiesArticles(force = false) {
    const box = document.getElementById('goodiesArticles');
    if (!goodiesData) {
        box.innerHTML = '';
        return;
    }
    // Do not throw away unsaved edits while the list is re-rendered after other changes
    if (!force && goodiesArticleDraft && box.contains(document.activeElement)) return;
    const articles = goodiesArticleDraft ?? goodiesData.articles.map(a => ({ ...a, priceText: euroInputValue(a.price), variantText: a.variants.join(', '), payerId: a.payer_id ?? null }));
    box.innerHTML = articles.length ? `
        <div class="goodies-article-head" aria-hidden="true"><span>Name</span><span>Preis/Stück</span><span>Varianten (mit Komma getrennt)</span><span>Bezahlt von</span><span></span></div>
        ${articles.map((a, i) => `
            <div class="goodies-article-row" data-index="${i}">
                <input type="text" class="ga-name" value="${escapeHtml(a.name)}" maxlength="60" placeholder="z.B. Hoodie" aria-label="Name von Artikel ${i + 1}">
                <input type="text" class="ga-price" value="${escapeHtml(a.priceText)}" inputmode="decimal" placeholder="0,00" aria-label="Preis von Artikel ${i + 1}">
                <input type="text" class="ga-variants" value="${escapeHtml(a.variantText)}" placeholder="S, M, L, XL" aria-label="Varianten von Artikel ${i + 1}">
                <select class="ga-payer" aria-label="Bezahlt von (Artikel ${i + 1})">${goodiesPersonOptions(a.payerId, '— noch niemand —')}</select>
                <button type="button" class="btn btn-ghost btn-icon" onclick="removeGoodiesArticleRow(${i})" title="Artikel entfernen" aria-label="Artikel ${i + 1} entfernen">${icon('trash')}</button>
            </div>`).join('')}`
        : '<p class="empty-state">Noch keine Artikel. Ohne Artikel lässt sich bei jedem Eintrag ein freier Name angeben.</p>';
    document.getElementById('goodiesArticlesSave').disabled = !goodiesArticleDraft;
}

function readGoodiesArticleRows() {
    goodiesArticleDraft = [...document.querySelectorAll('#goodiesArticles .goodies-article-row')].map(row => {
        const index = Number(row.dataset.index);
        const previous = (goodiesArticleDraft ?? goodiesData.articles)[index];
        return {
            id: previous?.id,
            name: row.querySelector('.ga-name').value,
            priceText: row.querySelector('.ga-price').value,
            variantText: row.querySelector('.ga-variants').value,
            payerId: row.querySelector('.ga-payer').value ? Number(row.querySelector('.ga-payer').value) : null,
        };
    });
    document.getElementById('goodiesArticlesSave').disabled = false;
}

function currentArticleDraft() {
    if (!goodiesArticleDraft) readGoodiesArticleRows();
    return goodiesArticleDraft;
}

function addGoodiesArticleRow() {
    const draft = currentArticleDraft();
    draft.push({ id: undefined, name: '', priceText: '', variantText: '', payerId: null });
    renderGoodiesArticles(true);
    document.querySelector('#goodiesArticles .goodies-article-row:last-child .ga-name')?.focus();
}

function removeGoodiesArticleRow(index) {
    currentArticleDraft().splice(index, 1);
    renderGoodiesArticles(true);
}

async function saveGoodiesArticles() {
    try {
        const articles = currentArticleDraft()
            .filter(a => a.name.trim() || a.priceText.trim() || a.variantText.trim())
            .map((a, i) => {
                const price = parseEuro(a.priceText);
                if (price === null) throw new Error(`Artikel ${i + 1}: Preis bitte als Betrag angeben, z.B. 45,00`);
                return { id: a.id, name: a.name, price, variants: a.variantText, payer_id: a.payerId };
            });
        const data = await apiFetch(`/events/${currentEventId}/goodies/articles`, { method: 'PUT', body: JSON.stringify({ articles }) });
        goodiesArticleDraft = null;
        document.activeElement?.blur();
        applyGoodies(data);
        applyGoodiesArticle('giNew'); // the chosen article may have a new payer
        notify('✅ Artikel gespeichert');
    } catch (error) {
        notify('❌ ' + error.message);
    }
}

/* Table import: paste an order list (name, then one column per article with sizes,
   optionally a column with the quantity)
   ========================================================================== */

let goodiesImport = null;          // { rows, columns } of the last parsed text
let goodiesImportColumns = [];     // column → article ID chosen by hand, QTY_COLUMN or '' (kept while the text changes)
const QTY_COLUMN = '__qty__';
const goodiesImportPeople = new Map(); // row name (lower case) → chosen person: id, 'new' or 'skip'

const EMPTY_CELL = /^[-–—_./]*$|^(nein|keins?|0)$/i;

function openGoodiesImport() {
    if (!goodiesData) return;
    document.getElementById('goodiesImportText').value = '';
    goodiesImport = null;
    goodiesImportColumns = [];
    goodiesImportPeople.clear();
    renderGoodiesImport();
    openModal('goodiesImportModal');
    document.getElementById('goodiesImportText').focus();
}

document.addEventListener('DOMContentLoaded', () => {
    const text = document.getElementById('goodiesImportText');
    text.addEventListener('input', () => {
        goodiesImport = parseGoodiesTable(text.value);
        renderGoodiesImport();
    });
    const preview = document.getElementById('goodiesImportPreview');
    preview.addEventListener('change', event => {
        const target = event.target;
        if (target.dataset.column !== undefined) {
            goodiesImportColumns[Number(target.dataset.column)] = target.value;
            goodiesImport = parseGoodiesTable(document.getElementById('goodiesImportText').value);
        }
        if (target.dataset.person !== undefined) goodiesImportPeople.set(target.dataset.person, target.value);
        renderGoodiesImport();
    });
});

// Size key: "xxl", "2 XL" and "2XL" are the same size; so are "XXXL" and "3XL"
function variantKey(value) {
    const compact = value.replace(/\s+/g, '').toUpperCase();
    const xs = compact.match(/^(X{2,})(S|L)$/);
    return xs ? `${xs[1].length}X${xs[2]}` : compact;
}

// "L+L" → [{ L, 2 }], "XL+2XL" → [{ XL, 1 }, { 2XL, 1 }], "2x XL" → [{ XL, 2 }], "-" → []
function parseSizeCell(cell) {
    const sizes = new Map();
    for (const raw of cell.split(/[+,;&]|\bund\b/i)) {
        const part = raw.trim();
        if (EMPTY_CELL.test(part)) continue;
        // "2x XL" / "2 × XL" is a quantity, "2XL" and "3 XL" are sizes
        const counted = part.match(/^(\d+)\s*(?:[x]\s+|[×*]\s*)(.+)$/i);
        const quantity = counted ? Number(counted[1]) : 1;
        const typed = (counted ? counted[2] : part).replace(/\s+/g, '');
        const key = variantKey(typed);
        const entry = sizes.get(key) ?? { typed: typed.toUpperCase(), quantity: 0 };
        entry.quantity += quantity;
        sizes.set(key, entry);
    }
    return [...sizes.entries()].map(([key, entry]) => ({ key, ...entry }));
}

function importNameKey(name) {
    return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Tabs from spreadsheets; semicolons from CSV files as fallback
function parseGoodiesTable(text) {
    const lines = text.split(/\r?\n/).map((line, i) => ({ line: i + 1, text: line })).filter(l => l.text.trim());
    const separator = lines.some(l => l.text.includes('\t')) ? '\t' : ';';
    let rows = lines.map(l => ({ line: l.line, cells: l.text.split(separator).map(c => c.trim()) }));
    // Rows without a name ("...", empty) are left out
    rows = rows.filter(r => /\p{L}/u.test(r.cells[0] ?? ''));

    // A first row naming articles is a header: it chooses the columns
    const articleByName = name => goodiesData.articles.find(a => importNameKey(a.name) === importNameKey(name));
    let header = null;
    if (rows.length && rows[0].cells.slice(1).some(c => c && articleByName(c))) {
        header = rows.shift().cells.slice(1);
    }
    const width = Math.max(0, ...rows.map(r => r.cells.length - 1), header?.length ?? 0);
    const raw = i => rows.map(r => r.cells[i + 1] ?? '').filter(c => c && !EMPTY_CELL.test(c));
    // Guess per column: header name, numbers only = quantity, else the article whose sizes fit best
    // ("5mm" → the mouse pad with "3 mm, 5 mm"), else the article in that position
    const unused = new Set(goodiesData.articles.map(a => a.id));
    const guesses = Array.from({ length: width }, (_, i) => {
        const fromHeader = header?.[i] ? articleByName(header[i]) : null;
        if (fromHeader) {
            unused.delete(fromHeader.id);
            return fromHeader.id;
        }
        if (raw(i).length && raw(i).every(c => /^\d+$/.test(c))) return QTY_COLUMN;
        if (header) return ''; // the header names the columns: an unknown title is ignored
        const keys = raw(i).flatMap(c => parseSizeCell(c).map(s => s.key));
        let best = null, bestScore = 0;
        for (const article of goodiesData.articles) {
            const variants = new Set(article.variants.map(variantKey));
            const score = keys.filter(k => variants.has(k)).length + (unused.has(article.id) ? 0.5 : 0);
            if (keys.some(k => variants.has(k)) && score > bestScore) [best, bestScore] = [article, score];
        }
        if (best) unused.delete(best.id); // the next column with the same sizes prefers another article
        return best?.id ?? null;
    });
    const columns = guesses.map((id, i) => {
        if (goodiesImportColumns[i] !== undefined) return goodiesImportColumns[i];
        if (id !== null) return id;
        return header ? '' : (goodiesData.articles[i]?.id ?? '');
    });
    return {
        columns,
        rows: rows.map(r => ({
            line: r.line,
            name: r.cells[0],
            raw: Array.from({ length: width }, (_, i) => r.cells[i + 1] ?? ''),
            cells: Array.from({ length: width }, (_, i) => (columns[i] === QTY_COLUMN ? [] : parseSizeCell(r.cells[i + 1] ?? ''))),
        })),
    };
}

// Quantity column: every size of the row counts that many times (empty = 1)
function importRowQuantity(row) {
    const index = goodiesImport.columns.indexOf(QTY_COLUMN);
    const value = index === -1 ? '' : row.raw[index].trim();
    return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : 1;
}

// Person of a row: chosen in the preview, else the one with this real name (or nickname)
function importPersonChoice(name) {
    const key = importNameKey(name);
    if (goodiesImportPeople.has(key)) return goodiesImportPeople.get(key);
    const byReal = goodiesData.people.filter(p => p.real_name && importNameKey(p.real_name) === key);
    if (byReal.length === 1) return String(byReal[0].id);
    if (byReal.length > 1) return '';
    const byNick = goodiesData.people.filter(p => importNameKey(p.display_name) === key);
    return byNick.length === 1 ? String(byNick[0].id) : 'new';
}

// Goodies of one row: article, size in the article's spelling, quantity; unknown sizes are flagged
function importRowItems(row) {
    const factor = importRowQuantity(row);
    const items = [];
    row.cells.forEach((sizes, i) => {
        const article = goodiesData.articles.find(a => a.id === goodiesImport.columns[i]);
        if (!article) return;
        for (const size of sizes) {
            const known = article.variants.find(v => variantKey(v) === size.key);
            items.push({ article, variant: known ?? size.typed, quantity: size.quantity * factor, unknown: article.variants.length > 0 && !known });
        }
    });
    return items;
}

function renderGoodiesImport() {
    const box = document.getElementById('goodiesImportPreview');
    const button = document.getElementById('goodiesImportButton');
    if (!goodiesImport || !goodiesImport.rows.length) {
        box.innerHTML = goodiesData && !goodiesData.articles.length
            ? '<p class="field-hint is-warning">Lege zuerst unter „Artikel“ an, was es gibt — die Spalten werden den Artikeln zugeordnet.</p>'
            : '';
        button.disabled = true;
        setButtonLabel(button, 'Eintragen');
        return;
    }
    const articleOptions = selected => `<option value="">— Spalte ignorieren —</option>`
        + `<option value="${QTY_COLUMN}"${selected === QTY_COLUMN ? ' selected' : ''}>Menge</option>`
        + goodiesData.articles.map(a => `<option value="${escapeHtml(a.id)}"${a.id === selected ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
    const personOptions = (choice, name) => `<option value="new"${choice === 'new' ? ' selected' : ''}>Neu als Gast „${escapeHtml(name)}“</option>`
        + `<option value="skip"${choice === 'skip' ? ' selected' : ''}>Zeile überspringen</option>`
        + `<option value=""${choice === '' ? ' selected' : ''} disabled>— Person wählen —</option>`
        + goodiesData.people.map(p => `<option value="${p.id}"${String(p.id) === choice ? ' selected' : ''}>${escapeHtml(p.name)}${p.guest ? ' (Gast)' : ''}</option>`).join('');

    let pieces = 0, people = 0, guests = 0, unresolved = 0, unknown = 0;
    const rowsHtml = goodiesImport.rows.map(row => {
        const choice = importPersonChoice(row.name);
        const items = importRowItems(row);
        const skip = choice === 'skip';
        if (!skip && items.length) {
            if (choice === '') unresolved++;
            else {
                people++;
                if (choice === 'new') guests++;
                pieces += items.reduce((sum, i) => sum + i.quantity, 0);
                unknown += items.filter(i => i.unknown).length;
            }
        }
        const existing = choice && choice !== 'new' && choice !== 'skip'
            ? goodiesData.items.filter(i => i.recipient_id === Number(choice) && items.some(it => it.article.id === i.article_id)).length
            : 0;
        const factor = importRowQuantity(row);
        const cells = row.cells.map((sizes, i) => {
            if (goodiesImport.columns[i] === QTY_COLUMN) return `<td>${factor > 1 ? `<strong>${factor}×</strong>` : '<span class="muted">1×</span>'}</td>`;
            const article = goodiesData.articles.find(a => a.id === goodiesImport.columns[i]);
            if (!sizes.length) return '<td class="muted">–</td>';
            return `<td${article ? '' : ' class="muted"'}>${sizes.map(size => {
                const known = article?.variants.find(v => variantKey(v) === size.key);
                const flagged = article && article.variants.length && !known;
                return `<span class="goodies-variant${flagged ? ' is-unknown' : ''}"${flagged ? ` title="Größe gibt es beim Artikel nicht — wird trotzdem so eingetragen"` : ''}>${size.quantity * factor > 1 ? `${size.quantity * factor}× ` : ''}${escapeHtml(known ?? size.typed)}</span>`;
            }).join(' ')}</td>`;
        }).join('');
        const status = skip ? '<span class="muted">übersprungen</span>'
            : !items.length ? '<span class="muted">nichts bestellt</span>'
            : choice === '' ? '<span class="status-error">Person wählen</span>'
            : existing ? `<span class="goodies-unpaid" title="Diese Person hat für diese Artikel schon Einträge — beim zweiten Import doppelt">hat schon ${existing}</span>`
            : '<span class="status-ok">OK</span>';
        return `<tr class="${skip || !items.length ? 'is-skipped' : ''}">
            <td class="col-name">${escapeHtml(row.name)}</td>
            <td><select class="select-sm" data-person="${escapeHtml(importNameKey(row.name))}" aria-label="Person für ${escapeHtml(row.name)}">${personOptions(choice, row.name)}</select></td>
            ${cells}
            <td>${status}</td>
        </tr>`;
    }).join('');

    box.innerHTML = `
        <p class="bulk-summary">
            <span class="info-badge badge-status">${pieces} Stück für ${people} ${people === 1 ? 'Person' : 'Personen'}</span>
            ${guests ? `<span class="info-badge">${guests} neue ${guests === 1 ? 'Gast' : 'Gäste'}</span>` : ''}
            ${unresolved ? `<span class="info-badge badge-error">${unresolved} ohne Person — werden übersprungen</span>` : ''}
            ${unknown ? `<span class="info-badge badge-error">${unknown} unbekannte Größe${unknown === 1 ? '' : 'n'}</span>` : ''}
        </p>
        <div class="table-wrap">
            <table class="attendee-table bulk-table goodies-import-table">
                <thead><tr>
                    <th>Name</th><th>Person</th>
                    ${goodiesImport.columns.map((id, i) => `<th><select class="select-sm" data-column="${i}" aria-label="Artikel für Spalte ${i + 2}">${articleOptions(id)}</select></th>`).join('')}
                    <th>Status</th>
                </tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>`;
    button.disabled = pieces === 0;
    setButtonLabel(button, pieces ? `${pieces} Stück eintragen` : 'Eintragen');
}

// New guests first (their IDs are needed), then all goodies in one request
async function runGoodiesImport() {
    const button = document.getElementById('goodiesImportButton');
    button.disabled = true;
    const created = [];
    try {
        const plan = goodiesImport.rows
            .map(row => ({ row, choice: importPersonChoice(row.name), items: importRowItems(row) }))
            .filter(p => p.items.length && p.choice !== '' && p.choice !== 'skip');
        const items = [];
        for (const { row, choice, items: rowItems } of plan) {
            let personId = Number(choice);
            if (choice === 'new') {
                const words = row.name.trim().split(/\s+/);
                const guest = await apiFetch(`/events/${currentEventId}/attendees`, {
                    method: 'POST',
                    body: JSON.stringify({ first_name: words.length > 1 ? words.slice(0, -1).join(' ') : words[0], last_name: words.length > 1 ? words.at(-1) : '', guest: true })
                });
                created.push(guest.display_name);
                personId = guest.id;
                goodiesImportPeople.set(importNameKey(row.name), String(personId)); // a retry does not create them twice
            }
            for (const item of rowItems) {
                items.push({ article_id: item.article.id, variant: item.variant, quantity: item.quantity, recipient_id: personId });
            }
        }
        const data = await apiFetch(`/events/${currentEventId}/goodies/items`, { method: 'POST', body: JSON.stringify({ items }) });
        closeModal('goodiesImportModal');
        await loadEvents();
        applyGoodies(data);
        const pieces = items.reduce((sum, i) => sum + i.quantity, 0);
        notify(`✅ ${pieces} Stück für ${plan.length} Personen eingetragen.${created.length ? ` Neue Gäste: ${created.join(', ')}` : ''}`);
    } catch (error) {
        if (created.length) {
            // The people view has to know the new guests, otherwise their rows show "Person wählen"
            goodiesData = await apiFetch(`/events/${currentEventId}/goodies`).catch(() => goodiesData);
            renderGoodiesImport();
        }
        notify('❌ ' + error.message + (created.length ? `\nSchon angelegt: ${created.join(', ')}` : ''));
        button.disabled = false;
    }
}
