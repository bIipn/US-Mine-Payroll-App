import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { AREA_SHEETS, DEMO_MODE, ROSTER, ROSTER_OWNER, SAMPLE_CREW, SERVER, STARTING_COMPANY, STARTING_SITE } from '../config';
import { buildExam, changedSheet, examFindings, newSheet, SAMPLE_AREA_SHEETS, sheetInUse, withFix, withMrf, withSheets, type ExamDraft } from '../domain/areaExam';
import { accountHere, offTheRosterHere, ownPersonHere, signInPerson, supervisorHere } from '../domain/access';
import { clockBlocker, signOutBlockers } from '../domain/accountDeletion';
import { checkCompany, savedCompany, type Company } from '../domain/company';
import { checkPaySchedule, type PaySchedule } from '../domain/payPeriod';
import { floorWords, freshReceiving, mergeRows, signInGone, standingChange, withNotices, worseStatus, type Receiving } from '../domain/receive';
import { newUnit, unitsCheckedOut, withoutUnit, type UnitInput } from '../domain/fleet';
import { clockInTurnDown, type ClockInTurnDown } from '../domain/geofence';
import { connectProblem, type ConnectedCompany } from '../domain/server';
import { DELETED, markSent, REFERENCE_KINDS, sortedChanges, type Change, type CompanyRow, type PushAnswer, type ReceivedRow, type Standing, type Synced, type SyncStatus } from '../domain/sync';
import { addedPerson, cleanText, findOnRoster, parsePersonName, payrollIdProblem, sameName, withBuildRoster, type PersonName, type RosterEntry } from '../domain/roster';
import { DEFAULT_RADIUS_M, MAX_RADIUS_M, MIN_RADIUS_M } from '../domain/site';
import { checklistFor, findItem, inspectionResult, isHazard, signedAnswers } from '../domain/templates';
import { rulesFor } from '../domain/stateRules';
import { CA_RULES, LUNCH_MS, lunchEndAt, punchAt, startedLunch, type TimeRules } from '../domain/time';
import type {
  Account,
  AreaExam,
  AreaSheet,
  AuthProvider,
  DemoLocation,
  DeniedPunch,
  Employee,
  Equipment,
  EquipmentStatus,
  GeoStamp,
  Inspection,
  InspectionAnswer,
  LatLng,
  LeaveType,
  MealNote,
  Mrf,
  MrfItem,
  MrfPriority,
  NoLocation,
  OperatingLog,
  Punch,
  Role,
  Session,
  Settings,
  Shift,
  ShiftEdit,
  SiteConfig,
} from '../domain/types';
import { safeStorage } from '../services/storage';
import { fmtDate, fmtTime, MIN, startOfDay } from '../util/format';
import { sha256, uid } from '../util/hash';
import { migratePersisted, STATE_VERSION } from './migrate';
import {
  buildBareData,
  buildDemoData,
  defaultSettings,
  DEMO_EMPLOYEE_ID,
  DEMO_SUPERVISOR_ID,
  emptyData,
  SAMPLE_CREW_IDS,
  type SeedData,
} from './seed';

export type ToastTone = 'ok' | 'bo' | 'warn' | 'info';
export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** A sign-in whose password was right, for a person taken off the roster: they may delete the account from the sign-in screen. */
export type OffRoster = { ok: false; error: string; offRoster: true };

interface Data extends SeedData {
  session: Session | null;
  denied: DeniedPunch[];
  settings: Settings;
  seededAt: number | null;
  /** The version of each record the company's server has confirmed (`src/domain/sync.ts`). */
  synced: Synced;
  /** The company whose server `synced` is about. A phone sends to one company only. */
  syncedWith: string | null;
  /** The company this phone is connected to and sends its records to, or none. */
  connectedCompany: ConnectedCompany | null;
  /**
   * The last request to join a company made from this phone, so the person can
   * check on it later without typing the code again. This phone's own: never sent.
   */
  joinAsked: JoinAsked | null;
  /**
   * On a phone connected to its company: what it has received of the company's
   * roster, fleet, area sheets and settings, and what of its own changes the
   * company did not take (`src/domain/receive.ts`). Null on a phone never connected.
   */
  receiving: Receiving | null;
}

/** Which company, server account and reading a page of the company's records was read for. Anything else is not applied. */
export interface ReceiveContext {
  company: string;
  account: string;
  epoch: number;
}

/** A request to join a company: the code and the name it was made with. */
export interface JoinAsked {
  code: string;
  firstName: string;
  lastName: string;
  companyName?: string;
  /** Why it waits for a supervisor, as the server said. */
  reason?: string;
  /** The server account that asked. */
  accountId: string;
  at: number;
}

export interface SignUpInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  /**
   * No longer read. On a phone joined to its company only the person its sign-in is for has an account,
   * and signing in to the company was the proof, so a supervisor's own needs no second password
   * (accountHere). The sign-in screen stops sending it when its connecting branch goes.
   */
  companyPasswordChecked?: boolean;
}

export interface InspectionDraft {
  equipmentId: string;
  /** The unit as the form opened with it: signed on as it was seen, though the office changes or takes it out meanwhile. */
  unit?: Equipment;
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
   *
   * `samples` is whether a preview starts with the made-up sample crew and
   * their history. Without them it starts with the fleet and the area sheets,
   * and only the people the build names.
   */
  ensureSeeded: (owner?: PersonName | null, sheets?: AreaSheet[], people?: RosterEntry[], samples?: boolean) => void;
  resetDemo: (owner?: PersonName | null, sheets?: AreaSheet[], people?: RosterEntry[], samples?: boolean) => void;

  signUp: (input: SignUpInput) => Result<{ note?: string }>;
  signIn: (email: string, password: string) => Result | OffRoster;
  /**
   * Delete the account signed in on this phone: the account, its session and its own hourly rate.
   * Never a made-up sample person's, and never while they are on the clock. The person's employee
   * record and every record stay. With `clearPhone`, and only when nothing on the phone would be lost
   * (no other account on it, and everything it holds has reached the company it was joined to), the
   * phone is cleared and starts as the build does. A company sign-in is deleted on the server first,
   * in `src/services/connection.ts`.
   */
  deleteMyAccount: (options: { clearPhone: boolean }) => Result<{ cleared: boolean }>;
  /** The sign-in screen: a person taken off the roster deletes their account from this phone with its password. */
  deleteAccountWithPassword: (email: string, password: string) => Result;
  signInWithProvider: (provider: Exclude<AuthProvider, 'password' | 'company'>, firstName: string, lastName: string) => Result;
  signInDemo: (role: Role) => Result;
  /** Preview only: open the app as the person the build is made for, with no account to set up first. */
  openAsOwner: (owner?: PersonName | null) => Result;
  /**
   * One person per phone. On a phone joined to its company with nobody signed in, open the account of
   * the person its company sign-in is for (ownPersonHere), made here if they have none: no email and no
   * password, since signing in to the company was the proof. A round runs it after each of its reads
   * (applyStanding, applyReceived), so the account opens by itself once the company's settings and
   * roster are in. Asked again for the person already signed in, it changes nothing.
   */
  openOwnAccount: () => Result;
  signOut: () => void;
  /**
   * One person per phone: the person whose own company sign-in this phone has (signInPerson) signs it out,
   * and it is emptied the way clearDevice empties it, to start as the build does. Only on a phone joined
   * to its company, and only once nothing on it would be lost, on the deletion plan's own terms for
   * clearing a phone (signOutBlockers): no shift open and no unit checked out, nobody else's account here,
   * the company's records read to the end, nothing waiting and nothing the company turned down. It refuses
   * with the first thing that holds it up and what to do. `round` is what only the round knows
   * (useSyncStatus): whether there is signal, what the server will not take as it is, and why nothing can
   * go now. Signing out of the company's server is connection.ts's.
   */
  forgetPhone: (round?: Pick<SyncStatus, 'online' | 'stuck' | 'trouble'>) => Result;

  /**
   * Where the phone was, or why it gave no location. With no boundary set it is
   * turned down. A position outside the boundary, simulated or too vague to
   * trust is turned down and logged; with no location the clock-in goes
   * through, flagged for a supervisor to review.
   */
  clockIn: (where: GeoStamp | NoLocation) => Result<{ shift: Shift }>;
  /** Never blocked by location. Left out when no location was read at all. */
  startLunch: (where?: GeoStamp | NoLocation) => Result<{ shift: Shift }>;
  toggleBreak: () => Result<{ shift: Shift }>;
  clockOut: (where?: GeoStamp | NoLocation, mealNote?: MealNote) => Result<{ shift: Shift }>;
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
  /** `single` is a sheet with one OK/BO column for each line instead of guarding, electrical and safe access. */
  addAreaSheet: (title: string, rowsText: string, single?: boolean) => Result<{ sheet: AreaSheet }>;
  /** Leave `single` out to keep the columns the sheet has. */
  updateAreaSheet: (sheetId: string, title: string, rowsText: string, single?: boolean) => Result;
  setAreaSheetActive: (sheetId: string, active: boolean) => Result;

  addEmployee: (firstName: string, lastName: string, role?: Role, title?: string) => Result;
  addEmployeesBulk: (text: string) => { added: number; skipped: number; error?: string };
  setEmployeeActive: (employeeId: string, active: boolean) => Result;
  setEmployeeRole: (employeeId: string, role: Role) => Result;
  /** A person's number in the company's payroll system, for the payroll hours file. Empty takes it off. */
  setPayrollId: (employeeId: string, payrollId: string) => Result;
  addEquipment: (input: UnitInput) => Result;
  removeEquipment: (equipmentId: string) => Result;

  setRadius: (radiusM: number) => Result;
  /** Move the boundary's pin to a point on the mine, such as where the supervisor stands. Makes the site if there is none. */
  setSitePin: (center: LatLng) => Result;
  setDemoLocation: (mode: DemoLocation) => void;
  setLunchReminders: (on: boolean) => void;
  setAllowSectionAllOk: (on: boolean) => Result;
  /** Supervisors only. */
  setCompany: (company: Company) => Result;

  addLeave: (input: LeaveInput) => Result;
  removeLeave: (leaveId: string) => Result;
  /** The signed-in person's own hourly rate for their pay estimate. `null` clears it. */
  setMyRate: (cents: number | null) => Result;

  /**
   * Note the versions of records the company's server took. `companyId` is the
   * company that answered: an answer from any company but the one `synced` is
   * about is not noted, such as one that comes back after the phone moved.
   */
  markSynced: (accepted: readonly Pick<Change, 'key' | 'rev'>[], companyId?: string | null, sent?: readonly Change[]) => void;
  /** On a connected phone with none (or another company's), start receiving the company's records from the beginning. */
  ensureReceiving: () => Receiving | null;
  /** Merge a page of the company's records, and move past it. False when it was read for another company, account or reading. */
  applyReceived: (ctx: ReceiveContext, rows: readonly ReceivedRow[]) => boolean;
  /** Who this phone's company sign-in is to the company: its role and name, or null for not on the roster. */
  applyStanding: (ctx: ReceiveContext, standing: Standing | null) => boolean;
  /** A company that never sent its settings: fill a blank company from the company's own row. */
  takeCompanyRow: (ctx: ReceiveContext, row: CompanyRow) => boolean;
  /** At start-up: read the company's records again from the beginning when some could not be read. */
  readUnreadableAgain: () => void;
  /** The rows the next page asks for: halved after a page that had no answer in time, doubled after a quick full one. */
  setReceivePageSize: (ctx: ReceiveContext, size: number) => void;
  /** Before a call goes: note the versions of the four kinds it carries, so their own write is known when it comes back. */
  markSending: (changes: readonly Change[], companyId: string) => void;
  /** Changes the server would not take from this phone's sign-in: kept, not sent again at that version, and not counted as sent. */
  holdRefused: (held: PushAnswer['held'], companyId: string) => void;
  /** Units the server keeps at the floor of the company's open requests on them. */
  keepFloor: (floored: PushAnswer['floored'], companyId: string) => void;
  /** Done, on the list of what the company did not take: kept as it is and not sent again, off the list. */
  dismissHeld: (changes: readonly Pick<Change, 'key' | 'rev'>[]) => void;
  /** Done, on a notice from the company. */
  dismissNotice: (id: string) => void;
  /**
   * Send this phone's records to a company from now on, as the server account
   * that joined it. A phone whose records already went to another company is
   * turned back.
   */
  connectCompany: (company: ConnectedCompany, account?: { id: string; email: string }) => Result;
  /** The signed-in account is on the connected company's roster, with this role: the phone sends as it from now on. */
  confirmConnection: (found: { userId: string; email: string; role: Role; name: string }) => void;
  /** Stop sending. The records stay on the phone, and what the server has is remembered for when it connects again. */
  disconnectCompany: () => void;
  /** The phone's own company sign-in was deleted: who it was to the company is forgotten (`signInGone`). */
  signInDeleted: () => void;
  /** Remember a request to join a company, or forget it. */
  setJoinAsked: (asked: JoinAsked | null) => void;
  /**
   * Erase everything on this device and start it the way the build starts. In a
   * preview anyone may; in a build that keeps real records only a supervisor
   * may, because what has not reached the server yet is lost.
   */
  clearDevice: () => Result;
}

export type Store = Data & Actions;

const clean = cleanText;
const hashPassword = (password: string, salt: string) => sha256(`${salt}:${password}`);

/** What a clock-in that is turned down says. The Clock screen shows its own sheet before it gets here. */
const TURNED_DOWN: Record<ClockInTurnDown, string> = {
  no_site: 'The mine boundary is not set, so no one can clock in yet. Ask a supervisor to set it on More, Mine boundary.',
  outside: 'You are outside the clock-in boundary. Clock in once you are on site.',
  weak_gps: 'Your phone cannot place you closely enough to check. Step out into the open and try again.',
  mocked: 'The phone reported a simulated location. Turn off any mock-location app and try again.',
};

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

/** A pay schedule from the company's own row, when the app can use it; otherwise none. */
function usablePay(pay: unknown): PaySchedule | null {
  if (!pay || typeof pay !== 'object') return null;
  try {
    return checkPaySchedule(pay as PaySchedule) === undefined ? (pay as PaySchedule) : null;
  } catch {
    return null;
  }
}

const initialData = (): Data => ({
  ...emptyData(),
  session: null,
  denied: [],
  settings: defaultSettings(DEMO_MODE, STARTING_COMPANY, STARTING_SITE),
  seededAt: null,
  synced: {},
  syncedWith: null,
  connectedCompany: null,
  joinAsked: null,
  receiving: null,
});

/** Whether what this build saves on the device is the sample crew's history, rather than only what people entered. */
export const HOLDS_SAMPLES = DEMO_MODE && SAMPLE_CREW;

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

      /** The one person on the active roster a typed name is, or what to tell whoever typed it. */
      const rosterMatch = (first: string, last: string): Result<{ employee: Employee }> => {
        const hit = findOnRoster(get().employees.filter((e) => e.active), first, last);
        if (!hit) return { ok: false, error: notOnRoster(first, last) };
        if ('several' in hit) {
          return { ok: false, error: `More than one person on the roster goes by "${clean(first)} ${clean(last)}". Type your name the way it is on the roster.` };
        }
        return { ok: true, employee: hit.person };
      };

      const notOnRoster = (first: string, last: string) =>
        `We couldn't find "${clean(first)} ${clean(last)}" on the roster. Check the spelling, or see your supervisor to be added.`;

      const signedOut = { ok: false as const, error: 'You are signed out.' };
      /** The receiving state a page or an answer was read for, or null when the phone has moved on since. */
      const receivingFor = (ctx: ReceiveContext): Receiving | null => {
        const { receiving, syncedWith, connectedCompany } = get();
        if (!receiving || !connectedCompany || ctx.company !== syncedWith || ctx.company !== receiving.company) return null;
        return ctx.account === connectedCompany.userId && ctx.epoch === receiving.epoch ? receiving : null;
      };
      /**
       * Whether the person signed in has a supervisor's powers on this phone. On a phone
       * connected to its company, the phone's company sign-in decides too (supervisorHere).
       */
      const isSupervisor = () => {
        const { session, employees, connectedCompany, receiving } = get();
        return supervisorHere({ session, employees, connected: !!connectedCompany, receiving });
      };
      /** On a connected phone, people are changed on the dashboard, which changes the sign-in roster with them. */
      const peopleProblem = (): { ok: false; error: string } | null =>
        get().connectedCompany
          ? {
              ok: false,
              error:
                'On a phone joined to a company, people are added, taken off and given a role or a payroll ID on the dashboard’s Roster page, which changes the sign-in roster too. This phone gets the change the next time it has signal.',
            }
          : null;
      /**
       * On a connected phone, the fleet, the sheets and the settings change from a supervisor's
       * company sign-in, and only once the company's own have come: the server takes them from a
       * supervisor only, and the company's would otherwise be put over them a moment later.
       */
      const sharedProblem = (): { ok: false; error: string } | null => {
        const { connectedCompany, receiving } = get();
        if (!connectedCompany) return null;
        if (receiving?.role === 'none') return { ok: false, error: 'This phone’s company sign-in is not on the company’s roster any more. See your supervisor.' };
        if (receiving?.role !== 'supervisor') {
          return {
            ok: false,
            error: 'This phone is joined with a crew sign-in, so the company’s server would not take this. Change it on the office dashboard, or join this phone with a supervisor’s sign-in on Company account.',
          };
        }
        if (receiving.caughtUpAt == null) return { ok: false, error: 'This phone has not got the company’s roster, fleet and sheets yet. Try again once it has had signal.' };
        return null;
      };
      /**
       * Why this person's account is not deleted now, or null when it may be: a made-up sample
       * person's never is, and nobody's while they are on the clock, so no punch is left open by it.
       */
      const keepsAccount = (employeeId: string, path: 'mine' | 'off_roster'): { ok: false; error: string } | null => {
        if (SAMPLE_CREW_IDS.has(employeeId)) return { ok: false, error: 'Sample accounts are not deleted. To start over, reset the sample data on More.' };
        const now = Date.now();
        const open = openShiftOf(get().shifts, employeeId, now);
        if (!open) return null;
        if (path === 'off_roster') {
          return { ok: false, error: 'You are still on the clock on this phone. Ask a supervisor to set the end of your shift, then delete this account.' };
        }
        // The deletion plan's own check and words (clockBlocker).
        const clock = clockBlocker(open, now, 'delete your account', fmtTime);
        return clock ? { ok: false, error: clock.body } : null;
      };
      /** What this phone holds that its company does not, sorted as a round sorts it on a phone joined to a company (sortedChanges). */
      const sortedHere = (r: Receiving) => {
        const state = get();
        return sortedChanges(state, state.synced, SAMPLE_CREW_IDS, { connected: true, role: r.role, caughtUp: r.caughtUpAt != null, unreadable: r.unreadable, held: r.held });
      };
      /** What the phone knows of receiving from the company it is connected to: none while it is not, or while what it keeps is another company's. */
      const receivingHere = () => {
        const { connectedCompany, receiving } = get();
        return connectedCompany && receiving?.company === connectedCompany.id ? receiving : null;
      };
      /** After each read of a round: a phone joined to its company with nobody signed in opens its own person's account, once it can. */
      const openWhenReady = () => {
        if (!get().session) get().openOwnAccount();
      };
      /**
       * Whether everything this phone holds has reached the company it was joined to, by the sort the
       * round sends by (sortedChanges): nothing waiting, and nothing the company would not take from its
       * sign-in. A phone that never joined a company has nothing of its own on any server.
       */
      const nothingUnsent = () => {
        const state = get();
        const r = state.receiving;
        // Until the phone has read the company's records to the end, a round leaves its new units, sheets and settings out of what it would send.
        if (!state.syncedWith || !r || r.company !== state.syncedWith || r.caughtUpAt == null) return false;
        const sorted = sortedHere(r);
        return sorted.now.length === 0 && sorted.afterReceive.length === 0 && sorted.notTaken.length === 0;
      };
      /** A request is worked by a supervisor or by the person it is assigned to. */
      const canWork = (mrf: Mrf) => isSupervisor() || (!!mrf.assignedTo && mrf.assignedTo === get().session?.employeeId);
      const notYours = { ok: false as const, error: 'Only a supervisor, or the person it is assigned to, can work this request.' };
      /** The sheets a first start is made with: the build's own, or the samples. */
      const startingSheets = (named: AreaSheet[]) => (named.length ? named : SAMPLE_AREA_SHEETS);
      /** The real people a build names, its owner among them: the sample crew starts apart from them. */
      const realPeople = (people: RosterEntry[], owner: PersonName | null): PersonName[] => (owner ? [...people, owner] : people);
      /**
       * What a preview starts with. With the samples, the made-up crew and their history.
       * Without them, the fleet and the area sheets: the people are the build's own, and
       * nothing has happened yet.
       */
      const previewStart = (now: number, owner: PersonName | null, sheets: AreaSheet[], people: RosterEntry[], samples: boolean): SeedData =>
        samples ? buildDemoData(now, startingSheets(sheets), realPeople(people, owner)) : buildBareData(startingSheets(sheets));
      /** A made-up address for an account opened without one, until the real sign-in is connected: the name, letters only. */
      const standInEmail = (person: PersonName) =>
        `${`${person.firstName} ${person.lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '')}@example.com`;

      return {
        ...initialData(),
        hydrated: false,
        toast: null,
        setHydrated: () => set({ hydrated: true }),
        showToast: (message, tone = 'ok') => set({ toast: { id: Date.now(), message, tone } }),
        clearToast: () => set({ toast: null }),

        ensureSeeded: (owner = ROSTER_OWNER, sheets = AREA_SHEETS, people = ROSTER, samples = SAMPLE_CREW) => {
          if (get().seededAt == null) {
            const now = Date.now();
            set({ ...(DEMO_MODE ? previewStart(now, owner, sheets, people, samples) : emptyData()), seededAt: now });
          }
          // The people this build names are always on the roster, its owner among them, and
          // the build's own area sheets are always there, including on a phone whose data
          // was saved before they were named. Not once the phone has sent to a company:
          // from then on the company's roster and sheets are the phone's.
          if (get().syncedWith != null) return;
          const { employees, areaSheets } = get();
          const roster = withBuildRoster(employees, people, owner);
          const named = withSheets(areaSheets, sheets);
          if (roster !== employees || named !== areaSheets) set({ employees: roster, areaSheets: named });
        },
        resetDemo: (owner = ROSTER_OWNER, sheets = AREA_SHEETS, people = ROSTER, samples = SAMPLE_CREW) => {
          if (!DEMO_MODE) {
            // A build that keeps real records starts the way a fresh install does: nothing in it but the build's own.
            set({ ...initialData(), seededAt: null });
            get().ensureSeeded(owner, sheets, people, samples);
            return;
          }
          const now = Date.now();
          const data = previewStart(now, owner, sheets, people, samples);
          set({ ...initialData(), ...data, employees: withBuildRoster(data.employees, people, owner), seededAt: now });
        },

        clearDevice: () => {
          if (!DEMO_MODE && !isSupervisor()) return { ok: false, error: 'Only a supervisor can clear this device.' };
          get().resetDemo();
          return { ok: true };
        },

        // ---- Accounts ----------------------------------------------------------------
        signUp: ({ firstName, lastName, email, password }) => {
          if (!clean(firstName) || !clean(lastName)) return { ok: false, error: 'Enter your first and last name.' };
          const address = email.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { ok: false, error: 'Enter a valid email address.' };
          if (password.length < 8) return { ok: false, error: 'Use a password of at least 8 characters.' };
          const match = rosterMatch(firstName, lastName);
          if (!match.ok) return match;
          const { employee } = match;
          // On a connected phone, whose account it may hold goes by its company sign-in (accountHere).
          const { connectedCompany, employees } = get();
          const here = connectedCompany ? accountHere(employee, employees, receivingHere() ?? { role: null, name: null, caughtUpAt: null }) : ({ ok: true } as const);
          if (!here.ok) return { ok: false, error: here.error };
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
          return 'note' in here && here.note ? { ok: true, note: here.note } : { ok: true };
        },

        signIn: (email, password) => {
          const address = email.trim().toLowerCase();
          const { accounts, employees } = get();
          const account = accounts.find((a) => a.email === address && a.passwordHash && a.salt);
          const wrong: Result = { ok: false, error: 'That email and password do not match an account.' };
          if (!account || account.passwordHash !== hashPassword(password, account.salt ?? '')) return wrong;
          const employee = employees.find((e) => e.id === account.employeeId);
          if (!employee || offTheRosterHere(employee, !!get().connectedCompany, get().receiving)) {
            return { ok: false, error: 'This account is no longer on the active roster. See your supervisor.', offRoster: true };
          }
          startSession(account);
          return { ok: true };
        },

        deleteMyAccount: ({ clearPhone }) => {
          const { session, accounts, payRates } = get();
          if (!session) return signedOut;
          const refused = keepsAccount(session.employeeId, 'mine');
          if (refused) return refused;
          const others = accounts.filter((a) => a.id !== session.accountId);
          if (clearPhone && others.length === 0 && nothingUnsent()) {
            // The clearDevice path, open to anyone here because nothing on the phone is lost.
            get().resetDemo();
            return { ok: true, cleared: true };
          }
          const rates = { ...payRates };
          delete rates[session.employeeId];
          set({ accounts: others, session: null, payRates: rates });
          return { ok: true, cleared: false };
        },

        deleteAccountWithPassword: (email, password) => {
          const address = email.trim().toLowerCase();
          const { accounts, employees, payRates, session } = get();
          const account = accounts.find((a) => a.email === address && a.passwordHash && a.salt);
          if (!account || account.passwordHash !== hashPassword(password, account.salt ?? '')) {
            return { ok: false, error: 'That email and password do not match an account.' };
          }
          const refused = keepsAccount(account.employeeId, 'off_roster');
          if (refused) return refused;
          const employee = employees.find((e) => e.id === account.employeeId);
          if (employee && !offTheRosterHere(employee, !!get().connectedCompany, get().receiving)) return { ok: false, error: 'Sign in, then delete your account on More.' };
          const rates = { ...payRates };
          delete rates[account.employeeId];
          set({ accounts: accounts.filter((a) => a.id !== account.id), payRates: rates, ...(session?.accountId === account.id ? { session: null } : null) });
          return { ok: true };
        },

        signInWithProvider: (provider, firstName, lastName) => {
          // Apple, Google and Microsoft are not connected yet, so this sign-in proves nothing but a typed name.
          // A build that sends to the company's server has none of it: there, what a session does is the company's record.
          if (SERVER) return { ok: false, error: 'Sign in with your email and password.' };
          if (!clean(firstName) || !clean(lastName)) return { ok: false, error: 'Enter your first and last name.' };
          const match = rosterMatch(firstName, lastName);
          if (!match.ok) return match;
          const { employee } = match;
          const { accounts } = get();
          if (employee.role === 'supervisor') {
            return { ok: false, error: 'A supervisor signs in with an email and password. Create an account under your name, or sign in with it.' };
          }
          if (accounts.some((a) => a.employeeId === employee.id && a.passwordHash)) {
            return { ok: false, error: `${employee.firstName} ${employee.lastName} has an account with a password. Sign in with your email and password.` };
          }
          let account = accounts.find((a) => a.employeeId === employee.id);
          if (!account) {
            account = { id: uid('acct_'), employeeId: employee.id, email: standInEmail(employee), provider, createdAt: Date.now() };
            set({ accounts: [...accounts, account] });
          }
          startSession(account);
          return { ok: true };
        },

        signInDemo: (role) => {
          const employeeId = role === 'supervisor' ? DEMO_SUPERVISOR_ID : DEMO_EMPLOYEE_ID;
          const account = get().accounts.find((a) => a.employeeId === employeeId);
          if (!account) return { ok: false, error: 'This preview has no sample crew to open as. Create an account under your own name.' };
          startSession(account);
          return { ok: true };
        },

        openAsOwner: (owner = ROSTER_OWNER) => {
          if (!DEMO_MODE) return { ok: false, error: 'Sign in with your own account.' };
          const { employees, accounts } = get();
          const person = owner ? employees.find((e) => e.active && sameName(e, owner.firstName, owner.lastName)) : undefined;
          if (!person) return { ok: false, error: 'Nobody is set up to open this preview as. Create an account under your own name.' };
          let account = accounts.find((a) => a.employeeId === person.id);
          if (!account) {
            // No password goes with it, so the person can still create an account of their own later.
            account = { id: uid('acct_'), employeeId: person.id, email: standInEmail(person), provider: 'password', createdAt: Date.now() };
            set({ accounts: [...accounts, account] });
          }
          startSession(account);
          return { ok: true };
        },

        openOwnAccount: () => {
          const { connectedCompany, session, employees, accounts } = get();
          if (!connectedCompany) return { ok: false, error: 'This phone is not joined to a company.' };
          const own = ownPersonHere(employees, receivingHere());
          if (!own.ok) return own;
          const { person } = own;
          // Open already: for its own person nothing changes, and nobody's account is opened over someone else's.
          if (session) return session.employeeId === person.id ? { ok: true } : { ok: false, error: 'Someone else is signed in on this phone.' };
          const account: Account = accounts.find((a) => a.employeeId === person.id) ?? {
            id: uid('acct_'),
            employeeId: person.id,
            email: '',
            provider: 'company',
            createdAt: Date.now(),
          };
          set({ ...(accounts.includes(account) ? null : { accounts: [...accounts, account] }), session: { accountId: account.id, employeeId: account.employeeId } });
          return { ok: true };
        },

        signOut: () => set({ session: null }),

        forgetPhone: (round = { online: true, stuck: 0, trouble: null }) => {
          const { connectedCompany, session, employees, accounts, shifts, opLogs, equipment } = get();
          if (!connectedCompany) return { ok: false, error: 'This phone is not joined to a company.' };
          if (!session) return signedOut;
          const r = receivingHere();
          if (!r?.name) return { ok: false, error: 'This phone has not heard from the company yet. Try again once it has had signal.' };
          // The sign-in's own person, exactly: never someone its name only loosely fits.
          const own = signInPerson(employees, r);
          if (!own.ok) return own;
          if (own.person.id !== session.employeeId) {
            return { ok: false, error: `This phone is joined with ${r.name.firstName} ${r.name.lastName}’s company sign-in. Only they can sign this phone out.` };
          }
          // Signing out empties the phone, so it waits until nothing on it would be lost. What waits, and what the
          // company turned down, are counted now from the phone's own records; only what the server will not take
          // as it is, and why nothing can go, are the round's. A sign-in off the roster, as its own row says, sends nothing.
          const sorted = sortedHere(r);
          const now = Date.now();
          const { blockers } = signOutBlockers({
            now,
            company: connectedCompany.name,
            openShift: openShiftOf(shifts, session.employeeId, now),
            staleShift: staleShiftOf(shifts, session.employeeId, now),
            openUnit: unitsCheckedOut(session.employeeId, opLogs, equipment, r.gone)[0]?.unit.unit ?? null,
            otherAccounts: accounts.filter((a) => a.id !== session.accountId).length,
            caughtUp: r.caughtUpAt != null,
            sync: {
              online: round.online,
              waiting: sorted.now.length + sorted.afterReceive.length,
              notTaken: sorted.notTaken.length,
              stuck: round.stuck,
              trouble: r.role === 'none' ? 'not_member' : round.trouble,
            },
            fmtTime,
            fmtDay: fmtDate,
          });
          const first = blockers[0];
          if (first) return { ok: false, error: `${first.title}. ${first.body}` };
          // The clearDevice path, open to the person here because nothing on the phone is lost.
          get().resetDemo();
          return { ok: true };
        },

        // ---- Time clock ----------------------------------------------------------------
        clockIn: (where) => {
          const { session, shifts, employees, connectedCompany, receiving, settings } = get();
          if (!session) return { ok: false, error: 'You are signed out.' };
          if (!employees.find((e) => e.id === session.employeeId)?.active) {
            return { ok: false, error: 'You are no longer on the active roster. See your supervisor.' };
          }
          if (connectedCompany && receiving?.role === 'none') {
            return {
              ok: false,
              error: `This phone is not joined to ${connectedCompany.name} any more, so a clock-in here would never reach payroll. See your supervisor.`,
            };
          }
          const now = Date.now();
          if (openShiftOf(shifts, session.employeeId, now)) return { ok: false, error: 'You are already clocked in.' };
          // No one clocks in until a boundary is set. Then a position has to be inside it and not simulated;
          // with none at all the clock-in goes through, and its flag puts it in front of a supervisor.
          const turnedDown = clockInTurnDown(settings.site, where);
          if (turnedDown) {
            // A position turned down is logged. With no boundary set there is nothing to check it against, so nothing is.
            if (turnedDown !== 'no_site' && typeof where !== 'string') get().logDenied('clock_in', turnedDown, where);
            return { ok: false, error: TURNED_DOWN[turnedDown] };
          }
          const shift: Shift = {
            id: uid('sh_'),
            employeeId: session.employeeId,
            clockIn: punchAt(now, where),
            lunches: [],
            breaks: [],
          };
          set({ shifts: [...shifts, shift] });
          return { ok: true, shift };
        },

        // One tap starts lunch. It ends by itself 30 minutes later, so there is no action to end it.
        startLunch: (where) =>
          updateOpenShift((shift, now) => {
            const last = shift.lunches[shift.lunches.length - 1];
            if (last && now < lunchEndAt(last)) return 'You are already at lunch.';
            const breaks = shift.breaks.map((b) => (b.end ? b : { ...b, end: now }));
            return { ...shift, breaks, lunches: [...shift.lunches, startedLunch(punchAt(now, where))] };
          }),

        toggleBreak: () =>
          updateOpenShift((shift, now) => {
            const last = shift.breaks[shift.breaks.length - 1];
            if (last && !last.end) {
              return { ...shift, breaks: [...shift.breaks.slice(0, -1), { ...last, end: now }] };
            }
            return { ...shift, breaks: [...shift.breaks, { start: now }] };
          }),

        clockOut: (where, mealNote) =>
          updateOpenShift((shift, now) => {
            const last = shift.lunches[shift.lunches.length - 1];
            if (last && now < lunchEndAt(last)) {
              return `You are at lunch until ${fmtTime(lunchEndAt(last))}. Clock out after that.`;
            }
            const breaks = shift.breaks.map((b) => (b.end ? b : { ...b, end: now }));
            return { ...shift, breaks, clockOut: punchAt(now, where), mealNote: mealNote ?? shift.mealNote };
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
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can correct punch times.' };
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
            const stillAutomatic = end.auto === true && end.at - start.at === LUNCH_MS;
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
          // A preview control: a build that keeps real records never moves a punch without an edit and a reason.
          if (!DEMO_MODE) return undefined;
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
          // Signed on the unit as the form opened with it, though the office changed it, or took it
          // out, meanwhile. The reading and the status go onto the unit as the phone holds it now.
          const current = equipment.find((e) => e.id === draft.equipmentId);
          const unit = draft.unit?.id === draft.equipmentId ? draft.unit : current;
          if (!unit) return { ok: false, error: 'That unit is no longer in the fleet list.' };
          // A card is signed once. A second tap on the same card gets the checklist already on record.
          const signed = inspections.find(
            (i) => i.equipmentId === unit.id && i.employeeId === session.employeeId && i.startedAt === draft.startedAt,
          );
          if (signed) return { ok: true, inspection: signed };
          // "Equp. hrs st" is a reading off the machine. Anything else would go on the card and into the fleet list.
          if (!Number.isFinite(draft.meter) || draft.meter < 0) return { ok: false, error: 'Enter the reading off the machine.' };
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
            // The standards printed beside its lines stay the ones it was signed under.
            category: unit.category,
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
          let status = current?.status ?? unit.status;
          if (result === 'bad_order') status = 'out_of_service';
          else if (result === 'defect' && status === 'ready') status = 'defect';

          // A new operator taking the unit ends the last operator's use of it.
          let logs = opLogs.map((log) =>
            log.equipmentId === unit.id && !log.endAt ? { ...log, endAt: now, endMeter: draft.meter } : log,
          );
          // A unit taken out of the fleet while it was being checked is not checked out.
          if (result === 'pass' && current) {
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
          const { opLogs, equipment, receiving } = get();
          const log = opLogs.find((l) => l.id === logId);
          if (!log || log.endAt) return { ok: false, error: 'That unit has already been checked back in.' };
          if (!(input.endMeter >= log.startMeter)) {
            return { ok: false, error: 'The ending meter cannot be lower than the starting meter.' };
          }
          // A unit the company took out of the fleet while it was checked out here is kept in `gone`
          // only so its use can be ended: ending it lets the copy go.
          const kept = receiving?.gone[log.equipmentId];
          let gone = receiving?.gone;
          if (kept && receiving) {
            const { [log.equipmentId]: _ended, ...rest } = receiving.gone;
            gone = rest;
          }
          set({
            opLogs: opLogs.map((l) => (l.id === logId ? { ...l, ...input, endAt: Date.now() } : l)),
            equipment: equipment.map((e) =>
              e.id === log.equipmentId ? { ...e, meter: Math.max(e.meter, input.endMeter) } : e,
            ),
            ...(kept && receiving && gone ? { receiving: { ...receiving, gone } } : null),
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
              // Making a request never makes a unit better: one red-tagged by a checklist, or by another phone, stays so.
              e.id === input.equipmentId ? { ...e, status: worseStatus(e.status, statusFromMrfs(e.id, all)) } : e,
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
            // Completing a request takes off what that request put on, and nothing more: a unit worse
            // than it (red-tagged by a checklist, or by another phone) keeps its status.
            equipment: equipment.map((e) => {
              if (e.id !== mrf.equipmentId) return e;
              const putOn: EquipmentStatus = mrf.taggedOut ? 'out_of_service' : 'defect';
              if (e.status !== putOn && worseStatus(e.status, putOn) === e.status) return e;
              return { ...e, status: statusFromMrfs(e.id, all) };
            }),
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
          // Signed on the sheet as the form opened with it, though the office changed or stopped it meanwhile.
          const sheet = draft.sheet?.id === draft.sheetId ? draft.sheet : areaSheets.find((s) => s.id === draft.sheetId && s.active);
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

        addAreaSheet: (title, rowsText, single) => {
          const { areaSheets } = get();
          const shared = sharedProblem();
          if (shared) return shared;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the area sheets.' };
          // The rules are the domain's (newSheet), so the office dashboard adds a sheet the same way.
          const made = newSheet(areaSheets, title, rowsText, single);
          if (!made.ok) return made;
          set({ areaSheets: [...areaSheets, made.sheet] });
          return { ok: true, sheet: made.sheet };
        },

        updateAreaSheet: (sheetId, title, rowsText, single) => {
          const { areaSheets } = get();
          const shared = sharedProblem();
          if (shared) return shared;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the area sheets.' };
          // With nothing said about the columns, the sheet keeps the ones it has. Exams already
          // signed keep the lines, and the columns, they were made on (changedSheet).
          const made = changedSheet(areaSheets, sheetId, title, rowsText, single);
          if (!made.ok) return made;
          set({ areaSheets: areaSheets.map((s) => (s.id === sheetId ? made.sheet : s)) });
          return { ok: true };
        },

        setAreaSheetActive: (sheetId, active) => {
          const shared = sharedProblem();
          if (shared) return shared;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the area sheets.' };
          set({ areaSheets: get().areaSheets.map((s) => (s.id === sheetId ? sheetInUse(s, active) : s)) });
          return { ok: true };
        },

        // ---- Roster and fleet ------------------------------------------------------------
        addEmployee: (firstName, lastName, role = 'employee', title) => {
          if (!get().session) return signedOut;
          const people = peopleProblem();
          if (people) return people;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the roster.' };
          // The rule is the domain's (addedPerson), so the dashboard's Roster page adds a person the same way.
          const { employees } = get();
          const added = addedPerson(employees, firstName, lastName, role, title, uid('emp_'));
          if (!added.ok) return added;
          set({ employees: added.returning ? employees.map((e) => (e.id === added.employee.id ? added.employee : e)) : [...employees, added.employee] });
          return { ok: true };
        },

        addEmployeesBulk: (text) => {
          const people = peopleProblem();
          if (people) {
            const lines = text.split(/[\n;]+/).filter((raw) => clean(raw.replace(/^\d+[.)]\s*/, ''))).length;
            return { added: 0, skipped: lines, error: people.error };
          }
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

        setEmployeeActive: (employeeId, active) => {
          const people = peopleProblem();
          if (people) return people;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the roster.' };
          set({ employees: get().employees.map((e) => (e.id === employeeId ? { ...e, active } : e)) });
          return { ok: true };
        },

        setEmployeeRole: (employeeId, role) => {
          const people = peopleProblem();
          if (people) return people;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the roster.' };
          set({ employees: get().employees.map((e) => (e.id === employeeId ? { ...e, role } : e)) });
          return { ok: true };
        },

        setPayrollId: (employeeId, payrollId) => {
          if (!get().session) return signedOut;
          const people = peopleProblem();
          if (people) return people;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can set payroll IDs.' };
          const id = payrollId.trim();
          const { employees } = get();
          const problem = payrollIdProblem(employees, employeeId, id);
          if (problem) return { ok: false, error: problem };
          set({
            employees: employees.map((e) => {
              if (e.id !== employeeId) return e;
              const { payrollId: _old, ...rest } = e;
              return id ? { ...rest, payrollId: id } : rest;
            }),
          });
          return { ok: true };
        },

        addEquipment: (input) => {
          if (!get().session) return signedOut;
          const shared = sharedProblem();
          if (shared) return shared;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the fleet.' };
          // What makes a unit number taken, and how a new unit starts, are the domain's (newUnit).
          const { equipment } = get();
          const made = newUnit(equipment, input);
          if (!made.ok) return made;
          set({ equipment: [...equipment, made.unit] });
          return { ok: true };
        },

        removeEquipment: (equipmentId) => {
          const shared = sharedProblem();
          if (shared) return shared;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the fleet.' };
          set({ equipment: withoutUnit(get().equipment, equipmentId) });
          return { ok: true };
        },

        // ---- Settings ---------------------------------------------------------------------
        setRadius: (radiusM) => {
          const shared = sharedProblem();
          if (shared) return shared;
          const { settings } = get();
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can move the mine boundary.' };
          if (!settings.site) return { ok: false, error: 'Put the boundary’s pin on the mine first.' };
          const clamped = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(radiusM / 50) * 50));
          set({ settings: { ...settings, site: { ...settings.site, radiusM: clamped } } });
          return { ok: true };
        },
        setSitePin: (center) => {
          if (!get().session) return signedOut;
          const shared = sharedProblem();
          if (shared) return shared;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can move the mine boundary.' };
          if (!(Math.abs(center.lat) <= 90 && Math.abs(center.lng) <= 180)) return { ok: false, error: 'That is not a position on the map.' };
          const { settings } = get();
          const site: SiteConfig = settings.site
            ? { ...settings.site, center: { lat: center.lat, lng: center.lng } }
            : { name: settings.company.name || 'Mine', center: { lat: center.lat, lng: center.lng }, radiusM: DEFAULT_RADIUS_M };
          set({ settings: { ...settings, site } });
          return { ok: true };
        },
        // Simulated GPS is a preview control. A build that keeps real records reads the phone's own.
        setDemoLocation: (demoLocation) => set({ settings: { ...get().settings, demoLocation: DEMO_MODE ? demoLocation : 'gps' } }),
        setLunchReminders: (lunchReminders) => set({ settings: { ...get().settings, lunchReminders } }),
        setAllowSectionAllOk: (allowSectionAllOk) => {
          // A company setting: it goes to the server with the others.
          const shared = sharedProblem();
          if (shared) return shared;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the company’s settings.' };
          set({ settings: { ...get().settings, allowSectionAllOk } });
          return { ok: true };
        },
        setCompany: (company) => {
          if (!get().session) return signedOut;
          const shared = sharedProblem();
          if (shared) return shared;
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can change the company details.' };
          // How a company is tidied and checked before it is saved is the domain's (savedCompany).
          const saved = savedCompany(company);
          if (!saved.ok) return saved;
          set({ settings: { ...get().settings, company: saved.company } });
          return { ok: true };
        },

        // ---- The company's server ---------------------------------------------------------
        markSynced: (accepted, companyId, sent = []) => {
          if (companyId !== undefined && companyId !== get().syncedWith) return;
          const synced = markSent(get().synced, accepted);
          const r = get().receiving;
          if (!r || !accepted.length) {
            if (synced !== get().synced) set({ synced });
            return;
          }
          // The sent marks go with their answer, and a unit the server took is the base of its next merge.
          const marks = { ...r.sent };
          const units = { ...r.units };
          const records = new Map(sent.map((c) => [`${c.key}@${c.rev}`, c.record]));
          for (const { key, rev } of accepted) {
            delete marks[key];
            if (!key.startsWith('equipment:')) continue;
            const id = key.slice('equipment:'.length);
            const record = records.get(`${key}@${rev}`) as Equipment | null | undefined;
            if (rev === DELETED) delete units[id];
            else if (record) units[id] = { status: record.status, meter: record.meter };
          }
          set({ synced, receiving: { ...r, sent: marks, units } });
        },

        ensureReceiving: () => {
          const { connectedCompany, receiving } = get();
          if (!connectedCompany) return receiving;
          if (receiving?.company === connectedCompany.id) return receiving;
          const fresh = freshReceiving(connectedCompany.id, null);
          set({ receiving: fresh });
          return fresh;
        },

        applyReceived: (ctx, rows) => {
          const r = receivingFor(ctx);
          if (!r) return false;
          const merged = mergeRows({ ...get(), receiving: r }, rows, Date.now());
          set(merged);
          openWhenReady();
          return true;
        },

        applyStanding: (ctx, standing) => {
          const r = receivingFor(ctx);
          if (!r) return false;
          const next = standingChange({ employees: get().employees, receiving: r }, standing);
          set({ employees: next.employees as Employee[], receiving: next.receiving });
          openWhenReady();
          return true;
        },

        takeCompanyRow: (ctx, row) => {
          if (!receivingFor(ctx)) return false;
          const { synced, settings } = get();
          // Once the company's settings came, or while the phone's company is whole, they stand.
          if (synced['settings:company'] !== undefined || checkCompany(settings.company) === undefined) return false;
          const pay = usablePay(row.pay);
          set({ settings: { ...settings, company: { ...settings.company, name: clean(row.name), state: row.state, pay } } });
          return true;
        },

        setReceivePageSize: (ctx, size) => {
          const r = receivingFor(ctx);
          const pageSize = Math.max(1, Math.min(500, Math.round(size)));
          if (r && r.pageSize !== pageSize) set({ receiving: { ...r, pageSize } });
        },

        readUnreadableAgain: () => {
          const r = get().receiving;
          if (!r?.unreadable.length) return;
          set({ receiving: { ...r, epoch: r.epoch + 1, cursor: 0, unreadable: [] } });
        },

        markSending: (changes, companyId) => {
          const r = get().receiving;
          if (!r || companyId !== get().syncedWith || companyId !== r.company) return;
          const marks = { ...r.sent };
          let marked = false;
          for (const c of changes) {
            if (!(REFERENCE_KINDS as readonly string[]).includes(c.kind)) continue;
            marks[c.key] = c.rev;
            marked = true;
          }
          if (marked) set({ receiving: { ...r, sent: marks } });
        },

        holdRefused: (refused, companyId) => {
          const r = get().receiving;
          if (!r || !refused.length || companyId !== get().syncedWith || companyId !== r.company) return;
          const held = { ...r.held };
          const marks = { ...r.sent };
          for (const { key, rev, reason } of refused) {
            held[key] = { rev, reason };
            delete marks[key];
          }
          set({ receiving: { ...r, held, sent: marks } });
        },

        dismissHeld: (changes) => {
          const r = get().receiving;
          if (!r || !changes.length) return;
          const held = { ...r.held };
          for (const { key, rev } of changes) held[key] = { rev, reason: held[key]?.rev === rev ? held[key].reason : 'supervisor_only', seen: true };
          set({ receiving: { ...r, held } });
        },

        dismissNotice: (id) => {
          const r = get().receiving;
          if (!r || !r.notices.some((n) => n.id === id && !n.seen)) return;
          set({ receiving: { ...r, notices: r.notices.map((n) => (n.id === id ? { ...n, seen: true as const } : n)) } });
        },

        keepFloor: (floored, companyId) => {
          const r = get().receiving;
          if (!r || !floored.length || companyId !== get().syncedWith || companyId !== r.company) return;
          const marks = { ...r.sent };
          const now = Date.now();
          const said: { id: string; at: number; words: string }[] = [];
          let equipment = get().equipment;
          for (const { key, rev, floor } of floored) {
            delete marks[key];
            const id = key.slice('equipment:'.length);
            const unit = equipment.find((e) => e.id === id);
            if (!unit) continue;
            // The server's status, raised to the floor: either the server's version again, or a raise sent next round.
            const status = worseStatus(r.units[id]?.status ?? floor, floor);
            equipment = equipment.map((e) => (e.id === id ? { ...e, status } : e));
            said.push({ id: `${key}@floor@${rev}`, at: now, words: floorWords(unit.unit, floor) });
          }
          set({ equipment, receiving: { ...r, sent: marks, notices: withNotices(r.notices, said, now) } });
        },

        connectCompany: (company, account) => {
          const { synced, syncedWith } = get();
          const problem = connectProblem(syncedWith, synced, company.id);
          if (problem) return { ok: false, error: problem };
          const linked: ConnectedCompany = {
            id: company.id,
            name: company.name,
            role: company.role,
            ...(account ? { userId: account.id, email: account.email } : null),
          };
          // What another company's server was told about counts for nothing here: everything is sent to this one.
          set({ connectedCompany: linked, joinAsked: null, ...(syncedWith !== company.id ? { synced: {}, syncedWith: company.id } : null) });
          return { ok: true };
        },

        confirmConnection: ({ userId, email, role, name }) => {
          const linked = get().connectedCompany;
          if (!linked) return;
          if (linked.userId === userId && linked.email === email && linked.role === role && linked.name === name) return;
          set({ connectedCompany: { ...linked, userId, email, role, name } });
        },

        disconnectCompany: () => set({ connectedCompany: null }),

        signInDeleted: () => {
          const { receiving, employees } = get();
          if (!receiving) return;
          const next = signInGone({ employees, receiving });
          set({ employees: next.employees as Employee[], receiving: next.receiving });
        },

        setJoinAsked: (joinAsked) => set({ joinAsked }),

        // ---- Paid leave and the pay estimate ----------------------------------------------
        addLeave: ({ employeeId, day, type, hours, note }) => {
          const { session, employees, leave } = get();
          if (!session) return { ok: false, error: 'You are signed out.' };
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can record paid leave.' };
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
          // The same rule as adding it: paid leave is a supervisor's entry to make or undo.
          if (!isSupervisor()) return { ok: false, error: 'Only a supervisor can take off paid leave.' };
          set({ leave: get().leave.filter((entry) => entry.id !== leaveId) });
          return { ok: true };
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
      // A device that has opened a preview with the sample crew has their sample history saved.
      // A build without them keeps its own records somewhere else, so it never opens onto that.
      // These keys predate the MineMuster name. They stay as they are, so a device keeps what it has saved.
      name: HOLDS_SAMPLES ? 'us-mine-crew' : 'us-mine-crew-records',
      version: STATE_VERSION,
      migrate: (saved, fromVersion) => migratePersisted(saved, fromVersion, HOLDS_SAMPLES, STARTING_COMPANY, STARTING_SITE) as unknown as Store,
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ session, employees, accounts, shifts, leave, denied, equipment, inspections, opLogs, areaSheets, exams, mrfs, mrfSeq, payRates, settings, seededAt, synced, syncedWith, connectedCompany, joinAsked, receiving }) => ({
        session, employees, accounts, shifts, leave, denied, equipment, inspections, opLogs, areaSheets, exams, mrfs, mrfSeq, payRates, settings, seededAt, synced, syncedWith, connectedCompany, joinAsked, receiving,
      }),
      onRehydrateStorage: () => (state) => {
        state?.readUnreadableAgain();
        state?.setHydrated();
      },
    },
  ),
);

// ---- Lookups used across screens ---------------------------------------------------------

/** The hours rules of the state the company is in. */
export function useRules(): TimeRules {
  return rulesFor(useStore((s) => s.settings.company.state));
}

export function useMe(): Employee | undefined {
  return useStore((s) => s.employees.find((e) => e.id === s.session?.employeeId));
}

/**
 * Whether the person signed in has a supervisor's powers on this phone: the
 * store's own rule (supervisorHere). On a phone connected to its company, the
 * phone's company sign-in decides too, so a screen never reads a power from
 * the person's role alone.
 */
export function useSupervisorHere(): boolean {
  return useStore((s) => supervisorHere({ session: s.session, employees: s.employees, connected: !!s.connectedCompany, receiving: s.receiving }));
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
