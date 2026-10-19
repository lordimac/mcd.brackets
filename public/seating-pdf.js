// Seating plan PDFs (vector, jsPDF): the room plan with names to put up at the entrance
// (plus an alphabetical "who sits where" list) and fold-up seat signs, two per A4 sheet.
// Uses SLIP, slipFileSlug, slipLabel, fitFontSize from ip-slips.js and the state of seating.js.
// Everything stays at least 10 mm from the paper edge (printers need 5 mm).

const PLAN_MARGIN = 10;

// Wraps at spaces; a word that is too long on its own is broken inside
function wrapWords(doc, text, maxWidth) {
    const lines = [];
    let line = '';
    const push = () => { if (line) lines.push(line); line = ''; };
    for (const word of text.trim().split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (doc.getTextWidth(candidate) <= maxWidth) { line = candidate; continue; }
        push();
        let rest = word;
        while (doc.getTextWidth(rest) > maxWidth && rest.length > 1) {
            let cut = rest.length - 1;
            while (cut > 1 && doc.getTextWidth(rest.slice(0, cut)) > maxWidth) cut--;
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
        }
        line = rest;
    }
    push();
    return lines;
}

// Name on a table: one line if possible (a little smaller is fine), else two lines,
// else two lines with "…" at the end — sets the font size it chose
function nameLines(doc, text, maxWidth, start, min) {
    for (let size = start; size >= start * 0.75; size -= 0.25) {
        doc.setFontSize(size);
        if (doc.getTextWidth(text) <= maxWidth) return [text];
    }
    for (let size = start * 0.8; size >= min; size -= 0.25) {
        doc.setFontSize(size);
        const lines = wrapWords(doc, text, maxWidth);
        if (lines.length <= 2) return lines;
    }
    doc.setFontSize(min);
    const lines = wrapWords(doc, text, maxWidth);
    return [lines[0], fitText(doc, lines.slice(1).join(' ') + '…', maxWidth).replace(/…*$/, '…')];
}

// Text shortened with "…" until it fits (after shrinking to the minimum font size)
function fitText(doc, text, maxWidth) {
    if (doc.getTextWidth(text) <= maxWidth) return text;
    let short = text;
    while (short.length > 1 && doc.getTextWidth(short + '…') > maxWidth) short = short.slice(0, -1);
    return short + '…';
}

/* Room plan
   ========================================================================== */

// The whole room scaled into the area: numbered tables with name, seating areas light, areas labelled
// Quarter circle around (cx, cy) from p0 to p1 as a cubic Bézier curve
function drawQuarterArc(doc, cx, cy, p0, p1) {
    const r = Math.hypot(p0[0] - cx, p0[1] - cy);
    const k = 0.5523 * r;
    const unitVec = (p) => [(p[0] - cx) / r, (p[1] - cy) / r];
    const [u0x, u0y] = unitVec(p0), [u1x, u1y] = unitVec(p1);
    // Tangents point from p0 towards p1 and arrive at p1 from p0's side
    const c1 = [p0[0] + u1x * k, p0[1] + u1y * k];
    const c2 = [p1[0] + u0x * k, p1[1] + u0y * k];
    doc.lines([[c1[0] - p0[0], c1[1] - p0[1], c2[0] - p0[0], c2[1] - p0[1], p1[0] - p0[0], p1[1] - p0[1]]], p0[0], p0[1], [1, 1], 'S');
}

// Walls with openings, door leaves and swing arcs (same geometry as on screen)
function drawWallsAndDoors(doc, room, x0, y0, unit) {
    const W = room.width * unit, H = room.height * unit;
    doc.setDrawColor(...SLIP.muted);
    doc.setLineWidth(0.7);
    doc.rect(x0, y0, W, H);
    for (const door of room.doors) {
        const g = doorGeometry(door, room);
        const pt = ([x, y]) => [x0 + x * unit, y0 + y * unit];
        const hinge = pt(g.hinge), leaf = pt(g.leaf), free = pt(g.free);
        doc.setDrawColor(255, 255, 255);
        doc.setLineWidth(1.4);
        doc.line(hinge[0], hinge[1], free[0], free[1]);
        doc.setDrawColor(...SLIP.text);
        doc.setLineWidth(0.5);
        doc.line(hinge[0], hinge[1], leaf[0], leaf[1]);
        doc.setDrawColor(...SLIP.faint);
        doc.setLineWidth(0.25);
        doc.setLineDashPattern([0.8, 0.8], 0);
        drawQuarterArc(doc, hinge[0], hinge[1], leaf, free);
        doc.setLineDashPattern([], 0);
    }
}

function drawRoomPlan(doc, room, people, area) {
    // Margin around the room for doors opening outwards (as on screen)
    const m = doorMargins(room);
    const unit = Math.min(area.w / (room.width + m.left + m.right), area.h / (room.height + m.top + m.bottom), 30);
    const x0 = area.x + (area.w - (room.width + m.left + m.right) * unit) / 2 + m.left * unit;
    const y0 = area.y + m.top * unit;
    const numbers = new Map(room.layout.seats.map(s => [s.key, s.label]));
    const shapes = new Map(room.layout.groups.map(g => [g.id, g]));
    const nameStart = Math.min(10, unit * 0.75);
    const numberSize = Math.max(4, Math.min(7, unit * 0.45));
    const inset = Math.min(0.8, unit * 0.06);

    for (const group of room.groups) {
        const shape = shapes.get(group.id);
        if (!shape) continue;
        const gx = x0 + group.x * unit, gy = y0 + group.y * unit;
        if (group.type === 'area') {
            doc.setFillColor(...SLIP.fill);
            doc.setDrawColor(...SLIP.faint);
            doc.setLineWidth(0.25);
            doc.setLineDashPattern([1, 1], 0);
            doc.rect(gx, gy, shape.w * unit, shape.h * unit, 'FD');
            doc.setLineDashPattern([], 0);
            if (group.label) {
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(...SLIP.muted);
                const maxWidth = shape.w * unit - 2;
                fitFontSize(doc, group.label.toUpperCase(), maxWidth, Math.min(11, unit * 0.8), 4);
                const label = fitText(doc, group.label.toUpperCase(), maxWidth);
                doc.text(label, gx + (shape.w * unit - doc.getTextWidth(label)) / 2, gy + shape.h * unit / 2 + doc.getFontSize() * 0.3528 * 0.35);
            }
            continue;
        }
        for (const cell of shape.cells) {
            const x = gx + cell.dx * unit, y = gy + cell.dy * unit;
            if (cell.kind === 'table') {
                // Seating area: chairs facing their tables (same shapes as on screen)
                for (const r of chairRects(chairDirections(cell, shape))) {
                    doc.setFillColor(...(r.part === 'seat' ? [214, 219, 228] : [168, 177, 192]));
                    const k = unit / 100;
                    doc.roundedRect(x + r.x * k, y + r.y * k, r.w * k, r.h * k, r.r * k, r.r * k, 'F');
                }
                continue;
            }
            const person = people.get(room.seats[cell.key]);
            doc.setLineWidth(0.25);
            // Numbered table: solid table top
            doc.setDrawColor(...(person ? SLIP.accent : [178, 186, 200]));
            doc.setFillColor(...(person ? SLIP.accentSoft : [233, 236, 241]));
            doc.roundedRect(x + inset, y + inset, unit - 2 * inset, unit - 2 * inset, 0.6, 0.6, 'FD');

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(numberSize);
            doc.setTextColor(...(person ? SLIP.accent : SLIP.faint));
            doc.text(fitText(doc, numbers.get(cell.key), unit - 2 * inset - 1), x + inset + 0.7, y + inset + numberSize * 0.3528 + 0.4);

            if (person) {
                doc.setTextColor(...SLIP.text);
                const maxWidth = unit - 2 * inset - 1.2;
                const lines = nameLines(doc, person.nickname, maxWidth, nameStart, 3.5);
                const lineH = doc.getFontSize() * 0.3528 * 1.15;
                const top = y + unit * 0.62 - (lines.length - 1) * lineH / 2;
                lines.forEach((line, i) => doc.text(line, x + unit / 2 - doc.getTextWidth(line) / 2, top + i * lineH));
            }
        }
    }
    drawWallsAndDoors(doc, room, x0, y0, unit);
}

function addPlanHeader(doc, event, room, pageW, subtitle) {
    slipLabel(doc, subtitle, PLAN_MARGIN, PLAN_MARGIN + 3, SLIP.accent, 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(...SLIP.text);
    doc.text(room.name, PLAN_MARGIN, PLAN_MARGIN + 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...SLIP.muted);
    doc.text(event.name, pageW - PLAN_MARGIN - doc.getTextWidth(event.name), PLAN_MARGIN + 10);
}

function addPlanFooter(doc, pageW, pageH, createdAt) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...SLIP.faint);
    const text = `Erstellt am ${createdAt.toLocaleDateString('de-DE')} · MCD Brackets`;
    doc.text(text, pageW - PLAN_MARGIN - doc.getTextWidth(text), pageH - PLAN_MARGIN + 2);
}

// Alphabetical list of the occupied seats, in columns over as many pages as needed
function addSeatList(doc, event, room, people, createdAt) {
    const numbers = new Map(room.layout.seats.map(s => [s.key, s.label]));
    const entries = Object.entries(room.seats)
        .map(([key, id]) => ({ person: people.get(id), number: numbers.get(key) }))
        .filter(e => e.person && e.number)
        .sort((a, b) => a.person.display_name.localeCompare(b.person.display_name, 'de', { sensitivity: 'base' }));
    if (entries.length === 0) return;

    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const top = PLAN_MARGIN + 20;
    const bottom = pageH - PLAN_MARGIN - 6;
    const lineH = 6;
    const columns = pageW > pageH ? 3 : 2;
    const colW = (pageW - 2 * PLAN_MARGIN) / columns;
    const perColumn = Math.floor((bottom - top) / lineH);

    entries.forEach((entry, i) => {
        const slot = i % (perColumn * columns);
        if (slot === 0) {
            doc.addPage();
            addPlanHeader(doc, event, room, pageW, 'Wer sitzt wo?');
            addPlanFooter(doc, pageW, pageH, createdAt);
        }
        const x = PLAN_MARGIN + Math.floor(slot / perColumn) * colW;
        const y = top + (slot % perColumn) * lineH;
        const place = `Platz ${entry.number}`;

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9.5);
        doc.setTextColor(...SLIP.accent);
        doc.text(place, x + colW - 4 - doc.getTextWidth(place), y);

        doc.setTextColor(...SLIP.text);
        const name = fitText(doc, entry.person.display_name, colW - 30);
        doc.text(name, x, y);
        doc.setDrawColor(...SLIP.border);
        doc.setLineWidth(0.15);
        doc.line(x, y + 2, x + colW - 4, y + 2);
    });
}

function buildSeatPlanPdf(event, room, format) {
    const { jsPDF } = window.jspdf;
    const orientation = room.width >= room.height * 0.8 ? 'landscape' : 'portrait';
    const doc = new jsPDF({ orientation, unit: 'mm', format });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const createdAt = new Date();
    const people = attendeeMap();

    addPlanHeader(doc, event, room, pageW, room.alternative ? 'Sitzplan · Alternative' : 'Sitzplan');
    addPlanFooter(doc, pageW, pageH, createdAt);
    drawRoomPlan(doc, room, people, {
        x: PLAN_MARGIN, y: PLAN_MARGIN + 18,
        w: pageW - 2 * PLAN_MARGIN, h: pageH - 2 * PLAN_MARGIN - 26,
    });
    addSeatList(doc, event, room, people, createdAt);
    return doc;
}

function exportSeatPlanPdf() {
    const room = currentRoom();
    const event = lanEvents.find(e => e.id === currentEventId);
    if (!room || !event) return;
    const format = document.getElementById('seatPdfFormat').value;
    buildSeatPlanPdf(event, room, format).save(`sitzplan-${slipFileSlug(event.name)}-${slipFileSlug(room.name)}.pdf`);
}

/* Seat signs: tent cards, two per A4 portrait sheet. Each card is folded along its middle;
   the upper half is drawn rotated by 180° so the sign reads correctly from both sides.
   ========================================================================== */

const SIGN = { width: 210, cardHeight: 148.5, side: 14 };

// Draws in "face coordinates" (x, y below the fold line); upper = the rotated copy above the fold
function signFace(doc, fold, upper) {
    const W = SIGN.width;
    const mapY = y => (upper ? fold - y : fold + y);
    return {
        rect(x, y, w, h, style, r = 0) {
            const rx = upper ? W - x - w : x;
            const ry = upper ? fold - y - h : fold + y;
            if (r) doc.roundedRect(rx, ry, w, h, r, r, style);
            else doc.rect(rx, ry, w, h, style);
        },
        // Left-aligned text with its baseline at y
        text(value, x, y) {
            if (upper) doc.text(value, W - x, mapY(y), { angle: 180 });
            else doc.text(value, x, mapY(y));
        },
    };
}

function drawSignFace(doc, fold, upper, { number, label, roomName, eventName }) {
    const face = signFace(doc, fold, upper);
    const left = SIGN.side;
    const contentW = SIGN.width - 2 * SIGN.side;

    // Number tile
    const tile = 34;
    doc.setFillColor(...SLIP.accent);
    face.rect(left, 20, tile, tile, 'F', 3);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    const numberText = String(number);
    fitFontSize(doc, numberText, tile - 6, 44, 18);
    face.text(numberText, left + (tile - doc.getTextWidth(numberText)) / 2, 20 + tile / 2 + doc.getFontSize() * 0.3528 * 0.36);

    // Name (or "frei") next to it
    const textX = left + tile + 8;
    const textW = contentW - tile - 8;
    doc.setTextColor(...(label ? SLIP.text : SLIP.faint));
    fitFontSize(doc, label || 'frei', textW, 34, 12);
    face.text(fitText(doc, label || 'frei', textW), textX, 42);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...SLIP.muted);
    face.text(fitText(doc, `Platz ${number} · ${roomName} · ${eventName}`, textW), textX, 51);
}

function buildSeatSignsPdf(event, room) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const people = attendeeMap();
    const keys = room.layout.seats.map(s => s.key);

    keys.forEach((key, i) => {
        if (i > 0 && i % 2 === 0) doc.addPage();
        const top = (i % 2) * SIGN.cardHeight;
        const fold = top + SIGN.cardHeight / 2;
        const person = people.get(room.seats[key]);
        const content = { number: room.layout.seats[i].label, label: person ? person.display_name : '', roomName: room.name, eventName: event.name };

        drawSignFace(doc, fold, false, content);
        drawSignFace(doc, fold, true, content);

        // Fold line (dotted) and cut line between the two cards (dashed)
        doc.setDrawColor(...SLIP.faint);
        doc.setLineWidth(0.2);
        doc.setLineDashPattern([0.6, 1.4], 0);
        doc.line(SIGN.side, fold, SIGN.width - SIGN.side, fold);
        if (i % 2 === 0 && i + 1 < keys.length) {
            doc.setLineDashPattern([3, 2], 0);
            doc.line(PLAN_MARGIN, SIGN.cardHeight, SIGN.width - PLAN_MARGIN, SIGN.cardHeight);
        }
        doc.setLineDashPattern([], 0);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.setTextColor(...SLIP.faint);
        doc.text('falten', SIGN.side, fold - 1.2);
    });
    return doc;
}

function exportSeatSignsPdf() {
    const room = currentRoom();
    const event = lanEvents.find(e => e.id === currentEventId);
    if (!room || !event) return;
    if (room.layout.seats.length === 0) {
        alert('Dieser Raum hat noch keine Plätze.');
        return;
    }
    buildSeatSignsPdf(event, room).save(`platz-schilder-${slipFileSlug(event.name)}-${slipFileSlug(room.name)}.pdf`);
}
