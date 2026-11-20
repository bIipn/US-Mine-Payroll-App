import type { Company } from '../domain/company';
import { freshReceiving } from '../domain/receive';
import { startedLunch } from '../domain/time';
import type { Lunch, SiteConfig } from '../domain/types';
import { sha256 } from '../util/hash';

/** Version of the saved app state. Raise it when the shape of the data changes. */
export const STATE_VERSION = 10;

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
 * Version 7 notes which version of each record the company's server has
 * (`synced`). A phone starts with none, so everything it holds is sent once
 * it can reach a server.
 * Version 8 made the clock-in site a setting, with no mine's location built
 * in. A saved site still on the pin that used to be built in takes the site
 * this build starts with (`site`), or none until a supervisor sets it. A site a
 * supervisor moved is kept.
 * Version 9 lets a phone connect to its company's server. It notes the company
 * the phone sends to (`connectedCompany`) and the company `synced` is about
 * (`syncedWith`), with the server account that joined it, and the last request
 * to join that waits for a supervisor (`joinAsked`). A phone starts connected
 * to none, so nothing is sent until someone signs in on it and joins their company.
 * Version 10 lets a connected phone receive the company's roster, fleet, area
 * sheets and settings (`receiving`, `src/domain/receive.ts`). A phone connected
 * before it starts reading them from the beginning; a supervisor's phone keeps
 * its powers until the company first answers who its sign-in is. A crew role
 * is never carried over: the first answer decides, and takes payroll IDs off.
 * Every record and what the server has of it stay as they were.
 *
 * A build keeps every record that people entered. A preview that holds the
 * sample crew (`samples`) clears its "sample data loaded" marker instead, so
 * the samples are loaded again under the current rules; that also signs the
 * preview out. A preview with no sample crew is not one of those: what is saved
 * on the device is people's own punches and records, and it keeps them.
 */
/**
 * The pin every build had before the site was a setting, as a hash of
 * "lat,lng", so no mine's location is written here.
 */
const OLD_BUILT_IN_PIN = '8d87cf641bd4931e8b096f87c8add6cc9e11c774a996b25810bce875d50d1244';

export function migratePersisted(
  saved: unknown,
  fromVersion: number,
  samples: boolean,
  company: Company,
  site: SiteConfig | null = null,
  oldPin: string = OLD_BUILT_IN_PIN,
): Saved {
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
  if (fromVersion < 7) {
    state.synced = {};
  }
  if (fromVersion < 8 && state.settings && typeof state.settings === 'object') {
    const saved = (state.settings as { site?: { center?: { lat?: number; lng?: number } } }).site;
    const pin = saved?.center;
    if (pin && sha256(`${pin.lat},${pin.lng}`) === oldPin) {
      state.settings = { ...(state.settings as Saved), site };
    }
  }
  if (fromVersion < 9) {
    state.connectedCompany = null;
    state.syncedWith = null;
    state.joinAsked = null;
  }
  if (fromVersion < 10) {
    const linked = state.connectedCompany as { id?: string; role?: string } | null | undefined;
    const company = (typeof state.syncedWith === 'string' && state.syncedWith) || linked?.id;
    state.receiving = linked && company ? freshReceiving(company, linked.role === 'supervisor' ? 'supervisor' : null) : null;
  }
  if (fromVersion < STATE_VERSION && samples && 'seededAt' in state) {
    state.seededAt = null;
    state.session = null;
  }
  return state;
}
