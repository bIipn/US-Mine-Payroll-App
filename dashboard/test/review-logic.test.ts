import { describe, expect, it } from 'vitest';

import { sheetInUse } from '@app/domain/areaExam';
import { revOf } from '@app/domain/sync';
import type { AreaSheet, Equipment, Inspection } from '@app/domain/types';

import { repeatWords, rowAfter, saveRecord, type SaveDeps } from '../src/lib/changes';
import type { RecordRow } from '../src/lib/server';
import { openOnUnit, standings } from '../src/lib/setup';

/**
 * Review findings on the Fleet, Exam sheets and Company pages (data and logic),
 * each written as the behaviour that is wanted, with the server's own rule
 * stood in for. Every unit, sheet and account here is made up.
 */

const NOW = Date.UTC(2026, 10, 17, 18);
const DAY = 86_400_000;

const wash: AreaSheet = { id: 'wash_bay', title: 'Wash bay', rows: [{ id: 'hose_reel', label: 'Hose reel' }], active: true };

/**
 * A stand-in for `push_records` as a supervisor meets it for the four kinds
 * phones receive, with rule 7 of
 * supabase/migrations/20261120000100_office_changes_reach_phones.sql:
 *
 *  - the server has this version already: accepted, nothing written;
 *  - "this is the caller's own latest change to it sent again (same rev and
 *    base: a batch retried after its answer was lost): accepted, nothing
 *    written". The server looks only at the CALLER's latest change, not at
 *    whether anyone else has written the record since;
 *  - a change made from any version but the one it holds: superseded;
 *  - otherwise written.
 */
function server(first: RecordRow) {
  let stored = first;
  let at = NOW;
  const history: { by: string; rev: string; base?: string }[] = [];
  const as = (who: string): SaveDeps => ({
    read: async () => stored,
    push: async ([change]) => {
      const taken = { accepted: [{ key: change.key, rev: change.rev }], ignored: [] };
      if (stored.rev === change.rev) return taken;
      const mine = [...history].reverse().find((h) => h.by === who);
      if (mine && mine.rev === change.rev && mine.base === change.base) return taken;
      if (change.base !== stored.rev) return { accepted: [], ignored: [{ key: change.key, rev: change.rev, reason: 'superseded' }] };
      at += 60_000;
      stored = rowAfter(change, stored, who, at);
      history.push({ by: who, rev: change.rev, base: change.base });
      return taken;
    },
    me: who,
    now: () => at,
  });
  return { as, stored: () => stored, writes: () => history.length };
}

const rowOf = (sheet: AreaSheet): RecordRow => ({
  kind: 'areaSheet', id: sheet.id, rev: revOf(sheet), data: sheet, deleted: false,
  created_by: 'user-phone', updated_by: 'user-phone', created_at: '2026-11-10T15:00:00.000Z', updated_at: '2026-11-10T15:00:00.000Z',
});

describe('review: a save the server answered "accepted" for without writing it', () => {
  // Two supervisors, each on the dashboard. The first stops using a sheet, the second starts using it
  // again, the first stops it once more. The third change is, to the server, the first one "sent again"
  // (the same version from the same base), so it answers accepted and writes nothing. No other base is
  // written for the four kinds since 20261120000100, so the page says what happened and calls nothing saved.
  it('is never called saved, nor said to be someone else’s change: the page says what the server did, and another supervisor can make it', async () => {
    const s = server(rowOf(wash));
    const what = 'the Wash bay sheet';
    const stop = (loaded: RecordRow) => saveRecord(s.as('user-office-a'), { kind: 'areaSheet', id: wash.id, record: sheetInUse(wash, false), loaded, what });
    const start = (loaded: RecordRow) => saveRecord(s.as('user-office-b'), { kind: 'areaSheet', id: wash.id, record: sheetInUse(wash, true), loaded, what });

    const first = await stop(s.stored());
    expect(first).toMatchObject({ ok: true, same: false });
    expect(s.stored().data).toMatchObject({ active: false });

    const back = await start(s.stored());
    expect(back).toMatchObject({ ok: true, same: false });
    expect(s.stored().data).toMatchObject({ active: true });
    expect(s.writes()).toBe(2);

    // The first supervisor loads the sheet as it is now, in use, and stops using it again.
    const again = await stop(s.stored());
    // Nothing is written, and the page does not say it was.
    expect(s.writes()).toBe(2);
    expect(s.stored().data).toMatchObject({ active: true });
    expect(again).toEqual({ ok: false, why: 'repeat', words: repeatWords(what) });

    // The other supervisor can make it, as the words say.
    const other = (loaded: RecordRow) => saveRecord(s.as('user-office-b'), { kind: 'areaSheet', id: wash.id, record: sheetInUse(wash, false), loaded, what });
    expect(await other(s.stored())).toMatchObject({ ok: true, same: false });
    expect(s.stored().data).toMatchObject({ active: false });
    expect(s.writes()).toBe(3);
    // Stopped now, a press of the first supervisor's is the save it is: the server has it already.
    expect(await stop(s.stored())).toMatchObject({ ok: true, same: true });
    expect(s.writes()).toBe(3);
  });
});

describe('review: a unit’s standing on the Fleet page', () => {
  const unit: Equipment = { id: 'eq_a', unit: 'L-2', category: 'loader', make: 'Test', model: 'One', status: 'ready', meter: 100, meterUnit: 'hrs' };
  // A checklist that red tagged the unit on the phone (a Bad Order on a safety item), with no request sent on it.
  // The checklist reached the server; the phone's change to the unit's own record did not, which is what the
  // server does with a crew phone's copy of a unit someone else wrote last ("superseded"), and with every
  // crew phone once the office has changed the unit.
  const redTagging: Inspection = {
    id: 'i1', equipmentId: 'eq_a', employeeId: 'e1', templateId: 'operator_equipment_checklist', templateVersion: 1,
    startedAt: NOW - DAY, submittedAt: NOW - DAY, meter: 120, result: 'bad_order',
    answers: [{ itemId: 'brakes', answer: 'bo', note: 'Pedal goes to the floor' }],
  };
  const data = { equipment: [unit], inspections: [redTagging], opLogs: [], mrfs: [] };

  it('lists the Bad Order as open on the unit', () => {
    const open = openOnUnit(unit, data);
    expect(open.badOrders).toHaveLength(1);
    expect(open.badOrders[0].hazard).toBe(true);
  });

  it('is red tagged, not "Ready", while a Bad Order on a safety item of one of its checklists is not corrected', () => {
    expect(standings(data).get(unit.id)).toBe('red_tagged');
    expect(openOnUnit(unit, data).redTagged).toBe(true);
  });
});
