import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { AREA_SHEETS, DEMO_MODE, ROSTER_OWNER } from '../config';
import { buildExam, examFindings, makeSheet, SAMPLE_AREA_SHEETS, withFix, withMrf, withSheets, type ExamDraft } from '../domain/areaExam';
import { cleanText, parsePersonName, sameName, titleCase, withOwner, type PersonName } from '../domain/roster';
import { MAX_RADIUS_M, MIN_RADIUS_M } from '../domain/site';
import { checklistFor, findItem, inspectionResult, isHazard, signedAnswers } from '../domain/templates';
import { CA_RULES, lunchEndAt, startedLunch } from '../domain/time';
import type {
  Account,
  AreaExam,
  AreaSheet,
  AuthProvider,
  DemoLocation,
  DeniedPunch,
  Employee,
  Equipment,
  EquipmentCategory,
  EquipmentStatus,
  GeoStamp,
  Inspection,
  InspectionAnswer,
  LeaveType,
  MealNote,
  Mrf,
  MrfItem,
  MrfPriority,
  OperatingLog,
  Punch,
  Role,
  Session,
  Settings,
  Shift,
  ShiftEdit,
} from '../domain/types';
import { safeStorage } from '../services/storage';
import { fmtTime, MIN, startOfDay } from '../util/format';
import { sha256, uid } from '../util/hash';
import { migratePersisted, STATE_VERSION } from './migrate';
import {
  buildDemoData,
  defaultSettings,
  DEMO_EMPLOYEE_ID,
  DEMO_SUPERVISOR_ID,
  emptyData,
  type SeedData,
} from './seed';

export type ToastTone = 'ok' | 'bo' | 'warn' | 'info';
export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

interface Data extends SeedData {
  session: Session | null;
  denied: DeniedPunch[];
  settings: Settings;
  seededAt: number | null;
}

export interface SignUpInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export interface InspectionDraft {
  equipmentId: string;
  startedAt: number;
  /** Equipment hours, or the odometer, at the start. */
  meter: number;
  answers: InspectionAnswer[];
  /** Gallons added, from the Fuel line. */
  fuelGal?: number;
  comments?: string;
}

export interface MrfInput {
  /** The fleet unit the request is about. Without one, `location` says where the problem is. */
  equipmentId?: string;
  location?: string;
  priority: MrfPriority;
  description: string;
  items?: MrfItem[];
  meter?: number;
  taggedOut: boolean;
  inspectionId?: string;
  /** The exam, and the line on it, that the request is for. */
  examId?: string;
  findingKey?: string;
}

export interface CompleteMrfInput {
  /** What was done. */
  remarks: string;
  /** Hundredths of an hour. */
  timeSpent?: number;
  /**
   * Who did the work: the name that goes on "Completed by". Left out, it is the
   * person signed in. A supervisor closing a request out for the person it is
   * assigned to can name that person instead; the history still shows who entered it.
   */
  completedBy?: string;
}

export interface EndUseInput {
  endMeter: number;
  fuelGal?: number;
  notes?: string;
  parkedSafely: boolean;
}

export interface LeaveInput {
  employeeId: string;
  /** Any moment on the day the hours are for. */
  day: number;
  type: LeaveType;
  /** Hundredths of an hour. */
  hours: number;
  note?: string;
}

export interface ShiftTimesPatch {
  clockIn?: number;
  clockOut?: number;
  lunchStart?: number;
  lunchEnd?: number;
}

interface Actions {
  hydrated: boolean;
  toast: Toast | null;
  setHydrated: () => void;
  showToast: (message: string, tone?: ToastTone) => void;
  clearToast: () => void;

  /**
   * Load the starting data on first run, and make sure the build's owner is on
   * the roster and the build's own area sheets are there.
   */
  ensureSeeded: (owner?: PersonName | null, sheets?: AreaSheet[]) => void;
  resetDemo: (owner?: PersonName | null, sheets?: AreaSheet[]) => void;

  signUp: (input: SignUpInput) => Result;
  signIn: (email: string, password: string) => Result;
  signInWithProvider: (provider: AuthProvider, firstName: string, lastName: string) => Result;
  signInDemo: (role: Role) => Result;
  signOut: () => void;

  clockIn: (geo: GeoStamp) => Result<{ shift: Shift }>;
  startLunch: (geo?: GeoStamp) => Result<{ shift: Shift }>;
  toggleBreak: () => Result<{ shift: Shift }>;
  clockOut: (geo?: GeoStamp, mealNote?: MealNote) => Result<{ shift: Shift }>;
  logDenied: (action: DeniedPunch['action'], reason: DeniedPunch['reason'], geo?: GeoStamp) => void;
  editShiftTimes: (shiftId: string, patch: ShiftTimesPatch, reason: string) => Result;
  demoRewindShift: (minutes: number) => Shift | undefined;

  submitInspection: (draft: InspectionDraft) => Result<{ inspection: Inspection }>;
  decideAfterDefect: (inspectionId: string, decision: 'operate' | 'parked') => void;
  endUse: (logId: string, input: EndUseInput) => Result;
  createMrf: (input: MrfInput) => Result<{ mrf: Mrf }>;
  /** Assigned to: a supervisor names who does the work. */
  assignMrf: (mrfId: string, employeeId: string) => Result;
  /** Starting and completing are for a supervisor or the person the request is assigned to. */
  startMrf: (mrfId: string, note?: string) => Result;
  completeMrf: (mrfId: string, input: CompleteMrfInput) => Result;

  submitExam: (draft: ExamDraft) => Result<{ exam: AreaExam }>;
  /** Add the date a condition was corrected to the exam it was found on. */
  markFixed: (examId: string, findingKey: string, note?: string) => Result;
  addAreaSheet: (title: string, rowsText: string) => Result<{ sheet: AreaSheet }>;
  updateAreaSheet: (sheetId: string, title: string, rowsText: string) => Result;
  setAreaSheetActive: (sheetId: string, active: boolean) => void;

  addEmployee: (firstName: string, lastName: string, role?: Role, title?: string) => Result;
  addEmployeesBulk: (text: string) => { added: number; skipped: number };
  setEmployeeActive: (employeeId: string, active: boolean) => void;
  setEmployeeRole: (employeeId: string, role: Role) => void;
  addEquipment: (input: { unit: string; category: EquipmentCategory; make: string; model: string; meter: number }) => Result;
  removeEquipment: (equipmentId: string) => void;

  setRadius: (radiusM: number) => void;
  setDemoLocation: (mode: DemoLocation) => void;
  setLunchReminders: (on: boolean) => void;
  setAllowSectionAllOk: (on: boolean) => void;

  addLeave: (input: LeaveInput) => Result;
  removeLeave: (leaveId: string) => void;
  /** The signed-in person's own hourly rate for their pay estimate. `null` clears it. */
  setMyRate: (cents: number | null) => Result;
}

export type Store = Data & Actions;

const clean = cleanText;
const hashPassword = (password: string, salt: string) => sha256(`${salt}:${password}`);

/** The shift a person is on right now. A shift left open for 16+ hours no longer counts. */
export function openShiftOf(shifts: Shift[], employeeId: string, now: number): Shift | undefined {
  for (let i = shifts.length - 1; i >= 0; i--) {
    const s = shifts[i];
    if (s.employeeId === employeeId && !s.clockOut && now - s.clockIn.at <= CA_RULES.missingOutAfterMs) return s;
  }
  return undefined;
}

/** An older shift that was never clocked out. */
export function staleShiftOf(shifts: Shift[], employeeId: string, now: number): Shift | undefined {
  return shifts.find(
    (s) => s.employeeId === employeeId && !s.clockOut && now - s.clockIn.at > CA_RULES.missingOutAfterMs,
  );
}

/** Units that are checked out right now, keyed by equipment. */
export function openLogs(opLogs: OperatingLog[]): Map<string, OperatingLog> {
  const map = new Map<string, OperatingLog>();
  for (const log of opLogs) if (!log.endAt) map.set(log.equipmentId, log);
  return map;
}

function statusFromMrfs(equipmentId: string, mrfs: Mrf[]): EquipmentStatus {
  const open = mrfs.filter((m) => m.equipmentId === equipmentId && m.status !== 'completed');
  if (open.some((m) => m.taggedOut)) return 'out_of_service';
  return open.length > 0 ? 'defect' : 'ready';
}

const initialData = (): Data => ({
  ...emptyData(),
  session: null,
  denied: [],
  settings: defaultSettings(DEMO_MODE),
  seededAt: null,
});

export const useStore = create<Store>()(
  persist(
    (set, get) => {
      /** Replace the signed-in employee's open shift with an updated copy. */
      const updateOpenShift = (change: (shift: Shift, now: number) => Shift | string): Result<{ shift: Shift }> => {
        const { session, shifts } = get();
        if (!session) return { ok: false, error: 'You are signed out.' };
        const now = Date.now();
        const current = openShiftOf(shifts, session.employeeId, now);
        if (!current) return { ok: false, error: 'You are not clocked in.' };
        const next = change(current, now);
        if (typeof next === 'string') return { ok: false, error: next };
        set({ shifts: shifts.map((s) => (s.id === current.id ? next : s)) });
        return { ok: true, shift: next };
      };

      const startSession = (account: Account) =>
        set({ session: { accountId: account.id, employeeId: account.employeeId } });

      const rosterMatch = (first: string, last: string) =>
        get().employees.find((e) => e.active && sameName(e, first, last));

      const notOnRoster = (first: string, last: string) =>
        `We couldn't find "${clean(first)} ${clean(last)}" on the US Mine roster. Check the spelling, or see your supervisor to be added.`;

      const signedOut = { ok: false as const, error: 'You are signed out.' };
      const isSupervisor = () => {
        const { session, employees } = get();
        return employees.find((e) => e.id === session?.employeeId)?.role === 'supervisor';
      };
      /** A request is worked by a supervisor or by the person it is assigned to. */
      const canWork = (mrf: Mrf) => isSupervisor() || (!!mrf.assignedTo && mrf.assignedTo === get().session?.employeeId);
      const notYours = { ok: false as const, error: 'Only a supervisor, or the person it is assigned to, can work this request.' };
      /** The sheets a first start is made with: the build's own, or the samples. */
      const startingSheets = (named: AreaSheet[]) => (named.length ? named : SAMPLE_AREA_SHEETS);

      return {
        ...initialData(),
        hydrated: false,
        toast: null,
        setHydrated: () => set({ hydrated: true }),
        showToast: (message, tone = 'ok') => set({ toast: { id: Date.now(), message, tone } }),
        clearToast: () => set({ toast: null }),

        ensureSeeded: (owner = ROSTER_OWNER, sheets = AREA_SHEETS) => {
          if (get().seededAt == null) {
            const now = Date.now();
            set({ ...(DEMO_MODE ? buildDemoData(now, startingSheets(sheets)) : emptyData()), seededAt: now });
          }
          // The person this build was made for is always on the roster, and the build's
          // own area sheets are always there, including on a phone whose data was saved
          // before they were named.
          const { employees, areaSheets } = get();
          const roster = withOwner(employees, owner);
          const named = withSheets(areaSheets, sheets);
          if (roster !== employees || named !== areaSheets) set({ employees: roster, areaSheets: named });
        },
        resetDemo: (owner = ROSTER_OWNER, sheets = AREA_SHEETS) => {
          const now = Date.now();
          const data = buildDemoData(now, startingSheets(sheets));
          set({ ...initialData(), ...data, employees: withOwner(data.employees, owner), seededAt: now });
        },

        // ---- Accounts ----------------------------------------------------------------
        signUp: ({ firstName, lastName, email, password }) => {
          if (!clean(firstName) || !clean(lastName)) return { ok: false, error: 'Enter your first and last name.' };
          const address = email.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { ok: false, error: 'Enter a valid email address.' };
          if (password.length < 8) return { ok: false, error: 'Use a password of at least 8 characters.' };
          const employee = rosterMatch(firstName, lastName);
          if (!employee) return { ok: false, error: notOnRoster(firstName, lastName) };
          const { accounts } = get();
          if (accounts.some((a) => a.email === address)) {
            return { ok: false, error: 'That email already has an account. Sign in instead.' };
          }
          if (accounts.some((a) => a.employeeId === employee.id && a.passwordHash)) {
            return { ok: false, error: `${employee.firstName} ${employee.lastName} already has an account. Sign in instead.` };
          }
          const salt = uid();
          const account: Account = {
            id: uid('acct_'),
            employeeId: employee.id,
            email: address,
            provider: 'password',
            salt,
            passwordHash: hashPassword(password, salt),
            createdAt: Date.now(),
          };
          set({ accounts: [...accounts.filter((a) => a.employeeId !== employee.id), account] });
          startSession(account);
          return { ok: true };
        },

        signIn: (email, password) => {
          const address = email.trim().toLowerCase();
          const { accounts, employees } = get();
          const account = accounts.find((a) => a.email === address && a.passwordHash && a.salt);
          const wrong: Result = { ok: false, error: 'That email and password do not match an account.' };
          if (!account || account.passwordHash !== hashPassword(password, account.salt ?? '')) return wrong;
          if (!employees.find((e) => e.id === account.employeeId)?.active) {
            return { ok: false, error: 'This account is no longer on the active roster. See your supervisor.' };
          }
          startSession(account);
          return { ok: true };
        },

        signInWithProvider: (provider, firstName, lastName) => {
          if (!clean(firstName) || !clean(lastName)) return { ok: false, error: 'Enter your first and last name.' };
          const employee = rosterMatch(firstName, lastName);
          if (!employee) return { ok: false, error: notOnRoster(firstName, lastName) };
          const { accounts } = get();
          let account = accounts.find((a) => a.employeeId === employee.id);
          if (!account) {
            account = {
              id: uid('acct_'),
              employeeId: employee.id,
              email: `${employee.firstName}.${employee.lastName}@example.com`.toLowerCase(),
              provider,
              createdAt: Date.now(),
            };
            set({ accounts: [...accounts, account] });
          }
          startSession(account);
          return { ok: true };
        },

        signInDemo: (role) => {
          const employeeId = role === 'supervisor' ? DEMO_SUPERVISOR_ID : DEMO_EMPLOYEE_ID;
          const account = get().accounts.find((a) => a.employeeId === employeeId);
          if (!account) return { ok: false, error: 'The demo crew is not loaded. Reset the demo data and try again.' };
          startSession(account);
          return { ok: true };
        },

        signOut: () => set({ session: null }),

        // ---- Time clock ----------------------------------------------------------------
        clockIn: (geo) => {
          const { session, shifts } = get();
          if (!session) return { ok: false, error: 'You are signed out.' };
          const now = Date.now();
          if (openShiftOf(shifts, session.employeeId, now)) return { ok: false, error: 'You are already clocked in.' };
          const shift: Shift = {
            id: uid('sh_'),
            employeeId: session.employeeId,
            clockIn: { at: now, geo },
            lunches: [],
            breaks: [],
          };
          set({ shifts: [...shifts, shift] });
          return { ok: true, shift };
        },

        // One tap starts lunch. It ends by itself 30 minutes later, so there is no action to end it.
        startLunch: (geo) =>
          updateOpenShift((shift, now) => {
            const last = shift.lunches[shift.lunches.length - 1];
            if (last && now < lunchEndAt(last)) return 'You are already at lunch.';
            const breaks = shift.breaks.map((b) => (b.end ? b : { ...b, end: now }));
            return { ...shift, breaks, lunches: [...shift.lunches, startedLunch({ at: now, geo })] };
          }),

        toggleBreak: () =>
          updateOpenShift((shift, now) => {
            const last = shift.breaks[shift.breaks.length - 1];
            if (last && !last.end) {
              return { ...shift, breaks: [...shift.breaks.slice(0, -1), { ...last, end: now }] };
            }
            return { ...shift, breaks: [...shift.breaks, { start: now }] };
          }),

        clockOut: (geo, mealNote) =>
          updateOpenShift((shift, now) => {
            const last = shift.lunches[shift.lunches.length - 1];
            if (last && now < lunchEndAt(last)) {
              return `You are at lunch until ${fmtTime(lunchEndAt(last))}. Clock out after that.`;
            }
            const breaks = shift.breaks.map((b) => (b.end ? b : { ...b, end: now }));
            return { ...shift, breaks, clockOut: { at: now, geo }, mealNote: mealNote ?? shift.mealNote };
          }),

        logDenied: (action, reason, geo) => {
          const { session, denied } = get();
          if (!session) return;
          const entry: DeniedPunch = { id: uid('dn_'), employeeId: session.employeeId, at: Date.now(), action, reason, geo };
          set({ denied: [...denied.slice(-199), entry] });
        },

        editShiftTimes: (shiftId, patch, reason) => {
          const { session, shifts } = get();
          if (!session) return { ok: false, error: 'You are signed out.' };
          if (!clean(reason)) return { ok: false, error: 'Add a reason for the change. It is kept with the record.' };
          const shift = shifts.find((s) => s.id === shiftId);
          if (!shift) return { ok: false, error: 'That shift no longer exists.' };

          const firstLunch = shift.lunches[0];
          const next = {
            clockIn: patch.clockIn ?? shift.clockIn.at,
            clockOut: patch.clockOut ?? shift.clockOut?.at,
            lunchStart: patch.lunchStart ?? firstLunch?.start.at,
            lunchEnd: patch.lunchEnd ?? firstLunch?.end?.at,
          };
          if (next.clockOut != null && next.clockOut <= next.clockIn) {
            return { ok: false, error: 'Clock-out has to be after clock-in.' };
          }
          if ((next.lunchStart == null) !== (next.lunchEnd == null)) {
            return { ok: false, error: 'Set both the start and the end of the lunch.' };
          }
          if (next.lunchStart != null && next.lunchEnd != null) {
            if (next.lunchEnd <= next.lunchStart) return { ok: false, error: 'Lunch has to end after it starts.' };
            if (next.lunchStart < next.clockIn || (next.clockOut != null && next.lunchEnd > next.clockOut)) {
              return { ok: false, error: 'Lunch has to fall inside the shift.' };
            }
          }

          const at = Date.now();
          const edits: ShiftEdit[] = [...(shift.edits ?? [])];
          const record = (field: ShiftEdit['field'], from: number | undefined, to: number | undefined) => {
            if (to != null && from !== to) edits.push({ at, byEmployeeId: session.employeeId, field, from, to, reason: clean(reason) });
          };
          record('clockIn', shift.clockIn.at, patch.clockIn);
          record('clockOut', shift.clockOut?.at, patch.clockOut);
          record('lunchStart', firstLunch?.start.at, patch.lunchStart);
          record('lunchEnd', firstLunch?.end?.at, patch.lunchEnd);
          if (edits.length === (shift.edits?.length ?? 0)) return { ok: false, error: 'Nothing was changed.' };

          const manual = (time: number, existing?: Punch): Punch =>
            existing && existing.at === time ? existing : { at: time };
          const lunches = [...shift.lunches];
          if (next.lunchStart != null && next.lunchEnd != null) {
            const start = manual(next.lunchStart, firstLunch?.start);
            const end: Punch = manual(next.lunchEnd, firstLunch?.end);
            // An end is only "automatic" while it is still the 30 minutes the app set.
            const stillAutomatic = end.auto === true && end.at - start.at === CA_RULES.mealMinMs;
            lunches[0] = { start, end: stillAutomatic ? end : { at: end.at, geo: end.geo } };
          }
          const updated: Shift = {
            ...shift,
            clockIn: manual(next.clockIn, shift.clockIn),
            clockOut: next.clockOut != null ? manual(next.clockOut, shift.clockOut) : undefined,
            lunches,
            edits,
          };
          set({ shifts: shifts.map((s) => (s.id === shiftId ? updated : s)) });
          return { ok: true };
        },

        demoRewindShift: (minutes) => {
          const { session, shifts } = get();
          if (!session) return undefined;
          const current = openShiftOf(shifts, session.employeeId, Date.now());
          if (!current) return undefined;
          const delta = minutes * MIN;
          const back = <T extends { at: number }>(p: T): T => ({ ...p, at: p.at - delta });
          const moved: Shift = {
            ...current,
            clockIn: back(current.clockIn),
            lunches: current.lunches.map((l) => ({ start: back(l.start), end: l.end ? back(l.end) : undefined })),
            breaks: current.breaks.map((b) => ({ start: b.start - delta, end: b.end ? b.end - delta : undefined })),
          };
          set({ shifts: shifts.map((s) => (s.id === current.id ? moved : s)) });
          return moved;
        },

        // ---- Equipment -----------------------------------------------------------------
        submitInspection: (draft) => {
          const { session, equipment, inspections, opLogs } = get();
          if (!session) return { ok: false, error: 'You are signed out.' };
          const unit = equipment.find((e) => e.id === draft.equipmentId);
          if (!unit) return { ok: false, error: 'That unit is no longer in the fleet list.' };
          // A card is signed once. A second tap on the same card gets the checklist already on record.
          const signed = inspections.find(
            (i) => i.equipmentId === unit.id && i.employeeId === session.employeeId && i.startedAt === draft.startedAt,
          );
          if (signed) return { ok: true, inspection: signed };
          const template = checklistFor(unit.category);
          // Nothing is signed with a line of the card left blank, or a Bad Order that does not say what is wrong.
          const { answers, blank } = signedAnswers(template, draft.answers);
          if (blank > 0) {
            return { ok: false, error: `Mark every line OK, BO or N/A. ${blank} ${blank === 1 ? 'is' : 'are'} still blank.` };
          }
          if (answers.some((a) => a.answer === 'bo' && !a.note)) {
            return { ok: false, error: 'Say what is wrong on each Bad Order.' };
          }
          const result = inspectionResult(template, answers);
          const now = Date.now();
          const inspection: Inspection = {
            id: uid('insp_'),
            equipmentId: unit.id,
            employeeId: session.employeeId,
            templateId: template.id,
            templateVersion: template.version,
            startedAt: draft.startedAt,
            submittedAt: now,
            meter: draft.meter,
            answers,
            result,
            fuelGal: draft.fuelGal != null && draft.fuelGal > 0 ? draft.fuelGal : undefined,
            comments: draft.comments && clean(draft.comments) ? clean(draft.comments) : undefined,
          };
          let status = unit.status;
          if (result === 'bad_order') status = 'out_of_service';
          else if (result === 'defect' && status === 'ready') status = 'defect';

          // A new operator taking the unit ends the last operator's use of it.
          let logs = opLogs.map((log) =>
            log.equipmentId === unit.id && !log.endAt ? { ...log, endAt: now, endMeter: draft.meter } : log,
          );
          if (result === 'pass') {
            logs = [...logs, {
              id: uid('op_'), equipmentId: unit.id, employeeId: session.employeeId, inspectionId: inspection.id,
              startAt: now, startMeter: draft.meter,
            }];
          }
          set({
            inspections: [...inspections, inspection],
            opLogs: logs,
            equipment: equipment.map((e) => (e.id === unit.id ? { ...e, status, meter: Math.max(e.meter, draft.meter) } : e)),
          });
          return { ok: true, inspection };
        },

        decideAfterDefect: (inspectionId, decision) => {
          const { session, inspections, opLogs } = get();
          const inspection = inspections.find((i) => i.id === inspectionId);
          if (!session || !inspection || inspection.decision) return;
          const now = Date.now();
          set({
            inspections: inspections.map((i) => (i.id === inspectionId ? { ...i, decision } : i)),
            opLogs:
              decision === 'operate'
                ? [...opLogs, {
                    id: uid('op_'), equipmentId: inspection.equipmentId, employeeId: session.employeeId,
                    inspectionId, startAt: now, startMeter: inspection.meter,
                  }]
                : opLogs,
          });
        },

        endUse: (logId, input) => {
          const { opLogs, equipment } = get();
          const log = opLogs.find((l) => l.id === logId);
          if (!log || log.endAt) return { ok: false, error: 'That unit has already been checked back in.' };
          if (!(input.endMeter >= log.startMeter)) {
            return { ok: false, error: 'The ending meter cannot be lower than the starting meter.' };
          }
          set({
            opLogs: opLogs.map((l) => (l.id === logId ? { ...l, ...input, endAt: Date.now() } : l)),
            equipment: equipment.map((e) =>
              e.id === log.equipmentId ? { ...e, meter: Math.max(e.meter, input.endMeter) } : e,
            ),
          });
          return { ok: true };
        },

        // ---- Maintenance requests ----------------------------------------------------------
        createMrf: (input) => {
          const { session, mrfs, mrfSeq, equipment, inspections, exams } = get();
          if (!session) return signedOut;
          if (!clean(input.description)) return { ok: false, error: 'Describe the problem so maintenance knows what to look for.' };
          const location = input.location ? clean(input.location) : '';
          if (!input.equipmentId && !location) return { ok: false, error: 'Say where the problem is, or pick the unit it is on.' };
          const description = clean(input.description);

          // A request only points at what is really there: a unit in the fleet, a checklist made
          // on that unit, a Bad Order on an exam that is still open. And one request for each.
          if (input.equipmentId && !equipment.some((e) => e.id === input.equipmentId)) {
            return { ok: false, error: 'That unit is no longer in the fleet list.' };
          }
          if (input.inspectionId) {
            const checklist = inspections.find((i) => i.id === input.inspectionId);
            if (!checklist || checklist.equipmentId !== input.equipmentId) {
              return { ok: false, error: 'That checklist is not on record for this unit.' };
            }
            const sent = mrfs.find((m) => m.id === checklist.mrfId);
            if (sent) return { ok: false, error: `Maintenance request #${sent.number} is already in for this checklist.` };
          }
          if (input.examId || input.findingKey) {
            const exam = exams.find((x) => x.id === input.examId);
            const finding = exam ? examFindings(exam).find((f) => f.key === input.findingKey) : undefined;
            if (!finding) return { ok: false, error: 'That line is not a Bad Order on this exam.' };
            if (finding.fixed) return { ok: false, error: 'The date it was fixed is already on the record.' };
            const sent = mrfs.find((m) => m.id === finding.mrfId);
            if (sent) return { ok: false, error: `Maintenance request #${sent.number} is already in for this.` };
          }
          // The same words about the same place from the same person, while the first is still
          // open, is a second tap on the button and not a second problem.
          const twin = mrfs.find(
            (m) =>
              m.status !== 'completed' &&
              m.requestedBy === session.employeeId &&
              m.equipmentId === input.equipmentId &&
              (m.location ?? '') === location &&
              m.description === description,
          );
          if (twin) return { ok: false, error: `That request is already in: #${twin.number}.` };

          const now = Date.now();
          const mrf: Mrf = {
            id: uid('mrf_'),
            number: mrfSeq,
            requestedBy: session.employeeId,
            createdAt: now,
            location: location || undefined,
            equipmentId: input.equipmentId,
            description,
            priority: input.priority,
            items: input.items ?? [],
            meter: input.meter,
            taggedOut: input.taggedOut,
            inspectionId: input.inspectionId,
            examId: input.examId,
            findingKey: input.findingKey,
            status: 'open',
            history: [{ at: now, by: session.employeeId, status: 'open' }],
          };
          const all = [...mrfs, mrf];
          const { examId, findingKey } = input;
          set({
            mrfs: all,
            mrfSeq: mrfSeq + 1,
            equipment: equipment.map((e) =>
              e.id === input.equipmentId ? { ...e, status: statusFromMrfs(e.id, all) } : e,
            ),
            inspections: inspections.map((i) => (i.id === input.inspectionId ? { ...i, mrfId: mrf.id } : i)),
            // The line on the exam shows the request it was sent on.
            exams: examId && findingKey ? exams.map((x) => (x.id === examId ? withMrf(x, findingKey, mrf.id) : x)) : exams,
          });
          return { ok: true, mrf };
        },

        assignMrf: (mrfId, employeeId) => {
          const { session, mrfs, employees } = get();
          if (!session) return signedOut;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can assign a request.' };
          const mrf = mrfs.find((m) => m.id === mrfId);
          if (!mrf) return { ok: false, error: 'That request no longer exists.' };
          if (mrf.status === 'completed') return { ok: false, error: 'That request is already completed.' };
          if (!employees.some((e) => e.id === employeeId && e.active)) return { ok: false, error: 'Pick someone on the roster.' };
          const entry = { at: Date.now(), by: session.employeeId, status: mrf.status, assignedTo: employeeId };
          set({ mrfs: mrfs.map((m) => (m.id === mrfId ? { ...m, assignedTo: employeeId, history: [...m.history, entry] } : m)) });
          return { ok: true };
        },

        startMrf: (mrfId, note) => {
          const { session, mrfs } = get();
          if (!session) return signedOut;
          const mrf = mrfs.find((m) => m.id === mrfId);
          if (!mrf) return { ok: false, error: 'That request no longer exists.' };
          if (!canWork(mrf)) return notYours;
          if (mrf.status !== 'open') return { ok: false, error: 'Work has already started on this request.' };
          const entry = { at: Date.now(), by: session.employeeId, status: 'in_progress' as const, note: note && clean(note) ? clean(note) : undefined };
          set({ mrfs: mrfs.map((m) => (m.id === mrfId ? { ...m, status: 'in_progress', history: [...m.history, entry] } : m)) });
          return { ok: true };
        },

        completeMrf: (mrfId, { remarks, timeSpent, completedBy: didTheWork }) => {
          const { session, mrfs, equipment, exams } = get();
          if (!session) return signedOut;
          const mrf = mrfs.find((m) => m.id === mrfId);
          if (!mrf) return { ok: false, error: 'That request no longer exists.' };
          if (!canWork(mrf)) return notYours;
          if (mrf.status === 'completed') return { ok: false, error: 'This request is already completed.' };
          // "Completed by" is the person signed in. A supervisor closing it out for the person
          // it is assigned to can put that person's name on the work instead, and nobody else's.
          const completedBy = didTheWork ?? session.employeeId;
          if (completedBy !== session.employeeId && !(isSupervisor() && completedBy === mrf.assignedTo)) {
            return { ok: false, error: 'Completed by is you, or the person the request is assigned to.' };
          }
          const done = clean(remarks);
          if (!done) return { ok: false, error: 'Say what was done. The remarks are the repair record.' };
          if (timeSpent != null && !(Number.isFinite(timeSpent) && timeSpent > 0 && timeSpent <= 100_000)) {
            return { ok: false, error: 'Enter the time spent in hours, like 1.5.' };
          }
          const now = Date.now();
          const all = mrfs.map((m): Mrf =>
            m.id === mrfId
              ? {
                  ...m,
                  status: 'completed',
                  completedAt: now,
                  completedBy,
                  timeSpent: timeSpent != null ? Math.round(timeSpent) : undefined,
                  remarks: done,
                  history: [...m.history, { at: now, by: session.employeeId, status: 'completed', note: done }],
                }
              : m,
          );
          const { examId, findingKey } = mrf;
          set({
            mrfs: all,
            equipment: equipment.map((e) => (e.id === mrf.equipmentId ? { ...e, status: statusFromMrfs(e.id, all) } : e)),
            // The repair is the corrective action: its date goes on the exam the condition was found on.
            exams:
              examId && findingKey
                ? exams.map((x) => (x.id === examId ? withFix(x, findingKey, { at: now, by: completedBy, note: done }) : x))
                : exams,
          });
          return { ok: true };
        },

        // ---- Pre shift exams ------------------------------------------------------------------
        submitExam: (draft) => {
          const { session, areaSheets, exams } = get();
          if (!session) return signedOut;
          // An exam is signed once. A second tap on the same sheet gets the exam already on record.
          const signed = exams.find(
            (x) => x.sheetId === draft.sheetId && x.employeeId === session.employeeId && x.startedAt === draft.startedAt,
          );
          if (signed) return { ok: true, exam: signed };
          const sheet = areaSheets.find((s) => s.id === draft.sheetId && s.active);
          if (!sheet) return { ok: false, error: 'That area sheet is no longer on the list.' };
          const built = buildExam(sheet, draft, { id: uid('exam_'), employeeId: session.employeeId, submittedAt: Date.now() });
          if (!built.ok) return built;
          set({ exams: [...exams, built.exam] });
          return built;
        },

        markFixed: (examId, findingKey, note) => {
          const { session, exams } = get();
          if (!session) return signedOut;
          const exam = exams.find((x) => x.id === examId);
          const finding = exam ? examFindings(exam).find((f) => f.key === findingKey) : undefined;
          if (!exam || !finding) return { ok: false, error: 'That line is not a Bad Order on this exam.' };
          if (exam.employeeId !== session.employeeId && !isSupervisor()) {
            return { ok: false, error: 'Only the person who made the exam, or a supervisor, can record the fix.' };
          }
          if (finding.fixed) return { ok: false, error: 'The date it was fixed is already on the record.' };
          const fix = { at: Date.now(), by: session.employeeId, ...(note && clean(note) ? { note: clean(note) } : null) };
          set({ exams: exams.map((x) => (x.id === examId ? withFix(x, findingKey, fix) : x)) });
          return { ok: true };
        },

        addAreaSheet: (title, rowsText) => {
          const { areaSheets } = get();
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the area sheets.' };
          const sheet = makeSheet(title, rowsText, areaSheets.map((s) => s.id));
          if (!sheet) return { ok: false, error: 'Give the sheet the name of its work area.' };
          const same = areaSheets.find((s) => s.title.toLowerCase() === sheet.title.toLowerCase());
          if (same) return { ok: false, error: `There is already a sheet called ${same.title}.` };
          set({ areaSheets: [...areaSheets, sheet] });
          return { ok: true, sheet };
        },

        updateAreaSheet: (sheetId, title, rowsText) => {
          const { areaSheets } = get();
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the area sheets.' };
          const current = areaSheets.find((s) => s.id === sheetId);
          if (!current) return { ok: false, error: 'That area sheet is no longer on the list.' };
          const next = makeSheet(title, rowsText);
          if (!next) return { ok: false, error: 'Give the sheet the name of its work area.' };
          const same = areaSheets.find((s) => s.id !== sheetId && s.title.toLowerCase() === next.title.toLowerCase());
          if (same) return { ok: false, error: `There is already a sheet called ${same.title}.` };
          // Exams already signed keep the lines they were made on.
          set({ areaSheets: areaSheets.map((s) => (s.id === sheetId ? { ...s, title: next.title, rows: next.rows } : s)) });
          return { ok: true };
        },

        setAreaSheetActive: (sheetId, active) => {
          if (!isSupervisor()) return;
          set({ areaSheets: get().areaSheets.map((s) => (s.id === sheetId ? { ...s, active } : s)) });
        },

        // ---- Roster and fleet ------------------------------------------------------------
        addEmployee: (firstName, lastName, role = 'employee', title) => {
          const first = titleCase(firstName);
          const last = titleCase(lastName);
          if (!first || !last) return { ok: false, error: 'Enter a first and last name.' };
          const { employees } = get();
          const existing = employees.find((e) => sameName(e, first, last));
          if (existing?.active) return { ok: false, error: `${first} ${last} is already on the roster.` };
          if (existing) {
            set({ employees: employees.map((e) => (e.id === existing.id ? { ...e, active: true, role } : e)) });
            return { ok: true };
          }
          const employee: Employee = { id: uid('emp_'), firstName: first, lastName: last, role, title: title ? clean(title) : undefined, active: true };
          set({ employees: [...employees, employee] });
          return { ok: true };
        },

        addEmployeesBulk: (text) => {
          let added = 0;
          let skipped = 0;
          for (const raw of text.split(/[\n;]+/)) {
            const line = clean(raw.replace(/^\d+[.)]\s*/, ''));
            if (!line) continue;
            // "Last, First" is read as well as "First Last".
            const name = parsePersonName(line);
            const result = name ? get().addEmployee(name.firstName, name.lastName) : undefined;
            if (result?.ok) added += 1;
            else skipped += 1;
          }
          return { added, skipped };
        },

        setEmployeeActive: (employeeId, active) =>
          set({ employees: get().employees.map((e) => (e.id === employeeId ? { ...e, active } : e)) }),

        setEmployeeRole: (employeeId, role) =>
          set({ employees: get().employees.map((e) => (e.id === employeeId ? { ...e, role } : e)) }),

        addEquipment: ({ unit, category, make, model, meter }) => {
          const name = clean(unit).toUpperCase();
          if (!name) return { ok: false, error: 'Enter a unit number.' };
          const { equipment } = get();
          if (equipment.some((e) => e.unit.toUpperCase() === name)) return { ok: false, error: `Unit ${name} is already in the fleet.` };
          const item: Equipment = {
            id: uid('eq_'), unit: name, category, make: clean(make), model: clean(model),
            status: 'ready', meter: Number.isFinite(meter) ? meter : 0,
            meterUnit: category === 'light_vehicle' ? 'mi' : 'hrs',
          };
          set({ equipment: [...equipment, item] });
          return { ok: true };
        },

        removeEquipment: (equipmentId) =>
          set({ equipment: get().equipment.filter((e) => e.id !== equipmentId) }),

        // ---- Settings ---------------------------------------------------------------------
        setRadius: (radiusM) => {
          const { settings } = get();
          const clamped = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(radiusM / 50) * 50));
          set({ settings: { ...settings, site: { ...settings.site, radiusM: clamped } } });
        },
        setDemoLocation: (demoLocation) => set({ settings: { ...get().settings, demoLocation } }),
        setLunchReminders: (lunchReminders) => set({ settings: { ...get().settings, lunchReminders } }),
        setAllowSectionAllOk: (allowSectionAllOk) => set({ settings: { ...get().settings, allowSectionAllOk } }),

        // ---- Paid leave and the pay estimate ----------------------------------------------
        addLeave: ({ employeeId, day, type, hours, note }) => {
          const { session, employees, leave } = get();
          if (!session) return { ok: false, error: 'You are signed out.' };
          if (employees.find((e) => e.id === session.employeeId)?.role !== 'supervisor') {
            return { ok: false, error: 'Only a supervisor can record paid leave.' };
          }
          if (!employees.some((e) => e.id === employeeId)) return { ok: false, error: 'That person is not on the roster.' };
          if (!Number.isFinite(hours) || hours <= 0 || hours > 2400) {
            return { ok: false, error: 'Enter the hours for that day, between 0.25 and 24.' };
          }
          set({
            leave: [...leave, {
              id: uid('lv_'),
              employeeId,
              day: startOfDay(day),
              type,
              hours: Math.round(hours),
              note: note && clean(note) ? clean(note) : undefined,
              enteredBy: session.employeeId,
              at: Date.now(),
            }],
          });
          return { ok: true };
        },

        removeLeave: (leaveId) => {
          const { session, employees, leave } = get();
          // The same rule as adding it: paid leave is a supervisor's entry to make or undo.
          if (employees.find((e) => e.id === session?.employeeId)?.role !== 'supervisor') return;
          set({ leave: leave.filter((entry) => entry.id !== leaveId) });
        },

        setMyRate: (cents) => {
          const { session, payRates } = get();
          if (!session) return { ok: false, error: 'You are signed out.' };
          const next = { ...payRates };
          if (cents === null) {
            delete next[session.employeeId];
          } else {
            if (!Number.isFinite(cents) || cents < 1 || cents > 100_000) {
              return { ok: false, error: 'Enter your hourly rate in dollars, like 24.00.' };
            }
            next[session.employeeId] = Math.round(cents);
          }
          set({ payRates: next });
          return { ok: true };
        },
      };
    },
    {
      name: 'us-mine-crew',
      version: STATE_VERSION,
      migrate: (saved, fromVersion) => migratePersisted(saved, fromVersion, DEMO_MODE) as unknown as Store,
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ session, employees, accounts, shifts, leave, denied, equipment, inspections, opLogs, areaSheets, exams, mrfs, mrfSeq, payRates, settings, seededAt }) => ({
        session, employees, accounts, shifts, leave, denied, equipment, inspections, opLogs, areaSheets, exams, mrfs, mrfSeq, payRates, settings, seededAt,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);

// ---- Lookups used across screens ---------------------------------------------------------

export function useMe(): Employee | undefined {
  return useStore((s) => s.employees.find((e) => e.id === s.session?.employeeId));
}

export function employeeName(employees: Employee[], id: string | undefined): string {
  const e = employees.find((x) => x.id === id);
  return e ? `${e.firstName} ${e.lastName}` : 'Unknown';
}

/** Lines for a maintenance request, taken from the Bad Orders on an equipment checklist. */
export function mrfItemsFromInspection(inspection: Inspection, equipment: Equipment): MrfItem[] {
  const checklist = checklistFor(equipment.category);
  return inspection.answers
    .filter((a) => a.answer === 'bo')
    .map((a) => {
      const item = findItem(checklist, a.itemId);
      return { label: item?.label ?? a.itemId, note: a.note, cfr: item?.cfr };
    });
}

export function inspectionHasHazard(inspection: Inspection, equipment: Equipment): boolean {
  const checklist = checklistFor(equipment.category);
  return inspection.answers.some((a) => isHazard(checklist, a));
}
