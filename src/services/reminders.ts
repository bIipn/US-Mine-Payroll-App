import { CA_RULES, reminderPlan, type TimeRules } from '../domain/time';
import type { Shift } from '../domain/types';
import { cancelLocal, scheduleLocal } from './notifications';

/**
 * Bring the scheduled notifications in line with where the shift stands.
 * Safe to call after every punch and at app start. What gets scheduled is
 * decided by `reminderPlan`; this only hands the plan to the phone.
 *
 * `remindersOn` is the person's Lunch reminders setting. It covers the
 * reminders before the lunch deadline, where the state's `rules` set one. The notice that lunch is over is sent
 * either way.
 */
export async function syncReminders(shift: Shift | undefined, remindersOn: boolean, rules: TimeRules = CA_RULES): Promise<void> {
  try {
    const plan = reminderPlan(shift, remindersOn, Date.now(), rules);
    await cancelLocal(plan.cancel);
    await scheduleLocal(plan.schedule);
  } catch {
    // Notifications are a convenience; a failure here must never block a punch.
  }
}
