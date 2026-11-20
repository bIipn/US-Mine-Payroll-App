import { sha256 } from '../util/hash';
import { checkCompany, SAMPLE_COMPANY } from './company';
import type { PersonName } from './roster';
import { SAMPLE_SITE } from './site';
import type {
  AreaExam,
  AreaSheet,
  DeniedPunch,
  Employee,
  Equipment,
  EquipmentStatus,
  Inspection,
  LeaveEntry,
  Mrf,
  OperatingLog,
  Role,
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

/**
 * The kinds every phone works from, which a phone connected to its company
 * also receives (src/domain/receive.ts): the settings, the roster, the fleet
 * and the area sheets. The rest it only sends.
 */
export const REFERENCE_KINDS = ['settings', 'employee', 'equipment', 'areaSheet'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];
const isReference = (kind: string): kind is ReferenceKind => (REFERENCE_KINDS as readonly string[]).includes(kind);

/** A row as read_shared_records hands it over: the server's version of the whole record. */
export interface ReceivedRow {
  kind: ReferenceKind;
  id: string;
  /** The server's version, or 'deleted'. */
  rev: string;
  seq: number;
  deleted: boolean;
  data: unknown;
}

/** Who a phone's company sign-in is to the company, from its own row of the sign-in roster. */
export interface Standing {
  role: Role;
  name: PersonName;
}

/** The company's own row: what a phone starts from when the company has never sent its settings. */
export interface CompanyRow {
  name: string;
  state: string;
  pay: unknown;
}

/** Why the server would not take a change from this phone's sign-in. Such a change is held, not counted as sent. */
export type HeldReason = 'supervisor_only' | 'not_yours' | 'signed' | 'malformed' | 'private' | 'too_large';

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

/** The settings record as it is sent and received: the four shared fields, and nothing of this phone's own. */
export type SharedSettings = Pick<Settings, (typeof SHARED_SETTINGS)[number]>;

export function sharedSettings(settings: Settings): SharedSettings {
  return { company: settings.company, site: settings.site, workweekStartsOn: settings.workweekStartsOn, allowSectionAllOk: settings.allowSectionAllOk };
}

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

/** Whether the company, or the site, is still the made-up sample one a preview starts with. A pin someone moved is theirs. */
function madeUpSettings(settings: Settings): boolean {
  const site = settings.site;
  const samplePin = !!site && site.name === SAMPLE_SITE.name && site.center.lat === SAMPLE_SITE.center.lat && site.center.lng === SAMPLE_SITE.center.lng;
  return settings.company.name === SAMPLE_COMPANY.name || samplePin;
}

/**
 * Every record the server does not have in its present version, people and
 * fleet first so a record never arrives ahead of what it points at.
 * `holdBack` names people whose records stay on the phone: the made-up sample crew.
 */
export function changesToSend(data: SyncData, synced: Synced, holdBack: ReadonlySet<string>, here?: SendHere): Change[] {
  const sorted = sortedChanges(data, synced, holdBack, here);
  return [...sorted.now, ...sorted.afterReceive];
}

/** What a phone connected to its company knows when it works out what to send. */
export interface SendHere {
  /** Connected to a company. A phone never connected sends as it always has. */
  connected: boolean;
  /** Who its company sign-in is to the company, as the last standing read found. */
  role: Role | 'none' | null;
  /** It has read the company's records to an empty page at least once. */
  caughtUp: boolean;
  /** Records of the company this version of the app could not read. */
  unreadable: readonly string[];
  /** Changes the server would not take from this sign-in, at the version it refused. */
  held: Readonly<Record<string, { rev: string }>>;
}

export interface SortedChanges {
  /** Sent first in a round: the seven kinds a phone makes, and ahead of them a unit or sheet this phone added. */
  now: Change[];
  /** Sent once the round has read the company's records: the rest of the settings, the fleet and the sheets. */
  afterReceive: Change[];
  /** Not sent: the server would not take them from this phone's sign-in. Counted apart from what waits. */
  notTaken: Change[];
}

/**
 * changesToSend's list, sorted for a phone connected to its company. On such a
 * phone a person is never sent (people change on the dashboard); a crew
 * sign-in sends no sheet, no settings, no new unit and no removal of a unit,
 * which the server takes from a supervisor only, and those are counted as not
 * taken; nothing of the four kinds the server never had goes before the phone
 * has seen the company's; no settings go whose company is not whole; nothing
 * the phone could not read from the company goes; and a change the server
 * would not take is not sent again at the version it refused.
 */
export function sortedChanges(data: SyncData, synced: Synced, holdBack: ReadonlySet<string>, here?: SendHere): SortedChanges {
  const all = everyChange(data, synced, holdBack);
  if (!here?.connected) return { now: all, afterReceive: [], notTaken: [] };
  const sorted: SortedChanges = { now: [], afterReceive: [], notTaken: [] };
  const supervisor = here.role === 'supervisor';
  const unreadable = new Set(here.unreadable);
  const refused = (c: Change) => here.held[c.key]?.rev === c.rev;
  for (const c of all) {
    if (!isReference(c.kind)) {
      (refused(c) ? sorted.notTaken : sorted.now).push(c);
      continue;
    }
    if (c.kind === 'employee' || unreadable.has(c.key)) continue;
    const isNew = synced[c.key] === undefined;
    if (isNew && !here.caughtUp) continue;
    if (c.kind === 'settings' && c.record && !wholeCompany((c.record as SharedSettings).company)) continue;
    const onlyASupervisor = c.kind === 'areaSheet' || c.kind === 'settings' || (c.kind === 'equipment' && (isNew || c.rev === DELETED));
    if ((onlyASupervisor && !supervisor) || refused(c)) sorted.notTaken.push(c);
    else if (isNew && (c.kind === 'equipment' || c.kind === 'areaSheet')) sorted.now.push(c);
    else sorted.afterReceive.push(c);
  }
  return sorted;
}

/** A company payroll can go by: the server would refuse settings with a blank one, and a phone must never send one. */
function wholeCompany(company: Settings['company'] | undefined): boolean {
  try {
    return !!company && checkCompany(company) === undefined;
  } catch {
    return false;
  }
}

function everyChange(data: SyncData, synced: Synced, holdBack: ReadonlySet<string>): Change[] {
  const out: Change[] = [];
  const here = new Set<string>();
  const add = (kind: SyncKind, id: string, record: object) => {
    const key = `${kind}:${id}`;
    here.add(key);
    if (holdBack.size && names(record, holdBack)) return;
    const rev = revOf(record);
    if (synced[key] !== rev) out.push({ key, kind, id, rev, ...(synced[key] ? { base: synced[key] } : null), record });
  };
  const shared = sharedSettings(data.settings);
  // With the sample crew held back, so are the made-up company and site: on the server they would take the place of the real ones.
  if (!(holdBack.size && madeUpSettings(data.settings))) add('settings', 'company', shared);
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

/**
 * What the server takes (see the record store's design): at most 200 changes
 * in one call, a record id of 1 to 120 characters with no control characters,
 * and a record of at most 256 KB. A change outside these is never sent: the
 * server would turn the whole call down for it.
 */
export const SERVER_LIMITS = { changes: 200, idChars: 120, recordBytes: 256 * 1024 } as const;

/** Changes in one call: half what the server takes, so that a call on weak signal is small enough to get through. */
export const BATCH = 100;

/** How long a call may go without an answer before it counts as not getting through. */
export const SEND_TIMEOUT_MS = 30_000;

/** The size of text once it is sent, in UTF-8 bytes. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Whether the server can take this change at all. */
export function fitsServer(change: Change): boolean {
  if (!change.id || change.id.length > SERVER_LIMITS.idChars || /[\u0000-\u001f\u007f]/.test(change.id)) return false;
  return change.record == null || utf8Bytes(stableJson(change.record)) <= SERVER_LIMITS.recordBytes;
}

/**
 * Why a send did not get through, so the phone can say what to do about it.
 * - `unreachable`: no signal, no answer, or the server is down. Tried again later.
 * - `signed_out`: the phone's account on the server is signed out. Sending waits until someone signs in.
 * - `not_member`: the account is no longer on the company's roster. Sending waits for a supervisor.
 * - `refused`: the server would not take what was sent. The change at fault is found and held back.
 * - `server`: something else went wrong on the server. Tried again later.
 * - `closed`: the company does not have MineMuster. Nothing more is read until a supervisor starts it again.
 */
export type SendTrouble = 'unreachable' | 'signed_out' | 'not_member' | 'refused' | 'server' | 'closed';

/** A failed send that says why, in plain words. */
export type SendError = Error & { trouble: SendTrouble };

export function sendError(trouble: SendTrouble, message: string): SendError {
  return Object.assign(new Error(message), { trouble });
}

/** Why an error from a send happened. Anything that does not say counts as not getting through. */
export function troubleOf(error: unknown): SendTrouble {
  const trouble = error && typeof error === 'object' ? (error as { trouble?: unknown }).trouble : undefined;
  return trouble === 'signed_out' || trouble === 'not_member' || trouble === 'refused' || trouble === 'server' || trouble === 'closed' ? trouble : 'unreachable';
}

/**
 * The server's answer to a send, by what the phone does with each change:
 * - `took`: the server has it, or keeps what it had of one of the seven kinds a phone makes. Counted as sent.
 * - `stale`: of the four kinds, made from a version the server no longer holds. Read the company's records again, then send.
 * - `floored`: a unit's status better than the company's open requests on it; `floor` is the best it may be.
 * - `held`: the server would not take it from this phone's sign-in. Not sent again until the record or the role changes.
 */
export interface PushAnswer {
  took: Pick<Change, 'key' | 'rev'>[];
  stale: Pick<Change, 'key' | 'rev'>[];
  floored: (Pick<Change, 'key' | 'rev'> & { floor: EquipmentStatus })[];
  held: (Pick<Change, 'key' | 'rev'> & { reason: HeldReason })[];
}

/** The company's server, as the phone sees it: it takes records, answers what it did with each, and hands over the company's. */
export interface SyncTransport {
  /** The company the records go to. */
  readonly company?: string;
  /** `signal` is aborted when the phone stops waiting for the answer. */
  push(changes: readonly Change[], signal?: AbortSignal): Promise<PushAnswer>;
  /** The four kinds after a cursor, at most `max` rows, in seq order. An empty page is the end. */
  pull?(after: number, max: number, signal?: AbortSignal): Promise<ReceivedRow[]>;
  /** This phone's sign-in's own row of the roster; null when it is not on the roster. */
  standing?(signal?: AbortSignal): Promise<Standing | null>;
  /** The company's own row, for a company that never sent its settings. */
  companyRow?(signal?: AbortSignal): Promise<CompanyRow | null>;
}

export interface SendOptions {
  batch?: number;
  /** A call with no answer by then counts as not getting through, so one hung request cannot stall the phone. */
  timeoutMs?: number;
  /**
   * Asked before each call and before an answer is noted. Once it is false (the
   * phone was disconnected, or now sends to another company) nothing more is
   * sent, and no answer still on its way is noted.
   */
  still?: () => boolean;
  /** Aborts the call under way, such as when the phone is disconnected. */
  signal?: AbortSignal;
}

export interface SendResult {
  /** How many changes the server now has. */
  sent: number;
  /** A call did not get through, so the rest waits for the next round. */
  failed: boolean;
  /** Why, when it failed. */
  trouble: SendTrouble | null;
  /** What the server said, in plain words, when it said anything. */
  problem: string | null;
  /** Changes the server will not take as they are: each held back, so it holds up nothing else. */
  stuck: Change[];
  /** The round was stopped part way because the phone was disconnected or moved. */
  stopped: boolean;
}

/** One call, given up on after `timeoutMs` or when `outer` is aborted. Either way the request itself is aborted too. */
function pushOnce(transport: SyncTransport, part: readonly Change[], timeoutMs: number, outer?: AbortSignal) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  return new Promise<PushAnswer>((resolve, reject) => {
    const giveUp = (why: string) => {
      controller?.abort();
      reject(sendError('unreachable', why));
    };
    if (outer?.aborted) return giveUp('Stopped');
    onAbort = () => giveUp('Stopped');
    outer?.addEventListener('abort', onAbort);
    timer = setTimeout(() => giveUp('No answer from the server'), timeoutMs);
    transport.push(part, controller?.signal).then(resolve, reject);
  }).finally(() => {
    clearTimeout(timer);
    if (onAbort) outer?.removeEventListener('abort', onAbort);
  });
}

/**
 * Send what is waiting, a batch at a time, noting each batch the server took
 * before sending the next. A batch that does not get through stops the round;
 * what got through stays sent, and the rest waits for the next round.
 *
 * A batch the server turns down for what is in it is split until the change
 * at fault is found. That one is held back (`stuck`) and the rest still go, so
 * one bad record cannot keep every record after it on the phone.
 */
export async function sendWaiting(
  changes: readonly Change[],
  transport: SyncTransport,
  took: (answer: PushAnswer) => void,
  { batch = BATCH, timeoutMs = SEND_TIMEOUT_MS, still = () => true, signal }: SendOptions = {},
): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: false, trouble: null, problem: null, stuck: [], stopped: false };
  const size = Math.max(1, Math.min(batch, SERVER_LIMITS.changes));
  const ready = changes.filter((c) => fitsServer(c) || (result.stuck.push(c), false));
  const going = () => {
    if (still() && !signal?.aborted) return true;
    result.stopped = true;
    return false;
  };
  /** Send one part. False stops the round. */
  const send = async (part: readonly Change[]): Promise<boolean> => {
    if (!going()) return false;
    try {
      const answer = await pushOnce(transport, part, timeoutMs, signal);
      if (!going()) return false;
      took(answer);
      result.sent += answer.took.length;
      return true;
    } catch (error) {
      if (!going()) return false;
      if (troubleOf(error) === 'refused') {
        if (part.length === 1) {
          result.stuck.push(part[0]);
          return true;
        }
        const half = Math.ceil(part.length / 2);
        return (await send(part.slice(0, half))) && send(part.slice(half));
      }
      result.failed = true;
      result.trouble = troubleOf(error);
      result.problem = error instanceof Error && result.trouble !== 'unreachable' ? error.message : null;
      return false;
    }
  };
  for (let i = 0; i < ready.length; i += size) {
    if (!(await send(ready.slice(i, i + size)))) break;
  }
  return result;
}

/** How long to wait before trying again after `failures` rounds in a row did not get through: 5 seconds, doubling, at most 5 minutes. */
export function retryDelay(failures: number): number {
  return Math.min(300_000, 5_000 * 2 ** Math.max(0, failures - 1));
}

/** Where a phone's records stand, for the More screen and the strip shown with no signal. */
export interface SyncStatus {
  /** Whether the phone has a connection, as far as it can tell. */
  online: boolean;
  /** Whether this phone sends its records to a company server: it is connected to its company. */
  server: boolean;
  /** Records saved on this phone that the server does not have yet. Counted only with a server. */
  waiting: number;
  sending: boolean;
  lastSentAt: number | null;
  /** The last round did not get through. */
  failed: boolean;
  /** Why the records are not going, when the phone knows: signed out, off the roster, or what the server said. */
  trouble: SendTrouble | null;
  /** What the server said, in plain words. */
  problem: string | null;
  /** Records the server will not take as they are. They stay on the phone. */
  stuck: number;
}

const records = (n: number) => `${n} ${n === 1 ? 'record' : 'records'}`;

/**
 * What to tell the person about their records, in plain words. `time` writes a
 * clock time ("2:14 PM"). `warn` marks something only a person can put right.
 */
export function syncWords(status: SyncStatus, time: (ms: number) => string): { title: string; sub: string; done: boolean; warn: boolean } {
  const { online, server, waiting, sending, lastSentAt, failed, trouble, problem, stuck } = status;
  const say = (title: string, sub: string, done = false, warn = false) => ({ title, sub, done, warn });
  if (!server) {
    // Two short lines: the More screen shows no more than that.
    return online
      ? say('Saved on this phone', 'Works with no signal. Not connected to a company server.')
      : say('No signal', 'Everything is saved on this phone. Not connected to a company server.');
  }
  const count = waiting ? `${records(waiting)} waiting` : null;
  if (trouble === 'signed_out') {
    const again = 'Sign in again on Company account to keep sending. Nothing is lost.';
    return count ? say(count, `Signed out of the company server. ${again}`, false, true) : say('Signed out of the company server', again, false, true);
  }
  if (trouble === 'closed') {
    return say(count ?? 'Not sending', 'MineMuster has stopped for this company. A supervisor can start it again on the dashboard’s Billing page. Nothing is lost.', false, true);
  }
  if (trouble === 'not_member') {
    return say(count ?? 'Not sending', `${problem ?? 'This account is not on the company’s roster.'} See your supervisor. Nothing is lost.`, false, true);
  }
  if (!waiting) return say('Everything is sent', lastSentAt ? `Last sent at ${time(lastSentAt)}.` : 'The server has every record on this phone.', true);
  if (!online) return say('No signal', `${records(waiting)} saved on this phone. They send when you are back in range.`);
  if (sending) return say(`Sending ${records(waiting)}`, 'They stay saved on this phone until the server has them.');
  if (stuck && stuck >= waiting) {
    return say(`${records(stuck)} cannot be sent`, 'The server will not take them as they are. They stay saved on this phone. Tell your supervisor.', false, true);
  }
  if (failed) {
    return say(count!, trouble === 'server' && problem ? `${problem} The phone tries again by itself.` : 'The server could not be reached. The phone tries again by itself.');
  }
  return say(count!, 'They send in a few seconds.');
}

/** What the records row knows about the company's records on a connected phone. */
export interface ReceiveView {
  connected: boolean;
  online: boolean;
  role: Role | 'none' | null;
  caughtUpAt: number | null;
  /** The company does not have MineMuster. */
  closed: boolean;
  /** Records from the company this version could not read. */
  unreadable: number;
  /** Changes the company would not take from this phone's sign-in. */
  notTaken: number;
  company: string;
  /** The phone's company sign-in. */
  email: string | null;
}

/**
 * The records row's second line about what comes from the company, or null on
 * a phone never connected. `time` writes a clock time. `warn` marks something
 * only a person can put right.
 */
export function receiveWords(v: ReceiveView, time: (ms: number) => string): { line: string; warn: boolean } | null {
  if (!v.connected) return null;
  const warn = (line: string) => ({ line, warn: true });
  const plain = (line: string) => ({ line, warn: false });
  if (v.role === 'none') {
    return warn(
      `This phone’s company sign-in${v.email ? `, ${v.email},` : ''} is not on ${v.company}’s roster any more, so nothing done here reaches the company. Records stay on this phone. See your supervisor.`,
    );
  }
  if (v.closed) return warn(`MineMuster has stopped for ${v.company}. A supervisor can start it again on the dashboard’s Billing page.`);
  if (v.unreadable) {
    return warn(`${records(v.unreadable)} from the company could not be read on this phone. Update the app; if that does not fix it, tell the office.`);
  }
  if (v.caughtUpAt === null) return plain(v.online ? 'Getting your company’s roster, fleet and area sheets.' : 'No signal. They come when this phone is back in range.');
  if (v.notTaken) return warn(`${v.notTaken} not taken by the company from this phone’s sign-in.`);
  return plain(`The company’s roster, fleet and sheets last came at ${time(v.caughtUpAt)}.`);
}
