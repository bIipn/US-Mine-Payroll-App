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
        },
      });
    } catch {
      // A reminder that cannot be scheduled must never block a punch.
    }
  }
}
