// Regression for migration 20261116001300: an account that is not a member of
// a company reads no id of that company's people or rows through its own join
// requests. The join_requests table is readable only by a company's
// supervisors; a requester reads their own requests through my_join_requests(),
// which never returns decided_by (the deciding supervisor's Auth id) or
// roster_id (a roster row's id). All names are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join, startCompany, startDatabase } from './harness.mjs';

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

describe('a non-member and their old join requests', () => {
  it('reads no id of the company that decided them', async () => {
    const b = await startCompany(db, { name: 'Test Pit B', state: 'NV', supervisor: ['Ana', 'Diaz'] });

    // One account is denied: never a member.
    const denied = await db.newAccount('denied');
    await join(db, denied, b.code, 'Jo', 'Sterne');
    const [deniedRequest] = await db.adminRows('select id from public.join_requests where user_id = $1', [denied]);
    await db.as(b.owner).call('deny_join_request', { request_id: deniedRequest.id });

    // Another is approved onto a new row, then taken off the roster.
    const leaver = await db.newAccount('leaver');
    await join(db, leaver, b.code, 'Pat', 'Cole');
    const [leaverRequest] = await db.adminRows('select id from public.join_requests where user_id = $1', [leaver]);
    const leaverRow = await db.as(b.owner).call('approve_join_request', { request_id: leaverRequest.id });
    await db.as(b.owner).affected('update public.roster set active = false where id = $1', [leaverRow]);

    for (const [who, account] of [['denied', denied], ['leaver', leaver]]) {
      assert.equal(await db.as(account).call('is_member', { company_id: b.id }), false, who);

      // The table itself is closed to them.
      assert.deepEqual(await db.as(account).rows('select * from public.join_requests'), [], who);

      // Their own requests, through the function, carry no B id.
      const mine = await db.as(account).callRows('my_join_requests');
      assert.ok(mine.length >= 1, who);
      for (const row of mine) {
        assert.ok(!('decided_by' in row), `${who}: my_join_requests leaks decided_by`);
        assert.ok(!('roster_id' in row), `${who}: my_join_requests leaks roster_id`);
        const text = JSON.stringify(row);
        assert.ok(!text.includes(b.owner), `${who} reads the Auth id of B's supervisor`);
        assert.ok(!text.includes(leaverRow), `${who} reads the id of a B roster row`);
      }
    }
  });

  it('still lets a supervisor read the company requests through the table', async () => {
    const company = await startCompany(db, { name: 'Test Pit C' });
    const asking = await db.newAccount();
    await join(db, asking, company.code, 'Pat', 'Cole');
    const rows = await db.as(company.owner).rows('select reason, status from public.join_requests');
    assert.deepEqual(rows, [{ reason: 'not_on_roster', status: 'pending' }]);
  });
});
