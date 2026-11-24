import { DAY } from '@app/util/format';

/**
 * "Start free trial" on minemuster.com opens https://app.minemuster.com/?start=trial.
 * The person may have no account yet: they create one, confirm their email
 * (the link may open in another tab of this browser), start their company, and
 * only then can a trial start. So the wish is kept in this browser until a
 * company opens, and then the dashboard opens on Billing.
 *
 * It is kept for a week at most, and it is only ever a wish to see the Billing
 * page: it starts nothing and charges nothing by itself.
 */

const KEY = 'minemuster.office.start';
export const INTENT_FOR_MS = 7 * DAY;

/** Whether an address's query asks to start a trial. */
export const asksForTrial = (search: string): boolean => new URLSearchParams(search).get('start') === 'trial';

/**
 * Whether an address's query asks for a new password: Forgot password? in the app opens
 * https://app.minemuster.com/?start=reset in the phone's browser, so the person asks for the link here and
 * the link comes back to this browser, the only one that can take it. It is a wish for this page load
 * only: nothing is kept.
 */
export const asksForReset = (search: string): boolean => new URLSearchParams(search).get('start') === 'reset';

/** Whether the page opened from the app's Forgot password? (read by noteArrival). */
let resetAsked = false;

/** Whether what this browser keeps is a wish to start a trial made in the last week. */
export function freshIntent(stored: string | null, now: number): boolean {
  if (!stored) return false;
  try {
    const at = (JSON.parse(stored) as { trial?: unknown }).trial;
    return typeof at === 'number' && at <= now + 60_000 && now - at < INTENT_FOR_MS;
  } catch {
    return false;
  }
}

/**
 * Read `?start=trial` or `?start=reset` off the address the page opened at, and take it off the address:
 * a trial is kept in this browser for a week, a new password for this page load.
 */
export function noteArrival(): void {
  let search = '';
  try {
    search = window.location.search;
  } catch {
    return;
  }
  if (asksForReset(search)) {
    resetAsked = true;
  } else if (asksForTrial(search)) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ trial: Date.now() }));
    } catch {
      // A browser that keeps nothing still opens the dashboard; the person finds Billing in the sidebar.
    }
  } else {
    return;
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('start');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Nothing to tidy.
  }
}

/** Whether this page opened from the app's Forgot password?, so its sign-in opens on Set a new password. */
export const wantsReset = (): boolean => resetAsked;

export function wantsTrial(): boolean {
  try {
    return freshIntent(window.localStorage.getItem(KEY), Date.now());
  } catch {
    return false;
  }
}

export function clearTrialIntent(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}
