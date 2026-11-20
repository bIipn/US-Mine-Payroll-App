// How a phone takes in what the company holds of the four kinds every phone works from: the
// settings, the roster, the fleet and the area sheets (src/domain/receive.ts). One test per row of
// the merge's table, on a supervisor's phone and on a crew phone, the unit's status merged three
// ways and held to this phone's own open requests, who the phone is to the company, and the shape a
// row must have to be read at all (the same good and bad records the server is held to).
import fixtures from './fixtures/sharedRecords.json';
import {
  changedFields,
  notTakenWords,
  EQUIPMENT_CATEGORIES,
  freshReceiving,
  listed,
  mergeRows,
  mergeStatus,
  readRecord,
  standingChange,
  statusFromRequests,
  worseStatus,
  type ReceivedRow,
  type ReceiveState,
} from '../receive';
import { changesToSend, revOf, sharedSettings, type SyncData } from '../sync';
import type { AreaSheet, Employee, Equipment, Mrf, OperatingLog, Role, Settings } from '../types';

const NOW = 1763300000000;
const DAY = 86_400_000;
const COMPANY = 'company-a';

const person = (extra: Partial<Employee> = {}): Employee => ({ id: 'emp_lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true, ...extra });
const unit = (extra: Partial<Equipment> = {}): Equipment => ({
  id: 'eq_t14',
  unit: 'T-14',
  category: 'haul_truck',
  make: 'Made-up',
  model: 'HX 40',
  status: 'ready',
  meter: 1200,
  meterUnit: 'hrs',
  ...extra,
});
const sheet = (extra: Partial<AreaSheet> = {}): AreaSheet => ({ id: 'wash-bay', title: 'Wash bay', rows: [{ id: 'r1', label: 'Walkways' }], active: true, ...extra });
const settings = (extra: Partial<Settings> = {}): Settings => ({
  company: { name: 'Test Pit A', state: 'NV', pay: null },
  site: null,
  workweekStartsOn: 0,
  lunchReminders: true,
  allowSectionAllOk: false,
  demoLocation: 'gps',
  ...extra,
});
const PIN = { name: 'Test Pit A', center: { lat: 39.5, lng: -118.25 }, radiusM: 800 };

let seq = 100;
type Kind = ReceivedRow['kind'];
/** A row as read_shared_records hands it over: the server's version of the whole record. */
function row(kind: Kind, id: string, data: object | null): ReceivedRow {
  seq += 1;
  return data === null ? { kind, id, rev: 'deleted', seq, deleted: true, data: {} } : { kind, id, rev: revOf(data), seq, deleted: false, data };
}
const settingsRow = (s: Settings) => row('settings', 'company', sharedSettings(s));
const formOf = (kind: Kind, record: object) => (kind === 'settings' ? sharedSettings(record as Settings) : record);

/** A connected phone that has caught up once, with the company's sign-in in this role. */
function phone(role: Role | 'none' | null = 'supervisor', extra: Partial<ReceiveState> = {}): ReceiveState {
  return {
    employees: [],
    equipment: [],
    areaSheets: [],
    settings: settings(),
    mrfs: [],
    opLogs: [],
    synced: {},
    receiving: { ...freshReceiving(COMPANY), role, caughtUpAt: NOW - DAY, cursor: 100 },
    ...extra,
  };
}

/** The phone holds this version as the one the server last had: in step. */
function inStep(state: ReceiveState, kind: Kind, id: string, record: object): ReceiveState {
  return { ...state, synced: { ...state.synced, [`${kind}:${id}`]: revOf(formOf(kind, record)) } };
}

const words = (state: { receiving: { notices: readonly { words: string }[] } }) => state.receiving.notices.map((n) => n.words);

// ---- A person ---------------------------------------------------------------------------------------

describe('a person', () => {
  it('is always the company’s version, with no notice', () => {
    const before = inStep(phone('supervisor', { employees: [person()] }), 'employee', 'emp_lee', person());
    const changed = person({ title: 'Loader operator', payrollId: '004417' });
    const after = mergeRows(before, [row('employee', 'emp_lee', changed)], NOW);
    expect(after.employees).toEqual([changed]);
    expect(after.synced['employee:emp_lee']).toBe(revOf(changed));
    expect(after.receiving.notices).toEqual([]);
  });

  it('comes without a payroll ID on a phone whose sign-in is not a supervisor’s, its version still the server’s', () => {
    const r = row('employee', 'emp_lee', person({ payrollId: '004417' }));
    const after = mergeRows(phone('employee'), [r], NOW);
    expect(after.employees).toEqual([person()]);
    expect(after.synced['employee:emp_lee']).toBe(r.rev);
  });

  it('is taken off with its synced entry when the company deletes them', () => {
    const before = inStep(phone('employee', { employees: [person()] }), 'employee', 'emp_lee', person());
    const after = mergeRows(before, [row('employee', 'emp_lee', null)], NOW);
    expect(after.employees).toEqual([]);
    expect(after.synced).toEqual({});
  });
});

// ---- A sheet and the settings, on a supervisor's phone ------------------------------------------------

describe('an area sheet on a supervisor’s phone', () => {
  it('R deleted, no L: S dropped', () => {
    const before = { ...phone(), synced: { 'areaSheet:wash-bay': revOf(sheet()) } };
    const after = mergeRows(before, [row('areaSheet', 'wash-bay', null)], NOW);
    expect(after.areaSheets).toEqual([]);
    expect(after.synced).toEqual({});
  });

  it('R deleted, L there: L and S off together', () => {
    const before = inStep(phone('supervisor', { areaSheets: [sheet()] }), 'areaSheet', 'wash-bay', sheet());
    const after = mergeRows(before, [row('areaSheet', 'wash-bay', null)], NOW);
    expect(after.areaSheets).toEqual([]);
    expect(after.synced).toEqual({});
  });

  it('R live, no L, no S: L = R', () => {
    const after = mergeRows(phone(), [row('areaSheet', 'wash-bay', sheet())], NOW);
    expect(after.areaSheets).toEqual([sheet()]);
    expect(after.synced['areaSheet:wash-bay']).toBe(revOf(sheet()));
  });

  it('R live, no L, S there: L = R, quietly (the app takes no sheet off)', () => {
    const before = { ...phone(), synced: { 'areaSheet:wash-bay': revOf(sheet()) } };
    const after = mergeRows(before, [row('areaSheet', 'wash-bay', sheet({ title: 'Wash bay north' }))], NOW);
    expect(after.areaSheets).toEqual([sheet({ title: 'Wash bay north' })]);
    expect(after.receiving.notices).toEqual([]);
  });

  it('R live, L there, no S: L = R, with a notice when the phone’s differed', () => {
    const mine = sheet({ rows: [{ id: 'r1', label: 'Walkways' }, { id: 'r2', label: 'Hose reel' }] });
    const after = mergeRows(phone('supervisor', { areaSheets: [mine] }), [row('areaSheet', 'wash-bay', sheet())], NOW);
    expect(after.areaSheets).toEqual([sheet()]);
    expect(words(after)).toEqual([
      'The Wash bay sheet was already on the company’s list, so this phone now shows the company’s. Your version was not sent; change it again if it is still wanted.',
    ]);
    const same = mergeRows(phone('supervisor', { areaSheets: [sheet()] }), [row('areaSheet', 'wash-bay', sheet())], NOW);
    expect(same.receiving.notices).toEqual([]);
  });

  it('R live, L not changed here: L = R', () => {
    const before = inStep(phone('supervisor', { areaSheets: [sheet()] }), 'areaSheet', 'wash-bay', sheet());
    const after = mergeRows(before, [row('areaSheet', 'wash-bay', sheet({ active: false }))], NOW);
    expect(after.areaSheets).toEqual([sheet({ active: false })]);
    expect(after.synced['areaSheet:wash-bay']).toBe(revOf(sheet({ active: false })));
    expect(after.receiving.notices).toEqual([]);
  });

  it('R live, L changed here, R.rev = S: L kept, to be sent', () => {
    const before = inStep(phone('supervisor', { areaSheets: [sheet({ title: 'Wash bay north' })] }), 'areaSheet', 'wash-bay', sheet());
    const after = mergeRows(before, [row('areaSheet', 'wash-bay', sheet())], NOW);
    expect(after.areaSheets).toEqual([sheet({ title: 'Wash bay north' })]);
    expect(after.synced['areaSheet:wash-bay']).toBe(revOf(sheet()));
  });

  it('R live, L changed here, its own write coming back: S = R.rev, L kept, the sent mark dropped', () => {
    const mine = sheet({ title: 'Wash bay north' });
    const before = inStep(phone('supervisor', { areaSheets: [mine] }), 'areaSheet', 'wash-bay', sheet());
    const after = mergeRows(before, [row('areaSheet', 'wash-bay', mine)], NOW);
    expect(after.areaSheets).toEqual([mine]);
    expect(after.synced['areaSheet:wash-bay']).toBe(revOf(mine));

    // The answer to the send was lost and the phone changed it again since: the sent mark knows it.
    const later = sheet({ title: 'Wash bay north end' });
    const marked = { ...before, areaSheets: [later], receiving: { ...before.receiving, sent: { 'areaSheet:wash-bay': revOf(mine) } } };
    const back = mergeRows(marked, [row('areaSheet', 'wash-bay', mine)], NOW);
    expect(back.areaSheets).toEqual([later]);
    expect(back.synced['areaSheet:wash-bay']).toBe(revOf(mine));
    expect(back.receiving.sent).toEqual({});
    expect(back.receiving.notices).toEqual([]);
  });

  it('R live, L changed here, both moved: the company’s version stands, and the phone says what it did not send', () => {
    const before = inStep(phone('supervisor', { areaSheets: [sheet({ title: 'Wash bay north' })] }), 'areaSheet', 'wash-bay', sheet());
    const theirs = sheet({ rows: [{ id: 'r1', label: 'Walkways' }, { id: 'r2', label: 'Hose reel' }] });
    const after = mergeRows(before, [row('areaSheet', 'wash-bay', theirs)], NOW);
    expect(after.areaSheets).toEqual([theirs]);
    expect(after.synced['areaSheet:wash-bay']).toBe(revOf(theirs));
    expect(words(after)).toEqual([
      'Your change to the Wash bay north sheet was not sent: it was changed in the office or on another phone first (lines and name). This phone now shows the newer version. Make your change again if it is still wanted.',
    ]);

    const sent = { ...before, receiving: { ...before.receiving, sent: { 'areaSheet:wash-bay': revOf(sheet({ title: 'Wash bay north' })) } } };
    const lost = mergeRows(sent, [row('areaSheet', 'wash-bay', theirs)], NOW);
    expect(lost.receiving.sent).toEqual({});
    expect(words(lost)).toEqual([
      'Your change to the Wash bay north sheet may have reached the company before it was changed in the office or on another phone (lines and name). This phone now shows the company’s version: check it, and make your change again if it is missing.',
    ]);
  });
});

describe('an area sheet on a crew phone', () => {
  it('is always the company’s version, with a notice only for a supervisor’s edit left from before', () => {
    const before = inStep(phone('employee', { areaSheets: [sheet({ title: 'Wash bay north' })] }), 'areaSheet', 'wash-bay', sheet());
    const after = mergeRows(before, [row('areaSheet', 'wash-bay', sheet())], NOW);
    expect(after.areaSheets).toEqual([sheet()]);
    expect(words(after)).toEqual(['Your change to the Wash bay north sheet was not sent: this phone’s company sign-in is no longer a supervisor’s. This phone shows the company’s version.']);

    const plain = inStep(phone('employee', { areaSheets: [sheet()] }), 'areaSheet', 'wash-bay', sheet());
    expect(mergeRows(plain, [row('areaSheet', 'wash-bay', sheet({ active: false }))], NOW).receiving.notices).toEqual([]);
  });
});

describe('the company settings', () => {
  it('take the four shared fields and keep this phone’s own', () => {
    const mine = settings({ lunchReminders: false, demoLocation: 'at_mine' });
    const before = inStep(phone('supervisor', { settings: mine }), 'settings', 'company', mine);
    const theirs = settings({ company: { name: 'Test Pit A', state: 'NV', pay: null, mineId: '0400123' }, workweekStartsOn: 1 });
    const after = mergeRows(before, [settingsRow(theirs)], NOW);
    expect(after.settings).toEqual({ ...theirs, lunchReminders: false, demoLocation: 'at_mine' });
    expect(after.synced['settings:company']).toBe(revOf(sharedSettings(theirs)));
  });

  it('never lose a pin to a company with no site, on a supervisor’s phone: the pin goes to the company', () => {
    const mine = settings({ site: PIN });
    const before = inStep(phone('supervisor', { settings: mine }), 'settings', 'company', settings());
    const r = settingsRow(settings({ workweekStartsOn: 1 }));
    const after = mergeRows(before, [r], NOW);
    expect(after.settings.site).toEqual(PIN);
    expect(after.settings.workweekStartsOn).toBe(1);
    expect(after.synced['settings:company']).toBe(r.rev);
  });

  it('are the company’s, site and all, on a crew phone', () => {
    const before = inStep(phone('employee', { settings: settings({ site: PIN }) }), 'settings', 'company', settings({ site: PIN }));
    const after = mergeRows(before, [settingsRow(settings())], NOW);
    expect(after.settings.site).toBeNull();
  });

  it('say which fields the office changed, in the dashboard’s words', () => {
    const mine = settings({ allowSectionAllOk: true });
    const before = inStep(phone('supervisor', { settings: mine }), 'settings', 'company', settings());
    const theirs = settings({ company: { name: 'Test Pit A LLC', state: 'NV', pay: null }, workweekStartsOn: 1 });
    expect(words(mergeRows(before, [settingsRow(theirs)], NOW))).toEqual([
      'Your change to the company settings was not sent: it was changed in the office or on another phone first (“Rest are OK” switch, company name and workweek). This phone now shows the newer version. Make your change again if it is still wanted.',
    ]);
  });
});

// ---- A unit ---------------------------------------------------------------------------------------------

describe('a unit', () => {
  const openLog: OperatingLog = { id: 'log1', equipmentId: 'eq_t14', employeeId: 'emp_lee', inspectionId: 'insp1', startAt: NOW - 3_600_000, startMeter: 1200 };

  it('R deleted, L there: off, and kept in gone while it is checked out on this phone', () => {
    const before = inStep(phone('employee', { equipment: [unit()], opLogs: [openLog] }), 'equipment', 'eq_t14', unit());
    const after = mergeRows({ ...before, receiving: { ...before.receiving, units: { eq_t14: { status: 'ready', meter: 1200 } } } }, [row('equipment', 'eq_t14', null)], NOW);
    expect(after.equipment).toEqual([]);
    expect(after.synced).toEqual({});
    expect(after.receiving.gone).toEqual({ eq_t14: unit() });
    expect(after.receiving.units).toEqual({});
    expect(after.receiving.notices).toEqual([]);

    const ended = { ...openLog, endAt: NOW, endMeter: 1204 };
    const notOut = inStep(phone('employee', { equipment: [unit()], opLogs: [ended] }), 'equipment', 'eq_t14', unit());
    expect(mergeRows(notOut, [row('equipment', 'eq_t14', null)], NOW).receiving.gone).toEqual({});
  });

  it('R deleted, L changed here: off, and the phone says its change was not sent', () => {
    const before = inStep(phone('employee', { equipment: [unit({ status: 'defect' })] }), 'equipment', 'eq_t14', unit());
    expect(words(mergeRows(before, [row('equipment', 'eq_t14', null)], NOW))).toEqual(['Unit T-14 was taken out of the fleet. Your change to it was not sent.']);
  });

  it('R live, no L, S there, on a supervisor’s phone: the removal still goes when the server has not moved', () => {
    const before = inStep(phone('supervisor'), 'equipment', 'eq_t14', unit());
    const after = mergeRows(before, [row('equipment', 'eq_t14', unit())], NOW);
    expect(after.equipment).toEqual([]);
    expect(after.synced['equipment:eq_t14']).toBe(revOf(unit()));
  });

  it('R live, no L, S there, the server moved: back, with the notice', () => {
    const before = inStep(phone('supervisor'), 'equipment', 'eq_t14', unit());
    const after = mergeRows(before, [row('equipment', 'eq_t14', unit({ status: 'defect' }))], NOW);
    expect(after.equipment).toEqual([unit({ status: 'defect' })]);
    expect(after.receiving.units.eq_t14).toEqual({ status: 'defect', meter: 1200 });
    expect(words(after)).toEqual([
      'Taking unit T-14 out was not sent: the unit changed after this phone last had it (a checklist, a request or the office). It is back; take it out again if it should go.',
    ]);
  });

  it('R live, no L, S there, on a crew phone: back, with the crew notice', () => {
    const before = inStep(phone('employee'), 'equipment', 'eq_t14', unit());
    const after = mergeRows(before, [row('equipment', 'eq_t14', unit())], NOW);
    expect(after.equipment).toEqual([unit()]);
    expect(words(after)).toEqual(['Taking unit T-14 out was not sent: this phone’s company sign-in is not a supervisor’s. It is back.']);
  });

  it('R live, no L, no S: L = R, and its status and reading become the base', () => {
    const after = mergeRows(phone('employee'), [row('equipment', 'eq_t14', unit({ status: 'defect', meter: 1300 }))], NOW);
    expect(after.equipment).toEqual([unit({ status: 'defect', meter: 1300 })]);
    expect(after.receiving.units).toEqual({ eq_t14: { status: 'defect', meter: 1300 } });
  });

  it('R live, L there, no S: merged with no base, the worse status and the higher reading', () => {
    const after = mergeRows(phone('supervisor', { equipment: [unit({ status: 'defect', meter: 1100 })] }), [row('equipment', 'eq_t14', unit({ model: 'HX 41', meter: 1250 }))], NOW);
    expect(after.equipment).toEqual([unit({ model: 'HX 41', status: 'defect', meter: 1250 })]);
    expect(after.synced['equipment:eq_t14']).toBe(revOf(unit({ model: 'HX 41', meter: 1250 })));
  });

  it('R live, L not changed here: L = R', () => {
    const before = inStep(phone('employee', { equipment: [unit()] }), 'equipment', 'eq_t14', unit());
    const after = mergeRows(before, [row('equipment', 'eq_t14', unit({ model: 'HX 41' }))], NOW);
    expect(after.equipment).toEqual([unit({ model: 'HX 41' })]);
  });

  it('R live, both moved: the office’s fields, the status merged three ways, the higher reading, sent from the server’s version', () => {
    const base = unit();
    const before = inStep(
      phone('employee', { equipment: [unit({ status: 'out_of_service', meter: 1210 })], receiving: { ...freshReceiving(COMPANY, 'employee'), caughtUpAt: NOW, units: { eq_t14: { status: 'ready', meter: 1200 } } } }),
      'equipment',
      'eq_t14',
      base,
    );
    const theirs = unit({ model: 'HX 41', meter: 1205 });
    const after = mergeRows(before, [row('equipment', 'eq_t14', theirs)], NOW);
    expect(after.equipment).toEqual([unit({ model: 'HX 41', status: 'out_of_service', meter: 1210 })]);
    expect(after.receiving.units.eq_t14).toEqual({ status: 'ready', meter: 1205 });
    expect(after.receiving.notices).toEqual([]);
    // The merged unit differs from the server's, so it goes, made from the server's version.
    const sent = changesToSend(dataOf(after), after.synced, new Set()).filter((c) => c.kind === 'equipment');
    expect(sent).toEqual([expect.objectContaining({ key: 'equipment:eq_t14', base: revOf(theirs), record: after.equipment[0] })]);
  });

  it('is never better than this phone’s own open requests on it, and the raise waits to be sent', () => {
    const request: Mrf = {
      id: 'mrf1',
      number: 1001,
      requestedBy: 'emp_lee',
      createdAt: NOW,
      equipmentId: 'eq_t14',
      description: 'Soft brake pedal',
      priority: 'safety',
      items: [],
      taggedOut: true,
      status: 'open',
      history: [{ at: NOW, by: 'emp_lee', status: 'open' }],
    };
    const before = inStep(phone('employee', { equipment: [unit({ status: 'out_of_service' })], mrfs: [request] }), 'equipment', 'eq_t14', unit({ status: 'out_of_service' }));
    const lowered = unit();
    const after = mergeRows(before, [row('equipment', 'eq_t14', lowered)], NOW);
    expect(after.equipment).toEqual([unit({ status: 'out_of_service' })]);
    expect(after.synced['equipment:eq_t14']).toBe(revOf(lowered));
    expect(changesToSend(dataOf(after), after.synced, new Set()).filter((c) => c.kind === 'equipment').map((c) => c.key)).toEqual(['equipment:eq_t14']);

    const done = { ...request, status: 'completed' as const };
    expect(mergeRows({ ...before, mrfs: [done] }, [row('equipment', 'eq_t14', lowered)], NOW).equipment).toEqual([lowered]);
  });
});

describe('the status of a unit, merged', () => {
  it('orders the statuses: out of service, then a defect, then ready', () => {
    expect(worseStatus('ready', 'defect')).toBe('defect');
    expect(worseStatus('out_of_service', 'defect')).toBe('out_of_service');
    expect(worseStatus('ready', 'ready')).toBe('ready');
  });

  it('takes what moved since the base, and the worse of two when both moved or there is no base', () => {
    expect(mergeStatus(undefined, 'defect', 'ready')).toBe('defect');
    expect(mergeStatus(undefined, 'ready', 'out_of_service')).toBe('out_of_service');
    expect(mergeStatus('ready', 'ready', 'out_of_service')).toBe('out_of_service');
    expect(mergeStatus('out_of_service', 'out_of_service', 'ready')).toBe('ready');
    expect(mergeStatus('out_of_service', 'ready', 'out_of_service')).toBe('ready');
    expect(mergeStatus('ready', 'defect', 'out_of_service')).toBe('out_of_service');
  });

  it('reads this phone’s own open requests as the store does', () => {
    const base = { number: 1, requestedBy: 'emp_lee', createdAt: NOW, description: 'x', priority: 'routine' as const, items: [], history: [] };
    expect(statusFromRequests('eq_t14', [])).toBe('ready');
    expect(statusFromRequests('eq_t14', [{ ...base, id: 'a', equipmentId: 'eq_t14', taggedOut: false, status: 'open' }])).toBe('defect');
    expect(statusFromRequests('eq_t14', [{ ...base, id: 'b', equipmentId: 'eq_t14', taggedOut: true, status: 'in_progress' }])).toBe('out_of_service');
    expect(statusFromRequests('eq_t14', [{ ...base, id: 'c', equipmentId: 'eq_t14', taggedOut: true, status: 'completed' }])).toBe('ready');
    expect(statusFromRequests('eq_t14', [{ ...base, id: 'd', equipmentId: 'eq_other', taggedOut: true, status: 'open' }])).toBe('ready');
  });
});

// ---- Reading a row --------------------------------------------------------------------------------------

describe('reading a row', () => {
  type Fixture = { name: string; kind: Kind; id: string; data: unknown; phoneOnly?: boolean };
  const good = fixtures.good as unknown as Fixture[];
  const bad = fixtures.bad as unknown as Fixture[];

  it.each(good.map((f) => [f.name, f] as const))('reads %s', (_, f) => {
    expect(readRecord(f.kind, f.id, f.data)).toEqual(f.data);
  });

  it.each(bad.map((f) => [f.name, f] as const))('does not read %s', (_, f) => {
    expect(readRecord(f.kind, f.id, f.data)).toBeNull();
  });

  it('does not read a private field at any depth, or a reading that is not finite', () => {
    expect(readRecord('areaSheet', 'wash-bay', { ...sheet(), rows: [{ id: 'r1', label: 'Walkways', extra: { PayRates: {} } }] })).toBeNull();
    expect(readRecord('employee', 'emp_lee', { ...person(), passwordHash: 'x' })).toBeNull();
    expect(readRecord('equipment', 'eq_t14', unit({ meter: Infinity }))).toBeNull();
    expect(readRecord('equipment', 'eq_t14', unit({ meter: NaN }))).toBeNull();
    expect(readRecord('equipment', 'eq_t14', [])).toBeNull();
    expect(readRecord('settings', 'company', null)).toBeNull();
  });

  it('knows every type of machine the app has', () => {
    expect([...EQUIPMENT_CATEGORIES].sort()).toEqual(['dozer', 'excavator', 'forklift', 'grader', 'haul_truck', 'light_vehicle', 'loader', 'skid_steer', 'water_truck']);
  });

  it('passes over a row it cannot read: its key kept, the phone’s copy and version unchanged, the cursor past it', () => {
    const before = inStep(phone('supervisor', { areaSheets: [sheet()] }), 'areaSheet', 'wash-bay', sheet());
    const unreadable = row('areaSheet', 'wash-bay', { id: 'wash-bay', name: 'Wash bay' });
    const after = mergeRows(before, [unreadable], NOW);
    expect(after.areaSheets).toEqual([sheet()]);
    expect(after.synced).toEqual(before.synced);
    expect(after.receiving.unreadable).toEqual(['areaSheet:wash-bay']);
    expect(after.receiving.cursor).toBe(unreadable.seq);
    // Read again once it can be: the key comes off the list.
    const fixed = mergeRows({ ...before, ...after }, [row('areaSheet', 'wash-bay', sheet({ title: 'Wash bay north' }))], NOW);
    expect(fixed.receiving.unreadable).toEqual([]);
  });
});

describe('changedFields', () => {
  it('names the fields that differ, in the dashboard’s words', () => {
    expect(changedFields('equipment', unit(), unit({ unit: 'T-15', meter: 1300 }))).toEqual(['last reading', 'unit number']);
    expect(changedFields('areaSheet', sheet(), sheet({ active: false, single: true }))).toEqual(['whether it is in use', 'columns']);
    expect(changedFields('settings', sharedSettings(settings()), sharedSettings(settings({ site: PIN, company: { name: 'Test Pit A', state: 'NV', pay: null, payCodes: { regular: 'R', overtime: 'O', double: 'D', holiday: 'H', pto: 'P', sick: 'S' } } })))).toEqual([
      'earning codes',
      'clock-in site',
    ]);
    expect(listed(['a'])).toBe('a');
    expect(listed(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

// ---- A page --------------------------------------------------------------------------------------------

describe('a page', () => {
  it('moves the cursor to its last row, and an empty page marks the phone caught up', () => {
    const fresh = { ...phone('employee'), receiving: freshReceiving(COMPANY, 'employee') };
    const a = row('areaSheet', 'wash-bay', sheet());
    const b = row('equipment', 'eq_t14', unit());
    const after = mergeRows(fresh, [a, b], NOW);
    expect(after.receiving.cursor).toBe(b.seq);
    expect(after.receiving.caughtUpAt).toBeNull();
    expect(mergeRows({ ...fresh, ...after }, [], NOW + 5).receiving.caughtUpAt).toBe(NOW + 5);
  });

  it('changes nothing when it is applied a second time', () => {
    const before = inStep(phone('supervisor', { areaSheets: [sheet({ title: 'Wash bay north' })], equipment: [unit({ status: 'defect' })] }), 'areaSheet', 'wash-bay', sheet());
    const page = [row('areaSheet', 'wash-bay', sheet({ active: false })), row('equipment', 'eq_t14', unit({ model: 'HX 41' })), row('employee', 'emp_lee', person())];
    const once = mergeRows(before, page, NOW);
    const twice = mergeRows({ ...before, ...once }, page, NOW);
    expect(twice).toEqual(once);
  });

  it('leaves nothing to send that the phone did not change', () => {
    const page = [row('areaSheet', 'wash-bay', sheet()), row('equipment', 'eq_t14', unit()), row('employee', 'emp_lee', person({ payrollId: '9' })), settingsRow(settings({ workweekStartsOn: 2 }))];
    for (const role of ['supervisor', 'employee'] as const) {
      const after = mergeRows(phone(role), page, NOW);
      const sending = changesToSend(dataOf(after), after.synced, new Set());
      // A crew phone's people lack the payroll ID the server holds; a connected phone never sends a person.
      expect(sending.filter((c) => c.kind !== 'employee')).toEqual([]);
    }
  });

  it('keeps at most 20 notices, newest first, and none older than 30 days', () => {
    const old = { id: 'old', at: NOW - 31 * DAY, words: 'Old' };
    const keep = Array.from({ length: 19 }, (_, i) => ({ id: `k${i}`, at: NOW - i * 1000, words: `Kept ${i}` }));
    const before = inStep(phone('employee', { areaSheets: [sheet({ title: 'Wash bay north' })] }), 'areaSheet', 'wash-bay', sheet());
    const after = mergeRows({ ...before, receiving: { ...before.receiving, notices: [...keep, old] } }, [row('areaSheet', 'wash-bay', sheet())], NOW + 1);
    expect(after.receiving.notices).toHaveLength(20);
    expect(after.receiving.notices[0].words).toMatch(/^Your change to the Wash bay north sheet/);
    expect(after.receiving.notices.some((n) => n.id === 'old')).toBe(false);
  });
});

// ---- Who the phone is to the company --------------------------------------------------------------------

describe('standingChange', () => {
  const withPay = [person({ payrollId: '004417' }), person({ id: 'emp_dana', firstName: 'Dana', lastName: 'Fry', role: 'supervisor', payrollId: '1100' })];
  const held = { 'leave:l1': { rev: 'r1', reason: 'supervisor_only' as const } };
  const dana = { firstName: 'Dana', lastName: 'Fry' };

  it('the same role: only the name is taken', () => {
    const before = phone('supervisor', { employees: withPay });
    const after = standingChange(before, { role: 'supervisor', name: dana });
    expect(after.receiving).toEqual({ ...before.receiving, name: dana });
    expect(after.employees).toBe(before.employees);
  });

  it('not on the roster: none, and every payroll ID off', () => {
    const after = standingChange(phone('supervisor', { employees: withPay }), null);
    expect(after.receiving.role).toBe('none');
    expect(after.employees.map((e) => e.payrollId)).toEqual([undefined, undefined]);
  });

  it('made crew: payroll IDs off, what was held still held, and everything read again', () => {
    const before = phone('supervisor', { employees: withPay });
    const after = standingChange({ ...before, receiving: { ...before.receiving, held } }, { role: 'employee', name: dana });
    expect(after.receiving).toMatchObject({ role: 'employee', name: dana, held, cursor: 0, epoch: before.receiving.epoch + 1 });
    expect(after.employees.map((e) => e.payrollId)).toEqual([undefined, undefined]);
    // Read again, the company's sheet goes back over the supervisor's edit not yet sent, with its notice.
    const edited = inStep({ ...before, ...after, areaSheets: [sheet({ title: 'Wash bay north' })] }, 'areaSheet', 'wash-bay', sheet());
    expect(words(mergeRows(edited, [row('areaSheet', 'wash-bay', sheet())], NOW))).toEqual([
      'Your change to the Wash bay north sheet was not sent: this phone’s company sign-in is no longer a supervisor’s. This phone shows the company’s version.',
    ]);
  });

  it('made a supervisor: what was held goes again, and everything is read again', () => {
    const before = phone('employee', { employees: [person()] });
    const after = standingChange({ ...before, receiving: { ...before.receiving, held } }, { role: 'supervisor', name: dana });
    expect(after.receiving).toMatchObject({ role: 'supervisor', held: {}, cursor: 0, epoch: before.receiving.epoch + 1 });
  });

  it('back on the roster from none, or the first read from nothing: a change of role', () => {
    const none = standingChange(phone('none', { employees: withPay }), { role: 'employee', name: dana });
    expect(none.receiving).toMatchObject({ role: 'employee', cursor: 0 });
    const first = standingChange(phone(null, { employees: withPay }), { role: 'employee', name: dana });
    expect(first.receiving.role).toBe('employee');
    expect(first.employees.map((e) => e.payrollId)).toEqual([undefined, undefined]);
    const firstBoss = standingChange(phone(null, { employees: withPay }), { role: 'supervisor', name: dana });
    expect(firstBoss.employees).toEqual(withPay);
  });
});

/** The records changesToSend reads, from the merged state. */
function dataOf(state: ReturnType<typeof mergeRows>): SyncData {
  return {
    employees: state.employees,
    equipment: state.equipment,
    areaSheets: state.areaSheets,
    settings: state.settings,
    shifts: [],
    denied: [],
    leave: [],
    inspections: [],
    opLogs: [],
    exams: [],
    mrfs: [],
  } as SyncData;
}

describe('notTakenWords', () => {
  const people = [person(), person({ id: 'emp_dana', firstName: 'Dana', lastName: 'Fry', role: 'supervisor' })];
  const day = new Date(2026, 10, 13, 9).getTime();
  const data = {
    employees: people,
    equipment: [unit()],
    areaSheets: [sheet()],
    leave: [{ id: 'lv1', employeeId: 'emp_lee', day, type: 'pto' as const, hours: 800, enteredBy: 'emp_dana', at: day }],
    shifts: [{ id: 'sh1', employeeId: 'emp_lee', clockIn: { at: day }, lunches: [], breaks: [] }],
    mrfs: [{ id: 'mrf1', number: 1042, requestedBy: 'emp_lee', createdAt: day, description: 'x', priority: 'routine' as const, items: [], taggedOut: false, status: 'open' as const, history: [], assignedTo: 'emp_dana' }],
  };
  const change = (key: string) => ({ key, kind: key.slice(0, key.indexOf(':')) as never, id: key.slice(key.indexOf(':') + 1), rev: 'r1', record: {} });

  it('names what was not taken the way the person knows it', () => {
    expect(notTakenWords(change('leave:lv1'), 'supervisor_only', data).what).toBe('Paid leave for Lee Park on Fri, Nov 13');
    expect(notTakenWords(change('shift:sh1'), 'supervisor_only', data).what).toBe('A correction to Lee Park’s shift on Fri, Nov 13');
    expect(notTakenWords(change('mrf:mrf1'), 'supervisor_only', data).what).toBe('Request #1042 assigned to Dana Fry');
    expect(notTakenWords(change('equipment:eq_t14'), 'supervisor_only', data).what).toBe('Unit T-14');
    expect(notTakenWords(change('areaSheet:wash-bay'), 'supervisor_only', data).what).toBe('The Wash bay sheet');
    expect(notTakenWords(change('settings:company'), 'supervisor_only', data).what).toBe('The company settings');
  });

  it('says why, and what to do', () => {
    expect(notTakenWords(change('leave:lv1'), 'supervisor_only', data).why).toBe(
      'Only a supervisor’s company sign-in can send this. Enter it on the dashboard, or join this phone with a supervisor’s sign-in on Company account.',
    );
    expect(notTakenWords(change('shift:sh1'), 'not_yours', data).why).toBe('Another person’s record: the company keeps theirs.');
    expect(notTakenWords(change('shift:sh1'), 'signed', data).why).toBe('Already signed: a signed record is not changed.');
    expect(notTakenWords(change('equipment:eq_t14'), 'malformed', data).why).toBe('The company’s server would not take it as it is. Tell the office.');
  });
});
