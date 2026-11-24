// What an employee cannot do: change the roster, roles, company settings, the
// join code, requests or notifications, or make themselves a supervisor. And
// what nobody does through the API, supervisors included: write a claim.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  join,
  newMember,
  NO_PRIVILEGE,
  NOT_FOUND,
  refused,
  startCompany,
  startDatabase,
} from './harness.mjs';

let db;
let company;
let employee; // Riley J Quinn
let coworker; // Maria De La Cruz
let request; // from someone typing Pat Cole

before(async () => {
  db = await startDatabase();
  company = await startCompany(db, {
    roster: [
      { first: 'Riley J', last: 'Quinn', title: 'Crusher' },
      { first: 'Maria', last: 'De La Cruz' },
      { first: 'Lee "Buck"', last: 'Vance III' },
    ],
  });
  employee = await newMember(db, company, 'Riley', 'Quinn');
  coworker = await newMember(db, company, 'Maria', 'De La Cruz');
  await join(db, await db.newAccount(), company.code, 'Pat', 'Cole');
  [request] = await db.adminRows('select * from public.join_requests where company_id = $1', [company.id]);
});
after(async () => {
  await db?.close();
});

async function snapshot() {
  return {
    company: await db.adminRows('select * from public.companies where id = $1', [company.id]),
    roster: await db.adminRows('select * from public.roster where company_id = $1 order by id', [company.id]),
    requests: await db.adminRows('select * from public.join_requests where company_id = $1 order by id', [company.id]),
    notifications: await db.adminRows('select * from public.notifications where company_id = $1 order by id', [company.id]),
  };
}

const own = () => company.rows['Riley J Quinn'];

describe('an employee', () => {
  it('reads their company and its roster', async () => {
    const as = db.as(employee);
    assert.deepEqual((await as.rows('select id, name, join_code from public.companies')), [{ id: company.id, name: 'Test Pit A', join_code: company.code }]);
    assert.equal((await as.rows('select id from public.roster')).length, 4);
  });

  it('cannot add, change or remove anyone on the roster, themselves included', async () => {
    const before = await snapshot();
    const as = db.as(employee);
    await refused(
      as.query("insert into public.roster (company_id, first_name, last_name) values ($1, 'Lee', 'Park')", [company.id]),
      NO_PRIVILEGE,
      /row-level security/,
    );
    assert.equal(await as.affected("update public.roster set title = 'Shop' where id = $1", [own()]), 0);
    assert.equal(await as.affected("update public.roster set first_name = 'Ana', active = false where id = $1", [company.rows['Maria De La Cruz']]), 0);
    assert.equal(await as.affected('update public.roster set active = false where company_id = $1', [company.id]), 0);
    assert.equal(await as.affected('delete from public.roster where id = $1', [company.rows['Maria De La Cruz']]), 0);
    assert.equal(await as.affected('delete from public.roster where id = $1', [own()]), 0);
    await refused(as.query('truncate public.roster cascade'), NO_PRIVILEGE, /permission denied/);
    assert.deepEqual(await snapshot(), before);
  });

  it('cannot make themselves, or anyone, a supervisor', async () => {
    const before = await snapshot();
    const as = db.as(employee);
    assert.equal(await as.affected("update public.roster set role = 'supervisor' where id = $1", [own()]), 0);
    assert.equal(await as.affected("update public.roster set role = 'supervisor' where company_id = $1", [company.id]), 0);
    await refused(as.call('approve_join_request', { request_id: request.id, role: 'supervisor' }), NOT_FOUND);
    await refused(as.call('release_roster_claim', { roster_id: own() }), NOT_FOUND);
    await refused(as.call('release_roster_claim', { roster_id: company.ownRow }), NOT_FOUND);
    // Joining again changes nothing.
    assert.deepEqual(await join(db, employee, company.code, 'Sam', 'Ortiz'), { status: 'already_member', company_name: 'Test Pit A', role: 'employee' });

    // Starting a company of their own makes them a supervisor there, and only there.
    const [theirs] = await as.callRows('create_company', { name: 'Test Pit C', state: 'CA', timezone: null, first_name: 'Riley J', last_name: 'Quinn' });
    assert.equal(await as.call('is_supervisor', { company_id: theirs.company_id }), true);
    assert.equal(await as.call('is_supervisor', { company_id: company.id }), false);
    assert.deepEqual(await snapshot(), before);
  });

  it('cannot change the company settings or the join code', async () => {
    const before = await snapshot();
    const as = db.as(employee);
    assert.equal(await as.affected("update public.companies set name = 'Taken', state = 'NV', timezone = 'UTC', logo_path = 'x.png', pay_period = '{}' where id = $1", [company.id]), 0);
    await refused(as.query("update public.companies set join_code = 'ABCDEFGH' where id = $1", [company.id]), NO_PRIVILEGE, /permission denied/);
    await refused(as.call('rotate_join_code', { company_id: company.id }), NOT_FOUND, /No such company/);
    assert.deepEqual(await snapshot(), before);
  });

  it('cannot see or decide join requests', async () => {
    const before = await snapshot();
    const as = db.as(employee);
    assert.deepEqual(await as.rows('select * from public.join_requests'), []);
    await refused(as.call('approve_join_request', { request_id: request.id }), NOT_FOUND, /No such join request/);
    await refused(as.call('approve_join_request', { request_id: request.id, roster_id: company.rows['Lee "Buck" Vance III'] }), NOT_FOUND);
    await refused(as.call('deny_join_request', { request_id: request.id }), NOT_FOUND, /No such join request/);
    await refused(as.query("update public.join_requests set status = 'approved' where id = $1", [request.id]), NO_PRIVILEGE);
    await refused(as.query('delete from public.join_requests where id = $1', [request.id]), NO_PRIVILEGE);
    assert.deepEqual(await snapshot(), before);
  });

  it('cannot see, mark, write or remove notifications', async () => {
    const before = await snapshot();
    const as = db.as(employee);
    assert.deepEqual(await as.rows('select * from public.notifications'), []);
    assert.equal(await as.affected('update public.notifications set read_at = now() where company_id = $1', [company.id]), 0);
    await refused(as.query("insert into public.notifications (company_id, kind, roster_id) values ($1, 'joined', $2)", [company.id, own()]), NO_PRIVILEGE);
    await refused(as.query('delete from public.notifications where company_id = $1', [company.id]), NO_PRIVILEGE);
    assert.deepEqual(await snapshot(), before);
  });
});

describe('nobody, a supervisor included', () => {
  it('writes a claim, moves a row to another company, or makes requests or notifications through the API', async () => {
    const before = await snapshot();
    const other = await startCompany(db, { name: 'Test Pit B' });
    const unclaimed = company.rows['Lee "Buck" Vance III'];
    for (const account of [company.owner, employee, coworker]) {
      const as = db.as(account);
      const writes = [
        ['update public.roster set user_id = $2 where id = $1', [unclaimed, account]],
        ['update public.roster set claimed_at = now() where id = $1', [unclaimed]],
        ['update public.roster set user_id = null where id = $1', [own()]],
        ['update public.roster set company_id = $2 where id = $1', [unclaimed, other.id]],
        ['update public.roster set id = gen_random_uuid() where id = $1', [unclaimed]],
        ['update public.roster set created_at = now() where id = $1', [unclaimed]],
        ["insert into public.roster (company_id, first_name, last_name, user_id) values ($1, 'Lee', 'Park', $2)", [company.id, account]],
        ["insert into public.roster (company_id, first_name, last_name, claimed_at) values ($1, 'Lee', 'Park', now())", [company.id]],
        ["insert into public.roster (id, company_id, first_name, last_name) values (gen_random_uuid(), $1, 'Lee', 'Park')", [company.id]],
        ["insert into public.join_requests (company_id, user_id, first_name, last_name, reason) values ($1, $2, 'Lee', 'Park', 'not_on_roster')", [company.id, account]],
        ["insert into public.notifications (company_id, kind, roster_id) values ($1, 'joined', $2)", [company.id, own()]],
        ["update public.notifications set kind = 'joined' where company_id = $1", [company.id]],
        ['update public.notifications set created_at = now() where company_id = $1', [company.id]],
      ];
      for (const [sql, params] of writes) await refused(as.query(sql, params), NO_PRIVILEGE, /permission denied/);
    }
    assert.deepEqual(await snapshot(), before);
  });
});
