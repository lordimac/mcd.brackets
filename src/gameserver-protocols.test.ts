import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'dgram';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import {
  parseCs2RconStatus, parseQ3RconStatus, q3Rcon, queryA2S, queryGameSpy, queryQ3, queryUt2, readSourcePackets, sourcePacket, sourceRcon,
  stripColors, webAdminCommand,
} from './gameserver-protocols';

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

// Fake UDP game server: answer(packet) returns the packets to send back
async function udpServer(answer: (packet: Buffer) => Buffer[]): Promise<{ port: number; close: () => void }> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (packet, from) => {
    for (const reply of answer(packet)) socket.send(reply, from.port, from.address);
  });
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  return { port: (socket.address() as AddressInfo).port, close: () => socket.close() };
}

const latin1 = (text: string) => Buffer.from(text, 'latin1');

test('Quake 3 / CoD: getstatus with colors, RCON with several packets and wrong password', async () => {
  const server = await udpServer(packet => {
    const text = packet.subarray(4).toString('latin1');
    if (text.startsWith('getstatus')) {
      return [Buffer.concat([OOB, latin1('statusResponse\n\\sv_hostname\\^1mcd^7.lan CoD4\\mapname\\mp_crash\\g_gametype\\war\\sv_maxclients\\24\n12 45 "^2Frag^7"\n3 60 "lordimac"\n')])];
    }
    if (text === 'rcon secret status') {
      return [
        Buffer.concat([OOB, latin1('print\nmap: mp_crash\nnum score ping guid                             name            lastmsg address               qport rate\n')]),
        Buffer.concat([OOB, latin1('print\n--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----\n  0    12   45 0123456789abcdef0123456789abcdef ^2Frag^7               0 192.168.120.101:28960 12345 25000\n  1     3   60 fedcba9876543210fedcba9876543210 lord imac^7            50 192.168.120.100:28960 23456 25000\n')]),
      ];
    }
    if (text.startsWith('rcon "two words" ')) return [Buffer.concat([OOB, latin1('print\nok\n')])];
    return [Buffer.concat([OOB, latin1('print\nBad rconpassword.\n')])];
  });
  try {
    const status = await queryQ3('127.0.0.1', server.port);
    assert.equal(status.hostname, 'mcd.lan CoD4');
    assert.equal(status.map, 'mp_crash');
    assert.equal(status.max_players, 24);
    assert.deepEqual(status.players.map(p => [p.name, p.score, p.ping]), [['Frag', 12, 45], ['lordimac', 3, 60]]);

    const output = await q3Rcon('127.0.0.1', server.port, 'secret', 'status');
    const players = parseQ3RconStatus(output);
    assert.deepEqual(players.map(p => [p.num, p.name, p.ip, p.score]), [[0, 'Frag', '192.168.120.101', 12], [1, 'lord imac', '192.168.120.100', 3]]);

    assert.equal((await q3Rcon('127.0.0.1', server.port, 'two words', 'say hi')).trim(), 'ok', 'passwords with spaces are quoted');
    await assert.rejects(q3Rcon('127.0.0.1', server.port, 'wrong', 'status'), /RCON-Passwort falsch/);
  } finally {
    server.close();
  }
});

test('Quake 3 RCON status without guid column, bots', () => {
  const players = parseQ3RconStatus([
    'map: q3dm17',
    'num score ping name            lastmsg address               qport rate',
    '--- ----- ---- --------------- ------- --------------------- ----- -----',
    '  0     5   33 ^1Visor^7             0 bot                       0 16384',
    '  2    -1  999 Sarge^7             100 192.168.120.102:27960  4711 25000',
  ].join('\n'));
  assert.deepEqual(players.map(p => [p.num, p.name, p.bot, p.ip, p.score]), [[0, 'Visor', true, null, 5], [2, 'Sarge', false, '192.168.120.102', -1]]);
});

test('A2S: challenge for info and players, split answer', async () => {
  const challenge = Buffer.from([1, 2, 3, 4]);
  const info = Buffer.concat([OOB, Buffer.from([0x49, 17]), Buffer.from('mcd CS2\0de_dust2\0cs\0Counter-Strike 2\0', 'utf8'), Buffer.from([0xda, 0x02, 3, 16, 1, 0x64, 0x6c, 0, 1]), Buffer.from('1.0\0')]);
  const playersBody = Buffer.concat([
    OOB, Buffer.from([0x44, 2]),
    Buffer.from([0]), Buffer.from('Frag\0'), Buffer.from([7, 0, 0, 0]), Buffer.alloc(4),
    Buffer.from([1]), Buffer.from('Ümit\0', 'utf8'), Buffer.from([2, 0, 0, 0]), Buffer.alloc(4),
  ]);
  // Players come as two split packets (Source format)
  const split = (part: Buffer, number: number) => {
    const header = Buffer.alloc(12);
    header.writeInt32LE(-2, 0);
    header.writeInt32LE(77, 4);
    header.writeUInt8(2, 8);
    header.writeUInt8(number, 9);
    header.writeInt16LE(1248, 10);
    return Buffer.concat([header, part]);
  };
  const server = await udpServer(packet => {
    const withChallenge = packet.subarray(-4).equals(challenge);
    if (packet[4] === 0x54) return withChallenge ? [info] : [Buffer.concat([OOB, Buffer.from([0x41]), challenge])];
    if (packet[4] === 0x55) {
      if (!withChallenge) return [Buffer.concat([OOB, Buffer.from([0x41]), challenge])];
      const middle = Math.floor(playersBody.length / 2);
      return [split(playersBody.subarray(middle), 1), split(playersBody.subarray(0, middle), 0)];
    }
    return [];
  });
  try {
    const status = await queryA2S('127.0.0.1', server.port);
    assert.equal(status.hostname, 'mcd CS2');
    assert.equal(status.map, 'de_dust2');
    assert.equal(status.max_players, 16);
    assert.deepEqual(status.players.map(p => [p.name, p.score]), [['Frag', 7], ['Ümit', 2]]);
  } finally {
    server.close();
  }
});

test('Source RCON: auth, output in several packets, end marker, wrong password', async () => {
  const server = net.createServer(socket => {
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      const { packets, rest } = readSourcePackets(Buffer.concat([buffer, chunk]));
      buffer = rest;
      for (const packet of packets) {
        if (packet.type === 3) {
          socket.write(sourcePacket(packet.id, 0, ''));
          socket.write(sourcePacket(packet.body === 'secret' ? packet.id : -1, 2, ''));
        } else if (packet.type === 2) {
          socket.write(sourcePacket(packet.id, 0, '---------players--------\n  id     time ping loss      state   rate adr name\n'));
          socket.write(sourcePacket(packet.id, 0, "65535 [NoChan]    0    0 challenging      0unknown ''\n    2    00:15   25    0     active 786432 192.168.120.101:27005 'Frag'\n    3      BOT    0    0     active      0 BOT 'Bot Ted'\n"));
        } else if (packet.type === 0) {
          socket.write(sourcePacket(packet.id, 0, '')); // mirror = end
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const output = await sourceRcon('127.0.0.1', port, 'secret', 'status');
    assert.deepEqual(parseCs2RconStatus(output).map(p => [p.num, p.name, p.ip, p.ping, p.bot]), [[2, 'Frag', '192.168.120.101', 25, false], [3, 'Bot Ted', null, 0, true]]);
    await assert.rejects(sourceRcon('127.0.0.1', port, 'wrong', 'status'), /RCON-Passwort falsch/);
  } finally {
    server.close();
  }
});

test('UT99 GameSpy: answer in several packets out of order', async () => {
  const server = await udpServer(packet => {
    if (packet.toString('latin1') !== '\\status\\') return [];
    return [
      latin1('\\player_1\\Nick\\frags_1\\3\\ping_1\\ 20\\team_1\\1\\queryid\\55.2\\final\\'),
      latin1('\\hostname\\mcd UT\\mapname\\DM-Deck16][\\gametype\\DeathMatchPlus\\maxplayers\\16\\player_0\\Frag\\frags_0\\10\\ping_0\\ 33\\team_0\\0\\queryid\\55.1'),
    ];
  });
  try {
    const status = await queryGameSpy('127.0.0.1', server.port);
    assert.equal(status.map, 'DM-Deck16][');
    assert.equal(status.max_players, 16);
    assert.deepEqual(status.players.map(p => [p.name, p.score, p.ping, p.team]).sort(), [['Frag', 10, 33, 'Rot'], ['Nick', 3, 20, 'Blau']]);
  } finally {
    server.close();
  }
});

test('UT2004 query: server info and players, colored and UCS-2 names', async () => {
  const ut2 = (text: string) => Buffer.concat([Buffer.from([text.length + 1]), latin1(text), Buffer.from([0])]);
  const int = (value: number) => { const b = Buffer.alloc(4); b.writeInt32LE(value); return b; };
  const ucs2 = (text: string) => Buffer.concat([Buffer.from([0x80 | (text.length + 1)]), Buffer.from(`${text}\0`, 'utf16le')]);
  const server = await udpServer(packet => {
    if (packet[0] !== 0x79) return [];
    if (packet[4] === 0) {
      return [Buffer.concat([Buffer.from([0x80, 0, 0, 0, 0]), int(1), ut2('192.168.120.5'), int(7777), int(7778), ut2('\x1b\xff\x00\x00mcd UT2004'), ut2('ONS-Torlan'), ut2('ONSOnslaughtGame'), int(2), int(32), int(0)])];
    }
    return [Buffer.concat([Buffer.from([0x80, 0, 0, 0, 2]), int(5), ut2('Frag'), int(30), int(12), int(0x20000000), int(6), ucs2('Ümit'), int(40), int(4), int(0x40000000)])];
  });
  try {
    const status = await queryUt2('127.0.0.1', server.port);
    assert.equal(status.hostname, 'mcd UT2004');
    assert.equal(status.map, 'ONS-Torlan');
    assert.equal(status.max_players, 32);
    assert.deepEqual(status.players.map(p => [p.name, p.score, p.ping, p.team]), [['Frag', 12, 30, 'Rot'], ['Ümit', 4, 40, 'Blau']]);
  } finally {
    server.close();
  }
});

test('UDP: no answer and closed port become errors', async () => {
  const silent = await udpServer(() => []);
  try {
    await assert.rejects(queryQ3('127.0.0.1', silent.port, 200), /Keine Antwort|antwortet nicht/);
  } finally {
    silent.close();
  }
});

test('WebAdmin: Basic auth, command to the console, answer from the log', async () => {
  const seen: { auth?: string; body?: string; path?: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body, path: req.url });
      if (req.headers.authorization !== `Basic ${Buffer.from('admin:pw').toString('base64')}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/ServerAdmin/current_console_log') res.end('<html><body>&gt; say hallo<br>Admin: hallo</body></html>');
      else res.end('<html>ok</html>');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const output = await webAdminCommand({ host: '127.0.0.1', port, path: '/ServerAdmin', username: 'admin', password: 'pw' }, 'say hallo');
    assert.equal(output, '> say hallo\nAdmin: hallo');
    assert.equal(seen[0].path, '/ServerAdmin/current_console');
    assert.equal(seen[0].body, 'SendText=say+hallo&Send=Send');
    await assert.rejects(webAdminCommand({ host: '127.0.0.1', port, path: '/ServerAdmin', username: 'admin', password: 'x' }, 'say hi'), /abgelehnt/);
  } finally {
    server.close();
  }
});

test('color codes are removed', () => {
  assert.equal(stripColors('^1mcd^7.lan ^3CoD'), 'mcd.lan CoD');
  assert.equal(stripColors('\x1b\xff\x00\x00Rot'), 'Rot');
});
