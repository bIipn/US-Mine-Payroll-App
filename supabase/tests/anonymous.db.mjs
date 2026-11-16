// Regression for migration 20261116001200: a Supabase anonymous sign-in
// (the authenticated role, a real sub, "is_anonymous": true in the JWT) is a
// throwaway account. join_company and create_company refuse it, so it cannot
// claim rows or leave requests when a project turns anonymous sign-ins on.
//
// auth.jwt() reads request.jwt.claims, as Supabase provides it; the stub
// (supabase-stub.mjs) defines it the same way. A normal signed-in request in
// these tests sets no claims, so is_anonymous is absent and nothing changes.
// All names are made up.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { addToRoster, startCompany, startDatabase } from './harness.mjs';

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

/** Run a call as an anonymous sign-in: authenticated, a real sub, is_anonymous true. */
async function asAnonymous(sql, params) {
  const id = randomUUID();
  await db.admin('insert into auth.users (id, email) values ($1, null)', [id]);
  const claims = JSON.stringify({ sub: id, role: 'authenticated', is_anonymous: true });
  return db.pg.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [id, claims]);
    await tx.exec('set local role authenticated');
    return tx.query(sql, params);
  });
}

describe('an anonymous sign-in', () => {
  it('cannot join a company, claim a row, or leave a request', async () => {
    const company = await startCompany(db);
    await addToRoster(db, company.owner, company.id, { first: 'Riley J', last: 'Quinn', role: 'supervisor' });
    await assert.rejects(
      asAnonymous('select public.join_company($1, $2, $3)', [company.code, 'Riley', 'Quinn']),
      (error) => error.code === '42501',
    );
    assert.equal((await db.adminRows('select count(*)::int as n from public.join_requests where company_id = $1', [company.id]))[0].n, 0);
    assert.equal((await db.adminRows('select count(*)::int as n from public.roster where company_id = $1 and user_id is not null', [company.id]))[0].n, 1);
  });

  it('cannot start a company', async () => {
    await assert.rejects(
      asAnonymous('select * from public.create_company($1, $2, $3, $4, $5)', ['Test Pit Z', 'CA', 'America/Los_Angeles', 'Mal', 'Lory']),
      (error) => error.code === '42501',
    );
    assert.equal((await db.adminRows("select count(*)::int as n from public.companies where name = 'Test Pit Z'"))[0].n, 0);
  });

  it('does not change a normal signed-in request (no is_anonymous claim)', async () => {
    const company = await startCompany(db, { name: 'Test Pit B', roster: [{ first: 'Maria', last: 'De La Cruz' }] });
    const account = await db.newAccount();
    // The harness sets only the sub, never is_anonymous, so a real account joins as before.
    const result = await db.as(account).call('join_company', { code: company.code, first_name: 'Maria', last_name: 'De La Cruz' });
    assert.equal(result.status, 'joined');
  });
});
