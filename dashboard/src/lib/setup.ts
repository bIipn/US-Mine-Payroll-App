import { openFindings } from '@app/domain/areaExam';
import { checkCompany, type Company } from '@app/domain/company';
import { codesOf, sameCodes, scheduleOf, type CompanyDraft } from '@app/domain/companyForm';
import { checkPaySchedule, type PaySchedule } from '@app/domain/payPeriod';
import { DEFAULT_PAY_CODES } from '@app/domain/payrollCsv';
import { stableJson } from '@app/domain/sync';
import type { AreaExam, AreaSheet, Equipment, Inspection, Mrf, OperatingLog } from '@app/domain/types';

import { openBadOrders, unitsDown, type OpenBadOrder } from './overview';
import type { CompanyRow } from './server';

/**
 * What the Fleet, Exam sheets and Company pages work out from the records
 * before they show or save anything. The rules for a unit, a sheet and a
 * company themselves are the app's own (`@app/domain/fleet`, `areaExam`,
 * `company`, `companyForm`); nothing here repeats them.
 */

/**
 * Said at the head of each page that saves a record, so nobody takes the
 * office for the phones. Phones send and do not receive: what is saved here is
 * the company's record on the server and on this dashboard, and no phone has it.
 */
export const PHONES_DO_NOT_RECEIVE = 'Phones do not receive changes from the office yet';

/** What that means on each page, and what to do about it today. */
export const ON_PHONES = {
  fleet: [
    'A unit added, changed or taken out here is saved to the company and shows on this dashboard. The crew’s phones keep the fleet they have until the app is updated to receive.',
    'To put a unit on the crew’s checklist today, add it on a supervisor’s phone, on Crew → Fleet. It arrives here with its checklists. Added here as well, the same unit shows twice, as each copy gets an id of its own.',
    'A unit taken out here is put back when a supervisor’s phone that still has it sends it again. Take it out on the supervisors’ phones too.',
  ],
  sheets: [
    'A sheet added, changed or stopped here is saved to the company and shows on this dashboard. The crew’s phones keep the sheets they have until the app is updated to receive.',
    'To have the crew fill a sheet in today, type it in on a supervisor’s phone as well, on Crew → Area sheets, under the same name: it is then the same record as the one here.',
    'A supervisor’s phone that changes a sheet sends its own copy, which replaces what is saved here, a sheet stopped here included.',
  ],
  company: [
    'What is saved here is what this dashboard goes by: its payroll, its hours file and its exports. Each phone keeps its own settings until the app is updated to receive.',
    'A supervisor’s phone that changes a shared setting, the clock-in pin included, sends its own copy of them all, and that replaces what is saved here. Make the same change on the supervisors’ phones first, on More → Company, then save it here. This page says so when a phone’s copy has replaced the office’s.',
  ],
} as const;

/** Said under a form that saves, in one quiet line. */
export const SAVED_HERE_ONLY = 'Saved to the company and shown on this dashboard. Phones do not receive it yet.';

// ---- The fleet -------------------------------------------------------------------------------------

type FleetData = { equipment: Equipment[]; inspections: Inspection[]; opLogs: OperatingLog[]; mrfs: Mrf[] };

export type Standing = 'ready' | 'defect' | 'red_tagged';

/**
 * Each unit's standing, worked out from the records that do arrive. The unit's
 * own record is the least reliable there is: each phone keeps its own copy,
 * and the server sets a crew phone's status for a unit aside whenever someone
 * else wrote the unit last, which is every time once the office has changed
 * it. The checklists and the requests still arrive. So a unit is red tagged
 * when its record says so, when an open red-tag request names it, or when a
 * Bad Order on a safety item of one of its checklists is not corrected; it has
 * a defect reported when its record says so, or anything else is open on it;
 * and it is ready only with none of those. The tag, the counts and the
 * question asked before a unit is taken out all go by this one rule.
 */
export function standings(data: Pick<FleetData, 'equipment' | 'mrfs' | 'inspections'>): Map<string, Standing> {
  const down = unitsDown(data.equipment, data.mrfs);
  const tagged = new Set(down.redTagged.map((e) => e.id));
  const defect = new Set(down.defect.map((e) => e.id));
  for (const open of openBadOrders(data)) (open.hazard ? tagged : defect).add(open.inspection.equipmentId);
  return new Map(data.equipment.map((e) => [e.id, tagged.has(e.id) ? 'red_tagged' : defect.has(e.id) ? 'defect' : 'ready']));
}

export interface Reading {
  value: number;
  /** When it was read, when a checklist or an end of use gave it. */
  at?: number;
  /** Where it comes from: a checklist, the end of a use, or the reading the unit was added with. */
  from: 'checklist' | 'use' | 'unit';
}

/**
 * A unit's last reading. Every phone keeps its own copy of the fleet, so the
 * reading on the unit's own record is only as new as the phone that sent it
 * last. The newest checklist on the unit, or the newest end of use, says more.
 */
export function lastReading(unit: Equipment, data: Pick<FleetData, 'inspections' | 'opLogs'>): Reading {
  let best: Reading = { value: unit.meter, from: 'unit' };
  for (const i of data.inspections) {
    if (i.equipmentId === unit.id && (best.at === undefined || i.submittedAt > best.at)) best = { value: i.meter, at: i.submittedAt, from: 'checklist' };
  }
  for (const l of data.opLogs) {
    if (l.equipmentId === unit.id && l.endAt != null && l.endMeter != null && (best.at === undefined || l.endAt >= best.at)) best = { value: l.endMeter, at: l.endAt, from: 'use' };
  }
  return best;
}

export interface OpenOnUnit {
  redTagged: boolean;
  /** Maintenance requests for the unit that are not completed. */
  requests: Mrf[];
  /** Bad Orders on its equipment checklists that are not corrected yet. */
  badOrders: OpenBadOrder[];
}

/** What is open on a unit: what a supervisor is told before it is taken out of the fleet. */
export function openOnUnit(unit: Equipment, data: FleetData): OpenOnUnit {
  return {
    redTagged: standings(data).get(unit.id) === 'red_tagged',
    requests: data.mrfs.filter((m) => m.equipmentId === unit.id && m.status !== 'completed'),
    badOrders: openBadOrders(data).filter((b) => b.inspection.equipmentId === unit.id),
  };
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const listed = (words: string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/** Whether anything is open on a unit. */
export const anythingOpen = (open: OpenOnUnit) => open.redTagged || open.requests.length > 0 || open.badOrders.length > 0;

/** Said in every question before a unit is taken out: what a phone that still has it does. */
export const PHONE_PUTS_BACK = 'A supervisor’s phone that still has this unit puts it back when it next sends it: take it out on the supervisors’ phones too.';

/**
 * What is asked before a unit is taken out of the fleet. The app takes a unit
 * out whatever is open on it, and its past checklists and requests stay on
 * record; here the question says what is open first, and that phones do not
 * hear of it.
 */
export function removalQuestion(unit: Equipment, open: OpenOnUnit): string {
  const kept = `Its past checklists and requests stay on record. ${PHONE_PUTS_BACK}`;
  const still: string[] = [];
  if (open.redTagged) still.push('is red tagged');
  if (open.requests.length) still.push(`has ${n(open.requests.length, 'open maintenance request')}`);
  if (open.badOrders.length) still.push(`has ${n(open.badOrders.length, 'Bad Order')} not corrected`);
  if (still.length === 0) return `Take unit ${unit.unit} out of the fleet? ${kept}`;
  // A request or a Bad Order outlives the unit; a red tag with neither behind it is on the unit's own record and goes with it.
  const stays = open.requests.length || open.badOrders.length ? ' What is open stays open on the other pages, under a unit removed from the fleet.' : '';
  return `Unit ${unit.unit} ${listed(still)}. Taking it out of the fleet corrects none of that.${stays} ${kept}`;
}

/** Units that share a unit number, whatever its capitals: each phone and the office give a new unit an id of its own. */
export function sameNumbers(equipment: Equipment[]): Map<string, Equipment[]> {
  const byNumber = new Map<string, Equipment[]>();
  for (const e of equipment) {
    const number = e.unit.trim().toUpperCase();
    byNumber.set(number, [...(byNumber.get(number) ?? []), e]);
  }
  return new Map([...byNumber].filter(([, units]) => units.length > 1).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })));
}

/** How many equipment checklists name each unit. */
export function checklistsByUnit(inspections: Inspection[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const i of inspections) counts.set(i.equipmentId, (counts.get(i.equipmentId) ?? 0) + 1);
  return counts;
}

// ---- Area sheets -----------------------------------------------------------------------------------

/** A sheet's lines as they are typed in: one to a line. */
export const linesText = (sheet: Pick<AreaSheet, 'rows'>) => sheet.rows.map((r) => r.label).join('\n');

/** How many lines a box of text holds: the ones with anything on them. */
export const lineCount = (text: string) => text.split('\n').filter((line) => line.trim()).length;

export interface SheetUse {
  /** Pre shift exams made on the sheet. */
  exams: number;
  /** Conditions found in the area with no date fixed yet. */
  open: number;
  /** Of those, the ones marked as a danger. */
  dangers: number;
}

export function sheetUse(sheet: AreaSheet, exams: AreaExam[]): SheetUse {
  const open = openFindings(exams, sheet.id);
  return { exams: exams.filter((x) => x.sheetId === sheet.id).length, open: open.length, dangers: open.filter((f) => f.danger).length };
}

/** Said in the question before a sheet is stopped: what a phone that still has it does. */
export const PHONE_STARTS_AGAIN = 'A supervisor’s phone that changes this sheet sends its own copy, in use: stop using it on the supervisors’ phones too.';

/** What is asked before a sheet is taken off the list the crew picks from. */
export function stopQuestion(sheet: AreaSheet, use: SheetUse): string {
  const moves = 'It moves to Not in use here, and the crew stops seeing the area once their phones have the change.';
  const kept = `Its exams stay on record, and it can be put back. ${PHONE_STARTS_AGAIN}`;
  if (use.open === 0) return `Stop using the ${sheet.title} sheet? ${moves} ${kept}`;
  const what = use.open === 1 ? 'One condition is' : `${use.open} conditions are`;
  const stays = use.open === 1 ? 'it stays open until its date fixed is recorded' : 'they stay open until each has its date fixed recorded';
  return `${what} still open in ${sheet.title}${use.dangers ? `, ${use.dangers === use.open ? (use.open === 1 ? 'a danger' : 'all dangers') : `${n(use.dangers, 'danger')} among them`}` : ''}. Stopping the sheet closes nothing: ${stays}. ${moves} ${kept}`;
}

/** Sheets with a danger open in their area first, then by name: a danger comes ahead of anything else. */
export function dangerFirst<T extends { sheet: AreaSheet; use: SheetUse }>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(b.use.dangers > 0) - Number(a.use.dangers > 0) || a.sheet.title.localeCompare(b.sheet.title, undefined, { numeric: true }));
}

/** The name a sheet is saved under, when that is not what was typed: "Truck scale areas:" is kept as "Truck scale". */
export function savedAs(typed: string, saved: string | undefined): string | null {
  return saved && typed.trim() && saved !== typed.trim() ? saved : null;
}

// ---- The shared company settings -------------------------------------------------------------------

export interface SharedSettings {
  company: Company;
  site: unknown;
  workweekStartsOn: number;
  allowSectionAllOk: boolean;
}

/**
 * The shared settings as a phone sends them: the company, the clock-in site,
 * the day the workweek starts and the "section all OK" switch, and nothing
 * else (the server sets aside settings that hold anything more).
 */
export function sharedSettings(from: SharedSettings): SharedSettings {
  const week = Number.isInteger(from.workweekStartsOn) && from.workweekStartsOn >= 0 && from.workweekStartsOn <= 6 ? from.workweekStartsOn : 0;
  return { company: from.company, site: from.site && typeof from.site === 'object' ? from.site : null, workweekStartsOn: week, allowSectionAllOk: from.allowSectionAllOk };
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The fields of the pay period a person types in, in the order the form shows them. */
export type PayField = 'firstDay' | 'daysAfter' | 'firstHalf' | 'secondHalf';
type CodeKey = keyof CompanyDraft['codes'];

export interface CompanyProblems {
  name?: string;
  state?: string;
  mineId?: string;
  pay?: string;
  /** The field of the pay period that is at fault, when it is one a person types in. */
  payField?: PayField;
  codes?: string;
  /** The earning codes at fault: the one that is not a code, or the ones that are the same. */
  codeKeys?: CodeKey[];
}

/** A value each pay field is known to pass with, to find the one at fault by the app's own check. */
const GOOD_PAY: Record<PayField, string> = { firstDay: '2026-01-04', daysAfter: '5', firstHalf: '20', secondHalf: '5' };
const PAY_FIELDS: PayField[] = ['firstDay', 'daysAfter', 'firstHalf', 'secondHalf'];

/**
 * Which field of the pay period the app's check is turning down: the first
 * one, in the order the form shows them, that draws the same words from the
 * check when it alone is as typed and the others are known to pass. Undefined
 * when the fault is not in a field a person types in.
 */
export function payFieldAtFault(draft: CompanyDraft): PayField | undefined {
  const check = (d: CompanyDraft) => {
    const schedule = scheduleOf(d);
    return schedule ? checkPaySchedule(schedule) : undefined;
  };
  const said = check(draft);
  if (!said) return undefined;
  const alone = (field: PayField) => check({ ...draft, ...GOOD_PAY, [field]: draft[field] });
  return PAY_FIELDS.find((field) => alone(field) === said) ?? PAY_FIELDS.find((field) => alone(field));
}

/**
 * Which earning codes are at fault. A code that is not one is found by putting
 * it to the app's own check beside five that pass; codes that are the same are
 * the ones the check's other message is about.
 */
export function codesAtFault(codes: CompanyDraft['codes']): CodeKey[] {
  const keys = Object.keys(DEFAULT_PAY_CODES) as CodeKey[];
  const fine: Company = { name: 'x', state: 'CA', pay: null };
  const alone = (key: CodeKey) => {
    // Five codes that pass, none of them the one being looked at.
    const spare = ['QA', 'QB', 'QC', 'QD', 'QE', 'QF'].filter((c) => c !== codes[key].trim().toUpperCase());
    return Object.fromEntries(keys.map((k) => [k, k === key ? codes[k] : spare.pop()!])) as unknown as CompanyDraft['codes'];
  };
  const notACode = keys.filter((key) => checkCompany({ ...fine, payCodes: alone(key) }));
  if (notACode.length) return notACode;
  const seen = new Map<string, CodeKey[]>();
  for (const key of keys) {
    const code = codes[key].trim().toUpperCase();
    seen.set(code, [...(seen.get(code) ?? []), key]);
  }
  return [...seen.values()].filter((same) => same.length > 1).flat();
}

/**
 * What is wrong with the company form, field by field, in the words of the
 * app's own checks (`checkCompany`, `checkPaySchedule`): each field is put to
 * the same check the whole company gets when it is saved, beside values that
 * are known to pass. Pay periods and earning codes are only checked while the
 * company keeps time, as only then does the form show them.
 */
export function companyProblems(draft: CompanyDraft): CompanyProblems {
  const fine: Company = { name: 'x', state: 'CA', pay: null };
  const schedule = draft.timeClock ? scheduleOf(draft) : null;
  const codes = codesOf(draft);
  const out: CompanyProblems = {
    name: checkCompany({ ...fine, name: draft.name }),
    state: checkCompany({ ...fine, state: draft.state }),
    mineId: draft.mineId.trim() ? checkCompany({ ...fine, mineId: draft.mineId.trim() }) : undefined,
    pay: schedule ? checkPaySchedule(schedule) : undefined,
    codes: draft.timeClock && !sameCodes(codes, DEFAULT_PAY_CODES) ? checkCompany({ ...fine, payCodes: codes }) : undefined,
  };
  if (out.pay) out.payField = payFieldAtFault(draft);
  if (out.codes) out.codeKeys = codesAtFault(codes);
  for (const key of Object.keys(out) as (keyof CompanyProblems)[]) if (!out[key]) delete out[key];
  return out;
}

export interface SiteSaid {
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  town?: string;
}

/** The clock-in site, for showing: its name, pin and radius, or null when there is none this page can read. */
export function readSite(raw: unknown): SiteSaid | null {
  if (!raw || typeof raw !== 'object') return null;
  const site = raw as { name?: unknown; center?: { lat?: unknown; lng?: unknown } | null; radiusM?: unknown; town?: { name?: unknown } | null };
  const { lat, lng } = site.center ?? {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (typeof site.radiusM !== 'number' || !Number.isFinite(site.radiusM)) return null;
  return {
    name: typeof site.name === 'string' ? site.name : '',
    lat,
    lng,
    radiusM: site.radiusM,
    ...(site.town && typeof site.town.name === 'string' && site.town.name ? { town: site.town.name } : null),
  };
}

/** What the company's own row on the server is called on the page: no supervisor knows it as a row. */
export const SIGN_IN_DETAILS = 'the company’s sign-in details (its name, state, time zone and pay period)';

/**
 * What to change on the company's own row on the server so that it says the
 * same as the settings where the two overlap: the name, the state and the pay
 * period. The time zone is the row's alone. Empty when nothing differs.
 */
export function companyRowPatch(company: Company, timezone: string, row: CompanyRow | null): Partial<Pick<CompanyRow, 'name' | 'state' | 'timezone' | 'pay_period'>> {
  const patch: Partial<Pick<CompanyRow, 'name' | 'state' | 'timezone' | 'pay_period'>> = {};
  if (!row || row.name !== company.name) patch.name = company.name;
  if (!row || row.state !== company.state) patch.state = company.state;
  if (timezone && (!row || row.timezone !== timezone)) patch.timezone = timezone;
  const pay: PaySchedule | null = company.pay ?? null;
  if (!row || stableJson(row.pay_period ?? null) !== stableJson(pay)) patch.pay_period = pay;
  return patch;
}
