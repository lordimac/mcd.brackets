import dgram from 'dgram';
import dns from 'dns/promises';
import net from 'net';

// Network protocols of the game servers on the LAN. Status (map, players) via UDP queries,
// administration via RCON or the WebAdmin of the Unreal games:
// - Quake 3 engine (Quake III Arena, Call of Duty 2, Call of Duty 4): "getstatus" and "rcon" over UDP
// - Source engine (Counter-Strike 2): A2S_INFO/A2S_PLAYER over UDP, Source RCON over TCP
// - Unreal Tournament (UT99): GameSpy v1 query ("\status\") on the query port
// - Unreal Tournament 2004: UT2 query protocol on the query port
// - UT99/UT2004 have no RCON: commands go to the console page of the WebAdmin (HTTP Basic auth)
// The parsers are exported for the tests (gameserver-protocols.test.ts with fake servers).

export class GameServerError extends Error {}

export interface QueryPlayer {
  name: string;
  score: number | null;
  ping: number | null;
  team: string | null;
  num: number | null;  // slot or user ID for kicking (only from RCON status)
  ip: string | null;   // only from RCON status
  bot: boolean;
}

export interface QueryResult {
  hostname: string;
  map: string;
  gametype: string;
  max_players: number | null;
  players: QueryPlayer[];
}

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

const player = (fields: Partial<QueryPlayer> & { name: string }): QueryPlayer =>
  ({ score: null, ping: null, team: null, num: null, ip: null, bot: false, ...fields });

const toInt = (value: string | undefined): number | null => {
  const number = Number.parseInt(value?.trim() ?? '', 10);
  return Number.isFinite(number) ? number : null;
};

// Color codes: Quake 3/CoD "^1Name", UT2004 ESC + 3 bytes RGB
export const stripColors = (text: string): string => text.replace(/\^[^^]/g, '').replace(/\x1b[\s\S]{3}/g, '').trim();

async function resolveIPv4(host: string): Promise<string> {
  if (net.isIPv4(host)) return host;
  try {
    return (await dns.lookup(host, { family: 4 })).address;
  } catch {
    throw new GameServerError(`${host} ist nicht auflösbar`);
  }
}

/* UDP: one connected socket per query, answers only from that server
   ========================================================================== */

class UdpClient {
  private queue: Buffer[] = [];
  private waiter: ((packet: Buffer | null) => void) | null = null;
  private failure: Error | null = null;

  private constructor(private socket: dgram.Socket) {
    socket.on('message', packet => {
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter(packet);
      } else this.queue.push(packet);
    });
    socket.on('error', error => {
      // ICMP "port unreachable" on a connected socket = nothing listens there
      this.failure = (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? new GameServerError('Server antwortet nicht (Port geschlossen)') : error;
      this.waiter?.(null);
      this.waiter = null;
    });
  }

  static async open(host: string, port: number): Promise<UdpClient> {
    const address = await resolveIPv4(host);
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(port, address, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    return new UdpClient(socket);
  }

  send(packet: Buffer): void {
    this.socket.send(packet);
  }

  // Next packet, null after timeoutMs
  receive(timeoutMs: number): Promise<Buffer | null> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = packet => {
        clearTimeout(timer);
        if (packet === null && this.failure) reject(this.failure);
        else resolve(packet);
      };
    });
  }

  // First packet within timeoutMs, then everything that follows with gaps shorter than idleMs
  async collect(timeoutMs: number, idleMs: number, done?: (packets: Buffer[]) => boolean): Promise<Buffer[]> {
    const first = await this.receive(timeoutMs);
    if (!first) return [];
    const packets = [first];
    while (!done?.(packets)) {
      const next = await this.receive(idleMs);
      if (!next) break;
      packets.push(next);
    }
    return packets;
  }

  close(): void {
    try {
      this.socket.close();
    } catch { /* already closed */ }
  }
}

async function withUdp<T>(host: string, port: number, run: (client: UdpClient) => Promise<T>): Promise<T> {
  const client = await UdpClient.open(host, port);
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

const noAnswer = () => new GameServerError('Keine Antwort vom Server');

/* Quake 3 engine: Quake III Arena, Call of Duty 2, Call of Duty 4
   ========================================================================== */

// "\xff\xff\xff\xffstatusResponse\n\key\value…\n<score> <ping> "<name>"\n…"
export function parseQ3Status(packet: Buffer): QueryResult {
  const text = packet.subarray(4).toString('latin1');
  const [header, info = '', ...lines] = text.split('\n');
  if (!/^statusResponse/i.test(header)) throw new GameServerError('Unerwartete Antwort');
  const parts = info.split('\\').slice(1);
  const vars: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) vars[parts[i].toLowerCase()] = parts[i + 1];
  const players = lines.flatMap(line => {
    const match = /^(-?\d+)\s+(-?\d+)\s+"(.*)"/.exec(line);
    return match ? [player({ name: stripColors(match[3]), score: toInt(match[1]), ping: toInt(match[2]) })] : [];
  });
  return {
    hostname: stripColors(vars.sv_hostname ?? vars.hostname ?? ''),
    map: vars.mapname ?? '',
    gametype: vars.g_gametype ?? vars.gametype ?? '',
    max_players: toInt(vars.sv_maxclients),
    players,
  };
}

export async function queryQ3(host: string, port: number, timeoutMs = 1500): Promise<QueryResult> {
  return withUdp(host, port, async client => {
    client.send(Buffer.concat([OOB, Buffer.from('getstatus\n', 'latin1')]));
    const packet = await client.receive(timeoutMs);
    if (!packet) throw noAnswer();
    return parseQ3Status(packet);
  });
}

// A password with spaces must be quoted, otherwise the server takes the first word as password
const q3Password = (password: string) => (/\s/.test(password) ? `"${password}"` : password);

// Every answer packet is "\xff\xff\xff\xffprint\n<text>"; long output comes in several packets
export async function q3Rcon(host: string, port: number, password: string, command: string, timeoutMs = 2000): Promise<string> {
  return withUdp(host, port, async client => {
    client.send(Buffer.concat([OOB, Buffer.from(`rcon ${q3Password(password)} ${command}`, 'latin1')]));
    const packets = await client.collect(timeoutMs, 300);
    if (!packets.length) throw noAnswer();
    const output = packets.map(packet => packet.subarray(4).toString('latin1').replace(/^print\n?/, '')).join('');
    if (/^bad rcon ?password/i.test(output.trim()) || /^invalid password/i.test(output.trim())) throw new GameServerError('RCON-Passwort falsch');
    if (/no rconpassword set/i.test(output)) throw new GameServerError('Auf dem Server ist kein RCON-Passwort gesetzt');
    return output;
  });
}

// RCON "status": Quake 3 without, Call of Duty with a guid column
//   num score ping [guid] name lastmsg address qport rate
export function parseQ3RconStatus(output: string): QueryPlayer[] {
  const lines = output.split('\n');
  const header = lines.find(line => /^\s*num\s+score\s+ping/i.test(line)) ?? '';
  const hasGuid = /\bguid\b/i.test(header);
  const players: QueryPlayer[] = [];
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(-?\d+)\s+(\d+|CNCT|ZMBI)\s+(.*?)\s+(\d+)\s+(\S+)\s+(-?\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    let name = match[4];
    if (hasGuid) name = name.replace(/^\S+\s+/, '');
    const address = match[6];
    const ip = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(address)?.[1] ?? null;
    players.push(player({
      name: stripColors(name),
      score: toInt(match[2]),
      ping: toInt(match[3]),
      num: Number(match[1]),
      ip,
      bot: address.toLowerCase() === 'bot',
    }));
  }
  return players;
}

/* Source engine: Counter-Strike 2
   ========================================================================== */

class Reader {
  offset = 0;
  constructor(private buffer: Buffer) {}
  get remaining() { return this.buffer.length - this.offset; }
  byte() { this.need(1); return this.buffer.readUInt8(this.offset++); }
  short() { this.need(2); const v = this.buffer.readInt16LE(this.offset); this.offset += 2; return v; }
  int() { this.need(4); const v = this.buffer.readInt32LE(this.offset); this.offset += 4; return v; }
  float() { this.need(4); const v = this.buffer.readFloatLE(this.offset); this.offset += 4; return v; }
  bytes(length: number) { this.need(length); const v = this.buffer.subarray(this.offset, this.offset + length); this.offset += length; return v; }
  cstring() {
    const end = this.buffer.indexOf(0, this.offset);
    if (end < 0) throw new GameServerError('Antwort abgeschnitten');
    const value = this.buffer.toString('utf8', this.offset, end);
    this.offset = end + 1;
    return value;
  }
  private need(length: number) {
    if (this.offset + length > this.buffer.length) throw new GameServerError('Antwort abgeschnitten');
  }
}

// One answer, split packets put together (header -2: id, total, number, size)
async function receiveSource(client: UdpClient, timeoutMs: number): Promise<Buffer> {
  const parts = new Map<number, Buffer>();
  let total = 0;
  for (;;) {
    const packet = await client.receive(parts.size ? 500 : timeoutMs);
    if (!packet) throw noAnswer();
    const kind = packet.readInt32LE(0);
    if (kind === -1) return packet.subarray(4);
    if (kind !== -2 || packet.length < 12) continue;
    total = packet.readUInt8(8);
    parts.set(packet.readUInt8(9), packet.subarray(12));
    if (total && parts.size >= total) {
      const whole = Buffer.concat([...Array(total).keys()].map(i => parts.get(i) ?? Buffer.alloc(0)));
      return whole.subarray(4); // starts with -1 again
    }
  }
}

// Request, and once more with the challenge if the server asks for one ('A' + 4 bytes)
async function sourceRequest(client: UdpClient, build: (challenge: Buffer | null) => Buffer, timeoutMs: number): Promise<Buffer> {
  client.send(build(null));
  let answer = await receiveSource(client, timeoutMs);
  for (let i = 0; i < 2 && answer[0] === 0x41 && answer.length >= 5; i++) {
    client.send(build(answer.subarray(1, 5)));
    answer = await receiveSource(client, timeoutMs);
  }
  return answer;
}

export function parseA2SInfo(answer: Buffer): { hostname: string; map: string; folder: string; game: string; players: number; max_players: number; bots: number } {
  const reader = new Reader(answer);
  if (reader.byte() !== 0x49) throw new GameServerError('Unerwartete Antwort');
  reader.byte(); // protocol
  const hostname = reader.cstring();
  const map = reader.cstring();
  const folder = reader.cstring();
  const game = reader.cstring();
  reader.short(); // app ID
  const players = reader.byte();
  const max = reader.byte();
  const bots = reader.byte();
  return { hostname, map, folder, game, players, max_players: max, bots };
}

export function parseA2SPlayers(answer: Buffer): QueryPlayer[] {
  const reader = new Reader(answer);
  if (reader.byte() !== 0x44) throw new GameServerError('Unerwartete Antwort');
  const count = reader.byte();
  const players: QueryPlayer[] = [];
  for (let i = 0; i < count && reader.remaining > 0; i++) {
    reader.byte(); // index
    const name = reader.cstring();
    const score = reader.int();
    reader.float(); // duration
    if (name) players.push(player({ name, score }));
  }
  return players;
}

export async function queryA2S(host: string, port: number, timeoutMs = 1500): Promise<QueryResult> {
  return withUdp(host, port, async client => {
    const info = parseA2SInfo(await sourceRequest(client, challenge =>
      Buffer.concat([OOB, Buffer.from('TSource Engine Query\0', 'latin1'), challenge ?? Buffer.alloc(0)]), timeoutMs));
    let players: QueryPlayer[] = [];
    try {
      players = parseA2SPlayers(await sourceRequest(client, challenge =>
        Buffer.concat([OOB, Buffer.from('U', 'latin1'), challenge ?? OOB]), timeoutMs));
    } catch {
      // Player list is optional, the server is up anyway
    }
    return { hostname: info.hostname, map: info.map, gametype: info.game, max_players: info.max_players, players };
  });
}

// Source RCON over TCP: packets <size><id><type><body>\0\0, little endian.
// Auth = type 3, its answer type 2 (ID -1 = wrong password); command = type 2, output = type 0.
// After the command an empty type-0 packet: servers that mirror it mark the end of the output.
export function sourcePacket(id: number, type: number, body: string): Buffer {
  const text = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(14 + text.length);
  packet.writeInt32LE(10 + text.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  text.copy(packet, 12);
  return packet;
}

export function readSourcePackets(buffer: Buffer): { packets: { id: number; type: number; body: string }[]; rest: Buffer } {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10 || size > 1 << 20) throw new GameServerError('Ungültige RCON-Antwort');
    if (buffer.length - offset < 4 + size) break;
    packets.push({
      id: buffer.readInt32LE(offset + 4),
      type: buffer.readInt32LE(offset + 8),
      body: buffer.toString('utf8', offset + 12, offset + 4 + size - 2),
    });
    offset += 4 + size;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export async function sourceRcon(host: string, port: number, password: string, command: string, timeoutMs = 3000): Promise<string> {
  const address = await resolveIPv4(host);
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    let buffer: Buffer = Buffer.alloc(0);
    let authed = false;
    let output = '';
    let gotOutput = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const finish = (error: Error | null) => {
      clearTimeout(overall);
      if (idleTimer) clearTimeout(idleTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve(output);
    };
    const overall = setTimeout(() => finish(gotOutput ? null : new GameServerError(authed ? 'Keine Antwort auf den Befehl' : 'Keine Antwort vom RCON-Port')), timeoutMs);
    socket.on('connect', () => socket.write(sourcePacket(1, 3, password)));
    socket.on('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
      ? new GameServerError('RCON-Port geschlossen (CS2 mit -usercon starten)')
      : new GameServerError(`RCON-Verbindung fehlgeschlagen: ${error.message}`)));
    socket.on('close', () => finish(gotOutput || authed ? null : new GameServerError('RCON-Verbindung geschlossen (Passwort falsch?)')));
    socket.on('data', chunk => {
      let parsed;
      try {
        parsed = readSourcePackets(Buffer.concat([buffer, chunk]));
      } catch (error) {
        finish(error as Error);
        return;
      }
      buffer = parsed.rest;
      for (const packet of parsed.packets) {
        if (!authed) {
          if (packet.type !== 2) continue; // the empty type-0 packet before the auth answer
          if (packet.id === -1) {
            finish(new GameServerError('RCON-Passwort falsch'));
            return;
          }
          authed = true;
          socket.write(sourcePacket(2, 2, command));
          socket.write(sourcePacket(3, 0, ''));
          continue;
        }
        if (packet.id === 3) {
          finish(null);
          return;
        }
        if (packet.id === 2 && packet.type === 0) {
          output += packet.body;
          gotOutput = true;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finish(null), 400); // servers that don't mirror the end marker
        }
      }
    });
  });
}

// CS2 RCON "status": "  id     time ping loss      state   rate adr name" then lines like
//   "    2    00:15   25    0     active 786432 192.168.1.10:27005 'PlayerName'"
export function parseCs2RconStatus(output: string): QueryPlayer[] {
  const players: QueryPlayer[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s*(\S+)\s+'(.*)'\s*$/.exec(line);
    if (!match || match[1] === '65535') continue;
    const address = match[7];
    const ip = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(address)?.[1] ?? null;
    if (match[5] !== 'active' && match[5] !== 'spawning' && match[5] !== 'connected') continue;
    players.push(player({
      name: match[8],
      ping: toInt(match[3]),
      num: Number(match[1]),
      ip,
      bot: /^bot$/i.test(address) || match[2] === 'BOT',
    }));
  }
  return players;
}

/* Unreal Tournament (UT99): GameSpy v1 on the query port (game port + 1)
   ========================================================================== */

// Packets "\key\value\…\queryid\12.1" — the last one ends with "\final\"; each packet is complete
export function parseGameSpy(packets: Buffer[]): QueryResult {
  const vars: Record<string, string> = {};
  for (const packet of packets) {
    const parts = packet.toString('latin1').split('\\').slice(1);
    for (let i = 0; i + 1 < parts.length; i += 2) vars[parts[i].toLowerCase()] = parts[i + 1];
  }
  if (!('hostname' in vars) && !('mapname' in vars)) throw new GameServerError('Unerwartete Antwort');
  const players: QueryPlayer[] = [];
  for (const key of Object.keys(vars)) {
    const index = /^player_(\d+)$/.exec(key)?.[1];
    if (index === undefined) continue;
    const team = toInt(vars[`team_${index}`]);
    players.push(player({
      name: vars[key],
      score: toInt(vars[`frags_${index}`]),
      ping: toInt(vars[`ping_${index}`]),
      team: team === 0 ? 'Rot' : team === 1 ? 'Blau' : team === 2 ? 'Grün' : team === 3 ? 'Gold' : null,
      bot: /^bot$/i.test(vars[`ngsecret_${index}`] ?? ''), // UT99 marks bots so
    }));
  }
  return {
    hostname: vars.hostname ?? '',
    map: vars.mapname ?? '',
    gametype: vars.gametype ?? '',
    max_players: toInt(vars.maxplayers),
    players,
  };
}

export async function queryGameSpy(host: string, queryPort: number, timeoutMs = 1500): Promise<QueryResult> {
  return withUdp(host, queryPort, async client => {
    client.send(Buffer.from('\\status\\', 'latin1'));
    const packets = await client.collect(timeoutMs, 300, all => {
      // Done when the final packet is there and no part is missing ("queryid\<id>.<n>")
      const final = all.find(p => p.includes('\\final\\'));
      if (!final) return false;
      const last = Number(/\\queryid\\\d+\.(\d+)/.exec(final.toString('latin1'))?.[1] ?? all.length);
      return all.length >= last;
    });
    if (!packets.length) throw noAnswer();
    return parseGameSpy(packets);
  });
}

/* Unreal Tournament 2004: UT2 query on the query port (game port + 1)
   Request 0x79 0 0 0 <type>, answer: 4 bytes header, type byte, data. 0 = server info, 2 = players
   ========================================================================== */

// Length byte (with the trailing zero); high bit = UCS-2 with (length & 0x7f) characters
function ut2String(reader: Reader): string {
  const length = reader.byte();
  const text = length & 0x80
    ? reader.bytes((length & 0x7f) * 2).toString('utf16le')
    : reader.bytes(length).toString('latin1');
  return stripColors(text.replace(/\0+$/, ''));
}

export function parseUt2Packets(packets: Buffer[]): QueryResult {
  let info: Omit<QueryResult, 'players'> | null = null;
  const players: QueryPlayer[] = [];
  for (const packet of packets) {
    if (packet.length < 5) continue;
    const reader = new Reader(packet.subarray(5));
    const type = packet[4];
    if (type === 0) {
      reader.int(); // server ID
      ut2String(reader); // IP
      reader.int(); // game port
      reader.int(); // query port
      const hostname = ut2String(reader);
      const map = ut2String(reader);
      const gametype = ut2String(reader);
      reader.int(); // players
      info = { hostname, map, gametype, max_players: reader.int() };
    } else if (type === 2) {
      while (reader.remaining >= 4) {
        reader.int(); // player ID
        const name = ut2String(reader);
        const ping = reader.int();
        const score = reader.int();
        const statsId = reader.int();
        // The top bits of the stats ID carry the team in team games
        const team = statsId & 0x20000000 ? 'Rot' : statsId & 0x40000000 ? 'Blau' : null;
        if (name) players.push(player({ name, ping, score, team }));
      }
    }
  }
  if (!info) throw new GameServerError('Unerwartete Antwort');
  return { ...info, players };
}

export async function queryUt2(host: string, queryPort: number, timeoutMs = 1500): Promise<QueryResult> {
  return withUdp(host, queryPort, async client => {
    client.send(Buffer.from([0x79, 0, 0, 0, 0]));
    client.send(Buffer.from([0x79, 0, 0, 0, 2]));
    const packets = await client.collect(timeoutMs, 300);
    if (!packets.length) throw noAnswer();
    return parseUt2Packets(packets);
  });
}

/* WebAdmin of UT99 and UT2004: HTTP Basic auth, console page "current_console" (field SendText),
   the log is on "current_console_log". Both games execute the text as console command.
   ========================================================================== */

export interface WebAdminTarget {
  host: string;
  port: number;
  path: string;      // "/ServerAdmin"
  username: string;
  password: string;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

export async function webAdminCommand(target: WebAdminTarget, command: string, timeoutMs = 4000): Promise<string> {
  const base = `http://${target.host}:${target.port}${target.path.replace(/\/$/, '')}`;
  const headers = { Authorization: `Basic ${Buffer.from(`${target.username}:${target.password}`, 'latin1').toString('base64')}` };
  const send = async (url: string, init: RequestInit = {}) => {
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    } catch (error) {
      const code = ((error as Error).cause as NodeJS.ErrnoException | undefined)?.code;
      const reason = (error as Error).name === 'TimeoutError' ? 'Zeitüberschreitung'
        : code === 'ECONNREFUSED' ? 'Port geschlossen — WebAdmin aktiv?'
        : code ?? (error as Error).message;
      throw new GameServerError(`WebAdmin nicht erreichbar (${reason})`);
    }
    if (response.status === 401 || response.status === 403) throw new GameServerError('WebAdmin-Anmeldung abgelehnt');
    if (!response.ok) throw new GameServerError(`WebAdmin antwortet mit HTTP ${response.status}`);
    return response.text();
  };
  await send(`${base}/current_console`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SendText: command, Send: 'Send' }).toString(),
  });
  try {
    // The last lines of the console log, so the admin sees the answer
    return htmlToText(await send(`${base}/current_console_log`)).split('\n').slice(-30).join('\n');
  } catch {
    return 'Befehl gesendet.';
  }
}
