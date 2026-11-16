import type { Company } from '../../domain/company';
import { migratePersisted } from '../migrate';

const COMPANY: Company = { name: 'Example Aggregates Co.', state: 'NV', pay: null };

const v1 = {
  session: { accountId: 'a1', employeeId: 'e1' },
  seededAt: 1_700_000_000_000,
  employees: [{ id: 'e1', firstName: 'Ana', lastName: 'Diaz', role: 'employee', active: true }],
  shifts: [{ id: 's1' }],
  settings: { lunchReminders: false },
};

describe('migratePersisted', () => {
  it('reloads the sample data in a preview build saved before paid leave existed', () => {
    const next = migratePersisted(v1, 1, true, COMPANY);
    // Clearing seededAt is what makes the app load the sample data again at start-up.
    expect(next.seededAt).toBeNull();
    expect(next.session).toBeNull();
    expect(next.leave).toEqual([]);
    expect(next.payRates).toEqual({});
    // A person's own settings survive the reload.
    expect(next.settings).toEqual({ lunchReminders: false, company: COMPANY });
  });

  it('keeps every real record in a live build and only adds the new empty lists', () => {
    const next = migratePersisted(v1, 1, false, COMPANY);
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
      const next = migratePersisted(v2, 2, false, COMPANY) as typeof v2;
      expect(next.shifts[0].lunches[0]).toEqual({ start: { at: start }, end: { at: start + 30 * 60_000, auto: true } });
      // A lunch that was punched back in from stays exactly as it was recorded.
      expect(next.shifts[1]).toEqual(v2.shifts[1]);
      expect(next.shifts[2]).toEqual(v2.shifts[2]);
      expect(next.session).toEqual(v1.session);
      expect(next.leave).toEqual([{ id: 'lv1' }]);
    });

    it('reloads the sample data in a preview build, so its lunches follow the new rule', () => {
      const next = migratePersisted(v2, 2, true, COMPANY);
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
      const next = migratePersisted(v3, 3, false, COMPANY);
      expect(next.inspections).toEqual(v3.inspections);
      expect(next.mrfs).toEqual(v3.mrfs);
      expect(next.exams).toEqual([]);
      expect(next.areaSheets).toEqual([]);
      expect(next.session).toEqual(v1.session);
    });

    it('reloads the sample data in a preview build, so its cards are on the real 21 lines', () => {
      const next = migratePersisted(v3, 3, true, COMPANY);
      expect(next.seededAt).toBeNull();
      expect(next.session).toBeNull();
    });
  });

  describe('from before a completed request kept its own date', () => {
    const done = (at: number) => ({ at, by: 'e6', status: 'completed', note: 'Replaced backup alarm and tested in reverse' });
    const v4 = {
      ...v1,
      leave: [{ id: 'lv1' }],
      payRates: { e1: 2500 },
      exams: [{ id: 'x1' }],
      areaSheets: [{ id: 'crusher' }],
      mrfs: [
        { id: 'm1', number: 1001, status: 'completed', createdAt: 1000, history: [{ at: 1000, by: 'e1', status: 'open' }, done(5000)] },
        { id: 'm2', number: 1002, status: 'open', createdAt: 1500, history: [{ at: 1500, by: 'e1', status: 'open' }] },
        { id: 'm3', number: 1003, status: 'completed', createdAt: 2000, completedAt: 9000, completedBy: 'e2', remarks: 'As entered', history: [done(9500)] },
        { id: 'm4', number: 1004, status: 'completed', createdAt: 2500 },
      ],
    };

    it('fills in date completed, completed by and remarks from the history, in a live build', () => {
      const next = migratePersisted(v4, 4, false, COMPANY) as typeof v4;
      expect(next.mrfs[0]).toEqual({ ...v4.mrfs[0], completedAt: 5000, completedBy: 'e6', remarks: 'Replaced backup alarm and tested in reverse' });
      // An open request, one that already has its fields, and one with no history are left as they are.
      expect(next.mrfs.slice(1)).toEqual(v4.mrfs.slice(1));
      expect(next.exams).toEqual(v4.exams);
      expect(next.session).toEqual(v1.session);
    });

    it('reloads the sample data in a preview build, so it shows the sample areas of this version', () => {
      const next = migratePersisted(v4, 4, true, COMPANY);
      expect(next.seededAt).toBeNull();
      expect(next.session).toBeNull();
    });
  });

  it('gives saved settings the company the build starts with, and keeps everything else', () => {
    const v5 = { ...v1, leave: [], payRates: {}, exams: [], areaSheets: [], settings: { lunchReminders: false, workweekStartsOn: 1 } };
    const next = migratePersisted(v5, 5, false, COMPANY);
    expect(next.settings).toEqual({ lunchReminders: false, workweekStartsOn: 1, company: COMPANY });
    expect(next.shifts).toEqual([{ id: 's1' }]);
    expect(next.seededAt).toBe(1_700_000_000_000);
  });

  it('keeps a company that is already saved', () => {
    const own: Company = { name: 'Another Co.', state: 'TX', pay: null };
    const v6 = { ...v1, settings: { lunchReminders: false, company: own } };
    expect((migratePersisted(v6, 5, false, COMPANY).settings as { company: Company }).company).toBe(own);
  });

  it('starts a phone with nothing sent to a server yet, and keeps every record to send', () => {
    const v6 = { ...v1, leave: [], payRates: {}, exams: [], areaSheets: [], settings: { lunchReminders: false, company: COMPANY } };
    const next = migratePersisted(v6, 6, false, COMPANY);
    expect(next.synced).toEqual({});
    expect(next.shifts).toEqual([{ id: 's1' }]);
    expect(next.seededAt).toBe(1_700_000_000_000);
  });

  it('leaves data from the current version alone', () => {
    const v7 = {
      ...v1, leave: [{ id: 'lv1' }], payRates: { e1: 2500 }, exams: [{ id: 'x1' }], areaSheets: [{ id: 'crusher' }],
      mrfs: [{ id: 'm1', status: 'completed', history: [{ at: 5000, by: 'e6', status: 'completed', note: 'Done' }] }],
      settings: { lunchReminders: false, company: COMPANY },
      synced: { 'shift:s1': 'abc' },
    };
    expect(migratePersisted(v7, 7, true, COMPANY)).toEqual(v7);
  });

  it('copes with nothing saved', () => {
    expect(migratePersisted(undefined, 1, false, COMPANY)).toEqual({ leave: [], payRates: {}, exams: [], areaSheets: [], synced: {} });
  });
});
