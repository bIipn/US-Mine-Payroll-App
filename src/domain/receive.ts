import { checkCompany } from './company';
import type { PersonName } from './roster';
import { revOf, sharedSettings, stableJson, type HeldReason, type ReceivedRow, type ReferenceKind, type SharedSettings, type Standing, type Synced } from './sync';
import type { AreaSheet, Employee, Equipment, EquipmentCategory, EquipmentStatus, Mrf, OperatingLog, Role, Settings } from './types';
import { fmtDate } from '../util/format';

export { REFERENCE_KINDS } from './sync';
export type { HeldReason, ReceivedRow, ReferenceKind, Standing } from './sync';

/**
 * What a phone takes in from the company: the four kinds of record every phone
 * works from, the settings, the roster, the fleet and the area sheets. The
 * office changes them on the dashboard; a phone reads them through
 * read_shared_records (supabase/migrations/20261120000100) and merges each
 * page here. Everything else a phone only sends.
 *
 * The rule in one sentence: a person is always the company's version; what the
 * phone has not changed takes the server's version; what it has changed is
 * kept while the server has not moved; when both moved, the server's version
 * stands for a sheet and the settings (the phone says so), and a unit takes
 * the server's version with the phone's status merged three ways and the
 * higher reading. A unit is never better than this phone's own open requests
 * on it.
 *
 * Pure: no store, no React Native. The store applies what these return.
 */

export interface ReceiveNotice {
  id: string;
  at: number;
  words: string;
  seen?: true;
}

/** A unit's status and reading as the server last had them. */
export interface UnitBase {
  status: EquipmentStatus;
  meter: number;
}

/** What a connected phone keeps about receiving from its company. */
export interface Receiving {
  /** The company this is about. Equals syncedWith. */
  company: string;
  /** Raised each time the cursor is put back to 0; a page read under another epoch is not applied. */
  epoch: number;
  /** Every row of the four kinds with a seq up to here is merged. */
  cursor: number;
  /** The last time a read reached an empty page; null until the first. */
  caughtUpAt: number | null;
  /** Rows a page asks for: 200 to start, halved after a page that timed out, doubled after a quick one. */
  pageSize: number;
  /** Who this phone's sign-in is to the company, as the last standing read found. Written only by standingChange and signInGone. */
  role: Role | 'none' | null;
  /** The name on this phone's sign-in row, from the same read. */
  name: PersonName | null;
  /** A change of the four kinds sent whose answer has not been read: key -> the rev sent. */
  sent: Readonly<Record<string, string>>;
  /** Each unit's status and reading as the server last had them, in step with synced: the base of the status merge. */
  units: Readonly<Record<string, UnitBase>>;
  /** Keys of rows passed over because this version of the app cannot read them. */
  unreadable: readonly string[];
  /** Changes the server would not take from this phone's sign-in: key -> the rev it refused and why; `seen` once Done was tapped. */
  held: Readonly<Record<string, { rev: string; reason: HeldReason; seen?: true }>>;
  /** Units taken out of the fleet while this phone has one checked out: kept to end the use, never sent. */
  gone: Readonly<Record<string, Equipment>>;
  /** What of a person's change the company did not take, newest first, at most 20, none older than 30 days. */
  notices: readonly ReceiveNotice[];
}

export function freshReceiving(company: string, role: Role | null = null): Receiving {
  return { company, epoch: 1, cursor: 0, caughtUpAt: null, pageSize: 200, role, name: null, sent: {}, units: {}, unreadable: [], held: {}, gone: {}, notices: [] };
}

// ---- Reading a row --------------------------------------------------------------------------------------

/** Every type of machine the app has. */
export const EQUIPMENT_CATEGORIES = [
  'loader',
  'haul_truck',
  'excavator',
  'dozer',
  'grader',
  'water_truck',
  'skid_steer',
  'forklift',
  'light_vehicle',
] as const satisfies readonly EquipmentCategory[];
// The compiler fails here when EquipmentCategory gains a type this list lacks.
type Unlisted = Exclude<EquipmentCategory, (typeof EQUIPMENT_CATEGORIES)[number]>;
const everyCategoryListed: [Unlisted] extends [never] ? true : Unlisted = true;
void everyCategoryListed;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Text with something in it besides spaces, tabs and line breaks: the server's test too. */
const filled = (v: unknown): v is string => isStr(v) && /[^ \t\n\r\f\v]/.test(v);
const has = (o: Obj, key: string) => Object.prototype.hasOwnProperty.call(o, key);
/** Left out, or there and of the right kind. A field that is null is there. */
const optional = (o: Obj, key: string, ok: (v: unknown) => boolean) => !has(o, key) || ok(o[key]);

/** The fields the server refuses as private, in any capitals, at any depth. */
const PRIVATE = /^(payrates?|passwordhash|salt|(hourly)?rate)$/i;
function holdsPrivate(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(holdsPrivate);
  if (!isObj(v)) return false;
  return Object.entries(v).some(([key, value]) => PRIVATE.test(key) || holdsPrivate(value));
}

const isPoint = (v: unknown) => isObj(v) && isNum(v.lat) && isNum(v.lng) && Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180;

function isSite(v: unknown): boolean {
  if (v === null) return true;
  if (!isObj(v) || !isStr(v.name) || !isPoint(v.center) || !isNum(v.radiusM) || v.radiusM <= 0) return false;
  if (!optional(v, 'polygon', (p) => Array.isArray(p) && p.every(isPoint))) return false;
  return optional(v, 'town', (t) => isObj(t) && isStr(t.name) && isPoint(t.center));
}

function isCompany(v: unknown): boolean {
  if (!isObj(v) || !isStr(v.name) || !isStr(v.state)) return false;
  const shaped =
    optional(v, 'place', isStr) &&
    optional(v, 'mineId', isStr) &&
    optional(v, 'logo', (l) => isObj(l) && (l.art === 'us-mine' || isStr(l.uri))) &&
    (!has(v, 'pay') || v.pay === null || isObj(v.pay)) &&
    optional(v, 'timeClock', (t) => t === false) &&
    optional(v, 'payCodes', (codes) => isObj(codes) && Object.values(codes).every(isStr));
  if (!shaped) return false;
  try {
    return checkCompany(v as never) === undefined;
  } catch {
    return false;
  }
}

const SETTINGS_FIELDS = ['company', 'site', 'workweekStartsOn', 'allowSectionAllOk'];

function readSettings(d: Obj): SharedSettings | null {
  if (!SETTINGS_FIELDS.every((f) => has(d, f)) || Object.keys(d).length !== SETTINGS_FIELDS.length) return null;
  const week = d.workweekStartsOn;
  if (!isCompany(d.company) || !isSite(d.site) || !isNum(week) || !Number.isInteger(week) || week < 0 || week > 6 || !isBool(d.allowSectionAllOk)) return null;
  return d as unknown as SharedSettings;
}

function readEmployee(d: Obj): Employee | null {
  const ok =
    filled(d.firstName) &&
    filled(d.lastName) &&
    (d.role === 'employee' || d.role === 'supervisor') &&
    isBool(d.active) &&
    optional(d, 'title', isStr) &&
    optional(d, 'payrollId', isStr);
  return ok ? (d as unknown as Employee) : null;
}

const STATUSES: readonly unknown[] = ['ready', 'defect', 'out_of_service'];

function readEquipment(d: Obj): Equipment | null {
  const ok =
    isStr(d.unit) &&
    isStr(d.make) &&
    isStr(d.model) &&
    (EQUIPMENT_CATEGORIES as readonly unknown[]).includes(d.category) &&
    STATUSES.includes(d.status) &&
    isNum(d.meter) &&
    d.meter >= 0 &&
    d.meter <= 10_000_000 &&
    (d.meterUnit === 'hrs' || d.meterUnit === 'mi');
  return ok ? (d as unknown as Equipment) : null;
}

function readSheet(d: Obj): AreaSheet | null {
  const rows = d.rows;
  if (!filled(d.title) || !Array.isArray(rows) || rows.length === 0) return null;
  if (!rows.every((r) => isObj(r) && isStr(r.id) && isStr(r.label))) return null;
  if (new Set(rows.map((r) => (r as Obj).id)).size !== rows.length) return null;
  return isBool(d.active) && optional(d, 'single', isBool) ? (d as unknown as AreaSheet) : null;
}

/**
 * A row's data as the record the phone keeps, or null when this version of the
 * app cannot read it. The checks are the shapes the app's own rules make, and
 * the server holds every writer to the same ones (shared_record_problem), but
 * for the company's pay schedule, mine ID and earning codes, which only the
 * phones and the dashboard's save check. What is kept is the data as it came,
 * so its version stays the server's.
 */
export function readRecord(kind: 'employee', id: string, data: unknown): Employee | null;
export function readRecord(kind: 'equipment', id: string, data: unknown): Equipment | null;
export function readRecord(kind: 'areaSheet', id: string, data: unknown): AreaSheet | null;
export function readRecord(kind: 'settings', id: string, data: unknown): SharedSettings | null;
export function readRecord(kind: ReferenceKind, id: string, data: unknown): Employee | Equipment | AreaSheet | SharedSettings | null;
export function readRecord(kind: ReferenceKind, id: string, data: unknown): Employee | Equipment | AreaSheet | SharedSettings | null {
  if (!isObj(data) || holdsPrivate(data)) return null;
  if (kind === 'settings') return readSettings(data);
  if (data.id !== id) return null;
  if (kind === 'employee') return readEmployee(data);
  if (kind === 'equipment') return readEquipment(data);
  return readSheet(data);
}

// ---- A unit's status ------------------------------------------------------------------------------------

const RANK: Record<EquipmentStatus, number> = { ready: 0, defect: 1, out_of_service: 2 };

/** out_of_service, then defect, then ready. */
export function worseStatus(a: EquipmentStatus, b: EquipmentStatus): EquipmentStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Three-way: what moved since the base wins; when both moved, the worse of the two. With no base, the worse of the two. */
export function mergeStatus(base: EquipmentStatus | undefined, mine: EquipmentStatus, theirs: EquipmentStatus): EquipmentStatus {
  if (base === undefined) return worseStatus(mine, theirs);
  if (mine === base) return theirs;
  if (theirs === base) return mine;
  return worseStatus(mine, theirs);
}

/** A unit's status from the requests open on it: a red-tag request keeps it out of service, any other keeps it at a defect. */
export function statusFromRequests(equipmentId: string, mrfs: readonly Mrf[]): EquipmentStatus {
  const open = mrfs.filter((m) => m.equipmentId === equipmentId && m.status !== 'completed');
  if (open.some((m) => m.taggedOut)) return 'out_of_service';
  return open.length > 0 ? 'defect' : 'ready';
}

// ---- What changed, in the dashboard's words ------------------------------------------------------------

/** What each field of a record is called on the dashboard's pages. */
const FIELD_WORDS: Record<string, Record<string, string>> = {
  equipment: {
    unit: 'unit number', category: 'type', make: 'make', model: 'model', status: 'status', meter: 'last reading', meterUnit: 'hours or miles',
  },
  areaSheet: { title: 'name', rows: 'lines', active: 'whether it is in use', single: 'columns' },
  settings: { site: 'clock-in site', workweekStartsOn: 'workweek', allowSectionAllOk: '“Rest are OK” switch' },
};

const COMPANY_WORDS: Record<string, string> = {
  name: 'company name', state: 'state', place: 'place', mineId: 'mine ID', logo: 'logo', pay: 'pay schedule', timeClock: 'time clock', payCodes: 'earning codes',
};

const asObj = (v: unknown): Obj => (isObj(v) ? v : {});
const differs = (a: unknown, b: unknown) => stableJson(a ?? null) !== stableJson(b ?? null);

/** The fields that are not the same in two versions of a record, by the name the dashboard gives them. */
export function changedFields(kind: string, before: unknown, after: unknown): string[] {
  const [was, now] = [asObj(before), asObj(after)];
  const words = FIELD_WORDS[kind] ?? {};
  const out: string[] = [];
  for (const field of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
    if (field === 'id' || !differs(was[field], now[field])) continue;
    if (kind === 'settings' && field === 'company') {
      const [a, b] = [asObj(was.company), asObj(now.company)];
      for (const part of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (differs(a[part], b[part])) out.push(COMPANY_WORDS[part] ?? part);
      }
      continue;
    }
    out.push(words[field] ?? field);
  }
  return out;
}

/** "a", "a and b", "a, b and c". */
export const listed = (words: readonly string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

// ---- Merging a page ------------------------------------------------------------------------------------

/** What of the store a page is merged with. */
export interface ReceiveState {
  employees: readonly Employee[];
  equipment: readonly Equipment[];
  areaSheets: readonly AreaSheet[];
  settings: Settings;
  /** This phone's own requests: requests are not received, so every one on the phone was made here. */
  mrfs: readonly Mrf[];
  opLogs: readonly OperatingLog[];
  synced: Synced;
  receiving: Receiving;
}

/** What a page changes. The store writes all of it in one set. */
export interface Received {
  employees: Employee[];
  equipment: Equipment[];
  areaSheets: AreaSheet[];
  settings: Settings;
  synced: Synced;
  receiving: Receiving;
}

const MAX_NOTICES = 20;
const NOTICE_DAYS = 30;
const DAY_MS = 86_400_000;

/** Newest first, at most 20, none older than 30 days. */
function keptNotices(notices: readonly ReceiveNotice[], now: number): ReceiveNotice[] {
  return notices.filter((n) => n.at >= now - NOTICE_DAYS * DAY_MS).slice(0, MAX_NOTICES);
}

/** The notices with new ones put first (the last of `fresh` is the newest), kept to 20 and to 30 days. */
export function withNotices(notices: readonly ReceiveNotice[], fresh: readonly ReceiveNotice[], now: number): ReceiveNotice[] {
  return keptNotices([...[...fresh].reverse(), ...notices], now);
}

/** What the phone says when the company kept a unit at the floor its open requests set. */
export function floorWords(unit: string, floor: EquipmentStatus): string {
  return `Unit ${unit} stays ${floor === 'out_of_service' ? 'red tagged' : 'marked for a defect'}: a maintenance request on it is still open with the company.`;
}

function withoutPayrollId(person: Employee): Employee {
  if (!has(person as unknown as Obj, 'payrollId')) return person;
  const { payrollId: _, ...rest } = person;
  return rest;
}

const BOTH_MOVED = (what: string, fields: string) =>
  `Your change to ${what} was not sent: it was changed in the office or on another phone first (${fields}). This phone now shows the newer version. Make your change again if it is still wanted.`;
const BOTH_MOVED_AFTER_A_SEND = (what: string, fields: string) =>
  `Your change to ${what} may have reached the company before it was changed in the office or on another phone (${fields}). This phone now shows the company’s version: check it, and make your change again if it is missing.`;
const NO_LONGER_A_SUPERVISOR = (what: string) =>
  `Your change to ${what} was not sent: this phone’s company sign-in is no longer a supervisor’s. This phone shows the company’s version.`;
const SHEET_ALREADY_THERE = (area: string) =>
  `The ${area} sheet was already on the company’s list, so this phone now shows the company’s. Your version was not sent; change it again if it is still wanted.`;
const UNIT_TAKEN_OUT = (unit: string) => `Unit ${unit} was taken out of the fleet. Your change to it was not sent.`;
const REMOVAL_OVERTAKEN = (unit: string) =>
  `Taking unit ${unit} out was not sent: the unit changed after this phone last had it (a checklist, a request or the office). It is back; take it out again if it should go.`;
const REMOVAL_NOT_A_SUPERVISOR = (unit: string) => `Taking unit ${unit} out was not sent: this phone’s company sign-in is not a supervisor’s. It is back.`;

/**
 * Merges one page of rows into the phone's records, on the state as it is at
 * that moment, and moves the cursor past the page. An empty page marks the
 * phone caught up. A row this version cannot read is passed over: its key goes
 * on the unreadable list, and the phone's copy and version stay as they were.
 * Applying the same page twice changes nothing the second time.
 */
export function mergeRows(state: ReceiveState, rows: readonly ReceivedRow[], now: number): Received {
  const r = state.receiving;
  const supervisor = r.role === 'supervisor';
  const people = new Map(state.employees.map((e) => [e.id, e]));
  const fleet = new Map(state.equipment.map((e) => [e.id, e]));
  const sheets = new Map(state.areaSheets.map((s) => [s.id, s]));
  let settings = state.settings;
  const synced: Synced = { ...state.synced };
  const sent: Record<string, string> = { ...r.sent };
  const units: Record<string, UnitBase> = { ...r.units };
  const held = { ...r.held };
  const gone = { ...r.gone };
  const unreadable = new Set(r.unreadable);
  const fresh: ReceiveNotice[] = [];
  let cursor = r.cursor;

  for (const row of rows) {
    cursor = Math.max(cursor, row.seq);
    const key = `${row.kind}:${row.id}`;
    const theirs = row.deleted ? null : readRecord(row.kind, row.id, row.data);
    if (!row.deleted && theirs === null) {
      unreadable.add(key);
      continue;
    }
    unreadable.delete(key);
    const S = synced[key];
    const took = () => {
      synced[key] = row.rev;
      delete sent[key];
      delete held[key];
    };
    const dropped = () => {
      delete synced[key];
      delete sent[key];
      delete held[key];
    };
    const say = (words: string) => fresh.push({ id: `${key}@${row.rev}`, at: now, words });

    if (row.kind === 'employee') {
      if (theirs === null) {
        people.delete(row.id);
        dropped();
      } else {
        people.set(row.id, supervisor ? (theirs as Employee) : withoutPayrollId(theirs as Employee));
        took();
      }
      continue;
    }

    if (row.kind === 'areaSheet' || row.kind === 'settings') {
      const mine: object | undefined = row.kind === 'areaSheet' ? sheets.get(row.id) : sharedSettings(settings);
      const what = row.kind === 'settings' ? 'the company settings' : `the ${(mine as AreaSheet | undefined)?.title ?? (theirs as AreaSheet | null)?.title ?? ''} sheet`;
      const take = (record: object) => {
        if (row.kind === 'areaSheet') {
          sheets.set(row.id, record as AreaSheet);
        } else {
          const company = record as SharedSettings;
          // A company with no site never takes a pin off a supervisor's phone: the pin goes to the company.
          const site = company.site === null && supervisor && settings.site ? settings.site : company.site;
          settings = { ...settings, ...company, site };
        }
        took();
      };
      if (theirs === null) {
        // The app never takes a sheet or the settings off; the company can.
        if (row.kind === 'areaSheet') sheets.delete(row.id);
        dropped();
        continue;
      }
      if (!mine || (row.kind === 'settings' && S === undefined)) {
        // Nothing here, or settings the server never had from this phone: the company's, quietly.
        take(theirs);
        continue;
      }
      const mineRev = revOf(mine);
      if (S === undefined) {
        // A sheet typed under a name the company already has.
        if (supervisor && mineRev !== row.rev) say(SHEET_ALREADY_THERE((mine as AreaSheet).title));
        take(theirs);
        continue;
      }
      if (mineRev === S) {
        take(theirs);
        continue;
      }
      // Changed here.
      if (!supervisor) {
        if (mineRev !== row.rev) say(NO_LONGER_A_SUPERVISOR(what));
        take(theirs);
        continue;
      }
      if (row.rev === S) continue; // The server has not moved: it goes in the send.
      if (row.rev === mineRev || row.rev === sent[key]) {
        // Its own write coming back, whose answer was lost.
        synced[key] = row.rev;
        delete sent[key];
        delete held[key];
        continue;
      }
      const fields = listed(changedFields(row.kind, mine, theirs));
      say(sent[key] ? BOTH_MOVED_AFTER_A_SEND(what, fields) : BOTH_MOVED(what, fields));
      take(theirs);
      continue;
    }

    // A unit.
    const mine = fleet.get(row.id);
    if (theirs === null) {
      if (mine) {
        fleet.delete(row.id);
        if (state.opLogs.some((l) => l.equipmentId === row.id && l.endAt === undefined)) gone[row.id] = mine;
        if (S === undefined || revOf(mine) !== S) say(UNIT_TAKEN_OUT(mine.unit));
      }
      delete units[row.id];
      dropped();
      continue;
    }
    const server = theirs as Equipment;
    const base = (): UnitBase => ({ status: server.status, meter: server.meter });
    let next: Equipment | undefined;
    if (!mine) {
      if (S !== undefined && supervisor && row.rev === S) continue; // Taken out here, and the server has not moved: the removal goes.
      if (S !== undefined) say(supervisor ? REMOVAL_OVERTAKEN(server.unit) : REMOVAL_NOT_A_SUPERVISOR(server.unit));
      next = server;
      took();
      units[row.id] = base();
    } else if (S === undefined) {
      next = { ...server, status: mergeStatus(undefined, mine.status, server.status), meter: Math.max(mine.meter, server.meter) };
      took();
      units[row.id] = base();
    } else if (revOf(mine) === S) {
      next = server;
      took();
      units[row.id] = base();
    } else if (row.rev === S) {
      next = mine; // The server has not moved: it goes in the send.
    } else if (row.rev === revOf(mine) || row.rev === sent[key]) {
      next = mine;
      synced[key] = row.rev;
      delete sent[key];
      delete held[key];
      units[row.id] = base();
    } else {
      next = { ...server, status: mergeStatus(units[row.id]?.status, mine.status, server.status), meter: Math.max(mine.meter, server.meter) };
      took();
      units[row.id] = base();
    }
    // Never better than this phone's own open requests on it: a raise goes to the company in the send.
    const floor = statusFromRequests(row.id, state.mrfs);
    if (worseStatus(next.status, floor) !== next.status) next = { ...next, status: floor };
    fleet.set(row.id, next);
  }

  return {
    employees: [...people.values()],
    equipment: [...fleet.values()],
    areaSheets: [...sheets.values()],
    settings,
    synced,
    receiving: {
      ...r,
      cursor,
      caughtUpAt: rows.length === 0 ? now : r.caughtUpAt,
      sent,
      units,
      held,
      gone,
      unreadable: [...unreadable],
      notices: withNotices(r.notices, fresh, now),
    },
  };
}

// ---- Who the phone is to the company ------------------------------------------------------------------

/** Every payroll ID off, the same list back when there is none. */
function withoutPayrollIds(people: readonly Employee[]): readonly Employee[] {
  return people.some((p) => p.payrollId !== undefined || has(p as unknown as Obj, 'payrollId')) ? people.map(withoutPayrollId) : people;
}

/**
 * What a phone does with the standing it read: its sign-in's own row of the
 * roster (null: not on the roster). The only writer of receiving.role and
 * receiving.name. Made crew or taken off the roster, every payroll ID comes
 * off; a change of role reads everything again under a new epoch, so the
 * crew-phone rule puts the company's version back over a supervisor's edit not
 * yet sent, and a new supervisor's phone gets the people whole. A new
 * supervisor's held changes go again.
 */
export function standingChange(
  state: { employees: readonly Employee[]; receiving: Receiving },
  standing: Standing | null,
): { employees: readonly Employee[]; receiving: Receiving } {
  const r = state.receiving;
  if (standing === null) return { employees: withoutPayrollIds(state.employees), receiving: { ...r, role: 'none' } };
  if (standing.role === r.role) return { employees: state.employees, receiving: { ...r, name: standing.name } };
  const again = { ...r, role: standing.role, name: standing.name, epoch: r.epoch + 1, cursor: 0 };
  if (standing.role === 'employee') return { employees: withoutPayrollIds(state.employees), receiving: again };
  return { employees: state.employees, receiving: { ...again, held: {} } };
}

/**
 * The phone's own company sign-in was deleted: who it was to the company is forgotten, as for a sign-in
 * taken off the roster, and its name with it, so nothing on the phone goes by the name of a sign-in that
 * is gone (the next account made here among it). Payroll IDs go too: no sign-in here is a supervisor's.
 */
export function signInGone(state: { employees: readonly Employee[]; receiving: Receiving }): { employees: readonly Employee[]; receiving: Receiving } {
  return { employees: withoutPayrollIds(state.employees), receiving: { ...state.receiving, role: 'none', name: null } };
}

// ---- What the company did not take, in words ------------------------------------------------------------

const fullName = (people: readonly Employee[], id: string | undefined) => {
  const p = people.find((e) => e.id === id);
  return p ? `${p.firstName} ${p.lastName}` : 'someone';
};

/**
 * What a change the company did not take from this phone's sign-in is, the way
 * the person knows it, and why, with what to do: for the list on More.
 */
export function notTakenWords(
  change: { kind: string; id: string },
  reason: HeldReason,
  data: {
    employees: readonly Employee[];
    equipment: readonly Equipment[];
    areaSheets: readonly AreaSheet[];
    leave: readonly { id: string; employeeId: string; day: number }[];
    shifts: readonly { id: string; employeeId: string; clockIn: { at: number } }[];
    mrfs: readonly Mrf[];
  },
): { what: string; why: string } {
  const { employees } = data;
  let what: string;
  switch (change.kind) {
    case 'leave': {
      const entry = data.leave.find((l) => l.id === change.id);
      what = entry ? `Paid leave for ${fullName(employees, entry.employeeId)} on ${fmtDate(entry.day)}` : 'Paid leave taken off';
      break;
    }
    case 'shift': {
      const shift = data.shifts.find((s) => s.id === change.id);
      what = shift ? `A correction to ${fullName(employees, shift.employeeId)}’s shift on ${fmtDate(shift.clockIn.at)}` : 'A shift taken off';
      break;
    }
    case 'mrf': {
      const mrf = data.mrfs.find((m) => m.id === change.id);
      what = mrf ? `Request #${mrf.number}${mrf.assignedTo ? ` assigned to ${fullName(employees, mrf.assignedTo)}` : ''}` : 'A maintenance request taken off';
      break;
    }
    case 'equipment':
      what = `Unit ${data.equipment.find((e) => e.id === change.id)?.unit ?? change.id}`;
      break;
    case 'areaSheet':
      what = `The ${data.areaSheets.find((s) => s.id === change.id)?.title ?? change.id} sheet`;
      break;
    case 'settings':
      what = 'The company settings';
      break;
    case 'exam':
      what = 'A pre shift exam';
      break;
    case 'inspection':
      what = 'An equipment checklist';
      break;
    case 'opLog':
      what = 'The use of a unit';
      break;
    default:
      what = 'A turned-down punch';
  }
  const why =
    reason === 'supervisor_only'
      ? 'Only a supervisor’s company sign-in can send this. Enter it on the dashboard, or join this phone with a supervisor’s sign-in on Company account.'
      : reason === 'not_yours'
        ? 'Another person’s record: the company keeps theirs.'
        : reason === 'signed'
          ? 'Already signed: a signed record is not changed.'
          : 'The company’s server would not take it as it is. Tell the office.';
  return { what, why };
}
