import { STANDARDS } from '../standards';
import { ANSWER_LEGEND, CATEGORY_ORDER, checklistFor, countAnswers, findItem, inspectionResult, isHazard } from '../templates';
import type { EquipmentCategory, InspectionAnswer } from '../types';

// The lines of the paper Operator Equipment Checklist, top to bottom.
const PRINTED = [
  'Fire extinguisher',
  'Steering',
  'Brake test & function',
  'Tires/nuts / pressure',
  'Lights',
  'Backup alarm / horn',
  'Warning lights',
  'Gauges',
  'Windows/mirrors (damage)',
  'Seatbelts/DROPS/FOPS',
  'Controls',
  'Hyd. cyl/hoses',
  'Wheel chocks (2 each)',
  'Appearance/damage',
  'House keeping',
  'Batteries/secure/corrosion',
  'Engine oil',
  'Transmission oil',
  'Radiator fluid',
  'Fuel',
  'Bed condition',
];

const ref = (category: EquipmentCategory, id: string) => findItem(checklistFor(category), id);

describe('operator equipment checklist', () => {
  it.each(CATEGORY_ORDER)('gives a %s the 21 lines of the paper card, in its order', (category) => {
    expect(checklistFor(category).items.map((i) => i.label)).toEqual(PRINTED);
  });

  it('is one checklist: the same lines, name and version whatever the machine', () => {
    const loader = checklistFor('loader');
    for (const category of CATEGORY_ORDER) {
      const list = checklistFor(category);
      expect([list.id, list.title, list.version]).toEqual([loader.id, 'Operator equipment checklist', loader.version]);
      expect(list.items.map((i) => i.id)).toEqual(loader.items.map((i) => i.id));
    }
    expect(new Set(loader.items.map((i) => i.id)).size).toBe(21);
  });

  it.each(CATEGORY_ORDER)('treats the same lines as safety items on a %s', (category) => {
    const safety = checklistFor(category).items.filter((i) => i.critical).map((i) => i.id);
    expect(safety).toEqual(['fire_extinguisher', 'steering', 'brakes', 'backup_alarm_horn', 'seatbelts', 'controls']);
  });

  it.each(CATEGORY_ORDER)('only cites standards that are in the standards table, for a %s', (category) => {
    for (const item of checklistFor(category).items) {
      if (item.cfr) expect(STANDARDS[item.cfr]?.agency).toBe('MSHA');
      if (item.osha) expect(STANDARDS[item.osha]?.agency).toBe('OSHA');
    }
  });

  it('cites the same MSHA standard for brakes, the alarm and the extinguisher on every machine', () => {
    for (const category of CATEGORY_ORDER) {
      expect(ref(category, 'brakes')?.cfr).toBe('56.14101');
      expect(ref(category, 'backup_alarm_horn')?.cfr).toBe('56.14132');
      expect(ref(category, 'fire_extinguisher')?.cfr).toBe('56.4230');
    }
  });

  it('cites the seat belt and roll-over standard that covers the type of machine', () => {
    expect(ref('haul_truck', 'seatbelts')?.cfr).toBe('56.14131');
    for (const category of ['loader', 'dozer', 'grader', 'skid_steer'] as const) {
      expect(ref(category, 'seatbelts')?.cfr).toBe('56.14130');
    }
    // A forklift's overhead guard is falling-object protection.
    expect(ref('forklift', 'seatbelts')?.cfr).toBe('56.14106');
    // No standard is cited where none names the machine.
    for (const category of ['excavator', 'water_truck', 'light_vehicle'] as const) {
      expect(ref(category, 'seatbelts')?.cfr).toBeUndefined();
    }
  });

  it('pairs each MSHA check with the OSHA rule for that type of machine', () => {
    const osha = (category: EquipmentCategory, id: string) => ref(category, id)?.osha;
    expect(osha('loader', 'brakes')).toBe('1926.602(a)(4)');
    expect(osha('loader', 'backup_alarm_horn')).toBe('1926.602(a)(9)');
    expect(osha('loader', 'seatbelts')).toBe('1926.602(a)(2)');
    expect(osha('forklift', 'brakes')).toBe('1910.178(q)(7)');
    expect(osha('forklift', 'steering')).toBe('1910.178(q)(7)');
    expect(osha('light_vehicle', 'backup_alarm_horn')).toBe('1926.601(b)(4)');
    expect(osha('light_vehicle', 'brakes')).toBe('1926.601(b)(14)');
    expect(osha('light_vehicle', 'tires')).toBe('1926.601(b)(14)');
    expect(osha('water_truck', 'windows_mirrors')).toBe('1926.601(b)(5)');
    expect(osha('loader', 'fire_extinguisher')).toBe('1910.157(e)(2)');
  });

  it('carries the legend printed at the foot of the card', () => {
    expect(ANSWER_LEGEND).toEqual({
      ok: 'Inspection free of defects or concerns',
      bo: 'Bad Order, needs repair. Safety items: red tag and report immediately',
      na: 'Not applicable to this equipment',
    });
  });
});

describe('inspectionResult', () => {
  const checklist = checklistFor('loader');
  const all = (overrides: Record<string, Partial<InspectionAnswer>> = {}): InspectionAnswer[] =>
    checklist.items.map((i) => ({ itemId: i.id, answer: 'ok', ...overrides[i.id] }));

  it('passes when everything is OK or N/A', () => {
    expect(inspectionResult(checklist, all({ bed_condition: { answer: 'na' } }))).toBe('pass');
  });
  it('is a reportable defect for a Bad Order that is not a safety item', () => {
    const answers = all({ lights: { answer: 'bo', note: 'Left work light out' } });
    expect(inspectionResult(checklist, answers)).toBe('defect');
    expect(countAnswers(answers)).toEqual({ ok: 20, bo: 1, na: 0 });
  });
  it('takes the unit out of service for a Bad Order on a safety item', () => {
    const answers = all({ brakes: { answer: 'bo', note: 'Pedal fades' } });
    expect(inspectionResult(checklist, answers)).toBe('bad_order');
    expect(isHazard(checklist, answers.find((a) => a.itemId === 'brakes')!)).toBe(true);
  });
  it('takes the unit out of service when the operator calls a defect unsafe', () => {
    const answers = all({ tires: { answer: 'bo', note: 'Sidewall cut', hazard: true } });
    expect(inspectionResult(checklist, answers)).toBe('bad_order');
  });
});
