// The companies a signed-in account belongs to, supervises, and reads the
// records of: worked out in one pass over its own roster rows, with its id read
// once per call (migration 20261117000700).
//
// An account can be in many companies: the security scan's one account
// started 381 in nine minutes, and an account may join as many as will have
// it. Before that migration records_open_company_ids asked
// supervisor_company_ids() again for each of the caller's companies, so its
// cost grew with the square of their number: an account in about 1,400
// companies took one call past the 8 s statement_timeout, and held a database
// connection all that time. These tests hold each function to the answers it
// gave before, case by case, and an account in 1,000 companies to a time well
// inside the timeout.
//
// The names are made up.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { errorOf, migrationFiles, MIGRATIONS, nobody, startCompany, startDatabase } from './harness.mjs';

// The migration that made them one pass. What came before it is "the old".
const REWRITTEN_IN = '20261117000700';
const NAMES = ['is_member', 'is_supervisor', 'member_company_ids', 'supervisor_company_ids', 'records_open_company_ids', 'my_companies'];
// PostgREST's statement_timeout for the authenticated role on Supabase.
const STATEMENT_TIMEOUT_MS = 8000;
// "Well inside": an eighth of it. Before the rewrite, PGlite took about 1.1 s here, and PostgreSQL 17 about 5 s.
const BUDGET_MS = STATEMENT_TIMEOUT_MS / 8;

/** The latest definition of each function in the migrations before `stamp`, as written there. */
async function definitionsBefore(stamp) {
  const latest = {};
  for (const file of await migrationFiles()) {
    if (file.slice(0, 14) >= stamp) break;
    const sql = await readFile(new URL(file, MIGRATIONS), 'utf8');
    for (const name of NAMES) {
      const statement = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;`, 'g');
      for (const [text] of sql.matchAll(statement)) latest[name] = { file, text };
    }
  }
  return latest;
}

/** The old functions, as they were, in schema `was`: each calls the old versions of the others. */
async function installOld(db) {
  const old = await definitionsBefore(REWRITTEN_IN);
  assert.deepEqual(Object.keys(old).sort(), [...NAMES].sort());
  const ours = new RegExp(`\\bpublic\\.(${NAMES.join('|')})\\b`, 'g');
  await db.admin('create schema was');
  await db.admin('grant usage on schema was to authenticated');
  for (const name of NAMES) {
    await db.admin(old[name].text.replace(/^create (?:or replace )?function public\./, 'create function was.').replace(ours, 'was.$1'));
    await db.admin(`grant execute on function was.${name} to authenticated`);
  }
  return old;
}

const sorted = (ids) => [...(ids ?? [])].sort();

/** What one function answers a session, or the code it refuses with. */
async function answer(session, sql, params) {
  try {
    return { rows: await session.rows(sql, params) };
  } catch (error) {
    return { refused: (await errorOf(Promise.reject(error))).code };
  }
}

/** An account on a company's roster, with its account claimed on the row, as the join functions leave it. */
async function onRoster(db, account, companyId, last, role = 'employee', active = true) {
  await db.admin(
    `insert into public.roster (company_id, first_name, last_name, role, active, user_id, claimed_at)
     values ($1, 'Robin', $2, $3, $4, $5, now())`,
    [companyId, last, role, active, account],
  );
}

describe('the caller\'s companies, worked out in one pass', () => {
  let db;
  const cases = {};
  let companies = [];

  before(async () => {
    db = await startDatabase();
    await installOld(db);

    // Four companies: two with MineMuster (let in without paying), one with none, and one whose free pass has run out.
    const paid = await startCompany(db, { name: 'Test Pit A' });
    const second = await startCompany(db, { name: 'Test Pit B' });
    const unpaid = await startCompany(db, { name: 'Test Pit C', comped: false });
    const lapsed = await startCompany(db, { name: 'Test Pit D', comped: false });
    await db.admin("insert into public.billing_overrides (company_id, reason, until) values ($1, 'A pass that ran out', now() - interval '1 day')", [lapsed.id]);
    companies = [paid, second, unpaid, lapsed].map((c) => c.id);

    cases['a supervisor of a company with MineMuster'] = paid.owner;
    cases['a supervisor of a company without it'] = unpaid.owner;
    cases['a supervisor of a company whose pass ran out'] = lapsed.owner;

    const add = async (label, rows) => {
      const account = await db.newAccount('case');
      for (const [company, role, active = true] of rows) await onRoster(db, account, company, `Case ${Object.keys(cases).length}`, role, active);
      cases[label] = account;
      return account;
    };
    await add('an employee of a company with MineMuster', [[paid.id, 'employee']]);
    await add('an employee of a company without it', [[unpaid.id, 'employee']]);
    await add('in several companies, employee in some and supervisor in others', [
      [paid.id, 'employee'],
      [second.id, 'supervisor'],
      [unpaid.id, 'supervisor'],
      [lapsed.id, 'employee'],
    ]);
    await add('taken off the roster (an inactive row)', [[paid.id, 'employee', false], [second.id, 'supervisor', false]]);
    await add('taken off one company and still in another', [[paid.id, 'employee', false], [unpaid.id, 'employee']]);
    const deleted = await add('soft-deleted by Supabase Auth', [[paid.id, 'employee'], [second.id, 'supervisor']]);
    await db.admin('update auth.users set deleted_at = now() where id = $1', [deleted]);
    const banned = await add('banned until tomorrow', [[paid.id, 'employee'], [second.id, 'supervisor']]);
    await db.admin("update auth.users set banned_until = now() + interval '1 day' where id = $1", [banned]);
    const wasBanned = await add('banned until yesterday', [[paid.id, 'employee'], [second.id, 'supervisor']]);
    await db.admin("update auth.users set banned_until = now() - interval '1 day' where id = $1", [wasBanned]);
    await add('on no roster at all', []);
  });

  after(async () => {
    await db?.close();
  });

  it('read the definitions they replace from the migrations before them', async () => {
    const old = await definitionsBefore(REWRITTEN_IN);
    assert.equal(old.records_open_company_ids.file, '20261117000500_billing.sql');
    assert.equal(old.member_company_ids.file, '20261116002300_membership_needs_a_sign_in.sql');
    assert.equal(old.my_companies.file, '20261117000200_record_reads.sql');
  });

  it('keep each function\'s language, volatility, security, search path, signature, cost and grants', async () => {
    const shape = async (schema, name) => {
      const [row] = await db.adminRows(
        `select (select l.lanname from pg_language l where l.oid = p.prolang) as lang, p.provolatile, p.prosecdef, p.proconfig, p.proparallel, p.proleakproof,
                p.proisstrict, p.proretset, p.prorettype::regtype::text as returns, pg_get_function_arguments(p.oid) as args,
                pg_get_function_result(p.oid) as result, p.procost::float8 as cost, p.prorows::float8 as rows
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = $1 and p.proname = $2`,
        [schema, name],
      );
      return row;
    };
    for (const name of NAMES) {
      assert.deepEqual(await shape('public', name), await shape('was', name), name);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const [{ allowed }] = await db.adminRows("select has_function_privilege($1, $2::regproc, 'execute') as allowed", [role, `public.${name}`]);
        assert.equal(allowed, role === 'authenticated', `${role} on ${name}`);
      }
    }
  });

  it('give every case the same companies as before, and the same yes or no for each company', async () => {
    const every = { ...cases, 'nobody signed in': null };
    for (const [label, account] of Object.entries(every)) {
      const session = account ? db.as(account) : db.noAccount();
      for (const fn of ['member_company_ids', 'supervisor_company_ids', 'records_open_company_ids']) {
        const [[now], [was]] = [await session.rows(`select public.${fn}() as ids`), await session.rows(`select was.${fn}() as ids`)];
        assert.deepEqual(sorted(now.ids), sorted(was.ids), `${fn}, ${label}`);
      }
      for (const company of [...companies, nobody(), null]) {
        for (const fn of ['is_member', 'is_supervisor']) {
          const [[now], [was]] = [
            await session.rows(`select public.${fn}($1) as yes`, [company]),
            await session.rows(`select was.${fn}($1) as yes`, [company]),
          ];
          assert.equal(now.yes, was.yes, `${fn}(${company}), ${label}`);
        }
      }
      const listed = await answer(session, 'select * from public.my_companies()');
      assert.deepEqual(listed, await answer(session, 'select * from was.my_companies()'), `my_companies, ${label}`);
    }
  });

  it('and the answers are the ones each case should get', async () => {
    const open = async (label) => sorted((await db.as(cases[label]).rows('select public.records_open_company_ids() as ids'))[0].ids);
    const [paid, second, unpaid, lapsed] = companies;
    assert.deepEqual(await open('a supervisor of a company with MineMuster'), [paid]);
    assert.deepEqual(await open('a supervisor of a company without it'), []);
    assert.deepEqual(await open('a supervisor of a company whose pass ran out'), []);
    assert.deepEqual(await open('an employee of a company without it'), [unpaid]);
    assert.deepEqual(await open('in several companies, employee in some and supervisor in others'), sorted([paid, second, lapsed]));
    assert.deepEqual(await open('taken off the roster (an inactive row)'), []);
    assert.deepEqual(await open('taken off one company and still in another'), [unpaid]);
    assert.deepEqual(await open('soft-deleted by Supabase Auth'), []);
    assert.deepEqual(await open('banned until tomorrow'), []);
    assert.deepEqual(await open('banned until yesterday'), sorted([paid, second]));
    assert.deepEqual(await open('on no roster at all'), []);
    assert.deepEqual((await db.noAccount().rows('select public.records_open_company_ids() as ids'))[0].ids, []);
    assert.equal((await answer(db.noAccount(), 'select * from public.my_companies()')).refused, '42501');
  });
});

describe('an account in 1,000 companies', () => {
  const COMPANIES = 1000;
  let db;
  let many;
  let expected;

  before(async () => {
    db = await startDatabase();
    await installOld(db);
    many = await db.newAccount('many');
    // As a scan's account would be: 1,000 companies, a supervisor in four of every five, half of them with MineMuster,
    // and a record in three of every ten. Written straight into the tables: no account may start that many.
    await db.admin(
      `insert into public.companies (name, state, join_code)
       select 'Test Pit ' || g, 'CA', public.new_join_code() from generate_series(1, $1::int) g`,
      [COMPANIES],
    );
    await db.admin(
      `insert into public.roster (company_id, first_name, last_name, role, user_id, claimed_at)
       select c.id, 'Sam', 'Ortiz', case when c.n % 5 = 0 then 'employee' else 'supervisor' end, $1, now()
       from (select id, row_number() over (order by id) as n from public.companies) c`,
      [many],
    );
    await db.admin(
      `insert into public.billing_overrides (company_id, reason)
       select id, 'A test company' from (select id, row_number() over (order by id) as n from public.companies) c where c.n % 2 = 0`,
    );
    await db.admin(
      `insert into public.records (company_id, kind, id, rev, data, seq)
       select id, 'equipment', 'eq-1', 'r1', '{"id": "eq-1"}', 1 from (select id, row_number() over (order by id) as n from public.companies) c where c.n % 10 in (3, 4, 5)`,
    );
    expected = sorted((await db.adminRows(`
      select r.company_id as id from public.roster r
      where r.user_id = $1 and (r.role = 'employee' or exists (select 1 from public.billing_overrides o where o.company_id = r.company_id))`, [many])).map((r) => r.id));
  });

  after(async () => {
    await db?.close();
  });

  const timed = async (sql) => {
    const start = performance.now();
    const rows = await db.as(many).rows(sql);
    return { rows, ms: performance.now() - start };
  };

  it('is told which companies\' records it reads well inside the statement timeout', async (t) => {
    await timed('select public.records_open_company_ids() as ids');
    const { rows, ms } = await timed('select public.records_open_company_ids() as ids');
    t.diagnostic(`records_open_company_ids for an account in ${COMPANIES} companies: ${ms.toFixed(0)} ms`);
    assert.deepEqual(sorted(rows[0].ids), expected);
    assert.equal(expected.length, 600);
    assert.ok(ms < BUDGET_MS, `records_open_company_ids took ${ms.toFixed(0)} ms, over ${BUDGET_MS} ms`);
  });

  it('reads its records well inside the statement timeout', async (t) => {
    const { rows, ms } = await timed('select count(*)::int as n from public.records');
    t.diagnostic(`reading the records of an account in ${COMPANIES} companies: ${ms.toFixed(0)} ms`);
    const [{ n }] = await db.adminRows('select count(*)::int as n from public.records where company_id = any ($1::uuid[])', [expected]);
    // A supervisor's company without MineMuster (3), one with it (4), and one where the account is crew (5) of every ten.
    assert.equal(n, 200);
    assert.equal(rows[0].n, n);
    assert.ok(ms < BUDGET_MS, `reading the records took ${ms.toFixed(0)} ms, over ${BUDGET_MS} ms`);
  });

  it('gets the same companies as before', async () => {
    for (const fn of ['member_company_ids', 'supervisor_company_ids', 'records_open_company_ids']) {
      const [[now], [was]] = [await db.as(many).rows(`select public.${fn}() as ids`), await db.as(many).rows(`select was.${fn}() as ids`)];
      assert.deepEqual(sorted(now.ids), sorted(was.ids), fn);
    }
    assert.deepEqual(await db.as(many).rows('select * from public.my_companies()'), await db.as(many).rows('select * from was.my_companies()'));
  });
});

describe('the caller\'s id', () => {
  let db;

  before(async () => {
    db = await startDatabase();
    // Count how often auth.uid() is asked. Only this test's own database is changed.
    await db.admin(`
      create or replace function auth.uid() returns uuid language plpgsql stable as $$
      begin
        perform set_config('test.uid_calls', (coalesce(nullif(current_setting('test.uid_calls', true), ''), '0')::int + 1)::text, false);
        return nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      end
      $$`);
  });

  after(async () => {
    await db?.close();
  });

  /** An account that is a supervisor in `n` companies, half of them with MineMuster. */
  async function inCompanies(n) {
    const account = await db.newAccount('member');
    const made = await db.adminRows(
      `insert into public.companies (name, state, join_code)
       select 'Test Pit ' || g, 'CA', public.new_join_code() from generate_series(1, $1::int) g returning id`,
      [n],
    );
    for (const [i, { id }] of made.entries()) {
      await onRoster(db, account, id, 'Ortiz', 'supervisor');
      if (i % 2 === 0) await db.admin("insert into public.billing_overrides (company_id, reason) values ($1, 'A test company')", [id]);
    }
    return { account, first: made[0].id };
  }

  async function uidCalls(account, sql, params) {
    await db.admin("select set_config('test.uid_calls', '0', false)");
    await db.as(account).rows(sql, params);
    const [{ n }] = await db.adminRows("select coalesce(nullif(current_setting('test.uid_calls', true), ''), '0')::int as n");
    return n;
  }

  it('is read a few times a call however many companies the account is in, not once for each', async () => {
    const few = await inCompanies(3);
    const lots = await inCompanies(40);
    const calls = [
      ['member_company_ids', 'select public.member_company_ids()'],
      ['supervisor_company_ids', 'select public.supervisor_company_ids()'],
      ['records_open_company_ids', 'select public.records_open_company_ids()'],
      ['my_companies', 'select * from public.my_companies()'],
      ['is_member', 'select public.is_member($1)', 'first'],
      ['is_supervisor', 'select public.is_supervisor($1)', 'first'],
      ['a read of the records', 'select count(*) from public.records'],
    ];
    for (const [label, sql, arg] of calls) {
      const forFew = await uidCalls(few.account, sql, arg ? [few.first] : []);
      const forLots = await uidCalls(lots.account, sql, arg ? [lots.first] : []);
      assert.equal(forLots, forFew, `${label}: ${forFew} reads of the caller's id for 3 companies, ${forLots} for 40`);
      assert.ok(forLots <= 6, `${label}: ${forLots} reads of the caller's id`);
    }
  });
});
