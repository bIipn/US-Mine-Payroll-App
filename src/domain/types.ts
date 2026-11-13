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
  /** Last recorded hour meter or odometer. */
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
  /** A Bad Order here always takes the unit out of service. */
  critical?: boolean;
}

export interface ChecklistSection {
  id: string;
  title: string;
  items: ChecklistItem[];
}

export interface ChecklistTemplate {
  id: string;
  title: string;
  version: number;
  sections: ChecklistSection[];
}

export type Answer = 'ok' | 'bo' | 'na';

export interface InspectionAnswer {
  itemId: string;
  answer: Answer;
  note?: string;
  /** Operator judged a non-critical defect unsafe to run with. */
  hazard?: boolean;
}

export type InspectionResult = 'pass' | 'defect' | 'bad_order';

export interface Inspection {
  id: string;
  equipmentId: string;
  employeeId: string;
  templateId: string;
  templateVersion: number;
  startedAt: number;
  submittedAt: number;
  meter: number;
  area?: string;
  answers: InspectionAnswer[];
  result: InspectionResult;
  mrfId?: string;
  /** What the operator did after a non-hazardous defect. */
  decision?: 'operate' | 'parked';
}

/** Equipment operating sheet: who ran which unit, when, and the meter readings. */
export interface OperatingLog {
  id: string;
  equipmentId: string;
  employeeId: string;
  inspectionId: string;
  startAt: number;
  startMeter: number;
  area?: string;
  endAt?: number;
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

/** Maintenance Request Form. */
export interface Mrf {
  id: string;
  number: number;
  equipmentId: string;
  requestedBy: string;
  createdAt: number;
  priority: MrfPriority;
  description: string;
  items: MrfItem[];
  meter?: number;
  location?: string;
  taggedOut: boolean;
  inspectionId?: string;
  status: MrfStatus;
  history: { at: number; by: string; status: MrfStatus; note?: string }[];
}

export interface SiteConfig {
  name: string;
  center: LatLng;
  radiusM: number;
  /** Optional surveyed boundary. When present it replaces the circle. */
  polygon?: LatLng[];
}

export type DemoLocation = 'gps' | 'at_mine' | 'in_town';

export interface Settings {
  site: SiteConfig;
  /** 0 = Sunday. */
  workweekStartsOn: number;
  lunchReminders: boolean;
  allowSectionAllOk: boolean;
  demoLocation: DemoLocation;
}
