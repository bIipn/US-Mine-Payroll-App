// The store's side of receiving the company's roster, fleet, sheets and settings: the receiving
// state a connected phone keeps, the guards that stop a late or stray answer from being applied,
// who the phone's company sign-in is, the company's own row for a company that never sent its
// settings, and the sent, held and floored marks of a send. The rules themselves are
// src/domain/receive.ts; these hold the store to applying them. Made-up company and people.
import { freshReceiving } from '../../domain/receive';
import { revOf, sharedSettings, type ReceivedRow } from '../../domain/sync';
import type { Equipment } from '../../domain/types';
import { useStore } from '../useStore';

const s = () => useStore.getState();
const COMPANY = 'c-test-a';
const ACCOUNT = 'u-lee';
const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m, 0).getTime();

let seq = 0;
function row(kind: ReceivedRow['kind'], id: string, data: object | null): ReceivedRow {
  seq += 1;
  return data === null ? { kind, id, rev: 'deleted', seq, deleted: true, data: {} } : { kind, id, rev: revOf(data), seq, deleted: false, data };
}

/** This phone joined Test Pit A with Lee's sign-in, and the company has answered who that is. */
function connect(role: 'employee' | 'supervisor' | null = 'employee') {
  useStore.setState({
    connectedCompany: { id: COMPANY, name: 'Test Pit A', role: 'employee', userId: ACCOUNT, email: 'lee@example.test' },
    syncedWith: COMPANY,
    synced: {},
    receiving: null,
  });
  s().ensureReceiving();
  if (role) useStore.setState({ receiving: { ...s().receiving!, role, name: { firstName: 'Lee', lastName: 'Park' } } });
}
const ctx = () => ({ company: COMPANY, account: ACCOUNT, epoch: s().receiving!.epoch });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(at(6, 15));
  s().resetDemo();
  seq = 0;
});
afterEach(() => jest.useRealTimers());

describe('ensureReceiving', () => {
  it('starts receiving on a connected phone that has none, or has another company’s', () => {
    expect(s().receiving).toBeNull();
    s().ensureReceiving();
    expect(s().receiving).toBeNull();
    connect(null);
    expect(s().receiving).toEqual(freshReceiving(COMPANY, null));
    useStore.setState({ receiving: { ...freshReceiving('c-other'), cursor: 40 } });
    s().ensureReceiving();
    expect(s().receiving).toEqual(freshReceiving(COMPANY, null));
    // The same company's is kept as it is.
    useStore.setState({ receiving: { ...s().receiving!, cursor: 12 } });
    s().ensureReceiving();
    expect(s().receiving!.cursor).toBe(12);
  });
});

describe('applyReceived', () => {
  const sheet = { id: 'test-sheet', title: 'Test bench', rows: [{ id: 'r1', label: 'Walkways' }], active: true };

  it('applies nothing for another company, another account or an older epoch', () => {
    connect();
    const before = s().areaSheets;
    expect(s().applyReceived({ ...ctx(), company: 'c-other' }, [row('areaSheet', sheet.id, sheet)])).toBe(false);
    expect(s().applyReceived({ ...ctx(), account: 'u-other' }, [row('areaSheet', sheet.id, sheet)])).toBe(false);
    expect(s().applyReceived({ ...ctx(), epoch: ctx().epoch - 1 }, [row('areaSheet', sheet.id, sheet)])).toBe(false);
    useStore.setState({ connectedCompany: null });
    expect(s().applyReceived(ctx(), [row('areaSheet', sheet.id, sheet)])).toBe(false);
    expect(s().areaSheets).toBe(before);
  });

  it('merges a page with the store as it is at that moment, and moves the cursor in the same write', () => {
    connect();
    const page = [row('areaSheet', sheet.id, sheet)];
    const context = ctx();
    // Something done on the phone while the page was on its way.
    const added = { ...s().equipment[0], id: 'eq_added_here' };
    useStore.setState({ equipment: [...s().equipment, added] });
    const writes: number[] = [];
    const stop = useStore.subscribe(() => writes.push(s().receiving!.cursor));
    expect(s().applyReceived(context, page)).toBe(true);
    stop();
    expect(writes).toEqual([page[0].seq]);
    expect(s().areaSheets.find((a) => a.id === sheet.id)).toEqual(sheet);
    expect(s().equipment.some((e) => e.id === 'eq_added_here')).toBe(true);
    expect(s().synced[`areaSheet:${sheet.id}`]).toBe(page[0].rev);
  });

  it('marks the phone caught up on an empty page', () => {
    connect();
    s().applyReceived(ctx(), []);
    expect(s().receiving!.caughtUpAt).toBe(at(6, 15));
  });
});

describe('applyStanding', () => {
  it('is the only way a role reaches the rules: one Company account saw first still takes the payroll IDs off', () => {
    connect('supervisor');
    const withIds = s().employees.map((e, i) => (i < 2 ? { ...e, payrollId: `P${i}` } : e));
    useStore.setState({ employees: withIds });
    // Company account found the sign-in made crew, and noted it for showing.
    s().confirmConnection({ userId: ACCOUNT, email: 'lee@example.test', role: 'employee', name: 'Test Pit A' });
    expect(s().receiving!.role).toBe('supervisor');
    expect(s().employees.filter((e) => e.payrollId)).toHaveLength(2);
    expect(s().applyStanding(ctx(), { role: 'employee', name: { firstName: 'Lee', lastName: 'Park' } })).toBe(true);
    expect(s().receiving).toMatchObject({ role: 'employee', cursor: 0 });
    expect(s().employees.some((e) => e.payrollId)).toBe(false);
  });

  it('notes a sign-in taken off the roster', () => {
    connect('employee');
    s().applyStanding(ctx(), null);
    expect(s().receiving!.role).toBe('none');
  });

  it('applies nothing for another account', () => {
    connect('employee');
    expect(s().applyStanding({ ...ctx(), account: 'u-other' }, null)).toBe(false);
    expect(s().receiving!.role).toBe('employee');
  });
});

describe('takeCompanyRow', () => {
  const blank = () => useStore.setState({ settings: { ...s().settings, company: { name: '', state: '', pay: null } } });

  it('fills a blank company from the company’s own row when it never sent its settings', () => {
    connect('supervisor');
    blank();
    const pay = { frequency: 'semimonthly', payday: { dayOfMonth: [20, 5] }, ifBankClosed: 'before' };
    expect(s().takeCompanyRow(ctx(), { name: 'Test Pit A', state: 'NV', pay })).toBe(true);
    expect(s().settings.company).toEqual({ name: 'Test Pit A', state: 'NV', pay });
  });

  it('leaves out a pay schedule the app cannot use', () => {
    connect('supervisor');
    blank();
    s().takeCompanyRow(ctx(), { name: 'Test Pit A', state: 'NV', pay: { frequency: 'yearly' } });
    expect(s().settings.company).toEqual({ name: 'Test Pit A', state: 'NV', pay: null });
  });

  it('changes nothing once the company’s settings came, or while the phone’s company is whole', () => {
    connect('supervisor');
    const whole = s().settings.company;
    expect(s().takeCompanyRow(ctx(), { name: 'Other', state: 'NV', pay: null })).toBe(false);
    expect(s().settings.company).toBe(whole);
    blank();
    useStore.setState({ synced: { 'settings:company': revOf(sharedSettings(s().settings)) } });
    expect(s().takeCompanyRow(ctx(), { name: 'Other', state: 'NV', pay: null })).toBe(false);
    expect(s().settings.company.name).toBe('');
  });
});

describe('at each start', () => {
  it('reads again from the start when some of the company’s records could not be read', () => {
    connect('employee');
    useStore.setState({ receiving: { ...s().receiving!, cursor: 80, epoch: 3, unreadable: ['areaSheet:x'] } });
    s().readUnreadableAgain();
    expect(s().receiving).toMatchObject({ cursor: 0, epoch: 4, unreadable: [] });
    s().readUnreadableAgain();
    expect(s().receiving).toMatchObject({ cursor: 0, epoch: 4 });
  });
});

describe('ensureSeeded on a connected phone', () => {
  it('puts no person or sheet of the build on a phone once it has sent to a company', () => {
    const owner = { firstName: 'Gus', lastName: 'Webb' };
    const sheet = { id: 'build-sheet', title: 'Build sheet', rows: [{ id: 'r1', label: 'Walkways' }], active: true };
    connect('employee');
    s().ensureSeeded(owner, [sheet], []);
    expect(s().employees.some((e) => e.lastName === 'Webb')).toBe(false);
    expect(s().areaSheets.some((a) => a.id === 'build-sheet')).toBe(false);
    useStore.setState({ syncedWith: null, connectedCompany: null });
    s().ensureSeeded(owner, [sheet], []);
    expect(s().employees.some((e) => e.lastName === 'Webb')).toBe(true);
    expect(s().areaSheets.some((a) => a.id === 'build-sheet')).toBe(true);
  });
});

describe('the marks of a send', () => {
  const unitChange = (unit: Equipment) => ({ key: `equipment:${unit.id}`, kind: 'equipment' as const, id: unit.id, rev: revOf(unit), record: unit });

  it('saves a sent mark for the four kinds before the call, and drops it with the answer', () => {
    connect('supervisor');
    const unit = { ...s().equipment[0], status: 'defect' as const, meter: 9999 };
    const shift = { key: 'shift:s1', kind: 'shift' as const, id: 's1', rev: 'r1', record: { id: 's1' } };
    s().markSending([unitChange(unit), shift], COMPANY);
    expect(s().receiving!.sent).toEqual({ [`equipment:${unit.id}`]: revOf(unit) });
    s().markSynced([{ key: `equipment:${unit.id}`, rev: revOf(unit) }], COMPANY, [unitChange(unit)]);
    expect(s().receiving!.sent).toEqual({});
    expect(s().receiving!.units[unit.id]).toEqual({ status: 'defect', meter: 9999 });
    expect(s().synced[`equipment:${unit.id}`]).toBe(revOf(unit));
  });

  it('notes nothing for another company', () => {
    connect('supervisor');
    const unit = s().equipment[0];
    s().markSending([unitChange(unit)], 'c-other');
    expect(s().receiving!.sent).toEqual({});
  });

  it('holds what the server would not take, without counting it as sent', () => {
    connect('employee');
    s().markSending([{ key: 'leave:l1', kind: 'leave', id: 'l1', rev: 'r1', record: {} }], COMPANY);
    s().holdRefused([{ key: 'leave:l1', rev: 'r1', reason: 'supervisor_only' }], COMPANY);
    expect(s().receiving!.held).toEqual({ 'leave:l1': { rev: 'r1', reason: 'supervisor_only' } });
    expect(s().synced['leave:l1']).toBeUndefined();
  });

  it('keeps a unit at the floor the company’s open requests set, and says so', () => {
    connect('employee');
    const unit = s().equipment[0];
    useStore.setState({
      equipment: s().equipment.map((e) => (e.id === unit.id ? { ...e, status: 'ready' } : e)),
      receiving: { ...s().receiving!, units: { [unit.id]: { status: 'defect', meter: unit.meter } }, sent: { [`equipment:${unit.id}`]: 'r1' } },
    });
    s().keepFloor([{ key: `equipment:${unit.id}`, rev: 'r1', floor: 'out_of_service' }], COMPANY);
    expect(s().equipment.find((e) => e.id === unit.id)!.status).toBe('out_of_service');
    expect(s().receiving!.sent).toEqual({});
    expect(s().receiving!.notices[0].words).toBe(`Unit ${unit.unit} stays red tagged: a maintenance request on it is still open with the company.`);
    s().keepFloor([{ key: `equipment:${unit.id}`, rev: 'r2', floor: 'defect' }], COMPANY);
    expect(s().receiving!.notices[0].words).toBe(`Unit ${unit.unit} stays marked for a defect: a maintenance request on it is still open with the company.`);
  });
});

describe('Done, on what the company did not take and on its notices', () => {
  it('keeps a change held and takes it off the list, and marks a notice seen', () => {
    connect('employee');
    s().holdRefused([{ key: 'leave:l1', rev: 'r1', reason: 'not_yours' }], COMPANY);
    s().dismissHeld([{ key: 'leave:l1', rev: 'r1' }, { key: 'areaSheet:a1', rev: 'r9' }]);
    expect(s().receiving!.held).toEqual({
      'leave:l1': { rev: 'r1', reason: 'not_yours', seen: true },
      // Passed over for the phone's role: held from now on at that version.
      'areaSheet:a1': { rev: 'r9', reason: 'supervisor_only', seen: true },
    });
    useStore.setState({ receiving: { ...s().receiving!, notices: [{ id: 'n1', at: at(6), words: 'Something' }] } });
    s().dismissNotice('n1');
    expect(s().receiving!.notices).toEqual([{ id: 'n1', at: at(6), words: 'Something', seen: true }]);
  });
});
