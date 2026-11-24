import { SAMPLE_COMPANY } from '@app/domain/company';
import { SAMPLE_SITE } from '@app/domain/site';
import { buildDemoData, DEMO_SUPERVISOR_ID, type SeedData } from '@app/store/seed';

import type { RecordRow, RosterRow } from '../src/lib/server';

/**
 * Records shaped the way the server holds them, made from the app's own
 * made-up sample crew. Every name in them is made up.
 */

/** The account a sample person signs in with: made up, like the person. */
export const accountOf = (employeeId: string) => `user-${employeeId}`;

export function seedRows(now: number, seed: SeedData = buildDemoData(now)): RecordRow[] {
  let tick = now - 3_600_000;
  const row = (kind: string, id: string, data: unknown, by: string): RecordRow => {
    tick += 1000;
    const at = new Date(tick).toISOString();
    return { kind, id, rev: `r-${kind}-${id}`, data, deleted: false, created_by: by, updated_by: by, created_at: at, updated_at: at };
  };
  const supervisor = accountOf(DEMO_SUPERVISOR_ID);
  return [
    row('settings', 'company', { company: SAMPLE_COMPANY, site: SAMPLE_SITE, workweekStartsOn: 0, allowSectionAllOk: true }, supervisor),
    ...seed.employees.map((e) => row('employee', e.id, e, supervisor)),
    ...seed.equipment.map((e) => row('equipment', e.id, e, supervisor)),
    ...seed.areaSheets.map((s) => row('areaSheet', s.id, s, supervisor)),
    ...seed.shifts.map((s) => row('shift', s.id, s, accountOf(s.employeeId))),
    ...seed.leave.map((l) => row('leave', l.id, l, supervisor)),
    ...seed.inspections.map((i) => row('inspection', i.id, i, accountOf(i.employeeId))),
    ...seed.opLogs.map((l) => row('opLog', l.id, l, accountOf(l.employeeId))),
    ...seed.exams.map((x) => row('exam', x.id, x, accountOf(x.employeeId))),
    ...seed.mrfs.map((m) => row('mrf', m.id, m, accountOf(m.requestedBy))),
  ];
}

export function rosterRow(over: Partial<RosterRow> & Pick<RosterRow, 'first_name' | 'last_name'>): RosterRow {
  return {
    id: `row-${over.first_name}-${over.last_name}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    company_id: 'company-a',
    title: null,
    role: 'employee',
    active: true,
    user_id: null,
    claimed_at: null,
    created_at: '2026-11-01T15:00:00.000Z',
    ...over,
  };
}
