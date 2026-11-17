// anon, the public key with nobody signed in, can call company_by_code and
// the website's contact form (submit_contact_request, contact.db.mjs) and
// nothing else, and reads nothing. The authenticated role with no account id
// gets nothing either.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  join,
  newMember,
  NO_PRIVILEGE,
  NOT_SIGNED_IN,
  refused,
  startCompany,
  startDatabase,
} from './harness.mjs';

const TABLES = ['companies', 'roster', 'join_requests', 'notifications', 'company_supervisor_guard', 'join_holds'];
// The only functions anon may call: finding a company by its code, and the contact form.
const ANON_CALLS = ['company_by_code', 'submit_contact_request'];

let db;
let company;
let request;
before(async () => {
  db = await startDatabase();
  company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
  await newMember(db, company, 'Riley', 'Quinn');
  await join(db, await db.newAccount(), company.code, 'Pat', 'Cole');
  [request] = await db.adminRows('select * from public.join_requests');
});
after(async () => {
  await db?.close();
});

/** Every function in schema public, with a call that passes a typed null for each argument. */
async function publicFunctions() {
  return db.adminRows(`
    select p.proname as name,
           p.prorettype = 'trigger'::regtype as is_trigger,
           format('select public.%I(%s)', p.proname,
             coalesce((select string_agg(format('null::%s', format_type(t, null)), ', ' order by n)
                       from unnest(p.proargtypes::oid[]) with ordinality as a(t, n)), '')) as call
    from pg_proc p
    join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public'
    order by p.proname`);
}

describe('anon', () => {
  it('finds a company by its code: its name and state, nothing else', async () => {
    const found = await db.anon().callRows('company_by_code', { code: company.code });
    assert.deepEqual(found, [{ name: 'Test Pit A', state: 'CA' }]);
    assert.deepEqual(await db.anon().callRows('company_by_code', { code: 'ZZZZZZZZ' }), []);
  });

  it('reads nothing from any table', async () => {
    for (const table of TABLES) {
      await refused(db.anon().query(`select * from public.${table}`), NO_PRIVILEGE, new RegExp(`permission denied for table ${table}`));
      await refused(db.anon().query(`select count(*) from public.${table}`), NO_PRIVILEGE);
    }
  });

  it('writes nothing to any table', async () => {
    const writes = [
      ["insert into public.companies (name, state, join_code) values ('Test Pit C', 'CA', 'ABCDEFGH')", []],
      ["insert into public.roster (company_id, first_name, last_name) values ($1, 'Lee', 'Park')", [company.id]],
      ["insert into public.join_requests (company_id, user_id, first_name, last_name, reason) values ($1, gen_random_uuid(), 'Lee', 'Park', 'not_on_roster')", [company.id]],
      ["insert into public.notifications (company_id, kind, request_id) values ($1, 'join_request', $2)", [company.id, request.id]],
      ["insert into public.join_holds (company_id, user_id, kind) values ($1, gen_random_uuid(), 'barred')", [company.id]],
      ['insert into public.company_supervisor_guard (company_id) values ($1)', [company.id]],
      ...TABLES.map((table) => [`update public.${table} set ${table === 'company_supervisor_guard' ? 'changes = 0' : 'created_at = now()'}`, []]),
      ...TABLES.map((table) => [`delete from public.${table}`, []]),
      ...TABLES.map((table) => [`truncate public.${table} cascade`, []]),
    ];
    for (const [sql, params] of writes) await refused(db.anon().query(sql, params), NO_PRIVILEGE, /permission denied/);
    assert.equal((await db.adminRows('select count(*)::int as n from public.roster'))[0].n, 2);
  });

  it('calls no function but company_by_code and the contact form', async () => {
    const functions = await publicFunctions();
    assert.ok(functions.length > 10);
    for (const fn of functions) {
      const [{ allowed }] = await db.adminRows("select has_function_privilege('anon', $1::regproc, 'execute') as allowed", [`public.${fn.name}`]);
      assert.equal(allowed, ANON_CALLS.includes(fn.name), fn.name);
      if (ANON_CALLS.includes(fn.name) || fn.is_trigger) continue;
      await refused(db.anon().query(fn.call), NO_PRIVILEGE, new RegExp(`permission denied for function ${fn.name}`));
    }
  });

  it('has no account', async () => {
    assert.deepEqual(await db.anon().rows('select auth.uid() as id'), [{ id: null }]);
  });
});

describe('the authenticated role with no account id', () => {
  it('is refused by every function that acts for an account', async () => {
    const as = db.noAccount();
    const calls = [
      ['create_company', { name: 'Test Pit C', state: 'CA', timezone: null, first_name: 'Lee', last_name: 'Park' }, true],
      ['join_company', { code: company.code, first_name: 'Lee', last_name: 'Park' }],
      ['approve_join_request', { request_id: request.id }],
      ['deny_join_request', { request_id: request.id }],
      ['rotate_join_code', { company_id: company.id }],
      ['release_roster_claim', { roster_id: company.ownRow }],
      ['lift_join_bar', { request_id: request.id }],
      ['my_join_requests', {}, true],
    ];
    for (const [fn, args, table] of calls) {
      await refused(table ? as.callRows(fn, args) : as.call(fn, args), NOT_SIGNED_IN, /Sign in first/);
    }
    // The row level security policies call these two, so they answer false rather than refuse.
    assert.equal(await as.call('is_member', { company_id: company.id }), false);
    assert.equal(await as.call('is_supervisor', { company_id: company.id }), false);
    assert.equal((await db.adminRows("select status from public.join_requests where id = $1", [request.id]))[0].status, 'pending');
  });

  it('reads nothing', async () => {
    for (const table of TABLES.slice(0, 4)) assert.deepEqual(await db.noAccount().rows(`select * from public.${table}`), [], table);
    // The functions' own tables are not granted to the API roles at all.
    for (const table of TABLES.slice(4)) await refused(db.noAccount().query(`select * from public.${table}`), NO_PRIVILEGE, /permission denied/);
  });
});
