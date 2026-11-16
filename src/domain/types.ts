import type { Company } from './company';
/** Shared data model. Times are epoch milliseconds unless noted. */

export type Role = 'employee' | 'supervisor';

/** A roster entry. Only people on the roster can create an account. */
export interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  role: Role;
  title?: string;
  active: boolean;
  /** The person's number in the company's payroll system (ADP's "File #", for one). Set by a supervisor for the payroll file. */
  payrollId?: string;
}

export type AuthProvider = 'password' | 'apple' | 'google' | 'microsoft';

export interface Account {
  id: string;
  employeeId: string;
  email: string;
  provider: AuthProvider;
  /** Demo-mode only. Real builds never store a password on the device. */
  passwordHash?: string;
  salt?: string;
  createdAt: number;
}

export interface Session {
  accountId: string;
  employeeId: string;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** Where a punch happened, relative to the mine boundary. */
export interface GeoStamp extends LatLng {
  accuracyM: number | null;
  /** Distance from the centre of the site boundary, in metres. */
  distanceM: number;
  inside: boolean;
  /** The OS reported a simulated / spoofed location. */
  mocked?: boolean;
  source: 'gps' | 'demo' | 'manual';
}

export interface Punch {
  at: number;
  geo?: GeoStamp;
  /**
   * Set by the app rather than tapped: the end of a lunch, 30 minutes after it
   * started. No location is read for it.
   */
  auto?: boolean;
}

/**
 * An unpaid meal period. One tap starts it. It ends by itself 30 minutes later,
 * so `end` is written when the lunch starts and there is no punch to end it.
 */
export interface Lunch {
  start: Punch;
  end?: Punch;
}

export interface RestBreak {
  start: number;
  end?: number;
}

/** Why a shift has no compliant lunch on record. Chosen by the employee at clock-out. */
export type MealNote = 'forgot_punch' | 'worked_through' | 'waived_short_shift';

export interface ShiftEdit {
  at: number;
  byEmployeeId: string;
  field: 'clockIn' | 'clockOut' | 'lunchStart' | 'lunchEnd';
  from?: number;
  to?: number;
  reason: string;
}

export interface Shift {
  id: string;
  employeeId: string;
  clockIn: Punch;
  clockOut?: Punch;
  /** Unpaid meal periods. */
  lunches: Lunch[];
  /** Paid rest breaks. Logged for the record; never deducted. */
  breaks: RestBreak[];
  mealNote?: MealNote;
  edits?: ShiftEdit[];
}

/** Paid hours that are not worked. They show on the pay stub as their own lines. */
export type LeaveType = 'holiday' | 'pto' | 'sick';

export interface LeaveEntry {
  id: string;
  employeeId: string;
  /** The day the hours are for, at the start of the day. */
  day: number;
  type: LeaveType;
  /** Hundredths of an hour: 800 = 8.00. */
  hours: number;
  note?: string;
  enteredBy: string;
  at: number;
}

export type ShiftFlag =
  | 'late_lunch'
  | 'no_lunch'
  | 'short_lunch'
  | 'second_meal'
  | 'offsite_out'
  | 'missing_out'
  | 'edited'
  | 'mock_gps';

export interface DeniedPunch {
  id: string;
  employeeId: string;
  at: number;
  action: 'clock_in' | 'end_lunch';
  reason: 'outside' | 'weak_gps' | 'mocked';
  geo?: GeoStamp;
}

export type EquipmentCategory =
  | 'loader'
  | 'haul_truck'
  | 'excavator'
  | 'dozer'
  | 'grader'
  | 'water_truck'
  | 'skid_steer'
  | 'forklift'
  | 'light_vehicle';

export type EquipmentStatus = 'ready' | 'defect' | 'out_of_service';

export interface Equipment {
  id: string;
  unit: string;
  category: EquipmentCategory;
  make: string;
  model: string;
  status: EquipmentStatus;
  /** Last recorded equipment hours, or odometer. */
  meter: number;
  meterUnit: 'hrs' | 'mi';
}

export interface ChecklistItem {
  id: string;
  label: string;
  hint?: string;
  /** MSHA standard, a key into the standards table, e.g. "56.14101". */
  cfr?: string;
  /** Matching OSHA rule, e.g. "1926.602(a)(4)". */
  osha?: string;
  /** A safety item: a Bad Order here always takes the unit out of service. */
  critical?: boolean;
}

/** A checklist: its lines in the order they are printed on the paper. */
export interface ChecklistTemplate {
  id: string;
  title: string;
  version: number;
  items: ChecklistItem[];
}

/** OK, Bad Order, or not applicable: the three marks on every sheet. */
export type Answer = 'ok' | 'bo' | 'na';

export interface InspectionAnswer {
  itemId: string;
  answer: Answer;
  note?: string;
  /** Operator judged a non-critical defect unsafe to run with. */
  hazard?: boolean;
}

export type InspectionResult = 'pass' | 'defect' | 'bad_order';

/**
 * One piece of equipment on a person's Operator Equipment Checklist: a column
 * of the paper card.
 */
export interface Inspection {
  id: string;
  equipmentId: string;
  employeeId: string;
  templateId: string;
  templateVersion: number;
  startedAt: number;
  submittedAt: number;
  /** Equipment hours (or odometer) when the check was made: "Equp. hrs st" on the card. */
  meter: number;
  answers: InspectionAnswer[];
  result: InspectionResult;
  /** Gallons added, written on the Fuel line. */
  fuelGal?: number;
  /** The Comments box. */
  comments?: string;
  mrfId?: string;
  /** What the operator did after a non-hazardous defect. */
  decision?: 'operate' | 'parked';
}

/** Who ran which unit, when, and the equipment hours at the start and the end. */
export interface OperatingLog {
  id: string;
  equipmentId: string;
  employeeId: string;
  inspectionId: string;
  startAt: number;
  startMeter: number;
  endAt?: number;
  /** "Equp. hrs. end" on the card. */
  endMeter?: number;
  fuelGal?: number;
  notes?: string;
  parkedSafely?: boolean;
}

export type MrfPriority = 'safety' | 'high' | 'routine';
export type MrfStatus = 'open' | 'in_progress' | 'completed';

export interface MrfItem {
  label: string;
  note?: string;
  cfr?: string;
}

export interface MrfEvent {
  at: number;
  by: string;
  status: MrfStatus;
  note?: string;
  /** Set when this entry records who the request was assigned to. */
  assignedTo?: string;
}

/** Maintenance Request. The fields follow the paper form, in its order. */
export interface Mrf {
  id: string;
  number: number;
  /** By, and Date. */
  requestedBy: string;
  createdAt: number;
  /** Location: where the problem is. For a fleet unit, where the unit was left. */
  location?: string;
  /** The fleet unit the request is about, when it is about one. */
  equipmentId?: string;
  /** Problem. */
  description: string;
  priority: MrfPriority;
  items: MrfItem[];
  meter?: number;
  taggedOut: boolean;
  inspectionId?: string;
  /** The pre shift exam, and the line on it, that this request came from. */
  examId?: string;
  findingKey?: string;
  /** Assigned to. */
  assignedTo?: string;
  /** Date completed. */
  completedAt?: number;
  /** Time spent, in hundredths of an hour. */
  timeSpent?: number;
  /** Completed by. */
  completedBy?: string;
  /** Remarks. */
  remarks?: string;
  status: MrfStatus;
  history: MrfEvent[];
}

/** The three columns of a Pre Shift Exam sheet. */
export type ExamColumn = 'guarding' | 'electrical' | 'access';

export type ShiftName = 'day' | 'swing' | 'night';

/** A work-area sheet: the paper Pre Shift Exam for one part of the plant. */
export interface AreaSheet {
  id: string;
  title: string;
  rows: { id: string; label: string }[];
  active: boolean;
  /** The sheet has one OK/BO column for each line, in place of guarding, electrical and safe access. */
  single?: boolean;
}

/** What was done about a condition, and when: "Notes / Date fixed" on the sheet. */
export interface ExamFix {
  at: number;
  by: string;
  note?: string;
}

interface ExamLine {
  /** What is wrong. Required for a Bad Order. */
  note?: string;
  /** Someone could be hurt right now, so people stay out until it is fixed. */
  danger?: boolean;
  fixed?: ExamFix;
  mrfId?: string;
}

/** One line of the area sheet, with its three columns. */
export interface ExamRow extends ExamLine {
  id: string;
  /** The line as it read on the sheet when the exam was made. */
  label: string;
  guarding: Answer;
  electrical: Answer;
  access: Answer;
  /** Written in on an "Other (specify)" line. */
  other?: boolean;
}

/** One line of the conditions page: OK or Bad Order. */
export interface ExamCondition extends ExamLine {
  /** A key into the conditions list. */
  id: string;
  answer: Answer;
}

/** A Pre Shift Exam: one person's examination of one work area before a shift's work. */
export interface AreaExam {
  id: string;
  sheetId: string;
  /** The area's name when the exam was made. */
  area: string;
  employeeId: string;
  shift: ShiftName;
  startedAt: number;
  submittedAt: number;
  /** Made on a sheet with one OK/BO column. The three cells of each line then hold that one answer. */
  single?: boolean;
  rows: ExamRow[];
  conditions: ExamCondition[];
}

export interface SiteConfig {
  name: string;
  center: LatLng;
  radiusM: number;
  /** Optional surveyed boundary. When present it replaces the circle. */
  polygon?: LatLng[];
  /** The nearest town, to show how far the boundary stays from it. Optional. */
  town?: { name: string; center: LatLng };
}

export type DemoLocation = 'gps' | 'at_mine' | 'in_town';

export interface Settings {
  /** Who the crew works for: name, state, logo, pay periods. */
  company: Company;
  /** The clock-in boundary. None until it is set: then no one can clock in. */
  site: SiteConfig | null;
  /** 0 = Sunday. */
  workweekStartsOn: number;
  lunchReminders: boolean;
  allowSectionAllOk: boolean;
  demoLocation: DemoLocation;
}
