/**
 * The phone side of reminders: on Android, the notice that lunch is over goes out as an alarm, on a channel of its
 * own, so a person who turns the deadline reminders off in the phone's settings still gets it. The app asks for
 * notifications only when a person acts (at clock-in, and from the Lunch reminders setting): handing the phone its
 * reminders never asks, so a phone told no once is not asked again at every punch and app start. The app can say
 * whether, and ask for, the phone's permission to deliver timed notices on time.
 */
type Os = 'android' | 'ios';

/** Android's importance levels, as expo-notifications numbers them. */
const NONE = 2;
const HIGH = 6;

interface Phone {
  /** What the phone says of notifications for the app before anything is asked. */
  allowed?: { granted: boolean; canAskAgain: boolean };
  /** The importance of each notification channel already on the phone, by id. */
  channels?: Record<string, number>;
  /** The phone cannot make or read channels. */
  channelsFail?: boolean;
}

function load(os: Os, exact: { granted: boolean; afterAsk?: boolean; throws?: boolean } = { granted: true }, phone: Phone = {}) {
  const scheduled: unknown[] = [];
  const asked = { count: 0 };
  const notifications = {
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(async (_id: string, _channel: unknown) => {
      if (phone.channelsFail) throw new Error('no channels');
      return null;
    }),
    getNotificationChannelAsync: jest.fn(async (id: string) => {
      if (phone.channelsFail) throw new Error('no channels');
      const importance = phone.channels?.[id];
      return importance == null ? null : { id, importance };
    }),
    deleteNotificationChannelAsync: jest.fn(async (_id: string) => undefined),
    getPermissionsAsync: jest.fn(async () => phone.allowed ?? { granted: true, canAskAgain: true }),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
    cancelScheduledNotificationAsync: jest.fn(async (_id: string) => undefined),
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
    AndroidImportance: { NONE, HIGH },
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
const lunchOver = () => ({ id: 'lunch-end', at: inAnHour(), title: 'Lunch is over', body: 'Back on the clock.', alarm: true as const });
const lunch15 = () => ({ id: 'lunch-15', at: inAnHour(), title: 'Lunch in 15 minutes', body: 'Start lunch soon.' });
type Request = { identifier: string; trigger: { delivery?: string; channelId?: string } };

describe('scheduleLocal', () => {
  it('sends the lunch-over notice as an alarm and every other reminder as a plain timed notice', async () => {
    const { mod, scheduled } = load('android');
    await mod.scheduleLocal([lunchOver(), lunch15()]);
    const deliveries = (scheduled as Request[]).map((r) => [r.identifier, r.trigger.delivery]);
    expect(deliveries).toEqual([
      ['lunch-end', 'alarmClock'],
      ['lunch-15', 'bestEffort'],
    ]);
  });

  it('sends the lunch-over notice on its own channel, apart from the deadline reminders a person may turn off', async () => {
    const { mod, scheduled } = load('android');
    await mod.scheduleLocal([lunchOver(), lunch15()]);
    expect((scheduled as Request[]).map((r) => [r.identifier, r.trigger.channelId])).toEqual([
      ['lunch-end', 'lunch-over'],
      ['lunch-15', 'lunch-deadline'],
    ]);
  });

  it('makes both channels on Android, each named for what it brings, and takes the old shared one off the phone', async () => {
    const { mod, notifications } = load('android');
    await mod.scheduleLocal([lunchOver()]);
    const made = Object.fromEntries(notifications.setNotificationChannelAsync.mock.calls.map(([id, channel]) => [id, channel]));
    expect(Object.keys(made).sort()).toEqual(['lunch-deadline', 'lunch-over']);
    expect(made['lunch-over']).toMatchObject({ name: 'Lunch is over', importance: HIGH });
    expect(made['lunch-deadline']).toMatchObject({ name: 'Lunch deadline reminders' });
    expect(notifications.deleteNotificationChannelAsync.mock.calls).toEqual([['lunch']]);
  });

  it('makes the channels once while the app runs', async () => {
    const { mod, notifications } = load('android');
    await mod.scheduleLocal([lunchOver()]);
    await mod.scheduleLocal([lunchOver()]);
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledTimes(2);
    expect(notifications.deleteNotificationChannelAsync).toHaveBeenCalledTimes(1);
  });

  it('makes no channels on an iPhone, which has none', async () => {
    const { mod, notifications, scheduled } = load('ios');
    await mod.scheduleLocal([lunchOver()]);
    expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(notifications.deleteNotificationChannelAsync).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
  });

  it('on a phone that had the old shared channel turned off, the lunch-over notice still goes out, on the new one', async () => {
    // The reminders handed to the phone before the update went to "lunch". Each is cancelled and scheduled again.
    const { mod, notifications, scheduled } = load('android', { granted: true }, { channels: { lunch: NONE } });
    await mod.scheduleLocal([lunchOver()]);
    expect(notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('lunch-end');
    expect((scheduled as Request[]).map((r) => r.trigger.channelId)).toEqual(['lunch-over']);
    expect(await mod.lunchNoticeState()).toBe('on');
  });

  it('never asks for notifications: with them not allowed it schedules nothing, however often it runs', async () => {
    const { mod, notifications, scheduled } = load('android', { granted: true }, { allowed: { granted: false, canAskAgain: true } });
    await mod.scheduleLocal([lunchOver(), lunch15()]);
    await mod.scheduleLocal([lunchOver()]);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
  });

  it('schedules without asking once notifications are allowed', async () => {
    const { mod, notifications, scheduled } = load('ios');
    await mod.scheduleLocal([lunchOver()]);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
  });

  it('with nothing to schedule, asks nothing and reads nothing', async () => {
    const { mod, notifications } = load('android', { granted: true }, { allowed: { granted: false, canAskAgain: true } });
    await mod.scheduleLocal([]);
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('a phone that will not make the channels still gets its notices', async () => {
    const { mod, scheduled } = load('android', { granted: true }, { channelsFail: true });
    await mod.scheduleLocal([lunchOver()]);
    expect(scheduled).toHaveLength(1);
  });

  // The reminders are handed over again whenever the app comes back to the front on a shift. One that comes back in
  // the last second of a lunch must not take off the phone the notice it could no longer hand over in time.
  it('leaves the notice the phone holds when it is due within the second, too late to hand it over again', async () => {
    const { mod, notifications, scheduled } = load('android');
    await mod.scheduleLocal([{ ...lunchOver(), at: Date.now() + 500 }]);
    expect(notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
  });

  it('takes off the phone a reminder already past, as before', async () => {
    const { mod, notifications, scheduled } = load('android');
    await mod.scheduleLocal([{ ...lunch15(), at: Date.now() - 60_000 }]);
    expect(notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('lunch-15');
    expect(scheduled).toEqual([]);
  });

  it('decides what goes before it takes anything off, so a slow phone does not lose a notice due soon', async () => {
    const { mod, notifications, scheduled } = load('android');
    // The phone takes a while to say whether notifications are allowed.
    notifications.getPermissionsAsync.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { granted: true, canAskAgain: true };
    });
    await mod.scheduleLocal([{ ...lunchOver(), at: Date.now() + 1_200 }]);
    expect(notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('lunch-end');
    expect((scheduled as Request[]).map((r) => r.identifier)).toEqual(['lunch-end']);
  });
});

describe('requestNotificationPermission', () => {
  it('asks the phone while it may still ask, and reports the answer', async () => {
    const { mod, notifications } = load('android', { granted: true }, { allowed: { granted: false, canAskAgain: true } });
    expect(await mod.requestNotificationPermission()).toBe(true);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('does not ask once the phone will not ask again', async () => {
    const { mod, notifications } = load('android', { granted: true }, { allowed: { granted: false, canAskAgain: false } });
    expect(await mod.requestNotificationPermission()).toBe(false);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('does not ask when notifications are already allowed', async () => {
    const { mod, notifications } = load('android');
    expect(await mod.requestNotificationPermission()).toBe(true);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('lunchNoticeState', () => {
  it('is off while notifications are not allowed, and never asks', async () => {
    const { mod, notifications } = load('android', { granted: true }, { allowed: { granted: false, canAskAgain: true } });
    expect(await mod.lunchNoticeState()).toBe('off');
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('says so on Android when the Lunch is over channel is turned off in the phone settings', async () => {
    const { mod } = load('android', { granted: true }, { channels: { 'lunch-over': NONE, 'lunch-deadline': HIGH } });
    expect(await mod.lunchNoticeState()).toBe('lunch_over_off');
  });

  it('is on when only the deadline reminders are turned off', async () => {
    const { mod } = load('android', { granted: true }, { channels: { 'lunch-over': HIGH, 'lunch-deadline': NONE } });
    expect(await mod.lunchNoticeState()).toBe('on');
  });

  it('is on before the channel is made, and when the phone cannot say', async () => {
    expect(await load('android').mod.lunchNoticeState()).toBe('on');
    expect(await load('android', { granted: true }, { channelsFail: true }).mod.lunchNoticeState()).toBe('on');
  });

  it('on an iPhone goes by the permission alone', async () => {
    const on = load('ios', { granted: true }, { channels: { 'lunch-over': NONE } });
    expect(await on.mod.lunchNoticeState()).toBe('on');
    expect(on.notifications.getNotificationChannelAsync).not.toHaveBeenCalled();
    expect(await load('ios', { granted: true }, { allowed: { granted: false, canAskAgain: false } }).mod.lunchNoticeState()).toBe('off');
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
