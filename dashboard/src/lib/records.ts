import { examCounts, examFindings } from '@app/domain/areaExam';
import { type Company } from '@app/domain/company';
import { checkPaySchedule, type PaySchedule } from '@app/domain/payPeriod';
import { checklistFor, isHazard } from '@app/domain/templates';
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
  Shift,
} from '@app/domain/types';
import type { ReportData } from '@app/services/reports';

import type { CompanyRow, RecordKind, RecordRow, RosterRow } from './server';
import { RECORD_KINDS } from './server';
import { isNum, isObj, isStr, problemWith } from './validate';

/**
 * The company's records as the server holds them, shaped into what the app's
 * own code takes: `ReportData` for payroll, the Excel workbooks and the PDF for
 * an inspector, plus the area sheets, the punches that were turned down and the
 * company settings. Each record's `data` is the record as it is on the phone.
 *
 * A record the phones took off is left out. A record that is not the shape the
 * app writes, all the way down, is set aside and listed, so one bad row never
 * stops the page (validate.ts).
 */

export interface Skipped {
  kind: string;
  id: string;
  why: string;
}

/** The accounts that sent a record: the first version, and the latest. */
export interface SentBy {
  created: string | null;
  updated: string | null;
}

export interface Shaped {
  data: ReportData & { settings: Pick<NonNullable<ReportData['settings']>, 'company' | 'workweekStartsOn'> };
  company: Company;
  workweekStartsOn: number;
  /**
   * Where the company settings came from: the settings record a supervisor's phone
   * sent, or, until one has arrived, the company on the server, which has no
   * workweek, earning codes or time-clock switch of its own.
   */
  settingsFrom: 'phones' | 'server';
  /**
   * The clock-in site in the shared settings, as it was sent: an object, or null
   * for none. It is set standing at the mine, on a phone; the dashboard shows it
   * and never changes it. It is read from the settings record even when the rest
   * of that record is set aside, so that settings saved in its place keep the pin.
   */
  site: unknown;
  /** Whether the unanswered lines of a checklist or an exam can be marked OK in one tap: the app's default until the settings say. */
  allowSectionAllOk: boolean;
  areaSheets: AreaSheet[];
  denied: DeniedPunch[];
  /**
   * People whose records arrived with no employee record from the phones yet. They are
   * named from the sign-in roster when the account that sent their records is on it.
   */
  placeholders: Set<string>;
  /** Of those, the ones no roster row names either. */
  unnamed: Set<string>;
  /** Who sent each record, by `kind:id`. */
  sentBy: Map<string, SentBy>;
  /** Records of each kind, not counting those taken off a phone. */
  counts: Record<RecordKind, number>;
  /** The newest change the server holds, and the account that sent it. */
  lastArrived?: { at: number; by: string | null };
  skipped: Skipped[];
}

type Obj = Record<string, unknown>;

/** The kinds a person makes for themselves, so the account that sent one is that person. */
const OWN_KINDS: RecordKind[] = ['shift', 'inspection', 'exam', 'opLog', 'denied'];

const ms = (iso: string) => Date.parse(iso);

/**
 * Runs a record through the app's own code that reads one record at a time, so
 * a shape the checks above let past still cannot stop a page.
 */
function tryRead(kind: RecordKind, d: Obj): void {
  if (kind === 'exam') {
    examFindings(d as unknown as AreaExam);
    examCounts(d as unknown as AreaExam);
  } else if (kind === 'inspection') {
    const template = checklistFor('loader');
    for (const answer of (d as unknown as Inspection).answers) isHazard(template, answer);
  }
}

/**
 * The company the hours are figured for. When a supervisor's phone has sent the
 * settings, they are the phones' own, as they are: the name, the state and the
 * pay periods the phones figure their hours and name their files by. A state left
 * empty on the phones stays empty here too, so both sides figure the same hours
 * under the federal rules; the pages say so. Only with no settings from the phones
 * yet is the company on the server used.
 */
function companyFrom(settings: Obj | undefined, row: CompanyRow | undefined): Company {
  const fromPhone = isObj(settings?.company) ? (settings.company as Obj) : undefined;
  const pay = (raw: unknown): PaySchedule | null =>
    isObj(raw) && isStr(raw.frequency) && isObj(raw.payday) && !checkPaySchedule(raw as unknown as PaySchedule) ? (raw as unknown as PaySchedule) : null;
  if (fromPhone) {
    return {
      ...(fromPhone as unknown as Company),
      name: isStr(fromPhone.name) ? fromPhone.name : '',
      state: isStr(fromPhone.state) ? fromPhone.state : '',
      pay: pay(fromPhone.pay),
    };
  }
  return { name: row?.name ?? '', state: row?.state ?? '', pay: pay(row?.pay_period) };
}

export function shapeRecords(rows: RecordRow[], from: { company?: CompanyRow; roster?: RosterRow[] } = {}): Shaped {
  // The latest version of each record, should a page have handed one over twice.
  const latest = new Map<string, RecordRow>();
  for (const row of rows) {
    const key = `${row.kind}:${row.id}`;
    const have = latest.get(key);
    if (!have || ms(row.updated_at) >= ms(have.updated_at)) latest.set(key, row);
  }

  const counts = Object.fromEntries(RECORD_KINDS.map((k) => [k, 0])) as Record<RecordKind, number>;
  const byKind = new Map<RecordKind, { row: RecordRow; data: Obj }[]>(RECORD_KINDS.map((k) => [k, []]));
  const skipped: Skipped[] = [];
  const sentBy = new Map<string, SentBy>();
  let lastArrived: Shaped['lastArrived'];

  for (const row of latest.values()) {
    const at = ms(row.updated_at);
    if (Number.isFinite(at) && (!lastArrived || at > lastArrived.at)) lastArrived = { at, by: row.updated_by };
    if (row.deleted) continue;
    const kind = row.kind as RecordKind;
    if (!RECORD_KINDS.includes(kind)) {
      skipped.push({ kind: row.kind, id: row.id, why: 'a kind of record this dashboard does not know' });
      continue;
    }
    if (!isObj(row.data)) {
      skipped.push({ kind, id: row.id, why: 'no record in it' });
      continue;
    }
    let why: string | undefined;
    try {
      why = problemWith(kind, row.data);
      if (!why) tryRead(kind, row.data);
    } catch {
      why = 'a record the app’s code cannot read';
    }
    if (why) {
      skipped.push({ kind, id: row.id, why });
      continue;
    }
    counts[kind] += 1;
    // The record's own id is the one the server keys it by.
    const id = isStr(row.data.id) && row.data.id ? row.data.id : row.id;
    sentBy.set(`${kind}:${id}`, { created: row.created_by, updated: row.updated_by });
    byKind.get(kind)!.push({ row, data: { ...row.data, id } });
  }

  // What a field the app may leave out stands for. Checked above: a field that is there is the right type.
  const list = <T,>(kind: RecordKind, fill?: (d: Obj) => Obj): T[] =>
    byKind.get(kind)!.map(({ data }) => (fill ? fill(data) : data) as unknown as T);

  const employees = list<Employee>('employee', (d) => ({ role: 'employee', active: true, ...d }));
  const shifts = list<Shift>('shift', (d) => ({ lunches: [], breaks: [], ...d }));
  const leave = list<LeaveEntry>('leave');
  const equipment = list<Equipment>('equipment', (d) => ({ make: '', model: '', status: 'ready', meter: 0, meterUnit: 'hrs', ...d }));
  const inspections = list<Inspection>('inspection');
  const opLogs = list<OperatingLog>('opLog');
  const exams = list<AreaExam>('exam', (d) => ({ sheetId: '', ...d }));
  const mrfs = list<Mrf>('mrf', (d) => ({ history: [], items: [], priority: 'routine', taggedOut: false, description: '', ...d }));
  const areaSheets = list<AreaSheet>('areaSheet', (d) => ({ active: true, ...d }));
  const denied = list<DeniedPunch>('denied');
  const settings = byKind.get('settings')!.find(({ row }) => row.id === 'company')?.data;

  // ---- People the records name with no employee record yet ----------------------------------
  const known = new Set(employees.map((e) => e.id));
  const named = new Set<string>();
  const add = (id: unknown) => {
    if (isStr(id) && id && !known.has(id)) named.add(id);
  };
  for (const s of shifts) {
    add(s.employeeId);
    for (const edit of s.edits ?? []) add(edit.byEmployeeId);
  }
  for (const l of leave) {
    add(l.employeeId);
    add(l.enteredBy);
  }
  for (const i of inspections) add(i.employeeId);
  for (const l of opLogs) add(l.employeeId);
  for (const d of denied) add(d.employeeId);
  for (const x of exams) {
    add(x.employeeId);
    for (const line of [...x.rows, ...x.conditions]) add(line.fixed?.by);
  }
  for (const m of mrfs) {
    add(m.requestedBy);
    add(m.assignedTo);
    add(m.completedBy);
    for (const h of m.history) {
      add(h.by);
      add(h.assignedTo);
    }
  }

  // The account that sent a person's own records, and so the roster row that names them.
  const accountsOf = new Map<string, Map<string, number>>();
  for (const kind of OWN_KINDS) {
    for (const { row, data } of byKind.get(kind)!) {
      const who = data.employeeId;
      if (!isStr(who) || !named.has(who) || !row.created_by) continue;
      const tally = accountsOf.get(who) ?? new Map<string, number>();
      tally.set(row.created_by, (tally.get(row.created_by) ?? 0) + 1);
      accountsOf.set(who, tally);
    }
  }
  const rosterOf = new Map((from.roster ?? []).filter((r) => r.user_id).map((r) => [r.user_id as string, r]));
  const hasHours = new Set([...shifts.map((s) => s.employeeId), ...leave.map((l) => l.employeeId)]);
  const placeholders = new Set<string>();
  const unnamed = new Set<string>();
  for (const id of [...named].sort()) {
    placeholders.add(id);
    const tally = [...(accountsOf.get(id) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    const row = tally.map(([account]) => rosterOf.get(account)).find(Boolean);
    if (!row) {
      unnamed.add(id);
      // With no name anywhere, the person reads "Unknown", as the app prints one it does not know.
      // Only someone with hours is kept, so their hours are never dropped from payroll for want of a name.
      if (!hasHours.has(id)) continue;
    }
    employees.push({
      id,
      firstName: row ? row.first_name : `ID ${id}`,
      lastName: row ? row.last_name : 'Unknown',
      role: row?.role ?? 'employee',
      ...(row?.title ? { title: row.title } : null),
      active: hasHours.has(id),
    });
  }

  const settingsFrom: Shaped['settingsFrom'] = settings && isObj(settings.company) ? 'phones' : 'server';
  // The settings record as it was sent, read or set aside: the site and the switch in it go back as they were.
  const sentRow = [...latest.values()].find((row) => row.kind === 'settings' && row.id === 'company' && !row.deleted);
  const sent = isObj(sentRow?.data) ? sentRow.data : undefined;
  const company = companyFrom(settings, from.company);
  const week = settings?.workweekStartsOn;
  const workweekStartsOn = isNum(week) && Number.isInteger(week) && week >= 0 && week <= 6 ? week : 0;

  return {
    data: {
      employees,
      shifts,
      leave,
      equipment,
      inspections,
      opLogs,
      exams,
      mrfs,
      settings: { company, workweekStartsOn },
    },
    company,
    workweekStartsOn,
    settingsFrom,
    site: isObj(sent?.site) ? sent.site : null,
    allowSectionAllOk: typeof sent?.allowSectionAllOk === 'boolean' ? sent.allowSectionAllOk : true,
    areaSheets,
    denied,
    placeholders,
    unnamed,
    sentBy,
    counts,
    lastArrived,
    skipped,
  };
}

/** A person's name, last name first, the way the paper lists it. */
export function nameOf(employees: Map<string, Employee> | Employee[], id: string | undefined): string {
  if (!id) return '';
  const e = Array.isArray(employees) ? employees.find((x) => x.id === id) : employees.get(id);
  return e ? `${e.lastName}, ${e.firstName}` : 'Unknown';
}
