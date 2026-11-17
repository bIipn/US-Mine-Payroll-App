import { describe, expect, it } from 'vitest';

import type { Employee } from '@app/domain/types';

import { phonesNotOnRoster, readPastedRoster, REASON_TEXT, rowsLike } from '../src/lib/rosterTools';
import { rosterRow } from './fixtures';

const person = (id: string, firstName: string, lastName: string, over: Partial<Employee> = {}): Employee => ({
  id, firstName, lastName, role: 'employee', active: true, ...over,
});

describe('readPastedRoster', () => {
  it('reads a name, a job title and a role from each line, the way a build names its roster', () => {
    const list = readPastedRoster('Ortiz, Sam | Crusher\nQuinn, Riley J | Maintenance | supervisor\n\nLee "Buck" Vance III\n', []);
    expect(list.add).toEqual([
      { firstName: 'Sam', lastName: 'Ortiz', title: 'Crusher', role: 'employee' },
      { firstName: 'Riley J', lastName: 'Quinn', title: 'Maintenance', role: 'supervisor' },
      { firstName: 'Lee', lastName: '"Buck" Vance III', role: 'employee' },
    ]);
    expect(list.skipped).toEqual([]);
  });

  it('passes over a line that is not a name, someone already on the roster, someone named twice and a role it does not know', () => {
    const list = readPastedRoster('Cher\nortiz, sam | Crusher\nPark, Lee\nPark, Lee | Scale house\nBell, Marcus | Laborer | boss', [
      rosterRow({ first_name: 'Sam', last_name: 'Ortiz' }),
    ]);
    expect(list.add).toEqual([{ firstName: 'Lee', lastName: 'Park', role: 'employee' }]);
    expect(list.skipped.map((s) => s.why)).toEqual([
      'Not a first and last name',
      'Already on the roster',
      'Named twice in the list',
      '“boss” is not a role. Write supervisor, or leave it off for crew',
    ]);
  });

  it('reads line ends typed out as \\n, as a setting holds them', () => {
    expect(readPastedRoster('Ortiz, Sam\\nPark, Lee', []).add).toHaveLength(2);
  });
});

describe('phonesNotOnRoster', () => {
  const roster = [
    rosterRow({ first_name: 'Riley J', last_name: 'Quinn' }),
    rosterRow({ first_name: 'Lee "Buck"', last_name: 'Vance III' }),
    rosterRow({ first_name: 'Sam', last_name: 'Ortiz', active: false }),
  ];

  it('finds the people on the phones who could not join under their own name yet', () => {
    const missing = phonesNotOnRoster(
      [
        person('a', 'Riley', 'Quinn'), // leaves off the middle initial
        person('b', 'Buck', 'Vance'), // goes by the nickname, no suffix
        person('c', 'Sam', 'Ortiz'), // taken off the server roster, but still a row
        person('d', 'Dana', 'Whitfield'),
        person('e', 'Tamsin', 'Fenwick', { active: false }), // off the app's roster too
        person('f', 'Angela', 'Ruiz'),
      ],
      roster,
      new Set(['f']),
    );
    expect(missing.map((e) => e.id)).toEqual(['d']);
  });
});

describe('rowsLike', () => {
  it('shows the active rows a typed name fits, for the supervisor to check', () => {
    const roster = [
      rosterRow({ first_name: 'Lee Roy', last_name: 'Park', user_id: 'acct-1' }),
      rosterRow({ first_name: 'Roy "Lee"', last_name: 'Park' }),
      rosterRow({ first_name: 'Lee', last_name: 'Park', active: false }),
    ];
    expect(rowsLike({ first_name: 'Roy', last_name: 'Park' }, roster).map((r) => r.first_name)).toEqual(['Lee Roy', 'Roy "Lee"']);
    expect(rowsLike({ first_name: 'Nobody', last_name: 'Here' }, roster)).toEqual([]);
  });

  it('has words for every reason a request can give', () => {
    for (const reason of ['not_on_roster', 'already_claimed', 'supervisor_row', 'removed', 'released', 'ambiguous'] as const) {
      expect(REASON_TEXT[reason]).toMatch(/\.$/);
    }
  });
});
