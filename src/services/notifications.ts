/**
 * Local notifications — web build.
 *
 * Browsers cannot deliver a scheduled notification after the tab is closed, so
 * on the web the reminders fire only while the app is open (the on-screen lunch
 * timer covers the rest). The phone builds use notifications.native.ts, which
 * hands the schedule to the operating system.
 */
export interface LocalReminder {
  id: string;
  at: number;
  title: string;
  body: string;
  /** Deliver at the minute even where the phone holds notices back to save battery (Android). */
  alarm?: true;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!supported()) return false;
  try {
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** A browser has no battery hold on timers; the phone builds answer for Android. */
export async function onTimeNotices(): Promise<boolean> {
  return true;
}

/** Nothing to ask in a browser. */
export async function allowOnTimeNotices(): Promise<boolean> {
  return true;
}

export async function cancelLocal(ids: string[]): Promise<void> {
  for (const id of ids) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  }
}

export async function scheduleLocal(reminders: LocalReminder[]): Promise<void> {
  await cancelLocal(reminders.map((r) => r.id));
  for (const reminder of reminders) {
    const delay = reminder.at - Date.now();
    // setTimeout tops out near 24 days; a shift never needs more than hours.
    if (delay <= 0 || delay > 24 * 3_600_000) continue;
    timers.set(
      reminder.id,
      setTimeout(() => {
        timers.delete(reminder.id);
        try {
          if (supported() && Notification.permission === 'granted') {
            new Notification(reminder.title, { body: reminder.body, tag: reminder.id });
          }
        } catch {
          // The on-screen timer still shows the reminder.
        }
      }, delay),
    );
  }
}
