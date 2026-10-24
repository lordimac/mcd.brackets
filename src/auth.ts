import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './http-error';

// Admin login via the ADMIN_PASSWORD environment variable. Without it everyone may edit.
// The session is a stateless signed cookie "<expires>.<hmac>": it survives restarts and
// becomes invalid as soon as the password changes.

export const SESSION_COOKIE = 'mcd_admin';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

const adminPassword = () => process.env.ADMIN_PASSWORD ?? '';
export const authRequired = () => adminPassword().length > 0;

function sign(expires: number): string {
  return crypto.createHmac('sha256', `mcd-brackets:${adminPassword()}`).update(String(expires)).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

export function passwordMatches(input: unknown): boolean {
  return authRequired() && typeof input === 'string' && safeEqual(input, adminPassword());
}

export function createSessionToken(now: number = Date.now()): string {
  const expires = now + SESSION_MS;
  return `${expires}.${sign(expires)}`;
}

export function isValidSessionToken(token: string | undefined, now: number = Date.now()): boolean {
  if (!token) return false;
  const [expiresText, signature] = token.split('.');
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires < now || !signature) return false;
  return safeEqual(signature, sign(expires));
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return undefined; // malformed cookie = not logged in
    }
  }
  return undefined;
}

export function isAdmin(req: Request): boolean {
  return !authRequired() || isValidSessionToken(readCookie(req, SESSION_COOKIE));
}

// secure: request came in via HTTPS (behind a reverse proxy only with TRUST_PROXY)
export function sessionCookie(token: string, secure = false): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure = false): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

// Login attempts: at most LOGIN_MAX_FAILURES wrong passwords per IP within LOGIN_WINDOW_MS,
// then the IP has to wait until the oldest failure in the window has expired
export const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, number[]>();

function recentFailures(ip: string, now: number): number[] {
  const recent = (loginFailures.get(ip) ?? []).filter(time => time > now - LOGIN_WINDOW_MS);
  if (recent.length) loginFailures.set(ip, recent);
  else loginFailures.delete(ip);
  return recent;
}

// Seconds until the next attempt is allowed, 0 = allowed now
export function loginRetryAfter(ip: string, now: number = Date.now()): number {
  const recent = recentFailures(ip, now);
  if (recent.length < LOGIN_MAX_FAILURES) return 0;
  return Math.ceil((recent[recent.length - LOGIN_MAX_FAILURES] + LOGIN_WINDOW_MS - now) / 1000);
}

export function recordLoginFailure(ip: string, now: number = Date.now()): void {
  loginFailures.set(ip, [...recentFailures(ip, now), now]);
  // Forget expired entries of other IPs now and then, so the map can't grow forever
  if (loginFailures.size > 1000) for (const key of [...loginFailures.keys()]) recentFailures(key, now);
}

export function resetLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}

// CSRF protection: changes only from the app's own pages. Cookies are sent for the whole site
// (host without port), so SameSite=Strict alone doesn't stop another app on the same host.
// Browsers send Sec-Fetch-Site; older ones at least Origin. Tools like curl send neither.
export function rejectCrossSite(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    next();
    return;
  }
  const site = req.headers['sec-fetch-site'];
  let foreign = site === 'cross-site' || site === 'same-site';
  if (!site && req.headers.origin) {
    try {
      foreign = new URL(req.headers.origin).host !== req.host; // req.host honours X-Forwarded-Host with TRUST_PROXY
    } catch {
      foreign = true; // "null" or garbage
    }
  }
  next(foreign ? new HttpError(403, 'Anfrage von einer fremden Seite abgelehnt') : undefined);
}

// Reads are public; every change, the full backup and the OPNsense settings need the admin session
const PUBLIC_PATHS = new Set(['/auth', '/login', '/logout']);
const isProtectedRead = (path: string) => path === '/backup' || path === '/opnsense' || path.startsWith('/opnsense/');

export function requireAdminForChanges(req: Request, _res: Response, next: NextFunction): void {
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if ((isRead && !isProtectedRead(req.path)) || PUBLIC_PATHS.has(req.path) || isAdmin(req)) {
    next();
    return;
  }
  next(new HttpError(401, 'Admin-Anmeldung erforderlich'));
}
