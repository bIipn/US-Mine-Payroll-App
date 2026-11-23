// The records the local scan stack's seed sends (scripts/security-scan/stack/seed.mjs), held to the server's own
// checks: push_records takes every one of them, and the four kinds every phone reads (settings, employee,
// equipment, areaSheet) are of the shape the phones read (shared_record_problem; readRecord in the app). A record
// the server sets aside stops the seed, and then the stack cannot start and its smoke cannot run. Everything here is
// made up, as the seed is.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { memberRecords, supervisorRecords } from '../../scripts/security-scan/stack/seed.mjs';
import { newMember, startCompany, startDatabase } from './harness.mjs';

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

/** The kinds every phone reads, which the server checks the shape of. */
const SHARED = ['settings', 'employee', 'equipment', 'areaSheet'];

describe("the scan stack's seed", () => {
  it('writes the four kinds every phone reads in the shape the server checks', async () => {
    for (const [name, state] of [['Test Pit A', 'CA'], ['Test Pit B', 'NV']]) {
      const shared = supervisorRecords(name, state).filter((change) => SHARED.includes(change.kind));
      assert.deepEqual(shared.map((change) => change.kind).sort(), [...SHARED].sort(), 'one record of each kind');
      for (const change of shared) {
        const [{ problem }] = await db.adminRows('select public.shared_record_problem($1, $2, $3::jsonb) as problem', [change.kind, change.id, JSON.stringify(change.record)]);
        assert.equal(problem, null, `${change.kind} ${change.id} ${problem}`);
      }
    }
  });

  it('has every record it sends taken by push_records, as the seed itself demands', async () => {
    // As the seed does it: a supervisor sends one record of each kind a supervisor sends, then an employee who
    // joined with the code and her name sends the rest.
    const company = await startCompany(db, { name: 'Test Pit A', state: 'CA', roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const at = Date.now() - 3600000;
    for (const [who, changes] of [
      [company.owner, supervisorRecords('Test Pit A', 'CA')],
      [riley, memberRecords(at)],
    ]) {
      const answer = await db.as(who).call('push_records', { company_id: company.id, changes: JSON.stringify(changes) });
      assert.deepEqual(answer.ignored, [], `set aside: ${JSON.stringify(answer.ignored)}`);
      assert.equal(answer.accepted.length, changes.length);
    }
  });
});
