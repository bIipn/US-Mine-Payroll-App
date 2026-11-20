import type { Equipment } from '@app/domain/types';

import { whatChanged } from './changes';

/**
 * What the versions of a record say about who wrote over whom.
 *
 * Before phones received the company's records, a phone made each change from
 * the last version the server had confirmed to it, which could be older than
 * the one the office saved since, and the server took a supervisor's phone at
 * its word: its copy went over the office's and nothing said so at the time.
 * Since 20261120000100_office_changes_reach_phones the server writes a change
 * of the roster, fleet, sheets or settings only on top of the version it was
 * made from, so a copy can no longer go over a version its sender had not seen;
 * the versions written before then still tell. The server keeps every version
 * it took, with the version each was made from (`base`), and a supervisor may
 * read them. From those this works out when a version was written over one its
 * sender had not seen, and what that put back.
 */

/** One row of `record_history`: a version the server took. */
export interface VersionRow {
  version: number;
  rev: string;
  /** The version the sender made it from, or null for none. */
  base: string | null;
  /** The record as it was sent, or null for a deletion. */
  data: unknown;
  deleted: boolean;
  /** The account that sent it. */
  by: string | null;
  at: string;
}

export interface WrittenOver {
  /** The version that was there, and was not seen by whoever sent the next. */
  over: VersionRow;
  /** The version that went over it. */
  by: VersionRow;
  /** `replaced`: fields went back to what they were before. `put_back`: a record taken off is back. */
  how: 'replaced' | 'put_back';
  /** What it put back to an older value and is still so, by the name the page gives each field. Empty for `put_back`. */
  fields: string[];
}

const byVersion = (a: VersionRow, b: VersionRow) => a.version - b.version;

/** A version made from the one before it, or one this dashboard once sent again with its own version as its base (it no longer does): its sender had seen what it went over. */
const seen = (version: VersionRow, before: VersionRow) => version.base === before.rev || version.base === version.rev;

/**
 * The newest version of a record that went over one its sender had not seen,
 * when what it undid is still undone; null when there is none.
 *
 * What a stale copy undoes is every field it left at the value its own base
 * had while the version it went over had another: its sender did not mean to
 * change those, and did. A field its sender did change is its sender's own
 * change and is not counted. A field changed again since (set right in the
 * office, say) is not counted either. `versions` may be only the newest few:
 * a base that is not among them counts every field the copy changed.
 */
export function writtenOver(kind: string, versions: readonly VersionRow[]): WrittenOver | null {
  const list = [...versions].sort(byVersion);
  const latest = list[list.length - 1];
  if (!latest || latest.deleted) return null;
  for (let i = list.length - 1; i >= 1; i--) {
    const [over, by] = [list[i - 1], list[i]];
    // Only versions next to each other tell: a gap in what was read is not a version written over.
    if (by.version !== over.version + 1 || seen(by, over) || by.deleted) continue;
    if (over.deleted) return { over, by, how: 'put_back', fields: [] };
    const base = by.base ? list.find((v) => v.rev === by.base && v.version < by.version && !v.deleted) : undefined;
    const changedByCopy = whatChanged(kind, over.data, by.data);
    const meant = new Set(base ? whatChanged(kind, base.data, by.data) : []);
    const since = new Set(whatChanged(kind, by.data, latest.data));
    const fields = changedByCopy.filter((field) => !meant.has(field) && !since.has(field));
    return fields.length ? { over, by, how: 'replaced', fields } : null;
  }
  return null;
}

/** A unit taken out of the fleet at some time, as `record_history` holds its deletion. */
export interface Deletion {
  id: string;
  at: string;
}

export interface PutBack {
  unit: Equipment;
  /** When it was last taken out. */
  takenOutAt: number;
}

/**
 * Units that are in the fleet now and were taken out of it before: a phone
 * that still had the unit sent it again. The dashboard itself never puts a
 * unit back, so each of these came back from a phone.
 */
export function putBackUnits(fleet: readonly Equipment[], deletions: readonly Deletion[]): PutBack[] {
  const last = new Map<string, number>();
  for (const d of deletions) {
    const at = Date.parse(d.at);
    if (Number.isFinite(at) && at > (last.get(d.id) ?? -Infinity)) last.set(d.id, at);
  }
  return fleet
    .filter((unit) => last.has(unit.id))
    .map((unit) => ({ unit, takenOutAt: last.get(unit.id)! }))
    .sort((a, b) => a.unit.unit.localeCompare(b.unit.unit, undefined, { numeric: true }));
}
