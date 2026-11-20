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
        // A row with a middle initial, or a suffix, the person in the app does not have is not theirs: the phone
        // matches a sign-in's row to a person the way a typed name is matched, and that row's name does not fit them.
        person('a', 'Riley', 'Quinn'),
        person('b', 'Buck', 'Vance'),
        person('c', 'Sam', 'Ortiz'), // taken off the server roster, but still a row: listed by offRosterInApp
        person('d', 'Dana', 'Whitfield'),
        person('e', 'Tamsin', 'Fenwick', { active: false }), // off the app's roster too
        person('f', 'Angela', 'Ruiz'),
      ],
      roster,
      new Set(['f']),
    );
    expect(missing.map((e) => e.id)).toEqual(['a', 'b', 'd']);
  });

  it('never lists someone a row is for: a row may leave off a middle initial the app has', () => {
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
    // The row has a middle initial the app's person does not: the phone would not take that sign-in for them.
    expect(match.get(quinnRow.id)).toEqual({ kind: 'none' });
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

describe('every person on the app\u2019s roster is somewhere on the page', () => {
  it('lists a father with no row when his son\u2019s row fits his name as typed', () => {
    const father = person('emp_father', 'Sam', 'Ortiz');
    const son = person('emp_son', 'Sam', 'Ortiz Jr');
    const sonRow = rosterRow({ first_name: 'Sam', last_name: 'Ortiz Jr' });
    expect(matchRows([sonRow], [father, son]).get(sonRow.id)).toMatchObject({ kind: 'person', person: son });
    // Not held by any row, and no row taken off fits him: he is on the phones and not on the sign-in roster.
    expect(phonesNotOnRoster([father, son], [sonRow]).map((e) => e.id)).toEqual(['emp_father']);
    expect(offRosterInApp([father, son], [sonRow])).toEqual([]);
  });

  it('does not give a row someone whose own row was taken off', () => {
    // Riley J Quinn's row was taken off; a new "Riley Quinn" row may be somebody else, so it is nobody's yet.
    const quinn = person('emp_quinn', 'Riley J', 'Quinn');
    const theirs = rosterRow({ first_name: 'Riley J', last_name: 'Quinn', active: false, user_id: 'user-quinn' });
    const fresh = rosterRow({ first_name: 'Riley', last_name: 'Quinn' });
    expect(matchRows([theirs, fresh], [quinn]).get(fresh.id)).toEqual({ kind: 'none' });
    expect(offRosterInApp([quinn], [theirs, fresh]).map((e) => e.id)).toEqual(['emp_quinn']);
    expect(phonesNotOnRoster([quinn], [theirs, fresh])).toEqual([]);
  });

  it('puts each active person in one place: a row, on the phones only, or off the sign-in roster', () => {
    const rows = [
      rosterRow({ first_name: 'Lee', last_name: 'Park' }),
      rosterRow({ first_name: 'Sam', last_name: 'Ortiz Jr' }),
      rosterRow({ first_name: 'Dana', last_name: 'Whitfield', active: false }),
      rosterRow({ first_name: 'Riley J', last_name: 'Quinn' }),
    ];
    const people = [
      person('park', 'Lee', 'Park'),
      person('father', 'Sam', 'Ortiz'),
      person('son', 'Sam', 'Ortiz Jr'),
      person('whitfield', 'Dana', 'Whitfield'),
      person('quinn', 'Riley', 'Quinn'),
      person('fenwick', 'Tamsin', 'Fenwick'),
    ];
    const held = new Set([...matchRows(rows, people).values()].flatMap((m) => (m.kind === 'person' ? [m.person.id] : m.kind === 'two' ? m.people.map((e) => e.id) : [])));
    const phones = phonesNotOnRoster(people, rows).map((e) => e.id);
    const off = offRosterInApp(people, rows).map((e) => e.id);
    for (const e of people) expect([held.has(e.id), phones.includes(e.id), off.includes(e.id)].filter(Boolean)).toHaveLength(1);
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
