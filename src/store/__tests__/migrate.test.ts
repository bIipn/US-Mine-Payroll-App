import { migratePersisted } from '../migrate';

const v1 = {
  session: { accountId: 'a1', employeeId: 'e1' },
  seededAt: 1_700_000_000_000,
  employees: [{ id: 'e1', firstName: 'Ana', lastName: 'Diaz', role: 'employee', active: true }],
  shifts: [{ id: 's1' }],
  settings: { lunchReminders: false },
};

describe('migratePersisted', () => {
  it('reloads the sample data in a preview build saved before paid leave existed', () => {
    const next = migratePersisted(v1, 1, true);
    // Clearing seededAt is what makes the app load the sample data again at start-up.
    expect(next.seededAt).toBeNull();
    expect(next.session).toBeNull();
    expect(next.leave).toEqual([]);
    expect(next.payRates).toEqual({});
    // A person's own settings survive the reload.
    expect(next.settings).toEqual({ lunchReminders: false });
  });

  it('keeps every real record in a live build and only adds the new empty lists', () => {
    const next = migratePersisted(v1, 1, false);
    expect(next.seededAt).toBe(1_700_000_000_000);
    expect(next.session).toEqual({ accountId: 'a1', employeeId: 'e1' });
    expect(next.shifts).toEqual([{ id: 's1' }]);
    expect(next.leave).toEqual([]);
    expect(next.payRates).toEqual({});
  });

  describe('from before lunch ended by itself', () => {
    const start = new Date(2026, 10, 13, 11, 0).getTime();
    const v2 = {
      ...v1,
      leave: [{ id: 'lv1' }],
      payRates: { e1: 2500 },
      shifts: [
        { id: 's1', lunches: [{ start: { at: start } }] },
        { id: 's2', lunches: [{ start: { at: start }, end: { at: start + 34 * 60_000, geo: { inside: true } } }] },
        { id: 's3', lunches: [] },
      ],
    };

    it('gives a lunch saved with no end its automatic end, 30 minutes after it started', () => {
      const next = migratePersisted(v2, 2, false) as typeof v2;
      expect(next.shifts[0].lunches[0]).toEqual({ start: { at: start }, end: { at: start + 30 * 60_000, auto: true } });
      // A lunch that was punched back in from stays exactly as it was recorded.
      expect(next.shifts[1]).toEqual(v2.shifts[1]);
      expect(next.shifts[2]).toEqual(v2.shifts[2]);
      expect(next.session).toEqual(v1.session);
      expect(next.leave).toEqual([{ id: 'lv1' }]);
    });

    it('reloads the sample data in a preview build, so its lunches follow the new rule', () => {
      const next = migratePersisted(v2, 2, true);
      expect(next.seededAt).toBeNull();
      expect(next.session).toBeNull();
      expect(next.payRates).toEqual({ e1: 2500 });
    });
  });

  describe('from before the paper forms were built in', () => {
    const v3 = {
      ...v1,
      leave: [{ id: 'lv1' }],
      payRates: { e1: 2500 },
      // A checklist signed on the old lines, and a request for a unit.
      inspections: [{ id: 'i1', templateId: 'preop_loader', answers: [{ itemId: 'fn_brakes', answer: 'bo', note: 'Pedal fades' }] }],
      mrfs: [{ id: 'm1', number: 1001, equipmentId: 'eq1', status: 'open' }],
    };

    it('keeps every record in a live build exactly as it was signed, and starts the exams', () => {
      const next = migratePersisted(v3, 3, false);
      expect(next.inspections).toEqual(v3.inspections);
      expect(next.mrfs).toEqual(v3.mrfs);
      expect(next.exams).toEqual([]);
      expect(next.areaSheets).toEqual([]);
      expect(next.session).toEqual(v1.session);
    });

    it('reloads the sample data in a preview build, so its cards are on the real 21 lines', () => {
      const next = migratePersisted(v3, 3, true);
      expect(next.seededAt).toBeNull();
      expect(next.session).toBeNull();
    });
  });

  it('leaves data from the current version alone', () => {
    const v4 = { ...v1, leave: [{ id: 'lv1' }], payRates: { e1: 2500 }, exams: [{ id: 'x1' }], areaSheets: [{ id: 'lab' }] };
    expect(migratePersisted(v4, 4, true)).toEqual(v4);
  });

  it('copes with nothing saved', () => {
    expect(migratePersisted(undefined, 1, false)).toEqual({ leave: [], payRates: {}, exams: [], areaSheets: [] });
  });
});
