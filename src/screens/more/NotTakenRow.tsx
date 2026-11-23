import React from 'react';

import { Row } from '../../components/ui';
import { notTakenWords, type HeldReason } from '../../domain/receive';
import type { Change } from '../../domain/sync';
import { useStore } from '../../store/useStore';

/**
 * One record the company did not take from this phone's sign-in: what it is, the way the person knows it,
 * and why, with what to do (notTakenWords). More's list of what the company did not take, and the list of
 * what holds signing out of the phone up, both show their records with it. It reads only the records it
 * names people, units, sheets, leave, shifts and requests from.
 */
export function NotTakenRow({ change, reason, testID, right }: { change: Change; reason: HeldReason | 'off_roster'; testID: string; right?: React.ReactNode }) {
  const employees = useStore((s) => s.employees);
  const equipment = useStore((s) => s.equipment);
  const areaSheets = useStore((s) => s.areaSheets);
  const leave = useStore((s) => s.leave);
  const shifts = useStore((s) => s.shifts);
  const mrfs = useStore((s) => s.mrfs);
  const { what, why } = notTakenWords(change, reason, { employees, equipment, areaSheets, leave, shifts, mrfs });
  return <Row testID={testID} title={what} sub={why} subLines={4} right={right} />;
}
