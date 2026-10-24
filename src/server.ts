import express, { ErrorRequestHandler, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { APP_TABLES, dataDir, dbPath, ensureAppTables, getManager, getStorage, replaceDatabase, withLock, withRollback } from './db';
import {
  authRequired, clearedSessionCookie, createSessionToken, isAdmin, loginRetryAfter, passwordMatches, recordLoginFailure,
  rejectCrossSite, requireAdminForChanges, resetLoginFailures, sessionCookie,
} from './auth';
import { HttpError } from './http-error';
import { ValidationError } from './lan';
import { lanRouter } from './lan-routes';
import { opnsenseRouter } from './opnsense-routes';
import { seatingRouter } from './seating-routes';
import { loadPoints, pointsRouter } from './points-routes';
import { migrateRooms } from './seating-store';
import { OpnsenseError } from './opnsense';
import { getStats, startUpdateChecks, updateFor } from './info';
import { playerNamesForEvent, syncEventsFromStages } from './lan-store';
import { isStageType, normalizeNames } from './seeding';
import { createStage, deleteStage, findStage, pickSettings, resolveMemorialMatches } from './stages';
import { getStandings } from './standings';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const publicDir = path.join(__dirname, '../public');

// Cache busting: every server start (i.e. every new image/container) gets its own build ID,
// which is appended to the JS/CSS URLs in index.html, so browsers never keep stale assets.
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
const version: string = packageJson.version;
// For the footer: "https://github.com/<owner>/<repo>" from the repository field
const REPO_URL: string = String(packageJson.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
const BUILD_ID = `${version}-${Date.now().toString(36)}`;

app.disable('x-powered-by');

// Behind a reverse proxy: TRUST_PROXY=true (or hop count / proxy addresses), so req.ip,
// req.secure and req.host come from the X-Forwarded-* headers
function trustProxySetting(value: string | undefined): boolean | number | string {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}
app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));

// Security headers. 'unsafe-inline' is needed for the onclick handlers and style attributes;
// everything else may only come from this server, and the app must not be framed (click-to-win).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((_req: Request, res: Response, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.get(['/', '/index.html'], (_req: Request, res: Response) => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8')
    .replace(/(src|href)="((?:lib\/)?[\w.-]+\.(?:js|css))"/g, `$1="$2?v=${BUILD_ID}"`)
    .replaceAll('{{APP_VERSION}}', version)
    .replaceAll('{{REPO_URL}}', REPO_URL);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
});

app.use(express.static(publicDir, { etag: true, lastModified: true, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); } }));

// API Routes

// Changes only from the app's own pages (CSRF), and only with the admin session (ADMIN_PASSWORD).
// Both run before the body parser, so nobody can make the server parse large bodies without login.
app.use('/api', rejectCrossSite);
app.use('/api', requireAdminForChanges);
// A restore carries the whole database; everything else is small (the event logo is up to 2 MB)
app.use('/api/restore', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '3mb' }));

app.get('/api/auth', (req: Request, res: Response) => {
  res.json({ required: authRequired(), admin: isAdmin(req) });
});

app.post('/api/login', async (req: Request, res: Response) => {
  if (!authRequired()) {
    res.json({ required: false, admin: true });
    return;
  }
  const ip = req.ip ?? '';
  const retryAfter = loginRetryAfter(ip);
  if (retryAfter > 0) {
    res.setHeader('Retry-After', String(retryAfter));
    throw new HttpError(429, `Zu viele Fehlversuche — bitte in ${Math.ceil(retryAfter / 60)} Minute(n) erneut versuchen`);
  }
  if (!passwordMatches(req.body?.password)) {
    recordLoginFailure(ip);
    await new Promise(resolve => setTimeout(resolve, 800)); // slows down guessing
    throw new HttpError(401, 'Falsches Passwort');
  }
  resetLoginFailures(ip);
  res.setHeader('Set-Cookie', sessionCookie(createSessionToken(), req.secure));
  res.json({ required: true, admin: true });
});

app.post('/api/logout', (req: Request, res: Response) => {
  res.setHeader('Set-Cookie', clearedSessionCookie(req.secure));
  res.json({ required: authRequired(), admin: !authRequired() });
});

// Events (LAN settings) and their attendees
app.use('/api', lanRouter);
app.use('/api', opnsenseRouter);
app.use('/api', seatingRouter);
app.use('/api', pointsRouter);

// Get all tournaments (stages)
app.get('/api/stages', async (_req: Request, res: Response) => {
  res.json((await getStorage().select('stage')) ?? []);
});

// Get specific stage
app.get('/api/stages/:id', async (req: Request<{ id: string }>, res: Response) => {
  res.json(await findStage(parseInt(req.params.id)));
});

// Get matches for a stage
app.get('/api/stages/:id/matches', async (req: Request<{ id: string }>, res: Response) => {
  res.json((await getStorage().select('match', { stage_id: parseInt(req.params.id) })) ?? []);
});

// Get all matches
app.get('/api/matches', async (_req: Request, res: Response) => {
  res.json((await getStorage().select('match')) ?? []);
});

// Create a new stage; the server assigns the tournament ID and the random seeding.
// Without an explicit participants list, all attendees of the event play.
app.post('/api/stages', async (req: Request, res: Response) => {
  const { name, type, participants, settings } = req.body ?? {};
  const eventName = typeof req.body?.eventName === 'string' ? req.body.eventName.trim() || undefined : undefined;
  const explicitNames = participants === undefined ? undefined : normalizeNames(participants);

  if (typeof name !== 'string' || !name.trim() || !isStageType(type) || explicitNames === null) {
    throw new HttpError(400, 'Missing required fields: name, type');
  }

  const stage = await withLock(async () => {
    const fromEvent = explicitNames ? null : await playerNamesForEvent(eventName);
    const names = explicitNames ?? fromEvent?.players;
    if (!names) {
      throw new HttpError(400, 'Ohne Teilnehmerliste muss ein vorhandenes Event angegeben werden');
    }
    const stages = (await getStorage().select('stage')) ?? [];
    const tournamentId = stages.reduce((max, s) => Math.max(max, Number(s.tournament_id)), 0) + 1;
    const created = await withRollback(() => createStage({
      tournamentId,
      name: name.trim(),
      type,
      names,
      settings: pickSettings(settings),
      eventName,
      memorial: fromEvent?.memorial ?? []
    }));
    await syncEventsFromStages();
    return created;
  });

  res.status(201).json(stage);
});

// Re-create a stage with a new random draw. Players: the given list, else the event's
// current attendees, else the stage's previous players (tournaments without attendee list).
// Keeps tournament ID, name, type, event and settings; rolls back if anything fails.
app.post('/api/stages/:id/regenerate', async (req: Request<{ id: string }>, res: Response) => {
  const newNames = req.body?.participants === undefined ? undefined : normalizeNames(req.body.participants);
  if (newNames === null) {
    throw new HttpError(400, 'participants must be an array of names');
  }

  const stage = await withLock(() => withRollback(async () => {
    const stage = await findStage(parseInt(req.params.id));
    const fromEvent = await playerNamesForEvent(stage.event_name);
    const useEvent = !newNames && !!fromEvent?.players.length;
    // Fallback (tournaments without attendee list): previous players minus previous memorial entries
    const previousMemorial = new Set(stage.memorial_names ?? []);
    const names = newNames
      ?? (useEvent ? fromEvent!.players : null)
      ?? ((await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [])
        .map(p => p.name)
        .filter(name => name && !previousMemorial.has(name));
    const memorial = useEvent ? fromEvent!.memorial : [...previousMemorial];

    await deleteStage(stage);
    return createStage({
      tournamentId: stage.tournament_id,
      name: stage.name,
      type: stage.type,
      names,
      settings: pickSettings(stage.settings),
      eventName: stage.event_name,
      memorial
    });
  }));

  res.status(201).json(stage);
});

// Update match result
app.put('/api/matches/:id', async (req: Request<{ id: string }>, res: Response) => {
  const { opponent1, opponent2 } = req.body ?? {};
  const matchId = parseInt(req.params.id);

  const updatedMatch = await withLock(async () => {
    await getManager().update.match({ id: matchId, opponent1, opponent2 });
    const match = await getStorage().select('match', matchId);
    if (match) await resolveMemorialMatches(match.stage_id); // next matches may be against a memorial entry
    return getStorage().select('match', matchId);
  });
  res.json(updatedMatch ?? {});
});

// Delete a stage (including all participants for that tournament)
app.delete('/api/stages/:id', async (req: Request<{ id: string }>, res: Response) => {
  await withLock(async () => deleteStage(await findStage(parseInt(req.params.id))));
  res.status(204).send();
});

// Get participants
app.get('/api/participants', async (_req: Request, res: Response) => {
  res.json((await getStorage().select('participant')) ?? []);
});

// Create participant
app.post('/api/participants', async (req: Request, res: Response) => {
  const { tournamentId, name } = req.body ?? {};

  if (tournamentId == null || !name) {
    throw new HttpError(400, 'Missing required fields: tournamentId, name');
  }

  const participant = await withLock(() => getStorage().insert('participant', { tournament_id: tournamentId, name }));
  res.status(201).json(participant);
});

// Delete participant
app.delete('/api/participants/:id', async (req: Request<{ id: string }>, res: Response) => {
  await withLock(() => getStorage().delete('participant', { id: parseInt(req.params.id) }));
  res.status(204).send();
});

// Get complete tournament data for viewer
app.get('/api/viewer-data/:stageId', async (req: Request<{ stageId: string }>, res: Response) => {
  const stageId = parseInt(req.params.stageId);
  const stage = await findStage(stageId);
  const storage = getStorage();

  res.json({
    stage: [stage],
    match: (await storage.select('match', { stage_id: stageId })) ?? [],
    match_game: (await storage.select('match_game', { stage_id: stageId })) ?? [],
    participant: (await storage.select('participant', { tournament_id: stage.tournament_id })) ?? []
  });
});

// Get final standings/placements incl. championship points for a stage
app.get('/api/standings/:stageId', async (req: Request<{ stageId: string }>, res: Response) => {
  // Points come from the current settings, so changing them recalculates every tournament
  const standings = await getStandings(getStorage(), getManager(), parseInt(req.params.stageId), await loadPoints());
  if (!standings) throw new HttpError(404, 'Stage not found');
  res.json(standings);
});

// DB Backup: download db.json
app.get('/api/backup', (_req: Request, res: Response) => {
  if (!fs.existsSync(dbPath)) {
    throw new HttpError(404, 'No database file found');
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="mcd-brackets-backup-${timestamp}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(dbPath);
});

// DB Import: restore db.json from uploaded backup
app.post('/api/restore', async (req: Request, res: Response) => {
  const parsed = req.body;
  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(400, 'Keine Daten empfangen');
  }
  // Basic sanity check — db.json must have known top-level keys
  const knownKeys = ['participant', 'stage', 'group', 'round', 'match', 'match_game', ...APP_TABLES];
  if (!knownKeys.some(k => Array.isArray(parsed[k]))) {
    throw new HttpError(400, 'Die Datei sieht nicht wie ein gültiges mcd.brackets-Backup aus');
  }

  await withLock(async () => {
    // Write backup of current db first
    if (fs.existsSync(dbPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(dbPath, path.join(dataDir, `db-before-restore-${ts}.json`));
    }
    await replaceDatabase(parsed);
    await syncEventsFromStages();
    await migrateRooms();
  });
  res.json({ ok: true, message: 'Datenbank wiederhergestellt. Bitte Seite neu laden.' });
});

// Footer: version, newer version on GitHub (if known) and short statistics
app.get('/api/info', async (_req: Request, res: Response) => {
  res.json({ version, repo_url: REPO_URL, update: updateFor(version), stats: await getStats() });
});

// JSON errors for all routes (Express 5 forwards rejected promises here)
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  // OpnsenseError: the firewall failed or is unreachable → 502 with a readable message
  // Client errors of Express/body-parser (invalid JSON, body too large) carry their own 4xx status
  const clientStatus = Number(error?.status ?? error?.statusCode);
  const status = error instanceof HttpError ? error.status
    : error instanceof ValidationError ? 400
    : error instanceof OpnsenseError ? 502
    : clientStatus >= 400 && clientStatus < 500 ? clientStatus
    : 500;
  if (status === 500) console.error(error);
  // Node system errors (ENOENT, EACCES, …) contain file paths → don't show them;
  // other messages (e.g. from brackets-manager) are shown in the app
  const hidden = status === 500 && (typeof error?.code === 'string' || !error?.message);
  res.status(status).json({ error: hidden ? 'Interner Serverfehler' : error.message });
};
app.use(errorHandler);

// Start server (after creating missing tables and event records for existing tournaments)
async function start(): Promise<void> {
  await ensureAppTables();
  await syncEventsFromStages();
  const migrated = await migrateRooms();
  if (migrated > 0) console.log(`🪑 ${migrated} Sitzplan-Raum/Räume ins neue Format übernommen`);
  if (!authRequired()) {
    console.warn('⚠️  Kein ADMIN_PASSWORD gesetzt — alle Besucher dürfen Turniere und Teilnehmer bearbeiten.');
  }
  startUpdateChecks(REPO_URL);
  app.listen(PORT, () => {
    console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
    console.log(`📊 API verfügbar unter http://localhost:${PORT}/api`);
  });
}

start().catch(error => {
  console.error('Start fehlgeschlagen:', error);
  process.exit(1);
});
