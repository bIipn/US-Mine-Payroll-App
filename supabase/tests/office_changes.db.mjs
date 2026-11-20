// What the office changes reach the phones through (migration 20261120000100): read_shared_records
// hands a member the company's settings, roster, fleet and area sheets by seq, without people's
// payroll IDs unless the member is a supervisor; members no longer read people through the table;
// push_records keeps those four kinds in the shape the phones read, writes them only on top of the
// version a change was made from, and never keeps a unit better than the company's open maintenance
// requests on it.
//
// Made-up people, units and areas; the companies are "Test Pit A" to "Test Pit F". The good and bad
// records are the ones the phones' own rules are held to (src/domain/__tests__/fixtures/sharedRecords.json).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { NOT_FOUND, newMember, refused, secondSupervisor, startCompany, startDatabase } from './harness.mjs';

const FIXTURES = JSON.parse(readFileSync(new URL('../../src/domain/__tests__/fixtures/sharedRecords.json', import.meta.url), 'utf8'));
const DELETED = 'deleted';
const SHARED = ['settings', 'employee', 'equipment', 'areaSheet'];
const NOT_ACTIVE = 'PT402';

let db;
let a; // Test Pit A: supervisor Sam Ortiz (boss)
let b; // Test Pit B: supervisor Ana Diaz
let boss;
let deputy; // a second supervisor of A
let riley; // crew of A
let bo; // crew of A, taken off the roster in one test
let outsider; // in no company

before(async () => {
  db = await startDatabase();
  a = await startCompany(db, {
    name: 'Test Pit A',
    state: 'NV',
    roster: [
      { first: 'Riley J', last: 'Quinn' },
      { first: 'Bo', last: 'Lark' },
    ],
  });
  boss = a.owner;
  riley = await newMember(db, a, 'Riley', 'Quinn');
  bo = await newMember(db, a, 'Bo', 'Lark');
  deputy = await secondSupervisor(db, a, 'Dee', 'Hale');
  b = await startCompany(db, { name: 'Test Pit B', state: 'NV', supervisor: ['Ana', 'Diaz'] });
  outsider = await db.newAccount('outsider');
});
after(async () => {
  await db?.close();
});

// ---- Helpers ----------------------------------------------------------------------------------------

/** A record's version, as a phone makes it: 20 hex characters of a hash. */
const revOf = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);

let made = 0;
const newId = (prefix) => `${prefix}_${(made += 1).toString(36)}`;

/** A change as changesToSend makes it: a null record is a deletion; base is the version the change was made from. */
function change(kind, id, record, base) {
  return { key: `${kind}:${id}`, kind, id, rev: record === null ? DELETED : revOf(record), ...(base ? { base } : null), record };
}

/** The same content under a version name chosen by the test. */
const named = (c, rev) => ({ ...c, rev });

const T = 1763300000000;

const personOf = (id, extra = {}) => ({ id, firstName: 'Lee', lastName: 'Park', role: 'employee', active: true, ...extra });
const unitOf = (id, extra = {}) => ({ id, unit: 'T-14', category: 'haul_truck', make: 'Made-up', model: 'HX 40', status: 'ready', meter: 1200, meterUnit: 'hrs', ...extra });
const sheetOf = (id, extra = {}) => ({ id, title: 'Wash bay', rows: [{ id: 'r1', label: 'Walkways' }], active: true, ...extra });
const settingsOf = (extra = {}) => ({ company: { name: 'Test Pit A', state: 'NV', pay: null }, site: null, workweekStartsOn: 0, allowSectionAllOk: false, ...extra });
const shiftOf = (id) => ({ id, employeeId: 'emp_riley', clockIn: { at: T }, lunches: [], breaks: [] });
/** A maintenance request as createMrf makes it: open, assigned to nobody. */
const mrfOf = (id, equipmentId, extra = {}) => ({
  id,
  number: 1001,
  requestedBy: 'emp_riley',
  createdAt: T,
  equipmentId,
  description: 'Soft brake pedal',
  priority: 'safety',
  items: [],
  taggedOut: true,
  status: 'open',
  history: [{ at: T, by: 'emp_riley', status: 'open' }],
  ...extra,
});
const completed = (mrf) => ({
  ...mrf,
  status: 'completed',
  completedAt: T + 3600000,
  completedBy: 'emp_sam',
  remarks: 'Brakes bled and adjusted',
  history: [...mrf.history, { at: T + 3600000, by: 'emp_sam', status: 'completed' }],
});

function push(account, changes, companyId = a.id) {
  return db.as(account).call('push_records', { company_id: companyId, changes: JSON.stringify(changes) });
}

function read(account, companyId = a.id, after = 0, max = 200) {
  return db.as(account).callRows('read_shared_records', { company_id: companyId, after, max });
}

async function stored(kind, id, companyId = a.id) {
  const [row] = await db.adminRows('select * from public.records where company_id = $1 and kind = $2 and id = $3', [companyId, kind, id]);
  return row;
}

async function versions(kind, id, companyId = a.id) {
  return db.adminRows('select * from public.record_history where company_id = $1 and kind = $2 and id = $3 order by version', [companyId, kind, id]);
}

/** Sends changes and checks every one was taken. */
async function taken(account, changes, companyId = a.id) {
  const list = Array.isArray(changes) ? changes : [changes];
  const result = await push(account, list, companyId);
  assert.deepEqual(result.ignored, [], `set aside: ${JSON.stringify(result.ignored)}`);
  assert.equal(result.accepted.length, list.length);
  return changes;
}

/** Sends one change and checks it was set aside with this reason, and that nothing was written. */
async function setAside(account, c, reason, companyId = a.id) {
  const before = await versions(c.kind, c.id, companyId);
  const result = await push(account, [c], companyId);
  assert.deepEqual(result.accepted, [], `${c.key} was taken`);
  assert.equal(result.ignored.length, 1);
  assert.equal(result.ignored[0].reason, reason, JSON.stringify(result.ignored[0]));
  assert.deepEqual(await versions(c.kind, c.id, companyId), before, `${c.key}: nothing is written`);
  return result.ignored[0];
}

/** The version the server holds now, as a phone that took it would send it as its base; none for a record it does not have. */
async function baseOf(kind, id, companyId = a.id) {
  const row = await stored(kind, id, companyId);
  return row && !row.deleted ? row.rev : undefined;
}

// ---- The read -----------------------------------------------------------------------------------------

describe('the phones read the four kinds through read_shared_records', () => {
  it('gives a crew member and a supervisor the four kinds by seq, deletions included, and nothing of another company', async () => {
    const lee = newId('emp');
    const unit = newId('eq');
    const gone = newId('eq');
    const sheet = newId('sheet');
    const shift = newId('sh');
    await taken(boss, [
      change('settings', 'company', settingsOf()),
      change('employee', lee, personOf(lee, { payrollId: '004417' })),
      change('equipment', unit, unitOf(unit)),
      change('areaSheet', sheet, sheetOf(sheet)),
    ]);
    await taken(riley, change('shift', shift, shiftOf(shift)));
    const listed = await taken(boss, change('equipment', gone, unitOf(gone, { unit: 'T-15' })));
    await taken(boss, change('equipment', gone, null, listed.rev));
    const other = newId('eq');
    await taken(b.owner, change('equipment', other, unitOf(other)), b.id);

    for (const account of [riley, boss]) {
      const rows = await read(account);
      assert.ok(rows.length >= 5);
      assert.ok(rows.every((r) => SHARED.includes(r.kind)), 'only the four kinds');
      assert.deepEqual(rows.map((r) => Number(r.seq)), [...rows.map((r) => Number(r.seq))].sort((x, y) => x - y), 'in seq order');
      assert.ok(!rows.some((r) => r.id === other), 'nothing of Test Pit B');
      assert.ok(!rows.some((r) => r.id === shift), 'no shift');
      const removed = rows.find((r) => r.id === gone);
      assert.deepEqual({ deleted: removed.deleted, rev: removed.rev, data: removed.data }, { deleted: true, rev: DELETED, data: {} });
      const person = rows.find((r) => r.kind === 'employee' && r.id === lee);
      assert.equal(person.rev, (await stored('employee', lee)).rev, "the server's version of the whole record");
      if (account === riley) assert.deepEqual(person.data, personOf(lee), 'no payroll ID for a crew member');
      else assert.deepEqual(person.data, personOf(lee, { payrollId: '004417' }), 'the payroll ID for a supervisor');
    }

    // After a cursor, only what came later.
    const all = await read(riley);
    const cut = Number(all[2].seq);
    assert.deepEqual((await read(riley, a.id, cut)).map((r) => r.id), all.slice(3).map((r) => r.id));
    assert.deepEqual(await read(riley, a.id, Number(all.at(-1).seq)), [], 'an empty page once caught up');
  });

  it('lets a crew member read no person through the table, and no payroll ID anywhere', async () => {
    const lee = newId('emp');
    const first = await taken(boss, change('employee', lee, personOf(lee, { payrollId: '1100' })));
    await taken(boss, change('employee', lee, personOf(lee, { payrollId: '1101', title: 'Loader operator' }), first.rev));
    for (const table of ['records', 'record_history']) {
      assert.deepEqual(await db.as(riley).rows(`select id from public.${table} where kind = 'employee'`), [], `${table}: no person`);
      assert.deepEqual(await db.as(riley).rows(`select id from public.${table} where data::text like '%payrollId%'`), [], `${table}: no payroll ID`);
      assert.ok((await db.as(boss).rows(`select id from public.${table} where kind = 'employee' and id = $1`, [lee])).length >= 1, `${table}: a supervisor still reads people`);
    }
    // The rest of what the crew works from is still read through the table.
    assert.ok((await db.as(riley).rows("select id from public.records where kind in ('equipment', 'areaSheet', 'settings')")).length >= 3);
  });

  it('refuses an account that is not a member of the company, as push_records does', async () => {
    await refused(read(outsider), NOT_FOUND, /No such company/);
    await refused(read(b.owner), NOT_FOUND, /No such company/);
    await refused(read(riley, null), NOT_FOUND, /No such company/);
    await refused(db.noAccount().callRows('read_shared_records', { company_id: a.id, after: 0, max: 10 }), '42501', /Sign in first/);
  });

  it('refuses a member taken off the roster', async () => {
    assert.ok((await read(bo)).length > 0);
    await db.as(boss).query('update public.roster set active = false where id = $1', [a.rows['Bo Lark']]);
    await refused(read(bo), NOT_FOUND, /No such company/);
  });

  it('tells a supervisor of a company without MineMuster so, and still gives its crew the records', async () => {
    const c = await startCompany(db, { name: 'Test Pit C', state: 'NV', supervisor: ['Cal', 'Nunez'], roster: [{ first: 'Jo', last: 'Vale' }], comped: false });
    const jo = await newMember(db, c, 'Jo', 'Vale');
    const unit = newId('eq');
    await taken(c.owner, change('equipment', unit, unitOf(unit)), c.id);
    await refused(read(c.owner, c.id), NOT_ACTIVE, /not active/);
    assert.deepEqual((await read(jo, c.id)).map((r) => r.id), [unit]);
  });

  it('gives at most 500 rows a call, at least one, and 200 when no size is asked for', async () => {
    const d = await startCompany(db, { name: 'Test Pit D', state: 'NV', supervisor: ['Dov', 'Reyes'] });
    await db.admin(
      `insert into public.records (company_id, kind, id, rev, data, seq, created_by, created_by_supervisor, updated_by)
       select $1, 'equipment', 'eq_bulk_' || g, 'r' || g, jsonb_build_object('id', 'eq_bulk_' || g), g, $2, true, $2
       from generate_series(1, 600) as g`,
      [d.id, d.owner],
    );
    assert.equal((await read(d.owner, d.id, 0, 1000)).length, 500);
    assert.equal((await read(d.owner, d.id, 0, 0)).length, 1);
    assert.equal((await db.as(d.owner).callRows('read_shared_records', { company_id: d.id, after: null, max: null })).length, 200);
    assert.equal((await read(d.owner, d.id, 550, 500)).length, 50);
  });

  it('reads through records_shared_seq, past a year of records of the other kinds', async () => {
    const e = await startCompany(db, { name: 'Test Pit E', state: 'NV', supervisor: ['Eve', 'Moss'] });
    await db.admin(
      `insert into public.records (company_id, kind, id, rev, data, seq, created_by, created_by_supervisor, updated_by)
       select $1, case when g % 100 = 0 then 'equipment' else 'shift' end, 'r_' || g, 'r' || g, '{}'::jsonb, g, $2, true, $2
       from generate_series(1, 20000) as g`,
      [e.id, e.owner],
    );
    await db.admin('analyze public.records');
    const [{ 'QUERY PLAN': plan }] = await db.adminRows(
      `explain (format json)
       select r.kind, r.id, r.rev, r.seq, r.deleted, r.data
       from public.records r
       where r.company_id = '${e.id}'
         and r.kind in ('settings', 'employee', 'equipment', 'areaSheet')
         and r.seq > 0
       order by r.seq
       limit 200`,
    );
    assert.match(JSON.stringify(plan), /records_shared_seq/);
  });
});

// ---- The shape the phones read ------------------------------------------------------------------------

describe('push_records keeps the four kinds in the shape the phones read', () => {
  let f;
  before(async () => {
    f = await startCompany(db, { name: 'Test Pit F', state: 'NV', supervisor: ['Fay', 'Okafor'], roster: [{ first: 'Gus', last: 'Webb' }] });
  });

  it('takes every good record', async () => {
    for (const record of FIXTURES.good) {
      const base = await baseOf(record.kind, record.id, f.id);
      const c = change(record.kind, record.id, record.data, base);
      const result = await push(f.owner, [c], f.id);
      assert.deepEqual(result.ignored, [], `${record.name}: ${JSON.stringify(result.ignored)}`);
    }
  });

  it('sets every bad record aside, and writes nothing', async () => {
    for (const record of FIXTURES.bad.filter((r) => !r.phoneOnly)) {
      const base = await baseOf(record.kind, record.id, f.id);
      const entry = await setAside(f.owner, change(record.kind, record.id, record.data, base), record.serverReason ?? 'malformed', f.id);
      if (!record.serverReason) assert.match(entry.problem, /^Change 1 \S.*\.$/, record.name);
    }
  });

  it('takes the company cases only the phones and the dashboard check', async () => {
    for (const record of FIXTURES.bad.filter((r) => r.phoneOnly)) {
      const base = await baseOf(record.kind, record.id, f.id);
      const result = await push(f.owner, [change(record.kind, record.id, record.data, base)], f.id);
      assert.deepEqual(result.ignored, [], record.name);
    }
  });

  it('checks the shape from a crew member too', async () => {
    const gus = await newMember(db, f, 'Gus', 'Webb');
    const unit = newId('eq');
    const listed = await taken(f.owner, change('equipment', unit, unitOf(unit)), f.id);
    await setAside(gus, change('equipment', unit, unitOf(unit, { status: 'x' }), listed.rev), 'malformed', f.id);
    await setAside(gus, change('equipment', unit, unitOf(unit, { meter: 1e300 }), listed.rev), 'malformed', f.id);
  });
});

// ---- A unit's floor -----------------------------------------------------------------------------------

describe("a unit's status is never better than the company's open requests on it", () => {
  it('keeps a unit red-tagged while a red-tag request on it is open, from a supervisor and a crew member', async () => {
    const u = newId('eq');
    const listed = await taken(boss, change('equipment', u, unitOf(u)));
    await taken(riley, change('mrf', 'mrf_' + u, mrfOf('mrf_' + u, u)));

    for (const [account, record] of [
      [boss, unitOf(u, { model: 'HX 41' })],
      [boss, unitOf(u, { status: 'defect' })],
      [riley, unitOf(u, { meter: 1210 })],
      [riley, unitOf(u, { status: 'defect', meter: 1210 })],
    ]) {
      const entry = await setAside(account, change('equipment', u, record, listed.rev), 'open_request');
      assert.equal(entry.floor, 'out_of_service');
    }
    // Raising it is always taken.
    await taken(riley, change('equipment', u, unitOf(u, { status: 'out_of_service', meter: 1210 }), listed.rev));
  });

  it('keeps a unit marked for a defect while a request on it without a red tag is open', async () => {
    const v = newId('eq');
    const listed = await taken(boss, change('equipment', v, unitOf(v)));
    await taken(riley, change('mrf', 'mrf_' + v, mrfOf('mrf_' + v, v, { taggedOut: false, priority: 'routine' })));
    const entry = await setAside(boss, change('equipment', v, unitOf(v, { model: 'HX 41' }), listed.rev), 'open_request');
    assert.equal(entry.floor, 'defect');
    await taken(boss, change('equipment', v, unitOf(v, { status: 'defect' }), listed.rev));
  });

  it('counts a request completed earlier in the same call as completed, and not one completed later', async () => {
    const u = newId('eq');
    const tagged = await taken(boss, change('equipment', u, unitOf(u, { status: 'out_of_service' })));
    const request = await taken(riley, change('mrf', 'mrf_' + u, mrfOf('mrf_' + u, u)));
    const done = change('mrf', request.id, completed(request.record), request.rev);
    const lowered = change('equipment', u, unitOf(u), tagged.rev);

    // The unit first, then the completion: the unit is set aside, the completion taken.
    const wrongWay = await push(boss, [lowered, done]);
    assert.deepEqual(wrongWay.accepted, [{ key: done.key, rev: done.rev }]);
    assert.deepEqual(wrongWay.ignored, [{ key: lowered.key, rev: lowered.rev, reason: 'open_request', floor: 'out_of_service' }]);
    assert.equal((await stored('equipment', u)).data.status, 'out_of_service');

    // Sent again after it: taken.
    const v = newId('eq');
    const vTagged = await taken(boss, change('equipment', v, unitOf(v, { status: 'out_of_service' })));
    const vRequest = await taken(riley, change('mrf', 'mrf_' + v, mrfOf('mrf_' + v, v)));
    const vDone = change('mrf', vRequest.id, completed(vRequest.record), vRequest.rev);
    const vLowered = change('equipment', v, unitOf(v), vTagged.rev);
    assert.deepEqual(await push(boss, [vDone, vLowered]), { accepted: [{ key: vDone.key, rev: vDone.rev }, { key: vLowered.key, rev: vLowered.rev }], ignored: [] });
    assert.equal((await stored('equipment', v)).data.status, 'ready');
  });

  it('holds a new unit to the requests already open on it', async () => {
    const u = newId('eq');
    await taken(riley, change('mrf', 'mrf_' + u, mrfOf('mrf_' + u, u)));
    const entry = await setAside(boss, change('equipment', u, unitOf(u)), 'open_request');
    assert.equal(entry.floor, 'out_of_service');
    await taken(boss, change('equipment', u, unitOf(u, { status: 'out_of_service' })));
  });

  it('does not count a deleted request', async () => {
    const u = newId('eq');
    const listed = await taken(boss, change('equipment', u, unitOf(u, { status: 'out_of_service' })));
    const request = await taken(riley, change('mrf', 'mrf_' + u, mrfOf('mrf_' + u, u)));
    await taken(boss, change('mrf', request.id, null, request.rev));
    await taken(boss, change('equipment', u, unitOf(u), listed.rev));
  });
});

// ---- Versions -----------------------------------------------------------------------------------------

describe('the four kinds are written only on top of the version a change was made from', () => {
  const kinds = [
    ['employee', (id) => personOf(id), (id) => personOf(id, { title: 'Loader operator' }), (id) => personOf(id, { title: 'Haul truck driver' })],
    ['equipment', (id) => unitOf(id), (id) => unitOf(id, { model: 'HX 41' }), (id) => unitOf(id, { model: 'HX 42' })],
    ['areaSheet', (id) => sheetOf(id), (id) => sheetOf(id, { title: 'Wash bay north' }), (id) => sheetOf(id, { title: 'Wash bay south' })],
    ['settings', () => settingsOf({ workweekStartsOn: 2 }), () => settingsOf({ workweekStartsOn: 3 }), () => settingsOf({ workweekStartsOn: 4 })],
  ];

  for (const [kind, first, second, third] of kinds) {
    it(`${kind}: from the server's version taken, from an older one set aside, an earlier name for other content refused, A-B-A taken`, async () => {
      const id = kind === 'settings' ? 'company' : newId(kind);
      const zero = change(kind, id, first(id), await baseOf(kind, id));
      await taken(boss, zero);
      const one = await taken(boss, change(kind, id, second(id), zero.rev));

      // Made from an older version, by anyone.
      await setAside(deputy, change(kind, id, third(id), zero.rev), 'superseded');
      await setAside(boss, change(kind, id, third(id), zero.rev), 'superseded');
      // A removal from an older version, or with no base at all.
      if (kind !== 'settings') {
        await setAside(boss, change(kind, id, null, zero.rev), 'superseded');
        await setAside(boss, change(kind, id, null), 'superseded');
      }
      // The account's own last version sent again: taken, and nothing written.
      const before = await versions(kind, id);
      assert.deepEqual(await push(boss, [one]), { accepted: [{ key: one.key, rev: one.rev }], ignored: [] });
      assert.deepEqual(await versions(kind, id), before);

      // Other content under the name of an earlier version.
      const entry = await setAside(deputy, named(change(kind, id, third(id), one.rev), zero.rev), 'malformed');
      assert.match(entry.problem, /names a version that held other content/);

      // The server back at the very content of an earlier version, under its own name.
      await taken(deputy, change(kind, id, first(id), one.rev));
      assert.equal((await stored(kind, id)).rev, zero.rev);
    });
  }

  it('sets aside a change made from a copy the phone had before a unit or sheet was taken out, and takes it added back', async () => {
    for (const [kind, of] of [['equipment', unitOf], ['areaSheet', sheetOf]]) {
      const id = newId(kind);
      const listed = await taken(boss, change(kind, id, of(id)));
      await taken(boss, change(kind, id, null, listed.rev));
      await setAside(deputy, change(kind, id, of(id, kind === 'equipment' ? { model: 'HX 41' } : { title: 'Wash bay north' }), listed.rev), 'deleted');
      await taken(deputy, change(kind, id, of(id)));
      assert.equal((await stored(kind, id)).deleted, false);
    }
  });
});

// ---- The check to run against a server before the migration --------------------------------------------

describe('supabase/checks/shared_shapes.sql', () => {
  const check = readFileSync(new URL('../checks/shared_shapes.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/20261120000100_office_changes_reach_phones.sql', import.meta.url), 'utf8');
  /** A function's text from "(" to its closing "$$;", with the schema it is made in left out. */
  const fn = (sql, name) => {
    const start = sql.search(new RegExp(`create function (public|pg_temp)\\.${name}\\(`));
    assert.ok(start >= 0, `${name} is in the file`);
    return sql.slice(sql.indexOf('(', start), sql.indexOf('$$;', start) + 3);
  };

  it("holds the migration's own two functions, unchanged", () => {
    for (const name of ['shared_record_problem', 'unit_status_floor']) assert.equal(fn(check, name), fn(migration, name), name);
  });

  it('names a record the phones cannot read and a unit better than its open requests, and nothing else', async () => {
    const g = await startCompany(db, { name: 'Test Pit G', state: 'NV', supervisor: ['Gil', 'Ames'] });
    const good = newId('eq');
    await taken(g.owner, change('equipment', good, unitOf(good)), g.id);
    // Written the way rows were before the migration: straight into the table.
    await db.admin(
      `insert into public.records (company_id, kind, id, rev, data, seq, created_by, created_by_supervisor, updated_by)
       values ($1, 'areaSheet', 'old-sheet', 'r1', '{"id": "old-sheet", "name": "Wash plant"}', 9001, $2, true, $2),
              ($1, 'mrf', 'mrf_old', 'r2', $3, 9002, $2, true, $2)`,
      [g.id, g.owner, JSON.stringify(mrfOf('mrf_old', good))],
    );
    const results = await db.pg.exec(check);
    const [shapes, floors] = results.slice(-2).map((r) => r.rows.filter((row) => row.company_id === g.id));
    assert.deepEqual(shapes, [{ company_id: g.id, kind: 'areaSheet', id: 'old-sheet', problem: 'is a sheet with no name' }]);
    assert.deepEqual(floors, [{ company_id: g.id, id: good, unit: 'T-14', status: 'ready', floor: 'out_of_service' }]);
    // What the check made is in this session's temporary schema, and goes with the session.
    const made = await db.adminRows(
      "select n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname in ('shared_record_problem', 'unit_status_floor') and n.nspname <> 'public'",
    );
    assert.equal(made.length, 2);
    assert.ok(made.every((m) => m.nspname.startsWith('pg_temp')), JSON.stringify(made));
  });
});
