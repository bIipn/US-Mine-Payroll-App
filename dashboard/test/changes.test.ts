import { describe, expect, it } from 'vitest';

import { changedSheet, newSheet, sheetInUse } from '@app/domain/areaExam';
import { SAMPLE_COMPANY } from '@app/domain/company';
import { changedUnit, newUnit } from '@app/domain/fleet';
import { changesToSend, DELETED, revOf, type Change, type SyncData } from '@app/domain/sync';
import type { AreaSheet, Equipment, Settings } from '@app/domain/types';

import type { BillingView } from '../src/lib/billing';
import {
  billingRefusal,
  changedSince,
  CONFLICT_WORDS,
  followNewer,
  loadedRow,
  notKeptWords,
  readAnswer,
  refusalWords,
  removeChange,
  rowAfter,
  saveChange,
  saveRecord,
  sentAgain,
  sinceWords,
  whatChanged,
  type SaveDeps,
} from '../src/lib/changes';
import type { RecordRow } from '../src/lib/server';
import { sharedSettings } from '../src/lib/setup';
import { problemWith } from '../src/lib/validate';

/** Every unit, sheet and company here is made up. */

const NOW = Date.UTC(2026, 10, 17, 18);
const ME = 'user-office';
const PHONE = 'user-phone';

const loader: Equipment = { id: 'eq_a', unit: 'L-2', category: 'loader', make: 'Test', model: 'One', status: 'ready', meter: 4250.5, meterUnit: 'hrs' };
const wash: AreaSheet = { id: 'wash_bay', title: 'Wash bay', rows: [{ id: 'hose_reel', label: 'Hose reel' }, { id: 'drain_grate', label: 'Drain grate' }], active: true };

const row = (kind: string, id: string, data: unknown, over: Partial<RecordRow> = {}): RecordRow => ({
  kind,
  id,
  rev: revOf(data),
  data,
  deleted: false,
  created_by: PHONE,
  updated_by: PHONE,
  created_at: '2026-11-10T15:00:00.000Z',
  updated_at: '2026-11-10T15:00:00.000Z',
  ...over,
});

const gone = (kind: string, id: string): RecordRow => row(kind, id, {}, { rev: DELETED, deleted: true, updated_at: '2026-11-12T15:00:00.000Z' });

/** What the app itself would send for the same records: the dashboard has to send the same. */
function fromPhone(data: Partial<SyncData>, synced: Record<string, string> = {}): Change[] {
  const settings: Settings = { company: SAMPLE_COMPANY, site: null, workweekStartsOn: 0, lunchReminders: true, allowSectionAllOk: true, demoLocation: 'gps' };
  const all: SyncData = { employees: [], equipment: [], areaSheets: [], shifts: [], denied: [], leave: [], inspections: [], opLogs: [], exams: [], mrfs: [], settings, ...data };
  return changesToSend(all, synced, new Set());
}

describe('a change as the dashboard sends it', () => {
  it('is the change a supervisor’s phone would send for a new unit: the same key, id, version and record, and no base', () => {
    const made = newUnit([loader], { unit: 'l-16', category: 'loader', make: 'Test', model: 'Two', meter: 12 }, 'eq_new');
    if (!made.ok) throw new Error(made.error);
    const change = saveChange('equipment', made.unit.id, made.unit);
    expect(change).toEqual({ key: 'equipment:eq_new', kind: 'equipment', id: 'eq_new', rev: revOf(made.unit), record: made.unit });
    expect('base' in change).toBe(false);
    expect(change).toEqual(fromPhone({ equipment: [made.unit] }).find((c) => c.kind === 'equipment'));
    expect(change.rev).toMatch(/^[0-9a-f]{20}$/);
  });

  it('gives a new unit an id of its own, made the way the app makes one', () => {
    const made = newUnit([], { unit: 'L-16', category: 'loader', make: '', model: '', meter: 0 });
    expect(made.ok && saveChange('equipment', made.unit.id, made.unit).key).toMatch(/^equipment:eq_[a-z0-9]{12,}$/);
  });

  it('carries the version this page loaded as its base when it changes a record already there', () => {
    const loaded = row('equipment', loader.id, loader);
    const made = changedUnit([loader], loader.id, { category: 'loader', make: 'Other', model: 'One' });
    if (!made.ok) throw new Error(made.error);
    const change = saveChange('equipment', loader.id, made.unit, loaded);
    expect(change.base).toBe(loaded.rev);
    expect(change.rev).toBe(revOf(made.unit));
    expect(change.rev).not.toBe(loaded.rev);
    // The same as the phone's change, made from the version the server confirmed to it.
    expect(change).toEqual(fromPhone({ equipment: [made.unit] }, { 'equipment:eq_a': loaded.rev }).find((c) => c.kind === 'equipment'));
  });

  it('takes a record off as the app does: the version "deleted", no record, from the version loaded', () => {
    const loaded = row('equipment', loader.id, loader);
    expect(removeChange('equipment', loader.id, loaded)).toEqual({ key: 'equipment:eq_a', kind: 'equipment', id: 'eq_a', rev: 'deleted', base: loaded.rev, record: null });
    expect(removeChange('equipment', loader.id, loaded)).toEqual(fromPhone({}, { 'equipment:eq_a': loaded.rev }).find((c) => c.kind === 'equipment'));
  });

  it('gives a sheet the id of its name, so the same area typed on a phone is the same record', () => {
    const made = newSheet([], 'Wash bay areas:', 'Hose reel\nDrain grate');
    if (!made.ok) throw new Error(made.error);
    const change = saveChange('areaSheet', made.sheet.id, made.sheet);
    expect(change.key).toBe('areaSheet:wash_bay');
    expect(change).toEqual(fromPhone({ areaSheets: [made.sheet] }).find((c) => c.kind === 'areaSheet'));
  });

  it('brings back a sheet taken off the server from the deleted version, so the server takes it as an edit', () => {
    const made = newSheet([], 'Wash bay', 'Hose reel');
    if (!made.ok) throw new Error(made.error);
    expect(saveChange('areaSheet', 'wash_bay', made.sheet, gone('areaSheet', 'wash_bay')).base).toBe('deleted');
  });

  it('sends the shared settings under the one id the server keeps them by, with only the four fields a company shares', () => {
    const record = sharedSettings({ company: SAMPLE_COMPANY, site: null, workweekStartsOn: 1, allowSectionAllOk: false });
    const change = saveChange('settings', 'company', record);
    expect(change.key).toBe('settings:company');
    expect(Object.keys(record).sort()).toEqual(['allowSectionAllOk', 'company', 'site', 'workweekStartsOn']);
    const phone = fromPhone({ settings: { company: SAMPLE_COMPANY, site: null, workweekStartsOn: 1, lunchReminders: false, allowSectionAllOk: false, demoLocation: 'gps' } });
    expect(change).toEqual(phone.find((c) => c.kind === 'settings'));
  });

  it('writes records its own checks take, and the same version whatever order the fields come in', () => {
    const unit = newUnit([], { unit: 'P-4', category: 'light_vehicle', make: 'Test', model: 'Three', meter: 61200 }, 'eq_p');
    const sheet = newSheet([], 'Wash bay [OK/BO]', 'Hose reel');
    if (!unit.ok || !sheet.ok) throw new Error('not made');
    expect(problemWith('equipment', unit.unit as never)).toBeUndefined();
    expect(problemWith('areaSheet', sheet.sheet as never)).toBeUndefined();
    expect(problemWith('areaSheet', sheetInUse(sheet.sheet, false) as never)).toBeUndefined();
    expect(problemWith('settings', sharedSettings({ company: { ...SAMPLE_COMPANY, timeClock: false }, site: { name: 'A' }, workweekStartsOn: 6, allowSectionAllOk: true }) as never)).toBeUndefined();
    const { id, unit: number, ...rest } = unit.unit;
    expect(revOf({ ...rest, unit: number, id })).toBe(revOf(unit.unit));
  });
});

describe('the row this page holds', () => {
  it('is found by kind and id, taken off or not, and is the latest when the page holds two', () => {
    const older = row('equipment', 'eq_a', loader);
    const newer = row('equipment', 'eq_a', { ...loader, status: 'defect' }, { updated_at: '2026-11-11T15:00:00.000Z' });
    expect(loadedRow([older, newer, row('areaSheet', 'eq_a', wash)], 'equipment', 'eq_a')).toBe(newer);
    expect(loadedRow([newer, older], 'equipment', 'eq_a')).toBe(newer);
    expect(loadedRow([gone('equipment', 'eq_a')], 'equipment', 'eq_a')?.deleted).toBe(true);
    expect(loadedRow([older], 'equipment', 'eq_b')).toBeUndefined();
  });
});

describe('changed since the page loaded it', () => {
  const loaded = row('equipment', 'eq_a', loader);

  it('is not, while the server has the version the page loaded', () => {
    expect(changedSince(loaded, { ...loaded })).toEqual({ changed: false });
    expect(changedSince(undefined, null)).toEqual({ changed: false });
    expect(changedSince(gone('areaSheet', 'wash_bay'), gone('areaSheet', 'wash_bay'))).toEqual({ changed: false });
  });

  it('is, when a phone sent a newer version, and says which parts of it changed', () => {
    const fresh = row('equipment', 'eq_a', { ...loader, status: 'out_of_service', meter: 4262 }, { updated_at: '2026-11-17T17:00:00.000Z' });
    expect(changedSince(loaded, fresh)).toEqual({ changed: true, how: 'edited', fields: ['last reading', 'status'] });
  });

  it('is, when it was taken off, put back, sent under an id the page never loaded, or hidden from this account', () => {
    expect(changedSince(loaded, gone('equipment', 'eq_a'))).toEqual({ changed: true, how: 'taken_off', fields: [] });
    expect(changedSince(gone('equipment', 'eq_a'), loaded)).toEqual({ changed: true, how: 'put_back', fields: [] });
    expect(changedSince(undefined, loaded)).toEqual({ changed: true, how: 'new_there', fields: [] });
    expect(changedSince(loaded, null)).toEqual({ changed: true, how: 'hidden', fields: [] });
  });

  it('names what changed in each kind of record by the words on the page', () => {
    expect(whatChanged('equipment', loader, { ...loader, make: 'Other', model: 'Two', category: 'dozer', unit: 'L-3', meterUnit: 'mi' })).toEqual(['type', 'make', 'hours or miles', 'model', 'unit number']);
    expect(whatChanged('areaSheet', wash, { ...wash, title: 'Truck wash', rows: [], active: false, single: true })).toEqual(['whether it is in use', 'lines', 'columns', 'name']);
    const settings = sharedSettings({ company: SAMPLE_COMPANY, site: null, workweekStartsOn: 0, allowSectionAllOk: true });
    const other = sharedSettings({
      company: { ...SAMPLE_COMPANY, name: 'Other Co.', state: 'NV', place: 'Somewhere', mineId: '0400123', pay: null, timeClock: false, payCodes: { regular: '1', overtime: '2', double: '3', holiday: '4', pto: '5', sick: '6' } },
      site: { name: 'A', center: { lat: 1, lng: 2 }, radiusM: 500 },
      workweekStartsOn: 1,
      allowSectionAllOk: false,
    });
    expect(whatChanged('settings', settings, other)).toEqual([
      '“Rest are OK” switch', 'mine ID', 'company name', 'pay schedule', 'earning codes', 'place', 'state', 'time clock', 'clock-in site', 'workweek',
    ]);
    expect(whatChanged('equipment', loader, { ...loader })).toEqual([]);
    // A field the page has no word for is named as it is, and a record of another kind too.
    expect(whatChanged('equipment', loader, { ...loader, colour: 'yellow' })).toEqual(['colour']);
    expect(whatChanged('mrf', { status: 'open' }, { status: 'completed' })).toEqual(['status']);
  });

  it('tells the supervisor what happened, that nothing was saved, and to look again', () => {
    expect(sinceWords({ changed: true, how: 'edited', fields: ['status', 'last reading'] }, 'unit L-2')).toBe(
      'Unit L-2 was changed on a phone after this page loaded it: its status and last reading changed. Nothing was saved. The page now shows the newer version. Look at it again, then save if the change is still wanted.',
    );
    expect(sinceWords({ changed: true, how: 'edited', fields: [] }, 'the Wash bay sheet')).toContain('The Wash bay sheet was changed on a phone after this page loaded it. Nothing was saved.');
    expect(sinceWords({ changed: true, how: 'edited', fields: ['name', 'lines', 'columns'] }, 'the Wash bay sheet')).toContain('its name, lines and columns changed');
    expect(sinceWords({ changed: true, how: 'taken_off', fields: [] }, 'unit L-2')).toBe('Unit L-2 was taken off after this page loaded it. Nothing was saved. The page now shows it as it is on the server.');
    expect(sinceWords({ changed: true, how: 'put_back', fields: [] }, 'unit L-2')).toContain('was put back after this page loaded it. Nothing was saved.');
    expect(sinceWords({ changed: true, how: 'new_there', fields: [] }, 'the Wash bay sheet')).toContain('The server already has the Wash bay sheet: it was sent after this page loaded. Nothing was saved.');
    expect(sinceWords({ changed: true, how: 'hidden', fields: [] }, 'unit L-2')).toContain('Open Billing, or sign out and back in.');
  });

  it('speaks of the settings as the plural they are', () => {
    expect(sinceWords({ changed: true, how: 'edited', fields: ['“Rest are OK” switch', 'place'] }, 'the company settings', { plural: true })).toBe(
      'The company settings were changed on a phone after this page loaded them: the “Rest are OK” switch and place changed. Nothing was saved. The page now shows the newer version. Look at them again, then save if the change is still wanted.',
    );
    expect(sinceWords({ changed: true, how: 'taken_off', fields: [] }, 'the company settings', { plural: true })).toBe(
      'The company settings were taken off after this page loaded them. Nothing was saved. The page now shows them as they are on the server.',
    );
    expect(refusalWords('private', 'the company settings', undefined, { plural: true })).toContain('The server will not keep the company settings as they were sent: they hold something that never leaves a phone');
    expect(refusalWords('too_large', 'the company settings', undefined, { plural: true })).toContain('The company settings are too large for the server to keep (256 KB at most). Nothing was saved. Shorten them and save again.');
  });
});

describe('a form over a record that has a newer version', () => {
  const opened = { title: 'Wash bay', rows: 'Hose reel\nDrain grate', single: false };

  it('takes the newer value in every field nobody touched, so saving after a look does not put the old one back', () => {
    const typed = { ...opened, rows: 'Hose reel\nDrain grate\nOil separator' };
    const newer = { title: 'Truck wash', rows: 'Hose reel\nDrain grate', single: true };
    expect(followNewer(opened, typed, newer)).toEqual({ title: 'Truck wash', rows: 'Hose reel\nDrain grate\nOil separator', single: true });
  });

  it('keeps what was typed in a field the newer version changed too: the supervisor is told, and decides', () => {
    const typed = { ...opened, title: 'Wash rack' };
    const newer = { ...opened, title: 'Truck wash' };
    expect(followNewer(opened, typed, newer).title).toBe('Wash rack');
  });

  it('leaves an untouched form exactly as the newer version, and a newer version that changed nothing changes nothing', () => {
    const newer = { title: 'Truck wash', rows: 'Hose reel', single: true };
    expect(followNewer(opened, { ...opened }, newer)).toEqual(newer);
    const typed = { ...opened, single: true };
    expect(followNewer(opened, typed, { ...opened })).toEqual(typed);
  });

  it('compares fields by what they hold, not by which object holds it', () => {
    const was = { codes: { regular: 'REG', overtime: 'OT' }, name: 'A' };
    const typed = { codes: { overtime: 'OT', regular: 'REG' }, name: 'B' };
    const newer = { codes: { regular: '01', overtime: '02' }, name: 'A' };
    expect(followNewer(was, typed, newer)).toEqual({ codes: { regular: '01', overtime: '02' }, name: 'B' });
  });
});

describe('what the server said about a change', () => {
  const change = { key: 'equipment:eq_a', rev: 'aaaaaaaaaaaaaaaaaaaa' };

  it('is taken when the change is among the accepted, with or without a conflict', () => {
    expect(readAnswer({ accepted: [{ key: 'equipment:eq_a', rev: 'aaaaaaaaaaaaaaaaaaaa' }], ignored: [] }, change, 'unit L-2')).toEqual({ ok: true, conflict: false });
    expect(readAnswer({ accepted: [{ key: 'equipment:eq_a', rev: 'aaaaaaaaaaaaaaaaaaaa', conflict: true }], ignored: [] }, change, 'unit L-2')).toEqual({ ok: true, conflict: true });
    // PostgREST may hand a function's answer back as a list of one.
    expect(readAnswer([{ accepted: [{ key: 'equipment:eq_a', rev: 'aaaaaaaaaaaaaaaaaaaa' }], ignored: [] }], change, 'unit L-2')).toEqual({ ok: true, conflict: false });
  });

  it('is turned down, in plain words, when the server set it aside', () => {
    const said = (reason: string, problem?: string) => readAnswer({ accepted: [], ignored: [{ ...change, reason, ...(problem ? { problem } : null) }] }, change, 'unit L-2');
    expect(said('supervisor_only')).toEqual({
      ok: false,
      reason: 'supervisor_only',
      later: false,
      words: 'Only a supervisor of the company can change unit L-2, and the server says this account is not one now. Nothing was saved. Sign out and back in if your role changed, or ask another supervisor.',
    });
    expect(said('private')).toMatchObject({
      ok: false,
      reason: 'private',
      words: 'The server will not keep unit L-2 as it was sent: it holds something that never leaves a phone, such as a pay rate, or a setting the company does not share. Nothing was saved. Reload the page and try again.',
    });
    const already = 'The server already has unit L-2 under the same id, sent by a phone before this page saw it. Nothing was saved. Load new records and look at what is there.';
    expect(said('copy')).toMatchObject({ reason: 'copy', words: already });
    expect(said('taken')).toMatchObject({ reason: 'taken', words: already });
    expect(said('superseded')).toMatchObject({ words: 'Someone else changed unit L-2 since this page loaded it. Nothing was saved. Load new records and look again.' });
    expect(said('deleted')).toMatchObject({ words: 'Unit L-2 was taken off on the server, and only a supervisor puts it back. Nothing was saved. Sign out and back in if your role changed.' });
    expect(said('too_large')).toMatchObject({ words: 'Unit L-2 is too large for the server to keep (256 KB at most). Nothing was saved. Shorten it and save again.' });
    expect(said('malformed', 'Change 1 has a key that is not its kind and id.')).toMatchObject({
      words: 'The server could not take unit L-2 (it said: Change 1 has a key that is not its kind and id). Nothing was saved. Reload the page and try again. If it keeps happening, tell whoever runs MineMuster for your company.',
    });
    expect(said('some_new_reason')).toMatchObject({ reason: 'some_new_reason', words: expect.stringContaining('(reason: some new reason). Nothing was saved.') });
  });

  it('is left for later when the server has taken all it takes in a call or a day', () => {
    const later = (reason: string) => readAnswer({ accepted: [], ignored: [], deferred: [{ ...change, reason }] }, change, 'unit L-2');
    expect(later('daily_limit')).toEqual({ ok: false, reason: 'daily_limit', later: true, words: 'This account has sent as much as the server takes from one account in a day. Nothing was saved. Save again tomorrow.' });
    expect(later('call_size')).toMatchObject({ later: true, words: 'The server took too much in one call to take unit L-2 as well. Nothing was saved. Save again.' });
  });

  it('is not known when the answer does not name the change, or names another version of it', () => {
    const unknown = { ok: false, reason: 'unknown', later: false, words: 'The server did not say whether unit L-2 was saved. Load new records to see what it has.' };
    expect(readAnswer({ accepted: [], ignored: [] }, change, 'unit L-2')).toEqual(unknown);
    expect(readAnswer({ accepted: [{ key: 'equipment:eq_a', rev: 'bbbbbbbbbbbbbbbbbbbb' }] }, change, 'unit L-2')).toEqual(unknown);
    expect(readAnswer(null, change, 'unit L-2')).toEqual(unknown);
    expect(readAnswer('ok', change, 'unit L-2')).toEqual(unknown);
    expect(readAnswer({ accepted: 'yes', ignored: [null, 3] }, change, 'unit L-2')).toEqual(unknown);
    expect(refusalWords('unknown', 'the company settings', undefined, { plural: true })).toBe('The server did not say whether the company settings were saved. Load new records to see what it has.');
  });

  it('names what the save was doing when only a supervisor may do it: adding, changing or taking out', () => {
    const only = (doing: 'add' | 'change' | 'remove') => refusalWords('supervisor_only', 'unit Z-99', undefined, { doing });
    expect(only('add')).toContain('Only a supervisor of the company can add unit Z-99, and the server says this account is not one now.');
    expect(only('change')).toContain('Only a supervisor of the company can change unit Z-99,');
    expect(only('remove')).toContain('Only a supervisor of the company can take out unit Z-99,');
    expect(refusalWords('supervisor_only', 'unit Z-99')).toContain('can change unit Z-99,');
  });
});

describe('the billing gate on a save', () => {
  const known = (access: string): BillingView => ({
    kind: 'known',
    billing: { access: access as never, status: null, trialEnd: null, periodEnd: null, cancelAtPeriodEnd: false, running: 0, hadTrial: false },
  });

  it('lets a save through while the company has MineMuster', () => {
    for (const access of ['trial', 'active', 'past_due', 'comped']) expect(billingRefusal(known(access))).toBeNull();
  });

  it('turns one back, in plain words, when the company has none or it has ended', () => {
    expect(billingRefusal(known('none'))).toBe('Nothing was saved: the company has no MineMuster trial or subscription yet. Open Billing to start the free trial.');
    expect(billingRefusal(known('ended'))).toBe('Nothing was saved: the company’s MineMuster subscription has ended. Open Billing to start it again.');
  });

  it('shuts nothing on a check that failed or a server with no billing yet: the page keeps the answer it had', () => {
    expect(billingRefusal({ kind: 'failed', message: 'no answer' })).toBeNull();
    expect(billingRefusal({ kind: 'missing' })).toBeNull();
    expect(billingRefusal({ kind: 'checking' })).toBeNull();
  });
});

describe('saving one record', () => {
  /** A stand-in for the server: one record store, taking what push_records would take from a supervisor. */
  function server(rows: RecordRow[] = [], answer?: (change: Change) => unknown) {
    const store = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r]));
    const pushed: Change[] = [];
    let reads = 0;
    const deps: SaveDeps = {
      read: async (kind, id) => {
        reads += 1;
        return store.get(`${kind}:${id}`) ?? null;
      },
      push: async (changes) => {
        pushed.push(...changes);
        const [change] = changes;
        if (answer) return answer(change);
        const had = store.get(change.key);
        store.set(change.key, { ...rowAfter(change, had, 'server-says-me', NOW + 5), updated_at: '2026-11-17T18:00:01.000Z' });
        return { accepted: [{ key: change.key, rev: change.rev, ...(had && change.base !== had.rev ? { conflict: true } : null) }], ignored: [] };
      },
      me: ME,
      now: () => NOW,
    };
    return { deps, store, pushed, reads: () => reads };
  }

  it('adds a new record and hands back the row the server now has', async () => {
    const s = server();
    const saved = await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: loader, what: 'unit L-2' });
    expect(saved).toMatchObject({ ok: true, conflict: false, same: false });
    expect(s.pushed).toEqual([{ key: 'equipment:eq_a', kind: 'equipment', id: 'eq_a', rev: revOf(loader), record: loader }]);
    expect(saved.ok && saved.row).toBe(s.store.get('equipment:eq_a'));
    expect(saved.ok && saved.row.updated_by).toBe('server-says-me');
  });

  it('changes a record from the version the page loaded, after reading it again', async () => {
    const loaded = row('equipment', loader.id, loader);
    const s = server([loaded]);
    const next = { ...loader, make: 'Other' };
    const saved = await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: next, loaded, what: 'unit L-2' });
    expect(saved).toMatchObject({ ok: true, conflict: false, same: false });
    expect(s.pushed[0]).toMatchObject({ base: loaded.rev, rev: revOf(next), record: next });
    expect(saved.ok && saved.row.created_by).toBe(PHONE);
  });

  it('does not overwrite a version a phone sent after the page loaded: nothing is sent, and it says what changed', async () => {
    const loaded = row('equipment', loader.id, loader);
    const fresh = row('equipment', loader.id, { ...loader, status: 'out_of_service' }, { updated_at: '2026-11-17T17:30:00.000Z' });
    const s = server([fresh]);
    const saved = await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: { ...loader, make: 'Other' }, loaded, what: 'unit L-2' });
    expect(s.pushed).toEqual([]);
    expect(saved).toEqual({
      ok: false,
      why: 'changed',
      how: 'edited',
      fresh,
      words: 'Unit L-2 was changed on a phone after this page loaded it: its status changed. Nothing was saved. The page now shows the newer version. Look at it again, then save if the change is still wanted.',
    });
    // Looked at again, the same save goes from the newer version.
    const again = await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: { ...loader, status: 'out_of_service', make: 'Other' }, loaded: fresh, what: 'unit L-2' });
    expect(again.ok).toBe(true);
    expect(s.pushed[0].base).toBe(fresh.rev);
  });

  it('does not take a unit out that was changed since, or add a sheet under an id the server already has', async () => {
    const loaded = row('equipment', loader.id, loader);
    const fresh = row('equipment', loader.id, { ...loader, status: 'out_of_service' });
    const s = server([fresh, row('areaSheet', 'wash_bay', wash)]);
    expect(await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: null, loaded, what: 'unit L-2' })).toMatchObject({ ok: false, why: 'changed', how: 'edited' });
    expect(await saveRecord(s.deps, { kind: 'areaSheet', id: 'wash_bay', record: { ...wash, rows: [] }, what: 'the Wash bay sheet' })).toMatchObject({ ok: false, why: 'changed', how: 'new_there' });
    expect(s.pushed).toEqual([]);
  });

  it('stops when the server no longer shows the record to this account', async () => {
    const loaded = row('equipment', loader.id, loader);
    const saved = await saveRecord(server().deps, { kind: 'equipment', id: loader.id, record: { ...loader, make: 'Other' }, loaded, what: 'unit L-2' });
    expect(saved).toMatchObject({ ok: false, why: 'changed', how: 'hidden', fresh: null });
  });

  it('takes a record off from the version loaded, and the page then holds it as taken off', async () => {
    const loaded = row('equipment', loader.id, loader);
    const s = server([loaded]);
    const saved = await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: null, loaded, what: 'unit L-2' });
    expect(s.pushed).toEqual([{ key: 'equipment:eq_a', kind: 'equipment', id: 'eq_a', rev: 'deleted', base: loaded.rev, record: null }]);
    expect(saved.ok && saved.row).toMatchObject({ deleted: true, rev: 'deleted', data: {} });
  });

  it('sends nothing when nothing changed, or when there is nothing on the server to take off', async () => {
    const loaded = row('areaSheet', wash.id, wash);
    const s = server([loaded]);
    const same = changedSheet([wash], wash.id, 'Wash bay', 'Hose reel\nDrain grate');
    if (!same.ok) throw new Error(same.error);
    expect(await saveRecord(s.deps, { kind: 'areaSheet', id: wash.id, record: same.sheet, loaded, what: 'the Wash bay sheet' })).toEqual({ ok: true, row: loaded, conflict: false, same: true });
    expect(await saveRecord(s.deps, { kind: 'areaSheet', id: 'never_there', record: null, what: 'a sheet' })).toMatchObject({ ok: true, same: true });
    expect(s.pushed).toEqual([]);
  });

  it('puts back a record that was taken off, from the deleted version', async () => {
    const loaded = gone('areaSheet', wash.id);
    const s = server([loaded]);
    const saved = await saveRecord(s.deps, { kind: 'areaSheet', id: wash.id, record: wash, loaded, what: 'the Wash bay sheet' });
    expect(s.pushed[0]).toMatchObject({ base: 'deleted', rev: revOf(wash) });
    expect(saved).toMatchObject({ ok: true, conflict: false });
  });

  it('says so when its save went over a version sent in the moment between the check and the save', async () => {
    const loaded = row('equipment', loader.id, loader);
    const s = server([loaded]);
    // A phone's version lands after this page read the record and before its save does.
    const push = s.deps.push;
    s.deps.push = async (changes) => {
      s.store.set('equipment:eq_a', row('equipment', loader.id, { ...loader, meter: 4300 }, { updated_at: '2026-11-17T17:59:59.000Z' }));
      return push(changes);
    };
    const saved = await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: { ...loader, make: 'Other' }, loaded, what: 'unit L-2' });
    expect(saved).toMatchObject({ ok: true, conflict: true, same: false });
    expect(CONFLICT_WORDS).toBe('A phone sent a newer version at the same moment, and this save went over it. Look at it again to be sure it is right.');
    // What the page then holds is the row the server holds, not what the page supposes it holds.
    expect(saved.ok && saved.row).toBe(s.store.get('equipment:eq_a'));
    expect(saved.ok && saved.row.rev).toBe(s.pushed[0].rev);
  });

  it('counts a press that was already taken as the save it is: a new unit whose first answer was lost', async () => {
    // The first press was written and its answer never came back. The form kept its fields and the unit's id.
    const there = row('equipment', loader.id, loader, { created_by: ME, updated_by: ME });
    const s = server([there]);
    const saved = await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: loader, what: 'unit L-2' });
    expect(saved).toEqual({ ok: true, row: there, conflict: false, same: true });
    expect(s.pushed).toEqual([]);
    // With anything about it changed since, it is a record the page never loaded, and is said to be.
    expect(await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: { ...loader, model: 'Two' }, what: 'unit L-2' })).toMatchObject({ ok: false, why: 'changed', how: 'new_there' });
  });

  it('counts a change, or a taking off, the server already holds as done, and does not call it a phone’s', async () => {
    const loaded = row('equipment', loader.id, loader);
    const next = { ...loader, make: 'Other' };
    const s = server([row('equipment', loader.id, next, { updated_by: ME, updated_at: '2026-11-17T17:59:00.000Z' })]);
    expect(await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: next, loaded, what: 'unit L-2' })).toMatchObject({ ok: true, same: true, row: { rev: revOf(next) } });
    const off = server([gone('equipment', loader.id)]);
    expect(await saveRecord(off.deps, { kind: 'equipment', id: loader.id, record: null, loaded, what: 'unit L-2' })).toMatchObject({ ok: true, same: true, row: { deleted: true } });
    expect([...s.pushed, ...off.pushed]).toEqual([]);
  });

  it('sends a change the server took for one sent already once more, in a form it writes', async () => {
    const loaded = row('areaSheet', wash.id, wash);
    // The server answers "accepted" and writes nothing while the change has its sender's own version as... anything but its base.
    const s = server([loaded]);
    const write = s.deps.push;
    s.deps.push = async (changes) => {
      const [change] = changes;
      if (change.base !== change.rev) {
        s.pushed.push(change);
        return { accepted: [{ key: change.key, rev: change.rev }], ignored: [] };
      }
      return write(changes);
    };
    const stopped = sheetInUse(wash, false);
    const saved = await saveRecord(s.deps, { kind: 'areaSheet', id: wash.id, record: stopped, loaded, what: 'the Wash bay sheet' });
    expect(s.pushed).toHaveLength(2);
    expect(s.pushed[0]).toMatchObject({ rev: revOf(stopped), base: loaded.rev });
    expect(s.pushed[1]).toEqual(sentAgain(s.pushed[0]));
    expect(s.pushed[1]).toMatchObject({ rev: revOf(stopped), base: revOf(stopped), record: stopped });
    // Saved for real: the row is the server's, and the page says nothing of a conflict, for there was none.
    expect(saved).toMatchObject({ ok: true, conflict: false, same: false });
    expect(saved.ok && saved.row).toBe(s.store.get('areaSheet:wash_bay'));
    expect(s.store.get('areaSheet:wash_bay')?.data).toMatchObject({ active: false });
  });

  it('never calls a change saved that the server does not hold: it says so, and hands the page the server’s row', async () => {
    const loaded = row('areaSheet', wash.id, wash);
    // A server that answers "accepted" to everything and writes nothing.
    const s = server([loaded], (change) => ({ accepted: [{ key: change.key, rev: change.rev }], ignored: [] }));
    const saved = await saveRecord(s.deps, { kind: 'areaSheet', id: wash.id, record: sheetInUse(wash, false), loaded, what: 'the Wash bay sheet' });
    expect(s.pushed).toHaveLength(2);
    expect(saved).toEqual({
      ok: false,
      why: 'not_kept',
      fresh: loaded,
      words: 'The server did not keep the change to the Wash bay sheet: it still has the version it had before. Nothing was saved. The page shows what the server has. Look at it again, then save if the change is still wanted.',
    });
  });

  it('says so when another version is on the server once it has answered, and does not send over it', async () => {
    const loaded = row('equipment', loader.id, loader);
    const other = row('equipment', loader.id, { ...loader, status: 'out_of_service' }, { updated_at: '2026-11-17T18:00:02.000Z' });
    const s = server([loaded]);
    const write = s.deps.push;
    s.deps.push = async (changes) => {
      const answer = await write(changes);
      // A phone's version lands the moment after this save was written.
      s.store.set('equipment:eq_a', other);
      return answer;
    };
    const saved = await saveRecord(s.deps, { kind: 'equipment', id: loader.id, record: { ...loader, make: 'Other' }, loaded, what: 'unit L-2' });
    expect(s.pushed).toHaveLength(1);
    expect(saved).toEqual({
      ok: false,
      why: 'not_kept',
      fresh: other,
      words: 'Another version of unit L-2 arrived at the same moment as this save, and the server has that one now. The page shows what the server has. Look at it again, then save if the change is still wanted.',
    });
    expect(notKeptWords('the company settings', false, { plural: true })).toContain('Look at them again, then save if the change is still wanted.');
  });

  it('does not know what became of a change the server took and then shows nothing of', async () => {
    const loaded = row('equipment', loader.id, loader);
    let reads = 0;
    const deps: SaveDeps = {
      read: async () => (reads++ === 0 ? loaded : null),
      push: async ([change]) => ({ accepted: [{ key: change.key, rev: change.rev }], ignored: [] }),
      me: ME,
      now: () => NOW,
    };
    expect(await saveRecord(deps, { kind: 'equipment', id: loader.id, record: { ...loader, make: 'Other' }, loaded, what: 'unit L-2' })).toMatchObject({ ok: false, why: 'unknown' });
  });

  it('puts the server’s refusal into words and changes nothing on the page', async () => {
    const loaded = row('equipment', loader.id, loader);
    const refuse = (reason: string, list: 'ignored' | 'deferred' = 'ignored') =>
      saveRecord(server([loaded], (change) => ({ accepted: [], ignored: [], [list]: [{ key: change.key, rev: change.rev, reason }] })).deps, {
        kind: 'equipment', id: loader.id, record: { ...loader, make: 'Other' }, loaded, what: 'unit L-2',
      });
    expect(await refuse('supervisor_only')).toMatchObject({ ok: false, why: 'refused', reason: 'supervisor_only', words: expect.stringContaining('Only a supervisor of the company can change unit L-2') });
    // A new unit is said to be added, and a unit taken out to be taken off.
    const turnedDown = (change: Change) => ({ accepted: [], ignored: [{ key: change.key, rev: change.rev, reason: 'supervisor_only' }] });
    expect(await saveRecord(server([], turnedDown).deps, { kind: 'equipment', id: 'eq_z', record: { ...loader, id: 'eq_z', unit: 'Z-99' }, what: 'unit Z-99' })).toMatchObject({ words: expect.stringContaining('can add unit Z-99,') });
    expect(await saveRecord(server([loaded], turnedDown).deps, { kind: 'equipment', id: loader.id, record: null, loaded, what: 'unit L-2' })).toMatchObject({ words: expect.stringContaining('can take out unit L-2,') });
    expect(await refuse('private')).toMatchObject({ ok: false, why: 'refused', reason: 'private' });
    expect(await refuse('daily_limit', 'deferred')).toMatchObject({ ok: false, why: 'later', reason: 'daily_limit' });
    expect(await saveRecord(server([loaded], () => ({})).deps, { kind: 'equipment', id: loader.id, record: { ...loader, make: 'Other' }, loaded, what: 'unit L-2' })).toMatchObject({ ok: false, why: 'unknown' });
  });

  it('never sends a record the server could not take for its size', async () => {
    const big = { ...wash, rows: Array.from({ length: 9000 }, (_, i) => ({ id: `line_${i}`, label: `Line ${i} `.repeat(4) })) };
    const s = server();
    const saved = await saveRecord(s.deps, { kind: 'areaSheet', id: wash.id, record: big, what: 'the Wash bay sheet' });
    expect(saved).toMatchObject({ ok: false, why: 'too_large', words: expect.stringContaining('too large for the server to keep') });
    expect(s.pushed).toEqual([]);
  });

  it('lets what goes wrong reaching the server be thrown, for the page to say', async () => {
    const down: SaveDeps = { read: async () => { throw new Error('offline'); }, push: async () => ({}), me: ME, now: () => NOW };
    await expect(saveRecord(down, { kind: 'equipment', id: loader.id, record: loader, what: 'unit L-2' })).rejects.toThrow('offline');
    const loaded = row('equipment', loader.id, loader);
    const half: SaveDeps = { read: async () => loaded, push: async () => { throw new Error('signed out'); }, me: ME, now: () => NOW };
    await expect(saveRecord(half, { kind: 'equipment', id: loader.id, record: { ...loader, make: 'Other' }, loaded, what: 'unit L-2' })).rejects.toThrow('signed out');
  });

  it('still counts as saved when the read after it fails: the page shows what was sent', async () => {
    let reads = 0;
    const deps: SaveDeps = {
      read: async () => {
        reads += 1;
        if (reads > 1) throw new Error('offline');
        return null;
      },
      push: async ([change]) => ({ accepted: [{ key: change.key, rev: change.rev }], ignored: [] }),
      me: ME,
      now: () => NOW,
    };
    const saved = await saveRecord(deps, { kind: 'equipment', id: loader.id, record: loader, what: 'unit L-2' });
    expect(saved.ok && saved.row).toEqual({
      kind: 'equipment', id: 'eq_a', rev: revOf(loader), data: loader, deleted: false, created_by: ME, updated_by: ME,
      created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
    });
  });
});
