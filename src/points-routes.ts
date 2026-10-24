import { Router, Request, Response } from 'express';
import { getAppStore, withLock } from './db';
import { DEFAULT_POINTS, pointsFromRecord, validatePoints, type PointsConfig } from './points';

// Championship points (one global record). Reading is public, changing needs the admin session (auth.ts).
export const pointsRouter = Router();

export async function loadPoints(): Promise<PointsConfig> {
  return pointsFromRecord(((await getAppStore().select('points')) ?? [])[0]);
}

const pointsView = async () => ({ ...(await loadPoints()), defaults: DEFAULT_POINTS });

pointsRouter.get('/points', async (_req: Request, res: Response) => {
  res.json(await pointsView());
});

pointsRouter.put('/points', async (req: Request, res: Response) => {
  const config = validatePoints(req.body ?? {});
  await withLock(async () => {
    const stored = ((await getAppStore().select('points')) ?? [])[0];
    if (stored) await getAppStore().update('points', stored.id, { ...config, id: stored.id });
    else await getAppStore().insert('points', config);
  });
  res.json(await pointsView());
});
