import type { Company } from '../domain/company';
import { startedLunch } from '../domain/time';
import type { Lunch } from '../domain/types';

/** Version of the saved app state. Raise it when the shape of the data changes. */
export const STATE_VERSION = 6;

type Saved = Record<string, unknown>;
type SavedEvent = { at?: number; by?: string; status?: string; note?: string };
type SavedMrf = { status?: string; completedAt?: number; completedBy?: string; remarks?: string; history?: SavedEvent[] };

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
 * Version 5 gives a request that was completed before the form had its own
 * fields the date completed, completed by and remarks that are in its history,
 * so it stops counting days open. It also reloads a preview's sample data,
 * which moved to sample work areas that are not modelled on anyone's plant.
 * Version 6 made the company a setting: its name, state, logo and pay periods.
 * Saved settings get the company this build starts with (`company`).
 *
 * A build keeps every record that people entered. A preview that holds the
 * sample crew (`samples`) clears its "sample data loaded" marker instead, so
 * the samples are loaded again under the current rules; that also signs the
 * preview out. A preview with no sample crew is not one of those: what is saved
 * on the device is people's own punches and records, and it keeps them.
 */
export function migratePersisted(saved: unknown, fromVersion: number, samples: boolean, company: Company): Saved {
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
  if (fromVersion < 5 && Array.isArray(state.mrfs)) {
    state.mrfs = state.mrfs.map((mrf: SavedMrf) => {
      if (mrf?.status !== 'completed' || mrf.completedAt != null || !Array.isArray(mrf.history)) return mrf;
      const done = [...mrf.history].reverse().find((entry) => entry?.status === 'completed');
      if (done?.at == null) return mrf;
      return { ...mrf, completedAt: done.at, completedBy: mrf.completedBy ?? done.by, remarks: mrf.remarks ?? done.note };
    });
  }
  if (fromVersion < 6 && state.settings && typeof state.settings === 'object' && !('company' in state.settings)) {
    state.settings = { ...(state.settings as Saved), company };
  }
  if (fromVersion < STATE_VERSION && samples && 'seededAt' in state) {
    state.seededAt = null;
    state.session = null;
  }
  return state;
}
