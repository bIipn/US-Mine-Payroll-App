import { AppState } from 'react-native';

import { keepsTime } from '../domain/company';
import { rulesFor } from '../domain/stateRules';
import { lunchEndAt, lunchOverReminder, reminderPlan, remindersToLetGo } from '../domain/time';
import { openShiftOf, useStore } from '../store/useStore';
import { cancelLocal, scheduleLocal } from './notifications';

/**
 * How long one hand-over may hold up the next. A hand-over is a few calls to the phone that answer in a moment; one
 * the phone never answers (its notification service stuck, say) must not hold back every hand-over after it, the
 * notice that lunch is over among them, which must always be sent. Ten seconds is far longer than a hand-over
 * takes, and far less than any reminder is ahead when it is handed over (a lunch's end is 30 minutes off).
 */
export const TURN_MS = 10_000;

/** Every hand-over asked for and not yet done, in the order asked. It never fails. */
let queue: Promise<void> = Promise.resolve();

/**
 * Runs `job` once every hand-over asked for before it is done or has had its `TURN_MS`, so two never run at once:
 * the one planned from a shift before a punch can never land after the punch's own. A job reads the store itself,
 * when its turn comes, never when it is asked for. `inTurn` says whether its turn is still running; once it is
 * over the queue has moved on and a later hand-over may already have been made from newer records, so the job
 * makes no more calls to the phone. A job that answers after its turn is made once more, in a turn of its own at
 * the back of the queue, so what it left undone is done from the records as they are then. A failure here must
 * never block a punch: notifications are a convenience.
 */
function inTurnOf(job: (inTurn: () => boolean) => Promise<void>, again = true): Promise<void> {
  const turn = queue.then(
    () =>
      new Promise<void>((done) => {
        let over = false;
        const limit = setTimeout(() => {
          over = true;
          done();
        }, TURN_MS);
        void job(() => !over)
          .catch(() => undefined)
          .then(() => {
            clearTimeout(limit);
            if (!over) done();
            else if (again) void inTurnOf(job, false);
          });
      }),
  );
  queue = turn;
  return turn;
}

/**
 * Whether this copy of the app holds the records it would plan from: it has read them, and saves them. A phone always
 * does once they are read. In a browser, a tab that another tab of MineMuster has the records in (`recordsElsewhere`,
 * storage.ts) has what was saved when it read them, which that tab changes from then on; and a tab that has them back
 * but could not read them again (`recordsUnreadable`) has what it had before. Neither hands reminders over.
 */
function holdsRecords(state: { recordsElsewhere: boolean; recordsUnreadable: boolean }): boolean {
  return !state.recordsElsewhere && !state.recordsUnreadable;
}

type Records = ReturnType<typeof useStore.getState>;

/**
 * As `state` has it: the shift the person signed in on this phone has open (none where the company keeps no time),
 * their Lunch reminders setting and the company's state's rules. Null with nobody signed in.
 */
function shiftIn({ session, shifts, settings }: Records, now: number) {
  if (!session) return null;
  return {
    shift: keepsTime(settings.company) ? openShiftOf(shifts, session.employeeId, now) : undefined,
    remindersOn: settings.lunchReminders,
    rules: rulesFor(settings.company.state),
  };
}

/** As the store has it now (`shiftIn`); null too in a browser tab that does not hold the records (`holdsRecords`). */
function standing(now: number) {
  const state = useStore.getState();
  return holdsRecords(state) ? shiftIn(state, now) : null;
}

/**
 * Bring the scheduled notifications in line with where the shift stands, as the store has it when this hand-over's
 * turn comes. Safe to call after every punch, at app start, and after the Lunch reminders setting or the company's
 * state changes. What gets scheduled is decided by `reminderPlan`; this only hands the plan to the phone. The Lunch
 * reminders setting covers the reminders before the lunch deadline, where the state's rules set one; the notice that
 * lunch is over is sent either way. With nobody signed in it does nothing, and so it does in a browser tab that does
 * not hold the records.
 */
export function syncReminders(): Promise<void> {
  return inTurnOf(async (inTurn) => {
    const now = Date.now();
    const here = standing(now);
    if (!here) return;
    const plan = reminderPlan(here.shift, here.remindersOn, now, here.rules);
    await cancelLocal(plan.cancel);
    if (inTurn()) await scheduleLocal(plan.schedule, inTurn);
  });
}

/**
 * Hands the phone again the reminders still ahead for the shift the person signed in on this phone has open, as
 * the store has it when this hand-over's turn comes: the notice that lunch is over during a lunch, the deadline
 * reminders before one. Each replaces the one of the same id the phone holds, so handing them over again changes
 * nothing when nothing has changed; one the phone held nothing of while notifications were off is handed over once
 * they are on, and one handed over without Alarms & reminders comes at the minute once that is on. It takes nothing
 * off the phone (only those still ahead are handed over, and a reminder whose time has passed is not one of them),
 * so a notice the phone is holding back past its time to save battery still comes, and it never asks the phone for
 * anything. Off the clock, where the company keeps no time, or in a browser tab that does not hold the records, it
 * does nothing.
 */
export function handOverWaiting(): Promise<void> {
  return inTurnOf(async (inTurn) => {
    const now = Date.now();
    const here = standing(now);
    if (!here?.shift) return;
    const plan = reminderPlan(here.shift, here.remindersOn, now, here.rules);
    const ahead = plan.schedule.filter((r) => r.at > now);
    if (ahead.length) await scheduleLocal(ahead, inTurn);
  });
}

/**
 * Preview builds only, after the punches were moved so lunch is over now: the notice that lunch is over, a few
 * seconds from now, so it can be seen in a demo. In turn with every other hand-over.
 */
export function previewLunchOver(): Promise<void> {
  return inTurnOf(async (inTurn) => {
    const shift = standing(Date.now())?.shift;
    const lunch = shift?.lunches[shift.lunches.length - 1];
    if (lunch) await scheduleLocal([{ ...lunchOverReminder(lunchEndAt(lunch)), at: Date.now() + 3000 }], inTurn);
  });
}

/**
 * In a browser, once another tab of MineMuster has taken the records: this tab's reminders come off, in turn with
 * every other hand-over. The tab that has the records now sets those still ahead from what it read, and this one's
 * would be planned from a shift that tab goes on changing. The notice that lunch is over stays once its time has come
 * (`remindersToLetGo`): the browser may still be holding it back here, and no tab sets it again. Decided when its turn
 * comes, from the shift as this tab had it when it last held the records: should this tab have them back by then, and
 * have read them, it takes nothing off, since the hand-over made from what it read is after it in the queue.
 */
function letGoOfReminders(): Promise<void> {
  return inTurnOf(async () => {
    const state = useStore.getState();
    if (holdsRecords(state)) return;
    const now = Date.now();
    await cancelLocal(remindersToLetGo(shiftIn(state, now)?.shift, now));
  });
}

/**
 * While the app runs: every time it comes back to the front, on whatever screen is in front, the reminders still
 * ahead on a shift are handed to the phone again (`handOverWaiting`). A person may have turned notifications or
 * Alarms & reminders on in the phone's settings meanwhile, from any tab, and the notice that lunch is over must
 * still come. And in a browser, the reminders go with the records (`holdsRecords`): a tab that another tab takes them
 * from takes its own off (`letGoOfReminders`), and a tab that has them again hands them over once it has read them
 * (`syncReminders`), from what it read. A phone always holds its records, so there only the first happens. Started
 * once the records are read; returns the way to stop.
 */
export function watchReminders(): () => void {
  const listening = AppState.addEventListener('change', (state) => {
    if (state === 'active') void handOverWaiting();
  });
  const unwatchRecords = useStore.subscribe((state, was) => {
    const holds = holdsRecords(state);
    if (holds === holdsRecords(was)) return;
    void (holds ? syncReminders() : letGoOfReminders());
  });
  return () => {
    listening.remove();
    unwatchRecords();
  };
}
