// Tests for what the local scan stack notes of a call made to Supabase Auth (stack/lib.mjs authCallNote, which
// functions-server.mjs writes to run/auth-calls.jsonl and crew-e2e.mjs keeps): the shape of an answer, its status
// and Auth's error_code, and never a value of it. The tokens, ids and addresses here are made up. They need
// nothing running. Run them with: node --test "test/*.node.mjs"

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { authCallNote, errorCodeOf, shapeOf } from '../stack/lib.mjs';

const AUTH = 'https://127.0.0.1:54321/auth/v1';
const token = () => `eyJ${randomBytes(24).toString('base64url')}.${randomBytes(48).toString('base64url')}.${randomBytes(32).toString('base64url')}`;

describe('what is noted of a call to Supabase Auth', () => {
  it('keeps the keys of a session and the types of their values, and none of the values', () => {
    const id = randomUUID();
    const answer = {
      access_token: token(),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: 1795000000,
      refresh_token: randomBytes(9).toString('hex'),
      user: { id, email: `crew-${randomBytes(16).toString('hex')}@crew.minemuster.com`, app_metadata: { provider: 'email', providers: ['email'], sign_in: 'passcode' }, identities: [{ id, identity_data: { sub: id } }] },
      weak_password: null,
    };
    const noted = authCallNote('POST', `${AUTH}/token?grant_type=password`, 200, JSON.stringify(answer));
    assert.deepEqual(noted.shape, {
      access_token: 'string',
      expires_at: 'number',
      expires_in: 'number',
      refresh_token: 'string',
      token_type: 'string',
      user: { app_metadata: { provider: 'string', providers: ['string'], sign_in: 'string' }, email: 'string', id: 'string', identities: [{ id: 'string', identity_data: 'object' }] },
      weak_password: 'null',
    });
    const written = JSON.stringify(noted);
    for (const value of [answer.access_token, answer.refresh_token, id, answer.user.email, 'passcode', 'bearer', '3600']) assert.ok(!written.includes(value), 'a value of the answer is not noted');
  });

  it('takes ids out of the path, and keeps a query value only when it names the call', () => {
    const id = randomUUID();
    assert.equal(authCallNote('DELETE', `${AUTH}/admin/users/${id}`, 200, '{}').path, '/auth/v1/admin/users/:id');
    assert.deepEqual(authCallNote('POST', `${AUTH}/token?grant_type=refresh_token`, 400, '').query, ['grant_type=refresh_token']);
    assert.deepEqual(authCallNote('POST', `${AUTH}/logout?scope=others`, 204, '').query, ['scope=others']);
    const link = authCallNote('GET', `${AUTH}/verify?token=${randomBytes(28).toString('hex')}&type=invite&redirect_to=${encodeURIComponent('https://app.minemuster.com/?invited=1')}`, 303, '');
    assert.deepEqual(link.query, ['token', 'type=invite', 'redirect_to']);
    assert.deepEqual(authCallNote('GET', `${AUTH}/verify?type=${encodeURIComponent('Bearer x.y.z')}`, 303, '').query, ['type']);
  });

  it('keeps Auth\'s error_code only when it looks like a code, and an answer that is not JSON as no shape', () => {
    assert.equal(errorCodeOf({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }), 'invalid_credentials');
    assert.equal(errorCodeOf({ error_code: `Bearer ${token()}` }), null);
    assert.equal(errorCodeOf(null), null);
    const page = authCallNote('GET', `${AUTH}/user`, 502, '<html>no healthy upstream</html>');
    assert.equal(page.shape, '(not JSON)');
    assert.equal(page.error_code, null);
    assert.equal(authCallNote('POST', `${AUTH}/logout?scope=others`, 204, '').shape, 'null');
  });

  it('gives a value below four levels as its type alone', () => {
    assert.deepEqual(shapeOf({ a: { b: { c: { d: { e: 'deep' } }, list: [[1]] } } }), { a: { b: { c: { d: 'object' }, list: ['array'] } } });
  });
});
