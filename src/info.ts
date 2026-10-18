// Footer data: version, newer version on GitHub (cached, fails silently offline) and short statistics

import https from 'https';
import type { Match } from 'brackets-model';
import { getAppStore, getStorage } from './db';

/* Version comparison ("0.17.2-beta", "v1.0.0")
   ========================================================================== */

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// > 0 if a is newer than b; a release is newer than its pre-releases (1.0.0 > 1.0.0-beta)
export function compareVersions(a: string, b: string): number {
  const x = VERSION_PATTERN.exec(a), y = VERSION_PATTERN.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return diff;
  }
  if (!x[4] !== !y[4]) return x[4] ? -1 : 1;
  return (x[4] ?? '').localeCompare(y[4] ?? '', 'en', { numeric: true });
}

// Highest version among tag names like "v0.17.1-beta"; others are ignored
export function latestVersion(tags: string[]): string | null {
  const versions = tags.filter(t => VERSION_PATTERN.test(t)).map(t => t.replace(/^v/, ''));
  return versions.reduce<string | null>((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

/* Update check against the GitHub tags
   ========================================================================== */

export interface UpdateInfo {
  latest: string;
  url: string;
  checked_at: string;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
let updateInfo: UpdateInfo | null = null;

export const updateCheckEnabled = () => !/^(0|false|no|off)$/i.test(process.env.UPDATE_CHECK ?? '');

// "https://github.com/owner/repo" → "owner/repo"
function githubRepo(repoUrl: string): string | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(repoUrl);
  return match ? match[1] : null;
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'mcd-brackets', Accept: 'application/vnd.github+json' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function checkForUpdate(repoUrl: string): Promise<void> {
  const repo = githubRepo(repoUrl);
  if (!repo) return;
  try {
    const tags = await fetchJson(`https://api.github.com/repos/${repo}/tags?per_page=100`);
    const latest = Array.isArray(tags) ? latestVersion(tags.map(t => String((t as { name?: unknown }).name ?? ''))) : null;
    if (latest) updateInfo = { latest, url: `${repoUrl}/tree/v${latest}`, checked_at: new Date().toISOString() };
  } catch {
    // No internet (typical at a LAN party) or rate limit: keep the last known state
  }
}

// Check at startup and then periodically; the timer doesn't keep the process alive
export function startUpdateChecks(repoUrl: string): void {
  if (!updateCheckEnabled()) return;
  void checkForUpdate(repoUrl);
  setInterval(() => void checkForUpdate(repoUrl), CHECK_INTERVAL_MS).unref();
}

export function updateFor(version: string): (UpdateInfo & { available: boolean }) | null {
  return updateInfo ? { ...updateInfo, available: compareVersions(updateInfo.latest, version) > 0 } : null;
}

/* Statistics
   ========================================================================== */

export interface Stats {
  events: number;
  attendees: number;
  tournaments: number;
  matches_played: number;
}

const MATCH_COMPLETED = 4; // Status.Completed; Archived (5) counts as played too

// Played = both sides known, finished, and not decided by a bye or a forfeit ("In Gedenken")
export function isPlayedMatch(match: Match): boolean {
  return match.status >= MATCH_COMPLETED
    && match.opponent1?.id != null && match.opponent2?.id != null
    && !match.opponent1.forfeit && !match.opponent2.forfeit;
}

export async function getStats(): Promise<Stats> {
  const [events, attendees, stages, matches] = await Promise.all([
    getAppStore().select('event'),
    getAppStore().select('attendee'),
    getStorage().select('stage'),
    getStorage().select('match'),
  ]);
  return {
    events: events?.length ?? 0,
    attendees: attendees?.length ?? 0,
    tournaments: stages?.length ?? 0,
    matches_played: (matches ?? []).filter(isPlayedMatch).length,
  };
}
