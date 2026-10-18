import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import {
  authRequired, createSessionToken, isAdmin, isValidSessionToken, passwordMatches,
  requireAdminForChanges, SESSION_COOKIE,
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
