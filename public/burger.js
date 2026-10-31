// Burger designer (#burger): everyone puts their burger together (drawn live as SVG) and orders it;
// admins see all orders, print them on DYMO labels (burger-labels.js) and/or show them on the
// tablet display (kitchen: waiting → started → done), and edit the menu.
// Server: src/burger.ts. Shares currentEventId/ensureCurrentEvent with lan.js; uses apiFetch,
// escapeHtml, icon, openModal/closeModal, setButtonLabel and isAdmin from app.js, `me` from welcome.js.

const BURGER_POLL_MS = 15000;
const BURGER_TOKENS_KEY = 'mcd.burgerTokens';
const BURGER_AUTO_PRINT_KEY = 'mcd.burgerAutoPrint';
const BURGER_KITCHEN_KEY = 'mcd.burgerKitchen';      // this device shows the tablet display
const BURGER_KITCHEN_SOUND_KEY = 'mcd.burgerKitchenSound';
const BURGER_KITCHEN_POLL_MS = 5000;
const BURGER_KITCHEN_LATE_MIN = 20; // waiting longer: marked

const BURGER_VISUALS = {
    size: 'Größe (Anzahl Patties)',
    patty: 'Patty',
    cheese: 'Käse',
    topping: 'Belag',
    sauce: 'Sauce',
    bun: 'Brötchen',
    none: 'nicht zeichnen',
};

const BURGER_SHAPES = {
    leaf: 'Salatblatt',
    slices: 'Scheiben (groß)',
    coins: 'Scheiben (klein)',
    rings: 'Ringe',
    crumbs: 'Krümel',
    strip: 'Streifen',
    slice: 'Käsescheibe',
    crumble: 'Käsestücke',
};

let burgerMenu = null;          // { open, categories, defaults }
let burgerOrders = [];
let burgerMeId = null;          // attendee of this device (IP), from the order list
let burgerAttendees = [];
let burgerSelection = null;     // { choices: { categoryId: [optionId] }, extra: Set }
let burgerEditingId = null;     // own order being changed
let burgerShownKeys = new Set(); // drawn layers, so new ones drop in
let burgerPollTimer = null;
let burgerPrinting = false;
let burgerMenuDraft = null;
let burgerShowAll = false;
let burgerKitchenTimer = null;
let burgerKitchenSeen = null;    // order ids already on the display (null = first render)
let burgerKitchenBusy = new Set();
let burgerWakeLock = null;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('burgerOrderForm').addEventListener('submit', submitBurgerOrder);
    document.getElementById('burgerMenuForm').addEventListener('submit', saveBurgerMenu);
    const auto = document.getElementById('burgerAutoPrint');
    try { auto.checked = localStorage.getItem(BURGER_AUTO_PRINT_KEY) === '1'; } catch { /* storage unavailable */ }
    auto.addEventListener('change', () => {
        try { localStorage.setItem(BURGER_AUTO_PRINT_KEY, auto.checked ? '1' : '0'); } catch { /* storage unavailable */ }
        if (auto.checked) autoPrintBurgers();
    });
    const sound = document.getElementById('burgerKitchenSound');
    try { sound.checked = localStorage.getItem(BURGER_KITCHEN_SOUND_KEY) !== '0'; } catch { /* storage unavailable */ }
    sound.addEventListener('change', () => {
        try { localStorage.setItem(BURGER_KITCHEN_SOUND_KEY, sound.checked ? '1' : '0'); } catch { /* storage unavailable */ }
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && burgerKitchenTimer) requestBurgerWakeLock();
    });
    document.addEventListener('fullscreenchange', updateKitchenFullscreenButton);
});

// Called by showView() in app.js whenever the burger tab opens
async function showBurgerView() {
    await loadEvents();
    ensureCurrentEvent();
    const select = document.getElementById('burgerEventSelect');
    const events = [...lanEvents].reverse();
    select.innerHTML = events.length
        ? events.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')
        : '<option value="">Noch kein Event — unter „Teilnehmer“ anlegen</option>';
    if (currentEventId != null) select.value = String(currentEventId);
    burgerMenu = await apiFetch('/burger/menu').catch(() => null);
    if (!burgerSelection) resetBurgerSelection();
    await loadBurgerEventData();
    clearInterval(burgerPollTimer);
    burgerPollTimer = setInterval(pollBurgerOrders, BURGER_POLL_MS);
    if (!burgerKitchenTimer && burgerKitchenRemembered()) openBurgerKitchen();
}

async function selectBurgerEvent(id) {
    currentEventId = Number(id);
    try { localStorage.setItem('mcd.attendeeEvent', String(currentEventId)); } catch { /* storage unavailable */ }
    updateBrandLogo();
    cancelBurgerEdit();
    await loadBurgerEventData();
}

async function loadBurgerEventData() {
    burgerAttendees = currentEventId != null ? await apiFetch(`/events/${currentEventId}/attendees`).catch(() => []) : [];
    burgerAttendees.sort((a, b) => a.display_name.localeCompare(b.display_name, 'de', { sensitivity: 'base' }));
    await loadBurgerOrders();
    renderBurgerWho();
    renderBurgerDesigner();
}

async function loadBurgerOrders() {
    const data = currentEventId != null
        ? await apiFetch(`/events/${currentEventId}/burger-orders`).catch(() => null)
        : { orders: [], me: null };
    if (!data) return false;
    burgerOrders = data.orders;
    burgerMeId = data.me;
    renderMyBurgerOrders();
    renderBurgerAdmin();
    renderBurgerKitchen();
    return true;
}

// Keeps the lists (status "beim Grill") current; also checks for new orders to print
async function pollBurgerOrders() {
    if (document.body.dataset.view !== 'burger') {
        clearInterval(burgerPollTimer);
        burgerPollTimer = null;
        return;
    }
    if (document.hidden) return;
    if (await loadBurgerOrders()) autoPrintBurgers();
}

/* Selection
   ========================================================================== */

const burgerCategories = () => burgerMenu?.categories ?? [];

function availableOptions(category) {
    return category.options.filter(o => o.available);
}

// Single categories start with their first available option, multiple ones empty
function resetBurgerSelection() {
    const choices = {};
    for (const category of burgerCategories()) {
        const first = availableOptions(category)[0];
        choices[category.id] = category.multiple || !first ? [] : [first.id];
    }
    burgerSelection = { choices, extra: new Set() };
}

function pickBurgerOption(categoryId, optionId) {
    const category = burgerCategories().find(c => c.id === categoryId);
    if (!category) return;
    const current = burgerSelection.choices[categoryId] ?? [];
    if (!category.multiple) {
        burgerSelection.choices[categoryId] = [optionId];
    } else if (current.includes(optionId)) {
        burgerSelection.choices[categoryId] = current.filter(id => id !== optionId);
        burgerSelection.extra.delete(optionId);
    } else {
        burgerSelection.choices[categoryId] = [...current, optionId];
    }
    renderBurgerDesigner();
}

function clearBurgerCategory(categoryId) {
    for (const id of burgerSelection.choices[categoryId] ?? []) burgerSelection.extra.delete(id);
    burgerSelection.choices[categoryId] = [];
    renderBurgerDesigner();
}

function toggleBurgerExtra(optionId) {
    if (burgerSelection.extra.has(optionId)) burgerSelection.extra.delete(optionId);
    else burgerSelection.extra.add(optionId);
    renderBurgerDesigner();
}

// Same text as summarizeOrder() in src/burger.ts
function burgerSummary(choices, extra) {
    const parts = [];
    for (const category of burgerCategories()) {
        const ids = choices[category.id] ?? [];
        const options = category.options.filter(o => ids.includes(o.id));
        if (!options.length && category.empty_label) parts.push(category.empty_label);
        for (const option of options) parts.push(`${extra.has(option.id) ? 'extra viel ' : ''}${option.short || option.name}`);
    }
    return parts.join(', ');
}

/* Drawing: layers from the bottom bun to the top bun, each { key, h, svg(y) }
   ========================================================================== */

const BURGER_W = 280;

// Darker (amount < 0) or lighter version of a hex colour
function shadeColor(hex, amount) {
    const value = /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : 0x999999;
    const channel = shift => {
        const c = (value >> shift) & 255;
        return Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
    };
    return `#${[16, 8, 0].map(s => channel(s).toString(16).padStart(2, '0')).join('')}`;
}

// Wavy line across the burger (sauce, bacon, lettuce edge)
function wavePath(y, amplitude, from = 28, to = BURGER_W - 28, waves = 7) {
    const step = (to - from) / waves;
    let d = `M${from} ${y}`;
    for (let i = 0; i < waves; i++) {
        d += ` q${step / 2} ${i % 2 ? amplitude : -amplitude} ${step} 0`;
    }
    return d;
}

const LAYER_SHAPES = {
    bunBottom: color => ({ h: 30, svg: y => `
        <path d="M30 ${y} H250 V${y + 16} Q250 ${y + 30} 234 ${y + 30} H46 Q30 ${y + 30} 30 ${y + 16} Z" fill="${color}"/>
        <rect x="30" y="${y}" width="220" height="7" fill="${shadeColor(color, 0.35)}"/>` }),
    bunTop: color => ({ h: 76, svg: y => {
        const seeds = [[92, 22, -20], [130, 14, 10], [170, 20, 30], [112, 38, 60], [152, 34, -40], [196, 40, 15], [72, 44, 40], [208, 56, -25], [130, 52, -10]];
        return `
        <path d="M22 ${y + 66} C22 ${y + 12} 76 ${y} 140 ${y} C204 ${y} 258 ${y + 12} 258 ${y + 66} Z" fill="${color}"/>
        <path d="M44 ${y + 30} C60 ${y + 14} 90 ${y + 8} 120 ${y + 8}" fill="none" stroke="${shadeColor(color, 0.35)}" stroke-width="6" stroke-linecap="round"/>
        <rect x="22" y="${y + 62}" width="236" height="14" rx="7" fill="${shadeColor(color, 0.3)}"/>
        ${seeds.map(([x, dy, r]) => `<ellipse cx="${x}" cy="${y + dy}" rx="4.5" ry="2.2" fill="#fff4dc" transform="rotate(${r} ${x} ${y + dy})"/>`).join('')}`;
    } }),
    patty: color => ({ h: 28, svg: y => `
        <rect x="26" y="${y}" width="228" height="28" rx="14" fill="${color}"/>
        <path d="${wavePath(y + 5, 2, 40, 240, 9)}" fill="none" stroke="${shadeColor(color, 0.25)}" stroke-width="2.5" stroke-linecap="round"/>
        ${[48, 78, 104, 136, 162, 194, 222, 64, 120, 178, 208].map((x, i) => `<circle cx="${x}" cy="${y + (i < 7 ? 15 : 21)}" r="${i % 3 ? 2.2 : 3}" fill="${shadeColor(color, -0.3)}"/>`).join('')}` }),
    slice: color => ({ h: 7, svg: y => `
        <path d="M22 ${y} H258 V${y + 6} H238 L228 ${y + 18} L220 ${y + 6} H170 L160 ${y + 22} L150 ${y + 6} H96 L86 ${y + 16} L78 ${y + 6} H22 Z" fill="${color}"/>` }),
    crumble: color => ({ h: 10, svg: y => [36, 66, 94, 126, 156, 188, 216, 238].map((x, i) => `
        <rect x="${x - 10}" y="${y + (i % 2 ? 1 : 3)}" width="${18 + (i % 3) * 3}" height="8" rx="3" fill="${color}"/>
        <circle cx="${x - 3}" cy="${y + 6}" r="1.4" fill="#4f78a8"/><circle cx="${x + 4}" cy="${y + 4.5}" r="1.1" fill="#3d6493"/>`).join('') }),
    sauce: (color, extra) => ({ h: extra ? 12 : 7, svg: y => {
        const h = extra ? 12 : 7;
        const drops = extra ? [70, 150, 214].map(x => `<ellipse cx="${x}" cy="${y + h + 2}" rx="4" ry="5" fill="${color}"/>`).join('') : '';
        return `<path d="${wavePath(y + h / 2, 2.5, 34, 246, 8)}" fill="none" stroke="${color}" stroke-width="${h}" stroke-linecap="round"/>${drops}`;
    } }),
    leaf: color => ({ h: 14, svg: y => `
        <path d="${wavePath(y + 4, 5, 16, 264, 10)} L264 ${y + 10} ${wavePath(y + 10, 4, 264, 16, 9).replace(/^M[\d.]+ [\d.]+/, '')} Z" fill="${color}" stroke="${shadeColor(color, -0.25)}" stroke-width="1.5" stroke-linejoin="round"/>` }),
    slices: color => ({ h: 12, svg: y => [64, 114, 166, 216].map(x => `
        <ellipse cx="${x}" cy="${y + 6}" rx="29" ry="6.5" fill="${color}"/>
        <ellipse cx="${x}" cy="${y + 5.5}" rx="20" ry="3.5" fill="${shadeColor(color, 0.3)}"/>`).join('') }),
    coins: color => ({ h: 8, svg: y => [52, 88, 122, 158, 192, 228].map((x, i) => `
        <ellipse cx="${x}" cy="${y + (i % 2 ? 3.5 : 4.5)}" rx="15" ry="4" fill="${color}" stroke="${shadeColor(color, -0.3)}" stroke-width="1"/>
        <circle cx="${x - 5}" cy="${y + 4}" r="1" fill="${shadeColor(color, 0.5)}"/><circle cx="${x + 4}" cy="${y + 3.5}" r="1" fill="${shadeColor(color, 0.5)}"/>`).join('') }),
    rings: color => ({ h: 8, svg: y => [58, 98, 140, 182, 222].map((x, i) => `
        <ellipse cx="${x}" cy="${y + 4}" rx="${19 - (i % 2) * 3}" ry="3.6" fill="none" stroke="${color}" stroke-width="2.6"/>`).join('') }),
    crumbs: color => ({ h: 8, svg: y => Array.from({ length: 26 }, (_, i) => {
        const x = 36 + i * 8.3, dy = (i * 7) % 5;
        return `<ellipse cx="${x}" cy="${y + 2 + dy}" rx="${3 + (i % 3)}" ry="1.8" fill="${i % 4 ? color : shadeColor(color, -0.3)}" transform="rotate(${(i * 37) % 60 - 30} ${x} ${y + 2 + dy})"/>`;
    }).join('') }),
    strip: color => ({ h: 11, svg: y => [0, 1].map(row => `
        <path d="${wavePath(y + 3 + row * 5, 3, 30 + row * 14, 236 + row * 14, 6)}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
        <path d="${wavePath(y + 3 + row * 5, 3, 30 + row * 14, 236 + row * 14, 6)}" fill="none" stroke="${shadeColor(color, 0.45)}" stroke-width="1.4" stroke-linecap="round"/>`).join('') }),
    band: color => ({ h: 8, svg: y => `<rect x="30" y="${y}" width="220" height="8" rx="4" fill="${color}"/>` }),
};

// Layers bottom → top: bun, sauces, lettuce/tomato, patties (cheese on each), other toppings, bun
function burgerLayers(choices, extra) {
    const chosen = category => category.options.filter(o => (choices[category.id] ?? []).includes(o.id));
    const byVisual = visual => burgerCategories().filter(c => c.visual === visual).flatMap(chosen);
    const bun = byVisual('bun')[0]?.color || '#e19a45';
    const size = byVisual('size')[0];
    const pattyCount = size ? size.count : 1;
    const pattyColor = byVisual('patty')[0]?.color || size?.color || '#5b3420';
    const cheeses = byVisual('cheese').filter(o => o.shape);
    const toppings = byVisual('topping');
    const under = toppings.filter(o => o.shape === 'leaf' || o.shape === 'slices');
    const over = toppings.filter(o => !under.includes(o));
    const toppingLayer = o => ({ key: `t-${o.id}`, ...(LAYER_SHAPES[o.shape] ?? LAYER_SHAPES.band)(o.color || '#999999') });

    const layers = [{ key: 'bun-bottom', ...LAYER_SHAPES.bunBottom(bun) }];
    for (const o of byVisual('sauce')) layers.push({ key: `s-${o.id}${extra.has(o.id) ? '-x' : ''}`, ...LAYER_SHAPES.sauce(o.color || '#f2a65a', extra.has(o.id)) });
    layers.push(...under.map(toppingLayer));
    for (let i = 0; i < pattyCount; i++) {
        layers.push({ key: `patty-${i}`, ...LAYER_SHAPES.patty(pattyColor) });
        for (const o of cheeses) layers.push({ key: `c-${o.id}-${i}`, ...(LAYER_SHAPES[o.shape] ?? LAYER_SHAPES.slice)(o.color || '#ffae1a') });
    }
    layers.push(...over.map(toppingLayer));
    layers.push({ key: 'bun-top', ...LAYER_SHAPES.bunTop(bun) });
    return layers;
}

// animate: new layers drop in (only the big designer burger)
function burgerSvg(choices, extra, { animate = false, className = 'burger-svg' } = {}) {
    const layers = burgerLayers(choices, extra);
    const total = layers.reduce((sum, l) => sum + l.h, 0);
    const height = Math.max(250, total + 40);
    let y = height - 16; // above the plate
    const parts = layers.map(layer => {
        y -= layer.h;
        const isNew = animate && burgerShownKeys.size > 0 && !burgerShownKeys.has(layer.key);
        return `<g class="burger-layer${isNew ? ' is-new' : ''}">${layer.svg(y)}</g>`;
    });
    if (animate) burgerShownKeys = new Set(layers.map(l => l.key));
    return `<svg class="${className}" viewBox="0 0 ${BURGER_W} ${height}" role="img" aria-label="Burger-Vorschau">
        <ellipse cx="${BURGER_W / 2}" cy="${height - 12}" rx="128" ry="9" fill="rgba(0,0,0,0.35)"/>
        ${parts.join('')}
    </svg>`;
}

/* Designer
   ========================================================================== */

function renderBurgerWho() {
    const select = document.getElementById('burgerWho');
    const meId = burgerMeId ?? (me?.status === 'identified' ? me.attendee.id : null);
    const previous = select.value;
    select.innerHTML = `<option value="">— bitte wählen —</option>`
        + burgerAttendees.map(a => `<option value="${a.id}">${escapeHtml(a.display_name)}${a.id === meId ? ' (du)' : ''}</option>`).join('')
        + (isAdmin ? '<option value="__name__">Anderer Name …</option>' : '');
    select.value = [...select.options].some(o => o.value === previous) && previous ? previous : (meId != null ? String(meId) : '');
    updateBurgerWhoName();
}

function updateBurgerWhoName() {
    const custom = document.getElementById('burgerWho').value === '__name__';
    document.getElementById('burgerWhoName').hidden = !custom;
}

function renderBurgerDesigner() {
    const box = document.getElementById('burgerSteps');
    const preview = document.getElementById('burgerPreview');
    const closedHint = document.getElementById('burgerClosed');
    if (!burgerMenu) {
        box.innerHTML = '<p class="empty-state">Die Speisekarte konnte nicht geladen werden.</p>';
        return;
    }
    closedHint.hidden = burgerMenu.open;
    closedHint.innerHTML = `${icon('lock')}<span>Die Bestellung ist gerade geschlossen.${isAdmin ? ' Als Admin kannst du trotzdem bestellen.' : ''}</span>`;

    // Options that disappeared from the menu (or became unavailable) drop out of the selection
    for (const category of burgerCategories()) {
        const valid = (burgerSelection.choices[category.id] ?? []).filter(id => availableOptions(category).some(o => o.id === id));
        const first = availableOptions(category)[0];
        burgerSelection.choices[category.id] = !category.multiple && !valid.length && first ? [first.id] : valid;
    }

    box.innerHTML = burgerCategories().map((category, index) => {
        const selected = burgerSelection.choices[category.id] ?? [];
        const chips = category.options.map(option => {
            const active = selected.includes(option.id);
            const extra = burgerSelection.extra.has(option.id);
            const swatch = option.color ? `<span class="burger-swatch" style="background:${escapeHtml(option.color)}"></span>` : '';
            return `
                <span class="burger-chip-wrap">
                    <button type="button" class="burger-chip${active ? ' is-active' : ''}" ${option.available ? '' : 'disabled title="Gerade nicht verfügbar"'}
                        data-category="${escapeHtml(category.id)}" data-option="${escapeHtml(option.id)}"
                        onclick="pickBurgerOption(this.dataset.category, this.dataset.option)" aria-pressed="${active}">
                        ${swatch}<span>${escapeHtml(option.name)}</span>${option.available ? '' : '<span class="burger-chip-off">aus</span>'}
                    </button>
                    ${category.extra && active ? `<button type="button" class="burger-extra${extra ? ' is-active' : ''}" data-option="${escapeHtml(option.id)}" onclick="toggleBurgerExtra(this.dataset.option)" aria-pressed="${extra}" title="Extra viel">extra viel</button>` : ''}
                </span>`;
        }).join('');
        const none = category.multiple
            ? `<button type="button" class="burger-chip burger-chip-none${selected.length ? '' : ' is-active'}" data-category="${escapeHtml(category.id)}" onclick="clearBurgerCategory(this.dataset.category)">${escapeHtml(category.empty_label || 'nichts')}</button>`
            : '';
        return `
            <div class="burger-step">
                <h3><span class="burger-step-no">${index + 1}</span>${escapeHtml(category.name)}${category.multiple ? '<span class="burger-step-hint">mehrere möglich</span>' : ''}</h3>
                <div class="burger-chips">${none}${chips}</div>
            </div>`;
    }).join('');

    preview.innerHTML = burgerSvg(burgerSelection.choices, burgerSelection.extra, { animate: true });
    document.getElementById('burgerSummary').textContent = burgerSummary(burgerSelection.choices, burgerSelection.extra);
    const editing = burgerEditingId != null; // IDs start at 0
    document.getElementById('burgerFormTitle').textContent = editing ? `Bestellung #${burgerOrders.find(o => o.id === burgerEditingId)?.number ?? ''} ändern` : 'Dein Burger';
    setButtonLabel(document.getElementById('burgerSubmit'), editing ? 'Änderung speichern' : 'Bestellen');
    document.getElementById('burgerCancelEdit').hidden = !editing;
    document.getElementById('burgerWho').disabled = editing;
}

async function submitBurgerOrder(e) {
    e.preventDefault();
    if (currentEventId == null) return;
    const who = document.getElementById('burgerWho').value;
    const body = {
        choices: burgerSelection.choices,
        extra: [...burgerSelection.extra],
        note: document.getElementById('burgerNote').value,
    };
    try {
        if (burgerEditingId != null) {
            await apiFetch(`/burger-orders/${burgerEditingId}`, { method: 'PUT', body: JSON.stringify(body), headers: burgerTokenHeader(burgerEditingId) });
            showBurgerMessage('Bestellung geändert.');
            cancelBurgerEdit();
        } else {
            if (!who) {
                alert('Bitte auswählen, für wen der Burger ist.');
                document.getElementById('burgerWho').focus();
                return;
            }
            if (who === '__name__') body.name = document.getElementById('burgerWhoName').value;
            else body.attendee_id = Number(who);
            const order = await apiFetch(`/events/${currentEventId}/burger-orders`, { method: 'POST', body: JSON.stringify(body) });
            storeBurgerToken(order.id, order.token);
            showBurgerMessage(`Bestellt! Deine Nummer: #${order.number}`);
            document.getElementById('burgerNote').value = '';
        }
        await loadBurgerOrders();
        autoPrintBurgers();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

function showBurgerMessage(text) {
    const box = document.getElementById('burgerMessage');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(showBurgerMessage.timer);
    showBurgerMessage.timer = setTimeout(() => { box.hidden = true; }, 6000);
}

/* Own orders: token in this browser or ordered for the attendee of this device
   ========================================================================== */

function burgerTokens() {
    try {
        return JSON.parse(localStorage.getItem(BURGER_TOKENS_KEY) || '{}') || {};
    } catch {
        return {};
    }
}

function storeBurgerToken(id, token) {
    const tokens = burgerTokens();
    tokens[id] = token;
    try { localStorage.setItem(BURGER_TOKENS_KEY, JSON.stringify(tokens)); } catch { /* storage unavailable */ }
}

function burgerTokenHeader(id) {
    const token = burgerTokens()[id];
    return token ? { 'X-Burger-Token': token } : {};
}

function isOwnBurgerOrder(order) {
    return order.id in burgerTokens() || (burgerMeId != null && order.attendee_id === burgerMeId);
}

const burgerTime = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

// Printed or being prepared: the orderer can't change it any more (same as isLocked in burger.ts)
const isBurgerLocked = order => !!(order.printed_at || order.started_at);

// Nothing left to do for the admin list: printed (if labels are on) and done (if the display is on)
function isBurgerHandled(order) {
    if (!burgerMenu?.print_labels && !burgerMenu?.kitchen_display) return false;
    return (!burgerMenu.print_labels || !!order.printed_at) && (!burgerMenu.kitchen_display || !!order.done_at);
}

function burgerStatus(order) {
    if (order.done_at) return `<span class="info-badge burger-status is-done">${icon('check')}fertig</span>`;
    return isBurgerLocked(order)
        ? `<span class="info-badge burger-status is-printed">${icon('check')}beim Grill</span>`
        : '<span class="info-badge burger-status">in der Warteschlange</span>';
}

function renderMyBurgerOrders() {
    const own = burgerOrders.filter(isOwnBurgerOrder);
    document.getElementById('burgerMineCard').style.display = own.length ? '' : 'none';
    document.getElementById('burgerMine').innerHTML = own.map(order => `
        <div class="burger-mine-item${order.id === burgerEditingId ? ' is-editing' : ''}">
            ${burgerSvg(order.choices, new Set(order.extra), { className: 'burger-thumb' })}
            <div class="burger-mine-body">
                <div class="burger-mine-head"><strong>#${order.number}</strong><span>${escapeHtml(order.name)}</span>${burgerStatus(order)}</div>
                <p>${escapeHtml(order.summary)}</p>
                ${order.note ? `<p class="burger-note">${escapeHtml(order.note)}</p>` : ''}
            </div>
            ${isBurgerLocked(order) ? '' : `
                <div class="burger-mine-actions">
                    <button class="btn btn-ghost btn-sm" data-id="${order.id}" onclick="editBurgerOrder(Number(this.dataset.id))">${icon('edit')}<span>Ändern</span></button>
                    <button class="btn btn-ghost btn-sm" data-id="${order.id}" onclick="cancelBurgerOrder(Number(this.dataset.id))">${icon('x')}<span>Stornieren</span></button>
                </div>`}
        </div>
    `).join('');
}

function editBurgerOrder(id) {
    const order = burgerOrders.find(o => o.id === id);
    if (!order) return;
    burgerEditingId = id;
    burgerSelection = { choices: structuredClone(order.choices), extra: new Set(order.extra) };
    document.getElementById('burgerNote').value = order.note;
    const who = document.getElementById('burgerWho');
    if (order.attendee_id != null) who.value = String(order.attendee_id);
    renderBurgerDesigner();
    renderMyBurgerOrders();
    document.getElementById('burgerDesignerCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelBurgerEdit() {
    if (burgerEditingId == null) return;
    burgerEditingId = null;
    document.getElementById('burgerNote').value = '';
    resetBurgerSelection();
    renderBurgerWho();
    renderBurgerDesigner();
    renderMyBurgerOrders();
}

async function cancelBurgerOrder(id) {
    const order = burgerOrders.find(o => o.id === id);
    if (!order || !confirm(`Bestellung #${order.number} (${order.name}) stornieren?`)) return;
    try {
        await apiFetch(`/burger-orders/${id}`, { method: 'DELETE', headers: burgerTokenHeader(id) });
        if (burgerEditingId === id) cancelBurgerEdit();
        await loadBurgerOrders();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

/* Admin: all orders, printing, totals
   ========================================================================== */

function renderBurgerAdmin() {
    const printing = !!burgerMenu?.print_labels;
    const display = !!burgerMenu?.kitchen_display;
    const unprinted = burgerOrders.filter(o => !o.printed_at);
    const button = document.getElementById('burgerPrintNew');
    setButtonLabel(button, unprinted.length ? `Neue drucken (${unprinted.length})` : 'Keine neuen');
    button.disabled = !unprinted.length || burgerPrinting;
    document.querySelectorAll('.burger-print-only').forEach(el => { el.hidden = !printing; });
    document.getElementById('burgerKitchenOpen').hidden = !display;
    document.getElementById('burgerDisplayHint').hidden = !display;
    document.getElementById('burgerOpenToggle').checked = !!burgerMenu?.open;
    document.getElementById('burgerPrintToggle').checked = printing;
    document.getElementById('burgerDisplayToggle').checked = display;
    document.getElementById('burgerShowAll').checked = burgerShowAll;
    const open = burgerOrders.filter(o => !isBurgerHandled(o));
    const parts = [`${open.length} offen`];
    if (printing) parts.push(`${burgerOrders.length - unprinted.length} gedruckt`);
    if (display) parts.push(`${burgerOrders.filter(o => o.done_at).length} fertig`);
    document.getElementById('burgerCounts').textContent = burgerOrders.length
        ? `${burgerOrders.length} Bestellung${burgerOrders.length === 1 ? '' : 'en'} · ${parts.join(' · ')}`
        : 'Noch keine Bestellungen';
    renderBurgerTotals();

    const shown = burgerShowAll ? burgerOrders : open;
    document.getElementById('burgerOrderList').innerHTML = shown.length ? shown.map(order => `
        <div class="burger-order${isBurgerHandled(order) ? ' is-printed' : ''}">
            <span class="burger-order-no">#${order.number}</span>
            <div class="burger-order-body">
                <div class="burger-mine-head"><strong>${escapeHtml(order.name)}</strong><span class="burger-order-time">${escapeHtml(burgerTime(order.created_at))}</span>${burgerStatus(order)}</div>
                <p>${escapeHtml(order.summary)}</p>
                ${order.note ? `<p class="burger-note">${escapeHtml(order.note)}</p>` : ''}
            </div>
            <div class="burger-order-actions">
                ${display ? `<button class="btn btn-ghost btn-icon" data-id="${order.id}" data-state="${order.done_at ? 'started' : 'done'}" onclick="setBurgerKitchenState(Number(this.dataset.id), this.dataset.state)" title="${order.done_at ? 'Doch nicht fertig (zurück auf die Anzeige)' : 'Als fertig markieren'}" aria-label="Fertig">${icon(order.done_at ? 'refresh' : 'check')}</button>` : ''}
                ${printing ? `<button class="btn btn-ghost btn-icon" data-id="${order.id}" onclick="printBurgerOrders([Number(this.dataset.id)])" title="${order.printed_at ? 'Erneut drucken' : 'Jetzt drucken'}" aria-label="Drucken">${icon('file')}</button>` : ''}
                ${printing && order.printed_at ? `<button class="btn btn-ghost btn-icon" data-id="${order.id}" onclick="requeueBurgerOrder(Number(this.dataset.id))" title="Zurück in die Warteschlange (wird beim nächsten Druck mitgedruckt)" aria-label="Zurück in die Warteschlange">${icon('refresh')}</button>` : ''}
                <button class="btn btn-ghost btn-icon" data-id="${order.id}" onclick="deleteBurgerOrder(Number(this.dataset.id))" title="Löschen" aria-label="Löschen">${icon('trash')}</button>
            </div>
        </div>
    `).join('') : `<p class="empty-state">${burgerOrders.length ? 'Alles erledigt.' : 'Noch keine Bestellungen.'}</p>`;
}

// What the grill needs: patties per kind (size × patty) and how often each option was chosen
function renderBurgerTotals() {
    const counts = new Map();
    const add = (label, n = 1) => counts.set(label, (counts.get(label) ?? 0) + n);
    const sizeCategory = burgerCategories().find(c => c.visual === 'size');
    const pattyCategory = burgerCategories().find(c => c.visual === 'patty');
    for (const order of burgerOrders) {
        const size = sizeCategory?.options.find(o => (order.choices[sizeCategory.id] ?? []).includes(o.id));
        const patty = pattyCategory?.options.find(o => (order.choices[pattyCategory.id] ?? []).includes(o.id));
        if (size || patty) add(`Patty ${patty ? patty.short || patty.name : ''}`.trim(), size ? size.count : 1);
        for (const category of burgerCategories()) {
            if (category.visual === 'size' || category.visual === 'patty') continue;
            for (const option of category.options.filter(o => (order.choices[category.id] ?? []).includes(o.id))) {
                add(option.short || option.name);
            }
        }
    }
    document.getElementById('burgerTotals').innerHTML = [...counts]
        .map(([label, n]) => `<span class="burger-total"><strong>${n}×</strong> ${escapeHtml(label)}</span>`).join('');
}

function toggleBurgerShowAll(checked) {
    burgerShowAll = checked;
    renderBurgerAdmin();
}

// ids: reprint exactly these; without ids all orders that are not printed yet
async function printBurgerOrders(ids) {
    if (burgerPrinting || currentEventId == null) return;
    const reprint = ids && burgerOrders.filter(o => ids.includes(o.id) && o.printed_at);
    if (reprint?.length && !confirm(`Bestellung #${reprint.map(o => o.number).join(', #')} wurde schon gedruckt. Trotzdem noch einmal drucken?`)) return;
    burgerPrinting = true;
    renderBurgerAdmin();
    try {
        const { orders } = await apiFetch(`/events/${currentEventId}/burger-orders/print`, { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) });
        if (orders.length) printBurgerLabels(lanEvents.find(e => e.id === currentEventId), orders);
    } catch (error) {
        alert('❌ ' + error.message);
    } finally {
        burgerPrinting = false;
        await loadBurgerOrders();
    }
}

// The print PC keeps the page open: new orders come out by themselves
function autoPrintBurgers() {
    if (!isAdmin || burgerPrinting || !burgerMenu?.print_labels || !document.getElementById('burgerAutoPrint').checked) return;
    if (burgerOrders.some(o => !o.printed_at)) printBurgerOrders();
}

async function requeueBurgerOrder(id) {
    try {
        await apiFetch(`/burger-orders/${id}/unprint`, { method: 'POST', body: '{}' });
        await loadBurgerOrders();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function deleteBurgerOrder(id) {
    const order = burgerOrders.find(o => o.id === id);
    if (!order || !confirm(`Bestellung #${order.number} von ${order.name} löschen?`)) return;
    try {
        await apiFetch(`/burger-orders/${id}`, { method: 'DELETE' });
        await loadBurgerOrders();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

async function storeBurgerMenu(menu) {
    const { open, print_labels, kitchen_display, categories } = menu;
    burgerMenu = await apiFetch('/burger/menu', { method: 'PUT', body: JSON.stringify({ open, print_labels, kitchen_display, categories }) });
    renderBurgerDesigner();
    renderBurgerAdmin();
    if (!burgerMenu.kitchen_display) closeBurgerKitchen();
}

// key: open, print_labels or kitchen_display
async function setBurgerMenuSwitch(key, value) {
    try {
        await storeBurgerMenu({ ...burgerMenu, [key]: value });
    } catch (error) {
        alert('❌ ' + error.message);
        renderBurgerAdmin();
    }
}

/* Menu editor: works on a copy, sends the whole menu
   ========================================================================== */

function openBurgerMenuModal() {
    if (!burgerMenu) return;
    const { open, print_labels, kitchen_display, categories } = burgerMenu;
    burgerMenuDraft = structuredClone({ open, print_labels, kitchen_display, categories });
    renderBurgerMenuEditor();
    openModal('burgerMenuModal');
}

function resetBurgerMenuDraft() {
    if (!confirm('Alle Kategorien und Zutaten auf den Standard zurücksetzen? Eigene Zutaten gehen dabei verloren (erst beim Speichern).')) return;
    burgerMenuDraft = structuredClone({ open: burgerMenuDraft.open, categories: burgerMenu.defaults.categories });
    renderBurgerMenuEditor();
}

function renderBurgerMenuEditor() {
    const visualOptions = selected => Object.entries(BURGER_VISUALS)
        .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
    const shapeOptions = (visual, selected) => `<option value="">${visual === 'cheese' ? 'nicht zeichnen' : 'Streifen (einfach)'}</option>` + Object.entries(BURGER_SHAPES)
        .filter(([value]) => (visual === 'cheese') === (value === 'slice' || value === 'crumble'))
        .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');

    document.getElementById('burgerMenuEditor').innerHTML = burgerMenuDraft.categories.map((category, ci) => {
        const hasShape = category.visual === 'topping' || category.visual === 'cheese';
        return `
        <fieldset class="burger-edit-category" data-ci="${ci}">
            <div class="burger-edit-head">
                <input type="text" value="${escapeHtml(category.name)}" maxlength="40" required aria-label="Name der Kategorie" data-field="name" oninput="setBurgerDraft(this)">
                <select data-field="visual" onchange="setBurgerDraft(this, true)" aria-label="Darstellung">${visualOptions(category.visual)}</select>
                <label class="toggle toggle-sm"><input type="checkbox" data-field="multiple" ${category.multiple ? 'checked' : ''} onchange="setBurgerDraft(this, true)"> mehrere</label>
                ${category.multiple ? `
                    <label class="toggle toggle-sm"><input type="checkbox" data-field="extra" ${category.extra ? 'checked' : ''} onchange="setBurgerDraft(this)"> „extra viel“</label>
                    <input type="text" class="burger-edit-empty" value="${escapeHtml(category.empty_label)}" maxlength="30" placeholder="nichts gewählt, z.B. ohne Sauce" aria-label="Text, wenn nichts gewählt ist" data-field="empty_label" oninput="setBurgerDraft(this)">` : ''}
                <span class="burger-edit-tools">
                    <button type="button" class="btn btn-ghost btn-icon burger-up" data-ci="${ci}" onclick="moveBurgerDraft(Number(this.dataset.ci))" ${ci ? '' : 'disabled'} title="Nach oben" aria-label="Nach oben">${icon('chevron')}</button>
                    <button type="button" class="btn btn-ghost btn-icon" data-ci="${ci}" onclick="removeBurgerDraft(Number(this.dataset.ci))" title="Kategorie löschen" aria-label="Kategorie löschen">${icon('trash')}</button>
                </span>
            </div>
            <div class="burger-edit-options">
                <div class="burger-edit-option burger-edit-labels">
                    <span>Zutat</span><span>auf dem Etikett</span><span>Farbe</span><span>${category.visual === 'size' ? 'Patties' : hasShape ? 'Form' : ''}</span><span>da</span><span></span>
                </div>
                ${category.options.map((option, oi) => `
                    <div class="burger-edit-option" data-oi="${oi}">
                        <input type="text" value="${escapeHtml(option.name)}" maxlength="40" required aria-label="Zutat" data-field="name" oninput="setBurgerDraft(this)">
                        <input type="text" value="${escapeHtml(option.short)}" maxlength="30" placeholder="wie Zutat" aria-label="Text auf dem Etikett" data-field="short" oninput="setBurgerDraft(this)">
                        <input type="color" value="${escapeHtml(option.color || '#999999')}" aria-label="Farbe" data-field="color" oninput="setBurgerDraft(this)">
                        ${category.visual === 'size'
                            ? `<input type="number" min="0" max="4" value="${option.count}" aria-label="Anzahl Patties" data-field="count" oninput="setBurgerDraft(this)">`
                            : hasShape ? `<select data-field="shape" onchange="setBurgerDraft(this)" aria-label="Form">${shapeOptions(category.visual, option.shape)}</select>` : '<span></span>'}
                        <input type="checkbox" ${option.available ? 'checked' : ''} title="Verfügbar" aria-label="Verfügbar" data-field="available" onchange="setBurgerDraft(this)">
                        <span class="burger-edit-tools">
                            <button type="button" class="btn btn-ghost btn-icon burger-up" data-ci="${ci}" data-oi="${oi}" onclick="moveBurgerDraft(Number(this.dataset.ci), Number(this.dataset.oi))" ${oi ? '' : 'disabled'} title="Nach oben" aria-label="Nach oben">${icon('chevron')}</button>
                            <button type="button" class="btn btn-ghost btn-icon" data-ci="${ci}" data-oi="${oi}" onclick="removeBurgerDraft(Number(this.dataset.ci), Number(this.dataset.oi))" title="Zutat löschen" aria-label="Zutat löschen">${icon('x')}</button>
                        </span>
                    </div>`).join('')}
                <button type="button" class="btn btn-ghost btn-sm" data-ci="${ci}" onclick="addBurgerDraftOption(Number(this.dataset.ci))">${icon('plus')}<span>Zutat</span></button>
            </div>
        </fieldset>`;
    }).join('');
}

// Field change from the editor; structural ones (darstellung, mehrere) render again
function setBurgerDraft(input, rerender = false) {
    const category = burgerMenuDraft.categories[Number(input.closest('[data-ci]').dataset.ci)];
    const optionRow = input.closest('[data-oi]');
    const target = optionRow ? category.options[Number(optionRow.dataset.oi)] : category;
    const field = input.dataset.field;
    target[field] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    if (rerender) renderBurgerMenuEditor();
}

function moveBurgerDraft(ci, oi) {
    const list = oi === undefined ? burgerMenuDraft.categories : burgerMenuDraft.categories[ci].options;
    const index = oi === undefined ? ci : oi;
    if (index < 1) return;
    [list[index - 1], list[index]] = [list[index], list[index - 1]];
    renderBurgerMenuEditor();
}

function removeBurgerDraft(ci, oi) {
    if (oi === undefined) {
        if (!confirm(`Kategorie „${burgerMenuDraft.categories[ci].name}“ mit allen Zutaten entfernen?`)) return;
        burgerMenuDraft.categories.splice(ci, 1);
    } else {
        burgerMenuDraft.categories[ci].options.splice(oi, 1);
    }
    renderBurgerMenuEditor();
}

function addBurgerDraftOption(ci) {
    const category = burgerMenuDraft.categories[ci];
    category.options.push({ name: '', short: '', color: '#999999', shape: category.visual === 'topping' ? 'strip' : '', count: category.visual === 'size' ? 1 : 0, available: true });
    renderBurgerMenuEditor();
    document.querySelector(`#burgerMenuEditor [data-ci="${ci}"] .burger-edit-option:last-of-type input`)?.focus();
}

function addBurgerDraftCategory() {
    burgerMenuDraft.categories.push({ name: 'Neue Kategorie', visual: 'topping', multiple: true, extra: false, empty_label: '', options: [] });
    addBurgerDraftOption(burgerMenuDraft.categories.length - 1);
}

async function saveBurgerMenu(e) {
    e.preventDefault();
    try {
        await storeBurgerMenu(burgerMenuDraft);
        closeModal('burgerMenuModal');
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

/* Tablet display (kitchen): full screen over the page, columns "Neu" and "In Arbeit"
   ========================================================================== */

function burgerKitchenRemembered() {
    try { return localStorage.getItem(BURGER_KITCHEN_KEY) === '1'; } catch { return false; }
}

function rememberBurgerKitchen(on) {
    try { localStorage.setItem(BURGER_KITCHEN_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

function openBurgerKitchen() {
    if (!isAdmin || !burgerMenu?.kitchen_display) return;
    rememberBurgerKitchen(true);
    burgerKitchenSeen = null;
    document.getElementById('burgerKitchen').hidden = false;
    document.body.classList.add('burger-kitchen-open');
    renderBurgerKitchen();
    clearInterval(burgerKitchenTimer);
    burgerKitchenTimer = setInterval(pollBurgerKitchen, BURGER_KITCHEN_POLL_MS);
    requestBurgerWakeLock();
    updateKitchenFullscreenButton();
}

// leave: the user closed it (forget it on this device); otherwise only hidden (menu switch, logout)
function closeBurgerKitchen(leave = false) {
    if (leave) rememberBurgerKitchen(false);
    clearInterval(burgerKitchenTimer);
    burgerKitchenTimer = null;
    document.getElementById('burgerKitchen').hidden = true;
    document.body.classList.remove('burger-kitchen-open');
    burgerWakeLock?.release().catch(() => {});
    burgerWakeLock = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

async function pollBurgerKitchen() {
    if (document.body.dataset.view !== 'burger' || !isAdmin) {
        closeBurgerKitchen();
        return;
    }
    if (!document.hidden) await loadBurgerOrders();
}

// The tablet shouldn't go dark while the display is open
async function requestBurgerWakeLock() {
    try {
        burgerWakeLock = await navigator.wakeLock?.request('screen') ?? null;
    } catch {
        burgerWakeLock = null; // not supported or not allowed: the display still works
    }
}

function toggleKitchenFullscreen() {
    const page = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else page.requestFullscreen?.().catch(() => {});
}

function updateKitchenFullscreenButton() {
    const button = document.getElementById('burgerKitchenFullscreen');
    button.hidden = !document.documentElement.requestFullscreen;
    setButtonLabel(button, document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild');
}

// Short double beep for new orders (only after the display was opened by a tap — browsers
// don't play sound before that)
function burgerKitchenBeep() {
    if (!document.getElementById('burgerKitchenSound').checked) return;
    try {
        const audio = burgerKitchenBeep.context ??= new AudioContext();
        for (const start of [0, 0.22]) {
            const tone = audio.createOscillator();
            const gain = audio.createGain();
            tone.frequency.value = 880;
            gain.gain.setValueAtTime(0.25, audio.currentTime + start);
            gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + start + 0.18);
            tone.connect(gain).connect(audio.destination);
            tone.start(audio.currentTime + start);
            tone.stop(audio.currentTime + start + 0.2);
        }
    } catch { /* no audio */ }
}

const burgerAge = iso => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));

function kitchenCard(order) {
    const started = !!order.started_at;
    const age = burgerAge(order.created_at);
    const busy = burgerKitchenBusy.has(order.id);
    const isNew = burgerKitchenSeen && !burgerKitchenSeen.has(order.id);
    const classes = ['kitchen-card', started ? 'is-started' : '', !started && age >= BURGER_KITCHEN_LATE_MIN ? 'is-late' : '', isNew ? 'is-new' : ''];
    return `
        <article class="${classes.filter(Boolean).join(' ')}">
            <header class="kitchen-card-head">
                <span class="kitchen-no">#${order.number}</span>
                <strong class="kitchen-name">${escapeHtml(order.name)}</strong>
                <span class="kitchen-age" title="bestellt um ${escapeHtml(burgerTime(order.created_at))} Uhr">${age < 1 ? 'gerade eben' : `vor ${age} min`}${order.printed_at ? ` · ${icon('file')}` : ''}</span>
            </header>
            <div class="kitchen-card-body">
                ${burgerSvg(order.choices, new Set(order.extra), { className: 'kitchen-burger' })}
                <div>
                    <p class="kitchen-summary">${escapeHtml(order.summary)}</p>
                    ${order.note ? `<p class="kitchen-note">${icon('alert')}${escapeHtml(order.note)}</p>` : ''}
                </div>
            </div>
            <footer class="kitchen-card-actions">
                ${started ? `<button class="btn btn-ghost" data-id="${order.id}" onclick="setBurgerKitchenState(Number(this.dataset.id), 'waiting')" title="Zurück zu „Neu“" aria-label="Zurück zu Neu"${busy ? ' disabled' : ''}>${icon('refresh')}</button>` : ''}
                <button class="btn ${started ? 'btn-success' : 'btn-primary'} kitchen-main-action" data-id="${order.id}" data-state="${started ? 'done' : 'started'}" onclick="setBurgerKitchenState(Number(this.dataset.id), this.dataset.state)"${busy ? ' disabled' : ''}>
                    ${icon(started ? 'check' : 'burger')}<span>${started ? 'Fertig' : 'Zubereiten'}</span>
                </button>
            </footer>
        </article>`;
}

function renderBurgerKitchen() {
    const box = document.getElementById('burgerKitchen');
    if (box.hidden) return;
    const event = lanEvents.find(e => e.id === currentEventId);
    document.getElementById('burgerKitchenEvent').textContent = event ? event.name : '';
    const active = burgerOrders.filter(o => !o.done_at);
    const waiting = active.filter(o => !o.started_at);
    const started = active.filter(o => o.started_at);
    const done = burgerOrders.filter(o => o.done_at).sort((a, b) => b.done_at.localeCompare(a.done_at)).slice(0, 8);
    if (burgerKitchenSeen && waiting.some(o => !burgerKitchenSeen.has(o.id))) burgerKitchenBeep();

    document.getElementById('burgerKitchenWaitingCount').textContent = waiting.length;
    document.getElementById('burgerKitchenStartedCount').textContent = started.length;
    document.getElementById('burgerKitchenWaiting').innerHTML = waiting.map(kitchenCard).join('') || '<p class="kitchen-empty">Keine neuen Bestellungen.</p>';
    document.getElementById('burgerKitchenStarted').innerHTML = started.map(kitchenCard).join('') || '<p class="kitchen-empty">Gerade wird nichts zubereitet.</p>';
    document.getElementById('burgerKitchenDone').innerHTML = done.length
        ? done.map(o => `<button class="kitchen-done-item" data-id="${o.id}" onclick="setBurgerKitchenState(Number(this.dataset.id), 'started')" title="Doch nicht fertig: zurück zu „In Arbeit“"><strong>#${o.number}</strong> ${escapeHtml(o.name)}</button>`).join('')
        : '<span class="kitchen-empty">noch nichts</span>';
    burgerKitchenSeen = new Set(active.map(o => o.id));
}

async function setBurgerKitchenState(id, state) {
    if (burgerKitchenBusy.has(id)) return;
    burgerKitchenBusy.add(id);
    renderBurgerKitchen();
    try {
        await apiFetch(`/burger-orders/${id}/kitchen`, { method: 'POST', body: JSON.stringify({ state }) });
    } catch (error) {
        alert('❌ ' + error.message);
    } finally {
        burgerKitchenBusy.delete(id);
        await loadBurgerOrders();
    }
}
