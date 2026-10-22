// Short guides (one A4 page each) for setting a static IP on Windows and macOS, with the
// event's netmask, gateway and DNS. The dialogs are drawn as vector mock-ups filled with these
// values. Uses SLIP, slipLabel, fitFontSize, slipFileSlug from ip-slips.js, currentEvent from lan.js.

const GUIDE = {
    left: 18,          // left column: steps and tips
    leftWidth: 66,
    mockX: 92,         // right column: dialog mock-ups
    mockWidth: 100,
    top: 80,           // start of both columns
    mockGap: 6,
};

// Values shown in the guide; the IP differs per PC and comes from the slip
function guideValues(event) {
    return { mask: event.netmask, gateway: event.gateway, dns: event.dns_server };
}

function setColor(doc, kind, rgb) {
    if (kind === 'fill') doc.setFillColor(...rgb);
    else if (kind === 'draw') doc.setDrawColor(...rgb);
    else doc.setTextColor(...rgb);
}

function guideFont(doc, size, style = 'normal', color = SLIP.text) {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    setColor(doc, 'text', color);
}

// Orange numbered circle linking a mock-up element to a step
function guideMarker(doc, n, x, y, r = 2.6) {
    setColor(doc, 'fill', SLIP.accent);
    doc.circle(x, y, r, 'F');
    guideFont(doc, r * 3.2, 'bold', [255, 255, 255]);
    doc.text(String(n), x, y + r * 0.42, { align: 'center' });
}

function guideHeader(doc, event, title, subtitle) {
    const { width, margin } = SLIP;
    const right = width - margin;
    setColor(doc, 'fill', SLIP.accent);
    doc.rect(margin, 10, width - 2 * margin, 2, 'F');
    slipLabel(doc, 'MCD Brackets', margin, 20, SLIP.faint, 8);
    guideFont(doc, 10, 'bold');
    doc.text(event.name, right, 20, { align: 'right' });
    setColor(doc, 'draw', SLIP.border);
    doc.setLineWidth(0.3);
    doc.line(margin, 24, right, 24);

    slipLabel(doc, 'Anleitung', margin, 34, SLIP.accent, 9);
    guideFont(doc, 22, 'bold');
    doc.text(title, margin, 44);
    guideFont(doc, 10.5, 'normal', SLIP.muted);
    doc.text(subtitle, margin, 51);
}

// "Deine Werte": IP (from the slip), mask, gateway, DNS in one row
function guideValueBoxes(doc, values, y) {
    const { margin } = SLIP;
    const boxes = [
        ['IP-Adresse', null],
        ['Subnetzmaske', values.mask],
        ['Gateway / Router', values.gateway],
        ['DNS-Server', values.dns],
    ];
    const gap = 4, boxW = (SLIP.width - 2 * margin - 3 * gap) / 4, boxH = 15;
    boxes.forEach(([label, value], i) => {
        const x = margin + i * (boxW + gap);
        setColor(doc, 'fill', i === 0 ? SLIP.accentSoft : SLIP.fill);
        setColor(doc, 'draw', i === 0 ? SLIP.accent : SLIP.border);
        doc.setLineWidth(0.3);
        doc.roundedRect(x, y, boxW, boxH, 2, 2, 'FD');
        slipLabel(doc, label, x + 3.5, y + 5.5, SLIP.muted, 6.5);
        if (i === 0) {
            guideFont(doc, 9, 'bold', SLIP.accent);
            doc.text('siehe IP-Zettel', x + 3.5, y + 11.3);
        } else if (value) {
            doc.setFont('courier', 'bold');
            doc.setFontSize(fitFontSize(doc, value, boxW - 7, 11, 7));
            setColor(doc, 'text', SLIP.text);
            doc.text(value, x + 3.5, y + 11.3);
        } else {
            setColor(doc, 'draw', SLIP.faint);
            doc.setLineDashPattern([1, 1], 0);
            doc.line(x + 3.5, y + 11.5, x + boxW - 3.5, y + 11.5);
            doc.setLineDashPattern([], 0);
        }
    });
    return y + boxH;
}

// Numbered steps in the left column; returns the y below the last step
function guideSteps(doc, steps, y) {
    const { left, leftWidth } = GUIDE;
    slipLabel(doc, 'So geht\'s', left, y);
    y += 7;
    steps.forEach((text, i) => {
        guideMarker(doc, i + 1, left + 3, y - 1.2, 3);
        guideFont(doc, 9.5);
        const lines = doc.splitTextToSize(text, leftWidth - 9);
        doc.text(lines, left + 9, y);
        y += lines.length * 4.4 + 4.2;
    });
    return y;
}

// Tip boxes (test, back to automatic) below the steps
function guideTips(doc, tips, y) {
    const { left, leftWidth } = GUIDE;
    tips.forEach(([title, text]) => {
        guideFont(doc, 8.8);
        const lines = doc.splitTextToSize(text, leftWidth - 8);
        const h = lines.length * 4 + 11;
        setColor(doc, 'fill', SLIP.accentSoft);
        doc.roundedRect(left, y, leftWidth, h, 2, 2, 'F');
        setColor(doc, 'fill', SLIP.accent);
        doc.rect(left, y, 1.4, h, 'F');
        guideFont(doc, 9, 'bold');
        doc.text(title, left + 5, y + 5.8);
        guideFont(doc, 8.8);
        doc.text(lines, left + 5, y + 10.6);
        y += h + 4;
    });
    return y;
}

function guideFooter(doc, event) {
    const { width, margin } = SLIP;
    setColor(doc, 'draw', SLIP.border);
    doc.setLineWidth(0.3);
    doc.line(margin, 282, width - margin, 282);
    guideFont(doc, 8, 'normal', SLIP.faint);
    doc.text(`${event.name} · Bei Fragen hilft die Orga.`, margin, 287);
    doc.text('Abbildungen schematisch', width - margin, 287, { align: 'right' });
}

/* Windows mock-ups (classic network dialogs, identical in Windows 10 and 11)
   ========================================================================== */

const WIN = {
    frame: [160, 160, 160],
    face: [240, 240, 240],
    field: [122, 122, 122],
    blue: [0, 103, 192],
    select: [204, 232, 255],
    text: [0, 0, 0],
};

// Window with title bar and close cross; returns the y of the client area
function winWindow(doc, x, y, w, h, title) {
    setColor(doc, 'fill', WIN.face);
    setColor(doc, 'draw', WIN.frame);
    doc.setLineWidth(0.3);
    doc.rect(x, y, w, h, 'FD');
    setColor(doc, 'fill', [255, 255, 255]);
    doc.rect(x, y, w, 7, 'F');
    guideFont(doc, 6.6, 'normal', WIN.text);
    doc.text(title, x + 3, y + 4.6);
    setColor(doc, 'draw', [60, 60, 60]);
    doc.setLineWidth(0.25);
    doc.line(x + w - 5.2, y + 2.3, x + w - 2.8, y + 4.7);
    doc.line(x + w - 5.2, y + 4.7, x + w - 2.8, y + 2.3);
    return y + 7;
}

function winButton(doc, x, y, w, label, primary = false) {
    setColor(doc, 'fill', primary ? WIN.blue : [253, 253, 253]);
    setColor(doc, 'draw', primary ? WIN.blue : [190, 190, 190]);
    doc.setLineWidth(0.25);
    doc.roundedRect(x, y, w, 5.6, 0.8, 0.8, 'FD');
    guideFont(doc, 6.4, 'normal', primary ? [255, 255, 255] : WIN.text);
    doc.text(label, x + w / 2, y + 3.8, { align: 'center' });
}

function winRadio(doc, x, y, label, checked) {
    setColor(doc, 'fill', [255, 255, 255]);
    setColor(doc, 'draw', checked ? WIN.blue : [90, 90, 90]);
    doc.setLineWidth(0.25);
    doc.circle(x + 1.5, y - 1.1, 1.5, 'FD');
    if (checked) {
        setColor(doc, 'fill', WIN.blue);
        doc.circle(x + 1.5, y - 1.1, 0.8, 'F');
    }
    guideFont(doc, 6.6, 'normal', WIN.text);
    doc.text(label, x + 4.6, y);
}

// Label + input field; value null = hint text from the slip, '' = empty
function winField(doc, x, y, labelW, fieldW, label, value, highlight) {
    guideFont(doc, 6.6, 'normal', WIN.text);
    doc.text(label, x, y);
    setColor(doc, 'fill', [255, 255, 255]);
    setColor(doc, 'draw', highlight ? SLIP.accent : WIN.field);
    doc.setLineWidth(highlight ? 0.55 : 0.25);
    doc.rect(x + labelW, y - 3.7, fieldW, 5, 'FD');
    if (value === null) {
        guideFont(doc, 6.4, 'bolditalic', SLIP.accent);
        doc.text('vom IP-Zettel', x + labelW + 1.8, y);
    } else if (value) {
        doc.setFont('courier', 'bold');
        doc.setFontSize(7.4);
        setColor(doc, 'text', WIN.text);
        doc.text(value, x + labelW + 1.8, y);
    }
}

// Step 1: Run dialog with "ncpa.cpl"
function winRunDialog(doc, x, y, w) {
    const h = 27;
    let cy = winWindow(doc, x, y, w, h, 'Ausführen');
    guideFont(doc, 6.4, 'normal', WIN.text);
    doc.text('Geben Sie den Namen eines Programms ein.', x + 4, cy + 5);
    doc.text('Öffnen:', x + 4, cy + 11.3);
    setColor(doc, 'fill', [255, 255, 255]);
    setColor(doc, 'draw', SLIP.accent);
    doc.setLineWidth(0.55);
    doc.rect(x + 16, cy + 8, w - 22, 5, 'FD');
    doc.setFont('courier', 'bold');
    doc.setFontSize(8);
    setColor(doc, 'text', WIN.text);
    doc.text('ncpa.cpl', x + 18, cy + 11.6);
    winButton(doc, x + w - 42, cy + 14.5, 18, 'OK', true);
    winButton(doc, x + w - 22, cy + 14.5, 18, 'Abbrechen');
    guideMarker(doc, 1, x - 3, y + 3.5);
    return y + h;
}

// Steps 2/3: properties of the Ethernet adapter, TCP/IPv4 highlighted
function winAdapterDialog(doc, x, y, w) {
    const h = 48;
    let cy = winWindow(doc, x, y, w, h, 'Eigenschaften von Ethernet');
    guideFont(doc, 6.4, 'normal', WIN.text);
    doc.text('Diese Verbindung verwendet folgende Elemente:', x + 4, cy + 5);
    const items = [
        'Client für Microsoft-Netzwerke',
        'Datei- und Druckerfreigabe für Microsoft-Netzwerke',
        'QoS-Paketplaner',
        'Internetprotokoll, Version 4 (TCP/IPv4)',
        'Internetprotokoll, Version 6 (TCP/IPv6)',
    ];
    const listY = cy + 7.5;
    setColor(doc, 'fill', [255, 255, 255]);
    setColor(doc, 'draw', WIN.field);
    doc.setLineWidth(0.25);
    doc.rect(x + 4, listY, w - 8, items.length * 4.6 + 1.5, 'FD');
    items.forEach((item, i) => {
        const iy = listY + 1 + i * 4.6;
        if (i === 3) {
            setColor(doc, 'fill', WIN.select);
            setColor(doc, 'draw', SLIP.accent);
            doc.setLineWidth(0.55);
            doc.rect(x + 4.6, iy, w - 9.2, 4.4, 'FD');
        }
        setColor(doc, 'fill', WIN.blue);
        doc.rect(x + 6, iy + 1.2, 2, 2, 'F');
        guideFont(doc, 6.4, i === 3 ? 'bold' : 'normal', WIN.text);
        doc.text(item, x + 10, iy + 3.1);
    });
    guideMarker(doc, 3, x + w - 4, listY + 1 + 3 * 4.6 + 2.2);
    winButton(doc, x + w - 22, y + h - 7.5, 18, 'Eigenschaften');
    guideMarker(doc, 2, x - 3, y + 3.5);
    return y + h;
}

// Steps 4–6: TCP/IPv4 properties with the event's values
function winIpv4Dialog(doc, x, y, w, values) {
    const h = 98;
    let cy = winWindow(doc, x, y, w, h, 'Eigenschaften von Internetprotokoll, Version 4 (TCP/IPv4)');
    // Tab "Allgemein" and the page below it
    setColor(doc, 'fill', [255, 255, 255]);
    setColor(doc, 'draw', [200, 200, 200]);
    doc.setLineWidth(0.25);
    doc.rect(x + 3, cy + 7, w - 6, h - 23, 'FD');
    doc.rect(x + 4, cy + 2.5, 15, 4.6, 'FD');
    setColor(doc, 'fill', [255, 255, 255]);
    doc.rect(x + 4.15, cy + 6.6, 14.7, 0.8, 'F');
    guideFont(doc, 6.4, 'normal', WIN.text);
    doc.text('Allgemein', x + 5.6, cy + 5.8);

    const labelW = 40, fieldW = w - labelW - 18;
    let ry = cy + 14;
    winRadio(doc, x + 6, ry, 'IP-Adresse automatisch beziehen', false);
    ry += 6.5;
    winRadio(doc, x + 6, ry, 'Folgende IP-Adresse verwenden:', true);
    guideMarker(doc, 4, x - 3, ry - 1.1);
    ry += 7;
    winField(doc, x + 10, ry, labelW, fieldW, 'IP-Adresse:', null, true);
    ry += 6.5;
    winField(doc, x + 10, ry, labelW, fieldW, 'Subnetzmaske:', values.mask, true);
    ry += 6.5;
    winField(doc, x + 10, ry, labelW, fieldW, 'Standardgateway:', values.gateway, true);
    ry += 9;
    winRadio(doc, x + 6, ry, 'DNS-Serveradresse automatisch beziehen', false);
    ry += 6.5;
    winRadio(doc, x + 6, ry, 'Folgende DNS-Serveradressen verwenden:', true);
    guideMarker(doc, 5, x - 3, ry - 1.1);
    ry += 7;
    winField(doc, x + 10, ry, labelW, fieldW, 'Bevorzugter DNS-Server:', values.dns, true);
    ry += 6.5;
    winField(doc, x + 10, ry, labelW, fieldW, 'Alternativer DNS-Server:', '', false);

    const by = y + h - 9;
    winButton(doc, x + w - 42, by, 18, 'OK', true);
    winButton(doc, x + w - 22, by, 18, 'Abbrechen');
    setColor(doc, 'draw', SLIP.accent);
    doc.setLineWidth(0.55);
    doc.roundedRect(x + w - 42.6, by - 0.6, 19.2, 6.8, 1, 1, 'S');
    guideMarker(doc, 6, x + w - 46, by + 2.8);
    return y + h;
}

function addWindowsGuide(doc, event) {
    const values = guideValues(event);
    guideHeader(doc, event, 'Feste IP-Adresse unter Windows', 'Windows 10 und 11 · für jeden PC mit seiner eigenen Adresse vom IP-Zettel');
    guideValueBoxes(doc, values, 58);

    let y = guideSteps(doc, [
        'Windows-Taste + R drücken, „ncpa.cpl“ eingeben und Enter.',
        'Rechtsklick auf die LAN-Verbindung („Ethernet“) › „Eigenschaften“.',
        'Doppelklick auf „Internetprotokoll, Version 4 (TCP/IPv4)“.',
        '„Folgende IP-Adresse verwenden“: IP-Adresse, Subnetzmaske und Standardgateway eintragen.',
        '„Folgende DNS-Serveradressen verwenden“: DNS-Server eintragen.',
        'Mit „OK“ bestätigen, dann auch das Fenster der Verbindung mit „OK“ schließen.',
    ], GUIDE.top);
    guideTips(doc, [
        ['Testen', `Windows-Taste + R › „cmd“ › ping ${values.gateway || 'Gateway-Adresse'} – kommen Antworten, passt alles.`],
        ['Nach der LAN', 'Beide Punkte wieder auf „automatisch beziehen“ stellen, sonst klappt das Internet zu Hause nicht.'],
    ], y + 3);

    let my = GUIDE.top - 4;
    my = winRunDialog(doc, GUIDE.mockX, my, GUIDE.mockWidth) + GUIDE.mockGap;
    my = winAdapterDialog(doc, GUIDE.mockX, my, GUIDE.mockWidth) + GUIDE.mockGap;
    winIpv4Dialog(doc, GUIDE.mockX, my, GUIDE.mockWidth, values);
    guideFooter(doc, event);
}

/* macOS mock-ups (System Settings since macOS 13 Ventura)
   ========================================================================== */

const MAC = {
    window: [246, 246, 246],
    sidebar: [232, 232, 232],
    border: [205, 205, 205],
    blue: [10, 132, 255],
    text: [30, 30, 30],
    muted: [120, 120, 120],
};

function macWindow(doc, x, y, w, h) {
    setColor(doc, 'fill', MAC.window);
    setColor(doc, 'draw', MAC.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, y, w, h, 2.5, 2.5, 'FD');
    [[255, 95, 87], [254, 188, 46], [40, 200, 64]].forEach((rgb, i) => {
        setColor(doc, 'fill', rgb);
        doc.circle(x + 4 + i * 3.6, y + 3.8, 1.1, 'F');
    });
}

function macSidebar(doc, x, y, w, h, items, selected) {
    setColor(doc, 'fill', MAC.sidebar);
    doc.roundedRect(x + 0.3, y + 0.3, w, h - 0.6, 2.3, 2.3, 'F');
    doc.rect(x + w - 3, y + 0.3, 3, h - 0.6, 'F');
    items.forEach((item, i) => {
        const iy = y + 9 + i * 5.4;
        if (i === selected) {
            setColor(doc, 'fill', MAC.blue);
            doc.roundedRect(x + 2, iy - 3.6, w - 4, 5, 1.2, 1.2, 'F');
        }
        guideFont(doc, 6.6, i === selected ? 'bold' : 'normal', i === selected ? [255, 255, 255] : MAC.text);
        doc.text(item, x + 4, iy);
    });
}

function macButton(doc, x, y, w, label, primary = false, highlight = false) {
    setColor(doc, 'fill', primary ? MAC.blue : [255, 255, 255]);
    setColor(doc, 'draw', highlight ? SLIP.accent : primary ? MAC.blue : MAC.border);
    doc.setLineWidth(highlight ? 0.55 : 0.25);
    doc.roundedRect(x, y, w, 5.2, 1.2, 1.2, 'FD');
    guideFont(doc, 6.4, 'normal', primary ? [255, 255, 255] : MAC.text);
    doc.text(label, x + w / 2, y + 3.6, { align: 'center' });
}

// Right-aligned label + rounded field (value null = hint from the slip)
function macField(doc, x, y, labelW, fieldW, label, value, highlight) {
    guideFont(doc, 6.6, 'normal', MAC.text);
    doc.text(label, x + labelW - 2, y, { align: 'right' });
    setColor(doc, 'fill', [255, 255, 255]);
    setColor(doc, 'draw', highlight ? SLIP.accent : MAC.border);
    doc.setLineWidth(highlight ? 0.55 : 0.25);
    doc.roundedRect(x + labelW, y - 3.6, fieldW, 5, 1, 1, 'FD');
    if (value === null) {
        guideFont(doc, 6.4, 'bolditalic', SLIP.accent);
        doc.text('vom IP-Zettel', x + labelW + 1.8, y);
    } else if (value) {
        doc.setFont('courier', 'bold');
        doc.setFontSize(7.4);
        setColor(doc, 'text', MAC.text);
        doc.text(value, x + labelW + 1.8, y);
    }
}

// Steps 1/2: System Settings › Network with the Ethernet service and "Details …"
function macNetworkWindow(doc, x, y, w) {
    const h = 36, side = 30;
    macWindow(doc, x, y, w, h);
    macSidebar(doc, x, y + 4, side, h - 4, ['WLAN', 'Bluetooth', 'Netzwerk', 'Mitteilungen'], 2);
    guideFont(doc, 8.5, 'bold', MAC.text);
    doc.text('Netzwerk', x + side + 5, y + 8.5);
    const ry = y + 13;
    setColor(doc, 'fill', [255, 255, 255]);
    setColor(doc, 'draw', MAC.border);
    doc.setLineWidth(0.25);
    doc.roundedRect(x + side + 5, ry, w - side - 10, 17, 1.5, 1.5, 'FD');
    setColor(doc, 'fill', [61, 220, 118]);
    doc.circle(x + side + 9, ry + 4.6, 1, 'F');
    guideFont(doc, 6.8, 'bold', MAC.text);
    doc.text('Ethernet', x + side + 12, ry + 5.2);
    guideFont(doc, 6.2, 'normal', MAC.muted);
    doc.text('Verbunden', x + side + 12, ry + 9.2);
    macButton(doc, x + w - 26, ry + 10, 18, 'Details …', false, true);
    guideMarker(doc, 1, x - 3, y + 3.8);
    guideMarker(doc, 2, x + w - 29, ry + 12.6);
    return y + h;
}

// Steps 3/4: Details › TCP/IP
function macTcpIpSheet(doc, x, y, w, values) {
    const h = 58, side = 26;
    macWindow(doc, x, y, w, h);
    macSidebar(doc, x, y + 4, side, h - 4, ['Details', 'TCP/IP', 'DNS', 'WINS', '802.1X', 'Proxys', 'Hardware'], 1);
    const fx = x + side + 2, labelW = 30, fieldW = w - side - labelW - 7;
    let ry = y + 13;
    // "Configure IPv4" pop-up set to "Manuell"
    guideFont(doc, 6.6, 'normal', MAC.text);
    doc.text('IPv4 konfigurieren', fx + labelW - 2, ry, { align: 'right' });
    setColor(doc, 'fill', [255, 255, 255]);
    setColor(doc, 'draw', SLIP.accent);
    doc.setLineWidth(0.55);
    doc.roundedRect(fx + labelW, ry - 3.6, 26, 5, 1, 1, 'FD');
    guideFont(doc, 6.6, 'bold', MAC.text);
    doc.text('Manuell', fx + labelW + 1.8, ry);
    setColor(doc, 'fill', MAC.blue);
    doc.roundedRect(fx + labelW + 21.5, ry - 3.1, 4, 4, 0.8, 0.8, 'F');
    guideMarker(doc, 3, x + w - 6, ry - 1.1);
    ry += 8;
    macField(doc, fx, ry, labelW, fieldW, 'IP-Adresse', null, true);
    guideMarker(doc, 4, x - 3, ry + 5.4);
    ry += 6.5;
    macField(doc, fx, ry, labelW, fieldW, 'Teilnetzmaske', values.mask, true);
    ry += 6.5;
    macField(doc, fx, ry, labelW, fieldW, 'Router', values.gateway, true);
    ry += 9;
    guideFont(doc, 6.6, 'normal', MAC.muted);
    doc.text('IPv6 konfigurieren', fx + labelW - 2, ry, { align: 'right' });
    doc.text('Automatisch', fx + labelW + 1.8, ry);
    macButton(doc, x + w - 48, y + h - 8, 16, 'Abbrechen');
    macButton(doc, x + w - 22, y + h - 8, 16, 'OK', true, true);
    guideMarker(doc, 6, x + w - 27, y + h - 5.4);
    return y + h;
}

// Step 5: Details › DNS with the server added via "+"
function macDnsSheet(doc, x, y, w, values) {
    const h = 44, side = 26;
    macWindow(doc, x, y, w, h);
    macSidebar(doc, x, y + 4, side, h - 4, ['Details', 'TCP/IP', 'DNS', 'WINS', '802.1X', 'Proxys'], 2);
    const lx = x + side + 5, lw = w - side - 10;
    guideFont(doc, 6.6, 'bold', MAC.text);
    doc.text('DNS-Server', lx, y + 10);
    setColor(doc, 'fill', [255, 255, 255]);
    setColor(doc, 'draw', SLIP.accent);
    doc.setLineWidth(0.55);
    doc.roundedRect(lx, y + 12, lw, 18, 1.2, 1.2, 'FD');
    setColor(doc, 'fill', [220, 235, 255]);
    doc.rect(lx + 0.6, y + 13, lw - 1.2, 4.6, 'F');
    if (values.dns) {
        doc.setFont('courier', 'bold');
        doc.setFontSize(7.4);
        setColor(doc, 'text', MAC.text);
        doc.text(values.dns, lx + 2, y + 16.3);
    } else {
        guideFont(doc, 6.4, 'italic', MAC.muted);
        doc.text('DNS-Server-Adresse', lx + 2, y + 16.3);
    }
    // + / − buttons below the list
    setColor(doc, 'draw', MAC.border);
    doc.setLineWidth(0.25);
    doc.line(lx, y + 26, lx + lw, y + 26);
    guideFont(doc, 8, 'bold', MAC.text);
    doc.text('+', lx + 2.2, y + 29.2);
    doc.text('–', lx + 7, y + 29.2);
    guideMarker(doc, 5, x - 3, y + 15.2);
    macButton(doc, x + w - 48, y + h - 8, 16, 'Abbrechen');
    macButton(doc, x + w - 22, y + h - 8, 16, 'OK', true);
    return y + h;
}

function addMacGuide(doc, event) {
    const values = guideValues(event);
    guideHeader(doc, event, 'Feste IP-Adresse unter macOS', 'macOS 13 Ventura und neuer · für jeden Mac mit seiner eigenen Adresse vom IP-Zettel');
    guideValueBoxes(doc, values, 58);

    let y = guideSteps(doc, [
        'Apple-Menü › „Systemeinstellungen“ › „Netzwerk“.',
        'Die LAN-Verbindung wählen („Ethernet“ bzw. USB-/Thunderbolt-LAN-Adapter) und auf „Details …“ klicken.',
        'Links „TCP/IP“ wählen und „IPv4 konfigurieren“ auf „Manuell“ stellen.',
        'IP-Adresse, Teilnetzmaske und Router eintragen.',
        'Links „DNS“ wählen, unter „DNS-Server“ auf „+“ klicken und den DNS-Server eintragen.',
        'Mit „OK“ bestätigen.',
    ], GUIDE.top);
    guideTips(doc, [
        ['Testen', `Terminal öffnen, ping ${values.gateway || 'Gateway-Adresse'} eingeben – kommen Antworten, passt alles (beenden mit ctrl-C).`],
        ['Nach der LAN', '„IPv4 konfigurieren“ wieder auf „DHCP“ stellen und den DNS-Eintrag mit „–“ entfernen.'],
    ], y + 3);

    let my = GUIDE.top - 4;
    my = macNetworkWindow(doc, GUIDE.mockX, my, GUIDE.mockWidth) + GUIDE.mockGap;
    my = macTcpIpSheet(doc, GUIDE.mockX, my, GUIDE.mockWidth, values) + GUIDE.mockGap;
    macDnsSheet(doc, GUIDE.mockX, my, GUIDE.mockWidth, values);
    guideFooter(doc, event);
}

function buildGuidePdf(event) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    addWindowsGuide(doc, event);
    doc.addPage();
    addMacGuide(doc, event);
    doc.setProperties({ title: `Anleitung feste IP-Adresse – ${event.name}`, creator: 'MCD Brackets' });
    return doc;
}

function exportIpGuide() {
    const event = currentEvent();
    if (!event) return;
    try {
        buildGuidePdf(event).save(`anleitung-feste-ip-${slipFileSlug(event.name)}.pdf`);
    } catch (error) {
        alert('❌ Fehler beim Erzeugen des PDFs: ' + error.message);
    }
}
