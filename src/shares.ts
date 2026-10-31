// SMB shares (SMB 3): attendees share folders of their PCs, admins add fixed shares of the event.
// The browser opens them via smb:// on macOS and a downloaded .cmd (net use) on Windows
// (public/shares.js) — so path, user and password must not break the quoting of the .cmd.
// Pure functions only — persistence lives in lan-store.ts.

import crypto from 'crypto';
import { isValidDomain, normalizeDomain, parseIPv4, RANGE_COUNT, ValidationError } from './lan';

export interface SmbShare {
  id: string;
  label: string;     // optional description, e.g. "Spiele"
  path: string;      // share name plus optional folders, separated by "/", e.g. "games/steam"
  username: string;  // optional, may contain a domain: "WORKGROUP\gast"
  password: string;
}

export interface AttendeeShare extends SmbShare {
  range_index: number; // PC of the attendee: host = ips[range_index]
}

export interface EventShare extends SmbShare {
  host: string;        // IPv4 address or DNS name
}

export const MAX_ATTENDEE_SHARES = 10;
export const MAX_EVENT_SHARES = 20;

const ID_PATTERN = /^[\w-]{1,40}$/;
// Characters Windows doesn't allow in share and folder names, plus "%" (expanded by cmd)
const PATH_SEGMENT = /^[^\\/:*?"<>|%\x00-\x1F\x7F]+$/;
// "%" and '"' would break the quoting in the .cmd, control characters the lines
const CREDENTIAL = /^[^"%\x00-\x1F\x7F]*$/;

const shareId = (value: unknown) => (typeof value === 'string' && ID_PATTERN.test(value) ? value : crypto.randomUUID());
const text = (value: unknown) => (typeof value === 'string' ? value : '');

// "\\games\steam\" or "games/steam" → "games/steam"
export function normalizeSharePath(value: string): string {
  return value.trim().split(/[\\/]+/).map(segment => segment.trim()).filter(Boolean).join('/');
}

function validateShare(raw: unknown, label: string): SmbShare {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = text(input.label).trim();
  if (name.length > 60) throw new ValidationError(`${label}: Bezeichnung ist zu lang (max. 60 Zeichen)`);

  const path = normalizeSharePath(text(input.path));
  if (!path) throw new ValidationError(`${label}: Freigabename fehlt`);
  if (path.length > 120) throw new ValidationError(`${label}: Pfad ist zu lang (max. 120 Zeichen)`);
  if (!path.split('/').every(segment => PATH_SEGMENT.test(segment))) {
    throw new ValidationError(`${label}: der Pfad darf keine der Zeichen \\ : * ? " < > | % enthalten`);
  }

  const username = text(input.username).trim();
  const password = text(input.password); // not trimmed: spaces count
  if (username.length > 64) throw new ValidationError(`${label}: Benutzername ist zu lang (max. 64 Zeichen)`);
  if (password.length > 128) throw new ValidationError(`${label}: Passwort ist zu lang (max. 128 Zeichen)`);
  if (!CREDENTIAL.test(username) || !CREDENTIAL.test(password)) {
    throw new ValidationError(`${label}: Benutzername und Passwort dürfen kein " und kein % enthalten`);
  }
  if (password && !username) throw new ValidationError(`${label}: zum Passwort fehlt der Benutzername`);

  return { id: shareId(input.id), label: name, path, username, password };
}

function shareList(input: unknown, max: number): unknown[] {
  const list = input ?? [];
  if (!Array.isArray(list)) throw new ValidationError('Shares: Liste erwartet');
  if (list.length > max) throw new ValidationError(`Höchstens ${max} Shares`);
  return list;
}

export function validateAttendeeShares(input: unknown): AttendeeShare[] {
  return shareList(input, MAX_ATTENDEE_SHARES).map((raw, i) => {
    const share = validateShare(raw, `Share ${i + 1}`);
    const rangeIndex = Number((raw as { range_index?: unknown } | null)?.range_index ?? 0);
    if (!Number.isInteger(rangeIndex) || rangeIndex < 0 || rangeIndex >= RANGE_COUNT) {
      throw new ValidationError(`Share ${i + 1}: ungültiger PC`);
    }
    return { ...share, range_index: rangeIndex };
  });
}

export function validateEventShares(input: unknown): EventShare[] {
  return shareList(input, MAX_EVENT_SHARES).map((raw, i) => {
    const share = validateShare(raw, `Share ${i + 1}`);
    const rawHost = text((raw as { host?: unknown } | null)?.host).trim();
    const host = parseIPv4(rawHost) !== null ? rawHost : normalizeDomain(rawHost);
    if (!host) throw new ValidationError(`Share ${i + 1}: Server fehlt`);
    if (parseIPv4(host) === null && !isValidDomain(host)) throw new ValidationError(`Share ${i + 1}: ungültiger Server ${rawHost}`);
    return { ...share, host };
  });
}
