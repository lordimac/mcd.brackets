import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import {
  authRequired, clearedSessionCookie, createSessionToken, isAdmin, isValidSessionToken, LOGIN_MAX_FAILURES, loginRetryAfter,
  passwordMatches, recordLoginFailure, rejectCrossSite, requireAdminForChanges, resetLoginFailures, SESSION_COOKIE, sessionCookie,
} from './auth';
import { HttpError } from './http-error';

function withPassword(password: string | undefined, fn: () => void) {
  const previous = process.env.ADMIN_PASSWORD;
  if (password === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = password;
  try { fn(); } finally {
    if (previous === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous;
  }
}

function request(method: string, path: string, token?: string): Request {
  return { method, path, headers: token ? { cookie: `foo=bar; ${SESSION_COOKIE}=${encodeURIComponent(token)}` } : {} } as unknown as Request;
}

// Runs the middleware and returns the error it passed on (or undefined)
function guard(req: Request): unknown {
  let passed: unknown = 'not called';
  requireAdminForChanges(req, {} as Response, ((error?: unknown) => { passed = error; }) as NextFunction);
  return passed;
}

test('without ADMIN_PASSWORD everyone is admin', () => {
  withPassword(undefined, () => {
    assert.equal(authRequired(), false);
    assert.equal(isAdmin(request('POST', '/stages')), true);
    assert.equal(passwordMatches(''), false);
    assert.equal(guard(request('DELETE', '/stages/1')), undefined);
  });
});

test('password check and signed session tokens', () => {
  withPassword('geheim', () => {
    assert.equal(passwordMatches('geheim'), true);
    assert.equal(passwordMatches('Geheim'), false);
    assert.equal(passwordMatches(undefined), false);

    const token = createSessionToken();
    assert.equal(isValidSessionToken(token), true);
    assert.equal(isAdmin(request('POST', '/stages', token)), true);
    assert.equal(isAdmin(request('POST', '/stages')), false);

    // Tampered, expired or foreign tokens are rejected
    const [expires, signature] = token.split('.');
    assert.equal(isValidSessionToken(`${Number(expires) + 1000}.${signature}`), false);
    assert.equal(isValidSessionToken(createSessionToken(0)), false);
    assert.equal(isValidSessionToken('garbage'), false);
  });

  // Changing the password invalidates existing sessions
  let token = '';
  withPassword('alt', () => { token = createSessionToken(); });
  withPassword('neu', () => assert.equal(isValidSessionToken(token), false));
});

test('reads are public, changes and the backup need the session', () => {
  withPassword('geheim', () => {
    assert.equal(guard(request('GET', '/stages')), undefined);
    assert.equal(guard(request('GET', '/events/1/export/csv')), undefined);
    assert.equal(guard(request('POST', '/login')), undefined);
    assert.equal(guard(request('GET', '/auth')), undefined);

    for (const [method, path] of [['POST', '/stages'], ['PUT', '/matches/3'], ['DELETE', '/attendees/1'], ['POST', '/restore'], ['GET', '/backup'], ['GET', '/opnsense'], ['POST', '/events/1/opnsense/preview']]) {
      const error = guard(request(method, path));
      assert.ok(error instanceof HttpError && error.status === 401, `${method} ${path}`);
    }
    assert.equal(guard(request('PUT', '/matches/3', createSessionToken())), undefined);
  });
});

test('a malformed session cookie counts as not logged in', () => {
  withPassword('geheim', () => {
    const req = { method: 'POST', path: '/stages', headers: { cookie: `${SESSION_COOKIE}=%` } } as unknown as Request;
    assert.equal(isAdmin(req), false);
  });
});

test('session cookies get Secure only via HTTPS', () => {
  assert.ok(!sessionCookie('t').includes('Secure'));
  assert.ok(sessionCookie('t', true).endsWith('; Secure'));
  assert.ok(clearedSessionCookie(true).includes('Max-Age=0; Secure'));
});

test('login is blocked after too many wrong passwords per IP', () => {
  const ip = '192.0.2.10';
  const start = 1_000_000;
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    assert.equal(loginRetryAfter(ip, start + i), 0);
    recordLoginFailure(ip, start + i);
  }
  assert.equal(loginRetryAfter(ip, start + 60_000), 15 * 60 - 60);
  assert.equal(loginRetryAfter('192.0.2.11', start), 0, 'other IPs are not affected');
  // The window slides: once the oldest failure is 15 min old, one more attempt is allowed
  assert.equal(loginRetryAfter(ip, start + 15 * 60 * 1000 + 1), 0);

  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure(ip, start);
  resetLoginFailures(ip); // successful login
  assert.equal(loginRetryAfter(ip, start), 0);
});

// Runs the CSRF check and returns the error it passed on (or undefined)
function crossSite(method: string, headers: Record<string, string | undefined>): unknown {
  const req = { method, path: '/rooms/1/clear', headers: { host: 'lan.example:3001', ...headers }, host: 'lan.example:3001' } as unknown as Request;
  let passed: unknown = 'not called';
  rejectCrossSite(req, {} as Response, ((error?: unknown) => { passed = error; }) as NextFunction);
  return passed;
}

test('changes from foreign pages are rejected (CSRF)', () => {
  for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'http://lan.example:3000' }, { origin: 'null' }]) {
    const error = crossSite('POST', headers);
    assert.ok(error instanceof HttpError && error.status === 403, JSON.stringify(headers));
  }
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}, { origin: 'http://lan.example:3001' }]) {
    assert.equal(crossSite('POST', headers), undefined, JSON.stringify(headers));
  }
  assert.equal(crossSite('GET', { 'sec-fetch-site': 'cross-site' }), undefined, 'reads stay possible');
});
