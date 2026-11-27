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

/**
 * Whether the notice that lunch is over can reach the person: `on`; `off`, notifications are off for the app; or,
 * on Android only, `lunch_over_off`, notifications are on but the phone's settings turn off the Lunch is over kind.
 */
export type LunchNotice = 'on' | 'off' | 'lunch_over_off';

/** What the browser allows. Never asks: only a clock-in and the Lunch reminders setting do. */
export async function lunchNoticeState(): Promise<LunchNotice> {
  try {
    return supported() && Notification.permission === 'granted' ? 'on' : 'off';
  } catch {
    return 'off';
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

/**
 * Sets each reminder to show while the tab is open, replacing any of the same id. Once `inTurn` says the hand-over
 * this is part of is no longer in its turn (src/services/reminders.ts), nothing more is set: a later hand-over may
 * have been made since.
 */
export async function scheduleLocal(reminders: LocalReminder[], inTurn: () => boolean = () => true): Promise<void> {
  await cancelLocal(reminders.map((r) => r.id));
  for (const reminder of reminders) {
    if (!inTurn()) return;
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
