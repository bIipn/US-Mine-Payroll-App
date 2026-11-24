// The records the crew's phones share (migrations 20261117000100 to 0300):
// push_records takes what a phone sends, each kind is written and read only by
// whom it should be, and record_history keeps every version as it was sent.
// What push_records checks inside a change (copies, stale versions, what a
// member may change in a record, resends, bounds and seq) is in
// record_rules.db.mjs.
//
// A change is shaped the way src/domain/sync.ts makes it: { key, kind, id,
// rev, base?, record }, with rev 'deleted' and record null for a record taken
// off the phone.
//
// All names and records are made up. The companies are "Test Pit A", "Test
// Pit B" and "Test Pit C".

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  addToRoster,
  BAD_INPUT,
  join,
  newMember,
  NO_PRIVILEGE,
  nobody,
  NOT_FOUND,
  NOT_SIGNED_IN,
  refused,
  secondSupervisor,
  startCompany,
  startDatabase,
} from './harness.mjs';

const DELETED = 'deleted';
const KINDS = ['settings', 'employee', 'equipment', 'areaSheet', 'shift', 'denied', 'leave', 'inspection', 'opLog', 'exam', 'mrf'];
// What every member reads through the table. People are read by a supervisor only; the crew gets the
// roster, without payroll IDs, through read_shared_records (migration 20261120000100).
const SHARED_KINDS = ['settings', 'equipment', 'areaSheet', 'inspection', 'opLog', 'exam', 'mrf'];

let db;
let a; // Test Pit A: supervisor Sam Ortiz
let b; // Test Pit B: supervisor Ana Diaz
let supervisorA;
let employeeA; // Riley J Quinn
let coworkerA; // Maria De La Cruz
let deputyA; // a second supervisor of A, Dee Hale
let supervisorB;
let outsider; // an account in no company

before(async () => {
  db = await startDatabase();
  a = await startCompany(db, {
    name: 'Test Pit A',
    roster: [
      { first: 'Riley J', last: 'Quinn' },
      { first: 'Maria', last: 'De La Cruz' },
      { first: 'Bo', last: 'Lark' },
      { first: 'Jo', last: 'Vale' },
      { first: 'Kit', last: 'Marlow' },
    ],
  });
  supervisorA = a.owner;
  employeeA = await newMember(db, a, 'Riley', 'Quinn');
  coworkerA = await newMember(db, a, 'Maria', 'De La Cruz');
  deputyA = await secondSupervisor(db, a, 'Dee', 'Hale');
  b = await startCompany(db, { name: 'Test Pit B', state: 'NV', supervisor: ['Ana', 'Diaz'] });
  supervisorB = b.owner;
  outsider = await db.newAccount('outsider');
});
after(async () => {
  await db?.close();
});

// ---- Helpers ----------------------------------------------------------------------------------------

/** The version of a record, the way a phone makes one: a hash of it, 20 hex characters. */
const revOf = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);

let made = 0;
/** A fresh id, like the phone's own. */
const newId = (kind) => `${kind}-${(made += 1)}`;

/** A change as changesToSend makes it. A null record is a deletion. */
function change(kind, id, record, base) {
  return { key: `${kind}:${id}`, kind, id, rev: record === null ? DELETED : revOf(record), ...(base ? { base } : null), record };
}

/** A made-up record of a kind. */
function recordOf(kind, id, extra = {}) {
  const shapes = {
    // The four kinds every phone reads are in the shape the phones read them (migration 20261120000100).
    settings: { company: { name: 'Test Pit A', state: 'CA' }, site: null, workweekStartsOn: 0, allowSectionAllOk: false },
    employee: { id, firstName: 'Lee', lastName: 'Park', role: 'employee', active: true },
    equipment: { id, unit: 'T-14', category: 'haul_truck', make: 'Made-up', model: 'HX 40', status: 'ready', meter: 1200, meterUnit: 'hrs' },
    areaSheet: { id, title: 'Wash plant', rows: [{ id: 'r1', label: 'Walkways' }, { id: 'r2', label: 'Guards' }], active: true },
    shift: { id, employeeId: 'emp-1', clockIn: 1763300000000, clockOut: null, edits: [] },
    denied: { id, employeeId: 'emp-1', at: 1763300000000, reason: 'outside the boundary' },
    leave: { id, employeeId: 'emp-1', day: '2026-11-11', kind: 'holiday', hours: 800 },
    inspection: { id, equipmentId: 'eq-1', answers: { 1: 'ok' }, signedAt: 1763300000000 },
    opLog: { id, equipmentId: 'eq-1', hoursStart: 1200, hoursEnd: 1208 },
    exam: { id, sheetId: 'sheet-1', shift: 'day', rows: [{ line: 'Walkways', answer: 'ok' }] },
    mrf: { id, number: 1001, problem: 'Loose guard', status: 'open' },
  };
  const record = { ...shapes[kind], ...extra };
  if (kind === 'settings') delete record.id;
  return record;
}

/** push_records as an account. */
function push(account, companyId, changes) {
  return db.as(account).call('push_records', { company_id: companyId, changes: JSON.stringify(changes) });
}

/** push_records with the changes as raw JSON text, for shapes JSON.stringify would not make. */
function pushRaw(account, companyId, json) {
  return db.as(account).rows('select public.push_records(company_id => $1, changes => $2::text::jsonb) as result', [companyId, json]);
}

/** The stored row, as the owner sees it, or undefined. */
async function stored(companyId, kind, id) {
  const [row] = await db.adminRows('select * from public.records where company_id = $1 and kind = $2 and id = $3', [companyId, kind, id]);
  return row;
}

/** Every version of a record, oldest first. */
function versions(companyId, kind, id) {
  return db.adminRows('select * from public.record_history where company_id = $1 and kind = $2 and id = $3 order by version', [companyId, kind, id]);
}

/** Every record and version of a company, as the owner sees them. */
async function snapshot(companyId) {
  return {
    records: await db.adminRows('select * from public.records where company_id = $1 order by kind, id', [companyId]),
    history: await db.adminRows('select * from public.record_history where company_id = $1 order by kind, id, version', [companyId]),
  };
}

/** What an account reads of a company's records: "kind:id" keys, sorted. */
async function keysReadBy(account, table = 'records') {
  return (await db.as(account).rows(`select kind, id from public.${table}`)).map((r) => `${r.kind}:${r.id}`).sort();
}

const accepted = (...changes) => changes.map((c) => ({ key: c.key, rev: c.rev }));
const ignoredAs = (reason, ...changes) => changes.map((c) => ({ key: c.key, rev: c.rev, reason }));

/** A record an account has sent, made fresh for one test. */
async function sent(account, kind, extra = {}) {
  const id = kind === 'settings' ? 'company' : newId(kind);
  const record = recordOf(kind, id, extra);
  // There is one settings record: a change to it is made from the version the server has.
  const base = kind === 'settings' ? (await stored(a.id, kind, id))?.rev : undefined;
  const c = change(kind, id, record, base);
  const result = await push(account, a.id, [c]);
  assert.deepEqual(result.ignored, [], `${kind} was not taken`);
  return { id, record, change: c };
}

// ---- Sending ----------------------------------------------------------------------------------------

describe('sending records', () => {
  it('a member sends a record, and reads it back as it was sent', async () => {
    const id = newId('shift');
    const record = recordOf('shift', id);
    const c = change('shift', id, record);
    assert.deepEqual(await push(employeeA, a.id, [c]), { accepted: accepted(c), ignored: [] });

    const [row] = await db.as(employeeA).rows('select * from public.records where kind = $1 and id = $2', ['shift', id]);
    assert.equal(row.company_id, a.id);
    assert.equal(row.rev, c.rev);
    assert.deepEqual(row.data, record);
    assert.equal(row.deleted, false);
    assert.equal(row.version, 1);
    assert.equal(row.created_by, employeeA);
    assert.equal(row.updated_by, employeeA);

    const history = await versions(a.id, 'shift', id);
    assert.equal(history.length, 1);
    assert.deepEqual(
      { version: history[0].version, rev: history[0].rev, base: history[0].base, data: history[0].data, deleted: history[0].deleted, by: history[0].by },
      { version: 1, rev: c.rev, base: null, data: record, deleted: false, by: employeeA },
    );
  });

  it('sending the same change twice writes it once, and both are accepted', async () => {
    const id = newId('exam');
    const c = change('exam', id, recordOf('exam', id));
    assert.deepEqual(await push(employeeA, a.id, [c]), { accepted: accepted(c), ignored: [] });
    const first = await stored(a.id, 'exam', id);
    assert.deepEqual(await push(employeeA, a.id, [c]), { accepted: accepted(c), ignored: [] });
    // Twice in one call as well.
    assert.deepEqual(await push(employeeA, a.id, [c, c]), { accepted: accepted(c, c), ignored: [] });
    assert.deepEqual(await stored(a.id, 'exam', id), first);
    assert.equal((await versions(a.id, 'exam', id)).length, 1);
  });

  it('a new version is written over the old one, and both stay in the history', async () => {
    const id = newId('mrf');
    const v1 = recordOf('mrf', id);
    const v2 = recordOf('mrf', id, { status: 'assigned', assignedTo: 'emp-2' });
    const c1 = change('mrf', id, v1);
    const c2 = change('mrf', id, v2, c1.rev);
    await push(supervisorA, a.id, [c1]);
    assert.deepEqual(await push(supervisorA, a.id, [c2]), { accepted: accepted(c2), ignored: [] });

    const row = await stored(a.id, 'mrf', id);
    assert.deepEqual([row.rev, row.data, row.version], [c2.rev, v2, 2]);
    const history = await versions(a.id, 'mrf', id);
    assert.deepEqual(history.map((h) => [h.version, h.rev, h.base, h.data]), [
      [1, c1.rev, null, v1],
      [2, c2.rev, c1.rev, v2],
    ]);
  });
});

// ---- Who may send what --------------------------------------------------------------------------------

describe('who may send records', () => {
  it('nobody outside the company, and the answer says nothing about it', async () => {
    const id = newId('shift');
    const c = change('shift', id, recordOf('shift', id));
    const before = await snapshot(a.id);
    const unknown = await refused(push(outsider, a.id, [c]), NOT_FOUND, /No such company/);
    // A supervisor of another company, and a company nobody has, get the same answer.
    assert.equal((await refused(push(supervisorB, a.id, [c]), NOT_FOUND)).message, unknown.message);
    assert.equal((await refused(push(supervisorA, nobody(), [c]), NOT_FOUND)).message, unknown.message);
    assert.equal((await refused(push(supervisorA, null, [c]), NOT_FOUND)).message, unknown.message);
    await refused(db.anon().call('push_records', { company_id: a.id, changes: JSON.stringify([c]) }), NO_PRIVILEGE, /permission denied for function push_records/);
    await refused(db.noAccount().call('push_records', { company_id: a.id, changes: JSON.stringify([c]) }), NOT_SIGNED_IN, /Sign in first/);
    assert.deepEqual(await snapshot(a.id), before);
  });

  it('nobody taken off the roster either', async () => {
    const account = await newMember(db, a, 'Bo', 'Lark');
    const { id } = await sent(account, 'shift');
    assert.ok((await keysReadBy(account)).includes(`shift:${id}`));

    await db.as(supervisorA).query('update public.roster set active = false where id = $1', [a.rows['Bo Lark']]);
    const later = change('shift', id, recordOf('shift', id, { clockOut: 1763340000000 }));
    await refused(push(account, a.id, [later]), NOT_FOUND, /No such company/);
    assert.deepEqual(await keysReadBy(account), []);
    assert.deepEqual(await keysReadBy(account, 'record_history'), []);
  });

  it("an employee's settings, roster, area sheets and paid leave are set aside: a supervisor's alone", async () => {
    const own = {};
    for (const kind of ['settings', 'employee', 'areaSheet', 'leave']) own[kind] = await sent(supervisorA, kind);
    const before = await snapshot(a.id);

    const changes = [];
    for (const kind of ['settings', 'employee', 'areaSheet', 'leave']) {
      const { id, record, change: first } = own[kind];
      changes.push(change(kind, id, { ...record, note: 'changed' }, first.rev)); // a change to the supervisor's
      changes.push(change(kind, id, null, first.rev)); // deleting it
      changes.push(first); // the version the server has
      if (kind !== 'settings') {
        const fresh = newId(kind);
        changes.push(change(kind, fresh, recordOf(kind, fresh))); // a new one
      }
    }
    // Settings are refused here as a supervisor's; a stray field would be private first.
    changes[0] = change('settings', 'company', { ...own.settings.record, workweekStartsOn: 1 }, own.settings.change.rev);

    // One at a time: a call takes one version of a record.
    for (const c of changes) {
      assert.deepEqual(await push(employeeA, a.id, [c]), { accepted: [], ignored: ignoredAs('supervisor_only', c) }, c.key);
    }
    assert.deepEqual(await snapshot(a.id), before);
  });

  it("an employee cannot change or delete another person's shift, denied punch, checklist, operating log or exam", async () => {
    const theirs = [];
    for (const kind of ['shift', 'denied', 'inspection', 'opLog', 'exam']) theirs.push({ kind, ...(await sent(coworkerA, kind)) });
    const before = await snapshot(a.id);

    const edits = theirs.map(({ kind, id, record, change: first }) => change(kind, id, { ...record, note: 'changed' }, first.rev));
    const deletions = theirs.map(({ kind, id, change: first }) => change(kind, id, null, first.rev));
    assert.deepEqual(await push(employeeA, a.id, edits), { accepted: [], ignored: ignoredAs('not_yours', ...edits) });
    // Deleting is a supervisor's, whoever sent the record.
    assert.deepEqual(await push(employeeA, a.id, deletions), { accepted: [], ignored: ignoredAs('supervisor_only', ...deletions) });
    assert.deepEqual(await snapshot(a.id), before);

    // Their own shift, they clock out of, and do not delete.
    const mine = await sent(employeeA, 'shift');
    const edit = change('shift', mine.id, { ...mine.record, clockOut: 1763340000000 }, mine.change.rev);
    const gone = change('shift', mine.id, null, edit.rev);
    assert.deepEqual(await push(employeeA, a.id, [edit]), { accepted: accepted(edit), ignored: [] });
    assert.deepEqual(await push(employeeA, a.id, [gone]), { accepted: [], ignored: ignoredAs('supervisor_only', gone) });
  });

  it('any member works a maintenance request assigned to someone, or a unit someone else sent, but does not delete one', async () => {
    const request = await sent(supervisorA, 'mrf', { assignedTo: 'emp-1' });
    const unit = await sent(supervisorA, 'equipment');
    const closing = { status: 'completed', completedAt: 1763340000000, completedBy: 'emp-1', remarks: 'Guard bolted back on' };
    const worked = change('mrf', request.id, { ...request.record, ...closing }, request.change.rev);
    const checked = change('equipment', unit.id, { ...unit.record, status: 'out_of_service', meter: 1208 }, unit.change.rev);
    assert.deepEqual(await push(employeeA, a.id, [worked, checked]), { accepted: accepted(worked, checked), ignored: [] });

    const row = await stored(a.id, 'mrf', request.id);
    assert.deepEqual([row.data.status, row.created_by, row.updated_by, row.version], ['completed', supervisorA, employeeA, 2]);

    // With nobody assigned, completing it is a supervisor's (migration 20261117000900).
    const nobodys = await sent(supervisorA, 'mrf');
    const closed = change('mrf', nobodys.id, { ...nobodys.record, ...closing }, nobodys.change.rev);
    assert.deepEqual(await push(employeeA, a.id, [closed]), { accepted: [], ignored: ignoredAs('supervisor_only', closed) });
    assert.deepEqual((await stored(a.id, 'mrf', nobodys.id)).data, nobodys.record);
    assert.equal((await stored(a.id, 'equipment', unit.id)).data.status, 'out_of_service');

    const before = await snapshot(a.id);
    const deletions = [change('mrf', request.id, null, worked.rev), change('equipment', unit.id, null, checked.rev)];
    assert.deepEqual(await push(coworkerA, a.id, deletions), { accepted: [], ignored: ignoredAs('supervisor_only', ...deletions) });
    assert.deepEqual(await snapshot(a.id), before);
  });

  it("a supervisor sends every kind, and changes or deletes anyone's", async () => {
    // The settings are on the server already: a change to them names the version it was made from.
    const settingsRev = (await stored(a.id, 'settings', 'company'))?.rev;
    const changes = KINDS.map((kind) => {
      const id = kind === 'settings' ? 'company' : newId(kind);
      return change(kind, id, recordOf(kind, id, kind === 'settings' ? { workweekStartsOn: 1 } : { note: 'from the office' }), kind === 'settings' ? settingsRev : undefined);
    });
    const result = await push(supervisorA, a.id, changes);
    assert.deepEqual(result.ignored, []);
    assert.deepEqual(result.accepted.map(({ key, rev }) => ({ key, rev })), accepted(...changes));

    const shift = await sent(coworkerA, 'shift');
    const exam = await sent(coworkerA, 'exam');
    const log = await sent(coworkerA, 'opLog');
    const own = await sent(employeeA, 'mrf');
    const fixes = [
      change('shift', shift.id, { ...shift.record, clockOut: 1763340000000, edits: [{ reason: 'Forgot to clock out' }] }, shift.change.rev),
      change('exam', exam.id, { ...exam.record, rows: [{ line: 'Walkways', answer: 'ok', fixed: '2026-11-16' }] }, exam.change.rev),
      change('opLog', log.id, null, log.change.rev),
      change('mrf', own.id, null, own.change.rev),
    ];
    assert.deepEqual(await push(supervisorA, a.id, fixes), { accepted: accepted(...fixes), ignored: [] });
    assert.equal((await stored(a.id, 'shift', shift.id)).updated_by, supervisorA);
    assert.equal((await stored(a.id, 'shift', shift.id)).created_by, coworkerA);
    assert.equal((await stored(a.id, 'opLog', log.id)).deleted, true);
  });

  it('what never leaves a phone is set aside, whoever sends it: pay rates, passwords and settings of its own', async () => {
    const before = await snapshot(a.id);
    const changes = [];
    for (const [kind, field, value] of [
      ['employee', 'payRates', { 'emp-1': 2800 }],
      ['employee', 'passwordHash', 'abc123'],
      ['employee', 'salt', 'pepper'],
      ['shift', 'rate', 2800],
      ['mrf', 'payRates', {}],
    ]) {
      const id = newId(kind);
      changes.push(change(kind, id, recordOf(kind, id, { [field]: value })));
    }
    // The phone's own settings: its reminders and preview controls.
    const ownSettings = [
      change('settings', 'company', { ...recordOf('settings', 'company'), lunchReminders: true }),
      change('settings', 'company', { company: { name: 'Test Pit A' }, demoMode: true }),
    ];

    for (const account of [supervisorA, employeeA]) {
      assert.deepEqual(await push(account, a.id, changes), { accepted: [], ignored: ignoredAs('private', ...changes) });
      for (const c of ownSettings) assert.deepEqual(await push(account, a.id, [c]), { accepted: [], ignored: ignoredAs('private', c) });
    }
    assert.deepEqual(await snapshot(a.id), before);

    // Nor does a private field get onto a record the server already has.
    const shift = await sent(employeeA, 'shift');
    const withRate = change('shift', shift.id, { ...shift.record, rate: 2800 }, shift.change.rev);
    assert.deepEqual(await push(employeeA, a.id, [withRate]), { accepted: [], ignored: ignoredAs('private', withRate) });
    assert.deepEqual((await stored(a.id, 'shift', shift.id)).data, shift.record);
  });
});

// ---- Deleting ------------------------------------------------------------------------------------------

describe('deleting a record', () => {
  it('is a supervisor\'s: it marks it deleted, empties it, and keeps every version', async () => {
    const shift = await sent(employeeA, 'shift');
    const gone = change('shift', shift.id, null, shift.change.rev);
    assert.deepEqual(gone.rev, DELETED);
    assert.deepEqual(await push(supervisorA, a.id, [gone]), { accepted: accepted(gone), ignored: [] });

    const row = await stored(a.id, 'shift', shift.id);
    assert.deepEqual([row.deleted, row.rev, row.data, row.version, row.created_by, row.updated_by], [true, DELETED, {}, 2, employeeA, supervisorA]);
    assert.deepEqual((await versions(a.id, 'shift', shift.id)).map((h) => [h.version, h.rev, h.deleted, h.data, h.base]), [
      [1, shift.change.rev, false, shift.record, null],
      [2, DELETED, true, null, shift.change.rev],
    ]);
    // The phone that sent it still reads it, deleted, so a phone can learn it is gone.
    const [read] = await db.as(employeeA).rows('select deleted, data from public.records where kind = $1 and id = $2', ['shift', shift.id]);
    assert.deepEqual(read, { deleted: true, data: {} });

    // Deleting it again changes nothing.
    assert.deepEqual(await push(supervisorA, a.id, [gone]), { accepted: accepted(gone), ignored: [] });
    assert.equal((await versions(a.id, 'shift', shift.id)).length, 2);

    // Sent again later by a supervisor, it is back, as a third version.
    const back = change('shift', shift.id, { ...shift.record, clockOut: 1763340000000 });
    const result = await push(supervisorA, a.id, [back]);
    assert.deepEqual(result, { accepted: [{ key: back.key, rev: back.rev, conflict: true }], ignored: [] });
    assert.deepEqual([(await stored(a.id, 'shift', shift.id)).deleted, (await versions(a.id, 'shift', shift.id)).length], [false, 3]);
  });

  it('of a record the server never had, writes nothing: accepted from a supervisor, set aside from anyone else', async () => {
    const gone = change('exam', newId('exam'), null, 'abcdef0123456789abcd');
    const before = await snapshot(a.id);
    assert.deepEqual(await push(supervisorA, a.id, [gone]), { accepted: accepted(gone), ignored: [] });
    assert.deepEqual(await push(employeeA, a.id, [gone]), { accepted: [], ignored: ignoredAs('supervisor_only', gone) });
    assert.deepEqual(await snapshot(a.id), before);
  });
});

// ---- Conflicts -------------------------------------------------------------------------------------------

describe('two phones changing the same record', () => {
  it('between supervisors, the latest change wins, both versions are kept, and the stale one says conflict', async () => {
    const request = await sent(employeeA, 'mrf');
    const theirs = change('mrf', request.id, { ...request.record, status: 'assigned' }, request.change.rev);
    const mine = change('mrf', request.id, { ...request.record, problem: 'Loose guard, east side' }, request.change.rev);

    assert.deepEqual(await push(deputyA, a.id, [theirs]), { accepted: accepted(theirs), ignored: [] });
    // Made from the first version, which is no longer the server's.
    assert.deepEqual(await push(supervisorA, a.id, [mine]), { accepted: [{ key: mine.key, rev: mine.rev, conflict: true }], ignored: [] });

    assert.deepEqual((await stored(a.id, 'mrf', request.id)).data, mine.record);
    assert.deepEqual((await versions(a.id, 'mrf', request.id)).map((h) => [h.rev, h.base, h.by]), [
      [request.change.rev, null, employeeA],
      [theirs.rev, request.change.rev, deputyA],
      [mine.rev, request.change.rev, supervisorA],
    ]);
  });

  it("a member's change made from a version someone else has replaced is set aside", async () => {
    // Assigned to someone, so that the crew may work it at all (migration 20261117000900).
    const request = await sent(supervisorA, 'mrf', { assignedTo: 'emp-2' });
    const theirs = change('mrf', request.id, { ...request.record, status: 'in_progress' }, request.change.rev);
    const mine = change('mrf', request.id, { ...request.record, status: 'open', remarks: 'Waiting on parts' }, request.change.rev);
    assert.deepEqual(await push(coworkerA, a.id, [theirs]), { accepted: accepted(theirs), ignored: [] });
    assert.deepEqual(await push(employeeA, a.id, [mine]), { accepted: [], ignored: ignoredAs('superseded', mine) });
    assert.deepEqual((await stored(a.id, 'mrf', request.id)).data, theirs.record);
  });

  it('a change with no base onto a record the server has is a copy; with one onto a record it does not, it says conflict', async () => {
    const unit = await sent(supervisorA, 'equipment');
    const blind = change('equipment', unit.id, { ...unit.record, meter: 1300 });
    assert.deepEqual(await push(employeeA, a.id, [blind]), { accepted: [], ignored: ignoredAs('copy', blind) });
    assert.deepEqual((await stored(a.id, 'equipment', unit.id)).data, unit.record);

    const id = newId('exam');
    const lost = change('exam', id, recordOf('exam', id), 'abcdef0123456789abcd');
    assert.deepEqual(await push(employeeA, a.id, [lost]), { accepted: [{ key: lost.key, rev: lost.rev, conflict: true }], ignored: [] });
    assert.equal((await versions(a.id, 'exam', id))[0].base, 'abcdef0123456789abcd');
  });
});

// ---- Malformed calls -------------------------------------------------------------------------------------

describe('a call that is not shaped right', () => {
  it('more than 200 changes, or changes that are not a list, are refused whole', async () => {
    const many = Array.from({ length: 201 }, () => {
      const id = newId('opLog');
      return change('opLog', id, recordOf('opLog', id));
    });
    const before = await snapshot(a.id);
    await refused(push(employeeA, a.id, many), BAD_INPUT, /at most 200/);
    assert.deepEqual(await snapshot(a.id), before);
    const result = await push(employeeA, a.id, many.slice(0, 200));
    assert.equal(result.accepted.length, 200);
  });

  it('a malformed change is set aside, says what is wrong, and the rest of the call is taken', async () => {
    const good = () => {
      const id = newId('shift');
      return change('shift', id, recordOf('shift', id));
    };
    const shift = (fields) => ({ ...good(), ...fields });
    const bad = [
      ['a change that is not an object', 'shift:x'],
      ['a change that is null', null],
      ['a change that is a list', []],
      ['a kind the server does not keep', shift({ kind: 'account', key: 'account:x', id: 'x' })],
      ['a kind in other capitals', shift({ kind: 'Shift', key: 'Shift:x', id: 'x' })],
      ['no kind', { key: 'shift:x', id: 'x', rev: 'abc', record: {} }],
      ['a key that is not kind:id', shift({ key: 'shift:someone-else' })],
      ['no key', (({ key, ...rest }) => rest)(good())],
      ['an empty id', shift({ id: '', key: 'shift:' })],
      ['an id of 121 characters', shift({ id: 'x'.repeat(121), key: `shift:${'x'.repeat(121)}` })],
      ['an id with a control character', shift({ id: 'a\u0007b', key: 'shift:a\u0007b' })],
      ['an id that is a number', shift({ id: 7, key: 'shift:7' })],
      ['settings with an id other than company', { ...change('settings', 'phone', recordOf('settings', 'phone')) }],
      ['no rev', shift({ rev: undefined })],
      ['a rev that is a number', shift({ rev: 12 })],
      ['an empty rev', shift({ rev: '' })],
      ['a rev of 65 characters', shift({ rev: 'a'.repeat(65) })],
      ['a base that is a number', shift({ base: 5 })],
      ['an empty base', shift({ base: '' })],
      ['a deletion that carries a record', shift({ rev: DELETED })],
      ['a record that is null', shift({ record: null })],
      ['no record', shift({ record: undefined })],
      ['a record that is a list', shift({ record: [1, 2] })],
      ['a record that is text', shift({ record: 'clocked in' })],
    ];
    for (const [what, malformed] of bad) {
      const first = good();
      const result = await push(employeeA, a.id, [first, malformed]);
      assert.deepEqual(result.accepted, accepted(first), what);
      assert.equal(result.ignored.length, 1, what);
      const [entry] = result.ignored;
      assert.equal(entry.reason, what.startsWith('a kind') || what === 'no kind' ? 'unknown_kind' : 'malformed', what);
      assert.match(entry.problem, /^Change 2 /, what);
      // The key and rev are given back as sent, when they are text, so the phone can mark the change.
      assert.equal(entry.key, typeof malformed?.key === 'string' ? malformed.key : null, what);
      assert.equal(entry.rev, typeof malformed?.rev === 'string' ? malformed.rev : null, what);
      if (malformed && typeof malformed === 'object' && typeof malformed.id === 'string') {
        assert.equal(await stored(a.id, malformed.kind, malformed.id), undefined, `${what}: something was written`);
      }
    }
    await refused(pushRaw(employeeA, a.id, JSON.stringify(good())), BAD_INPUT, /sent as a list/);
    await refused(pushRaw(employeeA, a.id, 'null'), BAD_INPUT, /sent as a list/);
    await refused(db.as(employeeA).rows('select public.push_records(company_id => $1, changes => null) as result', [a.id]), BAD_INPUT, /sent as a list/);
  });

  it('a record over 256 KB is set aside, and one under it is taken', async () => {
    const id = newId('exam');
    const big = change('exam', id, recordOf('exam', id, { note: 'x'.repeat(262144) }));
    const before = await snapshot(a.id);
    assert.deepEqual(await push(employeeA, a.id, [big]), { accepted: [], ignored: ignoredAs('too_large', big) });
    assert.deepEqual(await snapshot(a.id), before);

    const fits = change('exam', id, recordOf('exam', id, { note: 'x'.repeat(250000) }));
    assert.deepEqual(await push(employeeA, a.id, [fits]), { accepted: accepted(fits), ignored: [] });
  });
});

// ---- Reading ---------------------------------------------------------------------------------------------

describe('reading records', () => {
  let shared;
  let person; // a person on the roster, read by supervisors only
  let leave;
  let theirShift;
  let theirDenied;
  let myShift;
  let myDenied;
  let account; // a fresh employee, so the counts are this test's own
  let other; // and a fresh coworker of theirs

  before(async () => {
    account = await newMember(db, a, 'Jo', 'Vale');
    other = await newMember(db, a, 'Kit', 'Marlow');
    await sent(supervisorA, 'settings');
    shared = [];
    for (const kind of ['equipment', 'areaSheet']) shared.push(`${kind}:${(await sent(supervisorA, kind)).id}`);
    person = `employee:${(await sent(supervisorA, 'employee')).id}`;
    for (const kind of ['inspection', 'opLog', 'exam', 'mrf']) shared.push(`${kind}:${(await sent(other, kind)).id}`);
    leave = await sent(supervisorA, 'leave');
    theirShift = await sent(other, 'shift');
    theirDenied = await sent(other, 'denied');
    myShift = await sent(account, 'shift');
    myDenied = await sent(account, 'denied');
  });

  it("an employee reads the crew's shared records, and only their own shifts and denied punches", async () => {
    const read = await keysReadBy(account);
    for (const key of [...shared, 'settings:company', `shift:${myShift.id}`, `denied:${myDenied.id}`]) assert.ok(read.includes(key), `does not read ${key}`);
    for (const key of [`shift:${theirShift.id}`, `denied:${theirDenied.id}`, `leave:${leave.id}`, person]) assert.ok(!read.includes(key), `reads ${key}`);
    // Every shift, denied punch and paid leave they read is their own.
    const personal = await db.as(account).rows("select created_by from public.records where kind in ('shift', 'denied', 'leave')");
    assert.deepEqual([...new Set(personal.map((r) => r.created_by))], [account]);
    // Every kind the crew shares, they read all of.
    const [{ n: sharedAll }] = await db.adminRows('select count(*)::int as n from public.records where company_id = $1 and kind = any($2)', [a.id, SHARED_KINDS]);
    const [{ n: sharedRead }] = await db.as(account).rows('select count(*)::int as n from public.records where kind = any($1)', [SHARED_KINDS]);
    assert.equal(sharedRead, sharedAll);
  });

  it('and the history of just those records', async () => {
    const read = await keysReadBy(account, 'record_history');
    for (const key of [...shared, `shift:${myShift.id}`]) assert.ok(read.includes(key), `does not read the history of ${key}`);
    for (const key of [`shift:${theirShift.id}`, `denied:${theirDenied.id}`, `leave:${leave.id}`, person]) assert.ok(!read.includes(key), `reads the history of ${key}`);
    // Their own shift's history, a supervisor's correction included.
    const fixed = change('shift', myShift.id, { ...myShift.record, clockOut: 1763340000000 }, myShift.change.rev);
    await push(supervisorA, a.id, [fixed]);
    const own = await db.as(account).rows('select version, by from public.record_history where kind = $1 and id = $2 order by version', ['shift', myShift.id]);
    assert.deepEqual(own, [{ version: 1, by: account }, { version: 2, by: supervisorA }]);
  });

  it('a supervisor reads every record and every version of the company', async () => {
    for (const table of ['records', 'record_history']) {
      const [{ n: all }] = await db.adminRows(`select count(*)::int as n from public.${table} where company_id = $1`, [a.id]);
      const [{ n: read }] = await db.as(supervisorA).rows(`select count(*)::int as n from public.${table}`);
      assert.equal(read, all, table);
    }
  });

  it("nobody in company B reads any of company A's, and B's records are its own", async () => {
    await sent(employeeA, 'exam');
    for (const table of ['records', 'record_history']) {
      assert.deepEqual(await db.as(supervisorB).rows(`select * from public.${table} where company_id = $1`, [a.id]), [], table);
    }
    // The same key in B is B's own record, and A's is left as it was.
    const id = theirShift.id;
    const inB = change('shift', id, recordOf('shift', id, { employeeId: 'emp-9' }));
    assert.deepEqual(await push(supervisorB, b.id, [inB]), { accepted: accepted(inB), ignored: [] });
    assert.deepEqual((await stored(a.id, 'shift', id)).data, theirShift.record);
    assert.deepEqual((await stored(b.id, 'shift', id)).data, inB.record);
    assert.deepEqual(await keysReadBy(supervisorB), [`shift:${id}`]);
    assert.deepEqual(await keysReadBy(supervisorB, 'record_history'), [`shift:${id}`]);
    // And nobody in A reads B's.
    for (const who of [supervisorA, employeeA]) {
      for (const table of ['records', 'record_history']) {
        assert.deepEqual(await db.as(who).rows(`select * from public.${table} where company_id = $1`, [b.id]), [], table);
      }
    }
  });

  it('an account in no company, anon and the authenticated role with no account read nothing', async () => {
    for (const table of ['records', 'record_history']) {
      assert.deepEqual(await db.as(outsider).rows(`select * from public.${table}`), [], table);
      assert.deepEqual(await db.noAccount().rows(`select * from public.${table}`), [], table);
      await refused(db.anon().query(`select * from public.${table}`), NO_PRIVILEGE, new RegExp(`permission denied for table ${table}`));
    }
  });
});

// ---- Writing past push_records ---------------------------------------------------------------------------

describe('the tables themselves', () => {
  it('are written by nobody through the API, the server key included', async () => {
    const shift = await sent(employeeA, 'shift');
    const before = await snapshot(a.id);
    const writes = [
      ["insert into public.records (company_id, kind, id, rev, data) values ($1, 'shift', 'made-up', 'abc', '{}')", [a.id]],
      ["update public.records set data = '{}' where company_id = $1", [a.id]],
      ["update public.records set created_by = null where company_id = $1", [a.id]],
      ['delete from public.records where company_id = $1', [a.id]],
      ['truncate public.records cascade', []],
      ["insert into public.record_history (company_id, kind, id, version, rev, deleted) values ($1, 'shift', $2, 9, 'abc', false)", [a.id, shift.id]],
      ["update public.record_history set data = '{}' where company_id = $1", [a.id]],
      ['update public.record_history set by = null where company_id = $1', [a.id]],
      ['delete from public.record_history where company_id = $1', [a.id]],
      ['truncate public.record_history', []],
    ];
    const sessions = [
      ['a supervisor', db.as(supervisorA)],
      ['an employee', db.as(employeeA)],
      ['anon', db.anon()],
      ['the server key', db.serviceRole()],
    ];
    for (const [who, session] of sessions) {
      for (const [sql, params] of writes) {
        await refused(session.query(sql, params), NO_PRIVILEGE, /permission denied/).catch((error) => {
          error.message = `${who}, ${sql}: ${error.message}`;
          throw error;
        });
      }
    }
    assert.deepEqual(await snapshot(a.id), before);
    // The server key reads them.
    const [{ n }] = await db.serviceRole().rows('select count(*)::int as n from public.records where company_id = $1', [a.id]);
    assert.equal(n, before.records.length);
  });

  it('keep every version even from the database owner, until the company itself is deleted', async () => {
    const c = await startCompany(db, { name: 'Test Pit C', supervisor: ['Jo', 'Vale'] });
    const id = newId('exam');
    const first = change('exam', id, recordOf('exam', id));
    const second = change('exam', id, recordOf('exam', id, { shift: 'night' }), first.rev);
    await push(c.owner, c.id, [first]);
    await push(c.owner, c.id, [second]);
    const kept = /history is kept as it was sent/;

    await refused(db.admin("update public.record_history set data = '{}' where company_id = $1", [c.id]), NO_PRIVILEGE, kept);
    await refused(db.admin('update public.record_history set at = now() where company_id = $1', [c.id]), NO_PRIVILEGE, kept);
    // Who sent a version is cleared only when that account is deleted, not by hand.
    await refused(db.admin('update public.record_history set by = null where company_id = $1', [c.id]), NO_PRIVILEGE, kept);
    await refused(db.admin('delete from public.record_history where company_id = $1 and version = 1', [c.id]), NO_PRIVILEGE, kept);
    // Deleting the record would take its history with it.
    await refused(db.admin('delete from public.records where company_id = $1', [c.id]), NO_PRIVILEGE, kept);
    await refused(db.admin('truncate public.record_history'), NO_PRIVILEGE, kept);
    await refused(db.admin('truncate public.records cascade'), NO_PRIVILEGE, kept);
    assert.equal((await versions(c.id, 'exam', id)).length, 2);

    await db.serviceRole().query('delete from public.companies where id = $1', [c.id]);
    assert.deepEqual(await snapshot(c.id), { records: [], history: [] });
  });

  it("deleting an account clears who sent each version, and nothing else", async () => {
    const c = await startCompany(db, { name: 'Test Pit C', supervisor: ['Jo', 'Vale'], roster: [{ first: 'Pat', last: 'Cole' }] });
    const leaving = await newMember(db, c, 'Pat', 'Cole');
    const id = newId('shift');
    const first = change('shift', id, recordOf('shift', id));
    const fixed = change('shift', id, recordOf('shift', id, { clockOut: 1763340000000 }), first.rev);
    await push(leaving, c.id, [first]);
    await push(c.owner, c.id, [fixed]);
    const before = await snapshot(c.id);

    await db.admin('delete from auth.users where id = $1', [leaving]);
    const now = await snapshot(c.id);
    assert.deepEqual(now.history.map((h) => h.by), [null, c.owner]);
    assert.deepEqual(now.history.map(({ by, ...rest }) => rest), before.history.map(({ by, ...rest }) => rest));
    assert.deepEqual(now.records.map((r) => [r.created_by, r.updated_by]), [[null, c.owner]]);
    assert.deepEqual(now.records.map(({ created_by, ...rest }) => rest), before.records.map(({ created_by, ...rest }) => rest));
  });
});

// ---- my_companies ----------------------------------------------------------------------------------------

describe('my_companies', () => {
  it("lists the caller's companies and role, with the join code only where they supervise", async () => {
    assert.deepEqual(await db.as(supervisorA).callRows('my_companies'), [
      { id: a.id, name: 'Test Pit A', state: 'CA', role: 'supervisor', join_code: a.code },
    ]);
    assert.deepEqual(await db.as(employeeA).callRows('my_companies'), [
      { id: a.id, name: 'Test Pit A', state: 'CA', role: 'employee', join_code: null },
    ]);
    assert.deepEqual(await db.as(outsider).callRows('my_companies'), []);

    // Someone in two companies: a supervisor of one, on the crew of the other.
    const c = await startCompany(db, { name: 'Test Pit C', state: 'NV', supervisor: ['Lee', 'Park'] });
    await addToRoster(db, b.owner, b.id, { first: 'Lee', last: 'Park' });
    assert.equal((await join(db, c.owner, b.code, 'Lee', 'Park')).status, 'joined');
    assert.deepEqual(await db.as(c.owner).callRows('my_companies'), [
      { id: b.id, name: 'Test Pit B', state: 'NV', role: 'employee', join_code: null },
      { id: c.id, name: 'Test Pit C', state: 'NV', role: 'supervisor', join_code: c.code },
    ]);

    // Taken off a roster, that company is no longer listed.
    const [row] = await db.adminRows('select id from public.roster where company_id = $1 and user_id = $2', [b.id, c.owner]);
    await db.as(b.owner).query('update public.roster set active = false where id = $1', [row.id]);
    assert.deepEqual((await db.as(c.owner).callRows('my_companies')).map((r) => r.name), ['Test Pit C']);

    // An account Supabase Auth has banned or soft-deleted is no member anywhere, as is_member says.
    await db.admin("update auth.users set banned_until = now() + interval '1 day' where id = $1", [c.owner]);
    assert.deepEqual(await db.as(c.owner).callRows('my_companies'), []);
    await db.admin("update auth.users set banned_until = null, deleted_at = now() where id = $1", [c.owner]);
    assert.deepEqual(await db.as(c.owner).callRows('my_companies'), []);
  });

  it('refuses when nobody is signed in', async () => {
    await refused(db.noAccount().callRows('my_companies'), NOT_SIGNED_IN, /Sign in first/);
    await refused(db.anon().callRows('my_companies'), NO_PRIVILEGE, /permission denied for function my_companies/);
  });
});
