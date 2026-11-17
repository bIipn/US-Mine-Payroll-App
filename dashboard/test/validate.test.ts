import { describe, expect, it } from 'vitest';

import { inspectorReport } from '@app/services/inspectorReport';
import { payrollHoursFile, payrollReport, safetyReport } from '@app/services/reports';
import { buildDemoData } from '@app/store/seed';
import { addDays, startOfDay } from '@app/util/format';

import { board, openBadOrders, recordDays, redTagSource, repeatedNumbers } from '../src/lib/overview';
import { currentSpan, payrollFor, reportRange } from '../src/lib/payroll';
import { doubts } from '../src/lib/provenance';
import { shapeRecords } from '../src/lib/records';
import type { RecordRow } from '../src/lib/server';
import { seedRows } from './fixtures';

const NOW = new Date(2026, 10, 16, 14, 30).getTime();
const rows = seedRows(NOW, buildDemoData(NOW));

type Obj = Record<string, unknown>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const sample = (kind: string) => clone(rows.find((r) => r.kind === kind && (kind !== 'exam' || ((r.data as Obj).rows as unknown[]).length > 0))!);

/** A record of the kind, changed one way, under an id of its own. */
function broken(kind: string, name: string, change: (d: Obj) => void): RecordRow {
  const row = sample(kind);
  const data = row.data as Obj;
  change(data);
  const id = kind === 'settings' ? 'company' : `bad-${kind}-${name}`;
  if (kind !== 'settings') data.id = id;
  return { ...row, id, data, updated_at: new Date(NOW + 60_000).toISOString() };
}

/**
 * Records any member of a company could send, or a phone with a bug: a null where
 * the app writes a list, a list of nulls, a value the app has no word for, a
 * number as text, a field the app always writes left out.
 */
const BAD: [string, string, (d: Obj) => void][] = [
  ['employee', 'no-first-name', (d) => { d.firstName = null; }],
  ['employee', 'role', (d) => { d.role = 'boss'; }],
  ['employee', 'active', (d) => { d.active = 'yes'; }],
  ['equipment', 'type', (d) => { d.category = 'tank'; }],
  ['equipment', 'no-type', (d) => { delete d.category; }],
  ['equipment', 'status', (d) => { d.status = 'broken'; }],
  ['equipment', 'meter', (d) => { d.meter = null; }],
  ['areaSheet', 'rows-null', (d) => { d.rows = null; }],
  ['areaSheet', 'row-null', (d) => { d.rows = [null]; }],
  ['shift', 'clock-in', (d) => { d.clockIn = null; }],
  ['shift', 'clock-out', (d) => { d.clockOut = { at: 'noon' }; }],
  ['shift', 'lunches-null', (d) => { d.lunches = null; }],
  ['shift', 'lunch-null', (d) => { d.lunches = [null]; }],
  ['shift', 'breaks', (d) => { d.breaks = 'none'; }],
  ['shift', 'edit', (d) => { d.edits = [{}]; }],
  ['shift', 'meal-note', (d) => { d.mealNote = 'nap'; }],
  ['leave', 'type', (d) => { d.type = 'vacation'; }],
  ['leave', 'hours', (d) => { d.hours = '8'; }],
  ['inspection', 'answers-null', (d) => { d.answers = null; }],
  ['inspection', 'answer-null', (d) => { d.answers = [null]; }],
  ['inspection', 'answer', (d) => { (d.answers as Obj[])[0].answer = 'maybe'; }],
  ['inspection', 'no-meter', (d) => { delete d.meter; }],
  ['inspection', 'result', (d) => { d.result = 'meh'; }],
  ['inspection', 'started', (d) => { d.startedAt = null; }],
  ['opLog', 'start-meter', (d) => { d.startMeter = null; }],
  ['opLog', 'end', (d) => { d.endAt = 'later'; }],
  ['exam', 'rows-null', (d) => { d.rows = null; }],
  ['exam', 'row-null', (d) => { d.rows = [null]; }],
  ['exam', 'fixed-null', (d) => { (d.rows as Obj[])[0].fixed = null; }],
  ['exam', 'cell', (d) => { (d.rows as Obj[])[0].guarding = 'fine'; }],
  ['exam', 'condition', (d) => { d.conditions = [{ id: 'c1', answer: 'yes' }]; }],
  ['exam', 'no-shift', (d) => { delete d.shift; }],
  ['exam', 'no-area', (d) => { delete d.area; }],
  ['mrf', 'history-null', (d) => { d.history = null; }],
  ['mrf', 'history-line', (d) => { d.history = [null]; }],
  ['mrf', 'priority', (d) => { d.priority = 'urgent'; }],
  ['mrf', 'status', (d) => { d.status = 'done'; }],
  ['mrf', 'items', (d) => { d.items = [null]; }],
  ['mrf', 'tagged', (d) => { d.taggedOut = 'yes'; }],
  ['mrf', 'assigned', (d) => { d.assignedTo = 5; }],
];

describe('a record that is not the shape the app writes', () => {
  it('is set aside with what is wrong with it, kind by kind, and every other record still reads', () => {
    const bad = BAD.map(([kind, name, change]) => broken(kind, name, change));
    const shaped = shapeRecords([...rows, ...bad]);
    const set = new Map(shaped.skipped.map((s) => [s.id, s.why]));
    for (const row of bad) expect(set.has(row.id), `${row.id} is set aside`).toBe(true);
    expect(shaped.skipped.length).toBe(bad.length);
    for (const why of set.values()) expect(why).toMatch(/^(no |a |an |what |who |fuel)/);
    // The good records are all still there.
    expect(shaped.data.inspections.length).toBe(rows.filter((r) => r.kind === 'inspection').length);
    expect(shaped.data.mrfs.length).toBe(rows.filter((r) => r.kind === 'mrf').length);
  });

  it('cannot stop the board, payroll or any file', () => {
    const bad = BAD.map(([kind, name, change]) => broken(kind, name, change));
    const shaped = shapeRecords([...rows, ...bad]);
    const b = board(shaped, NOW);
    expect(b.badOrders.length).toBeGreaterThan(0);
    openBadOrders(shaped.data);
    recordDays(shaped.data);
    repeatedNumbers(shaped.data.mrfs);
    for (const unit of b.redTagged) redTagSource(unit, shaped.data);
    doubts(shaped, []);
    const span = currentSpan('period', NOW, shaped);
    payrollFor(shaped, span, NOW);
    const start = startOfDay(addDays(NOW, -30));
    const end = addDays(startOfDay(NOW), 1);
    inspectorReport(shaped.data, start, end, NOW);
    safetyReport(shaped.data, start, end, NOW);
    payrollReport(shaped.data, reportRange(span), NOW);
    payrollHoursFile(shaped.data, reportRange(span), 'day', NOW);
  });

  it('sets aside settings the app could not read, and falls back to the company on the server', () => {
    const server = { id: 'c', name: 'Test Pit A', state: 'NV', timezone: 'America/Los_Angeles', logo_path: null, pay_period: null };
    for (const change of [
      (d: Obj) => { d.company = null; },
      (d: Obj) => { (d.company as Obj).payCodes = 'REG'; },
      (d: Obj) => { (d.company as Obj).pay = 'weekly'; },
      (d: Obj) => { d.workweekStartsOn = 9; },
    ]) {
      const shaped = shapeRecords([broken('settings', 'x', change)], { company: server });
      expect(shaped.skipped.map((s) => s.kind)).toEqual(['settings']);
      expect(shaped.settingsFrom).toBe('server');
      expect(shaped.company.name).toBe('Test Pit A');
    }
  });

  it('takes a field the app leaves out as the app does, but not a null in its place', () => {
    const fine = sample('mrf');
    const data = fine.data as Obj;
    delete data.history;
    delete data.items;
    const shaped = shapeRecords([fine]);
    expect(shaped.skipped).toEqual([]);
    expect(shaped.data.mrfs[0].history).toEqual([]);
    expect(shaped.data.mrfs[0].items).toEqual([]);
    expect(shapeRecords([{ ...fine, data: { ...data, history: null } }]).skipped[0].why).toBe('a history that is not the shape the app writes');
  });
});
