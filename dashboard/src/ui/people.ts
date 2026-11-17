import { useMemo } from 'react';

import type { Employee } from '@app/domain/types';

import { useCompany } from '../lib/company';
import { repeatedNumbers } from '../lib/overview';
import { doubts, senderOf, type Doubt } from '../lib/provenance';

/** Names for the ids on the records, last name first, the way the paper lists them, and who sent each record. */
export function usePeople() {
  const { shaped, roster } = useCompany();
  return useMemo(() => {
    const byId = new Map<string, Employee>(shaped.data.employees.map((e) => [e.id, e]));
    const name = (id?: string) => {
      if (!id) return '';
      const e = byId.get(id);
      return e ? `${e.lastName}, ${e.firstName}` : 'Unknown';
    };
    const unitOf = new Map(shaped.data.equipment.map((e) => [e.id, e]));
    const mrfOf = new Map(shaped.data.mrfs.map((m) => [m.id, m]));
    const found = doubts(shaped, roster);
    const doubtOf = new Map<string, Doubt>(found.map((d) => [d.key, d]));
    /** The account the latest version of a record came from, by its roster row. */
    const sentFrom = (kind: string, id: string) => senderOf(shaped.sentBy.get(`${kind}:${id}`)?.updated, roster);
    return {
      byId,
      name,
      unitOf,
      mrfOf,
      placeholders: shaped.placeholders,
      repeated: repeatedNumbers(shaped.data.mrfs),
      doubts: found,
      doubtOf,
      sentFrom,
    };
  }, [shaped, roster]);
}
