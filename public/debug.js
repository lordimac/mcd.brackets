// Debug mode for admins (switch in the footer, remembered in this browser):
// - impersonate an attendee: the button in the attendee list picks one of their IPs, the page then
//   looks like on that device (the admin test view of /api/whoami, welcome.js welcomeTestIp);
//   back via the x next to the name at the top right
// - fake the date and time: Date is replaced by a class running with an offset, so the timetable,
//   playing times, "Jetzt" and the clocks show that moment. Only in this browser and only for the
//   display; the server (decisions by lot, closing rounds) keeps the real time.
// Uses isAdmin, notify, showView, toLocalInput from app.js and welcomeTestIp, showWelcomeView,
// resetWelcomeTest from welcome.js.

const RealDate = Date;
let debugMode = false;
let debugTimeOffset = 0; // ms added to the real time

class DebugDate extends RealDate {
    constructor(...args) {
        if (args.length) super(...args);
        else super(RealDate.now() + debugTimeOffset);
    }

    static now() {
        return RealDate.now() + debugTimeOffset;
    }
}

function readDebugSetting(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function writeDebugSetting(key, value) {
    try {
        if (value == null || value === '') localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch { /* storage unavailable */ }
}

function applyDebugTime(offset) {
    debugTimeOffset = offset;
    window.Date = offset ? DebugDate : RealDate;
    document.body?.classList.toggle('debug-time', Boolean(offset));
}

// Before the first render: the stored state applies at once (an admin check follows in syncDebugMode)
if (readDebugSetting('mcd.debug') === '1') {
    debugMode = true;
    applyDebugTime(Number(readDebugSetting('mcd.debugTimeOffset')) || 0);
    const impersonated = readDebugSetting('mcd.impersonate');
    if (impersonated) welcomeTestIp = impersonated;
}

// After loadAuth (app.js): only admins keep the debug mode
function syncDebugMode() {
    if (debugMode && !isAdmin) {
        setDebugMode(false);
        return;
    }
    renderDebugControls();
}

function setDebugMode(on) {
    debugMode = Boolean(on) && isAdmin;
    writeDebugSetting('mcd.debug', debugMode ? '1' : null);
    if (!debugMode) {
        if (debugTimeOffset) setDebugTime('');
        if (readDebugSetting('mcd.impersonate')) endImpersonation();
    }
    renderDebugControls();
}

function renderDebugControls() {
    document.body.classList.toggle('debug-mode', debugMode);
    document.body.classList.toggle('debug-time', debugMode && Boolean(debugTimeOffset));
    document.getElementById('debugToggle').checked = debugMode;
    document.getElementById('debugTools').hidden = !debugMode;
    document.getElementById('debugTime').value = toLocalInput(new Date().toISOString());
    document.getElementById('debugTimeReset').hidden = !debugTimeOffset;
}

// value: "YYYY-MM-DDTHH:MM" (local) from the input, '' = the real time again
function setDebugTime(value) {
    const target = value ? new RealDate(value).getTime() : NaN;
    applyDebugTime(Number.isFinite(target) ? target - RealDate.now() : 0);
    writeDebugSetting('mcd.debugTimeOffset', debugTimeOffset ? String(debugTimeOffset) : null);
    renderDebugControls();
    showView(); // the open view draws again with the new time
    notify(debugTimeOffset
        ? `Die Seite tut jetzt so, als wäre es ${new Date().toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}. Nur in diesem Browser.`
        : 'Wieder die echte Uhrzeit.');
}

// Look at the page as the device with this IP (one of the attendee's addresses)
async function impersonate(ip) {
    welcomeTestIp = ip;
    writeDebugSetting('mcd.impersonate', ip);
    await showWelcomeView();
    if (document.body.dataset.view !== 'welcome') showView();
    const who = me?.status === 'identified' ? me.attendee.display_name : null;
    notify(`Du siehst die Seite jetzt ${who ? `wie ${who}` : 'wie das Gerät'} (${ip}). Zurück über das Kreuz oben rechts.`);
}

async function endImpersonation() {
    writeDebugSetting('mcd.impersonate', null);
    await resetWelcomeTest();
    if (document.body.dataset.view !== 'welcome') showView();
}
