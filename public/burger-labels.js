// Burger order labels for the DYMO LabelWriter 450: one PDF page per burger on DYMO 11354
// (57 x 32 mm), black only (thermal printer). The page goes to the browser's print dialog via a
// hidden frame; in the dialog pick the DYMO printer, paper "11354", no margins, scale 100 %.
// Unlike the A4 PDFs the label keeps only LABEL.margin to the edge — the label is the sheet.
// Uses pdfText (timetable-pdf.js) and fitFontSize (ip-slips.js).

const LABEL = { width: 57, height: 32, margin: 2.5 };
const PT = 0.3528; // mm per point

let lastBurgerPdfUrl = null;

function addBurgerLabel(doc, event, order) {
    const { width, height, margin } = LABEL;
    const right = width - margin;
    doc.setTextColor(0, 0, 0);
    doc.setDrawColor(0, 0, 0);
    doc.setFillColor(0, 0, 0);

    // Number white on black, then the name as large as it fits
    const number = `#${order.number}`;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    const numberWidth = doc.getTextWidth(number) + 2.4;
    doc.rect(margin, margin, numberWidth, 6.6, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(number, margin + 1.2, margin + 4.9);
    doc.setTextColor(0, 0, 0);

    const name = pdfText(order.name);
    const nameX = margin + numberWidth + 1.8;
    fitFontSize(doc, name, right - nameX, 13, 7);
    let shown = name;
    while (shown.length > 1 && doc.getTextWidth(shown) > right - nameX) shown = shown.slice(0, -2) + '…';
    doc.text(shown, nameX, margin + 4.9);

    doc.setLineWidth(0.35);
    doc.line(margin, margin + 8.2, right, margin + 8.2);

    // Order and note: the largest size at which both fit between the line and the footer
    const top = margin + 9.4;
    const bottom = height - margin - 3.2;
    const summary = pdfText(order.summary);
    const note = order.note ? pdfText(`Hinweis: ${order.note}`) : '';
    let size = 11;
    let lines, noteLines, lineHeight;
    for (; size >= 5.5; size -= 0.5) {
        lineHeight = size * PT * 1.18;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(size);
        lines = doc.splitTextToSize(summary, right - margin);
        doc.setFont('helvetica', 'bolditalic');
        noteLines = note ? doc.splitTextToSize(note, right - margin) : [];
        if ((lines.length + noteLines.length) * lineHeight <= bottom - top) break;
    }
    const maxLines = Math.max(1, Math.floor((bottom - top) / lineHeight));
    let y = top + size * PT * 0.8;
    doc.setFont('helvetica', 'bold');
    for (const line of lines.slice(0, maxLines)) {
        doc.text(line, margin, y);
        y += lineHeight;
    }
    doc.setFont('helvetica', 'bolditalic');
    for (const line of noteLines.slice(0, Math.max(0, maxLines - lines.length))) {
        doc.text(line, margin, y);
        y += lineHeight;
    }

    // Footer: time of ordering and event
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.5);
    const time = new Date(order.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    doc.text(`${time} Uhr`, margin, height - margin);
    if (event) doc.text(pdfText(event.name), right, height - margin, { align: 'right' });
}

function buildBurgerLabelsPdf(event, orders) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: [LABEL.width, LABEL.height], orientation: 'landscape' });
    orders.forEach((order, i) => {
        if (i > 0) doc.addPage([LABEL.width, LABEL.height], 'landscape');
        addBurgerLabel(doc, event, order);
    });
    doc.setProperties({ title: `Burger ${orders.map(o => `#${o.number}`).join(' ')}` });
    return doc;
}

// Opens the print dialog for the labels; if the browser can't print from the frame (e.g. Safari),
// the PDF opens in a new tab instead
function printBurgerLabels(event, orders) {
    const doc = buildBurgerLabelsPdf(event, orders);
    if (lastBurgerPdfUrl) URL.revokeObjectURL(lastBurgerPdfUrl);
    lastBurgerPdfUrl = doc.output('bloburl');
    updateLastBurgerPdfLink(orders);

    document.getElementById('burgerPrintFrame')?.remove();
    const frame = document.createElement('iframe');
    frame.id = 'burgerPrintFrame';
    frame.className = 'burger-print-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.onload = () => {
        try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
        } catch {
            window.open(lastBurgerPdfUrl, '_blank');
        }
    };
    frame.src = lastBurgerPdfUrl;
    document.body.appendChild(frame);
}

function updateLastBurgerPdfLink(orders) {
    const link = document.getElementById('burgerLastPdf');
    link.href = lastBurgerPdfUrl;
    link.hidden = false;
    link.title = `Zuletzt gedruckt: #${orders.map(o => o.number).join(', #')}`;
}
