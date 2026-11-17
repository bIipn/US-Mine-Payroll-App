import { useEffect, useState } from 'react';

import { readDeletions, readVersions } from './api';
import { loadedRow } from './changes';
import { useCompany } from './company';
import type { Deletion, VersionRow } from './history';

/**
 * The versions of a record the server has taken, for the notices that say a
 * phone's copy went over what the office saved (history.ts). They are read
 * when a page opens and again whenever the record on the page changes. They
 * are a help and no page waits on them: null until they are read, and null
 * when they cannot be.
 */
export function useVersions(kind: string, id: string): VersionRow[] | null {
  const ctx = useCompany();
  const rev = loadedRow(ctx.records, kind, id)?.rev;
  const company = ctx.choice.id;
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  useEffect(() => {
    let current = true;
    if (!rev) {
      setVersions(null);
      return;
    }
    readVersions(company, kind, id).then(
      (rows) => current && setVersions(rows),
      () => current && setVersions(null),
    );
    return () => {
      current = false;
    };
  }, [company, kind, id, rev]);
  return versions;
}

/** Every time a record of a kind was taken off, read when the page opens and after each load or change of those records. */
export function useDeletions(kind: string): Deletion[] {
  const ctx = useCompany();
  const company = ctx.choice.id;
  // The records of the kind as the page holds them: a unit taken out here, or one that came back with a load, reads them again.
  const held = ctx.records.filter((r) => r.kind === kind).map((r) => `${r.id}:${r.deleted ? 0 : 1}`).sort().join(',');
  const [deletions, setDeletions] = useState<Deletion[]>([]);
  useEffect(() => {
    let current = true;
    readDeletions(company, kind).then(
      (rows) => current && setDeletions(rows),
      () => current && setDeletions([]),
    );
    return () => {
      current = false;
    };
  }, [company, kind, held]);
  return deletions;
}

// ---- Notices put away for now ----------------------------------------------------------------------

const hidden = new Set<string>();

/**
 * Whether a notice was put away, and the way to put it away. It stays away
 * while the page is open and comes back with the next visit: nothing about it
 * is kept on the computer.
 */
export function useHidden(key: string): [boolean, () => void] {
  const [, redraw] = useState(0);
  return [
    hidden.has(key),
    () => {
      hidden.add(key);
      redraw((n) => n + 1);
    },
  ];
}
