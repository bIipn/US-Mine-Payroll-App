import { findOnRoster } from '@app/domain/roster';
import type { Employee } from '@app/domain/types';

import type { Shaped } from './records';
import { rowName } from './rosterTools';
import type { RecordKind, RosterRow } from './server';

/**
 * Who sent each record, from the accounts the server keeps on it.
 *
 * The server takes a crew member's shift, checklist or exam for anyone in the
 * company, and anyone's change to a maintenance request: a record says whose it
 * is, and the server does not check that against the account that sent it. So
 * the dashboard does. A record sent from the account of someone else on the
 * crew, or a request completed from an account that is neither a supervisor nor
 * the person it is assigned to, is marked for a supervisor to look at. Nothing is
 * hidden or changed for it: it may be a crew member using a coworker's phone.
 */

export interface Sender {
  account: string;
  /** The sign-in roster row the account joined on, when it is still on one. */
  row?: RosterRow;
  supervisor: boolean;
  /** "Quinn, Riley J", or what to call an account no row names. */
  name: string;
}

export interface Doubt {
  /** `kind:id` */
  key: string;
  kind: RecordKind;
  id: string;
  /** The person the record is for. */
  personId?: string;
  at: number;
  sender: Sender;
  why: string;
}

export const NOT_ON_ROSTER = 'an account that is not on the sign-in roster';

export function senderOf(account: string | null | undefined, roster: RosterRow[]): Sender | undefined {
  if (!account) return undefined;
  const row = roster.find((r) => r.user_id === account);
  return { account, row, supervisor: row?.role === 'supervisor' && row.active, name: row ? rowName(row) : NOT_ON_ROSTER };
}

/** Whether the account's roster row is this person, by the same name matching a typed name gets. */
function isThem(sender: Sender, person: Employee | undefined): boolean {
  if (!sender.row || !person) return false;
  const hit = findOnRoster([{ firstName: sender.row.first_name, lastName: sender.row.last_name }], person.firstName, person.lastName);
  return !!hit && 'person' in hit;
}

const OWN: { kind: RecordKind; what: string }[] = [
  { kind: 'shift', what: 'shift' },
  { kind: 'inspection', what: 'equipment checklist' },
  { kind: 'exam', what: 'pre shift exam' },
  { kind: 'opLog', what: 'equipment use' },
  { kind: 'denied', what: 'turned-down punch' },
];

export const KIND_WORDS: Partial<Record<RecordKind, string>> = Object.fromEntries([...OWN.map((o) => [o.kind, o.what]), ['mrf', 'maintenance request']]);

/** Records sent from an account that is not the person's own, for a supervisor to look at, newest first. */
export function doubts(shaped: Pick<Shaped, 'data' | 'denied' | 'sentBy'>, roster: RosterRow[]): Doubt[] {
  const people = new Map(shaped.data.employees.map((e) => [e.id, e]));
  const out: Doubt[] = [];
  const records: { kind: RecordKind; id: string; personId: string; at: number }[] = [
    ...shaped.data.shifts.map((s) => ({ kind: 'shift' as const, id: s.id, personId: s.employeeId, at: s.clockIn.at })),
    ...shaped.data.inspections.map((i) => ({ kind: 'inspection' as const, id: i.id, personId: i.employeeId, at: i.submittedAt })),
    ...shaped.data.exams.map((x) => ({ kind: 'exam' as const, id: x.id, personId: x.employeeId, at: x.submittedAt })),
    ...shaped.data.opLogs.map((l) => ({ kind: 'opLog' as const, id: l.id, personId: l.employeeId, at: l.startAt })),
    ...shaped.denied.map((d) => ({ kind: 'denied' as const, id: d.id, personId: d.employeeId, at: d.at })),
  ];
  for (const r of records) {
    const key = `${r.kind}:${r.id}`;
    const sent = shaped.sentBy.get(key);
    if (!sent) continue;
    const person = people.get(r.personId);
    // The first version and the latest: either may have come from someone else's account.
    for (const account of new Set([sent.created, sent.updated])) {
      const sender = senderOf(account, roster);
      if (!sender || sender.supervisor || isThem(sender, person)) continue;
      out.push({ key, kind: r.kind, id: r.id, personId: r.personId, at: r.at, sender, why: `Sent from ${sender.row ? `the account of ${sender.name}` : NOT_ON_ROSTER}, not the person’s own` });
      break;
    }
  }
  for (const m of shaped.data.mrfs) {
    if (m.status !== 'completed') continue;
    const key = `mrf:${m.id}`;
    const sender = senderOf(shaped.sentBy.get(key)?.updated, roster);
    if (!sender || sender.supervisor || (m.assignedTo && isThem(sender, people.get(m.assignedTo)))) continue;
    out.push({
      key,
      kind: 'mrf',
      id: m.id,
      personId: m.assignedTo,
      at: m.completedAt ?? m.createdAt,
      sender,
      why: `Completed from ${sender.row ? `the account of ${sender.name}` : NOT_ON_ROSTER}, who is neither a supervisor nor the person it is assigned to`,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}
