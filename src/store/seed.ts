import { AREA_CONDITIONS, buildExam, SAMPLE_AREA_SHEETS, shiftAt, withFix, withMrf, type ExamDraft } from '../domain/areaExam';
import { destination, toGeoStamp } from '../domain/geofence';
import { keptApart, type PersonName } from '../domain/roster';
import { DEFAULT_SITE } from '../domain/site';
import { checklistFor, inspectionResult } from '../domain/templates';
import { CA_RULES, startedLunch } from '../domain/time';
import type {
  Account,
  AreaExam,
  AreaSheet,
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
 * two weeks of equipment checklists and pre shift exams. All names, unit
 * numbers and pay figures are made up.
 * "Today" is generated relative to the moment the demo starts, so there is
 * always a crew on the clock.
 */

export const DEMO_EMPLOYEE_ID = 'emp_demo';
export const DEMO_SUPERVISOR_ID = 'sup_demo';

/** Days of time punches to generate. The start of the last full pay period is at most 30 days back. */
const HISTORY_DAYS = 36;
/** Workdays of equipment checklists and pre shift exams to generate. */
const PREOP_WORKDAYS = 12;

export interface SeedData {
  employees: Employee[];
  accounts: Account[];
  shifts: Shift[];
  leave: LeaveEntry[];
  equipment: Equipment[];
  inspections: Inspection[];
  opLogs: OperatingLog[];
  /** The work-area sheets people can make a pre shift exam on. */
  areaSheets: AreaSheet[];
  exams: AreaExam[];
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

/** The made-up people the sample hours and records belong to. */
export const SAMPLE_CREW_IDS: ReadonlySet<string> = new Set(CREW.map(([id]) => id));

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

/** Lines of the card that do not apply to a type of machine, so the sample cards mark them N/A. */
const ON_TRACKS: EquipmentCategory[] = ['excavator', 'dozer'];
const HAS_BED: EquipmentCategory[] = ['haul_truck', 'light_vehicle'];
const notOn = (category: EquipmentCategory, line: string) =>
  (ON_TRACKS.includes(category) && (line === 'tires' || line === 'wheel_chocks')) ||
  (line === 'bed_condition' && !HAS_BED.includes(category));

const CARD_COMMENTS = ['Greased the pins', 'Washed the windshield', 'Topped off the coolant', 'Blew out the air filter'];

/** Who examines which work area: the first sheet, the second, the third, and round again. */
const EXAMINERS = ['e10', 'e04', 'e09'];
/** Conditions an area under a roof does not have, so the sample exams on its sheet mark them N/A. */
const INDOORS_NA = ['berms', 'pulleys', 'belt_components', 'estops', 'mobile_equipment', 'haul_roads'];
/** An area that is a room or a shed, going by the name on its sheet. */
const indoors = (sheet: AreaSheet) => /\b(lab|laboratory|office|shed)\b/i.test(sheet.title);

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
    inspections: [], opLogs: [], areaSheets: [], exams: [], mrfs: [], mrfSeq: 1001, payRates: {},
  };
}

/**
 * `sheets` are the work-area sheets the sample exams are made on: the build's
 * own when it names some, otherwise the made-up samples.
 *
 * `named` are the real people the build puts on its roster. A sample person with
 * the last name of one of them starts under a spare one, so nobody takes the
 * made-up hours for theirs.
 */
export function buildDemoData(now: number, sheets: AreaSheet[] = SAMPLE_AREA_SHEETS, named: PersonName[] = []): SeedData {
  const rand = seededRandom(5626);
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  // A second stream for the details on the cards and exams, so they never shift the punches.
  const extra = seededRandom(1848);
  const pick = (min: number, max: number) => min + Math.floor(extra() * (max - min + 1));
  const site = DEFAULT_SITE;

  const onSite = (): GeoStamp =>
    toGeoStamp(site, { ...destination(site.center, between(-420, 420), between(-380, 300)), accuracyM: between(4, 12) }, 'gps');
  const offSite = (): GeoStamp =>
    toGeoStamp(site, { ...destination(site.center, 1090, 2020), accuracyM: 9 }, 'gps');
  const punch = (at: number): Punch => ({ at, geo: onSite() });

  const employees: Employee[] = keptApart(
    CREW.map(([id, firstName, lastName, role, title]): Employee => ({ id, firstName, lastName, role, title, active: true })),
    named,
  );
  const unitOf = new Map(CREW.filter((c) => c[5]).map((c) => [c[0], c[5] as string]));

  const providers = ['password', 'google', 'microsoft', 'apple'] as const;
  const accounts: Account[] = employees.filter(({ id }) => !['e11', 'e12', 'e09'].includes(id)).map(
    ({ id, firstName, lastName }, i) => ({
      id: `acct_${id}`,
      employeeId: id,
      email: `${firstName}.${lastName}@example.com`.toLowerCase(),
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
    checklistFor(category).items.map((i): InspectionAnswer => ({
      itemId: i.id,
      answer: notOn(category, i.id) ? 'na' : 'ok',
      ...overrides[i.id],
    }));

  /** Record a unit on someone's checklist card and, unless it was parked, the hours they ran it. */
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
    const template = checklistFor(eq.category);
    const answers = allOk(eq.category, opts.overrides);
    const result = inspectionResult(template, answers);
    const fueled = eq.meterUnit === 'hrs' && extra() < 0.12;
    const wrote = extra() < 0.07;
    const inspection: Inspection = {
      id: nextId('insp'),
      equipmentId: eq.id,
      employeeId: opts.employeeId,
      templateId: template.id,
      templateVersion: template.version,
      startedAt: opts.inspectAt - between(4, 7) * MIN,
      submittedAt: opts.inspectAt,
      meter: eq.meter,
      answers,
      result,
      fuelGal: fueled ? pick(10, 45) : undefined,
      comments: wrote ? CARD_COMMENTS[pick(0, CARD_COMMENTS.length - 1)] : undefined,
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

      // The equipment card of people who run a unit, for the recent workdays.
      const unit = unitOf.get(id);
      if (!unit || back > PREOP_WORKDAYS) continue;
      const inspectAt = start + between(6, 14) * MIN;
      const parkAt = end - between(6, 14) * MIN;

      if (id === 'e03' && back === 6) {
        const bad = runUnit({
          employeeId: id, unit: 'HT-21', inspectAt,
          overrides: { backup_alarm_horn: { answer: 'bo', note: 'Backup alarm silent in reverse' } },
        });
        const remarks = 'Replaced backup alarm and tested in reverse. Returned to service.';
        const mrf: Mrf = {
          id: nextId('mrf'), number: 1041, equipmentId: bad.equipmentId, requestedBy: id,
          createdAt: inspectAt + 3 * MIN, priority: 'safety',
          description: 'Backup alarm does not sound when reverse is selected.',
          items: [{ label: 'Backup alarm / horn', note: 'Backup alarm silent in reverse', cfr: '56.14132' }],
          meter: bad.meter, location: 'Bad-order row, north of shop', taggedOut: true,
          inspectionId: bad.id, status: 'completed',
          assignedTo: 'e06', completedAt: inspectAt + 3 * HOUR, completedBy: 'e06', timeSpent: 225, remarks,
          history: [
            { at: inspectAt + 3 * MIN, by: id, status: 'open' },
            { at: inspectAt + 20 * MIN, by: 'e14', status: 'open', assignedTo: 'e06' },
            { at: inspectAt + 55 * MIN, by: 'e06', status: 'in_progress', note: 'Alarm unit failed. Pulling a replacement from stock.' },
            { at: inspectAt + 3 * HOUR, by: 'e06', status: 'completed', note: remarks },
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
          overrides: { hyd_cyl_hoses: { answer: 'bo', note: 'Oil seep at left lift cylinder rod seal' } },
        });
        const mrf: Mrf = {
          id: nextId('mrf'), number: 1042, equipmentId: defect.equipmentId, requestedBy: id,
          createdAt: inspectAt + 4 * MIN, priority: 'high',
          description: 'Hydraulic oil seeping at the left lift cylinder rod seal. Level is holding.',
          items: [{ label: 'Hyd. cyl/hoses', note: 'Oil seep at left lift cylinder rod seal', cfr: '56.4102' }],
          meter: defect.meter, location: 'Working at the stockpiles', taggedOut: false,
          inspectionId: defect.id, status: 'in_progress', assignedTo: 'e06',
          history: [
            { at: inspectAt + 4 * MIN, by: id, status: 'open' },
            { at: inspectAt + 70 * MIN, by: 'e14', status: 'open', assignedTo: 'e06' },
            { at: inspectAt + 2 * HOUR, by: 'e14', status: 'in_progress', note: 'Seal kit ordered. OK to run; check the hydraulic level every morning.' },
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

    if (id === 'e13') {
      // The seep found on the last workday is still there. Its request is in and the unit is
      // cleared to run, so the line is a Bad Order again and points at the same request.
      const waiting = mrfs.find((m) => m.number === 1042);
      const again = runUnit({
        employeeId: id, unit, inspectAt, decision: 'operate',
        overrides: { hyd_cyl_hoses: { answer: 'bo', note: 'Still seeping at the left lift cylinder rod seal. Level checked and holding.' } },
      });
      if (waiting) again.mrfId = waiting.id;
      continue;
    }

    if (id === 'e05') {
      const bad = runUnit({
        employeeId: id, unit: 'EX-09', inspectAt,
        overrides: { seatbelts: { answer: 'bo', note: 'Seat belt webbing frayed at the latch plate' } },
      });
      // Numbered after the request from this morning's exam, which was sent first.
      const mrf: Mrf = {
        id: nextId('mrf'), number: 1044, equipmentId: bad.equipmentId, requestedBy: id,
        createdAt: inspectAt + 2 * MIN, priority: 'safety',
        description: 'Seat belt webbing is frayed at the latch plate. Belt needs to be replaced.',
        items: [{ label: 'Seatbelts/DROPS/FOPS', note: 'Seat belt webbing frayed at the latch plate' }],
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

  // ---- Pre shift exams ------------------------------------------------------------------------
  // Each sheet has its examiner, who goes round the area a few minutes after clocking in. With
  // more sheets than examiners, an examiner goes round theirs one after another.
  // The first sheet is left unexamined today, so whoever opens the preview has one to do.
  const today0 = startOfDay(now);
  const clear = (sheet: AreaSheet, startedAt: number, clockedInAt: number): ExamDraft => ({
    sheetId: sheet.id,
    // The shift the examiner clocked in for, as the form would have started on.
    shift: shiftAt(clockedInAt),
    startedAt,
    rows: Object.fromEntries(sheet.rows.map((row) => [row.id, { answer: 'ok' as const }])),
    others: [],
    conditions: Object.fromEntries(
      AREA_CONDITIONS.map((c) => [c.id, { answer: indoors(sheet) && INDOORS_NA.includes(c.id) ? ('na' as const) : ('ok' as const) }]),
    ),
  });
  const firstExamDay = workdays[Math.max(0, workdays.length - PREOP_WORKDAYS)] ?? today0;
  let exams: AreaExam[] = [];
  /** When the examiner on a shift signed the last area they went round. */
  const lastSigned = new Map<string, number>();
  sheets.forEach((sheet, index) => {
    const examiner = EXAMINERS[index % EXAMINERS.length];
    const leftForToday = index === 0 && sheets.length > 1;
    for (const shift of shifts) {
      if (shift.employeeId !== examiner || shift.clockIn.at < firstExamDay) continue;
      if (leftForToday && shift.clockIn.at >= today0) continue;
      const submittedAt = (lastSigned.get(shift.id) ?? shift.clockIn.at) + pick(14, 26) * MIN;
      const startedAt = submittedAt - pick(6, 11) * MIN;
      lastSigned.set(shift.id, submittedAt);
      // An area they have not got round to yet is still to do.
      if (submittedAt > now) continue;
      const built = buildExam(sheet, clear(sheet, startedAt, shift.clockIn.at), {
        id: nextId('exam'), employeeId: examiner, submittedAt,
      });
      if (built.ok) exams.push(built.exam);
    }
  });
  exams.sort((a, b) => a.submittedAt - b.submittedAt);

  /** Rewrite one exam so it found something: the line gets a Bad Order and what was wrong. */
  const find = (exam: AreaExam, line: { row?: number; condition: string }, note: string): { exam: AreaExam; key: string } => {
    const row = line.row != null && exam.rows.length ? exam.rows[Math.min(line.row, exam.rows.length - 1)] : undefined;
    const found: AreaExam = row
      ? {
          ...exam,
          // In the guarding column, or on a sheet with one OK/BO column in all three cells, which hold the one answer.
          rows: exam.rows.map((r) =>
            r !== row ? r : exam.single ? { ...r, guarding: 'bo' as const, electrical: 'bo' as const, access: 'bo' as const, note } : { ...r, guarding: 'bo' as const, note },
          ),
        }
      : { ...exam, conditions: exam.conditions.map((c) => (c.id === line.condition ? { ...c, answer: 'bo' as const, note } : c)) };
    return { exam: found, key: row ? `row:${row.id}` : `cond:${line.condition}` };
  };
  const replace = (next: AreaExam) => {
    exams = exams.map((exam) => (exam.id === next.id ? next : exam));
  };
  const examsOn = (index: number, when: 'before' | 'today') =>
    exams.filter((exam) => exam.sheetId === sheets[Math.min(index, sheets.length - 1)]?.id && (when === 'today' ? exam.submittedAt >= today0 : exam.submittedAt < today0));

  // Found and put right on the spot, a few days ago.
  const earlier = examsOn(1, 'before');
  const tidy = earlier[Math.max(0, earlier.length - 5)];
  if (tidy) {
    const hose = find(tidy, { condition: 'ground' }, 'Wash-down hose left across the walkway');
    replace(withFix(hose.exam, hose.key, { at: tidy.submittedAt + 25 * MIN, by: tidy.employeeId, note: 'Rolled up the hose and hung it on the rack' }));
  }
  // Found on the last exam of the first area, and still open. That area is the one left for
  // today, so nobody has been round it since and no later exam says the line is fine.
  const lastOnFirst = exams.filter((exam) => exam.sheetId === sheets[0]?.id && exam.id !== tidy?.id).slice(-1)[0];
  if (lastOnFirst) replace(find(lastOnFirst, { condition: 'fire_extinguishers' }, 'Monthly tag has not been punched this month').exam);
  // Found this morning and sent to maintenance: the first request of the day.
  const thisMorning = examsOn(1, 'today')[0];
  if (thisMorning) {
    const guard = find(thisMorning, { row: 1, condition: 'pulleys' }, 'Guard is off the drive coupling');
    const line = guard.exam.rows.find((r) => `row:${r.id}` === guard.key);
    const mrf: Mrf = {
      id: nextId('mrf'), number: 1043, requestedBy: thisMorning.employeeId,
      createdAt: thisMorning.submittedAt + 4 * MIN, priority: 'high',
      location: line ? `${thisMorning.area}: ${line.label}` : thisMorning.area,
      description: 'Guard is off the drive coupling. The bolts are in the tray beside it.',
      items: [], taggedOut: false, examId: thisMorning.id, findingKey: guard.key, status: 'open',
      history: [{ at: thisMorning.submittedAt + 4 * MIN, by: thisMorning.employeeId, status: 'open' }],
    };
    mrfs.push(mrf);
    replace(withMrf(guard.exam, guard.key, mrf.id));
  }
  mrfs.sort((a, b) => a.number - b.number);

  return {
    employees, accounts, shifts, leave, equipment, inspections, opLogs, areaSheets: sheets, exams, mrfs,
    mrfSeq: Math.max(1040, ...mrfs.map((m) => m.number)) + 1,
    // A made-up rate so the sample employee's pay estimate has something to show.
    payRates: { [DEMO_EMPLOYEE_ID]: 2800 },
  };
}
