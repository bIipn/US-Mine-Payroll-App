import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { DEADLINE_CHANNEL, LUNCH_OVER_CHANNEL, OLD_CHANNEL_ID } from './notificationChannels';
import type { LocalReminder, LunchNotice } from './notifications';

export type { LocalReminder, LunchNotice } from './notifications';

/**
 * Local notifications — iPhone and Android.
 *
 * Reminders are scheduled with the operating system at clock-in, so they still
 * arrive with the app closed, the phone locked, or no signal in the pit.
 *
 * The phone is asked whether the app may send notifications only when a person
 * acts: at clock-in and from the Lunch reminders setting
 * (`requestNotificationPermission`). Handing the phone its reminders never asks.
 * Android 13 and later ask a second time after a first no, and after a second
 * one never again, so an ask at every punch and app start would use that up.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const LOUD = {
  importance: Notifications.AndroidImportance.HIGH,
  vibrationPattern: [0, 300, 200, 300],
  lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
};

let channelsMade: Promise<void> | null = null;

/**
 * Android: makes the two channels, once while the app runs, and takes the old shared one off the phone. A reminder
 * handed to the phone before then was on the old one; each is scheduled again on its own channel whenever reminders
 * are handed over (`scheduleLocal` cancels a reminder before it schedules it). A phone that cannot make them still
 * gets its notices, on Android's own fallback channel.
 */
function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  channelsMade ??= (async () => {
    await Notifications.setNotificationChannelAsync(LUNCH_OVER_CHANNEL.id, { name: LUNCH_OVER_CHANNEL.name, ...LOUD });
    await Notifications.setNotificationChannelAsync(DEADLINE_CHANNEL.id, { name: DEADLINE_CHANNEL.name, ...LOUD });
    await Notifications.deleteNotificationChannelAsync(OLD_CHANNEL_ID);
  })().catch(() => {
    channelsMade = null;
  });
  return channelsMade;
}

/** Asks the phone, if it may still ask, whether the app may send notifications. For a clock-in and the Lunch reminders setting only. */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    await ensureChannels();
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    return (await Notifications.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/**
 * Whether the notice that lunch is over can reach the person, without asking anything. On Android a person can turn
 * off the Lunch is over kind alone in the phone's settings, and the phone drops a notice of that kind without telling
 * the app, so the channel is read as well as the permission. When the phone cannot say about the channel, it is on.
 */
export async function lunchNoticeState(): Promise<LunchNotice> {
  try {
    if (!(await Notifications.getPermissionsAsync()).granted) return 'off';
  } catch {
    return 'off';
  }
  if (Platform.OS !== 'android') return 'on';
  try {
    const channel = await Notifications.getNotificationChannelAsync(LUNCH_OVER_CHANNEL.id);
    return channel?.importance === Notifications.AndroidImportance.NONE ? 'lunch_over_off' : 'on';
  } catch {
    return 'on';
  }
}

/**
 * Whether the phone delivers timed notices at the minute. Android 12 and later may hold them back to save battery
 * unless MineMuster may set alarms (Android 14 and later start with that off); an iPhone always delivers on time.
 * When the phone cannot say, the answer is yes, so nobody is asked for nothing.
 */
export async function onTimeNotices(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    return (await Notifications.getExactAlarmPermissionsAsync()).granted;
  } catch {
    return true;
  }
}

/**
 * Opens the phone's Alarms & reminders setting for MineMuster and says whether it is on when the person comes back.
 * Never asks on an iPhone.
 */
export async function allowOnTimeNotices(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    return (await Notifications.requestExactAlarmPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

export async function cancelLocal(ids: string[]): Promise<void> {
  await Promise.all(
    ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)),
  );
}

/** How far ahead a reminder must be for the phone to be handed it: one any sooner could be in the past by then. */
const LEAD_MS = 1000;

/**
 * Hands the reminders to the phone, each replacing any of the same id already there. Never asks for notifications.
 * Which go is decided once, before anything is taken off the phone: those at least a second ahead. One due within
 * the second is left as the phone holds it, since it could not be handed over again in time and taking it off
 * would lose it (the reminders are handed over again every time the app comes back to the front on a shift); one
 * already past is taken off.
 */
export async function scheduleLocal(reminders: LocalReminder[]): Promise<void> {
  if (!reminders.length) return;
  const now = Date.now();
  const ahead = reminders.filter((r) => r.at > now + LEAD_MS);
  await cancelLocal(reminders.filter((r) => r.at <= now || r.at > now + LEAD_MS).map((r) => r.id));
  await ensureChannels();
  try {
    if (!(await Notifications.getPermissionsAsync()).granted) return;
  } catch {
    return;
  }
  for (const reminder of ahead) {
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: reminder.id,
        content: { title: reminder.title, body: reminder.body, sound: true },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(reminder.at),
          // Android: the lunch-over notice on its own channel, so turning the deadline reminders off never silences it.
          channelId: reminder.alarm ? LUNCH_OVER_CHANNEL.id : DEADLINE_CHANNEL.id,
          // Android: an alarm is delivered at the minute even while the phone saves battery (it shows the alarm
          // icon until then). Without the Alarms & reminders permission both fall back to a timed notice.
          delivery: reminder.alarm ? 'alarmClock' : 'bestEffort',
        },
      });
    } catch {
      // A reminder that cannot be scheduled must never block a punch.
    }
  }
}
