import { describe, expect, it } from 'vitest';

import { dataProblem, notAllowed } from '../src/lib/errors';
import { match } from '../src/lib/router';
import { isSecretKey } from '../src/lib/secretKey';

const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

describe('an address', () => {
  it('names a record, and a malformed escape names no page rather than stopping the dashboard', () => {
    expect(match('/exams/:id', '/exams/abc%20d')).toEqual({ id: 'abc d' });
    expect(match('/exams/:id', '/exams/%E0%A4%A')).toBeNull();
    expect(match('/exams/:id', '/requests/abc')).toBeNull();
  });
});

describe('a key for the build', () => {
  it('tells a secret key from a publishable one', () => {
    expect(isSecretKey('sb_publishable_abc123')).toBe(false);
    expect(isSecretKey('sb_secret_abc123')).toBe(true);
    expect(isSecretKey(jwt({ role: 'anon' }))).toBe(false);
    expect(isSecretKey(jwt({ role: 'service_role' }))).toBe(true);
    expect(isSecretKey('not.a.key')).toBe(false);
  });
});

describe('a server answer with no words of its own', () => {
  it('says what did not work and what to do next', () => {
    expect(dataProblem({ code: 'XX000', message: 'internal error' }, 'Loading the roster').message).toBe(
      'Loading the roster did not work (the server said: internal error). Try again in a minute. If it keeps happening, tell whoever runs MineMuster for your company.',
    );
    expect(dataProblem({}, 'Loading the roster').message).toBe(
      'Loading the roster did not work. Try again in a minute. If it keeps happening, tell whoever runs MineMuster for your company.',
    );
  });

  it('knows a refusal for want of the role', () => {
    expect(notAllowed(dataProblem({ code: '42501', message: 'permission denied' }))).toBe(true);
    expect(notAllowed(dataProblem({ code: '23505' }))).toBe(false);
  });
});
