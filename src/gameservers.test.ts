import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Attendee, LanEvent } from './lan';
import { GameServerError, type QueryPlayer } from './gameserver-protocols';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-gs-'));

const db: typeof import('./db') = require('./db');
const store: typeof import('./lan-store') = require('./lan-store');
const gs: typeof import('./gameservers') = require('./gameservers');

const event: LanEvent = {
  id: 3, name: 'Demo-LAN', domain: '', dns_server: '', netmask: '', gateway: '', logo: '', starts_on: '', ends_on: '', wifi_enabled: false, wifi_ssid: '', wifi_password: '', memorial: [], ip_identification: true,
  ranges: [
    { start: '192.168.120.100', end: '192.168.120.149' },
    { start: '192.168.120.150', end: '192.168.120.199' },
    { start: '192.168.120.200', end: '192.168.120.249' },
  ],
};

const attendee = (id: number, nickname: string, slot: number, clan = ''): Attendee =>
  ({ id, event_id: event.id, first_name: '', last_name: '', clan, nickname, hostname: nickname.toLowerCase(), slot });

const qp = (fields: Partial<QueryPlayer> & { name: string }): QueryPlayer => ({ score: null, ping: null, team: null, num: null, ip: null, bot: false, ...fields });

test('validation: defaults per game, passwords kept, never shown', () => {
  const [cod, ut] = gs.validateServers([
    { game: 'cod4', host: '192.168.120.5', rcon_password: 'secret' },
    { game: 'ut2004', name: 'Onslaught', host: 'ut.lan.example', webadmin_port: '8075', webadmin_user: 'admin', webadmin_password: 'pw', rcon_password: 'ignored' },
  ]);
  assert.equal(cod.name, 'Call of Duty 4');
  assert.equal(cod.port, 28960);
  assert.equal(gs.queryPortOf(cod), 28960);
  assert.equal(gs.queryPortOf(ut), 7778, 'UT queries on game port + 1');
  assert.equal(ut.rcon_password, '', 'UT has no RCON');
  assert.equal(gs.canAdminister(ut), true);

  const again = gs.validateServers([{ ...cod, rcon_password: '' }, { ...ut, webadmin_password: '', clear_webadmin_password: true }], [cod, ut]);
  assert.equal(again[0].rcon_password, 'secret', 'empty keeps the stored password');
  assert.equal(again[1].webadmin_password, '', 'clear removes it');

  const publicView = gs.serverView(cod, false);
  assert.equal(JSON.stringify(publicView).includes('secret'), false);
  assert.equal('has_rcon_password' in publicView, false);
  assert.equal(publicView.manageable, true);
  const adminView = gs.serverView(cod, true) as Record<string, unknown>;
  assert.equal(adminView.has_rcon_password, true);
  assert.equal(JSON.stringify(adminView).includes('secret'), false);

  assert.throws(() => gs.validateServers([{ game: 'doom', host: '1.2.3.4' }]), /Spiel wählen/);
  assert.throws(() => gs.validateServers([{ game: 'q3', host: 'bad host!' }]), /ungültige Adresse/);
  assert.throws(() => gs.validateServers([{ game: 'q3', host: '1.2.3.4', port: 70000 }]), /Port/);
  assert.throws(() => gs.validateServers([{ game: 'q3', host: '1.2.3.4', rcon_password: 'a"b' }]), /"/);
});

test('players are linked by IP, else by name with or without clan tag', () => {
  const match = gs.playerMatcher(event, [attendee(1, 'lordimac', 0, 'M4E'), attendee(2, 'Frag', 1), attendee(3, 'Max', 2), attendee(4, 'max', 3, 'XY')]);
  assert.equal(match({ name: 'whatever', ip: '192.168.120.151' })?.id, 2, 'IP of the second PC');
  assert.equal(match({ name: '[M4E]lordimac', ip: null })?.id, 1);
  assert.equal(match({ name: 'M4E-lordimac', ip: null })?.id, 1);
  assert.equal(match({ name: 'FRAG', ip: null })?.id, 2);
  assert.equal(match({ name: 'Max', ip: null }), null, 'two attendees named max: no guess');
  assert.equal(match({ name: 'XY-max', ip: null })?.id, 4);
  assert.equal(match({ name: 'Unbekannt', ip: '10.0.0.1' }), null);
});

test('status: RCON players with IPs win, scores come from the query; admins see more', async () => {
  const [server] = gs.validateServers([{ game: 'cs2', host: '192.168.120.5', rcon_password: 'secret' }]);
  const protocols = {
    ...gs.defaultProtocols,
    queryA2S: async () => ({ hostname: 'mcd CS2', map: 'de_inferno', gametype: 'Counter-Strike 2', max_players: 10, players: [qp({ name: 'Frag', score: 9 }), qp({ name: 'Bot Ted', score: 1 })] }),
    sourceRcon: async () => "    2    00:15   25    0     active 786432 192.168.120.101:27005 'Frag'\n    3      BOT    0    0     active      0 BOT 'Bot Ted'\n",
  };
  const status = await gs.fetchStatus(server, protocols);
  assert.equal(status.rcon, 'ok');
  const match = gs.playerMatcher(event, [attendee(2, 'Frag', 1)]);

  const publicView = gs.statusView(status, match, false);
  assert.equal(publicView.player_count, 1);
  assert.equal(publicView.bot_count, 1);
  assert.deepEqual(publicView.players[0], { name: 'Frag', score: 9, ping: 25, team: null, bot: false, attendee_id: 2, nickname: 'Frag', clan: '', display_name: 'Frag' });
  assert.equal('rcon' in publicView, false);

  const adminView = gs.statusView(status, match, true);
  assert.equal((adminView.players[0] as { ip?: string }).ip, '192.168.120.101');
  assert.equal((adminView.players[0] as { num?: number }).num, 2);

  // RCON fails: the query result is still shown, the error only for admins
  const failing = await gs.fetchStatus(server, { ...protocols, sourceRcon: async () => { throw new GameServerError('RCON-Passwort falsch'); } });
  assert.equal(failing.online, true);
  assert.equal(failing.rcon, 'error');
  assert.equal(failing.rcon_error, 'RCON-Passwort falsch');
  assert.equal(failing.players.length, 2);

  const offline = await gs.fetchStatus(server, { ...protocols, queryA2S: async () => { throw new Error('boom'); } });
  assert.equal(offline.online, false);
  assert.equal(offline.error, 'Abfrage fehlgeschlagen');
});

test('actions: commands per engine, input cleaned', () => {
  assert.equal(gs.actionCommand('cod4', 'kick', 3), 'clientkick 3');
  assert.equal(gs.actionCommand('cs2', 'kick', '7'), 'kickid 7');
  assert.equal(gs.actionCommand('cs2', 'map', 'de_dust2'), 'changelevel de_dust2');
  assert.equal(gs.actionCommand('ut99', 'map', 'DM-Deck16]['), 'servertravel DM-Deck16][');
  assert.equal(gs.actionCommand('q3', 'say', 'Pause; quit "jetzt"'), 'say Pause, quit ,jetzt,');
  assert.equal(gs.actionCommand('cod2', 'next', ''), 'map_rotate');
  assert.throws(() => gs.actionCommand('ut2004', 'kick', 1), /kann das nicht/);
  assert.throws(() => gs.actionCommand('q3', 'map', 'q3dm17; quit'), /Mapname/);
  assert.throws(() => gs.actionCommand('q3', 'kick', 'all'), /Spieler/);
  assert.deepEqual(gs.availableActions('ut2004'), ['say', 'map', 'restart']);
  assert.throws(() => gs.validateCommand('status\nquit'), /Zeilenumbrüche/);
});

test('storage: saved per event, copied to a new event, removed with the event', async () => {
  await db.ensureAppTables();
  const first = await store.createEvent({ name: 'LAN 1' });
  await gs.saveServers(first.id, [{ game: 'q3', host: '192.168.120.9', rcon_password: 'pw' }]);
  const second = await store.createEvent({ name: 'LAN 2' });
  const copied = await gs.listServers(second.id);
  assert.equal(copied.length, 1);
  assert.equal(copied[0].rcon_password, 'pw');
  assert.notEqual(copied[0].id, (await gs.listServers(first.id))[0].id);
  await store.deleteEvent(second.id);
  assert.deepEqual(await gs.listServers(second.id), []);
});
