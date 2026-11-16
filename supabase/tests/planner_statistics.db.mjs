// Row level security hides rows, not the planner's statistics. With ordinary
// ANALYZE statistics (most common values, histograms) PostgreSQL estimates a
// query a caller writes from rows the caller cannot read, in every company.
// PostgREST hands that estimate to any signed-in caller as the count of a
// request with `Prefer: count=planned` (supabase-js: { count: 'planned' }).
// So an estimate must say nothing about another company: its id, how many
// people it has, or the names on its roster. The tables keep no column
// statistics (migration 20261116002200), so every estimate is the planner's
// fixed default.
//
// All names are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addToRoster, newMember, nobody, startCompany, startDatabase } from './harness.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let db;
let a;
let b;
let others;
let employeeA;
let loner;

const lit = (uuid) => {
  assert.match(uuid, UUID);
  return `'${uuid}'::uuid`;
};

const toUuid = (n) => {
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The planner's row estimate for a query an account writes, run as that account. */
async function planned(account, table, where) {
  const [row] = await db.as(account).rows(`explain (format json) select 1 from public.${table} where ${where}`);
  const plan = row['QUERY PLAN'];
  return (Array.isArray(plan) ? plan : JSON.parse(plan))[0].Plan['Plan Rows'];
}

/**
 * Bisect `column < X` over the whole uuid range. Wherever the estimate steps,
 * X has just passed a value held in the statistics, which is a real id. Gives
 * up after `limit` estimates; returns the ids found.
 */
async function idsFromEstimates(account, table, column, limit = 2000) {
  const values = new Map();
  const at = async (n) => {
    if (!values.has(n)) values.set(n, await planned(account, table, `${column} < ${lit(toUuid(n))}`));
    return values.get(n);
  };
  const found = new Set();
  const stack = [[0n, (1n << 128n) - 1n]];
  while (stack.length && values.size < limit) {
    const [lo, hi] = stack.pop();
    if ((await at(lo)) === (await at(hi))) continue;
    if (hi - lo === 1n) {
      found.add(toUuid(lo));
      continue;
    }
    const mid = (lo + hi) / 2n;
    stack.push([lo, mid], [mid, hi]);
  }
  return found;
}

before(async () => {
  db = await startDatabase();
  // The caller's own small company.
  a = await startCompany(db, { name: 'Test Pit A', roster: [{ first: 'Riley J', last: 'Quinn' }] });
  employeeA = await newMember(db, a, 'Riley', 'Quinn');
  loner = await db.newAccount('loner');

  // Companies the caller has nothing to do with, of different sizes. B has twelve people named Sterne.
  b = await startCompany(db, { name: 'Test Pit B', state: 'NV', supervisor: ['Ana', 'Diaz'] });
  for (let i = 0; i < 40; i += 1) {
    const first = `Kit${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
    await addToRoster(db, b.owner, b.id, { first, last: i < 12 ? 'Sterne' : `Marlow${i}` });
  }
  others = [];
  for (const [name, size] of [['Test Pit C', 15], ['Test Pit D', 8], ['Test Pit E', 4]]) {
    const c = await startCompany(db, { name, supervisor: ['Jo', 'Vale'] });
    for (let i = 0; i < size; i += 1) await addToRoster(db, c.owner, c.id, { first: 'Bo', last: `Lark${i}` });
    others.push(c.id);
  }

  // What autovacuum does on a live project once enough rows have changed.
  await db.admin('analyze');
});
after(async () => {
  await db?.close();
});

describe('planner estimates seen by a member of company A', () => {
  it('say nothing about how many people company B has', async () => {
    const forB = await planned(employeeA, 'roster', `company_id = ${lit(b.id)}`);
    const forNobody = await planned(employeeA, 'roster', `company_id = ${lit(nobody())}`);
    assert.equal(forB, forNobody, `the estimate for company B (${forB}) differs from one for an id nobody has (${forNobody})`);
  });

  it('say nothing about which last names other companies have', async () => {
    const sterne = await planned(employeeA, 'roster', "last_name = 'Sterne'");
    const unused = await planned(employeeA, 'roster', "last_name = 'Unusedname'");
    assert.equal(sterne, unused, `the estimate for Sterne (${sterne}) differs from one for a name nobody has (${unused})`);
  });

  it('do not hand over the ids of other companies', async () => {
    const found = await idsFromEstimates(employeeA, 'roster', 'company_id');
    const leaked = [b.id, ...others].filter((id) => found.has(id));
    assert.deepEqual(leaked, [], `${leaked.length} other company ids came out of the estimates`);
  });
});

describe('planner estimates seen by an account in no company', () => {
  it('do not hand over company ids either', async () => {
    const found = await idsFromEstimates(loner, 'companies', 'id');
    const leaked = [a.id, b.id, ...others].filter((id) => found.has(id));
    assert.deepEqual(leaked, [], `${leaked.length} company ids came out of the estimates`);
  });
});
