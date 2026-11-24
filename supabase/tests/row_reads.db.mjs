// Row level security hides rows; it must not read them either. If each policy
// calls a function on every row a scan meets, a request that does not filter
// on its own company reads every company's rows, and one that filters on a
// column (company_id = X, last_name = Y, company_id < X) takes longer the more
// hidden rows of other companies fit the filter. Then response times alone
// tell any signed-in account a real company id from a made-up one and roughly
// how many people it has, confirm a surname on another company's roster, and
// give up other companies' ids to anyone who bisects a range: what the
// planner's estimates no longer say (planner_statistics.db.mjs). So every
// policy compares the row's company with the caller's own companies, worked out
// once per statement, as an index condition (migration 20261116002300).
//
// The timing tests compare medians of interleaved requests, with wide margins:
// before the fix each one was several times slower for company B.
//
// All names are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { newMember, nobody, startCompany, startDatabase } from './harness.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let db;
let a;
let b;
let employeeA;
let loner;

const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

const toUuid = (n) => {
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

before(async () => {
  db = await startDatabase();
  a = await startCompany(db, { name: 'Test Pit A', roster: [{ first: 'Riley J', last: 'Quinn' }] });
  employeeA = await newMember(db, a, 'Riley', 'Quinn');
  loner = await db.newAccount('loner');

  // Company B has 300 people, 200 of them named Sterne.
  b = await startCompany(db, { name: 'Test Pit B', state: 'NV', supervisor: ['Ana', 'Diaz'] });
  await db.admin(
    `insert into public.roster (company_id, first_name, last_name)
     select $1, 'Kit' || g, case when g <= 200 then 'Sterne' else 'Marlow' || g end from generate_series(1, 300) g`,
    [b.id],
  );
  // And 500 more companies of five people each, so a scan of every company's rows shows.
  await db.admin(`
    insert into public.companies (name, state, join_code)
    select 'Test Pit Z' || g, 'CA', public.new_join_code() from generate_series(1, 500) g`);
  await db.admin(`
    insert into public.roster (company_id, first_name, last_name)
    select c.id, 'Bo' || g, 'Lark' || g from public.companies c, generate_series(1, 5) g where c.name like 'Test Pit Z%'`);
  // What autovacuum does on a live project once enough rows have changed.
  await db.admin('analyze');
});
after(async () => {
  await db?.close();
});

/** The plan of a query an account writes, run as that account. */
async function planOf(account, sql, params) {
  const [row] = await db.as(account).rows(`explain (analyze, format json, costs off, timing off, summary off) ${sql}`, params);
  const plan = row['QUERY PLAN'];
  return (Array.isArray(plan) ? plan : JSON.parse(plan))[0].Plan;
}

/** Every node of a plan, its subplans included. */
function nodesOf(node, into = []) {
  into.push(node);
  for (const child of node.Plans ?? []) nodesOf(child, into);
  return into;
}

/** How many rows the plan read and then threw away, and every condition it applied. */
function readOf(plan) {
  const nodes = nodesOf(plan);
  const removed = nodes.reduce((n, node) => n + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0), 0);
  const conditions = nodes.flatMap((node) => ['Filter', 'Index Cond', 'Recheck Cond', 'Join Filter'].map((key) => node[key]).filter(Boolean));
  return { removed, conditions, scanned: nodes.filter((node) => /Scan$/.test(node['Node Type'])).reduce((n, node) => n + node['Actual Rows'], 0) };
}

describe('what a request reads of rows the caller cannot see', () => {
  const READS = {
    'an employee of A reads the roster': () => [employeeA, 'select * from public.roster'],
    'an employee of A reads the companies': () => [employeeA, 'select * from public.companies'],
    'an account in no company reads the roster': () => [loner, 'select * from public.roster'],
    'an account in no company reads the companies': () => [loner, 'select * from public.companies'],
  };
  for (const [what, make] of Object.entries(READS)) {
    it(`is nothing: ${what} without a filter, and no row of another company is read`, async () => {
      const [account, sql] = make();
      const { removed, conditions } = await planOf(account, sql).then(readOf);
      assert.equal(removed, 0, `${removed} rows of other companies were read and thrown away (${conditions.join('; ')})`);
    });
  }

  it('is nothing when the filter names another company: none of its rows is read', async () => {
    const { removed, scanned, conditions } = readOf(await planOf(employeeA, 'select id from public.roster where company_id = $1', [b.id]));
    assert.equal(removed + scanned, 0, `${removed + scanned} of company B's rows were read (${conditions.join('; ')})`);
  });

  it('never calls a function on each row: the caller\'s companies are worked out once per statement', async () => {
    const supervisorA = a.owner;
    for (const [account, table] of [
      [employeeA, 'roster'],
      [employeeA, 'companies'],
      [supervisorA, 'roster'],
      [supervisorA, 'join_requests'],
      [supervisorA, 'notifications'],
      [loner, 'roster'],
    ]) {
      const { conditions } = readOf(await planOf(account, `select * from public.${table}`));
      for (const condition of conditions) assert.doesNotMatch(condition, /is_member|is_supervisor/, `${table}: ${condition}`);
    }
  });

  it('still lets each account read and change exactly what it did', async () => {
    assert.deepEqual((await db.as(employeeA).rows('select company_id from public.roster group by company_id')).map((r) => r.company_id), [a.id]);
    assert.deepEqual(await db.as(loner).rows('select id from public.roster'), []);
    assert.equal((await db.as(b.owner).rows('select count(*)::int as n from public.roster'))[0].n, 301);
    assert.equal(await db.as(employeeA).affected("update public.roster set title = 'Crusher' where company_id = $1", [b.id]), 0);
    assert.equal(await db.as(b.owner).affected("update public.roster set title = 'Crusher' where first_name = 'Kit1'"), 1);
  });
});

/**
 * Median times of the same request with two sets of parameters, run in turn so
 * that a slow moment of the machine falls on both. Fails if any row of company B
 * comes back: what is measured is time alone.
 */
async function timesOf(account, sql, first, second, runs = 31) {
  const as = db.as(account);
  const timed = async (params) => {
    const start = performance.now();
    const rows = await as.rows(sql, params);
    const ms = performance.now() - start;
    for (const row of rows) assert.notEqual(row.company_id, b.id, 'a row of company B came back');
    return ms;
  };
  for (let i = 0; i < 3; i += 1) {
    await timed(first);
    await timed(second);
  }
  const [x, y] = [[], []];
  for (let i = 0; i < runs; i += 1) {
    if (i % 2) {
      x.push(await timed(first));
      y.push(await timed(second));
    } else {
      y.push(await timed(second));
      x.push(await timed(first));
    }
  }
  return [median(x), median(y)];
}

describe('how long a request takes, for a member of company A', () => {
  it('does not depend on how many people company B has', async () => {
    const [forB, forNobody] = await timesOf(employeeA, 'select id, company_id from public.roster where company_id = $1', [b.id], [nobody()]);
    assert.ok(forB < forNobody * 1.5, `B's id takes ${forB.toFixed(3)} ms, an id nobody has ${forNobody.toFixed(3)} ms`);
  });

  it('does not depend on whether other companies have a surname', async () => {
    const [sterne, unused] = await timesOf(employeeA, 'select id, company_id from public.roster where last_name = $1', ['Sterne'], ['Unusedname']);
    assert.ok(sterne < unused * 1.5, `Sterne takes ${sterne.toFixed(3)} ms, a name nobody has ${unused.toFixed(3)} ms`);
  });
});

describe('an account in no company, timing range filters', () => {
  it("does not recover the leading bits of company B's id", async () => {
    assert.match(b.id, UUID);
    const sql = 'select id, company_id from public.roster where company_id >= $1 and company_id < $2';
    let lo = 0n;
    let hi = 1n << 128n;
    for (let step = 0; step < 16; step += 1) {
      const mid = (lo + hi) / 2n;
      const [left, right] = await timesOf(loner, sql, [toUuid(lo), toUuid(mid)], [toUuid(mid), toUuid(hi - 1n)], 15);
      if (left > right) hi = mid;
      else lo = mid;
    }
    assert.notEqual(toUuid(lo).slice(0, 4), b.id.slice(0, 4), `the first four hex digits of company B's id (${b.id}) came out of the timings`);
  });
});
