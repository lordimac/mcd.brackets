// IP slips: one DIN A4 page per attendee with addresses, DNS names and network settings.
// Drawn as vector PDF with jsPDF (crisp when printed). Uses lanEvents/attendees/currentEventId
// from lan.js and setButtonLabel from app.js.

// Print version of the „Patchkabel & Etikett“ design (design-system/mcd-lan/MASTER.md):
// white paper, rack greys, the wire colours as bands, titles on label tape, tiny radii.
const SLIP = {
    width: 210,
    margin: 18,
    radius: 0.8,
    accent: [255, 69, 0],
    accentSoft: [255, 233, 224],
    onAccent: [29, 32, 35],
    text: [29, 32, 35],
    muted: [74, 81, 77],
    faint: [141, 148, 144],
    fill: [236, 238, 235],
    border: [203, 208, 204],
    link: [31, 95, 191],
    tapeShadow: [170, 176, 172],
    // Band colours of the areas (same as --band-* in styles.css)
    blue: [31, 95, 191],
    green: [46, 125, 56],
    violet: [106, 79, 179],
    brown: [122, 74, 38],
    yellow: [230, 187, 30],
};

function slipFileSlug(value) {
    return value.toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
}

// Small bold heading in sentence case
function slipLabel(doc, text, x, y, color = SLIP.muted, size = 8.5) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size + 0.5);
    doc.setTextColor(...color);
    doc.text(text, x, y);
}

// Label tape: coloured band with a slanted right edge and a hard offset shadow, text in
// bold. top = upper edge of the band. Light text on dark bands, dark text on orange.
// Returns the size of the band.
function slipTape(doc, text, x, top, { color = SLIP.accent, size = 11 } = {}) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    const h = size * 0.3528 * 1.5;
    const cut = h * 0.35;
    const w = doc.getTextWidth(text) + h * 0.35 + h * 0.75;
    const band = (bx, by) => doc.lines([[w, 0], [-cut, h], [-(w - cut), 0]], bx, by, [1, 1], 'F', true);
    doc.setFillColor(...SLIP.tapeShadow);
    band(x + 0.6, top + 0.6);
    doc.setFillColor(...color);
    band(x, top);
    const dark = color === SLIP.accent;
    doc.setTextColor(...(dark ? SLIP.onAccent : [255, 255, 255]));
    doc.text(text, x + h * 0.35, top + h * 0.7);
    return { w, h };
}

// Page header shared by slips, guide and timetable: event name and brand in one row, a rule,
// then the title on tape in the colour of its area. The tape sits between 31 and 38 mm.
function slipPageHeader(doc, eventName, title, color) {
    const { width, margin } = SLIP;
    const right = width - margin;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...SLIP.text);
    doc.text(eventName, margin, 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...SLIP.faint);
    doc.text('MCD Brackets', right, 20, { align: 'right' });
    doc.setDrawColor(...SLIP.text);
    doc.setLineWidth(0.4);
    doc.line(margin, 24, right, 24);
    if (title) slipTape(doc, title, margin, 30.5, { color, size: 11 });
}

// Largest font size (down to min) at which text fits into maxWidth
function fitFontSize(doc, text, maxWidth, start, min) {
    let size = start;
    doc.setFontSize(size);
    while (size > min && doc.getTextWidth(text) > maxWidth) {
        size -= 1;
        doc.setFontSize(size);
    }
    return size;
}

// Logo box in mm following the image's aspect ratio: portrait stays portrait, landscape
// landscape. Roughly constant area (like the former 34 x 48 portrait frame), capped at
// 48 mm height and 64 mm width so the name keeps enough room.
const LOGO_AREA = 34 * 48, LOGO_MAX_W = 64, LOGO_MAX_H = 48;

function logoBox(doc, dataUrl) {
    const { width, height } = doc.getImageProperties(dataUrl);
    const ratio = width / height || 1;
    let h = Math.min(LOGO_MAX_H, Math.sqrt(LOGO_AREA / ratio));
    let w = h * ratio;
    if (w > LOGO_MAX_W) {
        w = LOGO_MAX_W;
        h = w / ratio;
    }
    return { w, h };
}

function addSlipPage(doc, event, attendee, createdAt) {
    const { width, margin } = SLIP;
    const right = width - margin;
    const contentWidth = width - 2 * margin;

    // Header with the title on blue tape (attendee area) — everything stays well inside
    // the 5 mm non-printable border
    slipPageHeader(doc, event.name, 'IP-Zettel', SLIP.blue);

    // Logo top right in its own aspect ratio (only when the event has a logo)
    const logo = event.logo ? { ...logoBox(doc, event.logo), gap: 8 } : null;
    if (logo) {
        doc.addImage(event.logo, right - logo.w, 30, logo.w, logo.h);
    }

    // Name: "Clan-" in accent color, nickname in text color
    doc.setFont('helvetica', 'bold');
    const nameWidth = contentWidth - (logo ? logo.w + logo.gap : 0);
    const size = fitFontSize(doc, attendee.display_name, nameWidth, 30, 14);
    doc.setFontSize(size);
    let x = margin;
    if (attendee.clan) {
        const clanText = `${attendee.clan}-`;
        doc.setTextColor(...SLIP.accent);
        doc.text(clanText, x, 52);
        x += doc.getTextWidth(clanText);
    }
    doc.setTextColor(...SLIP.text);
    doc.text(attendee.nickname, x, 52);

    const realName = [attendee.first_name, attendee.last_name].filter(Boolean).join(' ');
    if (realName) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(fitFontSize(doc, realName, nameWidth, 13, 9));
        doc.setTextColor(...SLIP.muted);
        doc.text(realName, margin, 60);
    }

    // Address cards
    // Below the logo (a portrait logo ends at 78 mm), at least at 72 mm
    let y = logo ? Math.max(72, 30 + logo.h + 8) : 72;
    slipLabel(doc, 'Deine Adressen', margin, y);
    y += 5;
    const cardH = 30;
    RANGE_LABELS.forEach((label, i) => {
        doc.setFillColor(...SLIP.fill);
        doc.setDrawColor(...SLIP.border);
        doc.setLineWidth(0.3);
        doc.roundedRect(margin, y, contentWidth, cardH, SLIP.radius, SLIP.radius, 'FD');

        // Number square: the main PC in orange, the others in rack black
        doc.setFillColor(...(i === 0 ? SLIP.accent : SLIP.text));
        doc.rect(margin + 6, y + cardH / 2 - 6, 12, 12, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(...(i === 0 ? SLIP.onAccent : [255, 255, 255]));
        doc.text(String(i + 1), margin + 12, y + cardH / 2 + 1.6, { align: 'center' });

        const textX = margin + 25;
        slipLabel(doc, label, textX, y + 8.5);
        doc.setFont('courier', 'bold');
        doc.setFontSize(22);
        doc.setTextColor(...SLIP.text);
        doc.text(attendee.ips[i], textX, y + 18.5);
        doc.setFont('courier', 'normal');
        doc.setFontSize(fitFontSize(doc, attendee.dns_names[i], contentWidth - 30, 11, 7));
        doc.setTextColor(...SLIP.link);
        doc.text(attendee.dns_names[i], textX, y + 25.5);

        y += cardH + 4;
    });

    // Network settings in one row: mask, gateway and DNS (empty ones get a line to fill in by hand).
    // The domain is only part of the DNS names above, it is not entered anywhere.
    y += 4;
    slipLabel(doc, 'Netzwerk-Einstellungen', margin, y);
    y = drawValueBoxes(doc, [
        { label: 'Subnetzmaske', value: event.netmask },
        { label: 'Router/Gateway', value: event.gateway },
        { label: 'DNS', value: event.dns_server },
    ], margin, y + 5, contentWidth);

    // WLAN (only when the event has one). Password: '' = open network, null = hidden for
    // visitors without admin login (line to fill in)
    if (event.wifi_enabled) {
        y += 7;
        slipLabel(doc, 'WLAN', margin, y);
        y = drawValueBoxes(doc, [
            { label: 'Netzwerkname (SSID)', value: event.wifi_ssid },
            event.wifi_password === ''
                ? { label: 'Passwort', note: 'keins (offenes WLAN)' }
                : { label: 'Passwort', value: event.wifi_password },
        ], margin, y + 5, contentWidth);
    }

    // Hint (a bit closer with WLAN, so a page with a large logo still fits)
    y += event.wifi_enabled ? 7 : 9;
    const hint = 'Bitte nur die dir zugewiesenen Adressen verwenden und in den Netzwerkeinstellungen deiner Rechner eintragen. '
        + 'Der Haupt-PC bekommt Adresse 1, weitere Rechner oder Server die Adressen 2 und 3. Bei Fragen hilft die Orga.';
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    const lines = doc.splitTextToSize(hint, contentWidth - 12);
    const hintH = lines.length * 4.6 + 8;
    doc.setFillColor(...SLIP.accentSoft);
    doc.setDrawColor(...SLIP.accent);
    doc.setLineWidth(0.3);
    doc.roundedRect(margin, y, contentWidth, hintH, SLIP.radius, SLIP.radius, 'FD');
    doc.setTextColor(...SLIP.text);
    doc.text(lines, margin + 6, y + 6.8);

    // Footer
    doc.setDrawColor(...SLIP.border);
    doc.setLineWidth(0.3);
    doc.line(margin, 282, right, 282);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...SLIP.faint);
    doc.text(`${event.name} · ${attendee.display_name}`, margin, 287);
    doc.text(`Erstellt am ${createdAt.toLocaleDateString('de-DE')}`, right, 287, { align: 'right' });
}

// A row of boxes with a small label and a value in courier (easy to tell 0/O and 1/l apart).
// Values that don't fit even at 8 pt wrap onto more lines and make the row taller.
// Empty values get a dashed line to fill in by hand, note a short text instead.
// Returns the y below the row.
function drawValueBoxes(doc, items, x, y, width) {
    const gap = 6;
    const boxW = (width - gap * (items.length - 1)) / items.length;
    const inner = boxW - 10;

    const layouts = items.map(item => {
        if (!item.value) return { size: 13, lines: [] };
        doc.setFont('courier', 'bold');
        const size = fitFontSize(doc, item.value, inner, 13, 8);
        const lines = doc.getTextWidth(item.value) > inner ? doc.splitTextToSize(item.value, inner) : [item.value];
        return { size, lines };
    });
    const lineH = size => size * 0.42;
    const boxH = Math.max(17, ...layouts.map(l => 9 + l.lines.length * lineH(l.size) + 2.5));

    items.forEach((item, i) => {
        const bx = x + i * (boxW + gap);
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(...SLIP.border);
        doc.setLineWidth(0.3);
        doc.roundedRect(bx, y, boxW, boxH, SLIP.radius, SLIP.radius, 'FD');
        slipLabel(doc, item.label, bx + 5, y + 6.5, SLIP.muted, 7);

        const { size, lines } = layouts[i];
        if (lines.length) {
            doc.setFont('courier', 'bold');
            doc.setFontSize(size);
            doc.setTextColor(...SLIP.text);
            lines.forEach((line, n) => doc.text(line, bx + 5, y + 13 + n * lineH(size)));
        } else if (item.note) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            doc.setTextColor(...SLIP.muted);
            doc.text(item.note, bx + 5, y + 13);
        } else {
            doc.setDrawColor(...SLIP.faint);
            doc.setLineDashPattern([1, 1], 0);
            doc.line(bx + 5, y + 13.5, bx + boxW - 5, y + 13.5);
            doc.setLineDashPattern([], 0);
        }
    });
    return y + boxH;
}

function buildSlipsPdf(event, list) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const createdAt = new Date();
    list.forEach((attendee, i) => {
        if (i > 0) doc.addPage();
        addSlipPage(doc, event, attendee, createdAt);
    });
    doc.setProperties({ title: `IP-Zettel ${event.name}`, creator: 'MCD Brackets' });
    return doc;
}

function exportSlip(attendeeId) {
    const event = currentEvent();
    const attendee = attendees.find(a => a.id === attendeeId);
    if (!event || !attendee) return;
    buildSlipsPdf(event, [attendee]).save(`ip-zettel-${slipFileSlug(event.name)}-${slipFileSlug(attendee.display_name)}.pdf`);
}

async function exportAllSlips() {
    const event = currentEvent();
    if (!event) return;
    if (attendees.length === 0) {
        notify('Dieses Event hat noch keine Teilnehmer.');
        return;
    }
    const button = document.getElementById('exportSlipsBtn');
    const label = getButtonLabel(button);
    setButtonLabel(button, 'Erzeuge PDF…');
    button.disabled = true;
    // Let the button repaint before the (synchronous) PDF generation
    await new Promise(resolve => setTimeout(resolve, 30));
    try {
        const sorted = [...attendees].sort((a, b) => a.slot - b.slot);
        buildSlipsPdf(event, sorted).save(`ip-zettel-${slipFileSlug(event.name)}.pdf`);
    } catch (error) {
        notify('❌ Fehler beim Erzeugen des PDFs: ' + error.message);
    } finally {
        setButtonLabel(button, label);
        button.disabled = false;
    }
}
