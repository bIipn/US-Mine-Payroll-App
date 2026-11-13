import { toGeoStamp } from '../../domain/geofence';
import { DEFAULT_SITE } from '../../domain/site';
import { templateFor, templateItems } from '../../domain/templates';
import { shiftFlags, shiftTotals } from '../../domain/time';
import type { InspectionAnswer } from '../../domain/types';
import { openShiftOf, useStore } from '../useStore';

const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m, 0).getTime();
const onSite = toGeoStamp(DEFAULT_SITE, { ...DEFAULT_SITE.center, accuracyM: 5 }, 'gps');
const s = () => useStore.getState();
const unit = (name: string) => s().equipment.find((e) => e.unit === name)!;
const answers = (name: string, bad: Record<string, Partial<InspectionAnswer>> = {}): InspectionAnswer[] =>
  templateItems(templateFor(unit(name).category)).map((i) => ({ itemId: i.id, answer: 'ok', ...bad[i.id] }));

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

  it('checks a unit out on a clean pre-op and back in at end of use', () => {
    const l12 = unit('L-12');
    const result = s().submitInspection({ equipmentId: l12.id, startedAt: Date.now(), meter: l12.meter + 1, answers: answers('L-12') });
    expect(result).toMatchObject({ ok: true, inspection: { result: 'pass' } });
    const log = s().opLogs.find((l) => l.equipmentId === l12.id && !l.endAt)!;
    expect(log.employeeId).toBe('emp_demo');
    expect(s().endUse(log.id, { endMeter: l12.meter - 5, parkedSafely: true })).toMatchObject({ ok: false });
    expect(s().endUse(log.id, { endMeter: l12.meter + 6.5, fuelGal: 40, parkedSafely: true })).toEqual({ ok: true });
    expect(unit('L-12').meter).toBe(l12.meter + 6.5);
  });

  it('takes a unit out of service on a safety Bad Order until the MRF is completed', () => {
    const l12 = unit('L-12');
    const result = s().submitInspection({
      equipmentId: l12.id, startedAt: Date.now(), meter: l12.meter,
      answers: answers('L-12', { fn_brakes: { answer: 'bo', note: 'Pedal fades' } }),
    });
    expect(result).toMatchObject({ ok: true, inspection: { result: 'bad_order' } });
    expect(unit('L-12').status).toBe('out_of_service');
    expect(s().opLogs.some((l) => l.equipmentId === l12.id && !l.endAt)).toBe(false);
    if (!result.ok) return;

    expect(s().createMrf({ equipmentId: l12.id, priority: 'safety', description: ' ', taggedOut: true })).toMatchObject({ ok: false });
    const mrf = s().createMrf({ equipmentId: l12.id, priority: 'safety', description: 'Service brakes fade', taggedOut: true, inspectionId: result.inspection.id });
    expect(mrf).toMatchObject({ ok: true, mrf: { number: 1044, status: 'open' } });
    expect(s().inspections.find((i) => i.id === result.inspection.id)?.mrfId).toBeDefined();

    s().signInDemo('supervisor');
    if (!mrf.ok) return;
    s().setMrfStatus(mrf.mrf.id, 'in_progress');
    expect(unit('L-12').status).toBe('out_of_service');
    s().setMrfStatus(mrf.mrf.id, 'completed', 'Replaced master cylinder');
    expect(unit('L-12').status).toBe('ready');
    expect(s().mrfs.find((m) => m.id === mrf.mrf.id)?.history).toHaveLength(3);
  });

  it('reports a lesser defect without parking the unit, and lets the operator escalate it', () => {
    const wt = unit('WT-01');
    const defect = s().submitInspection({
      equipmentId: wt.id, startedAt: Date.now(), meter: wt.meter,
      answers: answers('WT-01', { cab_wipers: { answer: 'bo', note: 'Blade torn' } }),
    });
    expect(defect).toMatchObject({ ok: true, inspection: { result: 'defect' } });
    expect(unit('WT-01').status).toBe('defect');
    if (!defect.ok) return;
    s().decideAfterDefect(defect.inspection.id, 'operate');
    expect(s().opLogs.some((l) => l.equipmentId === wt.id && !l.endAt && l.employeeId === 'emp_demo')).toBe(true);

    const g = unit('G-02');
    const escalated = s().submitInspection({
      equipmentId: g.id, startedAt: Date.now(), meter: g.meter,
      answers: answers('G-02', { wa_tires: { answer: 'bo', note: 'Sidewall cut to the cords', hazard: true } }),
    });
    expect(escalated).toMatchObject({ ok: true, inspection: { result: 'bad_order' } });
    expect(unit('G-02').status).toBe('out_of_service');
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
