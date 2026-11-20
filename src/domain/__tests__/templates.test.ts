import { STANDARDS } from '../standards';
import { ANSWER_LEGEND, CATEGORY_ORDER, checklistFor, checklistSignedOn, countAnswers, findItem, inspectionResult, isHazard, signedAnswers } from '../templates';
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

  it('carries the legend printed at the foot of the card, word for word', () => {
    expect(ANSWER_LEGEND).toEqual({
      ok: 'inspection free of defects/concerns',
      bo: 'Bad Order, Needs Repair (Safety items; red tag and report immediately.)',
      na: 'Not applicable to specific equipment',
    });
  });
});

describe('signedAnswers', () => {
  const checklist = checklistFor('loader');
  const all = (overrides: Record<string, Partial<InspectionAnswer>> = {}): InspectionAnswer[] =>
    checklist.items.map((i) => ({ itemId: i.id, answer: 'ok', ...overrides[i.id] }));

  it('puts one answer for each line on the record, in the order of the card', () => {
    const jumbled = [...all(), { itemId: 'not_on_the_card', answer: 'ok' as const }, { itemId: 'lights', answer: 'na' as const }].reverse();
    const signed = signedAnswers(checklist, jumbled);
    expect(signed.blank).toBe(0);
    expect(signed.answers.map((a) => a.itemId)).toEqual(checklist.items.map((i) => i.id));
  });

  it('keeps a note and the unsafe mark only on a Bad Order', () => {
    const signed = signedAnswers(
      checklist,
      all({
        lights: { answer: 'ok', note: 'Left work light out', hazard: true },
        bed_condition: { answer: 'na', note: 'No bed' },
        tires: { answer: 'bo', note: '  Sidewall cut  to the cords ', hazard: true },
      }),
    ).answers;
    expect(signed.find((a) => a.itemId === 'lights')).toEqual({ itemId: 'lights', answer: 'ok' });
    expect(signed.find((a) => a.itemId === 'bed_condition')).toEqual({ itemId: 'bed_condition', answer: 'na' });
    expect(signed.find((a) => a.itemId === 'tires')).toEqual({ itemId: 'tires', answer: 'bo', note: 'Sidewall cut to the cords', hazard: true });
  });

  it('counts a line as blank until it is marked OK, BO or N/A', () => {
    expect(signedAnswers(checklist, all().filter((a) => a.itemId !== 'fuel')).blank).toBe(1);
    const odd = all({ lights: { answer: 'fine' as unknown as InspectionAnswer['answer'] }, gauges: { answer: undefined as unknown as InspectionAnswer['answer'] } });
    expect(signedAnswers(checklist, odd).blank).toBe(2);
    expect(signedAnswers(checklist, []).blank).toBe(21);
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

describe('checklistSignedOn', () => {
  it('cites the standards of the type a checklist was signed under, whatever the unit is now', () => {
    expect(checklistSignedOn({ category: 'dozer' }, { category: 'forklift' })).toBe(checklistFor('dozer'));
    // Signed before the type was kept on it: the unit's type now, as before.
    expect(checklistSignedOn({}, { category: 'forklift' })).toBe(checklistFor('forklift'));
    expect(checklistSignedOn({}, null)).toBe(checklistFor('loader'));
  });
});
