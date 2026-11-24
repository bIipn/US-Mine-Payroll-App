import { cardsBetween, dailyCards, dayClock } from '../checklistCard';
import { checklistFor } from '../templates';
import { startedLunch } from '../time';
import type { Equipment, Inspection, InspectionAnswer, OperatingLog, Shift } from '../types';

const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const day = (d: number) => new Date(2026, 10, d).getTime();

const unit = (name: string, category: Equipment['category'] = 'loader'): Equipment => ({
  id: `eq_${name}`, unit: name, category, make: 'CAT', model: '980M', status: 'ready', meter: 100, meterUnit: 'hrs',
});
const fleet = [unit('L-12'), unit('HT-21', 'haul_truck'), unit('D-03', 'dozer'), unit('G-02', 'grader'), unit('WT-01', 'water_truck')];

const answers = (bad: Record<string, Partial<InspectionAnswer>> = {}): InspectionAnswer[] =>
  checklistFor('loader').items.map((i) => ({ itemId: i.id, answer: 'ok', ...bad[i.id] }));

const check = (id: string, unitName: string, when: number, extra: Partial<Inspection> = {}): Inspection => ({
  id, equipmentId: `eq_${unitName}`, employeeId: 'e1', templateId: 'operator_equipment_checklist', templateVersion: 1,
  startedAt: when - 5 * 60_000, submittedAt: when, meter: 100, answers: answers(), result: 'pass', ...extra,
});
const use = (inspectionId: string, unitName: string, extra: Partial<OperatingLog> = {}): OperatingLog => ({
  id: `op_${inspectionId}`, equipmentId: `eq_${unitName}`, employeeId: 'e1', inspectionId, startAt: 0, startMeter: 100, ...extra,
});

describe('dailyCards', () => {
  it('gives each unit a person checked that day its own column, in the order they were checked', () => {
    const inspections = [
      check('b', 'HT-21', at(13, 10, 30), { meter: 9120.4 }),
      check('a', 'L-12', at(13, 6, 20), { meter: 11842.6 }),
      check('yesterday', 'L-12', at(12, 6, 20)),
      check('someone-else', 'D-03', at(13, 7, 0), { employeeId: 'e2' }),
    ];
    const opLogs = [use('a', 'L-12', { endAt: at(13, 10, 15), endMeter: 11846.1 }), use('b', 'HT-21')];
    const cards = dailyCards({ inspections, opLogs, equipment: fleet }, 'e1', at(13, 15));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ employeeId: 'e1', day: day(13) });
    expect(cards[0].columns.map((c) => [c.n, c.unit?.unit, c.hoursStart, c.hoursEnd])).toEqual([
      [1, 'L-12', 11842.6, 11846.1],
      [2, 'HT-21', 9120.4, undefined],
    ]);
  });

  it('says a unit is in use only while someone has it checked out', () => {
    const inspections = [
      check('ran', 'L-12', at(13, 6)),
      check('running', 'HT-21', at(13, 7)),
      // A defect the operator parked the unit for: it was checked and never run.
      check('parked', 'D-03', at(13, 8), { result: 'defect', decision: 'parked' }),
    ];
    const opLogs = [use('ran', 'L-12', { endAt: at(13, 6, 50), endMeter: 101 }), use('running', 'HT-21')];
    const [card] = dailyCards({ inspections, opLogs, equipment: fleet }, 'e1', day(13));
    expect(card.columns.map((c) => [c.unit?.unit, c.inUse])).toEqual([['L-12', false], ['HT-21', true], ['D-03', false]]);
  });

  it('says so when a checklist was made before the card, and keeps what was written on it', () => {
    const old = check('old', 'L-12', at(13, 6), {
      templateId: 'preop_loader', result: 'bad_order',
      answers: [{ itemId: 'fn_brakes', answer: 'bo', note: 'Pedal fades' }, { itemId: 'fluid_levels', answer: 'ok' }],
    });
    const [card] = dailyCards({ inspections: [old, check('new', 'HT-21', at(13, 9), { answers: answers({ lights: { answer: 'bo', note: 'Lamp out' } }) })], opLogs: [], equipment: fleet }, 'e1', day(13));
    expect(card.comments).toEqual([
      { n: 1, text: 'Made on the checklist used before this card, so its lines are not the ones printed here' },
      { n: 1, text: 'Pedal fades' },
      { n: 2, text: 'Lights: Lamp out' },
    ]);
  });

  it('starts a second card after four units, as the paper would', () => {
    const inspections = ['L-12', 'HT-21', 'D-03', 'G-02', 'WT-01'].map((name, i) => check(`i${i}`, name, at(13, 6 + i)));
    const cards = dailyCards({ inspections, opLogs: [], equipment: fleet }, 'e1', day(13));
    expect(cards.map((card) => card.columns.map((c) => [c.n, c.unit?.unit]))).toEqual([
      [[1, 'L-12'], [2, 'HT-21'], [3, 'D-03'], [4, 'G-02']],
      [[1, 'WT-01']],
    ]);
  });

  it('adds the gallons written on the fuel line to the gallons added at the end of use', () => {
    const inspections = [
      check('a', 'L-12', at(13, 6), { fuelGal: 20 }),
      check('b', 'HT-21', at(13, 7)),
      check('c', 'D-03', at(13, 8), { fuelGal: 12.5 }),
    ];
    const opLogs = [use('a', 'L-12', { fuelGal: 42 }), use('b', 'HT-21', { fuelGal: 60 }), use('c', 'D-03')];
    const [card] = dailyCards({ inspections, opLogs, equipment: fleet }, 'e1', day(13));
    expect(card.columns.map((c) => c.fuelGal)).toEqual([62, 60, 12.5]);
  });

  it('writes each Bad Order, the comments and the end-of-use note in the comments box, by column', () => {
    const inspections = [
      check('a', 'L-12', at(13, 6), {
        answers: answers({ lights: { answer: 'bo', note: 'Left work light out' } }),
        result: 'defect',
        comments: 'Greased the pins',
      }),
      check('b', 'HT-21', at(13, 7)),
    ];
    const opLogs = [use('a', 'L-12', { notes: 'Low on DEF' }), use('b', 'HT-21')];
    const [card] = dailyCards({ inspections, opLogs, equipment: fleet }, 'e1', day(13));
    expect(card.comments).toEqual([
      { n: 1, text: 'Lights: Left work light out' },
      { n: 1, text: 'Greased the pins' },
      { n: 1, text: 'Low on DEF' },
    ]);
  });

  it('still shows a unit that has since been removed from the fleet', () => {
    const [card] = dailyCards({ inspections: [check('a', 'GONE-1', at(13, 6))], opLogs: [], equipment: fleet }, 'e1', day(13));
    expect(card.columns[0].unit).toBeUndefined();
    expect(card.columns[0].hoursStart).toBe(100);
  });

  it('has no card for a day with no equipment', () => {
    expect(dailyCards({ inspections: [check('a', 'L-12', at(12, 6))], opLogs: [], equipment: fleet }, 'e1', day(13))).toEqual([]);
  });
});

describe('cardsBetween', () => {
  it("lists everyone's cards in a run of days, newest day first", () => {
    const inspections = [
      check('a', 'L-12', at(11, 6)),
      check('b', 'HT-21', at(13, 6)),
      check('c', 'D-03', at(13, 7), { employeeId: 'e2' }),
      check('d', 'G-02', at(13, 9)),
      check('too-early', 'L-12', at(9, 6)),
    ];
    const cards = cardsBetween({ inspections, opLogs: [], equipment: fleet }, day(10), day(14));
    expect(cards.map((c) => [c.employeeId, c.day, c.columns.map((col) => col.unit?.unit)])).toEqual([
      ['e2', day(13), ['D-03']],
      ['e1', day(13), ['HT-21', 'G-02']],
      ['e1', day(11), ['L-12']],
    ]);
  });
});

describe('dayClock', () => {
  const punch = (when: number) => ({ at: when });
  const shift = (id: string, employeeId: string, inAt: number, outAt?: number, lunchAt?: number): Shift => ({
    id, employeeId, clockIn: punch(inAt), clockOut: outAt ? punch(outAt) : undefined,
    lunches: lunchAt ? [startedLunch(punch(lunchAt))] : [], breaks: [],
  });

  it('takes the total daily hours from the time clock, lunch off, as hundredths', () => {
    const shifts = [
      shift('s1', 'e1', at(13, 6, 15), at(13, 19, 0), at(13, 11, 0)),
      shift('other-day', 'e1', at(12, 6, 0), at(12, 14, 30)),
      shift('other-person', 'e2', at(13, 6, 0), at(13, 14, 30)),
    ];
    expect(dayClock(shifts, 'e1', at(13, 20), at(13, 20))).toEqual({ paid: 1225, running: false, noClockOut: false });
  });

  it('counts the hours so far for someone still on the clock', () => {
    expect(dayClock([shift('s1', 'e1', at(13, 6, 0))], 'e1', day(13), at(13, 9, 30))).toEqual({ paid: 350, running: true, noClockOut: false });
  });

  it('is zero on a day off', () => {
    expect(dayClock([], 'e1', day(13), at(13, 9))).toEqual({ paid: 0, running: false, noClockOut: false });
  });

  it('counts nothing for a shift that was never clocked out, as payroll does, and says so', () => {
    const forgot = [shift('s1', 'e1', at(12, 6, 0))];
    // The next morning, and three days on: the total does not keep growing.
    expect(dayClock(forgot, 'e1', day(12), at(13, 10, 18))).toEqual({ paid: 0, running: false, noClockOut: true });
    expect(dayClock(forgot, 'e1', day(12), at(16, 10, 18))).toEqual({ paid: 0, running: false, noClockOut: true });
    // A second shift that day, clocked out properly, still counts.
    const both = [shift('s0', 'e1', at(12, 1, 0), at(12, 5, 0)), ...forgot];
    expect(dayClock(both, 'e1', day(12), at(13, 10, 18))).toEqual({ paid: 400, running: false, noClockOut: true });
  });
});
