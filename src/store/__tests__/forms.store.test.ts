// What the forms and requests do once a unit or a sheet can change under them from the office: a
// checklist and an exam are signed on the unit and the sheet as the person saw them, with the
// type of machine they were signed under; a unit taken out while it is checked out can still be
// checked back in; making a request never makes a unit better, and completing one takes off only
// what that request put on. Made-up units and sheets of the sample data.
import { AREA_CONDITIONS } from '../../domain/areaExam';
import { checklistFor } from '../../domain/templates';
import type { Equipment, InspectionAnswer } from '../../domain/types';
import { useStore } from '../useStore';

const s = () => useStore.getState();
const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m, 0).getTime();
const okAnswers = (unit: Equipment): InspectionAnswer[] => checklistFor(unit.category).items.map((i) => ({ itemId: i.id, answer: 'ok' }));
const status = (id: string) => s().equipment.find((e) => e.id === id)?.status;
const setStatus = (id: string, value: Equipment['status']) => useStore.setState({ equipment: s().equipment.map((e) => (e.id === id ? { ...e, status: value } : e)) });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(at(6, 15));
  s().resetDemo();
  useStore.setState({ mrfs: [] });
});
afterEach(() => jest.useRealTimers());

describe('a maintenance request and its unit', () => {
  it('never makes a unit better when it is made', () => {
    s().signInDemo('employee');
    const unit = s().equipment[0];
    setStatus(unit.id, 'out_of_service');
    expect(s().createMrf({ equipmentId: unit.id, priority: 'routine', description: 'Mirror loose', taggedOut: false }).ok).toBe(true);
    expect(status(unit.id)).toBe('out_of_service');
  });

  it('takes off, when completed, only what that request put on', () => {
    s().signInDemo('supervisor');
    const unit = s().equipment[0];
    // A red tag from a checklist, or from another phone, stays when a request without one is completed.
    setStatus(unit.id, 'out_of_service');
    const plain = s().createMrf({ equipmentId: unit.id, priority: 'routine', description: 'Mirror loose', taggedOut: false });
    expect(plain.ok && s().completeMrf(plain.mrf.id, { remarks: 'Tightened' }).ok).toBe(true);
    expect(status(unit.id)).toBe('out_of_service');

    // The red tag a request put on comes off with it.
    const tagged = s().createMrf({ equipmentId: unit.id, priority: 'safety', description: 'Brakes soft', taggedOut: true });
    expect(tagged.ok && s().completeMrf(tagged.mrf.id, { remarks: 'Brakes bled' }).ok).toBe(true);
    expect(status(unit.id)).toBe('ready');

    // A defect a request put on comes off with it; one still open keeps it.
    const first = s().createMrf({ equipmentId: unit.id, priority: 'routine', description: 'Wiper worn', taggedOut: false });
    const second = s().createMrf({ equipmentId: unit.id, priority: 'routine', description: 'Horn weak', taggedOut: false });
    expect(status(unit.id)).toBe('defect');
    expect(first.ok && s().completeMrf(first.mrf.id, { remarks: 'New blade' }).ok).toBe(true);
    expect(status(unit.id)).toBe('defect');
    expect(second.ok && s().completeMrf(second.mrf.id, { remarks: 'New horn' }).ok).toBe(true);
    expect(status(unit.id)).toBe('ready');

    // A red-tag request completed with another, plain one still open leaves a defect.
    const red = s().createMrf({ equipmentId: unit.id, priority: 'safety', description: 'Steering', taggedOut: true });
    s().createMrf({ equipmentId: unit.id, priority: 'routine', description: 'Seat torn', taggedOut: false });
    expect(red.ok && s().completeMrf(red.mrf.id, { remarks: 'Steering fixed' }).ok).toBe(true);
    expect(status(unit.id)).toBe('defect');
  });
});

describe('an equipment checklist', () => {
  it('is signed on the unit as the form opened with it, with its type, though the office changes the unit meanwhile', () => {
    s().signInDemo('employee');
    const unit = s().equipment.find((e) => e.status === 'ready')!;
    const opened = { ...unit };
    // The office changes the unit's type while the card is open.
    useStore.setState({ equipment: s().equipment.map((e) => (e.id === unit.id ? { ...e, category: e.category === 'dozer' ? 'grader' : 'dozer', model: 'Changed' } : e)) });
    const signed = s().submitInspection({ equipmentId: unit.id, unit: opened, startedAt: at(6), meter: unit.meter + 5, answers: okAnswers(opened) });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.inspection.category).toBe(opened.category);
    // The reading still goes onto the unit as the store holds it now.
    expect(s().equipment.find((e) => e.id === unit.id)).toMatchObject({ model: 'Changed', meter: unit.meter + 5 });
  });

  it('is signed and kept when the unit was taken out of the fleet while it was being checked', () => {
    s().signInDemo('employee');
    const unit = s().equipment[0];
    useStore.setState({ equipment: s().equipment.filter((e) => e.id !== unit.id) });
    const signed = s().submitInspection({ equipmentId: unit.id, unit, startedAt: at(6), meter: unit.meter + 1, answers: okAnswers(unit) });
    expect(signed.ok).toBe(true);
    expect(s().equipment.some((e) => e.id === unit.id)).toBe(false);
    // Without the unit it opened with, a unit no longer in the fleet is turned back, as before.
    expect(s().submitInspection({ equipmentId: unit.id, startedAt: at(6, 1), meter: unit.meter + 1, answers: okAnswers(unit) })).toMatchObject({ ok: false });
  });

  it('notes the type of machine it was signed under', () => {
    s().signInDemo('employee');
    const unit = s().equipment.find((e) => e.status === 'ready')!;
    const signed = s().submitInspection({ equipmentId: unit.id, startedAt: at(6), meter: unit.meter, answers: okAnswers(unit) });
    expect(signed.ok && signed.inspection.category).toBe(unit.category);
  });
});

describe('a pre shift exam', () => {
  it('is signed on the sheet as the form opened with it, though the office changes or stops it meanwhile', () => {
    s().signInDemo('employee');
    const sheet = s().areaSheets.find((a) => a.active)!;
    const draft = {
      sheetId: sheet.id,
      sheet,
      shift: 'day' as const,
      startedAt: at(6),
      rows: Object.fromEntries(sheet.rows.map((r) => [r.id, { answer: 'ok' as const }])),
      others: [],
      conditions: Object.fromEntries(AREA_CONDITIONS.map((c) => [c.id, { answer: 'ok' as const }])),
    };
    useStore.setState({ areaSheets: s().areaSheets.map((a) => (a.id === sheet.id ? { ...a, active: false, rows: [{ id: 'new', label: 'A new line' }] } : a)) });
    const signed = s().submitExam(draft);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.exam.rows.map((r) => r.label).slice(0, sheet.rows.length)).toEqual(sheet.rows.map((r) => r.label));
    // Without the sheet it opened with, a sheet no longer in use is turned back, as before.
    expect(s().submitExam({ ...draft, sheet: undefined, startedAt: at(6, 1) })).toMatchObject({ ok: false });
  });
});

describe('a unit taken out of the fleet while it is checked out', () => {
  it('is still checked back in, and its copy kept for that goes', () => {
    s().signInDemo('employee');
    const unit = s().equipment.find((e) => e.status === 'ready')!;
    const signed = s().submitInspection({ equipmentId: unit.id, startedAt: at(6), meter: unit.meter, answers: okAnswers(unit) });
    expect(signed.ok).toBe(true);
    const log = s().opLogs.find((l) => l.equipmentId === unit.id && !l.endAt)!;
    useStore.setState({
      connectedCompany: { id: 'c-test-a', name: 'Test Pit A', role: 'employee', userId: 'u1' },
      syncedWith: 'c-test-a',
      equipment: s().equipment.filter((e) => e.id !== unit.id),
    });
    s().ensureReceiving();
    useStore.setState({ receiving: { ...s().receiving!, gone: { [unit.id]: unit } } });
    expect(s().endUse(log.id, { endMeter: unit.meter + 3, parkedSafely: true })).toEqual({ ok: true });
    expect(s().opLogs.find((l) => l.id === log.id)?.endAt).toBe(at(6, 15));
    expect(s().receiving!.gone).toEqual({});
  });
});
