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
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

export function isAdmin(req: Request): boolean {
  return !authRequired() || isValidSessionToken(readCookie(req, SESSION_COOKIE));
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
}

export const clearedSessionCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

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
