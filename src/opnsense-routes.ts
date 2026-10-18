import { Router, Request, Response } from 'express';
import { getAppStore, withLock } from './db';
import { HttpError } from './http-error';
import { getEvent, listAttendees } from './lan-store';
import {
  applyPlan, createOpnsenseClient, desiredRecords, EMPTY_SETTINGS, planSync, settingsView, validateSettings,
  type OpnsenseSettings, type OpnsenseSettingsInput,
} from './opnsense';

// Routes for the OPNsense connection (admin only, see auth.ts) and the Unbound sync
export const opnsenseRouter = Router();

type IdParams = { id: string };
type Mode = 'sync' | 'remove';

async function loadSettings(): Promise<OpnsenseSettings | null> {
  return ((await getAppStore().select('opnsense')) ?? [])[0] ?? null;
}

async function currentSettings(): Promise<Omit<OpnsenseSettings, 'id'>> {
  return (await loadSettings()) ?? EMPTY_SETTINGS;
}

async function saveSettings(input: OpnsenseSettingsInput): Promise<Omit<OpnsenseSettings, 'id'>> {
  const stored = await loadSettings();
  const settings = validateSettings(input, stored ?? EMPTY_SETTINGS);
  if (stored) await getAppStore().update('opnsense', stored.id, { ...settings, id: stored.id });
  else await getAppStore().insert('opnsense', settings);
  return settings;
}

function idParam(req: Request<IdParams>): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID');
  return id;
}

function modeOf(req: Request): Mode {
  return req.body?.mode === 'remove' ? 'remove' : 'sync';
}

async function buildPlan(eventId: number, mode: Mode) {
  const event = await getEvent(eventId);
  const desired = mode === 'sync' ? desiredRecords(event, await listAttendees(event.id)) : [];
  const client = createOpnsenseClient(await currentSettings());
  const plan = planSync(event.id, desired, await client.searchHosts(), mode);
  return { event, client, plan };
}

/* Settings */

opnsenseRouter.get('/opnsense', async (_req: Request, res: Response) => {
  res.json(settingsView(await currentSettings()));
});

opnsenseRouter.put('/opnsense', async (req: Request, res: Response) => {
  res.json(settingsView(await withLock(() => saveSettings(req.body ?? {}))));
});

// Test with the values from the form (not saved yet); an empty secret uses the stored one
opnsenseRouter.post('/opnsense/test', async (req: Request, res: Response) => {
  const settings = validateSettings(req.body ?? {}, await currentSettings());
  const rows = await createOpnsenseClient(settings).searchHosts();
  res.json({ ok: true, host_count: rows.length });
});

/* Sync of an event's DNS names to Unbound host overrides */

// Only one sync at a time: two parallel runs would both create the same entries
let syncRunning = false;

opnsenseRouter.post('/events/:id/opnsense/preview', async (req: Request<IdParams>, res: Response) => {
  const { plan } = await buildPlan(idParam(req), modeOf(req));
  res.json(plan);
});

// Plans again against the current state of the firewall, then applies it
opnsenseRouter.post('/events/:id/opnsense/apply', async (req: Request<IdParams>, res: Response) => {
  if (syncRunning) throw new HttpError(409, 'Es läuft bereits eine Übertragung zu OPNsense');
  syncRunning = true;
  try {
    const { client, plan } = await buildPlan(idParam(req), modeOf(req));
    res.json(await applyPlan(client, plan));
  } finally {
    syncRunning = false;
  }
});
