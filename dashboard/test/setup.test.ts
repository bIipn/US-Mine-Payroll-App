import { describe, expect, it } from 'vitest';

import { checkCompany, SAMPLE_COMPANY } from '@app/domain/company';
import { draftOf } from '@app/domain/companyForm';
import { SAMPLE_SITE } from '@app/domain/site';
import type { AreaExam, AreaSheet, Equipment, Inspection, Mrf, OperatingLog } from '@app/domain/types';
import { buildDemoData } from '@app/store/seed';

import { shapeRecords } from '../src/lib/records';
import type { CompanyRow } from '../src/lib/server';
import {
  anythingOpen,
  checklistsByUnit,
  codesAtFault,
  companyProblems,
  companyRowPatch,
  dangerFirst,
  lastReading,
  lineCount,
  linesText,
  ON_PHONES,
  openOnUnit,
  payFieldAtFault,
  PHONE_PUTS_BACK,
  PHONE_STARTS_AGAIN,
  PHONES_DO_NOT_RECEIVE,
  readSite,
  removalQuestion,
  sameNumbers,
  savedAs,
  SAVED_HERE_ONLY,
  sharedSettings,
  sheetUse,
  SIGN_IN_DETAILS,
  standings,
  stopQuestion,
  WEEKDAYS,
} from '../src/lib/setup';
import { seedRows } from './fixtures';

/** Every unit, sheet, person and company here is made up, like the app's sample crew. */

const NOW = new Date(2026, 10, 13, 14, 30).getTime();
const DAY = 86_400_000;

const unit = (over: Partial<Equipment> = {}): Equipment => ({ id: 'eq_a', unit: 'L-2', category: 'loader', make: 'Test', model: 'One', status: 'ready', meter: 100, meterUnit: 'hrs', ...over });
const mrf = (over: Partial<Mrf>): Mrf => ({
  id: 'm1', number: 1001, requestedBy: 'e1', createdAt: NOW - DAY, description: 'Leak', priority: 'routine', items: [], taggedOut: false, status: 'open', history: [], equipmentId: 'eq_a', ...over,
});
const check = (over: Partial<Inspection>): Inspection => ({
  id: 'i1', equipmentId: 'eq_a', employeeId: 'e1', templateId: 'operator_equipment_checklist', templateVersion: 1, startedAt: NOW - DAY, submittedAt: NOW - DAY, meter: 120, answers: [], result: 'pass', ...over,
});
const log = (over: Partial<OperatingLog>): OperatingLog => ({ id: 'o1', equipmentId: 'eq_a', employeeId: 'e1', inspectionId: 'i1', startAt: NOW - DAY, startMeter: 120, ...over });

describe('a unit’s standing and last reading, as the records give them', () => {
  it('is red tagged while its record says so or an open red-tag request names it, and has a defect reported while another request is open', () => {
    const fleet = [unit(), unit({ id: 'eq_b', unit: 'T-1' }), unit({ id: 'eq_c', unit: 'T-2', status: 'out_of_service' }), unit({ id: 'eq_d', unit: 'T-3', status: 'defect' }), unit({ id: 'eq_e', unit: 'T-4' })];
    const mrfs = [mrf({ id: 'm1', equipmentId: 'eq_a', taggedOut: true }), mrf({ id: 'm2', equipmentId: 'eq_b' }), mrf({ id: 'm3', equipmentId: 'eq_e', taggedOut: true, status: 'completed' })];
    expect(Object.fromEntries(standings({ equipment: fleet, mrfs, inspections: [] }))).toEqual({ eq_a: 'red_tagged', eq_b: 'defect', eq_c: 'red_tagged', eq_d: 'defect', eq_e: 'ready' });
  });

  it('goes by the checklists that arrived, whatever the unit’s own record says: a phone’s status for a unit may never reach it', () => {
    // Each unit's own record says ready. The checklists say otherwise, and they are the records that arrive.
    const fleet = [unit(), unit({ id: 'eq_b', unit: 'T-1' }), unit({ id: 'eq_c', unit: 'T-2' }), unit({ id: 'eq_d', unit: 'T-3' })];
    const inspections = [
      // A Bad Order on a safety item: the unit is red tagged, with no request sent on it.
      check({ id: 'i1', equipmentId: 'eq_a', result: 'bad_order', answers: [{ itemId: 'brakes', answer: 'bo', note: 'Pedal goes to the floor' }] }),
      // A Bad Order on another line: a defect reported, and the unit still runs.
      check({ id: 'i2', equipmentId: 'eq_b', result: 'defect', answers: [{ itemId: 'lights', answer: 'bo', note: 'Lamp out' }] }),
      // A Bad Order whose request is completed is corrected, and counts for nothing.
      check({ id: 'i3', equipmentId: 'eq_c', result: 'bad_order', mrfId: 'm9', answers: [{ itemId: 'brakes', answer: 'bo', note: 'Soft pedal' }] }),
      check({ id: 'i4', equipmentId: 'eq_d' }),
    ];
    const mrfs = [mrf({ id: 'm9', equipmentId: 'eq_c', taggedOut: true, status: 'completed', completedAt: NOW })];
    const data = { equipment: fleet, mrfs, inspections, opLogs: [] };
    expect(Object.fromEntries(standings(data))).toEqual({ eq_a: 'red_tagged', eq_b: 'defect', eq_c: 'ready', eq_d: 'ready' });
    // The one rule serves the tag in the table, the counts and what is said before a unit is taken out.
    expect(openOnUnit(fleet[0], data)).toMatchObject({ redTagged: true, requests: [] });
    expect(openOnUnit(fleet[0], data).badOrders).toHaveLength(1);
    expect(openOnUnit(fleet[1], data).redTagged).toBe(false);
    expect(anythingOpen(openOnUnit(fleet[1], data))).toBe(true);
    expect(anythingOpen(openOnUnit(fleet[2], data))).toBe(false);
  });

  it('reads the unit’s own record until a checklist or an end of use gives a newer reading', () => {
    expect(lastReading(unit(), { inspections: [], opLogs: [] })).toEqual({ value: 100, from: 'unit' });
    const inspections = [check({ id: 'i1', submittedAt: NOW - 2 * DAY, meter: 120 }), check({ id: 'i2', submittedAt: NOW - DAY, meter: 131.5 }), check({ id: 'i3', equipmentId: 'eq_other', submittedAt: NOW, meter: 999 })];
    expect(lastReading(unit(), { inspections, opLogs: [] })).toEqual({ value: 131.5, at: NOW - DAY, from: 'checklist' });
    const opLogs = [log({ id: 'o1', endAt: NOW - DAY + 8 * 3_600_000, endMeter: 139 }), log({ id: 'o2', startAt: NOW })];
    expect(lastReading(unit(), { inspections, opLogs })).toEqual({ value: 139, at: NOW - DAY + 8 * 3_600_000, from: 'use' });
  });

  it('counts the checklists on each unit', () => {
    expect([...checklistsByUnit([check({ id: 'i1' }), check({ id: 'i2' }), check({ id: 'i3', equipmentId: 'eq_b' })])]).toEqual([['eq_a', 2], ['eq_b', 1]]);
  });
});

describe('taking a unit out of the fleet', () => {
  const bad = check({ id: 'i9', result: 'defect', answers: [{ itemId: 'lights', answer: 'bo', note: 'Lamp out' }] });

  it('asks once more with nothing open on it', () => {
    const open = openOnUnit(unit(), { equipment: [unit()], inspections: [check({})], opLogs: [], mrfs: [] });
    expect(open).toEqual({ redTagged: false, requests: [], badOrders: [] });
    expect(removalQuestion(unit(), open)).toBe(`Take unit L-2 out of the fleet? Its past checklists and requests stay on record. ${PHONE_PUTS_BACK}`);
    // Every way of asking says what a phone that still has the unit does, where the unit is taken out.
    expect(PHONE_PUTS_BACK).toBe('A supervisor’s phone that still has this unit puts it back when it next sends it: take it out on the supervisors’ phones too.');
  });

  it('says what is open first: a red tag, open requests, Bad Orders not corrected', () => {
    const data = { equipment: [unit()], inspections: [bad], opLogs: [], mrfs: [mrf({ taggedOut: true }), mrf({ id: 'm2', number: 1002 }), mrf({ id: 'm3', status: 'completed' })] };
    const open = openOnUnit(unit(), data);
    expect(open.redTagged).toBe(true);
    expect(open.requests.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(open.badOrders).toHaveLength(1);
    expect(removalQuestion(unit(), open)).toBe(
      `Unit L-2 is red tagged, has 2 open maintenance requests and has 1 Bad Order not corrected. Taking it out of the fleet corrects none of that. What is open stays open on the other pages, under a unit removed from the fleet. Its past checklists and requests stay on record. ${PHONE_PUTS_BACK}`,
    );
  });

  it('says just the one thing when there is one', () => {
    const open = openOnUnit(unit(), { equipment: [unit()], inspections: [], opLogs: [], mrfs: [mrf({})] });
    expect(removalQuestion(unit(), open)).toContain('Unit L-2 has 1 open maintenance request. Taking it out of the fleet corrects none of that. What is open stays open on the other pages');
    // A red tag with no request or Bad Order behind it is on the unit's own record, and goes with the unit.
    expect(removalQuestion(unit(), { redTagged: true, requests: [], badOrders: [] })).toBe(`Unit L-2 is red tagged. Taking it out of the fleet corrects none of that. Its past checklists and requests stay on record. ${PHONE_PUTS_BACK}`);
  });

  it('leaves another unit’s open work out of it', () => {
    const other = unit({ id: 'eq_b', unit: 'T-1' });
    expect(openOnUnit(other, { equipment: [unit(), other], inspections: [bad], opLogs: [], mrfs: [mrf({ taggedOut: true })] })).toEqual({ redTagged: false, requests: [], badOrders: [] });
  });
});

describe('units that share a number', () => {
  it('are found whatever the capitals, so a unit added here and again on a phone shows as two', () => {
    const fleet = [unit(), unit({ id: 'eq_b', unit: 'l-2 ' }), unit({ id: 'eq_c', unit: 'T-1' }), unit({ id: 'eq_d', unit: 'L-10' }), unit({ id: 'eq_e', unit: 'L-10' }), unit({ id: 'eq_f', unit: 'L-10' })];
    const twice = sameNumbers(fleet);
    expect([...twice.keys()]).toEqual(['L-2', 'L-10']);
    expect(twice.get('L-2')?.map((e) => e.id)).toEqual(['eq_a', 'eq_b']);
    expect(twice.get('L-10')).toHaveLength(3);
    expect(sameNumbers([unit(), unit({ id: 'eq_c', unit: 'T-1' })]).size).toBe(0);
  });
});

describe('an area sheet in use', () => {
  const seed = buildDemoData(NOW);
  const sheet = seed.areaSheets[1];
  const exam = (id: string, mark: (x: AreaExam) => AreaExam = (x) => x): AreaExam =>
    mark({
      id, sheetId: sheet.id, area: sheet.title, employeeId: 'e1', shift: 'day', startedAt: NOW - DAY, submittedAt: NOW - DAY,
      rows: sheet.rows.map((r) => ({ id: r.id, label: r.label, guarding: 'ok', electrical: 'ok', access: 'ok' })),
      conditions: [{ id: 'ground', answer: 'ok' }],
    });
  const withBo = (danger: boolean) => (x: AreaExam): AreaExam => ({ ...x, rows: x.rows.map((r, i) => (i === 0 ? { ...r, guarding: 'bo', note: 'Guard off', ...(danger ? { danger: true } : null) } : r)) });

  it('is typed and counted a line to a line', () => {
    expect(linesText(sheet).split('\n')).toEqual(sheet.rows.map((r) => r.label));
    expect(lineCount('One\n\n  \nTwo\n')).toBe(2);
    expect(lineCount('')).toBe(0);
  });

  it('counts its exams, and what is still open in its area', () => {
    const exams = [exam('x1'), exam('x2', withBo(false)), exam('x3', withBo(true)), { ...exam('x4', withBo(true)), sheetId: 'elsewhere' }];
    expect(sheetUse(sheet, exams)).toEqual({ exams: 3, open: 2, dangers: 1 });
    expect(sheetUse(sheet, [])).toEqual({ exams: 0, open: 0, dangers: 0 });
  });

  it('asks before it is stopped, and says what is still open in the area and what a phone does', () => {
    const wash: AreaSheet = { id: 'wash_bay', title: 'Wash bay', rows: [], active: true };
    const tail = `It moves to Not in use here, and the crew stops seeing the area once their phones have the change. Its exams stay on record, and it can be put back. ${PHONE_STARTS_AGAIN}`;
    expect(PHONE_STARTS_AGAIN).toBe('A supervisor’s phone that changes this sheet sends its own copy, in use: stop using it on the supervisors’ phones too.');
    expect(stopQuestion(wash, { exams: 4, open: 0, dangers: 0 })).toBe(`Stop using the Wash bay sheet? ${tail}`);
    expect(stopQuestion(wash, { exams: 4, open: 1, dangers: 0 })).toBe(`One condition is still open in Wash bay. Stopping the sheet closes nothing: it stays open until its date fixed is recorded. ${tail}`);
    // More than one condition is spoken of as more than one.
    expect(stopQuestion(wash, { exams: 4, open: 3, dangers: 1 })).toBe(`3 conditions are still open in Wash bay, 1 danger among them. Stopping the sheet closes nothing: they stay open until each has its date fixed recorded. ${tail}`);
    expect(stopQuestion(wash, { exams: 4, open: 1, dangers: 1 })).toContain('One condition is still open in Wash bay, a danger.');
    expect(stopQuestion(wash, { exams: 4, open: 2, dangers: 2 })).toContain('2 conditions are still open in Wash bay, all dangers.');
  });

  it('lists a sheet with a danger open in its area first, in use or not, then by name', () => {
    const named = (title: string, dangers: number) => ({ sheet: { id: title, title, rows: [], active: true }, use: { exams: 0, open: dangers, dangers } });
    expect(dangerFirst([named('Wash bay', 0), named('Crusher 10', 0), named('Truck scale', 1), named('Crusher 2', 0), named('Core shed', 2)]).map((s) => s.sheet.title)).toEqual([
      'Core shed', 'Truck scale', 'Crusher 2', 'Crusher 10', 'Wash bay',
    ]);
  });

  it('says the name a sheet is saved under when that is not what was typed', () => {
    expect(savedAs('Truck scale areas:', 'Truck scale')).toBe('Truck scale');
    expect(savedAs('  Truck scale ', 'Truck scale')).toBeNull();
    expect(savedAs('', undefined)).toBeNull();
    expect(savedAs('areas:', undefined)).toBeNull();
  });
});

describe('the shared settings', () => {
  it('hold the four things a company shares and nothing else, with the site as it was sent', () => {
    const settings = sharedSettings({ company: SAMPLE_COMPANY, site: SAMPLE_SITE, workweekStartsOn: 1, allowSectionAllOk: false });
    expect(settings).toEqual({ company: SAMPLE_COMPANY, site: SAMPLE_SITE, workweekStartsOn: 1, allowSectionAllOk: false });
    expect(settings.site).toBe(SAMPLE_SITE);
  });

  it('keep no site when none has arrived, and a workweek that starts on a real day', () => {
    expect(sharedSettings({ company: SAMPLE_COMPANY, site: undefined, workweekStartsOn: 9, allowSectionAllOk: true })).toEqual({ company: SAMPLE_COMPANY, site: null, workweekStartsOn: 0, allowSectionAllOk: true });
    expect(sharedSettings({ company: SAMPLE_COMPANY, site: 'somewhere', workweekStartsOn: 2.5, allowSectionAllOk: true })).toMatchObject({ site: null, workweekStartsOn: 0 });
    expect(WEEKDAYS[0]).toBe('Sunday');
    expect(WEEKDAYS).toHaveLength(7);
  });

  it('come out of the records with the site and the switch a phone sent, to be saved back as they were', () => {
    const shaped = shapeRecords(seedRows(NOW));
    expect(shaped.site).toEqual(SAMPLE_SITE);
    expect(shaped.allowSectionAllOk).toBe(true);
    const off = seedRows(NOW).map((r) => (r.kind === 'settings' ? { ...r, data: { company: SAMPLE_COMPANY, site: null, workweekStartsOn: 0, allowSectionAllOk: false } } : r));
    expect(shapeRecords(off)).toMatchObject({ site: null, allowSectionAllOk: false });
    // With no settings from a phone, there is no site, and the switch is the app's default.
    expect(shapeRecords(seedRows(NOW).filter((r) => r.kind !== 'settings'))).toMatchObject({ site: null, allowSectionAllOk: true, settingsFrom: 'server' });
    // Settings set aside for a company the app could not read still give up their site, so saving over them keeps the pin.
    const broken = seedRows(NOW).map((r) => (r.kind === 'settings' ? { ...r, data: { company: { name: 'A', state: 'CA', pay: 'weekly' }, site: SAMPLE_SITE, workweekStartsOn: 0, allowSectionAllOk: false } } : r));
    const aside = shapeRecords(broken);
    expect(aside.skipped.map((s) => s.kind)).toEqual(['settings']);
    expect(aside).toMatchObject({ settingsFrom: 'server', site: SAMPLE_SITE, allowSectionAllOk: false });
    // Settings taken off the server give up nothing.
    expect(shapeRecords(seedRows(NOW).map((r) => (r.kind === 'settings' ? { ...r, deleted: true, data: {} } : r)))).toMatchObject({ site: null, allowSectionAllOk: true });
  });

  it('show the clock-in site, and nothing for a site this page cannot read', () => {
    expect(readSite(SAMPLE_SITE)).toEqual({ name: SAMPLE_SITE.name, lat: SAMPLE_SITE.center.lat, lng: SAMPLE_SITE.center.lng, radiusM: SAMPLE_SITE.radiusM, ...(SAMPLE_SITE.town ? { town: SAMPLE_SITE.town.name } : null) });
    expect(readSite({ name: 'A', center: { lat: 1, lng: 2 }, radiusM: 500 })).toEqual({ name: 'A', lat: 1, lng: 2, radiusM: 500 });
    for (const bad of [null, undefined, 'x', {}, { center: { lat: '1', lng: 2 }, radiusM: 500 }, { center: { lat: 1, lng: 2 } }, { center: null, radiusM: 500 }]) expect(readSite(bad)).toBeNull();
  });
});

describe('the company’s own row on the server', () => {
  const rowOf = (over: Partial<CompanyRow> = {}): CompanyRow => ({ id: 'co', name: SAMPLE_COMPANY.name, state: SAMPLE_COMPANY.state, timezone: 'America/Los_Angeles', logo_path: null, pay_period: SAMPLE_COMPANY.pay, ...over });

  it('is left alone when it already says the same', () => {
    expect(companyRowPatch(SAMPLE_COMPANY, 'America/Los_Angeles', rowOf())).toEqual({});
    // The same schedule with its fields in another order is the same schedule.
    expect(companyRowPatch(SAMPLE_COMPANY, 'America/Los_Angeles', rowOf({ pay_period: { ifBankClosed: 'before', payday: { dayOfMonth: [20, 5] }, frequency: 'semimonthly' } }))).toEqual({});
  });

  it('is brought in step where the two overlap: the name, the state, the pay period, and its own time zone', () => {
    const next = { ...SAMPLE_COMPANY, name: 'Renamed Co.', state: 'NV', pay: null };
    expect(companyRowPatch(next, 'America/Denver', rowOf())).toEqual({ name: 'Renamed Co.', state: 'NV', timezone: 'America/Denver', pay_period: null });
    expect(companyRowPatch(SAMPLE_COMPANY, 'America/Los_Angeles', rowOf({ pay_period: null }))).toEqual({ pay_period: SAMPLE_COMPANY.pay });
    expect(companyRowPatch(SAMPLE_COMPANY, '', rowOf())).toEqual({});
    expect(companyRowPatch(SAMPLE_COMPANY, 'America/Denver', null)).toEqual({ name: SAMPLE_COMPANY.name, state: 'CA', timezone: 'America/Denver', pay_period: SAMPLE_COMPANY.pay });
  });
});

describe('the company form, field by field', () => {
  const draft = draftOf(SAMPLE_COMPANY, NOW);

  it('finds nothing wrong with a company that is whole', () => {
    expect(companyProblems(draft)).toEqual({});
  });

  it('says what is wrong with each field in the words of the app’s own check', () => {
    expect(companyProblems({ ...draft, name: '  ' })).toEqual({ name: checkCompany({ name: '', state: 'CA', pay: null }) });
    expect(companyProblems({ ...draft, state: '' })).toEqual({ state: 'Choose the state the crew works in.' });
    expect(companyProblems({ ...draft, mineId: '12-345' })).toEqual({ mineId: 'An MSHA mine ID is seven digits, like 0400123.' });
    expect(companyProblems({ ...draft, mineId: ' 04-00123 ' })).toEqual({});
    expect(companyProblems({ ...draft, firstHalf: '32' })).toEqual({ pay: 'A day of the month must be from 1 to 31.', payField: 'firstHalf' });
    expect(companyProblems({ ...draft, often: 'weekly', firstDay: '' })).toEqual({ pay: 'Give the first day of any one pay period as a date, like 2026-11-01.', payField: 'firstDay' });
    expect(companyProblems({ ...draft, codes: { ...draft.codes, overtime: 'reg' } })).toEqual({ codes: 'Two kinds of hours have the same code. Give each its own.', codeKeys: ['regular', 'overtime'] });
    expect(companyProblems({ ...draft, codes: { ...draft.codes, sick: 'a code far too long' } })).toEqual({ codes: 'An earning code is up to 12 letters and numbers, the way the payroll system writes it.', codeKeys: ['sick'] });
    expect(Object.keys(companyProblems({ ...draft, name: '', state: 'ZZ', mineId: 'x', firstHalf: '' })).sort()).toEqual(['mineId', 'name', 'pay', 'payField', 'state']);
  });

  it('says which field of the pay period is at fault, by the app’s own check, so the page can mark it and move to it', () => {
    // Twice a month, on days of the month: the one that is out of range, whichever half it is.
    expect(payFieldAtFault({ ...draft, secondHalf: '45' })).toBe('secondHalf');
    expect(payFieldAtFault({ ...draft, firstHalf: '0' })).toBe('firstHalf');
    // Both wrong: the first the form shows. Put right, the other is named.
    expect(payFieldAtFault({ ...draft, firstHalf: 'x', secondHalf: '45' })).toBe('firstHalf');
    expect(payFieldAtFault({ ...draft, paidBy: 'daysAfter', daysAfter: '61' })).toBe('daysAfter');
    expect(payFieldAtFault({ ...draft, often: 'monthly', firstHalf: '' })).toBe('firstHalf');
    expect(payFieldAtFault({ ...draft, often: 'biweekly', firstDay: 'tomorrow', daysAfter: '5' })).toBe('firstDay');
    expect(payFieldAtFault({ ...draft, often: 'weekly', firstDay: '2026-11-01', daysAfter: '-1' })).toBe('daysAfter');
    // Nothing wrong, or no pay periods at all: no field.
    expect(payFieldAtFault(draft)).toBeUndefined();
    expect(payFieldAtFault({ ...draft, often: 'none', firstHalf: '99' })).toBeUndefined();
  });

  it('says which earning codes are at fault: the one that is not a code, or every one that is the same as another', () => {
    const codes = { regular: 'REG', overtime: 'OT', double: 'DT', holiday: 'HOL', pto: 'PTO', sick: 'SICK' };
    expect(codesAtFault(codes)).toEqual([]);
    expect(codesAtFault({ ...codes, holiday: '' })).toEqual(['holiday']);
    expect(codesAtFault({ ...codes, double: 'D/T', sick: 'a code far too long' })).toEqual(['double', 'sick']);
    expect(codesAtFault({ ...codes, pto: 'OT' })).toEqual(['overtime', 'pto']);
    expect(codesAtFault({ ...codes, pto: 'OT', sick: 'OT', holiday: 'REG' })).toEqual(['regular', 'holiday', 'overtime', 'pto', 'sick']);
    // A code that happens to be one the check is made beside is still only itself.
    expect(codesAtFault({ ...codes, regular: 'QA', overtime: 'QF' })).toEqual([]);
  });

  it('leaves the pay periods and the codes alone while the time clock is off, as the form does not show them', () => {
    expect(companyProblems({ ...draft, timeClock: false, firstHalf: '99', codes: { ...draft.codes, overtime: 'REG' } })).toEqual({});
  });
});

describe('what is said about the phones on every page that saves', () => {
  it('is that phones do not receive what is saved here, in so many words, with nothing that reads as "at the next sync"', () => {
    expect(PHONES_DO_NOT_RECEIVE).toBe('Phones do not receive changes from the office yet');
    expect(SAVED_HERE_ONLY).toBe('Saved to the company and shown on this dashboard. Phones do not receive it yet.');
    const all = [PHONES_DO_NOT_RECEIVE, SAVED_HERE_ONLY, ...ON_PHONES.fleet, ...ON_PHONES.sheets, ...ON_PHONES.company].join(' ');
    expect(all).not.toMatch(/pick up|once the app receives from the office/i);
  });

  it('says on each page what to do today, and what a supervisor’s phone undoes', () => {
    expect(ON_PHONES.fleet.join(' ')).toContain('add it on a supervisor’s phone, on Crew → Fleet');
    expect(ON_PHONES.fleet.join(' ')).toContain('A unit taken out here is put back when a supervisor’s phone that still has it sends it again.');
    expect(ON_PHONES.sheets.join(' ')).toContain('on Crew → Area sheets, under the same name');
    expect(ON_PHONES.sheets.join(' ')).toContain('sends its own copy, which replaces what is saved here, a sheet stopped here included');
    expect(ON_PHONES.company.join(' ')).toContain('A supervisor’s phone that changes a shared setting, the clock-in pin included, sends its own copy of them all, and that replaces what is saved here.');
    expect(ON_PHONES.company.join(' ')).toContain('Make the same change on the supervisors’ phones first');
  });

  it('calls the company’s row on the server by what it holds', () => {
    expect(SIGN_IN_DETAILS).toBe('the company’s sign-in details (its name, state, time zone and pay period)');
  });
});
