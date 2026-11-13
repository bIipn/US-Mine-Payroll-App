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

  it('leaves data from the current version alone', () => {
    const v2 = { ...v1, leave: [{ id: 'lv1' }], payRates: { e1: 2500 } };
    expect(migratePersisted(v2, 2, true)).toEqual(v2);
  });

  it('copes with nothing saved', () => {
    expect(migratePersisted(undefined, 1, false)).toEqual({ leave: [], payRates: {} });
  });
});
