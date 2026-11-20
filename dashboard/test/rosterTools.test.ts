import { describe, expect, it } from 'vitest';

import type { Employee } from '@app/domain/types';

import { matchRows, offRosterInApp, phonesNotOnRoster, readPastedRoster, REASON_TEXT, rowsLike } from '../src/lib/rosterTools';
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

  it('never lists someone a row is for, whichever of the two names is the longer', () => {
    // The row leaves off the middle initial the app has: the table counts the row as theirs, and so does this list.
    const riley = person('emp_quinn', 'Riley J', 'Quinn');
    const row = rosterRow({ first_name: 'Riley', last_name: 'Quinn' });
    expect(matchRows([row], [riley]).get(row.id)).toMatchObject({ kind: 'person', person: riley });
    expect(phonesNotOnRoster([riley], [row])).toEqual([]);
  });
});

describe('matchRows', () => {
  it('gives each active row one person: exactly, else the one it fits that no other row has', () => {
    const son = person('emp_son', 'Sam', 'Ortiz Jr');
    const sonRow = rosterRow({ first_name: 'Sam', last_name: 'Ortiz Jr' });
    const fatherRow = rosterRow({ first_name: 'Sam', last_name: 'Ortiz' });
    const quinn = person('emp_quinn', 'Riley', 'Quinn');
    const quinnRow = rosterRow({ first_name: 'Riley J', last_name: 'Quinn' });
    const off = rosterRow({ first_name: 'Tamsin', last_name: 'Fenwick', active: false });
    const match = matchRows([sonRow, fatherRow, quinnRow, off], [son, quinn, person('emp_fenwick', 'Tamsin', 'Fenwick')]);
    expect(match.get(sonRow.id)).toEqual({ kind: 'person', person: son, exact: true, shared: false });
    // "Sam Ortiz" fits the son, but the son's own row has him exactly.
    expect(match.get(fatherRow.id)).toEqual({ kind: 'none' });
    // The row has a middle initial the app's person leaves off: still them, matched the other way round.
    expect(match.get(quinnRow.id)).toEqual({ kind: 'person', person: quinn, exact: false, shared: false });
    // A row taken off is nobody's.
    expect(match.has(off.id)).toBe(false);
  });

  it('says when two people in the app have the row’s name, and when two rows are one person’s', () => {
    const a = person('emp_a', 'Lee', 'Park');
    const b = person('emp_b', 'Lee', 'Park');
    const row = rosterRow({ first_name: 'Lee', last_name: 'Park' });
    expect(matchRows([row], [a, b]).get(row.id)).toEqual({ kind: 'two', name: 'Lee Park', people: [a, b] });
    const joined = { ...row, id: 'row-joined', user_id: 'user-park' };
    const twice = matchRows([joined, { ...row, id: 'row-second' }], [a]);
    expect(twice.get('row-joined')).toMatchObject({ kind: 'person', person: a, shared: true });
    expect(twice.get('row-second')).toMatchObject({ kind: 'person', person: a, shared: true });
    // Neither of two people of a name is listed as off the sign-in roster: a row of the name is there.
    expect(phonesNotOnRoster([a, b], [row])).toEqual([]);
  });
});

describe('offRosterInApp', () => {
  it('finds the people still in the app whose row was taken off the sign-in roster', () => {
    const roster = [
      rosterRow({ first_name: 'Sam', last_name: 'Ortiz', active: false, user_id: 'user-ortiz' }),
      rosterRow({ first_name: 'Lee', last_name: 'Park' }),
      rosterRow({ first_name: 'Lee', last_name: 'Park', id: 'row-park-off', active: false }),
    ];
    const people = [
      person('a', 'Sam', 'Ortiz'),
      person('b', 'Lee', 'Park'), // the active row is theirs
      person('c', 'Dana', 'Whitfield'), // no row at all: on the phones, not on the sign-in roster
      person('d', 'Sam', 'Ortiz', { active: false }),
    ];
    expect(offRosterInApp(people, roster).map((e) => e.id)).toEqual(['a']);
    expect(phonesNotOnRoster(people, roster).map((e) => e.id)).toEqual(['c']);
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
