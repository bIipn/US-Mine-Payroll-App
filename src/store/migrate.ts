import { startedLunch } from '../domain/time';
import type { Lunch } from '../domain/types';

/** Version of the saved app state. Raise it when the shape of the data changes. */
export const STATE_VERSION = 4;

type Saved = Record<string, unknown>;

/**
 * Bring app state saved by an older version up to date.
 *
 * Version 2 added paid leave and the personal pay rate.
 * Version 3 made lunch end by itself after 30 minutes. A lunch that was saved
 * with no end, because the person had not punched back in yet, gets its
 * automatic end. Lunches that were punched back in from are left as recorded.
 * Version 4 built in the mine's paper forms: the one equipment checklist, the
 * pre shift exams and their area sheets, and the fields of the maintenance
 * request. A checklist signed on the earlier lines is kept as it was signed.
 *
 * A live build keeps every record. A preview build clears its "sample data
 * loaded" marker instead, so the sample crew is loaded again under the current
 * rules; that also signs the preview out.
 */
export function migratePersisted(saved: unknown, fromVersion: number, demo: boolean): Saved {
  const state: Saved = saved && typeof saved === 'object' ? { ...(saved as Saved) } : {};
  if (fromVersion < 2) {
    state.leave = [];
    state.payRates = {};
  }
  if (fromVersion < 3 && Array.isArray(state.shifts)) {
    state.shifts = state.shifts.map((shift: { lunches?: Lunch[] }) =>
      Array.isArray(shift?.lunches) && shift.lunches.some((lunch) => !lunch.end)
        ? { ...shift, lunches: shift.lunches.map((lunch) => (lunch.end ? lunch : startedLunch(lunch.start))) }
        : shift,
    );
  }
  if (fromVersion < 4) {
    state.exams = [];
    // The build's own area sheets are added at start-up.
    state.areaSheets = [];
  }
  if (fromVersion < STATE_VERSION && demo && 'seededAt' in state) {
    state.seededAt = null;
    state.session = null;
  }
  return state;
}
