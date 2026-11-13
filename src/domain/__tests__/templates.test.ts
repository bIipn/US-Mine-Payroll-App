import { STANDARDS } from '../standards';
import { CATEGORY_ORDER, countAnswers, inspectionResult, isHazard, templateFor, templateItems } from '../templates';
import type { InspectionAnswer } from '../types';

describe('pre-op templates', () => {
  it.each(CATEGORY_ORDER)('%s has unique item ids and valid MSHA references', (category) => {
    const template = templateFor(category);
    const items = templateItems(template);
    expect(items.length).toBeGreaterThanOrEqual(20);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const item of items) {
      if (item.cfr) expect(STANDARDS[item.cfr]?.agency).toBe('MSHA');
      if (item.osha) expect(STANDARDS[item.osha]?.agency).toBe('OSHA');
    }
  });

  it.each(CATEGORY_ORDER)('%s covers the MSHA safety-critical checks', (category) => {
    const critical = templateItems(templateFor(category)).filter((i) => i.critical).map((i) => i.id);
    for (const id of ['cab_belt', 'cab_ext', 'fn_horn', 'fn_backup', 'fn_brakes', 'fn_park', 'fn_steer']) {
      expect(critical).toContain(id);
    }
  });

  it('cites the haul-truck seat belt standard for haul trucks', () => {
    const belt = (c: 'haul_truck' | 'loader') => templateItems(templateFor(c)).find((i) => i.id === 'cab_belt')?.cfr;
    expect(belt('haul_truck')).toBe('56.14131');
    expect(belt('loader')).toBe('56.14130');
  });

  it('pairs each MSHA check with the OSHA rule for that type of machine', () => {
    const osha = (c: 'loader' | 'forklift' | 'light_vehicle', id: string) =>
      templateItems(templateFor(c)).find((i) => i.id === id)?.osha;
    expect(osha('loader', 'fn_brakes')).toBe('1926.602(a)(4)');
    expect(osha('loader', 'fn_backup')).toBe('1926.602(a)(9)');
    expect(osha('loader', 'cab_belt')).toBe('1926.602(a)(2)');
    expect(osha('forklift', 'fn_brakes')).toBe('1910.178(q)(7)');
    expect(osha('light_vehicle', 'fn_backup')).toBe('1926.601(b)(4)');
    expect(osha('light_vehicle', 'fn_brakes')).toBe('1926.601(b)(14)');
    expect(osha('loader', 'cab_ext')).toBe('1910.157(e)(2)');
  });

  it('uses tracks instead of tires on tracked machines', () => {
    const ids = (c: 'dozer' | 'loader') => templateItems(templateFor(c)).map((i) => i.id);
    expect(ids('dozer')).toContain('wa_tracks');
    expect(ids('dozer')).not.toContain('wa_tires');
    expect(ids('loader')).toContain('wa_tires');
  });
});

describe('inspectionResult', () => {
  const template = templateFor('loader');
  const all = (overrides: Record<string, Partial<InspectionAnswer>> = {}): InspectionAnswer[] =>
    templateItems(template).map((i) => ({ itemId: i.id, answer: 'ok', ...overrides[i.id] }));

  it('passes when everything is OK or N/A', () => {
    expect(inspectionResult(template, all({ cab_radio: { answer: 'na' } }))).toBe('pass');
  });
  it('is a reportable defect for a non-critical Bad Order', () => {
    const answers = all({ cab_wipers: { answer: 'bo', note: 'blade torn' } });
    expect(inspectionResult(template, answers)).toBe('defect');
    expect(countAnswers(answers).bo).toBe(1);
  });
  it('takes the unit out of service for a critical Bad Order', () => {
    const answers = all({ fn_brakes: { answer: 'bo', note: 'pedal fades' } });
    expect(inspectionResult(template, answers)).toBe('bad_order');
    expect(isHazard(template, answers.find((a) => a.itemId === 'fn_brakes')!)).toBe(true);
  });
  it('takes the unit out of service when the operator calls a defect unsafe', () => {
    const answers = all({ wa_tires: { answer: 'bo', note: 'sidewall cut', hazard: true } });
    expect(inspectionResult(template, answers)).toBe('bad_order');
  });
});
