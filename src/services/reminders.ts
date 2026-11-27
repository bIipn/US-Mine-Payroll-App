import { AppState } from 'react-native';

import { keepsTime } from '../domain/company';
import { rulesFor } from '../domain/stateRules';
import { reminderPlan, type TimeRules } from '../domain/time';
import type { Shift } from '../domain/types';
import { openShiftOf, useStore } from '../store/useStore';
import { cancelLocal, scheduleLocal } from './notifications';

/**
 * Bring the scheduled notifications in line with where the shift stands.
 * Safe to call after every punch and at app start. What gets scheduled is
 * decided by `reminderPlan`; this only hands the plan to the phone.
 *
 * `remindersOn` is the person's Lunch reminders setting. It covers the
 * reminders before the lunch deadline, where the state's `rules` set one.
 * The rules are always passed: a missing one would fall back to another state's deadline. The notice that lunch is over is sent
 * either way.
 */
export async function syncReminders(shift: Shift | undefined, remindersOn: boolean, rules: TimeRules): Promise<void> {
  try {
    const plan = reminderPlan(shift, remindersOn, Date.now(), rules);
    await cancelLocal(plan.cancel);
    await scheduleLocal(plan.schedule);
  } catch {
    // Notifications are a convenience; a failure here must never block a punch.
  }
}

/**
 * Hands the phone again the reminders still ahead for the shift the person signed in on this phone has open, as the
 * store has them now: the notice that lunch is over during a lunch, the deadline reminders before one. Each replaces
 * the one of the same id the phone holds, so handing them over again changes nothing when nothing has changed; one
 * the phone held nothing of while notifications were off is handed over once they are on, and one handed over
 * without Alarms & reminders comes at the minute once that is on. It takes nothing off the phone, so a notice the
 * phone is holding back past its time to save battery still comes, and it never asks the phone for anything. Off the
 * clock, or where the company keeps no time, it does nothing.
 */
export async function handOverWaiting(): Promise<void> {
  try {
    const { session, shifts, settings } = useStore.getState();
    if (!session || !keepsTime(settings.company)) return;
    const now = Date.now();
    const shift = openShiftOf(shifts, session.employeeId, now);
    if (!shift) return;
    const plan = reminderPlan(shift, settings.lunchReminders, now, rulesFor(settings.company.state));
    const ahead = plan.schedule.filter((r) => r.at > now);
    if (ahead.length) await scheduleLocal(ahead);
  } catch {
    // Notifications are a convenience; a failure here must never get in anyone's way.
  }
}

/**
 * While the app runs: every time it comes back to the front, on whatever screen is in front, the reminders still
 * ahead on a shift are handed to the phone again (`handOverWaiting`). A person may have turned notifications or
 * Alarms & reminders on in the phone's settings meanwhile, from any tab, and the notice that lunch is over must
 * still come. Started once the records are read; returns the way to stop.
 */
export function watchReminders(): () => void {
  const listening = AppState.addEventListener('change', (state) => {
    if (state === 'active') void handOverWaiting();
  });
  return () => listening.remove();
}
