import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { LocalReminder } from './notifications';

export type { LocalReminder } from './notifications';

/**
 * Local notifications — iPhone and Android.
 *
 * Reminders are scheduled with the operating system at clock-in, so they still
 * arrive with the app closed, the phone locked, or no signal in the pit.
 */
const CHANNEL = 'lunch';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Lunch reminders',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 300, 200, 300],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

export async function requestNotificationPermission(): Promise<boolean> {
  try {
    await ensureChannel();
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    return (await Notifications.requestPermissionsAsync()).granted;
  } catch {
    return false;
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

export async function scheduleLocal(reminders: LocalReminder[]): Promise<void> {
  await cancelLocal(reminders.map((r) => r.id));
  if (!(await requestNotificationPermission())) return;
  for (const reminder of reminders) {
    if (reminder.at <= Date.now() + 1000) continue;
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: reminder.id,
        content: { title: reminder.title, body: reminder.body, sound: true },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(reminder.at),
          channelId: CHANNEL,
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
