import { Router, NextFunction, Request, Response } from 'express';
import { Resolver } from 'dns/promises';
import { getAppStore } from './db';
import { authRequired, isAdmin, markIpAdmin } from './auth';
import { HttpError } from './http-error';
import { listRooms } from './seating-store';
import type { Attendee, LanEvent } from './lan';
import { clientIPv4, expectedSettings, identify, networkChecks, type DnsLookup, type Identification } from './welcome';

// Welcome page (public): the client IP identifies the attendee of an event with IP identification
export const welcomeRouter = Router();

// Attendees with the admin flag are admins by IP address: the same identification as the welcome
// page (only events with IP identification). Runs for every API request before the admin check.
export async function resolveIpAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const ip = authRequired() ? clientIPv4(req.ip) : null;
  if (ip) {
    const events: LanEvent[] = (await getAppStore().select('event')) ?? [];
    const attendees: Attendee[] = (await getAppStore().select('attendee')) ?? [];
    if (identify(ip, events, attendees).attendee?.admin) markIpAdmin(req);
  }
  next();
}

// Asks the event's DNS server for the attendee's name of this device. Errors and timeouts
// (DNS server not reachable from the server) leave the check out instead of failing the page.
async function lookupName(id: Identification): Promise<DnsLookup> {
  const event = id.event;
  if (!event?.domain || !event.dns_server || !id.attendee || id.range_index == null) return undefined;
  const name = id.attendee.dns_names[id.range_index];
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  resolver.setServers([event.dns_server]);
  try {
    return { name, addresses: await resolver.resolve4(name) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOTFOUND' || code === 'ENODATA' ? { name, addresses: null } : undefined;
  }
}

// Final room and seat label of the attendee
async function findSeat(event: LanEvent, attendeeId: number): Promise<{ room_id: number; room: string; key: string; label: string } | null> {
  for (const room of (await listRooms(event.id)).filter(r => !r.alternative)) {
    const key = Object.keys(room.seats).find(k => room.seats[k] === attendeeId);
    const seat = key ? room.layout.seats.find(s => s.key === key) : undefined;
    if (seat) return { room_id: room.id, room: room.name, key: seat.key, label: seat.label };
  }
  return null;
}

// ?ip= lets admins preview the page as another device
welcomeRouter.get('/whoami', async (req: Request, res: Response) => {
  const testIp = typeof req.query.ip === 'string' && req.query.ip.trim() ? req.query.ip.trim() : null;
  if (testIp && !isAdmin(req)) throw new HttpError(403, 'Nur Admins können eine andere IP testen');
  if (testIp && clientIPv4(testIp) === null) throw new HttpError(400, `Ungültige IPv4-Adresse: ${testIp}`);

  const ip = clientIPv4(testIp ?? req.ip);
  const events: LanEvent[] = (await getAppStore().select('event')) ?? [];
  const attendees: Attendee[] = (await getAppStore().select('attendee')) ?? [];
  const id = identify(ip, events, attendees);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ip: ip ?? req.ip ?? null,
    tested: testIp !== null,
    status: id.status,
    event_id: id.event?.id ?? null,
    attendee: id.attendee,
    range_index: id.range_index,
    expected: expectedSettings(id),
    seat: id.event && id.attendee ? await findSeat(id.event, id.attendee.id) : null,
    checks: networkChecks(ip, id, await lookupName(id)),
  });
});
