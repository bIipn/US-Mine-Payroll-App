import { describe, expect, it } from 'vitest';

import { doubts, NOT_ON_ROSTER, senderOf } from '../src/lib/provenance';
import { shapeRecords } from '../src/lib/records';
import type { RecordRow } from '../src/lib/server';
import { rosterRow } from './fixtures';

const NOW = new Date(2026, 10, 16, 14, 30).getTime();
const row = (kind: string, id: string, data: unknown, created: string | null, updated = created): RecordRow => ({
  kind, id, rev: 'r1', data, deleted: false, created_by: created, updated_by: updated,
  created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
});
const shift = (employeeId: string) => ({ employeeId, clockIn: { at: NOW - 8 * 3_600_000 }, clockOut: { at: NOW }, lunches: [], breaks: [] });

// Made-up people: two on the crew and a supervisor, each joined with an account of their own.
const roster = [
  rosterRow({ first_name: 'Sam', last_name: 'Ortiz', user_id: 'acct-sam' }),
  rosterRow({ first_name: 'Riley J', last_name: 'Quinn', user_id: 'acct-riley' }),
  rosterRow({ first_name: 'Dana', last_name: 'Whitfield', user_id: 'acct-dana', role: 'supervisor' }),
];
const people = [
  row('employee', 'e-sam', { firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: true }, 'acct-dana'),
  row('employee', 'e-riley', { firstName: 'Riley', lastName: 'Quinn', role: 'employee', active: true }, 'acct-dana'),
];

describe('who sent a record', () => {
  it('names the roster row of the account, and says so when no row has it', () => {
    expect(senderOf('acct-riley', roster)).toMatchObject({ name: 'Quinn, Riley J', supervisor: false });
    expect(senderOf('acct-dana', roster)?.supervisor).toBe(true);
    expect(senderOf('acct-gone', roster)).toMatchObject({ name: NOT_ON_ROSTER, supervisor: false });
    expect(senderOf(null, roster)).toBeUndefined();
  });

  it('passes a person’s own records and a supervisor’s, and marks a shift sent from a coworker’s account', () => {
    const shaped = shapeRecords([
      ...people,
      // Sam's own shift, from Sam's account; the roster writes the middle initial, the phone does not.
      row('shift', 's1', shift('e-riley'), 'acct-riley'),
      // A supervisor entered one for Sam.
      row('shift', 's2', shift('e-sam'), 'acct-dana'),
      // Riley's account sent a shift for Sam.
      row('shift', 's3', shift('e-sam'), 'acct-riley'),
      // Sam's checklist, changed later from an account that has left the roster.
      row('inspection', 'i1', {
        employeeId: 'e-sam', equipmentId: 'l1', templateId: 'operator_equipment_checklist', templateVersion: 1,
        startedAt: NOW - 900_000, submittedAt: NOW - 600_000, meter: 10, answers: [], result: 'pass',
      }, 'acct-sam', 'acct-gone'),
    ], { roster });
    const found = doubts(shaped, roster);
    // Newest first.
    expect(found.map((d) => [d.key, d.sender.name])).toEqual([
      ['inspection:i1', NOT_ON_ROSTER],
      ['shift:s3', 'Quinn, Riley J'],
    ]);
    expect(found[1].why).toBe('Sent from the account of Quinn, Riley J, not the person’s own');
  });

  it('marks a request completed from an account that is neither a supervisor nor the person it is assigned to', () => {
    const mrf = (id: string, assignedTo: string) => ({
      number: 1001, createdAt: NOW - 86_400_000, status: 'completed', completedAt: NOW, requestedBy: 'e-sam', assignedTo,
      completedBy: assignedTo, remarks: 'Done', history: [], items: [], description: 'Light out', priority: 'routine', taggedOut: false,
    });
    const shaped = shapeRecords([
      ...people,
      row('mrf', 'm1', mrf('m1', 'e-riley'), 'acct-sam', 'acct-riley'),
      row('mrf', 'm2', mrf('m2', 'e-riley'), 'acct-sam', 'acct-dana'),
      row('mrf', 'm3', mrf('m3', 'e-riley'), 'acct-sam', 'acct-sam'),
    ], { roster });
    expect(doubts(shaped, roster).map((d) => d.key)).toEqual(['mrf:m3']);
  });
});
