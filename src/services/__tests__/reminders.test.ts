/**
 * The reminders are handed to the phone one hand-over at a time, each planned from the records as they are when
 * its turn comes, not when it was asked for: a hand-over on coming back to the front and a punch's own can be asked
 * for moments apart (a punch's location read can send the app to the back and to the front again), and the one
 * planned from the shift before the punch must never land after the punch's. One the phone never answers holds up
 * the next for ten seconds at most, so the notice that lunch is over still goes. The phone's notifications are
 * stand-ins here. Everyone and everything here is made up.
 */
import type { LocalReminder } from '../notifications';

jest.mock('../notifications', () => ({ cancelLocal: jest.fn(), scheduleLocal: jest.fn() }));

const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});
for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });

type Reminders = typeof import('../reminders');
type Store = typeof import('../../store/useStore')['useStore'];
type Phone = { cancelLocal: jest.Mock; scheduleLocal: jest.Mock };
type Shift = import('../../domain/types').Shift;

const HOUR = 3_600_000;
const DEADLINE_IDS = ['lunch-60', 'lunch-30', 'lunch-15', 'lunch-0'];

/** A fresh copy of the reminders, the store and the phone's stand-ins, so no queue is left over from another test. */
function load(): { reminders: Reminders; useStore: Store; phone: Phone } {
  let loaded: { reminders: Reminders; useStore: Store; phone: Phone } | undefined;
  jest.isolateModules(() => {
    const phone = require('../notifications') as Phone;
    phone.cancelLocal.mockImplementation(async () => undefined);
    phone.scheduleLocal.mockImplementation(async () => undefined);
    loaded = { reminders: require('../reminders'), useStore: (require('../../store/useStore') as { useStore: Store }).useStore, phone };
  });
  return loaded!;
}

/** Lee signed in on a California shift, clocked in an hour ago, with `lunches`. */
function onShift(useStore: Store, lunches: Shift['lunches'] = []) {
  const now = Date.now();
  useStore.getState().ensureSeeded();
  const { settings } = useStore.getState();
  useStore.setState({
    employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }],
    accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
    session: { accountId: 'acct-lee', employeeId: 'emp-lee' },
    shifts: [{ id: 'sh-lee', employeeId: 'emp-lee', clockIn: { at: now - HOUR, noLocation: 'off' }, lunches, breaks: [] }],
    settings: { ...settings, lunchReminders: true, company: { ...settings.company, name: 'Test Pit A', state: 'CA', pay: null, timeClock: undefined } },
  });
}
const clockedOut = (useStore: Store) =>
  useStore.setState({ shifts: useStore.getState().shifts.map((s) => ({ ...s, clockOut: { at: Date.now(), noLocation: 'off' as const } })) });

/** A call to the phone that answers only when told to. */
function later() {
  let answer: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  return { answered, answer };
}
const ids = (call: unknown[]) => (call[0] as LocalReminder[]).map((r) => r.id);
async function ticks(n = 10) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

it('makes one hand-over at a time, each from the records as they are when its turn comes', async () => {
  const { reminders, useStore, phone } = load();
  onShift(useStore);
  const slow = later();
  phone.scheduleLocal.mockImplementationOnce(() => slow.answered);

  // Back in the app before the punch: the deadline reminders are handed over again, and the phone takes its time.
  const handOver = reminders.handOverWaiting();
  await ticks();
  expect(phone.scheduleLocal).toHaveBeenCalledTimes(1);
  expect(ids(phone.scheduleLocal.mock.calls[0])).toEqual(DEADLINE_IDS);

  // The clock-out is recorded and its own hand-over asked for: it waits its turn.
  clockedOut(useStore);
  const punch = reminders.syncReminders();
  await ticks();
  expect(phone.cancelLocal).not.toHaveBeenCalled();

  slow.answer();
  await Promise.all([handOver, punch]);
  // Planned once its turn came, from the shift as it is now: closed, so everything comes off.
  expect(phone.cancelLocal.mock.calls).toEqual([[[...DEADLINE_IDS, 'lunch-end']]]);
  expect(phone.scheduleLocal).toHaveBeenCalledTimes(2);
  expect(phone.scheduleLocal.mock.calls[1][0]).toEqual([]);
});

it('holds up the next hand-over for ten seconds at most when the phone never answers', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate'] });
  const { reminders, useStore, phone } = load();
  onShift(useStore);
  phone.scheduleLocal.mockImplementationOnce(() => new Promise(() => undefined));

  void reminders.handOverWaiting();
  await ticks();
  const stillInTurn = phone.scheduleLocal.mock.calls[0][1] as () => boolean;
  expect(stillInTurn()).toBe(true);

  // Lunch starts: the notice that lunch is over must still be handed over.
  const now = Date.now();
  useStore.setState({ shifts: useStore.getState().shifts.map((s) => ({ ...s, lunches: [{ start: { at: now, noLocation: 'off' as const }, end: { at: now + 30 * 60_000, auto: true as const } }] })) });
  const punch = reminders.syncReminders();
  await jest.advanceTimersByTimeAsync(reminders.TURN_MS - 1);
  expect(phone.cancelLocal).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(1);
  await punch;
  // The stuck hand-over's turn is over: it may make no more calls.
  expect(stillInTurn()).toBe(false);
  expect(phone.cancelLocal.mock.calls).toEqual([[DEADLINE_IDS]]);
  expect(ids(phone.scheduleLocal.mock.calls[1])).toEqual(['lunch-end']);
});

it('a hand-over that answers after its turn makes no more calls, and is made once more from the records as they are then', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate'] });
  const { reminders, useStore, phone } = load();
  const now = Date.now();
  onShift(useStore, [{ start: { at: now, noLocation: 'off' }, end: { at: now + 30 * 60_000, auto: true } }]);
  const slow = later();
  phone.cancelLocal.mockImplementationOnce(() => slow.answered);

  // Lunch started: the deadline reminders come off first, and the phone takes longer than a turn to answer.
  void reminders.syncReminders();
  await jest.advanceTimersByTimeAsync(reminders.TURN_MS);
  slow.answer();
  await jest.advanceTimersByTimeAsync(0);
  await ticks();

  // It went no further itself (a later hand-over may have been made meanwhile), and was made again in its own turn:
  // the notice that lunch is over is on the phone.
  expect(phone.cancelLocal).toHaveBeenCalledTimes(2);
  expect(phone.scheduleLocal).toHaveBeenCalledTimes(1);
  expect(ids(phone.scheduleLocal.mock.calls[0])).toEqual(['lunch-end']);
});

it('a hand-over made again after a clock-out is planned from the clock-out, never from the lunch it was asked for during', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate'] });
  const { reminders, useStore, phone } = load();
  const now = Date.now();
  onShift(useStore, [{ start: { at: now, noLocation: 'off' }, end: { at: now + 30 * 60_000, auto: true } }]);
  const slow = later();
  phone.scheduleLocal.mockImplementationOnce(() => slow.answered);

  // At lunch, back in the app: the notice that lunch is over is handed over again, and the phone takes longer than a
  // turn to answer.
  void reminders.handOverWaiting();
  await ticks();
  expect(ids(phone.scheduleLocal.mock.calls[0])).toEqual(['lunch-end']);
  await jest.advanceTimersByTimeAsync(reminders.TURN_MS);

  // The person clocks out, and the clock-out's own hand-over takes everything off the phone.
  clockedOut(useStore);
  const punch = reminders.syncReminders();
  await jest.advanceTimersByTimeAsync(0);
  await punch;
  expect(phone.cancelLocal.mock.calls).toEqual([[[...DEADLINE_IDS, 'lunch-end']]]);
  const byTheClockOut = phone.scheduleLocal.mock.calls.length;

  // Then the slow call answers, and the hand-over it was part of is made once more, in a turn of its own: planned
  // then, from the closed shift, it hands nothing over. Planned when it was asked for, it would put the notice that
  // lunch is over back on the phone after the person had left.
  slow.answer();
  await jest.advanceTimersByTimeAsync(reminders.TURN_MS);
  await ticks();
  const afterTheClockOut = phone.scheduleLocal.mock.calls.slice(byTheClockOut);
  expect(afterTheClockOut.filter((call) => ids(call).includes('lunch-end'))).toEqual([]);
  expect(phone.cancelLocal).toHaveBeenCalledTimes(1);
});

it('makes a hand-over again once at most, however late the phone answers', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate'] });
  const { reminders, useStore, phone } = load();
  onShift(useStore);
  const first = later();
  const second = later();
  phone.scheduleLocal.mockImplementationOnce(() => first.answered).mockImplementationOnce(() => second.answered);

  void reminders.handOverWaiting();
  await jest.advanceTimersByTimeAsync(reminders.TURN_MS);
  first.answer();
  await jest.advanceTimersByTimeAsync(reminders.TURN_MS);
  second.answer();
  await jest.advanceTimersByTimeAsync(reminders.TURN_MS);
  await ticks();
  expect(phone.scheduleLocal).toHaveBeenCalledTimes(2);
});

it('with nobody signed in, hands nothing over and takes nothing off', async () => {
  const { reminders, useStore, phone } = load();
  onShift(useStore);
  useStore.setState({ session: null });
  await reminders.syncReminders();
  await reminders.handOverWaiting();
  expect(phone.cancelLocal).not.toHaveBeenCalled();
  expect(phone.scheduleLocal).not.toHaveBeenCalled();
});

/**
 * In a browser, only the tab that saves the records hands reminders over (storage.ts, recordsTab.ts): another tab of
 * MineMuster is hidden behind MineMuster is open in another tab (`recordsElsewhere`), and what its store has may be
 * older than what the tab that saves them has saved since. The store says so in `recordsElsewhere`; a phone never
 * has another tab, so there it is never true.
 */
describe('a browser tab that another tab has the records in', () => {
  /** Let every hand-over asked for so far be made. */
  const made = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  /** The store has read what is saved (nothing, here), as it has before App.tsx starts the reminders. */
  const read = async (useStore: Store) => {
    for (let i = 0; i < 50 && !useStore.getState().hydrated; i += 1) await new Promise<void>((r) => setImmediate(() => r()));
    expect(useStore.getState().hydrated).toBe(true);
  };
  /** Lunch starts at `at`, and ends by itself 30 minutes later. */
  const atLunch = (useStore: Store, at = Date.now()) =>
    useStore.setState({ shifts: useStore.getState().shifts.map((s) => ({ ...s, lunches: [{ start: { at, noLocation: 'off' as const }, end: { at: at + 30 * 60_000, auto: true as const } }] })) });

  it('hands nothing over and takes nothing off, at start-up or on coming back to the front', async () => {
    const { reminders, useStore, phone } = load();
    await read(useStore);
    onShift(useStore);
    useStore.setState({ recordsElsewhere: true });
    await reminders.syncReminders();
    await reminders.handOverWaiting();
    expect(phone.cancelLocal).not.toHaveBeenCalled();
    expect(phone.scheduleLocal).not.toHaveBeenCalled();
  });

  it('takes its reminders off once another tab takes the records, and hands them over from what it reads once it has them back', async () => {
    const { reminders, useStore, phone } = load();
    await read(useStore);
    onShift(useStore);
    const stop = reminders.watchReminders();
    await reminders.syncReminders();
    expect(ids(phone.scheduleLocal.mock.calls[0])).toEqual(DEADLINE_IDS);
    phone.cancelLocal.mockClear();
    phone.scheduleLocal.mockClear();

    // Use this tab, in another tab: this one saves nothing more (watchOtherTabs), and its reminders come off.
    useStore.setState({ recordsElsewhere: true });
    await made();
    expect(phone.cancelLocal.mock.calls).toEqual([[[...DEADLINE_IDS, 'lunch-end']]]);
    expect(phone.scheduleLocal).not.toHaveBeenCalled();

    // Lunch starts in the other tab. This tab has the records back once that one closes: it reads them (the store
    // merges what it read), and only then says it has them (onRehydrateStorage). What it read is what it goes by.
    const lunchAt = Date.now();
    atLunch(useStore, lunchAt);
    await made();
    expect(phone.scheduleLocal).not.toHaveBeenCalled();
    useStore.setState({ recordsElsewhere: false });
    await made();
    expect(phone.scheduleLocal.mock.calls.map(ids)).toEqual([['lunch-end']]);
    expect((phone.scheduleLocal.mock.calls[0][0] as LocalReminder[])[0].at).toBe(lunchAt + 30 * 60_000);
    stop();
  });

  it('leaves the notice that lunch is over on the phone once its time has come, when another tab takes the records', async () => {
    const { reminders, useStore, phone } = load();
    await read(useStore);
    onShift(useStore);
    // Lunch ended a minute ago: the browser may still be holding its notice back on this tab, in the back.
    atLunch(useStore, Date.now() - 31 * 60_000);
    const stop = reminders.watchReminders();
    useStore.setState({ recordsElsewhere: true });
    await made();
    expect(phone.cancelLocal.mock.calls).toEqual([[DEADLINE_IDS]]);
    stop();
  });

  it('hands nothing over again when the records cannot be read once it has them back', async () => {
    const { reminders, useStore, phone } = load();
    await read(useStore);
    onShift(useStore);
    const stop = reminders.watchReminders();
    useStore.setState({ recordsElsewhere: true });
    await made();
    phone.cancelLocal.mockClear();
    // The read failed: Records not read is shown in place of the app, and what the store has is what it had before.
    useStore.setState({ recordsElsewhere: false, recordsUnreadable: true });
    await made();
    await reminders.handOverWaiting();
    expect(phone.cancelLocal).not.toHaveBeenCalled();
    expect(phone.scheduleLocal).not.toHaveBeenCalled();
    stop();
  });

  it('a slow taking-off, made again after the tab has the records back, takes nothing off', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate'] });
    const { reminders, useStore, phone } = load();
    await read(useStore);
    onShift(useStore);
    atLunch(useStore);
    const stop = reminders.watchReminders();
    const slow = later();
    phone.cancelLocal.mockImplementationOnce(() => slow.answered);

    // Another tab takes the records, and the phone takes longer than a turn to take this tab's reminders off.
    useStore.setState({ recordsElsewhere: true });
    await jest.advanceTimersByTimeAsync(reminders.TURN_MS);
    // This tab has them back, and the notice that lunch is over is handed over from what it read.
    useStore.setState({ recordsElsewhere: false });
    await jest.advanceTimersByTimeAsync(0);
    await ticks();
    expect(phone.scheduleLocal.mock.calls.map(ids)).toEqual([['lunch-end']]);
    const byTheHandOver = phone.cancelLocal.mock.calls.length;

    // Then the slow call answers, and the taking-off is made once more: the tab has the records, so it takes nothing off.
    slow.answer();
    await jest.advanceTimersByTimeAsync(reminders.TURN_MS);
    await ticks();
    expect(phone.cancelLocal.mock.calls.slice(byTheHandOver).filter(([taken]) => (taken as string[]).includes('lunch-end'))).toEqual([]);
    stop();
  });

  it('on a phone, where the records are never in another tab, a change to the store hands nothing over by itself', async () => {
    const { reminders, useStore, phone } = load();
    await read(useStore);
    onShift(useStore);
    const stop = reminders.watchReminders();
    atLunch(useStore);
    clockedOut(useStore);
    useStore.setState({ toast: { id: 1, message: 'Clocked out.', tone: 'ok' } });
    await made();
    expect(phone.cancelLocal).not.toHaveBeenCalled();
    expect(phone.scheduleLocal).not.toHaveBeenCalled();
    stop();
  });
});
