import { describe, expect, it } from 'vitest';

import { openFindings } from '@app/domain/areaExam';
import { buildDemoData } from '@app/store/seed';
import type { Equipment, Inspection, Mrf } from '@app/domain/types';
import { addDays, DAY, startOfDay } from '@app/util/format';

import { board, daysOpen, fmtDays, openBadOrders, openRequests, recordDays, redTagSource, repeatedNumbers, unitsDown } from '../src/lib/overview';
import { shapeRecords } from '../src/lib/records';
import { seedRows } from './fixtures';

const NOW = new Date(2026, 10, 16, 14, 30).getTime();

const unit = (id: string, over: Partial<Equipment> = {}): Equipment => ({
  id, unit: id.toUpperCase(), category: 'loader', make: 'Make', model: 'Model', status: 'ready', meter: 100, meterUnit: 'hrs', ...over,
});
const check = (id: string, over: Partial<Inspection>): Inspection => ({
  id, equipmentId: 'l1', employeeId: 'e1', templateId: 'operator_equipment_checklist', templateVersion: 1,
  startedAt: NOW - 600_000, submittedAt: NOW - 300_000, meter: 100, answers: [], result: 'pass', ...over,
});
const request = (id: string, over: Partial<Mrf>): Mrf => ({
  id, number: 1001, requestedBy: 'e1', createdAt: NOW - 86_400_000, description: 'Broken', priority: 'routine',
  items: [], taggedOut: false, status: 'open', history: [], ...over,
});

describe('openBadOrders', () => {
  it('lists each Bad Order not corrected yet, the red-tagged ones first, as the inspector PDF does', () => {
    const data = {
      equipment: [unit('l1')],
      mrfs: [request('m1', { status: 'completed', completedAt: NOW - 1000 }), request('m2', { status: 'in_progress' })],
      inspections: [
        // Corrected: its request is completed.
        check('i1', { answers: [{ itemId: 'brakes', answer: 'bo', note: 'Soft' }], mrfId: 'm1', result: 'bad_order', submittedAt: NOW - 50_000 }),
        // A light out, sent on a request still being worked.
        check('i2', { answers: [{ itemId: 'lights', answer: 'bo', note: 'Tail light out' }], mrfId: 'm2', result: 'defect', submittedAt: NOW - 40_000 }),
        // Steering is a safety item, never sent on a request.
        check('i3', { answers: [{ itemId: 'steering', answer: 'bo', note: 'Loose' }, { itemId: 'tires', answer: 'ok' }], result: 'bad_order', submittedAt: NOW - 90_000 }),
      ],
    };
    const open = openBadOrders(data);
    expect(open.map((b) => [b.key, b.label, b.hazard, b.mrf?.id])).toEqual([
      ['i3:steering', 'Steering', true, undefined],
      ['i2:lights', 'Lights', false, 'm2'],
    ]);
  });

  it('on the sample records, keeps every Bad Order whose request is not completed and none whose request is', () => {
    const shaped = shapeRecords(seedRows(NOW, buildDemoData(NOW)));
    const open = new Set(openBadOrders(shaped.data).map((b) => b.key));
    const mrfOf = new Map(shaped.data.mrfs.map((m) => [m.id, m]));
    let both = 0;
    for (const i of shaped.data.inspections) {
      for (const a of i.answers.filter((x) => x.answer === 'bo')) {
        const done = i.mrfId ? mrfOf.get(i.mrfId)?.status === 'completed' : false;
        expect(open.has(`${i.id}:${a.itemId}`)).toBe(!done);
        both += 1;
      }
    }
    expect(both).toBeGreaterThan(open.size);
    expect(open.size).toBeGreaterThan(0);
  });
});

describe('openRequests', () => {
  it('puts safety first, then high, then routine, the oldest first within each, and leaves completed ones out', () => {
    const list = openRequests([
      request('a', { priority: 'routine', createdAt: 1 }),
      request('b', { priority: 'safety', createdAt: 5 }),
      request('c', { priority: 'high', createdAt: 3 }),
      request('d', { priority: 'safety', createdAt: 2 }),
      request('e', { priority: 'safety', status: 'completed', completedAt: 9 }),
    ]);
    expect(list.map((m) => m.id)).toEqual(['d', 'b', 'c', 'a']);
  });
});

describe('unitsDown', () => {
  it('names the red-tagged units and those with a defect reported, in unit order', () => {
    const down = unitsDown([unit('l10', { status: 'out_of_service' }), unit('l2', { status: 'out_of_service' }), unit('l3', { status: 'defect' }), unit('l4')]);
    expect(down.redTagged.map((e) => e.unit)).toEqual(['L2', 'L10']);
    expect(down.defect.map((e) => e.unit)).toEqual(['L3']);
  });
});

describe('unitsDown across phones', () => {
  it('keeps a unit red tagged while an open red-tag request names it, whatever another phone’s copy of the unit says', () => {
    // Another operator's phone sent its copy of the unit last, still "ready": it never heard of the tag.
    const units = [unit('l1'), unit('l2'), unit('l3', { status: 'defect' })];
    const mrfs = [
      request('m1', { equipmentId: 'l1', taggedOut: true, priority: 'safety' }),
      request('m2', { equipmentId: 'l2' }),
      request('m3', { equipmentId: 'l3', status: 'completed', completedAt: NOW - 1000 }),
    ];
    const down = unitsDown(units, mrfs);
    expect(down.redTagged.map((e) => e.id)).toEqual(['l1']);
    // An open request that did not tag the unit is a defect; a completed one is nothing, but a defect a phone recorded stays.
    expect(down.defect.map((e) => e.id)).toEqual(['l2', 'l3']);
    // A completed red-tag request no longer keeps the tag on, as on the phone.
    expect(unitsDown([unit('l1')], [request('m1', { equipmentId: 'l1', taggedOut: true, status: 'completed', completedAt: NOW })]).redTagged).toEqual([]);
  });

  it('is what the board counts', () => {
    const data = { equipment: [unit('l1')], inspections: [], mrfs: [request('m1', { equipmentId: 'l1', taggedOut: true })], employees: [], shifts: [], leave: [], opLogs: [], exams: [] };
    expect(board({ data } as never, NOW).redTagged.map((e) => e.id)).toEqual(['l1']);
  });
});

describe('redTagSource', () => {
  it('names the open request that keeps the tag on, and the checklist it came from', () => {
    const old = check('old', { result: 'bad_order', submittedAt: NOW - 30 * DAY, mrfId: 'm-old' });
    const mrfs = [
      request('m-old', { equipmentId: 'l1', taggedOut: true, status: 'completed', completedAt: NOW - 29 * DAY, inspectionId: 'old', createdAt: NOW - 30 * DAY }),
      // Tagged again today from a request made by hand, with no checklist.
      request('m-new', { equipmentId: 'l1', taggedOut: true, createdAt: NOW - 3_600_000 }),
    ];
    expect(redTagSource(unit('l1'), { inspections: [old], mrfs })).toEqual({ at: NOW - 3_600_000, mrfId: 'm-new' });
    const fromCheck = check('today', { result: 'bad_order', submittedAt: NOW - 600_000, mrfId: 'm-today' });
    const tagged = request('m-today', { equipmentId: 'l1', taggedOut: true, createdAt: NOW - 500_000, inspectionId: 'today' });
    expect(redTagSource(unit('l1'), { inspections: [old, fromCheck], mrfs: [...mrfs.slice(0, 1), tagged] })).toEqual({ at: NOW - 500_000, mrfId: 'm-today', inspectionId: 'today' });
  });

  it('with no open request, takes the newest Bad Order checklist not corrected yet, and never one whose request is completed', () => {
    const old = check('old', { result: 'bad_order', submittedAt: NOW - 30 * DAY, mrfId: 'm-old' });
    const done = request('m-old', { equipmentId: 'l1', taggedOut: true, status: 'completed', completedAt: NOW - 29 * DAY });
    expect(redTagSource(unit('l1', { status: 'out_of_service' }), { inspections: [old], mrfs: [done] })).toEqual({});
    const unsent = check('unsent', { result: 'bad_order', submittedAt: NOW - 3_600_000 });
    expect(redTagSource(unit('l1', { status: 'out_of_service' }), { inspections: [old, unsent], mrfs: [done] })).toEqual({ at: NOW - 3_600_000, inspectionId: 'unsent' });
  });
});

describe('repeatedNumbers', () => {
  it('finds a number two phones gave to different requests', () => {
    const repeated = repeatedNumbers([request('a', { number: 1001 }), request('b', { number: 1002 }), request('c', { number: 1001 })]);
    expect([...repeated.keys()]).toEqual([1001]);
    expect(repeated.get(1001)!.map((m) => m.id)).toEqual(['a', 'c']);
  });
});

describe('daysOpen', () => {
  it('counts to a tenth of a day, as the safety log does, so the pages and the workbook agree', () => {
    expect(daysOpen(NOW - 2.64 * DAY, NOW)).toBe(2.6);
    expect(fmtDays(daysOpen(NOW - 2.66 * DAY, NOW))).toBe('2.7');
    expect(fmtDays(daysOpen(NOW, NOW))).toBe('0.0');
    expect(daysOpen(NOW + DAY, NOW)).toBe(0);
  });
});

describe('board', () => {
  it('puts any danger first among the open conditions, and takes today as this computer’s day', () => {
    const shaped = shapeRecords(seedRows(NOW, buildDemoData(NOW)));
    const b = board(shaped, NOW);
    expect(b.conditions).toEqual(openFindings(shaped.data.exams));
    expect(b.dangers.every((f) => f.danger)).toBe(true);
    const firstSafe = b.conditions.findIndex((f) => !f.danger);
    expect(b.conditions.slice(firstSafe < 0 ? b.conditions.length : firstSafe).some((f) => f.danger)).toBe(false);
    const today = startOfDay(NOW);
    expect(b.today.inspections.every((i) => i.submittedAt >= today && i.submittedAt < addDays(today, 1))).toBe(true);
    expect(b.today.inspections.length).toBe(shaped.data.inspections.filter((i) => startOfDay(i.submittedAt) === today).length);
  });
});

describe('recordDays', () => {
  it('counts the checklists and exams of each day, newest day first', () => {
    const day = startOfDay(NOW);
    const days = recordDays({
      inspections: [check('a', { submittedAt: day + 1000 }), check('b', { submittedAt: day + 2000 }), check('c', { submittedAt: addDays(day, -2) + 5 })],
      exams: [{ id: 'x', sheetId: 's', area: 'Crusher', employeeId: 'e1', shift: 'day', startedAt: day, submittedAt: day + 3000, rows: [], conditions: [] }],
    });
    expect(days).toEqual([
      { day, checklists: 2, exams: 1 },
      { day: addDays(day, -2), checklists: 1, exams: 0 },
    ]);
  });
});
