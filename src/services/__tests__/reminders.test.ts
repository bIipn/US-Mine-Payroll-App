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
