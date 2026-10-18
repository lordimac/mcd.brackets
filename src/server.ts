import express, { ErrorRequestHandler, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { APP_TABLES, dataDir, dbPath, ensureAppTables, getManager, getStorage, replaceDatabase, withLock, withRollback } from './db';
import { authRequired, clearedSessionCookie, createSessionToken, isAdmin, passwordMatches, requireAdminForChanges, sessionCookie } from './auth';
import { HttpError } from './http-error';
import { ValidationError } from './lan';
import { lanRouter } from './lan-routes';
import { playerNamesForEvent, syncEventsFromStages } from './lan-store';
import { isStageType, normalizeNames } from './seeding';
import { createStage, deleteStage, findStage, pickSettings, resolveMemorialMatches } from './stages';
import { getStandings } from './standings';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const publicDir = path.join(__dirname, '../public');

// Cache busting: every server start (i.e. every new image/container) gets its own build ID,
// which is appended to the JS/CSS URLs in index.html, so browsers never keep stale assets.
const version: string = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8')).version;
const BUILD_ID = `${version}-${Date.now().toString(36)}`;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get(['/', '/index.html'], (_req: Request, res: Response) => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8')
    .replace(/(src|href)="((?:lib\/)?[\w.-]+\.(?:js|css))"/g, `$1="$2?v=${BUILD_ID}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
});

app.use(express.static(publicDir, { etag: true, lastModified: true, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); } }));

// API Routes

// Admin login (ADMIN_PASSWORD): reads stay public, changes need the session cookie
app.use('/api', requireAdminForChanges);

app.get('/api/auth', (req: Request, res: Response) => {
  res.json({ required: authRequired(), admin: isAdmin(req) });
});

app.post('/api/login', async (req: Request, res: Response) => {
  if (!authRequired()) {
    res.json({ required: false, admin: true });
    return;
  }
  if (!passwordMatches(req.body?.password)) {
    await new Promise(resolve => setTimeout(resolve, 800)); // slows down guessing
    throw new HttpError(401, 'Falsches Passwort');
  }
  res.setHeader('Set-Cookie', sessionCookie(createSessionToken()));
  res.json({ required: true, admin: true });
});

app.post('/api/logout', (_req: Request, res: Response) => {
  res.setHeader('Set-Cookie', clearedSessionCookie);
  res.json({ required: authRequired(), admin: !authRequired() });
});

// Events (LAN settings) and their attendees
app.use('/api', lanRouter);

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
  const standings = await getStandings(getStorage(), getManager(), parseInt(req.params.stageId));
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
  });
  res.json({ ok: true, message: 'Datenbank wiederhergestellt. Bitte Seite neu laden.' });
});

// JSON errors for all routes (Express 5 forwards rejected promises here)
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error instanceof HttpError ? error.status : error instanceof ValidationError ? 400 : 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: error.message || 'Internal server error' });
};
app.use(errorHandler);

// Start server (after creating missing tables and event records for existing tournaments)
async function start(): Promise<void> {
  await ensureAppTables();
  await syncEventsFromStages();
  if (!authRequired()) {
    console.warn('⚠️  Kein ADMIN_PASSWORD gesetzt — alle Besucher dürfen Turniere und Teilnehmer bearbeiten.');
  }
  app.listen(PORT, () => {
    console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
    console.log(`📊 API verfügbar unter http://localhost:${PORT}/api`);
  });
}

start().catch(error => {
  console.error('Start fehlgeschlagen:', error);
  process.exit(1);
});
