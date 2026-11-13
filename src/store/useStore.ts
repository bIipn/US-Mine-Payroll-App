import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { DEMO_MODE } from '../config';
import { MAX_RADIUS_M, MIN_RADIUS_M } from '../domain/site';
import { findItem, inspectionResult, isHazard, templateFor } from '../domain/templates';
import { CA_RULES, lunchEndAt, startedLunch } from '../domain/time';
import type {
  Account,
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
  MrfStatus,
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
  meter: number;
  area?: string;
  answers: InspectionAnswer[];
}

export interface MrfInput {
  equipmentId: string;
  priority: MrfPriority;
  description: string;
  items?: MrfItem[];
  meter?: number;
  location?: string;
  taggedOut: boolean;
  inspectionId?: string;
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

  ensureSeeded: () => void;
  resetDemo: () => void;

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
  setMrfStatus: (mrfId: string, status: MrfStatus, note?: string) => void;

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

const clean = (text: string) => text.trim().replace(/\s+/g, ' ');
const sameName = (e: Employee, first: string, last: string) =>
  e.firstName.toLowerCase() === clean(first).toLowerCase() && e.lastName.toLowerCase() === clean(last).toLowerCase();
const titleCase = (text: string) =>
  clean(text).replace(/(^|[\s'-])([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());
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

/** Operating sheets that are still open, keyed by equipment. */
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

      return {
        ...initialData(),
        hydrated: false,
        toast: null,
        setHydrated: () => set({ hydrated: true }),
        showToast: (message, tone = 'ok') => set({ toast: { id: Date.now(), message, tone } }),
        clearToast: () => set({ toast: null }),

        ensureSeeded: () => {
          if (get().seededAt != null) return;
          const now = Date.now();
          set({ ...(DEMO_MODE ? buildDemoData(now) : emptyData()), seededAt: now });
        },
        resetDemo: () => {
          const now = Date.now();
          set({ ...initialData(), ...buildDemoData(now), seededAt: now });
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
          const template = templateFor(unit.category);
          const result = inspectionResult(template, draft.answers);
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
            area: draft.area,
            answers: draft.answers,
            result,
          };
          let status = unit.status;
          if (result === 'bad_order') status = 'out_of_service';
          else if (result === 'defect' && status === 'ready') status = 'defect';

          // A new operator taking the unit closes the previous operating sheet.
          let logs = opLogs.map((log) =>
            log.equipmentId === unit.id && !log.endAt ? { ...log, endAt: now, endMeter: draft.meter } : log,
          );
          if (result === 'pass') {
            logs = [...logs, {
              id: uid('op_'), equipmentId: unit.id, employeeId: session.employeeId, inspectionId: inspection.id,
              startAt: now, startMeter: draft.meter, area: draft.area,
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
                    inspectionId, startAt: now, startMeter: inspection.meter, area: inspection.area,
                  }]
                : opLogs,
          });
        },

        endUse: (logId, input) => {
          const { opLogs, equipment } = get();
          const log = opLogs.find((l) => l.id === logId);
          if (!log || log.endAt) return { ok: false, error: 'That operating sheet is already closed.' };
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

        createMrf: (input) => {
          const { session, mrfs, mrfSeq, equipment, inspections } = get();
          if (!session) return { ok: false, error: 'You are signed out.' };
          if (!clean(input.description)) return { ok: false, error: 'Describe the problem so maintenance knows what to look for.' };
          const now = Date.now();
          const mrf: Mrf = {
            id: uid('mrf_'),
            number: mrfSeq,
            equipmentId: input.equipmentId,
            requestedBy: session.employeeId,
            createdAt: now,
            priority: input.priority,
            description: clean(input.description),
            items: input.items ?? [],
            meter: input.meter,
            location: input.location ? clean(input.location) : undefined,
            taggedOut: input.taggedOut,
            inspectionId: input.inspectionId,
            status: 'open',
            history: [{ at: now, by: session.employeeId, status: 'open' }],
          };
          const all = [...mrfs, mrf];
          set({
            mrfs: all,
            mrfSeq: mrfSeq + 1,
            equipment: equipment.map((e) =>
              e.id === input.equipmentId ? { ...e, status: statusFromMrfs(e.id, all) } : e,
            ),
            inspections: inspections.map((i) => (i.id === input.inspectionId ? { ...i, mrfId: mrf.id } : i)),
          });
          return { ok: true, mrf };
        },

        setMrfStatus: (mrfId, status, note) => {
          const { session, mrfs, equipment } = get();
          const mrf = mrfs.find((m) => m.id === mrfId);
          if (!session || !mrf) return;
          const all = mrfs.map((m) =>
            m.id === mrfId
              ? { ...m, status, history: [...m.history, { at: Date.now(), by: session.employeeId, status, note: note ? clean(note) : undefined }] }
              : m,
          );
          set({
            mrfs: all,
            equipment: equipment.map((e) => (e.id === mrf.equipmentId ? { ...e, status: statusFromMrfs(e.id, all) } : e)),
          });
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
            let line = clean(raw.replace(/^\d+[.)]\s*/, ''));
            if (!line) continue;
            // Accept "Last, First" as well as "First Last".
            if (line.includes(',')) {
              const [last, first] = line.split(',').map(clean);
              line = `${first} ${last}`;
            }
            const parts = line.split(' ');
            if (parts.length < 2) {
              skipped += 1;
              continue;
            }
            const result = get().addEmployee(parts[0], parts.slice(1).join(' '));
            if (result.ok) added += 1;
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
      partialize: ({ session, employees, accounts, shifts, leave, denied, equipment, inspections, opLogs, mrfs, mrfSeq, payRates, settings, seededAt }) => ({
        session, employees, accounts, shifts, leave, denied, equipment, inspections, opLogs, mrfs, mrfSeq, payRates, settings, seededAt,
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

/** Defect lines for an MRF, taken from the Bad Order answers on an inspection. */
export function mrfItemsFromInspection(inspection: Inspection, equipment: Equipment): MrfItem[] {
  const template = templateFor(equipment.category);
  return inspection.answers
    .filter((a) => a.answer === 'bo')
    .map((a) => {
      const item = findItem(template, a.itemId);
      return { label: item?.label ?? a.itemId, note: a.note, cfr: item?.cfr };
    });
}

export function inspectionHasHazard(inspection: Inspection, equipment: Equipment): boolean {
  const template = templateFor(equipment.category);
  return inspection.answers.some((a) => isHazard(template, a));
}
