// What push_records checks inside a change (migrations 20261117000100 to
// 0400): a phone that never pulls cannot undo what someone else wrote, a copy
// is not an edit, a member changes only what the app lets them change, a
// resent batch writes nothing, one change the server will not take never
// stops the rest, the size of what a call can make the server build or keep
// is bounded, and a client pulls what changed by seq.
//
// The records are shaped like the app's own (src/domain/types.ts), with
// made-up people, units and areas. The companies are "Test Pit A" and "Test
// Pit B".

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { newMember, refused, secondSupervisor, startCompany, startDatabase } from './harness.mjs';

const DELETED = 'deleted';

let db;
let a; // Test Pit A: supervisor Sam Ortiz (a.owner)
let b; // Test Pit B: supervisor Ana Diaz
let boss; // a.owner
let deputy; // a second supervisor of A, Dee Hale
let riley; // an employee of A
let maria; // an employee of A
let bo; // an employee of A

before(async () => {
  db = await startDatabase();
  a = await startCompany(db, {
    name: 'Test Pit A',
    roster: [
      { first: 'Riley J', last: 'Quinn' },
      { first: 'Maria', last: 'De La Cruz' },
      { first: 'Bo', last: 'Lark' },
    ],
  });
  boss = a.owner;
  riley = await newMember(db, a, 'Riley', 'Quinn');
  maria = await newMember(db, a, 'Maria', 'De La Cruz');
  bo = await newMember(db, a, 'Bo', 'Lark');
  deputy = await secondSupervisor(db, a, 'Dee', 'Hale');
  b = await startCompany(db, { name: 'Test Pit B', state: 'NV', supervisor: ['Ana', 'Diaz'] });
});
after(async () => {
  await db?.close();
});

// ---- Helpers ----------------------------------------------------------------------------------------

/** A record's version, as a phone makes it: 20 hex characters of a hash. */
const revOf = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);

let made = 0;
const newId = (prefix) => `${prefix}_${(made += 1).toString(36)}t${'x'.repeat(4)}`;

/** A change as changesToSend makes it: a null record is a deletion; base is the version the server last confirmed. */
function change(kind, id, record, base) {
  return { key: `${kind}:${id}`, kind, id, rev: record === null ? DELETED : revOf(record), ...(base ? { base } : null), record };
}

const T = 1763300000000; // a morning in November 2026
const HOUR = 3600000;

const shiftOf = (id, extra = {}) => ({ id, employeeId: 'emp_riley', clockIn: { at: T }, lunches: [], breaks: [], ...extra });
const unitOf = (id, extra = {}) => ({ id, unit: 'L-7', category: 'loader', make: 'Made-up', model: 'X1', status: 'ready', meter: 4200, meterUnit: 'hrs', ...extra });
const examOf = (id, extra = {}) => ({
  id,
  sheetId: 'sample-wash-bay',
  area: 'Wash bay',
  employeeId: 'emp_riley',
  shift: 'day',
  startedAt: T,
  submittedAt: T + 600000,
  rows: [
    { id: 'r1', label: 'Walkways', guarding: 'ok', electrical: 'ok', access: 'ok' },
    { id: 'r2', label: 'Tail pulley', guarding: 'bo', electrical: 'ok', access: 'ok', note: 'Guard off the tail pulley', danger: true },
  ],
  conditions: [{ id: 'c1', answer: 'ok' }],
  ...extra,
});
const inspectionOf = (id, extra = {}) => ({
  id,
  equipmentId: 'eq_l7',
  employeeId: 'emp_riley',
  templateId: 'operator-equipment-checklist',
  templateVersion: 1,
  startedAt: T,
  submittedAt: T + 300000,
  meter: 4200,
  answers: [{ itemId: 'brakes', answer: 'bo', note: 'Soft pedal' }, { itemId: 'horn', answer: 'ok' }],
  result: 'defect',
  ...extra,
});
const opLogOf = (id, extra = {}) => ({ id, equipmentId: 'eq_l7', employeeId: 'emp_riley', inspectionId: 'insp_1', startAt: T, startMeter: 4200, ...extra });
const mrfOf = (id, extra = {}) => ({
  id,
  number: 1001,
  requestedBy: 'emp_riley',
  createdAt: T,
  equipmentId: 'eq_l7',
  description: 'Soft brake pedal',
  priority: 'safety',
  items: [],
  taggedOut: true,
  status: 'open',
  history: [{ at: T, by: 'emp_riley', status: 'open' }],
  ...extra,
});
const settingsOf = (extra = {}) => ({ company: { name: 'Test Pit A', state: 'CA' }, site: null, workweekStartsOn: 0, allowSectionAllOk: false, ...extra });

function push(account, changes, companyId = a.id) {
  return db.as(account).call('push_records', { company_id: companyId, changes: JSON.stringify(changes) });
}

async function stored(kind, id, companyId = a.id) {
  const [row] = await db.adminRows('select * from public.records where company_id = $1 and kind = $2 and id = $3', [companyId, kind, id]);
  return row;
}

function versions(kind, id, companyId = a.id) {
  return db.adminRows('select * from public.record_history where company_id = $1 and kind = $2 and id = $3 order by version', [companyId, kind, id]);
}

async function snapshot(companyId = a.id) {
  return {
    records: await db.adminRows('select * from public.records where company_id = $1 order by kind, id', [companyId]),
    history: await db.adminRows('select * from public.record_history where company_id = $1 order by kind, id, version', [companyId]),
  };
}

const ok = (...changes) => changes.map((c) => ({ key: c.key, rev: c.rev }));
const conflicted = (...changes) => changes.map((c) => ({ key: c.key, rev: c.rev, conflict: true }));
const set = (reason, ...changes) => changes.map((c) => ({ key: c.key, rev: c.rev, reason }));

/** Sends one change and checks it was taken. */
async function taken(account, c) {
  const result = await push(account, [c]);
  assert.deepEqual(result.ignored, [], `${c.key} was set aside: ${JSON.stringify(result.ignored)}`);
  assert.equal(result.accepted.length, 1);
  return c;
}

// ---- A stale phone ------------------------------------------------------------------------------------

describe('a phone that has not seen the latest version', () => {
  it("does not put the employee's clock-out over a supervisor's correction of it", async () => {
    // Riley forgets to clock out. The office sets the clock-out, with its reason.
    const id = newId('sh');
    const opened = await taken(riley, change('shift', id, shiftOf(id)));
    const corrected = shiftOf(id, {
      clockOut: { at: T + 10 * HOUR },
      edits: [{ at: T + 20 * HOUR, byEmployeeId: 'emp_sam', field: 'clockOut', to: T + 10 * HOUR, reason: 'Forgot to clock out' }],
    });
    const fix = await taken(boss, change('shift', id, corrected, opened.rev));

    // The next morning Riley's phone still shows the shift open, and Riley taps Clock out.
    const late = change('shift', id, shiftOf(id, { clockOut: { at: T + 25 * HOUR } }), opened.rev);
    assert.deepEqual(await push(riley, [late]), { accepted: [], ignored: set('superseded', late) });
    assert.deepEqual((await stored('shift', id)).data, corrected);
    assert.deepEqual((await versions('shift', id)).map((v) => v.rev), [opened.rev, fix.rev]);
  });

  it('does not bring back a shift or a unit a supervisor deleted', async () => {
    const id = newId('sh');
    const first = await taken(riley, change('shift', id, shiftOf(id)));
    await taken(boss, change('shift', id, null, first.rev));
    const again = change('shift', id, shiftOf(id, { clockOut: { at: T + 9 * HOUR } }), first.rev);
    const blind = change('shift', id, shiftOf(id, { breaks: [{ start: T + HOUR }] }));
    assert.deepEqual(await push(riley, [again]), { accepted: [], ignored: set('deleted', again) });
    assert.deepEqual(await push(riley, [blind]), { accepted: [], ignored: set('deleted', blind) });
    // The first version sent again is a resend: answered, and nothing is written.
    assert.deepEqual(await push(riley, [first]), { accepted: ok(first), ignored: [] });
    assert.equal((await stored('shift', id)).deleted, true);
    assert.equal((await versions('shift', id)).length, 2);

    const unit = newId('eq');
    const listed = await taken(boss, change('equipment', unit, unitOf(unit)));
    await taken(boss, change('equipment', unit, null, listed.rev));
    const copy = change('equipment', unit, unitOf(unit), listed.rev);
    assert.deepEqual(await push(maria, [copy]), { accepted: [], ignored: set('deleted', copy) });
    assert.equal((await stored('equipment', unit)).deleted, true);
  });

  it('does not take back a date fixed a supervisor recorded on the exam', async () => {
    const id = newId('exam');
    const signed = await taken(riley, change('exam', id, examOf(id)));
    const withFix = examOf(id);
    withFix.rows[1] = { ...withFix.rows[1], fixed: { at: T + 3 * HOUR, by: 'emp_sam', note: 'Guard bolted back on' } };
    await taken(boss, change('exam', id, withFix, signed.rev));

    const undone = examOf(id);
    undone.rows[1] = { id: 'r2', label: 'Tail pulley', guarding: 'ok', electrical: 'ok', access: 'ok' };
    const stale = change('exam', id, undone, signed.rev);
    assert.deepEqual(await push(riley, [stale]), { accepted: [], ignored: set('superseded', stale) });
    assert.deepEqual((await stored('exam', id)).data, withFix);
  });

  it("still takes the employee's own next change when the answer to the first was lost", async () => {
    // The phone never heard that the server took the new shift, so its next change has no base.
    const id = newId('sh');
    const first = await taken(riley, change('shift', id, shiftOf(id)));
    const lunch = shiftOf(id, { lunches: [{ start: { at: T + 4 * HOUR }, end: { at: T + 4.5 * HOUR, auto: true } }] });
    const next = change('shift', id, lunch);
    assert.deepEqual(await push(riley, [next]), { accepted: conflicted(next), ignored: [] });
    assert.deepEqual((await versions('shift', id)).map((v) => [v.rev, v.base]), [[first.rev, null], [next.rev, null]]);
  });

  it("among supervisors, the latest change still wins and says conflict", async () => {
    const id = newId('mrf');
    const opened = await taken(riley, change('mrf', id, mrfOf(id)));
    const assigned = change('mrf', id, mrfOf(id, { assignedTo: 'emp_maria' }), opened.rev);
    const reworded = change('mrf', id, mrfOf(id, { description: 'Soft brake pedal, both sides' }), opened.rev);
    assert.deepEqual(await push(boss, [assigned]), { accepted: ok(assigned), ignored: [] });
    assert.deepEqual(await push(deputy, [reworded]), { accepted: conflicted(reworded), ignored: [] });
    assert.deepEqual((await stored('mrf', id)).data, reworded.record);
  });
});

// ---- Copies -------------------------------------------------------------------------------------------

describe('a copy of the fleet, the roster, the area sheets or the settings', () => {
  it("from a new phone is not put over the server's: a red tag stays", async () => {
    // Every phone of a build starts with the same fleet, every unit ready.
    const id = newId('eq');
    const seed = unitOf(id);
    const listed = await taken(boss, change('equipment', id, seed));
    const tagged = await taken(boss, change('equipment', id, unitOf(id, { status: 'out_of_service' }), listed.rev));

    const fromNewPhone = change('equipment', id, seed);
    assert.deepEqual(fromNewPhone.rev, listed.rev);
    // The new phone's copy, the version the server had first, is set aside and nothing is written.
    assert.deepEqual(await push(riley, [fromNewPhone]), { accepted: [], ignored: set('copy', fromNewPhone) });
    // A copy that differs from it, with no base, is a copy too, a supervisor's own cleared phone included.
    const older = change('equipment', id, unitOf(id, { meter: 4100 }));
    for (const who of [riley, deputy, boss]) assert.deepEqual(await push(who, [older]), { accepted: [], ignored: set('copy', older) });
    assert.deepEqual([(await stored('equipment', id)).data.status, (await stored('equipment', id)).rev], ['out_of_service', tagged.rev]);
    assert.equal((await versions('equipment', id)).length, 2);

    // Settings and the roster the same way.
    const settings = await taken(boss, change('settings', 'company', settingsOf({ workweekStartsOn: 1 })));
    const buildDefault = change('settings', 'company', settingsOf());
    assert.deepEqual(await push(deputy, [buildDefault]), { accepted: [], ignored: set('copy', buildDefault) });
    assert.equal((await stored('settings', 'company')).rev, settings.rev);
  });

  it('the same as the server has is taken, and writes nothing', async () => {
    const id = newId('eq');
    const seed = change('equipment', id, unitOf(id));
    await taken(boss, seed);
    const before = await snapshot();
    assert.deepEqual(await push(maria, [seed]), { accepted: ok(seed), ignored: [] });
    assert.deepEqual(await snapshot(), before);
  });

  it('a supervisor can bring back an area sheet deleted earlier, by the same id', async () => {
    const id = 'sample-wash-bay';
    const sheet = { id, title: 'Wash bay', rows: [{ id: 'r1', label: 'Walkways' }], active: true };
    const first = await taken(boss, change('areaSheet', id, sheet));
    await taken(boss, change('areaSheet', id, null, first.rev));
    const back = change('areaSheet', id, { ...sheet, rows: [...sheet.rows, { id: 'r2', label: 'Hose reel' }] });
    assert.deepEqual(await push(deputy, [back]), { accepted: conflicted(back), ignored: [] });
    assert.equal((await stored('areaSheet', id)).deleted, false);
  });

  it("a member's new record under an id another account already has is set aside as taken", async () => {
    const id = newId('sh');
    await taken(riley, change('shift', id, shiftOf(id)));
    const mine = change('shift', id, shiftOf(id, { employeeId: 'emp_maria', clockIn: { at: T + HOUR } }));
    assert.deepEqual(await push(maria, [mine]), { accepted: [], ignored: set('taken', mine) });
  });
});

// ---- What a member changes ----------------------------------------------------------------------------

describe('what an employee may change', () => {
  it('deletes nothing, and a deletion gets the same answer whether or not the record is there', async () => {
    const mine = [];
    for (const [kind, of] of [['shift', shiftOf], ['exam', examOf], ['inspection', inspectionOf], ['opLog', opLogOf], ['mrf', mrfOf]]) {
      const id = newId(kind);
      mine.push(await taken(riley, change(kind, id, of(id))));
    }
    const before = await snapshot();
    const deletions = mine.map((c) => change(c.kind, c.id, null, c.rev));
    const nothing = change('shift', newId('sh'), null, 'abcdef0123456789abcd');
    assert.deepEqual(await push(riley, [...deletions, nothing]), { accepted: [], ignored: set('supervisor_only', ...deletions, nothing) });
    assert.deepEqual(await snapshot(), before);
  });

  it('keeps the punches of a shift: clocks out once, adds a lunch, and moves no time', async () => {
    const id = newId('sh');
    const v1 = await taken(riley, change('shift', id, shiftOf(id, { breaks: [{ start: T + HOUR }] })));
    const lunch = { start: { at: T + 4 * HOUR }, end: { at: T + 4.5 * HOUR, auto: true } };
    const v2 = await taken(riley, change('shift', id, shiftOf(id, { breaks: [{ start: T + HOUR, end: T + 1.25 * HOUR }], lunches: [lunch] }), v1.rev));

    const refusedAs = async (record, base) => {
      const c = change('shift', id, record, base);
      assert.deepEqual(await push(riley, [c]), { accepted: [], ignored: set('signed', c) });
    };
    const base = { breaks: [{ start: T + HOUR, end: T + 1.25 * HOUR }], lunches: [lunch] };
    await refusedAs(shiftOf(id, { ...base, clockIn: { at: T - HOUR } }), v2.rev); // clock-in moved
    await refusedAs(shiftOf(id, { ...base, lunches: [] }), v2.rev); // lunch taken off
    await refusedAs(shiftOf(id, { ...base, lunches: [{ ...lunch, end: { at: T + 4.2 * HOUR } }] }), v2.rev); // lunch cut short
    await refusedAs(shiftOf(id, { ...base, breaks: [{ start: T + HOUR, end: T + 2 * HOUR }] }), v2.rev); // break moved
    await refusedAs(shiftOf(id, { ...base, employeeId: 'emp_maria' }), v2.rev); // someone else's
    await refusedAs(shiftOf(id, { ...base, edits: [{ at: T, byEmployeeId: 'emp_riley', field: 'clockIn', to: T - HOUR, reason: 'x' }] }), v2.rev);

    const out = await taken(riley, change('shift', id, shiftOf(id, { ...base, clockOut: { at: T + 10 * HOUR }, mealNote: 'worked_through' }), v2.rev));
    await refusedAs(shiftOf(id, { ...base, clockOut: { at: T + 11 * HOUR }, mealNote: 'worked_through' }), out.rev); // clocked out already
    assert.equal((await stored('shift', id)).rev, out.rev);
  });

  it('does not rewrite a signed exam, checklist or denied punch, and adds a date fixed only once', async () => {
    const exam = newId('exam');
    const signed = await taken(riley, change('exam', exam, examOf(exam)));
    const rewritten = examOf(exam);
    rewritten.rows[1] = { ...rewritten.rows[1], guarding: 'ok', danger: false };
    const rewrite = change('exam', exam, rewritten, signed.rev);
    assert.deepEqual(await push(riley, [rewrite]), { accepted: [], ignored: set('signed', rewrite) });

    // The person who made it records the fix, and the request it was sent on.
    const fixed = examOf(exam);
    fixed.rows[1] = { ...fixed.rows[1], mrfId: 'mrf_1', fixed: { at: T + 3 * HOUR, by: 'emp_riley' } };
    const fix = await taken(riley, change('exam', exam, fixed, signed.rev));
    // The first date stands.
    const later = examOf(exam);
    later.rows[1] = { ...later.rows[1], mrfId: 'mrf_1', fixed: { at: T + 5 * HOUR, by: 'emp_riley' } };
    const second = change('exam', exam, later, fix.rev);
    assert.deepEqual(await push(riley, [second]), { accepted: [], ignored: set('signed', second) });

    const card = newId('insp');
    const checked = await taken(riley, change('inspection', card, inspectionOf(card)));
    const parked = await taken(riley, change('inspection', card, inspectionOf(card, { decision: 'parked', mrfId: 'mrf_2' }), checked.rev));
    for (const record of [
      inspectionOf(card, { decision: 'operate', mrfId: 'mrf_2' }), // decided already
      inspectionOf(card, { decision: 'parked', mrfId: 'mrf_2', answers: [{ itemId: 'brakes', answer: 'ok' }, { itemId: 'horn', answer: 'ok' }], result: 'pass' }),
    ]) {
      const c = change('inspection', card, record, parked.rev);
      assert.deepEqual(await push(riley, [c]), { accepted: [], ignored: set('signed', c) });
    }

    const punch = newId('dn');
    const denied = { id: punch, employeeId: 'emp_riley', at: T, action: 'clock_in', reason: 'outside' };
    const first = await taken(riley, change('denied', punch, denied));
    const softened = change('denied', punch, { ...denied, reason: 'weak_gps' }, first.rev);
    assert.deepEqual(await push(riley, [softened]), { accepted: [], ignored: set('signed', softened) });
  });

  it("changes nobody else's exam or checklist", async () => {
    const exam = newId('exam');
    const signed = await taken(riley, change('exam', exam, examOf(exam)));
    const fixed = examOf(exam);
    fixed.rows[1] = { ...fixed.rows[1], fixed: { at: T + HOUR, by: 'emp_bo' } };
    const c = change('exam', exam, fixed, signed.rev);
    assert.deepEqual(await push(bo, [c]), { accepted: [], ignored: set('not_yours', c) });
  });

  it("ends another operator's open log of a unit, and changes nothing else of it", async () => {
    const id = newId('op');
    const open = await taken(riley, change('opLog', id, opLogOf(id)));
    for (const record of [
      opLogOf(id, { endAt: T + 5 * HOUR, endMeter: 4205, notes: 'Left it running' }),
      opLogOf(id, { startMeter: 4100, endAt: T + 5 * HOUR, endMeter: 4205 }),
      opLogOf(id, { endMeter: 4205 }),
    ]) {
      const c = change('opLog', id, record, open.rev);
      assert.deepEqual(await push(maria, [c]), { accepted: [], ignored: set('not_yours', c) });
    }
    const ended = await taken(maria, change('opLog', id, opLogOf(id, { endAt: T + 5 * HOUR, endMeter: 4205 }), open.rev));
    const again = change('opLog', id, opLogOf(id, { endAt: T + 6 * HOUR, endMeter: 4206 }), ended.rev);
    assert.deepEqual(await push(maria, [again]), { accepted: [], ignored: set('not_yours', again) });

    // The operator's own log: checked in once, with the start left as it was.
    const own = newId('op');
    const started = await taken(riley, change('opLog', own, opLogOf(own)));
    const moved = change('opLog', own, opLogOf(own, { startAt: T - HOUR, endAt: T + 2 * HOUR, endMeter: 4202 }), started.rev);
    assert.deepEqual(await push(riley, [moved]), { accepted: [], ignored: set('signed', moved) });
    const back = await taken(riley, change('opLog', own, opLogOf(own, { endAt: T + 2 * HOUR, endMeter: 4202, fuelGal: 30, parkedSafely: true }), started.rev));
    const twice = change('opLog', own, opLogOf(own, { endAt: T + 3 * HOUR, endMeter: 4203 }), back.rev);
    assert.deepEqual(await push(riley, [twice]), { accepted: [], ignored: set('signed', twice) });
  });

  it('works a maintenance request, but does not assign, reword, blank or reopen it', async () => {
    const id = newId('mrf');
    const opened = await taken(boss, change('mrf', id, mrfOf(id, { assignedTo: 'emp_maria', history: [{ at: T, by: 'emp_sam', status: 'open', assignedTo: 'emp_maria' }] })));
    const base = opened.record;
    for (const record of [
      { ...base, assignedTo: 'emp_bo' },
      { ...base, description: 'Nothing wrong' },
      { ...base, history: [] },
      {},
      { id },
    ]) {
      const c = change('mrf', id, record, opened.rev);
      assert.deepEqual(await push(bo, [c]), { accepted: [], ignored: set('supervisor_only', c) });
    }
    const started = await taken(maria, change('mrf', id, { ...base, status: 'in_progress', history: [...base.history, { at: T + HOUR, by: 'emp_maria', status: 'in_progress' }] }, opened.rev));
    const done = {
      ...started.record,
      status: 'completed',
      completedAt: T + 2 * HOUR,
      completedBy: 'emp_maria',
      timeSpent: 150,
      remarks: 'Bled the brakes',
      history: [...started.record.history, { at: T + 2 * HOUR, by: 'emp_maria', status: 'completed', note: 'Bled the brakes' }],
    };
    const completed = await taken(maria, change('mrf', id, done, started.rev));
    const reopened = change('mrf', id, { ...done, status: 'open' }, completed.rev);
    assert.deepEqual(await push(maria, [reopened]), { accepted: [], ignored: set('supervisor_only', reopened) });

    // A new request from an employee is not assigned by them either.
    const other = newId('mrf');
    const selfAssigned = change('mrf', other, mrfOf(other, { assignedTo: 'emp_bo' }));
    assert.deepEqual(await push(bo, [selfAssigned]), { accepted: [], ignored: set('supervisor_only', selfAssigned) });
  });

  it("changes a unit's status and equipment hours only, and adds no unit", async () => {
    const id = newId('eq');
    const listed = await taken(boss, change('equipment', id, unitOf(id)));
    for (const record of [unitOf(id, { unit: 'L-8' }), unitOf(id, { meter: 4100 }), unitOf(id, { meter: '4300' }), { id, status: 'ready', meter: 4300 }]) {
      const c = change('equipment', id, record, listed.rev);
      assert.deepEqual(await push(riley, [c]), { accepted: [], ignored: set('supervisor_only', c) });
    }
    await taken(riley, change('equipment', id, unitOf(id, { status: 'out_of_service', meter: 4210 }), listed.rev));

    const added = newId('eq');
    const c = change('equipment', added, unitOf(added));
    assert.deepEqual(await push(riley, [c]), { accepted: [], ignored: set('supervisor_only', c) });
  });
});

// ---- A supervisor who is no longer one ------------------------------------------------------------------

describe('what an account sent as a supervisor', () => {
  it('stays a supervisor’s when the account is made an employee: not read, not changed', async () => {
    const kim = await secondSupervisor(db, a, 'Kim', 'Ashby');
    const leave = newId('lv');
    const sick = { id: leave, employeeId: 'emp_maria', day: T, type: 'sick', hours: 800, enteredBy: 'emp_kim', at: T };
    const entered = await taken(kim, change('leave', leave, sick));
    const shift = newId('sh');
    const forMaria = await taken(kim, change('shift', shift, shiftOf(shift, { employeeId: 'emp_maria' })));
    const own = newId('sh');
    await taken(kim, change('shift', own, shiftOf(own, { employeeId: 'emp_kim' })));

    await db.as(boss).query("update public.roster set role = 'employee' where id = $1", [a.rows['Kim Ashby']]);
    await taken(boss, change('leave', leave, { ...sick, hours: 1000, note: 'Doctor note on file' }, entered.rev));

    for (const table of ['records', 'record_history']) {
      const read = await db.as(kim).rows(`select kind, id from public.${table} where kind in ('leave', 'shift', 'denied')`);
      assert.deepEqual(read, [], table);
    }
    const out = change('shift', shift, shiftOf(shift, { employeeId: 'emp_maria', clockOut: { at: T + 8 * HOUR } }), forMaria.rev);
    assert.deepEqual(await push(kim, [out]), { accepted: [], ignored: set('not_yours', out) });
  });
});

// ---- Resends ------------------------------------------------------------------------------------------

describe('a batch sent again after its answer was lost', () => {
  it('writes nothing over a newer version', async () => {
    const id = newId('mrf');
    const v1 = await taken(boss, change('mrf', id, mrfOf(id)));
    // The office assigns it; the call is taken, but its answer never reaches the phone.
    const v2 = await taken(boss, change('mrf', id, mrfOf(id, { assignedTo: 'emp_maria' }), v1.rev));
    // The other supervisor, who read it, rewords it.
    const v3 = await taken(deputy, change('mrf', id, mrfOf(id, { assignedTo: 'emp_maria', priority: 'high' }), v2.rev));
    // The first phone tries the same batch again.
    assert.deepEqual(await push(boss, [v2]), { accepted: ok(v2), ignored: [] });
    assert.equal((await stored('mrf', id)).rev, v3.rev);
    assert.equal((await versions('mrf', id)).length, 3);
  });

  it('still writes a record that comes back to an earlier version of its own', async () => {
    const id = newId('eq');
    const ready = await taken(boss, change('equipment', id, unitOf(id)));
    const tagged = await taken(boss, change('equipment', id, unitOf(id, { status: 'out_of_service' }), ready.rev));
    const backToReady = await taken(boss, change('equipment', id, unitOf(id), tagged.rev));
    const taggedAgain = change('equipment', id, unitOf(id, { status: 'out_of_service' }), backToReady.rev);
    assert.deepEqual(await push(boss, [taggedAgain]), { accepted: ok(taggedAgain), ignored: [] });
    assert.deepEqual((await versions('equipment', id)).map((v) => v.data?.status), ['ready', 'out_of_service', 'ready', 'out_of_service']);
  });
});

// ---- One change does not stop the rest --------------------------------------------------------------------

describe('a change the server will not take', () => {
  it('is set aside, and the rest of the call is taken', async () => {
    const logo = `data:image/png;base64,${'A'.repeat(270 * 1024)}`;
    const id = newId('sh');
    const shift = change('shift', id, shiftOf(id));
    const big = change('settings', 'company', settingsOf({ company: { name: 'Test Pit A', state: 'CA', logo: { uri: logo } } }));
    const result = await push(boss, [big, shift]);
    assert.deepEqual(result, { accepted: ok(shift), ignored: set('too_large', big) });
    // An employee's copy of the same settings is not theirs to send at all.
    const other = newId('sh');
    const theirs = change('shift', other, shiftOf(other));
    assert.deepEqual(await push(riley, [big, theirs]), { accepted: ok(theirs), ignored: set('supervisor_only', big) });
  });

  it('a kind the server does not keep, and a change not shaped right, are set aside with what is wrong', async () => {
    const good = () => {
      const id = newId('sh');
      return change('shift', id, shiftOf(id));
    };
    const photo = { key: 'photo:p1', kind: 'photo', id: 'p1', rev: 'abc', record: {} };
    const badKey = { ...good(), key: 'shift:someone-else' };
    const notObject = 'shift:x';
    const rest = [good(), good()];
    const result = await push(riley, [rest[0], photo, badKey, notObject, rest[1]]);
    assert.deepEqual(result.accepted, ok(...rest));
    assert.deepEqual(result.ignored.map(({ key, rev, reason }) => ({ key, rev, reason })), [
      { key: 'photo:p1', rev: 'abc', reason: 'unknown_kind' },
      { key: 'shift:someone-else', rev: badKey.rev, reason: 'malformed' },
      { key: null, rev: null, reason: 'malformed' },
    ]);
    assert.match(result.ignored[1].problem, /^Change 3 has a key that is not its kind and id\.$/);
    assert.match(result.ignored[2].problem, /^Change 4 is not an object\.$/);
  });
});

// ---- Bounds -------------------------------------------------------------------------------------------------

describe('what a call can make the server build', () => {
  it('a record of huge numbers is set aside before it is ever written out as text', async () => {
    // 1e131071 is 9 characters as JSON and 131,072 as text. 8,200 of them made 1 GB.
    const id = newId('exam');
    const numbers = `[${Array(8200).fill('1e131071').join(',')}]`;
    const json = `[{"key":"exam:${id}","kind":"exam","id":"${id}","rev":"abcdef0123456789abcd","record":{"id":"${id}","a":${numbers}}}]`;
    const started = Date.now();
    const [{ result }] = await db.as(riley).rows('select public.push_records(company_id => $1, changes => $2::text::jsonb) as result', [a.id, json]);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    assert.deepEqual(result.accepted, []);
    assert.equal(result.ignored[0].reason, 'malformed');
    assert.match(result.ignored[0].problem, /number/);

    // The smallest and largest numbers a phone can send are taken.
    const edge = newId('exam');
    const fine = change('exam', edge, { ...examOf(edge), limits: [1.7976931348623157e308, -1.7976931348623157e308, 5e-324, 0] });
    assert.deepEqual(await push(riley, [fine]), { accepted: ok(fine), ignored: [] });
    for (const n of ['1e-400', '-2e308']) {
      const odd = newId('exam');
      const raw = `[{"key":"exam:${odd}","kind":"exam","id":"${odd}","rev":"abcdef0123456789abcd","record":{"n":${n}}}]`;
      const [{ result: answer }] = await db.as(riley).rows('select public.push_records(company_id => $1, changes => $2::text::jsonb) as result', [a.id, raw]);
      assert.equal(answer.ignored[0]?.reason, 'malformed', n);
    }
  });

  it('a pay period of huge numbers is refused before it is written out as text', async () => {
    const numbers = `[${Array(8200).fill('1e131071').join(',')}]`;
    const started = Date.now();
    await refused(
      db.as(boss).query(`update public.companies set pay_period = $2::text::jsonb where id = $1`, [a.id, `{"kind":"weekly","a":${numbers}}`]),
      '23514',
      /companies_pay_period_size/,
    );
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    await refused(db.as(boss).query(`update public.companies set pay_period = '{"kind":"weekly","n":1e-400}' where id = $1`, [a.id]), '23514');
    assert.equal(await db.as(boss).affected(`update public.companies set pay_period = '{"kind":"weekly","anchor":1763300000000}' where id = $1`, [a.id]), 1);
  });

  it('a record over 1 MB as stored is set aside before it is written out as text', async () => {
    // 70,000 numbers of 301 digits: about 1.1 MB as stored, 21 MB as text.
    const id = newId('exam');
    const json = `[{"key":"exam:${id}","kind":"exam","id":"${id}","rev":"abcdef0123456789abcd","record":{"a":[${Array(70000).fill('1e300').join(',')}]}}]`;
    const [{ result }] = await db.as(riley).rows('select public.push_records(company_id => $1, changes => $2::text::jsonb) as result', [a.id, json]);
    assert.deepEqual(result, { accepted: [], ignored: [{ key: `exam:${id}`, rev: 'abcdef0123456789abcd', reason: 'too_large' }] });
  });

  it('one call writes one version of a record, however many times it carries it', async () => {
    const id = newId('eq');
    const listed = await taken(boss, change('equipment', id, unitOf(id)));
    let base = listed.rev;
    const many = [];
    for (let n = 1; n <= 50; n += 1) {
      const c = change('equipment', id, unitOf(id, { meter: 4200 + n }), base);
      many.push(c);
      base = c.rev;
    }
    const result = await push(boss, [...many, many[0]]);
    assert.deepEqual(result.accepted, ok(many[0], many[0]));
    assert.deepEqual(result.ignored, set('duplicate', ...many.slice(1)));
    assert.equal((await versions('equipment', id)).length, 2);
  });

  it('past 8 MB of records in one call, the rest wait for the next call', async () => {
    const pad = 'p'.repeat(250 * 1024);
    const changes = [];
    for (let n = 0; n < 40; n += 1) {
      const id = newId('exam');
      changes.push(change('exam', id, { ...examOf(id), pad }));
    }
    const result = await push(riley, changes);
    const kept = result.accepted.length;
    assert.ok(kept >= 32 && kept < 40, `took ${kept}`);
    assert.deepEqual(result.accepted, ok(...changes.slice(0, kept)));
    assert.deepEqual(result.ignored, []);
    assert.deepEqual(result.deferred, set('call_size', ...changes.slice(kept)));
    assert.equal(await stored('exam', changes[kept].id), undefined);
    // The next call takes them.
    assert.deepEqual((await push(riley, changes.slice(kept))).accepted, ok(...changes.slice(kept)));
  });

  it('an account sends at most 20,000 versions a day, and the count starts again the next day', async () => {
    const today = (await db.adminRows("select (now() at time zone 'UTC')::date::text as d"))[0].d;
    await db.admin('insert into public.record_usage (user_id, day, versions, bytes) values ($1, $2, 19999, 0) on conflict (user_id) do update set day = $2, versions = 19999, bytes = 0', [bo, today]);
    const changes = [0, 1, 2].map(() => {
      const id = newId('sh');
      return change('shift', id, shiftOf(id));
    });
    const result = await push(bo, changes);
    assert.deepEqual(result.accepted, ok(changes[0]));
    assert.deepEqual(result.deferred, set('daily_limit', changes[1], changes[2]));
    assert.equal(await stored('shift', changes[1].id), undefined);

    // Nothing more today; what the server has already is still answered.
    const again = await push(bo, [changes[0], changes[1]]);
    assert.deepEqual([again.accepted, again.deferred], [ok(changes[0]), set('daily_limit', changes[1])]);

    await db.admin("update public.record_usage set day = day - 1 where user_id = $1", [bo]);
    assert.deepEqual((await push(bo, changes.slice(1))).accepted, ok(changes[1], changes[2]));
    const [usage] = await db.adminRows('select day::text, versions from public.record_usage where user_id = $1', [bo]);
    assert.deepEqual(usage, { day: today, versions: 2 });
  });

  it('and at most 64 MB of records a day', async () => {
    const today = (await db.adminRows("select (now() at time zone 'UTC')::date::text as d"))[0].d;
    await db.admin('update public.record_usage set day = $2, versions = 0, bytes = $3 where user_id = $1', [bo, today, 64 * 1024 * 1024 - 1000]);
    const shift = newId('sh');
    const small = change('shift', shift, shiftOf(shift));
    const id = newId('exam');
    const big = change('exam', id, { ...examOf(id), pad: 'p'.repeat(2000) });
    const result = await push(bo, [small, big]);
    assert.deepEqual([result.accepted, result.deferred], [ok(small), set('daily_limit', big)]);
  });
});

// ---- Private fields ---------------------------------------------------------------------------------------

describe('a private field anywhere in a record', () => {
  it('sets the record aside, however deep it is and however it is spelled', async () => {
    const before = await snapshot();
    const changes = [
      change('settings', 'company', settingsOf({ company: { name: 'Test Pit A', state: 'CA', payRates: { emp_riley: 3100 } } })),
      change('employee', 'emp_x1', { id: 'emp_x1', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true, pay: { rate: 3100 } }),
      change('employee', 'emp_x2', { id: 'emp_x2', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true, account: { passwordHash: 'abc', salt: 'def' } }),
      change('employee', 'emp_x3', { id: 'emp_x3', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true, hourlyRate: 3100 }),
      change('employee', 'emp_x4', { id: 'emp_x4', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true, PayRates: {} }),
      change('mrf', 'mrf_x5', mrfOf('mrf_x5', { items: [{ label: 'Labor', payrate: 3100 }] })),
    ];
    assert.deepEqual(await push(boss, changes), { accepted: [], ignored: set('private', ...changes) });
    assert.deepEqual(await snapshot(), before);
    // A word that only looks like one is fine.
    const fine = change('mrf', 'mrf_x6', mrfOf('mrf_x6', { items: [{ label: 'rate', note: 'Ratel' }], rated: true }));
    assert.deepEqual(await push(boss, [fine]), { accepted: ok(fine), ignored: [] });
  });
});

// ---- Reading -----------------------------------------------------------------------------------------------

/** The plan of a query, run as an account. */
async function planOf(account, sql, params) {
  const [row] = await db.as(account).rows(`explain (analyze, format json, costs off, timing off, summary off) ${sql}`, params);
  const plan = row['QUERY PLAN'];
  return (Array.isArray(plan) ? plan : JSON.parse(plan))[0].Plan;
}

function nodesOf(node, into = []) {
  into.push(node);
  for (const child of node.Plans ?? []) nodesOf(child, into);
  return into;
}

describe('reading records', () => {
  it('calls no function on each row, and reads no row of another company (as row_reads.db.mjs holds the step 1 tables to)', async () => {
    const theirs = newId('sh');
    await push(b.owner, [change('shift', theirs, shiftOf(theirs))], b.id);
    for (const table of ['records', 'record_history']) {
      for (const account of [riley, boss]) {
        const nodes = nodesOf(await planOf(account, `select * from public.${table}`));
        const conditions = nodes.flatMap((node) => ['Filter', 'Index Cond', 'Recheck Cond', 'Join Filter'].map((key) => node[key]).filter(Boolean));
        for (const condition of conditions) assert.doesNotMatch(condition, /is_member|is_supervisor/, `${table}: ${condition}`);
      }
      // Asked for company B's rows by its id, the scan reads none of them.
      const nodes = nodesOf(await planOf(riley, `select * from public.${table} where company_id = $1`, [b.id]));
      const read = nodes.reduce((n, node) => n + (node['Rows Removed by Filter'] ?? 0) + (/Scan$/.test(node['Node Type']) ? node['Actual Rows'] : 0), 0);
      assert.equal(read, 0, `${table}: ${read} of company B's rows were read`);
    }
  });
});

// ---- Pulling what changed ----------------------------------------------------------------------------------

describe('what changed, by seq', () => {
  it('every version gets the next number of its company, and a record its newest', async () => {
    const ids = [newId('sh'), newId('sh'), newId('sh')];
    const first = ids.map((id) => change('shift', id, shiftOf(id)));
    const [{ last }] = await db.adminRows('select coalesce(max(seq), 0)::int as last from public.record_history where company_id = $1', [a.id]);
    await push(riley, first);
    const rows = await db.adminRows('select id, seq::int from public.record_history where company_id = $1 and seq > $2 order by seq', [a.id, last]);
    assert.deepEqual(rows, ids.map((id, n) => ({ id, seq: last + n + 1 })));
    assert.deepEqual((await db.adminRows('select id, seq::int from public.records where company_id = $1 and seq > $2 order by seq', [a.id, last])), rows);

    // A change moves the record to the newest number; the history keeps the old one.
    await push(riley, [change('shift', ids[0], shiftOf(ids[0], { clockOut: { at: T + 9 * HOUR } }), first[0].rev)]);
    assert.equal(Number((await stored('shift', ids[0])).seq), last + 4);
    assert.deepEqual((await versions('shift', ids[0])).map((v) => Number(v.seq)), [last + 1, last + 4]);
    // Another company counts its own: one more than B's own last.
    const [{ before }] = await db.adminRows('select seq::int as before from public.record_counters where company_id = $1', [b.id]);
    const id = newId('sh');
    await push(b.owner, [change('shift', id, shiftOf(id))], b.id);
    const [{ seq }] = await db.adminRows('select seq::int from public.records where company_id = $1 and id = $2', [b.id, id]);
    assert.equal(seq, before + 1);
    assert.ok(seq < last, 'B counts apart from A');
  });

  it('a pull by seq reads every record, even one changed between two pages', async () => {
    const ids = [newId('eq'), newId('eq'), newId('eq'), newId('eq')];
    const sent = [];
    for (const id of ids) sent.push(await taken(boss, change('equipment', id, unitOf(id))));
    const [{ from }] = await db.adminRows('select min(seq)::int - 1 as from from public.records where company_id = $1 and id = any($2)', [a.id, ids]);
    const page = (after) => db.as(maria).rows("select id, seq from public.records where company_id = $1 and kind = 'equipment' and seq > $2 order by seq limit 2", [a.id, after]);
    const one = await page(from);
    await taken(boss, change('equipment', ids[0], unitOf(ids[0], { status: 'defect' }), sent[0].rev));
    const two = await page(one[1].seq);
    const three = await page(two[two.length - 1].seq);
    const read = new Set([...one, ...two, ...three].map((r) => r.id));
    for (const id of ids) assert.ok(read.has(id), `never read ${id}`);
  });
});
