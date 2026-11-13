/** Version of the saved app state. Raise it when the shape of the data changes. */
export const STATE_VERSION = 2;

type Saved = Record<string, unknown>;

/**
 * Bring app state saved by an older version up to date.
 *
 * Version 2 added paid leave and the personal pay rate. A live build keeps
 * every record and just gains the two empty lists. A preview build clears its
 * "sample data loaded" marker instead, so the sample crew is loaded again with
 * leave and a longer history; that also signs the preview out.
 */
export function migratePersisted(saved: unknown, fromVersion: number, demo: boolean): Saved {
  const state: Saved = saved && typeof saved === 'object' ? { ...(saved as Saved) } : {};
  if (fromVersion < 2) {
    state.leave = [];
    state.payRates = {};
    if (demo && 'seededAt' in state) {
      state.seededAt = null;
      state.session = null;
    }
  }
  return state;
}
