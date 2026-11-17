import type { RecordKind } from './server';

/**
 * Whether a record from the server is the shape the app writes, all the way
 * down. Any member of a company can send a record, and a phone with a bug can
 * send a wrong one; the app's own code reads them without checking, so one
 * record with a null where a list should be, or a status the app does not have,
 * would stop every page. A record that fails here is set aside and counted.
 *
 * A field the app leaves out may be missing. A field that is there has to be
 * the type the app writes: a null where the app writes nothing is not.
 */

type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === 'string';
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Missing, or passes the test. */
const opt = (v: unknown, test: (v: unknown) => boolean) => v === undefined || test(v);
const oneOf = (...values: string[]) => (v: unknown) => typeof v === 'string' && values.includes(v);
const listOf = (test: (v: unknown) => boolean) => (v: unknown) => Array.isArray(v) && v.every(test);

const ANSWER = oneOf('ok', 'bo', 'na');
const ROLE = oneOf('employee', 'supervisor');
const MRF_STATUS = oneOf('open', 'in_progress', 'completed');
const MRF_PRIORITY = oneOf('safety', 'high', 'routine');
export const CATEGORIES = ['loader', 'haul_truck', 'excavator', 'dozer', 'grader', 'water_truck', 'skid_steer', 'forklift', 'light_vehicle'];

const geo = (v: unknown) => isObj(v) && isBool(v.inside) && opt(v.distanceM, isNum);
const punch = (v: unknown) => isObj(v) && isNum(v.at) && opt(v.geo, geo) && opt(v.auto, isBool);
const lunch = (v: unknown) => isObj(v) && punch(v.start) && opt(v.end, punch);
const restBreak = (v: unknown) => isObj(v) && isNum(v.start) && opt(v.end, isNum);
const edit = (v: unknown) =>
  isObj(v) && isNum(v.at) && isStr(v.byEmployeeId) && oneOf('clockIn', 'clockOut', 'lunchStart', 'lunchEnd')(v.field) &&
  opt(v.from, isNum) && opt(v.to, isNum) && isStr(v.reason);
const answer = (v: unknown) => isObj(v) && isStr(v.itemId) && ANSWER(v.answer) && opt(v.note, isStr) && opt(v.hazard, isBool);
const fix = (v: unknown) => isObj(v) && isNum(v.at) && isStr(v.by) && opt(v.note, isStr);
const examLine = (v: Obj) => opt(v.note, isStr) && opt(v.danger, isBool) && opt(v.fixed, fix) && opt(v.mrfId, isStr);
const examRow = (v: unknown) =>
  isObj(v) && isStr(v.id) && isStr(v.label) && ANSWER(v.guarding) && ANSWER(v.electrical) && ANSWER(v.access) && opt(v.other, isBool) && examLine(v);
const examCondition = (v: unknown) => isObj(v) && isStr(v.id) && ANSWER(v.answer) && examLine(v);
const mrfItem = (v: unknown) => isObj(v) && isStr(v.label) && opt(v.note, isStr) && opt(v.cfr, isStr);
const mrfEvent = (v: unknown) => isObj(v) && isNum(v.at) && isStr(v.by) && MRF_STATUS(v.status) && opt(v.note, isStr) && opt(v.assignedTo, isStr);
const sheetRow = (v: unknown) => isObj(v) && isStr(v.id) && isStr(v.label);

const PAY_CODE_KEYS = ['regular', 'overtime', 'double', 'holiday', 'pto', 'sick'];
const logo = (v: unknown) => isObj(v) && (isStr(v.art) || isStr(v.uri));
const company = (v: unknown) =>
  isObj(v) &&
  opt(v.name, isStr) && opt(v.state, isStr) && opt(v.place, isStr) && opt(v.mineId, isStr) && opt(v.logo, logo) &&
  (v.pay === undefined || v.pay === null || isObj(v.pay)) &&
  opt(v.timeClock, (t) => t === false) &&
  opt(v.payCodes, (codes) => isObj(codes) && PAY_CODE_KEYS.every((k) => isStr(codes[k])));

/** The first thing wrong, said as what the record has not got. */
const first = (...checks: [boolean, string][]) => checks.find(([ok]) => !ok)?.[1];

/** What is wrong with a record for the app's code to read it, or undefined when it reads. */
export function problemWith(kind: RecordKind, d: Obj): string | undefined {
  switch (kind) {
    case 'settings':
      return first(
        [isObj(d.company), 'no company in it'],
        [company(d.company), 'a company that is not the shape the app writes'],
        [opt(d.workweekStartsOn, (w) => Number.isInteger(w) && (w as number) >= 0 && (w as number) <= 6), 'a workweek that starts on no day'],
        [d.site === undefined || d.site === null || isObj(d.site), 'a site that is not the shape the app writes'],
      );
    case 'employee':
      return first(
        [isStr(d.firstName) && isStr(d.lastName), 'no first and last name'],
        [opt(d.role, ROLE) && opt(d.active, isBool) && opt(d.title, isStr) && opt(d.payrollId, isStr), 'a role, job title or payroll ID that is not the shape the app writes'],
      );
    case 'equipment':
      return first(
        [isStr(d.unit), 'no unit number'],
        [oneOf(...CATEGORIES)(d.category), 'no type of machine the app has'],
        [opt(d.make, isStr) && opt(d.model, isStr) && opt(d.meter, isNum) && opt(d.meterUnit, oneOf('hrs', 'mi')), 'a make, model or equipment hours that are not the shape the app writes'],
        [opt(d.status, oneOf('ready', 'defect', 'out_of_service')), 'a status the app does not have'],
      );
    case 'areaSheet':
      return first(
        [isStr(d.title) && listOf(sheetRow)(d.rows), 'no title or lines'],
        [opt(d.active, isBool) && opt(d.single, isBool), 'a switch that is not the shape the app writes'],
      );
    case 'shift':
      return first(
        [isStr(d.employeeId) && isObj(d.clockIn) && isNum(d.clockIn.at), 'no person or clock-in time'],
        [punch(d.clockIn) && opt(d.clockOut, punch), 'a punch that is not the shape the app writes'],
        [opt(d.lunches, listOf(lunch)) && opt(d.breaks, listOf(restBreak)), 'a lunch or break that is not the shape the app writes'],
        [opt(d.mealNote, oneOf('forgot_punch', 'worked_through', 'waived_short_shift')), 'a meal note the app does not have'],
        [opt(d.edits, listOf(edit)), 'a correction that is not the shape the app writes'],
      );
    case 'denied':
      return first(
        [isStr(d.employeeId) && isNum(d.at), 'no person or time'],
        [oneOf('clock_in', 'end_lunch')(d.action) && oneOf('outside', 'weak_gps', 'mocked')(d.reason), 'no punch or reason the app has'],
        [opt(d.geo, geo), 'a location that is not the shape the app writes'],
      );
    case 'leave':
      return first(
        [isStr(d.employeeId) && isNum(d.day) && isNum(d.hours) && oneOf('holiday', 'pto', 'sick')(d.type), 'no person, day, type or hours'],
        [opt(d.enteredBy, isStr) && opt(d.at, isNum) && opt(d.note, isStr), 'who entered it, or when, is not the shape the app writes'],
      );
    case 'inspection':
      return first(
        [isStr(d.employeeId) && isStr(d.equipmentId) && isNum(d.submittedAt) && isArr(d.answers), 'no person, unit, time signed or answers'],
        [listOf(answer)(d.answers), 'an answer that is not the shape the app writes'],
        [isNum(d.meter), 'no equipment hours'],
        [isNum(d.startedAt), 'no time started'],
        [oneOf('pass', 'defect', 'bad_order')(d.result), 'no result the app has'],
        [isStr(d.templateId) && opt(d.templateVersion, isNum), 'no checklist it was made on'],
        [opt(d.fuelGal, isNum) && opt(d.comments, isStr) && opt(d.mrfId, isStr) && opt(d.decision, oneOf('operate', 'parked')), 'fuel, comments or a request that are not the shape the app writes'],
      );
    case 'opLog':
      return first(
        [isStr(d.employeeId) && isStr(d.equipmentId) && isNum(d.startAt), 'no person, unit or start time'],
        [isNum(d.startMeter), 'no equipment hours at the start'],
        [opt(d.inspectionId, isStr) && opt(d.endAt, isNum) && opt(d.endMeter, isNum) && opt(d.fuelGal, isNum) && opt(d.notes, isStr) && opt(d.parkedSafely, isBool), 'an end of use that is not the shape the app writes'],
      );
    case 'exam':
      return first(
        [isStr(d.employeeId) && isNum(d.submittedAt) && isArr(d.rows) && isArr(d.conditions), 'no person, time signed or lines'],
        [filled(d.shift), 'no shift'],
        [isStr(d.area), 'no area'],
        [isNum(d.startedAt), 'no time started'],
        [listOf(examRow)(d.rows), 'a line of the area sheet that is not the shape the app writes'],
        [listOf(examCondition)(d.conditions), 'a line of the conditions page that is not the shape the app writes'],
        [opt(d.sheetId, isStr) && opt(d.single, isBool), 'a sheet that is not the shape the app writes'],
      );
    case 'mrf':
      return first(
        [isNum(d.number) && isNum(d.createdAt) && isStr(d.status) && isStr(d.requestedBy), 'no number, date, status or person'],
        [MRF_STATUS(d.status), 'a status the app does not have'],
        [opt(d.priority, MRF_PRIORITY), 'a priority the app does not have'],
        [opt(d.history, listOf(mrfEvent)), 'a history that is not the shape the app writes'],
        [opt(d.items, listOf(mrfItem)), 'a line it was sent for that is not the shape the app writes'],
        [opt(d.description, isStr) && opt(d.taggedOut, isBool) && opt(d.location, isStr) && opt(d.meter, isNum), 'a problem, location or red tag that is not the shape the app writes'],
        [
          ['equipmentId', 'inspectionId', 'examId', 'findingKey', 'assignedTo', 'completedBy', 'remarks'].every((k) => opt(d[k], isStr)) &&
            opt(d.completedAt, isNum) && opt(d.timeSpent, isNum),
          'what it points at, or how it was completed, is not the shape the app writes',
        ],
      );
  }
}
