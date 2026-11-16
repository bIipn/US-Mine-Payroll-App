import { AREA_CONDITIONS, examFindings, openFindings, parseAreaSheets, type ExamDraft } from '../../domain/areaExam';
import { toGeoStamp } from '../../domain/geofence';
import { DEFAULT_SITE } from '../../domain/site';
import { checklistFor } from '../../domain/templates';
import { shiftFlags, shiftTotals } from '../../domain/time';
import type { InspectionAnswer } from '../../domain/types';
import { parseRoster } from '../../domain/roster';
import { openShiftOf, useStore } from '../useStore';

const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m, 0).getTime();
const onSite = toGeoStamp(DEFAULT_SITE, { ...DEFAULT_SITE.center, accuracyM: 5 }, 'gps');
const s = () => useStore.getState();
const unit = (name: string) => s().equipment.find((e) => e.unit === name)!;
const answers = (name: string, bad: Record<string, Partial<InspectionAnswer>> = {}): InspectionAnswer[] =>
  checklistFor(unit(name).category).items.map((i) => ({ itemId: i.id, answer: 'ok', ...bad[i.id] }));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(at(6, 15));
  s().resetDemo();
});
afterEach(() => jest.useRealTimers());

describe('accounts', () => {
  it('lets only roster names sign up, once, and checks the password at sign-in', () => {
    const input = { firstName: 'Pat', lastName: 'Nobody', email: 'pat@example.com', password: 'haulroad88' };
    expect(s().signUp(input)).toMatchObject({ ok: false });
    expect(s().signUp({ ...input, firstName: ' jordan ', lastName: 'RIVERA', password: 'short' })).toMatchObject({ ok: false });
    expect(s().signUp({ ...input, firstName: ' jordan ', lastName: 'RIVERA' })).toEqual({ ok: true });
    expect(s().session?.employeeId).toBe('emp_demo');
    // The password itself is never kept, only a salted hash.
    const account = s().accounts.find((a) => a.email === 'pat@example.com')!;
    expect(account.passwordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(account)).not.toContain('haulroad88');

    s().signOut();
    expect(s().signUp({ ...input, email: 'other@example.com', firstName: 'Jordan', lastName: 'Rivera' })).toMatchObject({ ok: false });
    expect(s().signIn('pat@example.com', 'wrong-password')).toMatchObject({ ok: false });
    expect(s().signIn('PAT@example.com ', 'haulroad88')).toEqual({ ok: true });
  });

  it('stops a removed person from signing in', () => {
    s().signUp({ firstName: 'Jordan', lastName: 'Rivera', email: 'j@example.com', password: 'haulroad88' });
    s().signOut();
    s().setEmployeeActive('emp_demo', false);
    expect(s().signIn('j@example.com', 'haulroad88')).toMatchObject({ ok: false });
  });

  it('reads pasted roster lists in either name order and skips repeats', () => {
    expect(s().addEmployeesBulk('Alex Carter\nMorgan, Riley\n3. sam ortiz\nJordan Rivera\nCher')).toEqual({ added: 3, skipped: 2 });
    expect(s().employees.some((e) => e.firstName === 'Riley' && e.lastName === 'Morgan')).toBe(true);
    expect(s().employees.some((e) => e.firstName === 'Sam' && e.lastName === 'Ortiz')).toBe(true);
  });
});

describe('the build owner', () => {
  const owner = { firstName: 'Riley', lastName: 'Quinn' };
  const signUp = () => s().signUp({ firstName: 'riley', lastName: 'QUINN', email: 'riley@example.com', password: 'haulroad88' });

  it('is on the roster from the first start, so they can create their own account', () => {
    s().ensureSeeded(owner);
    expect(signUp()).toEqual({ ok: true });
    const me = s().employees.find((e) => e.id === s().session?.employeeId)!;
    expect(me).toMatchObject({ firstName: 'Riley', lastName: 'Quinn', role: 'supervisor', active: true });
    // The name comes with no made-up hours, leave or pre-ops.
    expect(s().shifts.some((x) => x.employeeId === me.id)).toBe(false);
    expect(s().leave.some((x) => x.employeeId === me.id)).toBe(false);
    expect(s().inspections.some((x) => x.employeeId === me.id)).toBe(false);
  });

  it('is added once, to a roster that was already saved on the phone', () => {
    const before = s().employees.length;
    s().ensureSeeded(owner);
    s().ensureSeeded(owner);
    expect(s().employees).toHaveLength(before + 1);
    expect(s().shifts.length).toBeGreaterThan(100); // the saved records are untouched
  });

  it('is still there after the sample data is reset', () => {
    s().resetDemo(owner);
    expect(signUp()).toEqual({ ok: true });
  });

  it('is nobody when the build names no owner', () => {
    s().ensureSeeded(null);
    expect(signUp()).toMatchObject({ ok: false });
  });
});

describe("a build's own roster", () => {
  const people = parseRoster('Ortiz, Sam | Crusher\nQuinn, Riley J | Maintenance | supervisor\nVance III, Lee "Buck" | Bagging plant');
  const account = (firstName: string, lastName: string) => ({
    firstName, lastName, email: `${firstName.replace(/\W/g, '')}@example.com`.toLowerCase(), password: 'haulroad88',
  });
  const me = () => s().employees.find((e) => e.id === s().session?.employeeId);

  it('puts everyone it names on the roster with their job title, and makes nothing up for them', () => {
    s().ensureSeeded(null, undefined, people);
    expect(s().employees.find((e) => e.lastName === 'Ortiz')).toMatchObject({ firstName: 'Sam', title: 'Crusher', role: 'employee', active: true });
    const named = s().employees.filter((e) => e.id.startsWith('ros_'));
    expect(named).toHaveLength(3);
    for (const person of named) {
      const theirs = (list: { employeeId: string }[]) => list.some((x) => x.employeeId === person.id);
      expect([theirs(s().shifts), theirs(s().leave), theirs(s().inspections), theirs(s().opLogs), theirs(s().exams), theirs(s().accounts)]).toEqual(Array(6).fill(false));
      expect(s().mrfs.some((m) => [m.requestedBy, m.assignedTo, m.completedBy].includes(person.id))).toBe(false);
      expect(s().payRates[person.id]).toBeUndefined();
    }
  });

  it('lets them sign up under the name they go by', () => {
    s().ensureSeeded(null, undefined, people);
    expect(s().signUp(account('Buck', 'Vance'))).toEqual({ ok: true });
    expect(me()).toMatchObject({ firstName: 'Lee "Buck"', lastName: 'Vance III', role: 'employee' });
    s().signOut();
    expect(s().signUp(account('riley', 'quinn'))).toEqual({ ok: true });
    expect(me()).toMatchObject({ firstName: 'Riley J', role: 'supervisor', title: 'Maintenance' });
    s().signOut();
    expect(s().signInWithProvider('google', 'Sam', 'Ortiz')).toEqual({ ok: true });
    expect(me()).toMatchObject({ lastName: 'Ortiz' });
  });

  it('asks for the whole name when a name fits more than one person', () => {
    s().ensureSeeded(null, undefined, parseRoster('Park, Lee Roy\nPark, Roy "Lee"'));
    expect(s().signUp(account('Roy', 'Park'))).toEqual({
      ok: false,
      error: 'More than one person on the roster goes by "Roy Park". Type your name the way it is on the roster.',
    });
    expect(s().signUp(account('Lee Roy', 'Park'))).toEqual({ ok: true });
  });

  it('is added once, and is still there after the sample data is reset', () => {
    const before = s().employees.length;
    s().ensureSeeded(null, undefined, people);
    s().ensureSeeded(null, undefined, people);
    expect(s().employees).toHaveLength(before + 3);
    s().resetDemo(null, undefined, people);
    expect(s().employees).toHaveLength(before + 3);
  });

  it('has the owner on it once, as a supervisor, with the job title the roster gives them', () => {
    s().ensureSeeded({ firstName: 'Sam', lastName: 'Ortiz' }, undefined, people);
    const sams = s().employees.filter((e) => e.lastName === 'Ortiz');
    expect(sams).toEqual([expect.objectContaining({ firstName: 'Sam', role: 'supervisor', title: 'Crusher' })]);
  });

  it('starts the sample crew apart from the people it names: nobody made up has the last name of someone real', () => {
    // The sample crew comes with a Torres and a Bell. This build names a Torres of its own, and its owner is a Bell.
    const mine = parseRoster('Torres, Pat | Crusher');
    const owner = { firstName: 'Lou', lastName: 'Bell' };
    const check = () => {
      const madeUp = s().employees.filter((e) => !e.id.startsWith('ros_') && !e.id.startsWith('own_'));
      expect(madeUp).toHaveLength(14);
      expect(madeUp.filter((e) => ['Torres', 'Bell'].includes(e.lastName))).toEqual([]);
      expect(s().employees.filter((e) => ['Torres', 'Bell'].includes(e.lastName)).map((e) => e.firstName).sort()).toEqual(['Lou', 'Pat']);
      // The made-up people keep their hours under the name they were given.
      expect(s().shifts.some((shift) => shift.employeeId === 'e03')).toBe(true);
    };
    s().resetDemo(owner, undefined, mine);
    check();
    // A phone opening the build for the first time starts with the same crew.
    useStore.setState({ seededAt: null });
    s().ensureSeeded(owner, undefined, mine);
    check();
  });

  it('keeps a made-up email for a sign-in with Apple, Google or Microsoft free of anything but letters', () => {
    s().ensureSeeded(null, undefined, people);
    s().signInWithProvider('apple', 'Lee', 'Vance');
    expect(s().accounts.find((a) => a.employeeId === me()?.id)?.email).toBe('lee.buck.vance.iii@example.com');
  });
});

describe('a build with nobody made up', () => {
  const people = parseRoster('Ortiz, Sam | Crusher\nQuinn, Riley J | Maintenance | supervisor');
  const owner = { firstName: 'Sam', lastName: 'Ortiz' };
  const account = (firstName: string, lastName: string) => ({
    firstName, lastName, email: `${firstName.replace(/\W/g, '')}@example.com`.toLowerCase(), password: 'haulroad88',
  });
  const me = () => s().employees.find((e) => e.id === s().session?.employeeId);

  beforeEach(() => {
    s().resetDemo(owner, undefined, people, false);
  });

  it('starts with the people it names and nobody else, and nothing that happened', () => {
    expect(s().employees.map((e) => `${e.lastName}, ${e.firstName}`).sort()).toEqual(['Ortiz, Sam', 'Quinn, Riley J']);
    expect([s().accounts, s().shifts, s().leave, s().denied, s().inspections, s().opLogs, s().exams, s().mrfs]).toEqual(Array(8).fill([]));
    expect(s().payRates).toEqual({});
    // The fleet and the work areas are there to be used.
    expect(s().equipment).toHaveLength(14);
    expect(s().equipment.every((e) => e.status === 'ready')).toBe(true);
    expect(s().areaSheets.length).toBeGreaterThan(0);
    expect(s().session).toBeNull();
  });

  it('starts a phone opening it for the first time the same way', () => {
    useStore.setState({ seededAt: null });
    s().ensureSeeded(owner, undefined, people, false);
    expect(s().employees).toHaveLength(2);
    expect(s().shifts).toEqual([]);
    // Opening it again keeps what is there.
    s().openAsOwner(owner);
    s().clockIn(onSite);
    s().ensureSeeded(owner, undefined, people, false);
    expect(s().shifts).toHaveLength(1);
  });

  it('has no sample person to open the preview as', () => {
    expect(s().signInDemo('employee')).toMatchObject({ ok: false });
    expect(s().signInDemo('supervisor')).toMatchObject({ ok: false });
    expect(s().session).toBeNull();
  });

  it('opens as the person the build is made for, with no account to set up first', () => {
    expect(s().openAsOwner(owner)).toEqual({ ok: true });
    expect(me()).toMatchObject({ firstName: 'Sam', lastName: 'Ortiz', role: 'supervisor', title: 'Crusher' });
    s().signOut();
    expect(s().openAsOwner(owner)).toEqual({ ok: true });
    expect(s().accounts).toHaveLength(1);
    // They can still set a password of their own afterwards.
    s().signOut();
    expect(s().signUp(account('Sam', 'Ortiz'))).toEqual({ ok: true });
    expect(s().accounts).toHaveLength(1);
    expect(s().signIn('sam@example.com', 'haulroad88')).toEqual({ ok: true });
  });

  it('opens as nobody when the build names no owner, or the owner is off the roster', () => {
    expect(s().openAsOwner(null)).toMatchObject({ ok: false });
    expect(s().openAsOwner({ firstName: 'Pat', lastName: 'Nobody' })).toMatchObject({ ok: false });
    // Another supervisor takes the owner off the roster.
    s().signUp(account('Riley', 'Quinn'));
    s().setEmployeeActive(s().employees.find((e) => e.lastName === 'Ortiz')!.id, false);
    s().signOut();
    expect(s().openAsOwner(owner)).toMatchObject({ ok: false });
    expect(s().session).toBeNull();
  });

  it('is ready to work in: a punch, a checklist, an exam and a request, all under real names', () => {
    s().openAsOwner(owner);
    expect(s().clockIn(onSite)).toMatchObject({ ok: true });
    const l12 = unit('L-12');
    expect(s().submitInspection({ equipmentId: l12.id, startedAt: Date.now(), meter: l12.meter, answers: answers('L-12') })).toMatchObject({ ok: true });
    const sheet = s().areaSheets[0];
    expect(s().submitExam({
      sheetId: sheet.id, shift: 'day', startedAt: Date.now() - 600_000, others: [],
      rows: Object.fromEntries(sheet.rows.map((r) => [r.id, { answer: 'ok' as const }])),
      conditions: Object.fromEntries(AREA_CONDITIONS.map((c) => [c.id, { answer: 'ok' as const }])),
    })).toMatchObject({ ok: true });
    expect(s().createMrf({ equipmentId: l12.id, location: 'Shop', priority: 'routine', description: 'Wiper blade is worn', items: [], taggedOut: false })).toMatchObject({ ok: true, mrf: { number: 1001 } });
    const mine = me()!.id;
    expect(s().shifts.map((x) => x.employeeId)).toEqual([mine]);
    expect(s().inspections.map((x) => x.employeeId)).toEqual([mine]);
    expect(s().exams.map((x) => x.employeeId)).toEqual([mine]);
  });

  it('comes back to the same start when the device is cleared', () => {
    s().openAsOwner(owner);
    s().clockIn(onSite);
    s().resetDemo(owner, undefined, people, false);
    expect(s().shifts).toEqual([]);
    expect(s().employees).toHaveLength(2);
    expect(s().session).toBeNull();
  });
});

describe('time clock', () => {
  beforeEach(() => {
    s().signInDemo('employee');
  });

  it('runs a whole day with one tap for lunch and pays it the timesheet way', () => {
    expect(s().clockIn(onSite)).toMatchObject({ ok: true });
    expect(s().clockIn(onSite)).toMatchObject({ ok: false });
    jest.setSystemTime(at(11, 0));
    const lunch = s().startLunch(onSite);
    // The end of lunch is set the moment it starts: 30 minutes on, with no punch to make.
    expect(lunch).toMatchObject({ ok: true, shift: { lunches: [{ start: { at: at(11, 0), geo: onSite }, end: { at: at(11, 30), auto: true } }] } });
    jest.setSystemTime(at(11, 20));
    expect(s().startLunch(onSite)).toMatchObject({ ok: false }); // already at lunch
    expect(s().clockOut(onSite)).toMatchObject({ ok: false, error: 'You are at lunch until 11:30 AM. Clock out after that.' });
    jest.setSystemTime(at(19, 0));
    const result = s().clockOut(onSite);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const totals = shiftTotals(result.shift, Date.now());
    expect([totals.gross, totals.lunch, totals.paid]).toEqual([1275, 50, 1225]);
    expect(openShiftOf(s().shifts, 'emp_demo', Date.now())).toBeUndefined();
  });

  it('has no end-of-lunch punch, so a lunch cannot be cut short', () => {
    expect('endLunch' in s()).toBe(false);
  });

  it('puts the person back on the clock after 30 minutes and allows a second lunch later', () => {
    s().clockIn(onSite);
    jest.setSystemTime(at(10, 0));
    s().startLunch(onSite);
    jest.setSystemTime(at(10, 30));
    expect(shiftTotals(openShiftOf(s().shifts, 'emp_demo', Date.now())!, Date.now()).onLunch).toBe(false);
    jest.setSystemTime(at(16, 0));
    expect(s().startLunch(onSite)).toMatchObject({ ok: true });
    const shift = openShiftOf(s().shifts, 'emp_demo', Date.now())!;
    expect(shift.lunches.map((l) => [l.start.at, l.end?.at])).toEqual([[at(10, 0), at(10, 30)], [at(16, 0), at(16, 30)]]);
  });

  it('keeps an audit trail when a supervisor corrects a shift', () => {
    s().clockIn(onSite);
    jest.setSystemTime(at(15, 0));
    const shiftId = openShiftOf(s().shifts, 'emp_demo', Date.now())!.id;
    s().signInDemo('supervisor');
    expect(s().editShiftTimes(shiftId, { clockOut: at(14, 45) }, '')).toMatchObject({ ok: false });
    expect(s().editShiftTimes(shiftId, { clockOut: at(5, 0) }, 'typo')).toMatchObject({ ok: false });
    expect(s().editShiftTimes(shiftId, { lunchStart: at(10, 30) }, 'lunch')).toMatchObject({ ok: false });
    expect(s().editShiftTimes(shiftId, { clockOut: at(14, 45), lunchStart: at(10, 30), lunchEnd: at(11, 0) }, 'Forgot to punch')).toEqual({ ok: true });
    const shift = s().shifts.find((x) => x.id === shiftId)!;
    expect(shiftTotals(shift, Date.now()).paid).toBe(800);
    expect(shift.edits).toHaveLength(3);
    expect(shift.edits?.every((e) => e.byEmployeeId === 'sup_demo' && e.reason === 'Forgot to punch')).toBe(true);
    expect(shiftFlags(shift, Date.now())).toEqual(['edited']);
  });

  it('stops calling a lunch end automatic once a supervisor moves the lunch', () => {
    s().clockIn(onSite);
    jest.setSystemTime(at(11, 0));
    s().startLunch(onSite);
    jest.setSystemTime(at(15, 0));
    const shiftId = openShiftOf(s().shifts, 'emp_demo', Date.now())!.id;
    const lunch = () => s().shifts.find((x) => x.id === shiftId)!.lunches[0];
    expect(lunch().end?.auto).toBe(true);
    s().signInDemo('supervisor');
    // A correction to something else leaves the lunch as it was recorded.
    expect(s().editShiftTimes(shiftId, { clockIn: at(6, 0) }, 'Came in early')).toEqual({ ok: true });
    expect(lunch().end).toEqual({ at: at(11, 30), auto: true });
    // Moving the start makes it a 45-minute lunch that a supervisor set, not an automatic one.
    expect(s().editShiftTimes(shiftId, { lunchStart: at(10, 45) }, 'Started lunch earlier')).toEqual({ ok: true });
    expect(lunch().start.at).toBe(at(10, 45));
    expect(lunch().end?.at).toBe(at(11, 30));
    expect(lunch().end?.auto).toBeUndefined();
  });
});

describe('equipment', () => {
  beforeEach(() => {
    s().signInDemo('employee');
  });

  it('checks a unit out on a clean checklist and back in at end of use', () => {
    const l12 = unit('L-12');
    const result = s().submitInspection({
      equipmentId: l12.id, startedAt: Date.now(), meter: l12.meter + 1, answers: answers('L-12'),
      fuelGal: 18, comments: '  Greased the pins ',
    });
    expect(result).toMatchObject({
      ok: true,
      inspection: { result: 'pass', templateId: 'operator_equipment_checklist', fuelGal: 18, comments: 'Greased the pins' },
    });
    const log = s().opLogs.find((l) => l.equipmentId === l12.id && !l.endAt)!;
    expect(log.employeeId).toBe('emp_demo');
    expect(s().endUse(log.id, { endMeter: l12.meter - 5, parkedSafely: true })).toMatchObject({ ok: false });
    expect(s().endUse(log.id, { endMeter: l12.meter + 6.5, fuelGal: 40, parkedSafely: true })).toEqual({ ok: true });
    expect(unit('L-12').meter).toBe(l12.meter + 6.5);
  });

  it('will not sign a checklist with a line left blank', () => {
    const l12 = unit('L-12');
    const before = s().inspections.length;
    const short = answers('L-12').filter((a) => a.itemId !== 'bed_condition');
    expect(s().submitInspection({ equipmentId: l12.id, startedAt: Date.now(), meter: l12.meter, answers: short })).toEqual({
      ok: false, error: 'Mark every line OK, BO or N/A. 1 is still blank.',
    });
    const silent = answers('L-12', { lights: { answer: 'bo', note: '  ' } });
    expect(s().submitInspection({ equipmentId: l12.id, startedAt: Date.now(), meter: l12.meter, answers: silent })).toEqual({
      ok: false, error: 'Say what is wrong on each Bad Order.',
    });
    expect(s().inspections).toHaveLength(before);
    // A card needs the hours off the machine: a reading that is not a number never reaches the fleet list.
    for (const meter of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(s().submitInspection({ equipmentId: l12.id, startedAt: Date.now(), meter, answers: answers('L-12') })).toEqual({
        ok: false, error: 'Enter the reading off the machine.',
      });
    }
    expect(unit('L-12').meter).toBe(l12.meter);
    expect(s().inspections).toHaveLength(before);
    // A mark that is not OK, BO or N/A is a line still blank.
    const odd = answers('L-12', { gauges: { answer: 'fine' as unknown as InspectionAnswer['answer'] } });
    expect(s().submitInspection({ equipmentId: l12.id, startedAt: Date.now(), meter: l12.meter, answers: odd })).toEqual({
      ok: false, error: 'Mark every line OK, BO or N/A. 1 is still blank.',
    });
    expect(s().inspections).toHaveLength(before);
  });

  it('signs nothing that was written on a line and then changed back to OK', () => {
    const l12 = unit('L-12');
    const result = s().submitInspection({
      equipmentId: l12.id, startedAt: Date.now(), meter: l12.meter,
      answers: answers('L-12', { brakes: { answer: 'ok', note: 'Pedal fades', hazard: true }, lights: { answer: 'bo', note: ' Left work light out ' } }),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.inspection.result).toBe('defect');
    expect(result.inspection.answers.find((a) => a.itemId === 'brakes')).toEqual({ itemId: 'brakes', answer: 'ok' });
    expect(result.inspection.answers.find((a) => a.itemId === 'lights')).toEqual({ itemId: 'lights', answer: 'bo', note: 'Left work light out' });
    expect(unit('L-12').status).toBe('defect');
  });

  it('signs a checklist once, however many times the button lands', () => {
    const l12 = unit('L-12');
    const before = s().inspections.length;
    const draft = { equipmentId: l12.id, startedAt: Date.now() - 300_000, meter: l12.meter, answers: answers('L-12') };
    const first = s().submitInspection(draft);
    expect(s().submitInspection(draft)).toEqual(first);
    expect(s().inspections).toHaveLength(before + 1);
    expect(s().opLogs.filter((l) => l.equipmentId === l12.id && !l.endAt)).toHaveLength(1);
  });

  it('takes a unit out of service on a safety Bad Order until the request is completed', () => {
    const l12 = unit('L-12');
    const result = s().submitInspection({
      equipmentId: l12.id, startedAt: Date.now(), meter: l12.meter,
      answers: answers('L-12', { brakes: { answer: 'bo', note: 'Pedal fades' } }),
    });
    expect(result).toMatchObject({ ok: true, inspection: { result: 'bad_order' } });
    expect(unit('L-12').status).toBe('out_of_service');
    expect(s().opLogs.some((l) => l.equipmentId === l12.id && !l.endAt)).toBe(false);
    if (!result.ok) return;

    expect(s().createMrf({ equipmentId: l12.id, priority: 'safety', description: ' ', taggedOut: true })).toMatchObject({ ok: false });
    const mrf = s().createMrf({ equipmentId: l12.id, priority: 'safety', description: 'Service brakes fade', taggedOut: true, inspectionId: result.inspection.id });
    expect(mrf).toMatchObject({ ok: true, mrf: { number: 1045, status: 'open' } });
    expect(s().inspections.find((i) => i.id === result.inspection.id)?.mrfId).toBeDefined();

    s().signInDemo('supervisor');
    if (!mrf.ok) return;
    expect(s().startMrf(mrf.mrf.id)).toEqual({ ok: true });
    expect(unit('L-12').status).toBe('out_of_service');
    expect(s().completeMrf(mrf.mrf.id, { remarks: 'Replaced master cylinder' })).toEqual({ ok: true });
    expect(unit('L-12').status).toBe('ready');
    expect(s().mrfs.find((m) => m.id === mrf.mrf.id)?.history).toHaveLength(3);
  });

  it('reports a lesser defect without parking the unit, and lets the operator escalate it', () => {
    const wt = unit('WT-01');
    const defect = s().submitInspection({
      equipmentId: wt.id, startedAt: Date.now(), meter: wt.meter,
      answers: answers('WT-01', { lights: { answer: 'bo', note: 'Left tail light out' } }),
    });
    expect(defect).toMatchObject({ ok: true, inspection: { result: 'defect' } });
    expect(unit('WT-01').status).toBe('defect');
    if (!defect.ok) return;
    s().decideAfterDefect(defect.inspection.id, 'operate');
    expect(s().opLogs.some((l) => l.equipmentId === wt.id && !l.endAt && l.employeeId === 'emp_demo')).toBe(true);

    const g = unit('G-02');
    const escalated = s().submitInspection({
      equipmentId: g.id, startedAt: Date.now(), meter: g.meter,
      answers: answers('G-02', { tires: { answer: 'bo', note: 'Sidewall cut to the cords', hazard: true } }),
    });
    expect(escalated).toMatchObject({ ok: true, inspection: { result: 'bad_order' } });
    expect(unit('G-02').status).toBe('out_of_service');
  });
});

describe('maintenance requests', () => {
  const request = (description = 'Tail roller is seized') => {
    s().signInDemo('employee');
    const result = s().createMrf({ location: ' Bagging plant, bag conveyor ', priority: 'high', description, taggedOut: false });
    if (!result.ok) throw new Error(result.error);
    return result.mrf;
  };
  const saved = (id: string) => s().mrfs.find((m) => m.id === id)!;

  it('can be for a place in the plant instead of a fleet unit', () => {
    const mrf = request();
    expect(mrf).toMatchObject({ requestedBy: 'emp_demo', location: 'Bagging plant, bag conveyor', status: 'open', createdAt: at(6, 15) });
    expect(mrf.equipmentId).toBeUndefined();
    expect(s().createMrf({ priority: 'high', description: 'Something is loose', taggedOut: false })).toEqual({
      ok: false, error: 'Say where the problem is, or pick the unit it is on.',
    });
  });

  it('is sent once, however many times the button lands', () => {
    const first = request();
    const before = s().mrfs.length;
    expect(s().createMrf({ location: 'Bagging plant, bag conveyor', priority: 'high', description: 'Tail roller is seized', taggedOut: false })).toEqual({
      ok: false, error: `That request is already in: #${first.number}.`,
    });
    expect(s().mrfs).toHaveLength(before);
    // Something else wrong in the same place is a request of its own.
    expect(s().createMrf({ location: 'Bagging plant, bag conveyor', priority: 'high', description: 'Belt is tracking off', taggedOut: false })).toMatchObject({ ok: true });
  });

  it('is not sent for a unit or a checklist that is not there', () => {
    s().signInDemo('employee');
    const before = s().mrfs.length;
    const l12 = unit('L-12');
    expect(s().createMrf({ equipmentId: 'eq_nowhere', priority: 'high', description: 'Loose step', taggedOut: false })).toEqual({
      ok: false, error: 'That unit is no longer in the fleet list.',
    });
    expect(s().createMrf({ equipmentId: l12.id, inspectionId: 'insp_nowhere', priority: 'high', description: 'Loose step', taggedOut: false })).toEqual({
      ok: false, error: 'That checklist is not on record for this unit.',
    });
    // A checklist made on another unit cannot be attached to this one.
    const other = s().inspections.find((i) => i.equipmentId !== l12.id)!;
    expect(s().createMrf({ equipmentId: l12.id, inspectionId: other.id, priority: 'high', description: 'Loose step', taggedOut: false })).toMatchObject({ ok: false });
    expect(s().mrfs).toHaveLength(before);
  });

  it('is sent once for a checklist: the next one says which request is already in', () => {
    s().signInDemo('employee');
    const wt = unit('WT-01');
    const check = s().submitInspection({
      equipmentId: wt.id, startedAt: Date.now(), meter: wt.meter,
      answers: answers('WT-01', { lights: { answer: 'bo', note: 'Left tail light out' } }),
    });
    if (!check.ok) throw new Error(check.error);
    const input = { equipmentId: wt.id, inspectionId: check.inspection.id, priority: 'high' as const, taggedOut: false };
    const first = s().createMrf({ ...input, description: 'Left tail light is out' });
    if (!first.ok) throw new Error(first.error);
    expect(s().createMrf({ ...input, description: 'Tail light, again' })).toEqual({
      ok: false, error: `Maintenance request #${first.mrf.number} is already in for this checklist.`,
    });
    expect(s().inspections.find((i) => i.id === check.inspection.id)?.mrfId).toBe(first.mrf.id);
  });

  it('fills in the rest of the paper form as the work is done', () => {
    const { id } = request();
    s().signInDemo('supervisor');
    expect(s().assignMrf(id, 'emp_demo')).toEqual({ ok: true });
    expect(saved(id)).toMatchObject({ assignedTo: 'emp_demo', status: 'open' });

    // The person it is assigned to does the work and signs it off.
    s().signInDemo('employee');
    jest.setSystemTime(at(8, 0));
    expect(s().startMrf(id, 'Conveyor locked out')).toEqual({ ok: true });
    jest.setSystemTime(at(9, 30));
    expect(s().completeMrf(id, { remarks: ' Replaced the tail roller and ran it for ten minutes ', timeSpent: 150 })).toEqual({ ok: true });
    expect(saved(id)).toMatchObject({
      status: 'completed',
      assignedTo: 'emp_demo',
      completedAt: at(9, 30),
      completedBy: 'emp_demo',
      timeSpent: 150,
      remarks: 'Replaced the tail roller and ran it for ten minutes',
    });
    expect(saved(id).history.map((h) => [h.status, h.by, h.assignedTo])).toEqual([
      ['open', 'emp_demo', undefined],
      ['open', 'sup_demo', 'emp_demo'],
      ['in_progress', 'emp_demo', undefined],
      ['completed', 'emp_demo', undefined],
    ]);
  });

  it('is worked only by a supervisor or the person it is assigned to', () => {
    const { id } = request();
    expect(s().assignMrf(id, 'emp_demo')).toMatchObject({ ok: false });
    expect(s().startMrf(id)).toMatchObject({ ok: false });
    expect(s().completeMrf(id, { remarks: 'Done' })).toMatchObject({ ok: false });
    expect([saved(id).status, saved(id).assignedTo]).toEqual(['open', undefined]);
    s().signInDemo('supervisor');
    expect(s().assignMrf(id, 'nobody')).toMatchObject({ ok: false });
    // Not to someone who has been taken off the roster, and not once it is completed.
    s().setEmployeeActive('e06', false);
    expect(s().assignMrf(id, 'e06')).toEqual({ ok: false, error: 'Pick someone on the roster.' });
    expect(s().completeMrf(id, { remarks: 'Replaced the tail roller' })).toEqual({ ok: true });
    expect(s().assignMrf(id, 'e03')).toEqual({ ok: false, error: 'That request is already completed.' });
    expect(s().assignMrf('mrf_nowhere', 'e03')).toEqual({ ok: false, error: 'That request no longer exists.' });
  });

  it('is completed by whoever closes it, unless a supervisor says the person it is assigned to did the work', () => {
    let belt = 0;
    const closedBy = (input: { completedBy?: string }, as: 'supervisor' | 'employee' = 'supervisor', assignTo = 'e06') => {
      const { id } = request(`Tail roller is seized on belt ${++belt}`);
      s().signInDemo('supervisor');
      s().assignMrf(id, assignTo);
      s().signInDemo(as);
      const result = s().completeMrf(id, { remarks: `Replaced the tail roller ${id}`, ...input });
      return { result, mrf: saved(id) };
    };
    // Said nothing: the name on the form is the person who closed it.
    const plain = closedBy({});
    expect([plain.result, plain.mrf.completedBy]).toEqual([{ ok: true }, 'sup_demo']);
    // The supervisor closes it out for the mechanic who did the work. History still shows who entered it.
    const forMechanic = closedBy({ completedBy: 'e06' });
    expect([forMechanic.result, forMechanic.mrf.completedBy, forMechanic.mrf.history.slice(-1)[0].by]).toEqual([{ ok: true }, 'e06', 'sup_demo']);
    // Nobody can put a third person's name on the work.
    const third = closedBy({ completedBy: 'e03' });
    expect(third.result).toEqual({ ok: false, error: 'Completed by is you, or the person the request is assigned to.' });
    expect(third.mrf.status).toBe('open');
    // The person it is assigned to signs for their own work, not for someone else.
    const assignee = closedBy({ completedBy: 'sup_demo' }, 'employee', 'emp_demo');
    expect(assignee.result).toMatchObject({ ok: false });
    expect(closedBy({}, 'employee', 'emp_demo').mrf.completedBy).toBe('emp_demo');
  });

  it('is not closed without saying what was done, or with a time spent that makes no sense', () => {
    const { id } = request();
    s().signInDemo('supervisor');
    expect(s().completeMrf(id, { remarks: '  ' })).toEqual({ ok: false, error: 'Say what was done. The remarks are the repair record.' });
    for (const timeSpent of [0, -50, Number.NaN]) {
      expect(s().completeMrf(id, { remarks: 'Repacked', timeSpent })).toMatchObject({ ok: false });
    }
    expect(saved(id).status).toBe('open');
    // With nobody assigned, the person who closes it is the one who completed it.
    expect(s().completeMrf(id, { remarks: 'Repacked' })).toEqual({ ok: true });
    expect([saved(id).completedBy, saved(id).timeSpent]).toEqual(['sup_demo', undefined]);
    expect(s().completeMrf(id, { remarks: 'Again' })).toMatchObject({ ok: false });
  });
});

describe('pre shift exams', () => {
  const sheet = () => s().areaSheets[0];
  const draft = (change: (d: ExamDraft) => void = () => {}): ExamDraft => {
    const d: ExamDraft = {
      sheetId: sheet().id, shift: 'day', startedAt: Date.now() - 600_000, others: [],
      rows: Object.fromEntries(sheet().rows.map((r) => [r.id, { answer: 'ok' as const }])),
      conditions: Object.fromEntries(AREA_CONDITIONS.map((c) => [c.id, { answer: 'ok' as const }])),
    };
    change(d);
    return d;
  };
  const lampOut = (d: ExamDraft) => { d.conditions.lighting = { answer: 'bo', note: 'Lamp out over the conveyor' }; };
  const saved = (id: string) => s().exams.find((e) => e.id === id)!;

  it('records who examined the area, when, and every line', () => {
    s().signInDemo('employee');
    const result = s().submitExam(draft());
    expect(result).toMatchObject({ ok: true, exam: { area: sheet().title, employeeId: 'emp_demo', shift: 'day', submittedAt: at(6, 15) } });
    if (!result.ok) return;
    expect(saved(result.exam.id).rows).toHaveLength(sheet().rows.length);
    expect(saved(result.exam.id).conditions).toHaveLength(20);
  });

  it('is not signed with a line blank, for a sheet that is gone, or by nobody', () => {
    s().signInDemo('employee');
    const before = s().exams.length;
    expect(s().submitExam(draft((d) => { delete d.conditions.berms; }))).toEqual({ ok: false, error: '1 line still needs an answer.' });
    expect(s().submitExam({ ...draft(), sheetId: 'nowhere' })).toMatchObject({ ok: false });
    s().signOut();
    expect(s().submitExam(draft())).toMatchObject({ ok: false });
    expect(s().exams).toHaveLength(before);
  });

  it('keeps a condition open until the date it was fixed is added to the record', () => {
    s().signInDemo('employee');
    const result = s().submitExam(draft(lampOut));
    if (!result.ok) throw new Error(result.error);
    const mine = () => openFindings(s().exams).filter((f) => f.examId === result.exam.id);
    expect(mine().map((f) => f.key)).toEqual(['cond:lighting']);

    jest.setSystemTime(at(9, 5));
    expect(s().markFixed(result.exam.id, 'cond:lighting', ' Changed the lamp ')).toEqual({ ok: true });
    expect(saved(result.exam.id).conditions.find((c) => c.id === 'lighting')?.fixed).toEqual({ at: at(9, 5), by: 'emp_demo', note: 'Changed the lamp' });
    expect(mine()).toEqual([]);
    expect(s().markFixed(result.exam.id, 'cond:lighting')).toMatchObject({ ok: false });
    expect(s().markFixed(result.exam.id, 'cond:berms')).toMatchObject({ ok: false });
  });

  it('lets only the examiner or a supervisor record the fix', () => {
    s().signInDemo('supervisor');
    const result = s().submitExam(draft(lampOut));
    if (!result.ok) throw new Error(result.error);
    s().signInDemo('employee');
    expect(s().markFixed(result.exam.id, 'cond:lighting')).toEqual({ ok: false, error: 'Only the person who made the exam, or a supervisor, can record the fix.' });
    s().signInDemo('supervisor');
    expect(s().markFixed(result.exam.id, 'cond:lighting')).toEqual({ ok: true });
  });

  it('is signed once, however many times the button lands', () => {
    s().signInDemo('employee');
    const before = s().exams.length;
    const same = draft(lampOut);
    const first = s().submitExam(same);
    expect(s().submitExam(same)).toEqual(first);
    expect(s().exams).toHaveLength(before + 1);
    // Going round the same area again later is a new exam.
    expect(s().submitExam({ ...draft(), startedAt: Date.now() })).toMatchObject({ ok: true });
    expect(s().exams).toHaveLength(before + 2);
  });

  it('is not made on a sheet a supervisor has taken off the list', () => {
    s().signInDemo('supervisor');
    s().setAreaSheetActive(sheet().id, false);
    const before = s().exams.length;
    expect(s().submitExam(draft())).toEqual({ ok: false, error: 'That area sheet is no longer on the list.' });
    expect(s().exams).toHaveLength(before);
  });

  it('only sends a request for a Bad Order that is open and has no request yet', () => {
    s().signInDemo('employee');
    const result = s().submitExam(draft(lampOut));
    if (!result.ok) throw new Error(result.error);
    const before = s().mrfs.length;
    // `null` leaves the exam out; a parameter default would put it back in for `undefined`.
    const send = (findingKey: string | undefined, examId: string | null = result.exam.id) =>
      s().createMrf({
        location: `${sheet().title}: Lighting`, priority: 'high', description: `Lamp out, ${findingKey}, ${examId}`, taggedOut: false,
        examId: examId ?? undefined, findingKey,
      });

    // A line that was marked OK, a key with no page, an exam that is not there, and half a link.
    expect(send('cond:berms')).toEqual({ ok: false, error: 'That line is not a Bad Order on this exam.' });
    expect(send('lighting')).toEqual({ ok: false, error: 'That line is not a Bad Order on this exam.' });
    expect(send('cond:lighting', 'exam_nowhere')).toEqual({ ok: false, error: 'That line is not a Bad Order on this exam.' });
    expect(send(undefined)).toEqual({ ok: false, error: 'That line is not a Bad Order on this exam.' });
    expect(send('cond:lighting', null)).toEqual({ ok: false, error: 'That line is not a Bad Order on this exam.' });
    expect(s().mrfs).toHaveLength(before);
    expect(s().exams.find((x) => x.id === result.exam.id)).toEqual(result.exam);

    const first = send('cond:lighting');
    if (!first.ok) throw new Error(first.error);
    expect(send('cond:lighting')).toEqual({ ok: false, error: `Maintenance request #${first.mrf.number} is already in for this.` });
    expect(examFindings(saved(result.exam.id))[0].mrfId).toBe(first.mrf.id);

    // Once the date fixed is on the record there is nothing left to send.
    const again = s().submitExam({ ...draft(lampOut), startedAt: Date.now() });
    if (!again.ok) throw new Error(again.error);
    expect(s().markFixed(again.exam.id, 'cond:lighting', 'Changed the lamp')).toEqual({ ok: true });
    expect(send('cond:lighting', again.exam.id)).toEqual({ ok: false, error: 'The date it was fixed is already on the record.' });
    expect(s().mrfs).toHaveLength(before + 1);
  });

  it('keeps the first date fixed when the request is completed after the line was marked fixed by hand', () => {
    s().signInDemo('supervisor');
    const result = s().submitExam(draft(lampOut));
    if (!result.ok) throw new Error(result.error);
    const mrf = s().createMrf({
      location: `${sheet().title}: Lighting`, priority: 'high', description: 'Lamp out over the conveyor', taggedOut: false,
      examId: result.exam.id, findingKey: 'cond:lighting',
    });
    if (!mrf.ok) throw new Error(mrf.error);
    jest.setSystemTime(at(9, 5));
    expect(s().markFixed(result.exam.id, 'cond:lighting', 'Changed the lamp')).toEqual({ ok: true });
    jest.setSystemTime(at(13, 40));
    expect(s().completeMrf(mrf.mrf.id, { remarks: 'Replaced the ballast as well' })).toEqual({ ok: true });
    expect(saved(result.exam.id).conditions.find((c) => c.id === 'lighting')?.fixed).toEqual({ at: at(9, 5), by: 'sup_demo', note: 'Changed the lamp' });
  });

  it('sends a condition on a maintenance request, and dates the fix when the request is completed', () => {
    s().signInDemo('employee');
    const result = s().submitExam(draft(lampOut));
    if (!result.ok) throw new Error(result.error);
    const mrf = s().createMrf({
      location: `${sheet().title}: Lighting`, priority: 'high', description: 'Lamp out over the conveyor', taggedOut: false,
      examId: result.exam.id, findingKey: 'cond:lighting',
    });
    if (!mrf.ok) throw new Error(mrf.error);
    expect(examFindings(saved(result.exam.id))[0].mrfId).toBe(mrf.mrf.id);

    s().signInDemo('supervisor');
    jest.setSystemTime(at(13, 40));
    s().completeMrf(mrf.mrf.id, { remarks: 'Replaced the lamp and the ballast', timeSpent: 75 });
    expect(saved(result.exam.id).conditions.find((c) => c.id === 'lighting')?.fixed).toEqual({
      at: at(13, 40), by: 'sup_demo', note: 'Replaced the lamp and the ballast',
    });
  });
});

describe('area sheets', () => {
  it('let a supervisor add a sheet, change its lines and take it off the list', () => {
    s().signInDemo('supervisor');
    const before = s().areaSheets.length;
    const added = s().addAreaSheet(' Wash bay ', 'Feeder\nBelt');
    expect(added).toMatchObject({ ok: true, sheet: { id: 'wash_bay', title: 'Wash bay', active: true } });
    expect(s().areaSheets).toHaveLength(before + 1);
    expect(s().addAreaSheet('  ', 'Feeder')).toEqual({ ok: false, error: 'Give the sheet the name of its work area.' });
    expect(s().addAreaSheet('wash BAY', 'Feeder')).toEqual({ ok: false, error: 'There is already a sheet called Wash bay.' });

    expect(s().updateAreaSheet('wash_bay', 'Truck wash', 'Feeder\nBelt\nHose reel')).toEqual({ ok: true });
    const sheet = s().areaSheets.find((x) => x.id === 'wash_bay')!;
    expect([sheet.title, sheet.rows.map((r) => r.label)]).toEqual(['Truck wash', ['Feeder', 'Belt', 'Hose reel']]);

    s().setAreaSheetActive('wash_bay', false);
    expect(s().areaSheets.find((x) => x.id === 'wash_bay')?.active).toBe(false);
  });

  it('can have one OK/BO column instead of the three, and keep it or change it when the sheet is edited', () => {
    s().signInDemo('supervisor');
    const added = s().addAreaSheet('Wash bay', 'Hose reel\nDrain grate', true);
    expect(added).toMatchObject({ ok: true, sheet: { id: 'wash_bay', single: true } });
    const sheet = () => s().areaSheets.find((x) => x.id === 'wash_bay')!;
    // Changing the lines without a word about the columns leaves them as they are.
    expect(s().updateAreaSheet('wash_bay', 'Wash bay', 'Hose reel\nDrain grate\nOil separator')).toEqual({ ok: true });
    expect([sheet().single, sheet().rows.length]).toEqual([true, 3]);
    expect(s().updateAreaSheet('wash_bay', 'Wash bay', 'Hose reel', false)).toEqual({ ok: true });
    expect('single' in sheet()).toBe(false);
    expect(s().updateAreaSheet('wash_bay', 'Wash bay', 'Hose reel', true)).toEqual({ ok: true });
    expect(sheet().single).toBe(true);

    // An exam on it is signed with a Bad Order that names no column.
    const result = s().submitExam({
      sheetId: 'wash_bay', shift: 'day', startedAt: Date.now(), others: [],
      rows: { hose_reel: { answer: 'bo', note: 'Reel will not lock' } },
      conditions: Object.fromEntries(AREA_CONDITIONS.map((c) => [c.id, { answer: 'ok' as const }])),
    });
    expect(result).toMatchObject({ ok: true, exam: { single: true } });
  });

  it('are not something an employee can change', () => {
    s().signInDemo('employee');
    const before = s().areaSheets;
    expect(s().addAreaSheet('Wash bay', 'Feeder')).toMatchObject({ ok: false });
    expect(s().updateAreaSheet(before[0].id, 'Renamed', 'One line')).toMatchObject({ ok: false });
    s().setAreaSheetActive(before[0].id, false);
    expect(s().areaSheets).toEqual(before);
  });

  it('leave an exam as it was signed when the sheet changes afterwards', () => {
    s().signInDemo('supervisor');
    const sheet = s().areaSheets[0];
    const result = s().submitExam({
      sheetId: sheet.id, shift: 'day', startedAt: Date.now(), others: [],
      rows: Object.fromEntries(sheet.rows.map((r) => [r.id, { answer: 'ok' as const }])),
      conditions: Object.fromEntries(AREA_CONDITIONS.map((c) => [c.id, { answer: 'ok' as const }])),
    });
    if (!result.ok) throw new Error(result.error);
    s().updateAreaSheet(sheet.id, 'Renamed', 'Only line');
    const exam = s().exams.find((e) => e.id === result.exam.id)!;
    expect(exam.area).toBe(sheet.title);
    expect(exam.rows.map((r) => r.label)).toEqual(sheet.rows.map((r) => r.label));
  });

  it("are the build's own sheets when it names some, with the sample exams made on them", () => {
    const named = parseAreaSheets('North plant\nFeeder\nBelt 4\n\nBag house\nFan');
    s().resetDemo(null, named);
    expect(s().areaSheets.map((x) => x.title)).toEqual(['North plant', 'Bag house']);
    expect(s().exams.length).toBeGreaterThan(5);
    expect(new Set(s().exams.map((e) => e.area))).toEqual(new Set(['North plant', 'Bag house']));
    // A sheet named later reaches a phone whose data was already saved, once.
    const more = [...named, ...parseAreaSheets('Wash bay')];
    s().ensureSeeded(null, more);
    s().ensureSeeded(null, more);
    expect(s().areaSheets.map((x) => x.title)).toEqual(['North plant', 'Bag house', 'Wash bay']);
  });
});

describe('settings', () => {
  it('keeps the boundary radius inside sane limits, in 50 m steps', () => {
    s().setRadius(1234);
    expect(s().settings.site.radiusM).toBe(1250);
    s().setRadius(10);
    expect(s().settings.site.radiusM).toBe(200);
    s().setRadius(99999);
    expect(s().settings.site.radiusM).toBe(2000);
  });
});

describe('the company', () => {
  const own = {
    name: '  Example Aggregates   Co. ',
    state: 'NV',
    place: ' ',
    pay: { frequency: 'biweekly' as const, firstDay: '2026-11-01', payday: { daysAfter: 6 }, ifBankClosed: 'before' as const },
  };

  it('starts a preview with the sample company', () => {
    expect(s().settings.company.name).toBe('Sample Mining Co.');
  });

  it('is changed by a supervisor, tidied, and saved whole', () => {
    s().signInDemo('supervisor');
    expect(s().setCompany(own)).toEqual({ ok: true });
    expect(s().settings.company).toEqual({ name: 'Example Aggregates Co.', state: 'NV', pay: own.pay });
  });

  it('can be set to have no pay periods at all', () => {
    s().signInDemo('supervisor');
    expect(s().setCompany({ ...own, pay: null })).toEqual({ ok: true });
    expect(s().settings.company.pay).toBeNull();
  });

  it('is not changed by anyone else, or with a part missing', () => {
    s().signInDemo('employee');
    expect(s().setCompany(own)).toMatchObject({ ok: false, error: expect.stringMatching(/supervisor/) });
    s().signInDemo('supervisor');
    expect(s().setCompany({ ...own, state: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/state/) });
    expect(s().setCompany({ ...own, pay: { ...own.pay, firstDay: undefined } })).toMatchObject({ ok: false });
    expect(s().settings.company.name).toBe('Sample Mining Co.');
  });
});

describe('paid leave', () => {
  const day = new Date(2026, 10, 10, 9, 30).getTime();

  it('lets a supervisor record leave against a day, and take it back off', () => {
    s().signInDemo('supervisor');
    const before = s().leave.length;
    expect(s().addLeave({ employeeId: 'emp_demo', day, type: 'pto', hours: 800, note: ' Dentist ' })).toEqual({ ok: true });
    const entry = s().leave[s().leave.length - 1];
    expect(entry).toMatchObject({ employeeId: 'emp_demo', type: 'pto', hours: 800, note: 'Dentist', enteredBy: 'sup_demo' });
    // Stored against the calendar day, not the time of day it was typed in.
    expect(entry.day).toBe(new Date(2026, 10, 10).getTime());
    s().removeLeave(entry.id);
    expect(s().leave).toHaveLength(before);
  });

  it('is not something an employee can add for themselves', () => {
    s().signInDemo('employee');
    const before = s().leave.length;
    expect(s().addLeave({ employeeId: 'emp_demo', day, type: 'sick', hours: 800 })).toMatchObject({ ok: false });
    expect(s().leave).toHaveLength(before);
  });

  it('is not something an employee can take off the record', () => {
    s().signInDemo('supervisor');
    s().addLeave({ employeeId: 'emp_demo', day, type: 'pto', hours: 800 });
    const entry = s().leave[s().leave.length - 1];
    s().signInDemo('employee');
    s().removeLeave(entry.id);
    expect(s().leave).toContainEqual(entry);
    s().signOut();
    s().removeLeave(entry.id);
    expect(s().leave).toContainEqual(entry);
  });

  it('refuses hours that are zero, negative or more than a day', () => {
    s().signInDemo('supervisor');
    for (const hours of [0, -100, 2401, Number.NaN]) {
      expect(s().addLeave({ employeeId: 'emp_demo', day, type: 'holiday', hours })).toMatchObject({ ok: false });
    }
    expect(s().addLeave({ employeeId: 'emp_demo', day, type: 'holiday', hours: 2400 })).toEqual({ ok: true });
  });
});

describe('pay rate for the estimate', () => {
  it('is kept per person and can be cleared', () => {
    s().signInDemo('supervisor');
    expect(s().setMyRate(3150)).toEqual({ ok: true });
    expect(s().payRates.sup_demo).toBe(3150);
    s().signInDemo('employee');
    expect(s().setMyRate(2800)).toEqual({ ok: true });
    expect([s().payRates.sup_demo, s().payRates.emp_demo]).toEqual([3150, 2800]);
    expect(s().setMyRate(null)).toEqual({ ok: true });
    expect(s().payRates.emp_demo).toBeUndefined();
  });

  it('refuses a rate that is not a sensible hourly wage', () => {
    s().signInDemo('employee');
    for (const cents of [0, -500, 100001, Number.NaN]) {
      expect(s().setMyRate(cents)).toMatchObject({ ok: false });
    }
  });
});
