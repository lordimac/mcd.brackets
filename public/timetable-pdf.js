// Timetable as A4 PDF to put up: days with their entries (own entries and tournament rounds),
// then the notes. Same style as the IP slips (SLIP, slipLabel, fitFontSize, logoBox, slipFileSlug
// from ip-slips.js); days and times from timetable.js (timetableDays, ttTimeRange, ttDay).

// Same categories as in the app: meals brown, programme green, tournaments orange, rest grey
const TT_PDF_COLORS = {
    meal: SLIP.brown,
    program: SLIP.green,
    tournament: SLIP.accent,
    other: SLIP.faint,
};
const TT_PDF_BOTTOM = 276; // content ends above the footer line (282 mm)

// jsPDF's standard fonts only know Windows-1252: drop everything else (e.g. emojis)
const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function pdfText(value) {
    return [...String(value ?? '')].filter(ch => ch.charCodeAt(0) <= 0xff || CP1252_EXTRA.includes(ch)).join('');
}

function ttPdfHeader(doc, event, first) {
    const { width, margin } = SLIP;
    const right = width - margin;
    // Title on violet tape (timetable area), only on the first page
    slipPageHeader(doc, pdfText(event.name), first ? 'Zeitplan' : '', SLIP.violet);
    if (!first) return 32;

    const logo = event.logo ? logoBox(doc, event.logo) : null;
    if (logo) doc.addImage(event.logo, right - logo.w, 30, logo.w, logo.h);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(fitFontSize(doc, pdfText(event.name), width - 2 * margin - (logo ? logo.w + 8 : 0), 28, 14));
    doc.setTextColor(...SLIP.text);
    doc.text(pdfText(event.name), margin, 51);
    return logo ? Math.max(64, 30 + logo.h + 8) : 64;
}

function buildTimetablePdf(event, data) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const { width, margin } = SLIP;
    const contentWidth = width - 2 * margin;
    const timeWidth = 34;
    const textX = margin + timeWidth + 5;
    const textWidth = width - margin - textX - 5; // inner padding on the right
    let y = ttPdfHeader(doc, event, true);

    // New page when the next block doesn't fit any more
    const ensureSpace = height => {
        if (y + height <= TT_PDF_BOTTOM) return;
        doc.addPage();
        y = ttPdfHeader(doc, event, false);
    };

    // With an event period only its days (e.g. old deadlines outside are left out)
    const period = eventDays(event);
    const days = timetableDays(data).filter(({ day }) => !period.length || period.includes(localDay(day)));
    if (days.length === 0) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        doc.setTextColor(...SLIP.muted);
        doc.text('Noch nichts geplant.', margin, y + 4);
        y += 12;
    }

    for (const { day, items } of days) {
        ensureSpace(20);
        // Day: bold heading with a rule
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(...SLIP.text);
        doc.text(pdfText(ttDay(day)), margin, y + 4.5);
        doc.setDrawColor(...SLIP.text);
        doc.setLineWidth(0.4);
        doc.line(margin, y + 6.5, width - margin, y + 6.5);
        y += 10;

        for (const item of items) {
            const category = item.kind === 'rounds' ? 'tournament' : item.entry.category;
            const title = pdfText(item.kind === 'rounds' ? item.item.title : item.entry.title);
            const info = pdfText(item.kind === 'rounds'
                ? item.item.rounds.map(r => `${r.stage_name}: ${r.label}`).join(' · ')
                : item.entry.info);

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11.5);
            const titleLines = doc.splitTextToSize(title, textWidth);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9.5);
            const infoLines = info ? doc.splitTextToSize(info, textWidth) : [];
            const height = 4 + titleLines.length * 5 + infoLines.length * 4.2 + 3;
            ensureSpace(height);

            doc.setFillColor(...SLIP.fill);
            doc.roundedRect(margin, y, contentWidth, height, SLIP.radius, SLIP.radius, 'F');
            // Category as a small square in its colour (like the nodes on screen)
            doc.setFillColor(...(TT_PDF_COLORS[category] ?? TT_PDF_COLORS.other));
            doc.rect(margin + 3, y + 4.4, 2.8, 2.8, 'F');

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11.5);
            doc.setTextColor(...SLIP.text);
            doc.text(pdfText(ttTimeRange(item)), margin + 8, y + 7);
            doc.text(titleLines, textX, y + 7);
            if (infoLines.length) {
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(9.5);
                doc.setTextColor(...SLIP.muted);
                doc.text(infoLines, textX, y + 7 + titleLines.length * 5);
            }
            y += height + 2;
        }
        y += 4;
    }

    // Notes as boxes, like the hint on the IP slips
    if (data.notes.length) {
        ensureSpace(24);
        y += 2;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(...SLIP.text);
        doc.text('Hinweise', margin, y + 4.5);
        doc.setDrawColor(...SLIP.text);
        doc.setLineWidth(0.4);
        doc.line(margin, y + 6.5, width - margin, y + 6.5);
        y += 10;
        for (const note of data.notes) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            const lines = doc.splitTextToSize(pdfText(note.text), contentWidth - 14);
            const height = (note.title ? 6 : 0) + lines.length * 4.6 + 8;
            ensureSpace(height);
            doc.setFillColor(...SLIP.accentSoft);
            doc.setDrawColor(...SLIP.accent);
            doc.setLineWidth(0.3);
            doc.roundedRect(margin, y, contentWidth, height, SLIP.radius, SLIP.radius, 'FD');
            let textY = y + 6.8;
            if (note.title) {
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(11);
                doc.setTextColor(...SLIP.text);
                doc.text(pdfText(note.title), margin + 7, textY);
                textY += 6;
            }
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            doc.setTextColor(...SLIP.text);
            doc.text(lines, margin + 7, textY);
            y += height + 3;
        }
    }

    // Footer on every page
    const pages = doc.getNumberOfPages();
    const createdAt = new Date().toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    for (let page = 1; page <= pages; page++) {
        doc.setPage(page);
        doc.setDrawColor(...SLIP.border);
        doc.setLineWidth(0.3);
        doc.line(margin, 282, width - margin, 282);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(...SLIP.faint);
        doc.text(`${pdfText(event.name)} · Zeitplan${pages > 1 ? ` · Seite ${page}/${pages}` : ''}`, margin, 287);
        doc.text(`Stand ${createdAt}`, width - margin, 287, { align: 'right' });
    }
    doc.setProperties({ title: `Zeitplan ${event.name}`, creator: 'MCD Brackets' });
    return doc;
}

async function exportTimetablePdf() {
    const event = lanEvents.find(e => e.id === currentEventId);
    if (!event) return;
    try {
        // Fresh data: the tournament rounds follow the deadlines
        const data = await apiFetch(`/events/${event.id}/timetable`);
        buildTimetablePdf(event, data).save(`zeitplan-${slipFileSlug(event.name)}.pdf`);
    } catch (error) {
        alert('❌ Fehler beim Erzeugen des PDFs: ' + error.message);
    }
}
