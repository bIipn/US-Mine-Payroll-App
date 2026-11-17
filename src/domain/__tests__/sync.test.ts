import { buildDemoData, SAMPLE_CREW_IDS } from '../../store/seed';
import { SAMPLE_COMPANY } from '../company';
import { SAMPLE_SITE } from '../site';
import {
  BATCH,
  changesToSend,
  DELETED,
  fitsServer,
  markSent,
  retryDelay,
  revOf,
  sendError,
  sendWaiting,
  SERVER_LIMITS,
  stableJson,
  syncWords,
  type Change,
  type SyncData,
  type SyncStatus,
  type Synced,
} from '../sync';
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
    // Nor the made-up company these samples work for.
    expect(changes.some((c) => c.kind === 'settings')).toBe(false);
    const own = { ...data, settings: { ...settings, company: { ...SAMPLE_COMPANY, name: 'Test Pit A' } } };
    expect(changesToSend(own, {}, SAMPLE_CREW_IDS).some((c) => c.kind === 'settings')).toBe(true);
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
    const result = await sendWaiting(changes, server, (accepted) => { synced = markSent(synced, accepted); }, { batch: 100 });
    expect(server.batches).toEqual([100, 100, 50]);
    expect(result).toMatchObject({ sent: 250, failed: false, stuck: [], stopped: false });
    expect(Object.keys(synced)).toHaveLength(250);
  });

  it('stops at a batch that does not get through, and keeps the ones that did', async () => {
    const server = taking((n) => n === 2);
    let synced: Synced = {};
    const result = await sendWaiting(changes, server, (accepted) => { synced = markSent(synced, accepted); }, { batch: 100 });
    expect(server.batches).toEqual([100, 100]);
    expect(result).toMatchObject({ sent: 100, failed: true, trouble: 'unreachable' });
    expect(changesToSend(data, synced, none).length).toBe(changesToSend(data, {}, none).length - 100);
  });

  it('leaves a record the server turned down waiting', async () => {
    const server = taking(undefined, (c) => c.kind !== 'settings');
    let synced: Synced = {};
    await sendWaiting(changes, server, (accepted) => { synced = markSent(synced, accepted); }, { batch: 100 });
    expect(synced['settings:company']).toBeUndefined();
  });

  it('waits longer after each failure, up to five minutes', () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(retryDelay(20)).toBe(300_000);
  });
});

describe('what a person is told about their records', () => {
  const base: SyncStatus = { online: true, server: true, waiting: 0, sending: false, lastSentAt: null, failed: false, trouble: null, problem: null, stuck: 0 };
  const at = () => '2:14 PM';

  it('says records stay on the phone when the build has no server, signal or not', () => {
    expect(syncWords({ ...base, server: false }, at)).toEqual({ title: 'Saved on this phone', sub: 'Works with no signal. Not connected to a company server.', done: false, warn: false });
    expect(syncWords({ ...base, server: false, online: false }, at).title).toBe('No signal');
    expect(syncWords({ ...base, server: false, online: false }, at).sub).toMatch(/^Everything is saved on this phone/);
  });

  it('says what is waiting with no signal, and that it sends once back in range', () => {
    expect(syncWords({ ...base, online: false, waiting: 1 }, at)).toEqual({ title: 'No signal', sub: '1 record saved on this phone. They send when you are back in range.', done: false, warn: false });
  });

  it('says when everything is sent, and when it last was', () => {
    expect(syncWords({ ...base, lastSentAt: 1 }, at)).toEqual({ title: 'Everything is sent', sub: 'Last sent at 2:14 PM.', done: true, warn: false });
  });

  it('says a round that did not get through is tried again by itself', () => {
    expect(syncWords({ ...base, waiting: 3, failed: true }, at).sub).toMatch(/tries again by itself/);
    expect(syncWords({ ...base, waiting: 3, sending: true }, at).title).toBe('Sending 3 records');
  });

  it('says what the server said, not that it could not be reached, when it answered', () => {
    const said = syncWords({ ...base, waiting: 3, failed: true, trouble: 'server', problem: 'The company server is not ready to take records yet.' }, at);
    expect(said.sub).toBe('The company server is not ready to take records yet. The phone tries again by itself.');
    expect(said.sub).not.toMatch(/could not be reached/);
  });

  it('says to sign in again when the phone is signed out, with records waiting or not', () => {
    const out = syncWords({ ...base, waiting: 2, trouble: 'signed_out' }, at);
    expect(out).toMatchObject({ title: '2 records waiting', warn: true, done: false });
    expect(out.sub).toMatch(/^Signed out of the company server. Sign in again/);
    expect(out.sub).not.toMatch(/could not be reached/);
    // Even with nothing waiting it is not "Everything is sent": nothing more will go until someone signs in.
    expect(syncWords({ ...base, trouble: 'signed_out', lastSentAt: 1 }, at)).toEqual({
      title: 'Signed out of the company server',
      sub: 'Sign in again on Company account to keep sending. Nothing is lost.',
      done: false,
      warn: true,
    });
  });

  it('says an account taken off the roster needs a supervisor', () => {
    const off = syncWords({ ...base, waiting: 1, failed: true, trouble: 'not_member', problem: 'This account is not on the company’s roster any more.' }, at);
    expect(off).toMatchObject({ title: '1 record waiting', warn: true });
    expect(off.sub).toBe('This account is not on the company’s roster any more. See your supervisor. Nothing is lost.');
  });

  it('says when records cannot be sent as they are', () => {
    expect(syncWords({ ...base, waiting: 1, stuck: 1 }, at)).toMatchObject({ title: '1 record cannot be sent', warn: true });
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

  it('counts a send that never answers as one that did not get through, and gives up on the request', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const hung = { push: (_c: readonly Change[], signal?: AbortSignal) => (signals.push(signal), new Promise<never>(() => undefined)) };
    const result = await sendWaiting(changesToSend(data, {}, none).slice(0, 3), hung, () => undefined, { timeoutMs: 20 });
    expect(result).toMatchObject({ sent: 0, failed: true, trouble: 'unreachable' });
    // The request itself is aborted, so a hung one does not stay open behind the next try.
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('a round of sending that the phone stops', () => {
  const changes = changesToSend(data, {}, none).slice(0, 350);
  /** A server that answers each call only when the test lets it. */
  const held = () => {
    const calls: { size: number; signal?: AbortSignal; answer: () => void }[] = [];
    const transport = {
      push: (sent: readonly Change[], signal?: AbortSignal) =>
        new Promise<readonly Pick<Change, 'key' | 'rev'>[]>((resolve) => {
          calls.push({ size: sent.length, signal, answer: () => resolve(sent.map(({ key, rev }) => ({ key, rev }))) });
        }),
    };
    return { calls, transport };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('sends nothing more once the phone is disconnected, and notes no late answer', async () => {
    const { calls, transport } = held();
    let connected = true;
    const noted: string[] = [];
    const round = sendWaiting(changes, transport, (accepted) => noted.push(...accepted.map((c) => c.key)), { still: () => connected });
    await settle();
    expect(calls).toHaveLength(1);
    connected = false;
    calls[0].answer();
    const result = await round;
    expect(calls).toHaveLength(1);
    expect(noted).toEqual([]);
    expect(result).toMatchObject({ sent: 0, stopped: true, failed: false });
  });

  it('aborts the call under way when told to stop', async () => {
    const { calls, transport } = held();
    const stop = new AbortController();
    const round = sendWaiting(changes, transport, () => undefined, { signal: stop.signal });
    await settle();
    stop.abort();
    const result = await round;
    expect(calls).toHaveLength(1);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(result).toMatchObject({ stopped: true, sent: 0 });
  });
});

describe('what the server will take', () => {
  const all = changesToSend(data, {}, none);

  it('never puts more in a call than the server takes', async () => {
    expect(BATCH).toBeLessThanOrEqual(SERVER_LIMITS.changes);
    const sizes: number[] = [];
    const server = { push: async (sent: readonly Change[]) => (sizes.push(sent.length), sent.map(({ key, rev }) => ({ key, rev }))) };
    await sendWaiting(all.slice(0, 450), server, () => undefined, { batch: 500 });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(SERVER_LIMITS.changes);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(450);
  });

  it('holds back a record the server could not take, and sends the rest', async () => {
    const shift = all.find((c) => c.kind === 'shift')!;
    const longId = { ...shift, id: 'x'.repeat(121), key: `shift:${'x'.repeat(121)}` };
    const big = { ...shift, id: 'big', key: 'shift:big', record: { ...(shift.record as object), note: 'é'.repeat(140_000) } };
    expect(fitsServer(shift)).toBe(true);
    expect(fitsServer(longId)).toBe(false);
    expect(fitsServer({ ...shift, id: 'a\nb' })).toBe(false);
    expect(fitsServer(big)).toBe(false);
    expect(fitsServer({ ...shift, rev: DELETED, record: null })).toBe(true);
    const sent: string[] = [];
    const server = { push: async (part: readonly Change[]) => (sent.push(...part.map((c) => c.key)), part.map(({ key, rev }) => ({ key, rev }))) };
    const result = await sendWaiting([longId, shift, big], server, () => undefined);
    expect(sent).toEqual([shift.key]);
    expect(result.stuck.map((c) => c.key)).toEqual([longId.key, big.key]);
    expect(result.failed).toBe(false);
  });

  it('finds the one change a call was turned down for, and sends every other', async () => {
    const changes = all.slice(0, 120);
    const bad = changes[37];
    let calls = 0;
    const server = {
      push: async (part: readonly Change[]) => {
        calls += 1;
        if (part.some((c) => c.key === bad.key)) throw sendError('refused', 'The server would not take a record as it is.');
        return part.map(({ key, rev }) => ({ key, rev }));
      },
    };
    let synced: Synced = {};
    const result = await sendWaiting(changes, server, (accepted) => { synced = markSent(synced, accepted); });
    expect(result.stuck.map((c) => c.key)).toEqual([bad.key]);
    expect(result.sent).toBe(119);
    expect(result.failed).toBe(false);
    expect(Object.keys(synced)).toHaveLength(119);
    expect(bad.key in synced).toBe(false);
    // A handful of calls to find it, not one for every record.
    expect(calls).toBeLessThan(20);
  });

  it('stops at once when the phone is signed out, and says so', async () => {
    let calls = 0;
    const server = { push: async () => { calls += 1; throw sendError('signed_out', 'You are signed out of the company server.'); } };
    const result = await sendWaiting(all.slice(0, 250), server, () => undefined);
    expect(calls).toBe(1);
    expect(result).toMatchObject({ failed: true, trouble: 'signed_out', problem: 'You are signed out of the company server.' });
  });

  it('holds back the made-up company and site along with the sample crew', () => {
    const sample = { ...data, settings: { ...settings, company: SAMPLE_COMPANY, site: SAMPLE_SITE } };
    expect(changesToSend(sample, {}, SAMPLE_CREW_IDS).some((c) => c.kind === 'settings')).toBe(false);
    const ownSite = { ...sample, settings: { ...sample.settings, company: { ...SAMPLE_COMPANY, name: 'Test Pit A' } } };
    // The site is still the sample one: it would take the place of the company's own pin.
    expect(changesToSend(ownSite, {}, SAMPLE_CREW_IDS).some((c) => c.kind === 'settings')).toBe(false);
    const own = { ...data, settings: { ...settings, company: { ...SAMPLE_COMPANY, name: 'Test Pit A' } } };
    expect(changesToSend(own, {}, SAMPLE_CREW_IDS).some((c) => c.kind === 'settings')).toBe(true);
    // A pin a supervisor moved is the company's own, whatever the site is called; so is a site of the company's own at the same spot.
    const moved = { ...ownSite, settings: { ...ownSite.settings, site: { ...SAMPLE_SITE, center: { lat: 38.1, lng: -117.2 } } } };
    expect(changesToSend(moved, {}, SAMPLE_CREW_IDS).some((c) => c.kind === 'settings')).toBe(true);
    const named = { ...ownSite, settings: { ...ownSite.settings, site: { ...SAMPLE_SITE, name: 'Test Pit A' } } };
    expect(changesToSend(named, {}, SAMPLE_CREW_IDS).some((c) => c.kind === 'settings')).toBe(true);
  });
});
