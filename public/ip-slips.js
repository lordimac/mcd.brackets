// IP slips: one DIN A4 page per attendee with addresses, DNS names and network settings.
// Drawn as vector PDF with jsPDF (crisp when printed). Uses lanEvents/attendees/currentEventId
// from lan.js and setButtonLabel from app.js.

const SLIP = {
    width: 210,
    margin: 18,
    accent: [240, 130, 40],
    accentSoft: [254, 243, 232],
    text: [20, 24, 33],
    muted: [107, 114, 128],
    faint: [156, 163, 175],
    fill: [245, 246, 248],
    border: [226, 229, 234],
    link: [24, 110, 190],
};

function slipFileSlug(value) {
    return value.toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
}

// Small uppercase heading with letter spacing
function slipLabel(doc, text, x, y, color = SLIP.muted, size = 8.5) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.setCharSpace(0.6);
    doc.text(text.toUpperCase(), x, y);
    doc.setCharSpace(0);
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

// Logo (portrait) fitted into its frame: as large as possible, centered horizontally, top-aligned
function drawLogo(doc, dataUrl, x, y, w, h) {
    const { width, height } = doc.getImageProperties(dataUrl);
    const scale = Math.min(w / width, h / height);
    const drawW = width * scale, drawH = height * scale;
    doc.addImage(dataUrl, x + (w - drawW) / 2, y, drawW, drawH);
}

function addSlipPage(doc, event, attendee, createdAt) {
    const { width, margin } = SLIP;
    const right = width - margin;
    const contentWidth = width - 2 * margin;

    // Accent bar and header — everything stays well inside the 5 mm non-printable border
    doc.setFillColor(...SLIP.accent);
    doc.rect(margin, 10, contentWidth, 2, 'F');

    slipLabel(doc, 'MCD Brackets', margin, 20, SLIP.faint, 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...SLIP.text);
    doc.text(event.name, right, 20, { align: 'right' });

    doc.setDrawColor(...SLIP.border);
    doc.setLineWidth(0.3);
    doc.line(margin, 24, right, 24);

    // Portrait logo frame top right (only when the event has a logo)
    const logo = { w: 34, h: 48, gap: 8 };
    if (event.logo) {
        drawLogo(doc, event.logo, right - logo.w, 30, logo.w, logo.h);
    }

    // Name: "Clan-" in accent color, nickname in text color
    slipLabel(doc, 'IP-Zettel', margin, 38, SLIP.accent, 9);
    doc.setFont('helvetica', 'bold');
    const nameWidth = contentWidth - (event.logo ? logo.w + logo.gap : 0);
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
    let y = event.logo ? 86 : 72;
    slipLabel(doc, 'Deine Adressen', margin, y);
    y += 5;
    const cardH = 30;
    RANGE_LABELS.forEach((label, i) => {
        doc.setFillColor(...SLIP.fill);
        doc.setDrawColor(...SLIP.border);
        doc.roundedRect(margin, y, contentWidth, cardH, 3, 3, 'FD');

        // Number circle
        doc.setFillColor(...(i === 0 ? SLIP.accent : SLIP.muted));
        doc.circle(margin + 12, y + cardH / 2, 6, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(255, 255, 255);
        doc.text(String(i + 1), margin + 12, y + cardH / 2 + 1.5, { align: 'center' });

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

    // Network settings: mask, gateway and DNS always (empty ones get a line to fill in by hand),
    // the domain only when configured
    const settings = [
        ['Subnetzmaske', event.netmask],
        ['Router/Gateway', event.gateway],
        ['DNS', event.dns_server],
        ...(event.domain ? [['Domain', event.domain]] : []),
    ];

    y += 4;
    slipLabel(doc, 'Netzwerk-Einstellungen', margin, y);
    y += 5;
    const gap = 6, boxW = (contentWidth - gap) / 2, boxH = 17;
    settings.forEach(([label, value], i) => {
        const bx = margin + (i % 2) * (boxW + gap);
        const by = y + Math.floor(i / 2) * (boxH + gap / 2);
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(...SLIP.border);
        doc.roundedRect(bx, by, boxW, boxH, 2.5, 2.5, 'FD');
        slipLabel(doc, label, bx + 5, by + 6.5, SLIP.muted, 7);
        if (value) {
            doc.setFont('courier', 'bold');
            doc.setFontSize(fitFontSize(doc, value, boxW - 10, 13, 8));
            doc.setTextColor(...SLIP.text);
            doc.text(value, bx + 5, by + 13);
        } else {
            doc.setDrawColor(...SLIP.faint);
            doc.setLineDashPattern([1, 1], 0);
            doc.line(bx + 5, by + 13.5, bx + boxW - 5, by + 13.5);
            doc.setLineDashPattern([], 0);
        }
    });
    y += Math.ceil(settings.length / 2) * (boxH + gap / 2) - gap / 2;

    // Hint
    y += 9;
    const hint = 'Bitte nur die dir zugewiesenen Adressen verwenden und in den Netzwerkeinstellungen deiner Rechner eintragen. '
        + 'Der Haupt-PC bekommt Adresse 1, weitere Rechner oder Server die Adressen 2 und 3. Bei Fragen hilft die Orga.';
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    const lines = doc.splitTextToSize(hint, contentWidth - 12);
    const hintH = lines.length * 4.6 + 8;
    doc.setFillColor(...SLIP.accentSoft);
    doc.roundedRect(margin, y, contentWidth, hintH, 2.5, 2.5, 'F');
    doc.setFillColor(...SLIP.accent);
    doc.rect(margin, y, 1.6, hintH, 'F');
    doc.setTextColor(...SLIP.text);
    doc.text(lines, margin + 7, y + 6.8);

    // Footer
    doc.setDrawColor(...SLIP.border);
    doc.line(margin, 282, right, 282);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...SLIP.faint);
    doc.text(`${event.name} · ${attendee.display_name}`, margin, 287);
    doc.text(`Erstellt am ${createdAt.toLocaleDateString('de-DE')}`, right, 287, { align: 'right' });
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
        alert('Dieses Event hat noch keine Teilnehmer.');
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
        alert('❌ Fehler beim Erzeugen des PDFs: ' + error.message);
    } finally {
        setButtonLabel(button, label);
        button.disabled = false;
    }
}
