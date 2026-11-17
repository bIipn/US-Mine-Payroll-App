import { describe, expect, it } from 'vitest';

import { sheetInUse } from '@app/domain/areaExam';
import { revOf } from '@app/domain/sync';
import type { AreaSheet, Equipment } from '@app/domain/types';

import { putBackUnits, writtenOver, type VersionRow } from '../src/lib/history';
import { sharedSettings } from '../src/lib/setup';

/** Every company, sheet, unit and account here is made up. */

const OFFICE = 'user-office';
const PHONE = 'user-phone';

/** The versions of one record as the server keeps them: each made from the one named, by rev, or from none. */
function versions(...steps: { data: object | null; from?: number | 'self' | 'none'; by?: string }[]): VersionRow[] {
  const out: VersionRow[] = [];
  steps.forEach((step, i) => {
    const rev = step.data === null ? 'deleted' : revOf(step.data);
    const base = step.from === 'none' || (step.from === undefined && i === 0) ? null : step.from === 'self' ? rev : out[(step.from ?? i) - 1].rev;
    out.push({ version: i + 1, rev, base, data: step.data, deleted: step.data === null, by: step.by ?? PHONE, at: new Date(Date.UTC(2026, 10, 10 + i, 15)).toISOString() });
  });
  // Newest first, as they are read.
  return out.reverse();
}

const company = { name: 'Sample Mining Co.', state: 'CA', pay: null };
const phones = sharedSettings({ company, site: null, workweekStartsOn: 0, allowSectionAllOk: true });
const office = sharedSettings({
  company: { ...company, pay: { frequency: 'weekly', firstDay: '2026-11-01', payday: { daysAfter: 5 }, ifBankClosed: 'before' }, payCodes: { regular: '01', overtime: '02', double: '03', holiday: '04', pto: '05', sick: '06' } },
  site: null,
  workweekStartsOn: 1,
  allowSectionAllOk: true,
});
const pinned = { ...phones, site: { name: 'Sample pit', center: { lat: 1, lng: 2 }, radiusM: 500 } };

describe('a phone’s copy that went over what the office saved', () => {
  it('is found when a supervisor’s phone sets the pin from the settings it knew: the pay schedule, the codes and the workweek go back', () => {
    // The phone sent the settings, the office set the pay period, the codes and the workweek, then the phone
    // set the clock-in pin from the version it had been confirmed: the first.
    const found = writtenOver('settings', versions({ data: phones }, { data: office, by: OFFICE }, { data: pinned, from: 1 }));
    expect(found).toMatchObject({ how: 'replaced', fields: ['pay schedule', 'earning codes', 'workweek'] });
    // The pin is the phone's own change, and is not counted as something undone.
    expect(found?.fields).not.toContain('clock-in site');
    expect(found?.over.by).toBe(OFFICE);
    expect(found?.by.version).toBe(3);
  });

  it('is found whichever account sent the copy: the same supervisor on a phone and in the office is one account', () => {
    expect(writtenOver('settings', versions({ data: phones, by: OFFICE }, { data: office, by: OFFICE }, { data: pinned, from: 1, by: OFFICE }))?.fields).toEqual(['pay schedule', 'earning codes', 'workweek']);
  });

  it('is no longer said once the office has set right what was undone, and is said again when the phone sends its own once more', () => {
    const restored = { ...office, site: pinned.site };
    const fixed = versions({ data: phones }, { data: office, by: OFFICE }, { data: pinned, from: 1 }, { data: restored, by: OFFICE });
    expect(writtenOver('settings', fixed)).toBeNull();
    // Only part set right: the rest is still said.
    const part = { ...pinned, workweekStartsOn: 1 };
    expect(writtenOver('settings', versions({ data: phones }, { data: office, by: OFFICE }, { data: pinned, from: 1 }, { data: part, by: OFFICE }))?.fields).toEqual(['pay schedule', 'earning codes']);
    // The phone, which never receives, changes a switch from the last version it was confirmed: the third.
    const again = { ...pinned, allowSectionAllOk: false };
    const undone = writtenOver('settings', versions({ data: phones }, { data: office, by: OFFICE }, { data: pinned, from: 1 }, { data: restored, by: OFFICE }, { data: again, from: 3 }));
    expect(undone).toMatchObject({ how: 'replaced', fields: ['pay schedule', 'earning codes', 'workweek'] });
    expect(undone?.by.version).toBe(5);
  });

  it('is not found in a record changed one version from the last, by a phone or from here', () => {
    expect(writtenOver('settings', versions({ data: phones }, { data: office, by: OFFICE }))).toBeNull();
    expect(writtenOver('settings', versions({ data: phones }, { data: pinned }, { data: office, by: OFFICE }))).toBeNull();
    expect(writtenOver('settings', versions({ data: phones }))).toBeNull();
    expect(writtenOver('settings', [])).toBeNull();
  });

  it('is not found in a change this dashboard sent again on purpose, which names its own version as its base', () => {
    const wash: AreaSheet = { id: 'wash_bay', title: 'Wash bay', rows: [{ id: 'hose_reel', label: 'Hose reel' }], active: true };
    const off = sheetInUse(wash, false);
    // Stopped, started again by another supervisor, stopped again: the last one had to be sent again.
    expect(writtenOver('areaSheet', versions({ data: wash }, { data: off, by: OFFICE }, { data: wash, by: 'user-office-b' }, { data: off, from: 'self', by: OFFICE }))).toBeNull();
  });

  it('says a sheet stopped here is back in use when a phone changed its lines from the version it knew', () => {
    const wash: AreaSheet = { id: 'wash_bay', title: 'Wash bay', rows: [{ id: 'hose_reel', label: 'Hose reel' }], active: true };
    const longer = { ...wash, rows: [...wash.rows, { id: 'drain_grate', label: 'Drain grate' }] };
    expect(writtenOver('areaSheet', versions({ data: wash }, { data: sheetInUse(wash, false), by: OFFICE }, { data: longer, from: 1 }))).toMatchObject({ how: 'replaced', fields: ['whether it is in use'] });
  });

  it('counts everything the copy changed when the version it was made from is not among those read, or it had none', () => {
    const [newest, before] = versions({ data: phones }, { data: office, by: OFFICE }, { data: pinned, from: 1 });
    expect(writtenOver('settings', [newest, before])?.fields).toEqual(['pay schedule', 'earning codes', 'clock-in site', 'workweek']);
    expect(writtenOver('settings', versions({ data: phones }, { data: office, by: OFFICE }, { data: pinned, from: 'none' }))?.fields).toEqual(['pay schedule', 'earning codes', 'clock-in site', 'workweek']);
  });

  it('says a record taken off is back, and says nothing of one that is off now or of versions that are not next to each other', () => {
    const unit: Equipment = { id: 'eq_t9', unit: 'T-9', category: 'haul_truck', make: 'Test', model: 'One', status: 'ready', meter: 4200, meterUnit: 'hrs' };
    const used = { ...unit, meter: 4300 };
    expect(writtenOver('equipment', versions({ data: unit }, { data: null, by: OFFICE }, { data: used, from: 1 }))).toMatchObject({ how: 'put_back', fields: [] });
    expect(writtenOver('equipment', versions({ data: unit }, { data: used }, { data: null, from: 1, by: OFFICE }))).toBeNull();
    const [third, , first] = versions({ data: unit }, { data: { ...unit, make: 'Other' }, by: OFFICE }, { data: used, from: 1 });
    expect(writtenOver('equipment', [third, first])).toBeNull();
  });
});

describe('units taken out of the fleet that are back in it', () => {
  const unit = (id: string, number: string): Equipment => ({ id, unit: number, category: 'loader', make: 'Test', model: 'One', status: 'ready', meter: 1, meterUnit: 'hrs' });

  it('are the units in the fleet now that were taken out before, with when they last were', () => {
    const fleet = [unit('eq_a', 'L-10'), unit('eq_b', 'L-2'), unit('eq_c', 'T-1')];
    const back = putBackUnits(fleet, [
      { id: 'eq_a', at: '2026-11-10T15:00:00.000Z' },
      { id: 'eq_a', at: '2026-11-12T15:00:00.000Z' },
      { id: 'eq_b', at: '2026-11-11T15:00:00.000Z' },
      { id: 'eq_gone', at: '2026-11-11T15:00:00.000Z' },
      { id: 'eq_c', at: 'not a time' },
    ]);
    expect(back.map((b) => [b.unit.unit, new Date(b.takenOutAt).toISOString()])).toEqual([['L-2', '2026-11-11T15:00:00.000Z'], ['L-10', '2026-11-12T15:00:00.000Z']]);
    expect(putBackUnits(fleet, [])).toEqual([]);
  });
});
