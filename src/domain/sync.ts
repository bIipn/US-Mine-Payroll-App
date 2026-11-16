import { sha256 } from '../util/hash';
import type {
  AreaExam,
  AreaSheet,
  DeniedPunch,
  Employee,
  Equipment,
  Inspection,
  LeaveEntry,
  Mrf,
  OperatingLog,
  Settings,
  Shift,
} from './types';

/**
 * What a phone sends to the company's server, worked out from what it holds.
 *
 * Everything a person does is saved on the phone first, signal or not. When
 * the phone can reach the server, it sends each record the server does not
 * have yet, or has an older copy of, and notes the version the server took.
 * The list is worked out from the records themselves, not kept as a queue,
 * so nothing done while the app was closed or offline can be left out of it,
 * and sending the same record twice changes nothing.
 *
 * Some things never leave the phone: the accounts and passwords on it, the
 * hourly rate a person entered for their own pay estimate, and the settings
 * that belong to this phone alone (its reminders and its preview controls).
 *
 * People, the fleet and the sheets go first. Two back-pointers can still
 * arrive ahead of what they name: an inspection's and an exam line's `mrfId`
 * point at a request sent after them. The server takes those as soft links
 * and checks them against the request's own `inspectionId` or `examId`.
 */

/** A kind of record the crew shares through the server, in the order they are sent. */
export const SYNC_KINDS = [
  'settings',
  'employee',
  'equipment',
  'areaSheet',
  'shift',
  'denied',
  'leave',
  'inspection',
  'opLog',
  'exam',
  'mrf',
] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

/** The records a phone holds that the crew shares. */
export interface SyncData {
  employees: Employee[];
  equipment: Equipment[];
  areaSheets: AreaSheet[];
  shifts: Shift[];
  denied: DeniedPunch[];
  leave: LeaveEntry[];
  inspections: Inspection[];
  opLogs: OperatingLog[];
  exams: AreaExam[];
  mrfs: Mrf[];
  settings: Settings;
}

export interface Change {
  /** `kind:id`: one record, whatever its version. */
  key: string;
  kind: SyncKind;
  id: string;
  /** The version: a hash of the record as it is now, or `DELETED` for one taken off the phone. */
  rev: string;
  /** The version the server last confirmed, so it can tell when two phones changed the same record. */
  base?: string;
  /** The record, or null for one taken off the phone. */
  record: unknown;
}

/** The version of a record that was taken off the phone, such as paid leave a supervisor removed. */
export const DELETED = 'deleted';

/** The version of each record the server has confirmed, by its key. */
export type Synced = Record<string, string>;

/** The settings a company shares. The rest are this phone's own. */
const SHARED_SETTINGS = ['company', 'site', 'workweekStartsOn', 'allowSectionAllOk'] as const;

/** JSON with every object's keys in order, so the same record always reads the same. Undefined fields are left out, as JSON does. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableJson(v))).join(',')}]`;
  const fields = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
  return `{${fields.join(',')}}`;
}

/**
 * The version of a record: changes whenever any field of it does. A record is
 * replaced, never changed in place, so the version of one already seen is
 * kept by the object itself and not worked out again.
 */
const versions = new WeakMap<object, string>();
export function revOf(record: unknown): string {
  if (record && typeof record === 'object') {
    const known = versions.get(record);
    if (known) return known;
    const rev = sha256(stableJson(record)).slice(0, 20);
    versions.set(record, rev);
    return rev;
  }
  return sha256(stableJson(record)).slice(0, 20);
}

/** Whether a held-back person's id is anywhere in the record: its owner, who entered it, who fixed or closed it. */
function names(value: unknown, holdBack: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return holdBack.has(value);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((v) => names(v, holdBack));
}

/**
 * Every record the server does not have in its present version, people and
 * fleet first so a record never arrives ahead of what it points at.
 * `holdBack` names people whose records stay on the phone: the made-up sample crew.
 */
export function changesToSend(data: SyncData, synced: Synced, holdBack: ReadonlySet<string>): Change[] {
  const out: Change[] = [];
  const here = new Set<string>();
  const add = (kind: SyncKind, id: string, record: object) => {
    const key = `${kind}:${id}`;
    here.add(key);
    if (holdBack.size && names(record, holdBack)) return;
    const rev = revOf(record);
    if (synced[key] !== rev) out.push({ key, kind, id, rev, ...(synced[key] ? { base: synced[key] } : null), record });
  };
  const shared = Object.fromEntries(SHARED_SETTINGS.map((k) => [k, data.settings[k]]));
  add('settings', 'company', shared);
  const lists: [SyncKind, { id: string }[]][] = [
    ['employee', data.employees],
    ['equipment', data.equipment],
    ['areaSheet', data.areaSheets],
    ['shift', data.shifts],
    ['denied', data.denied],
    ['leave', data.leave],
    ['inspection', data.inspections],
    ['opLog', data.opLogs],
    ['exam', data.exams],
    ['mrf', data.mrfs],
  ];
  for (const [kind, records] of lists) for (const record of records) add(kind, record.id, record);
  // What the server has that is no longer on the phone.
  for (const key of Object.keys(synced)) {
    if (here.has(key)) continue;
    const cut = key.indexOf(':');
    out.push({ key, kind: key.slice(0, cut) as SyncKind, id: key.slice(cut + 1), rev: DELETED, base: synced[key], record: null });
  }
  return out;
}

/** Note the versions the server took. A record changed since then is still waiting, because its version no longer matches. */
export function markSent(synced: Synced, accepted: readonly Pick<Change, 'key' | 'rev'>[]): Synced {
  if (!accepted.length) return synced;
  const next = { ...synced };
  for (const c of accepted) {
    if (c.rev === DELETED) delete next[c.key];
    else next[c.key] = c.rev;
  }
  return next;
}

/** The company's server, as the phone sees it: it takes records and answers with the versions it now has. */
export interface SyncTransport {
  push(changes: readonly Change[]): Promise<readonly Pick<Change, 'key' | 'rev'>[]>;
}

/**
 * Send what is waiting, a batch at a time, noting each batch the server took
 * before sending the next. A batch that does not get through stops the round;
 * what got through stays sent, and the rest waits for the next round.
 */
export async function sendWaiting(
  changes: readonly Change[],
  transport: SyncTransport,
  took: (accepted: readonly Pick<Change, 'key' | 'rev'>[]) => void,
  batch = 100,
  /** A batch with no answer by then counts as not getting through, so one hung request cannot stall the phone. */
  timeoutMs = 30_000,
): Promise<{ sent: number; failed: boolean }> {
  let sent = 0;
  for (let i = 0; i < changes.length; i += batch) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('No answer from the server')), timeoutMs);
      });
      const accepted = await Promise.race([transport.push(changes.slice(i, i + batch)), late]);
      took(accepted);
      sent += accepted.length;
    } catch {
      return { sent, failed: true };
    } finally {
      clearTimeout(timer);
    }
  }
  return { sent, failed: false };
}

/** How long to wait before trying again after `failures` rounds in a row did not get through: 5 seconds, doubling, at most 5 minutes. */
export function retryDelay(failures: number): number {
  return Math.min(300_000, 5_000 * 2 ** Math.max(0, failures - 1));
}

/** Where a phone's records stand, for the More screen and the strip shown with no signal. */
export interface SyncStatus {
  /** Whether the phone has a connection, as far as it can tell. */
  online: boolean;
  /** Whether this build sends its records to a company server. */
  server: boolean;
  /** Records saved on this phone that the server does not have yet. Counted only with a server. */
  waiting: number;
  sending: boolean;
  lastSentAt: number | null;
  /** The last round did not get through. */
  failed: boolean;
}

const records = (n: number) => `${n} ${n === 1 ? 'record' : 'records'}`;

/** What to tell the person about their records, in plain words. `time` writes a clock time ("2:14 PM"). */
export function syncWords(status: SyncStatus, time: (ms: number) => string): { title: string; sub: string; done: boolean } {
  const { online, server, waiting, sending, lastSentAt, failed } = status;
  if (!server) {
    // Two short lines: the More screen shows no more than that.
    return {
      title: online ? 'Saved on this phone' : 'No signal',
      sub: online ? 'Works with no signal. Not connected to a company server.' : 'Everything is saved on this phone. Not connected to a company server.',
      done: false,
    };
  }
  if (!waiting) return { title: 'Everything is sent', sub: lastSentAt ? `Last sent at ${time(lastSentAt)}.` : 'The server has every record on this phone.', done: true };
  if (!online) return { title: 'No signal', sub: `${records(waiting)} saved on this phone. They send when you are back in range.`, done: false };
  if (sending) return { title: `Sending ${records(waiting)}`, sub: 'They stay saved on this phone until the server has them.', done: false };
  if (failed) return { title: `${records(waiting)} waiting`, sub: 'The server could not be reached. The phone tries again by itself.', done: false };
  return { title: `${records(waiting)} waiting`, sub: 'They send in a few seconds.', done: false };
}
