import { buildDemoData, SAMPLE_CREW_IDS } from '../../store/seed';
import { SAMPLE_COMPANY } from '../company';
import { changesToSend, DELETED, markSent, retryDelay, revOf, sendWaiting, stableJson, syncWords, type Change, type SyncData, type Synced } from '../sync';
import type { Settings } from '../types';

const now = new Date(2026, 10, 13, 10, 42).getTime();
const seed = buildDemoData(now);
const settings = {
  company: SAMPLE_COMPANY,
  site: { name: 'Test pit', center: { lat: 35, lng: -116 }, radiusM: 1000 },
  workweekStartsOn: 0,
  lunchReminders: true,
  allowSectionAllOk: false,
  demoLocation: 'gps',
} as Settings;
const data: SyncData = { ...seed, denied: [], settings };
/** Nobody is held back: the sample crew counts as the company's own people here. */
const none = new Set<string>();

describe('what a phone sends to the company’s server', () => {
  const all = changesToSend(data, {}, none);

  it('sends every shared record once, by its kind and id', () => {
    const keys = all.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const count = (kind: string) => all.filter((c) => c.kind === kind).length;
    expect(count('shift')).toBe(seed.shifts.length);
    expect(count('inspection')).toBe(seed.inspections.length);
    expect(count('exam')).toBe(seed.exams.length);
    expect(count('mrf')).toBe(seed.mrfs.length);
    expect(count('leave')).toBe(seed.leave.length);
    expect(count('employee')).toBe(seed.employees.length);
    expect(count('settings')).toBe(1);
  });

  it('never sends an account, a password or the hourly rate someone entered for their own estimate', () => {
    const text = JSON.stringify(all);
    expect(all.some((c) => (c.kind as string) === 'account')).toBe(false);
    expect(text).not.toMatch(/passwordHash|"salt"|payRates|"cents"/);
    const rated = { ...data, payRates: { [seed.employees[0].id]: 31_250 } } as SyncData;
    expect(JSON.stringify(changesToSend(rated, {}, none))).not.toContain('31250');
  });

  it('sends the company’s settings, but not what belongs to this phone', () => {
    const company = all.find((c) => c.kind === 'settings')!;
    expect(Object.keys(company.record as object).sort()).toEqual(['allowSectionAllOk', 'company', 'site', 'workweekStartsOn']);
    const synced = markSent({}, all);
    const quieter = { ...data, settings: { ...settings, lunchReminders: false, demoLocation: 'at_mine' as const } };
    expect(changesToSend(quieter, synced, none)).toEqual([]);
    const renamed = { ...data, settings: { ...settings, company: { ...SAMPLE_COMPANY, name: 'Renamed Co.' } } };
    expect(changesToSend(renamed, synced, none).map((c) => c.key)).toEqual(['settings:company']);
  });

  it('sends nothing the server already has', () => {
    expect(changesToSend(data, markSent({}, all), none)).toEqual([]);
  });

  it('sends a record again once it changes, and only that record', () => {
    const synced = markSent({}, all);
    const shift = seed.shifts[seed.shifts.length - 1];
    const changed = { ...data, shifts: data.shifts.map((s) => (s.id === shift.id ? { ...s, edits: [...(s.edits ?? []), { at: now, byEmployeeId: 'x', reason: 'Forgot to clock out', field: 'clockOut' as const }] } : s)) } as SyncData;
    expect(changesToSend(changed, synced, none).map((c) => c.key)).toEqual([`shift:${shift.id}`]);
  });

  it('keeps a record waiting when it changed again after the copy the server took', () => {
    const shift = seed.shifts[0];
    const sent = all.filter((c) => c.key === `shift:${shift.id}`);
    const later = { ...data, shifts: data.shifts.map((s) => (s.id === shift.id ? { ...s, clockIn: { ...s.clockIn, at: s.clockIn.at + 60_000 } } : s)) };
    const synced = markSent(markSent({}, all), sent);
    expect(changesToSend(later, synced, none).map((c) => c.key)).toEqual([`shift:${shift.id}`]);
  });

  it('sends the people, the fleet and the sheets ahead of the records that point at them', () => {
    const order = all.map((c) => c.kind).filter((k, i, a) => a.indexOf(k) === i);
    expect(order.indexOf('employee')).toBeLessThan(order.indexOf('shift'));
    expect(order.indexOf('equipment')).toBeLessThan(order.indexOf('inspection'));
    expect(order.indexOf('inspection')).toBeLessThan(order.indexOf('mrf'));
    expect(order.indexOf('areaSheet')).toBeLessThan(order.indexOf('exam'));
    expect(order.indexOf('exam')).toBeLessThan(order.indexOf('mrf'));
  });

  it('never sends a made-up sample person or anything they did', () => {
    const changes = changesToSend(data, {}, SAMPLE_CREW_IDS);
    const sampleIds = [...SAMPLE_CREW_IDS];
    for (const c of changes) {
      const r = c.record as { id?: string; employeeId?: string; requestedBy?: string };
      if (c.kind === 'employee') expect(sampleIds).not.toContain(r.id);
      expect(sampleIds).not.toContain(r.employeeId);
      expect(sampleIds).not.toContain(r.requestedBy);
    }
    expect(changes.some((c) => c.kind === 'shift')).toBe(false);
    expect(changes.some((c) => c.kind === 'settings')).toBe(true);
  });
});

describe('the version of a record', () => {
  it('is the same whatever order its fields were written in, and changes with any field', () => {
    expect(revOf({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(revOf({ b: { d: 'x', c: [1, 2] }, a: 1 }));
    expect(revOf({ a: 1, b: 2 })).not.toBe(revOf({ a: 1, b: 3 }));
    expect(revOf({ a: 1, b: undefined })).toBe(revOf({ a: 1 }));
  });

  it('reads a record the way JSON does', () => {
    expect(stableJson({ b: [1, 'two', null], a: { y: true, x: undefined } })).toBe('{"a":{"y":true},"b":[1,"two",null]}');
  });
});

describe('sending what is waiting', () => {
  const changes = changesToSend(data, {}, none).slice(0, 250);
  const taking = (fail?: (batch: number) => boolean, only?: (c: Change) => boolean) => {
    const batches: number[] = [];
    return {
      batches,
      push: async (sent: readonly Change[]) => {
        batches.push(sent.length);
        if (fail?.(batches.length)) throw new Error('No route to host');
        return sent.filter((c) => !only || only(c)).map(({ key, rev }) => ({ key, rev }));
      },
    };
  };

  it('sends in batches and notes each batch the server took', async () => {
    const server = taking();
    let synced: Synced = {};
    const result = await sendWaiting(changes, server, (accepted) => { synced = markSent(synced, accepted); }, 100);
    expect(server.batches).toEqual([100, 100, 50]);
    expect(result).toEqual({ sent: 250, failed: false });
    expect(Object.keys(synced)).toHaveLength(250);
  });

  it('stops at a batch that does not get through, and keeps the ones that did', async () => {
    const server = taking((n) => n === 2);
    let synced: Synced = {};
    const result = await sendWaiting(changes, server, (accepted) => { synced = markSent(synced, accepted); }, 100);
    expect(server.batches).toEqual([100, 100]);
    expect(result).toEqual({ sent: 100, failed: true });
    expect(changesToSend(data, synced, none).length).toBe(changesToSend(data, {}, none).length - 100);
  });

  it('leaves a record the server turned down waiting', async () => {
    const server = taking(undefined, (c) => c.kind !== 'settings');
    let synced: Synced = {};
    await sendWaiting(changes, server, (accepted) => { synced = markSent(synced, accepted); }, 100);
    expect(synced['settings:company']).toBeUndefined();
  });

  it('waits longer after each failure, up to five minutes', () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(retryDelay(20)).toBe(300_000);
  });
});

describe('what a person is told about their records', () => {
  const base = { online: true, server: true, waiting: 0, sending: false, lastSentAt: null, failed: false };
  const at = () => '2:14 PM';

  it('says records stay on the phone when the build has no server, signal or not', () => {
    expect(syncWords({ ...base, server: false }, at)).toEqual({ title: 'Saved on this phone', sub: 'Works with no signal. Not connected to a company server.', done: false });
    expect(syncWords({ ...base, server: false, online: false }, at).title).toBe('No signal');
    expect(syncWords({ ...base, server: false, online: false }, at).sub).toMatch(/^Everything is saved on this phone/);
  });

  it('says what is waiting with no signal, and that it sends once back in range', () => {
    expect(syncWords({ ...base, online: false, waiting: 1 }, at)).toEqual({ title: 'No signal', sub: '1 record saved on this phone. They send when you are back in range.', done: false });
  });

  it('says when everything is sent, and when it last was', () => {
    expect(syncWords({ ...base, lastSentAt: 1 }, at)).toEqual({ title: 'Everything is sent', sub: 'Last sent at 2:14 PM.', done: true });
  });

  it('says a round that did not get through is tried again by itself', () => {
    expect(syncWords({ ...base, waiting: 3, failed: true }, at).sub).toMatch(/tries again by itself/);
    expect(syncWords({ ...base, waiting: 3, sending: true }, at).title).toBe('Sending 3 records');
  });
});

describe('what the review of sending found', () => {
  const all = changesToSend(data, {}, none);

  it('holds back a record that names a sample person anywhere in it, not only as its owner', () => {
    const sampleId = [...SAMPLE_CREW_IDS][1];
    const real = { id: 'real1', firstName: 'Riley', lastName: 'Quinn', role: 'employee' as const, active: true };
    const leaveBySample = { id: 'lv-x', employeeId: 'real1', day: now, type: 'pto' as const, hours: 800, enteredBy: sampleId, at: now };
    const withReal = { ...data, employees: [...data.employees, real], leave: [leaveBySample] } as SyncData;
    const keys = changesToSend(withReal, {}, SAMPLE_CREW_IDS).map((c) => c.key);
    expect(keys).toContain('employee:real1');
    expect(keys).not.toContain('leave:lv-x');
  });

  it('tells the server about a record that was taken off the phone, once', () => {
    const synced = markSent({}, all);
    const entry = data.leave[0];
    const fewer = { ...data, leave: data.leave.slice(1) };
    const gone = changesToSend(fewer, synced, none);
    expect(gone).toEqual([{ key: `leave:${entry.id}`, kind: 'leave', id: entry.id, rev: DELETED, base: synced[`leave:${entry.id}`], record: null }]);
    const after = markSent(synced, gone);
    expect(`leave:${entry.id}` in after).toBe(false);
    expect(changesToSend(fewer, after, none)).toEqual([]);
  });

  it('carries the version the server last had, so it can see two phones changing the same record', () => {
    const synced = markSent({}, all);
    const shift = seed.shifts[0];
    const later = { ...data, shifts: data.shifts.map((s) => (s.id === shift.id ? { ...s, clockIn: { ...s.clockIn, at: s.clockIn.at + 60_000 } } : s)) };
    const [change] = changesToSend(later, synced, none);
    expect(change.base).toBe(synced[`shift:${shift.id}`]);
    expect(all.every((c) => c.base === undefined)).toBe(true);
  });

  it('counts a send that never answers as one that did not get through', async () => {
    const hung = { push: () => new Promise<never>(() => undefined) };
    const result = await sendWaiting(changesToSend(data, {}, none).slice(0, 3), hung, () => undefined, 100, 20);
    expect(result).toEqual({ sent: 0, failed: true });
  });
});
