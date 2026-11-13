import { CA_RULES, lunchReminders } from '../domain/time';
import type { Shift } from '../domain/types';
import { cancelLocal, scheduleLocal, type LocalReminder } from './notifications';

const LUNCH_IDS = ['lunch-60', 'lunch-30', 'lunch-15', 'lunch-0'];
const LUNCH_END_ID = 'lunch-end';

/**
 * Bring the scheduled reminders in line with where the shift stands.
 * Safe to call after every punch and at app start.
 *
 *   on the clock, no lunch yet  -> remind 60/30/15 minutes before the fifth hour ends, and at the deadline
 *   at lunch                    -> one notice when the 30 minutes are up
 *   lunch done / off the clock  -> nothing
 */
export async function syncReminders(shift: Shift | undefined, enabled: boolean): Promise<void> {
  try {
    if (!shift || shift.clockOut || !enabled) {
      await cancelLocal([...LUNCH_IDS, LUNCH_END_ID]);
      return;
    }
    const current = shift.lunches[shift.lunches.length - 1];
    if (current && !current.end) {
      await cancelLocal(LUNCH_IDS);
      const done: LocalReminder = {
        id: LUNCH_END_ID,
        at: current.start.at + CA_RULES.mealMinMs,
        title: 'Lunch is up',
        body: 'Your 30 minutes are done. Clock back in when you are at the mine.',
      };
      await scheduleLocal([done]);
      return;
    }
    if (shift.lunches.length > 0) {
      await cancelLocal([...LUNCH_IDS, LUNCH_END_ID]);
      return;
    }
    await cancelLocal([LUNCH_END_ID]);
    await scheduleLocal(lunchReminders(shift.clockIn.at));
  } catch {
    // Reminders are a convenience; a failure here must never block a punch.
  }
}
