import { destination, toGeoStamp } from '../domain/geofence';
import { DEFAULT_SITE } from '../domain/site';
import { inspectionResult, templateFor, templateItems } from '../domain/templates';
import { CA_RULES, startedLunch } from '../domain/time';
import type {
  Account,
  Employee,
  Equipment,
  EquipmentCategory,
  GeoStamp,
  Inspection,
  InspectionAnswer,
  LeaveEntry,
  Mrf,
  OperatingLog,
  Punch,
  Role,
  Settings,
  Shift,
} from '../domain/types';
import { addDays, HOUR, MIN, startOfDay } from '../util/format';
import { seededRandom } from '../util/hash';

/**
 * Sample crew, fleet and history so every screen has something to show: about
 * five weeks of time punches (enough to look back over a whole pay period) and
 * two weeks of pre-ops. All names, unit numbers and pay figures are made up.
 * "Today" is generated relative to the moment the demo starts, so there is
 * always a crew on the clock.
 */

export const DEMO_EMPLOYEE_ID = 'emp_demo';
export const DEMO_SUPERVISOR_ID = 'sup_demo';

/** Days of time punches to generate. The start of the last full pay period is at most 30 days back. */
const HISTORY_DAYS = 36;
/** Workdays of pre-ops and operating sheets to generate. */
const PREOP_WORKDAYS = 12;

export interface SeedData {
  employees: Employee[];
  accounts: Account[];
  shifts: Shift[];
  leave: LeaveEntry[];
  equipment: Equipment[];
  inspections: Inspection[];
  opLogs: OperatingLog[];
  mrfs: Mrf[];
  mrfSeq: number;
  /** Hourly rate each person entered for their own pay estimate, in cents. */
  payRates: Record<string, number>;
}

type CrewRow = [id: string, first: string, last: string, role: Role, title: string, unit?: string];

const CREW: CrewRow[] = [
  [DEMO_EMPLOYEE_ID, 'Jordan', 'Rivera', 'employee', 'Loader Operator', 'L-12'],
  [DEMO_SUPERVISOR_ID, 'Casey', 'Morgan', 'supervisor', 'Safety & Operations Supervisor'],
  ['e03', 'Miguel', 'Torres', 'employee', 'Haul Truck Driver', 'HT-21'],
  ['e04', 'Dana', 'Whitfield', 'employee', 'Plant Operator', 'FK-06'],
  ['e05', 'Luis', 'Herrera', 'employee', 'Excavator Operator', 'EX-07'],
  ['e06', 'Tyler', 'Brooks', 'employee', 'Mechanic', 'PU-31'],
  ['e07', 'Sam', 'Nakamura', 'employee', 'Water Truck Driver', 'WT-01'],
  ['e08', 'Ray', 'Dalton', 'employee', 'Dozer Operator', 'D-03'],
  ['e09', 'Angela', 'Ruiz', 'employee', 'Lab / QC Technician'],
  ['e10', 'Marcus', 'Bell', 'employee', 'Laborer', 'SS-04'],
  ['e11', 'Hannah', 'Cole', 'employee', 'Scale House'],
  ['e12', 'Pete', 'Lawson', 'employee', 'Grader Operator', 'G-02'],
  ['e13', 'Brooke', 'Jensen', 'employee', 'Loader Operator', 'L-15'],
  ['e14', 'Eddie', 'Vasquez', 'supervisor', 'Maintenance Lead', 'PU-34'],
];

type FleetRow = [unit: string, category: EquipmentCategory, make: string, model: string, meter: number];

const FLEET: FleetRow[] = [
  ['L-12', 'loader', 'CAT', '980M', 11842.6],
  ['L-15', 'loader', 'Komatsu', 'WA500-8', 7310.2],
  ['HT-21', 'haul_truck', 'CAT', '745', 9120.4],
  ['HT-24', 'haul_truck', 'Volvo', 'A40G', 5488.9],
  ['EX-07', 'excavator', 'Komatsu', 'PC360LC-11', 6204.7],
  ['EX-09', 'excavator', 'CAT', '349', 3977.3],
  ['D-03', 'dozer', 'CAT', 'D8T', 14230.8],
  ['G-02', 'grader', 'CAT', '140M3', 8765.1],
  ['WT-01', 'water_truck', 'Kenworth', 'T800 4,000 gal', 10344.5],
  ['SS-04', 'skid_steer', 'Bobcat', 'S770', 2890.3],
  ['FK-06', 'forklift', 'Hyster', 'H80FT', 4120.6],
  ['TH-05', 'forklift', 'CAT', 'TL1055D', 3301.9],
  ['PU-31', 'light_vehicle', 'Ford', 'F-250', 48210],
  ['PU-34', 'light_vehicle', 'Chevrolet', 'Silverado 2500', 61877],
];

const AREAS: Partial<Record<EquipmentCategory, string>> = {
  loader: 'Stockpiles',
  haul_truck: 'Haul road',
  excavator: 'Pit',
  dozer: 'Pit',
  grader: 'Haul road',
  water_truck: 'Haul road',
  skid_steer: 'Plant',
  forklift: 'Plant',
  light_vehicle: 'Shop / yard',
};

export function defaultSettings(demo: boolean): Settings {
  return {
    site: DEFAULT_SITE,
    workweekStartsOn: 0,
    lunchReminders: true,
    allowSectionAllOk: true,
    demoLocation: demo ? 'at_mine' : 'gps',
  };
}

/** The roster and fleet with no history — what a fresh production install starts from. */
export function emptyData(): SeedData {
  return {
    employees: [], accounts: [], shifts: [], leave: [], equipment: [],
    inspections: [], opLogs: [], mrfs: [], mrfSeq: 1001, payRates: {},
  };
}

export function buildDemoData(now: number): SeedData {
  const rand = seededRandom(5626);
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const site = DEFAULT_SITE;

  const onSite = (): GeoStamp =>
    toGeoStamp(site, { ...destination(site.center, between(-420, 420), between(-380, 300)), accuracyM: between(4, 12) }, 'gps');
  const offSite = (): GeoStamp =>
    toGeoStamp(site, { ...destination(site.center, 1090, 2020), accuracyM: 9 }, 'gps');
  const punch = (at: number): Punch => ({ at, geo: onSite() });

  const employees: Employee[] = CREW.map(([id, firstName, lastName, role, title]) => ({
    id, firstName, lastName, role, title, active: true,
  }));
  const unitOf = new Map(CREW.filter((c) => c[5]).map((c) => [c[0], c[5] as string]));

  const providers = ['password', 'google', 'microsoft', 'apple'] as const;
  const accounts: Account[] = CREW.filter(([id]) => !['e11', 'e12', 'e09'].includes(id)).map(
    ([id, first, last], i) => ({
      id: `acct_${id}`,
      employeeId: id,
      email: `${first}.${last}@example.com`.toLowerCase(),
      provider: providers[i % providers.length],
      createdAt: now - between(20, 60) * 24 * HOUR,
    }),
  );

  const equipment: Equipment[] = FLEET.map(([unit, category, make, model, meter]) => ({
    id: `eq_${unit}`,
    unit,
    category,
    make,
    model,
    status: 'ready',
    meter,
    meterUnit: category === 'light_vehicle' ? 'mi' : 'hrs',
  }));
  const byUnit = new Map(equipment.map((e) => [e.unit, e]));

  const shifts: Shift[] = [];
  const leave: LeaveEntry[] = [];
  const inspections: Inspection[] = [];
  const opLogs: OperatingLog[] = [];
  const mrfs: Mrf[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}_${(seq++).toString(36)}`;

  const allOk = (category: EquipmentCategory, overrides: Record<string, Partial<InspectionAnswer>> = {}) =>
    templateItems(templateFor(category)).map((i): InspectionAnswer => ({
      itemId: i.id,
      answer: i.id === 'cab_radio' && category === 'forklift' ? 'na' : 'ok',
      ...overrides[i.id],
    }));

  /** Record a pre-op and, unless the unit was parked, the operating sheet that follows it. */
  function runUnit(opts: {
    employeeId: string;
    unit: string;
    inspectAt: number;
    endAt?: number;
    overrides?: Record<string, Partial<InspectionAnswer>>;
    decision?: 'operate' | 'parked';
    operate?: boolean;
  }): Inspection {
    const eq = byUnit.get(opts.unit)!;
    const template = templateFor(eq.category);
    const answers = allOk(eq.category, opts.overrides);
    const result = inspectionResult(template, answers);
    const inspection: Inspection = {
      id: nextId('insp'),
      equipmentId: eq.id,
      employeeId: opts.employeeId,
      templateId: template.id,
      templateVersion: template.version,
      startedAt: opts.inspectAt - between(4, 7) * MIN,
      submittedAt: opts.inspectAt,
      meter: eq.meter,
      area: AREAS[eq.category],
      answers,
      result,
      decision: opts.decision,
    };
    inspections.push(inspection);
    const operate = opts.operate ?? (result === 'pass' || opts.decision === 'operate');
    if (operate) {
      const log: OperatingLog = {
        id: nextId('op'),
        equipmentId: eq.id,
        employeeId: opts.employeeId,
        inspectionId: inspection.id,
        startAt: opts.inspectAt + MIN,
        startMeter: eq.meter,
        area: AREAS[eq.category],
      };
      if (opts.endAt) {
        const hours = (opts.endAt - log.startAt) / HOUR;
        const used = eq.meterUnit === 'mi' ? between(14, 46) : Math.round(hours * (0.72 + rand() * 0.16) * 10) / 10;
        eq.meter = Math.round((eq.meter + used) * 10) / 10;
        log.endAt = opts.endAt;
        log.endMeter = eq.meter;
        log.parkedSafely = true;
        if (eq.meterUnit === 'hrs' && rand() < 0.3) log.fuelGal = between(28, 96);
      }
      opLogs.push(log);
    }
    return inspection;
  }

  // ---- History ---------------------------------------------------------------------------
  // Workdays (Monday to Saturday), oldest first. `back` counts workdays before today,
  // so the examples below land on a real workday whatever day of the week the demo
  // is opened.
  const today = startOfDay(now);
  const workdays: number[] = [];
  for (let d = HISTORY_DAYS; d >= 1; d--) {
    const day = addDays(today, -d);
    if (new Date(day).getDay() !== 0) workdays.push(day);
  }
  const SCENARIOS: Record<string, number[]> = {
    e12: [1], e13: [1], e08: [2], e03: [3, 6], e04: [4], e10: [5], e05: [7],
  };
  /** A day of paid leave in place of a shift: [workdays back, type]. */
  const TIME_OFF: Record<string, [number, LeaveEntry['type']]> = { e11: [3, 'pto'], e07: [6, 'sick'] };

  for (let w = 0; w < workdays.length; w++) {
    const day = workdays[w];
    const back = workdays.length - w;
    const weekday = new Date(day).getDay();

    for (const [id, , , , title] of CREW) {
      if (TIME_OFF[id]?.[0] === back) {
        leave.push({
          id: nextId('lv'), employeeId: id, day, type: TIME_OFF[id][1], hours: 800,
          enteredBy: DEMO_SUPERVISOR_ID, at: day + 16 * HOUR,
        });
        continue;
      }
      const scripted = SCENARIOS[id]?.includes(back) ?? false;
      const saturday = weekday === 6 && !scripted;
      const roll = rand();
      if (!scripted && (saturday ? roll > 0.3 : roll < 0.05)) continue;

      const office = title === 'Scale House' || title.startsWith('Lab');
      const start = day + (office ? 7 : 6) * HOUR + between(-11, 14) * MIN;
      // One tap starts lunch; it ends by itself 30 minutes later.
      const lunch = startedLunch(punch(start + 4 * HOUR + between(0, 38) * MIN));
      const paid = saturday ? between(300, 380) : rand() < 0.12 ? between(540, 610) : between(468, 496);
      let end = start + paid * MIN + CA_RULES.mealMinMs;

      const shift: Shift = {
        id: nextId('sh'),
        employeeId: id,
        clockIn: punch(start),
        clockOut: punch(end),
        lunches: [lunch],
        breaks: [],
      };

      // A handful of realistic exceptions for payroll and safety to review.
      if (id === 'e03' && back === 3) {
        shift.lunches = [startedLunch(punch(start + 5 * HOUR + 12 * MIN))];
      }
      if (id === 'e10' && back === 5) {
        shift.lunches = [];
        shift.mealNote = 'worked_through';
        end = start + 8 * HOUR + 6 * MIN;
        shift.clockOut = punch(end);
      }
      if (id === 'e08' && back === 2) {
        shift.clockOut = { at: end + 9 * MIN, geo: offSite() };
        end += 9 * MIN;
      }
      if (id === 'e05' && back === 7) {
        end = start + 11 * HOUR + 4 * MIN;
        shift.clockOut = punch(end);
      }
      if (id === 'e04' && back === 4) {
        shift.edits = [{
          at: end + 17 * HOUR,
          byEmployeeId: DEMO_SUPERVISOR_ID,
          field: 'clockOut',
          from: undefined,
          to: end,
          reason: 'Forgot to clock out — confirmed with plant lead',
        }];
        shift.clockOut = { at: end, geo: undefined };
      }
      if (id === 'e12' && back === 1) {
        shift.clockOut = undefined;
      }
      shifts.push(shift);

      // Pre-op and operating sheet for people who run a unit, for the recent workdays.
      const unit = unitOf.get(id);
      if (!unit || back > PREOP_WORKDAYS) continue;
      const inspectAt = start + between(6, 14) * MIN;
      const parkAt = end - between(6, 14) * MIN;

      if (id === 'e03' && back === 6) {
        const bad = runUnit({
          employeeId: id, unit: 'HT-21', inspectAt,
          overrides: { fn_backup: { answer: 'bo', note: 'Backup alarm silent in reverse' } },
        });
        const mrf: Mrf = {
          id: nextId('mrf'), number: 1041, equipmentId: bad.equipmentId, requestedBy: id,
          createdAt: inspectAt + 3 * MIN, priority: 'safety',
          description: 'Backup alarm does not sound when reverse is selected.',
          items: [{ label: 'Backup alarm', note: 'Backup alarm silent in reverse', cfr: '56.14132' }],
          meter: bad.meter, location: 'Bad-order row, north of shop', taggedOut: true,
          inspectionId: bad.id, status: 'completed',
          history: [
            { at: inspectAt + 3 * MIN, by: id, status: 'open' },
            { at: inspectAt + 55 * MIN, by: 'e06', status: 'in_progress', note: 'Alarm unit failed. Pulling a replacement from stock.' },
            { at: inspectAt + 3 * HOUR, by: 'e06', status: 'completed', note: 'Replaced backup alarm and tested in reverse. Returned to service.' },
          ],
        };
        bad.mrfId = mrf.id;
        mrfs.push(mrf);
        runUnit({ employeeId: id, unit: 'HT-24', inspectAt: inspectAt + 22 * MIN, endAt: parkAt });
        continue;
      }

      if (id === 'e13' && back === 1) {
        const defect = runUnit({
          employeeId: id, unit, inspectAt, endAt: parkAt, decision: 'operate',
          overrides: { ld_cyl: { answer: 'bo', note: 'Oil seep at left lift cylinder rod seal' } },
        });
        const mrf: Mrf = {
          id: nextId('mrf'), number: 1042, equipmentId: defect.equipmentId, requestedBy: id,
          createdAt: inspectAt + 4 * MIN, priority: 'high',
          description: 'Hydraulic oil seeping at the left lift cylinder rod seal. Level is holding.',
          items: [{ label: 'Hydraulic cylinders and hoses', note: 'Oil seep at left lift cylinder rod seal' }],
          meter: defect.meter, location: 'Working — stockpiles', taggedOut: false,
          inspectionId: defect.id, status: 'in_progress',
          history: [
            { at: inspectAt + 4 * MIN, by: id, status: 'open' },
            { at: inspectAt + 2 * HOUR, by: 'e14', status: 'in_progress', note: 'Seal kit ordered. OK to run; check hydraulic level each pre-op.' },
          ],
        };
        defect.mrfId = mrf.id;
        mrfs.push(mrf);
        byUnit.get(unit)!.status = 'defect';
        continue;
      }

      runUnit({ employeeId: id, unit, inspectAt, endAt: shift.clockOut ? parkAt : end - 10 * MIN });
    }
  }

  // ---- Today: a crew on the clock at different points in their shift ------------------------
  // `lunchAtMin` is how far into the shift lunch started. Sam Nakamura (e07) started
  // 14 minutes ago, so he is the one at lunch; the others' lunches are long over.
  type Live = [id: string, inAgoMin: number, lunchAtMin?: number];
  const live: Live[] = [
    ['e03', 190],
    ['e13', 262],
    ['e05', 284],
    ['e10', 318],
    ['e07', 290, 276],
    ['e08', 365, 255],
    ['e04', 390, 250],
    ['e06', 340, 270],
    ['e14', 370, 262],
    ['e09', 125],
    [DEMO_SUPERVISOR_ID, 380, 258],
  ];
  for (const [id, inAgo, lunchAt] of live) {
    const start = now - inAgo * MIN - between(0, 40) * 1000;
    const shift: Shift = { id: nextId('sh'), employeeId: id, clockIn: punch(start), lunches: [], breaks: [] };
    if (lunchAt != null) shift.lunches.push(startedLunch(punch(start + lunchAt * MIN)));
    shifts.push(shift);

    const unit = unitOf.get(id);
    if (!unit) continue;
    const inspectAt = start + between(6, 11) * MIN;

    if (id === 'e05') {
      const bad = runUnit({
        employeeId: id, unit: 'EX-09', inspectAt,
        overrides: { cab_belt: { answer: 'bo', note: 'Webbing frayed at the latch plate' } },
      });
      const mrf: Mrf = {
        id: nextId('mrf'), number: 1043, equipmentId: bad.equipmentId, requestedBy: id,
        createdAt: inspectAt + 2 * MIN, priority: 'safety',
        description: 'Seat belt webbing is frayed at the latch plate. Belt needs to be replaced.',
        items: [{ label: 'Seat belt', note: 'Webbing frayed at the latch plate', cfr: '56.14130' }],
        meter: bad.meter, location: 'Parked at pit entrance, tagged', taggedOut: true,
        inspectionId: bad.id, status: 'open',
        history: [{ at: inspectAt + 2 * MIN, by: id, status: 'open' }],
      };
      bad.mrfId = mrf.id;
      mrfs.push(mrf);
      byUnit.get('EX-09')!.status = 'out_of_service';
      runUnit({ employeeId: id, unit: 'EX-07', inspectAt: inspectAt + 16 * MIN });
      continue;
    }
    runUnit({ employeeId: id, unit, inspectAt });
  }

  return {
    employees, accounts, shifts, leave, equipment, inspections, opLogs, mrfs, mrfSeq: 1044,
    // A made-up rate so the sample employee's pay estimate has something to show.
    payRates: { [DEMO_EMPLOYEE_ID]: 2800 },
  };
}
