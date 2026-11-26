/**
 * The phone side of reminders: on Android, the notice that lunch is over goes out as an alarm, and the app can say
 * whether, and ask for, the phone's permission to deliver timed notices on time.
 */
type Os = 'android' | 'ios';

function load(os: Os, exact: { granted: boolean; afterAsk?: boolean; throws?: boolean } = { granted: true }) {
  const scheduled: unknown[] = [];
  const asked = { count: 0 };
  const notifications = {
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(async () => null),
    getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
    cancelScheduledNotificationAsync: jest.fn(async () => undefined),
    scheduleNotificationAsync: jest.fn(async (request: unknown) => {
      scheduled.push(request);
      return 'id';
    }),
    getExactAlarmPermissionsAsync: jest.fn(async () => {
      if (exact.throws) throw new Error('not available');
      return { granted: exact.granted, canAskAgain: true };
    }),
    requestExactAlarmPermissionsAsync: jest.fn(async () => {
      asked.count += 1;
      if (exact.throws) throw new Error('not available');
      return { granted: exact.afterAsk ?? exact.granted, canAskAgain: true };
    }),
    SchedulableTriggerInputTypes: { DATE: 'date' },
    AndroidImportance: { HIGH: 4 },
    AndroidNotificationVisibility: { PUBLIC: 1 },
  };
  let mod: typeof import('../notifications.native') | undefined;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os } }));
    jest.doMock('expo-notifications', () => notifications);
    mod = require('../notifications.native');
  });
  return { mod: mod!, notifications, scheduled, asked };
}

const inAnHour = () => Date.now() + 3_600_000;

describe('scheduleLocal', () => {
  it('sends the lunch-over notice as an alarm and every other reminder as a plain timed notice', async () => {
    const { mod, scheduled } = load('android');
    await mod.scheduleLocal([
      { id: 'lunch-end', at: inAnHour(), title: 'Lunch is over', body: 'Back on the clock.', alarm: true },
      { id: 'lunch-15', at: inAnHour(), title: 'Lunch in 15 minutes', body: 'Start lunch soon.' },
    ]);
    const deliveries = (scheduled as { identifier: string; trigger: { delivery?: string } }[]).map((r) => [r.identifier, r.trigger.delivery]);
    expect(deliveries).toEqual([
      ['lunch-end', 'alarmClock'],
      ['lunch-15', 'bestEffort'],
    ]);
  });
});

describe('onTimeNotices', () => {
  it('reports the Android alarms permission', async () => {
    expect(await load('android', { granted: false }).mod.onTimeNotices()).toBe(false);
    expect(await load('android', { granted: true }).mod.onTimeNotices()).toBe(true);
  });

  it('is always yes on an iPhone, which never holds a timed notice back', async () => {
    const { mod, notifications } = load('ios', { granted: false });
    expect(await mod.onTimeNotices()).toBe(true);
    expect(notifications.getExactAlarmPermissionsAsync).not.toHaveBeenCalled();
  });

  it('does not nag when the phone cannot say', async () => {
    expect(await load('android', { granted: false, throws: true }).mod.onTimeNotices()).toBe(true);
  });
});

describe('allowOnTimeNotices', () => {
  it('asks Android for the permission and reports the answer', async () => {
    const { mod, asked } = load('android', { granted: false, afterAsk: true });
    expect(await mod.allowOnTimeNotices()).toBe(true);
    expect(asked.count).toBe(1);
  });

  it('reports a refusal', async () => {
    expect(await load('android', { granted: false, afterAsk: false }).mod.allowOnTimeNotices()).toBe(false);
  });

  it('never asks on an iPhone', async () => {
    const { mod, asked } = load('ios', { granted: false });
    expect(await mod.allowOnTimeNotices()).toBe(true);
    expect(asked.count).toBe(0);
  });

  it('reports no instead of throwing when the phone cannot ask', async () => {
    expect(await load('android', { granted: false, throws: true }).mod.allowOnTimeNotices()).toBe(false);
  });
});
