import { addedPerson, findOnRoster, keptApart, parsePersonName, parseRoster, payrollIdProblem, personForRow, SPARE_LAST_NAMES, startsWithSamples, withOwner, withRoster } from '../roster';
import type { Employee } from '../types';

describe('parsePersonName', () => {
  it.each([
    ['Sam Ortiz', 'Sam', 'Ortiz'],
    ['  sam   ortiz ', 'Sam', 'Ortiz'],
    ['Ortiz, Sam', 'Sam', 'Ortiz'],
    ['RILEY QUINN', 'RILEY', 'QUINN'],
    ["pat o'neil-smith", 'Pat', "O'Neil-Smith"],
    ['Maria de la Cruz', 'Maria', 'De La Cruz'],
    // With a comma the name is split where the comma is, so a middle initial, a nickname or "III" stays where it was put.
    ['de la cruz, maria elena', 'Maria Elena', 'De La Cruz'],
    ['Quinn, Riley J', 'Riley J', 'Quinn'],
    ['Vance III, Lee "Buck"', 'Lee "Buck"', 'Vance III'],
  ])('reads "%s" as %s %s', (text, firstName, lastName) => {
    expect(parsePersonName(text)).toEqual({ firstName, lastName });
  });

  it('is no name at all without both a first and a last name', () => {
    for (const text of ['', '   ', 'Cher', ',', 'Ortiz,', undefined, null]) {
      expect(parsePersonName(text)).toBeNull();
    }
  });
});

describe('withOwner', () => {
  const crew: Employee[] = [
    { id: 'e1', firstName: 'Ana', lastName: 'Diaz', role: 'employee', active: true },
    { id: 'e2', firstName: 'Lee', lastName: 'Park', role: 'employee', active: false },
  ];

  it('puts the person the build was made for on the roster, as a supervisor', () => {
    const next = withOwner(crew, { firstName: 'Sam', lastName: 'Ortiz' });
    expect(next).toEqual([
      ...crew,
      { id: 'own_sam_ortiz', firstName: 'Sam', lastName: 'Ortiz', role: 'supervisor', active: true },
    ]);
    // The list handed in is left as it was.
    expect(crew).toHaveLength(2);
  });

  it('changes nothing when they are already on the roster, whatever the capitals', () => {
    expect(withOwner(crew, { firstName: 'ANA', lastName: 'diaz' })).toBe(crew);
  });

  it('does not bring back an owner a supervisor has removed', () => {
    expect(withOwner(crew, { firstName: 'Lee', lastName: 'Park' })).toBe(crew);
  });

  it('changes nothing when the build names no owner', () => {
    expect(withOwner(crew, null)).toBe(crew);
  });
});

describe('parseRoster', () => {
  it('reads one person to a line: the name, then the job title, then "supervisor" for a supervisor', () => {
    const text = 'Ortiz, Sam | Crusher\n  Quinn, Riley J |Maintenance| Supervisor \nVance III, Lee "Buck" | Bagging plant\nPat Cole';
    expect(parseRoster(text)).toEqual([
      { firstName: 'Sam', lastName: 'Ortiz', title: 'Crusher', role: 'employee' },
      { firstName: 'Riley J', lastName: 'Quinn', title: 'Maintenance', role: 'supervisor' },
      { firstName: 'Lee "Buck"', lastName: 'Vance III', title: 'Bagging plant', role: 'employee' },
      { firstName: 'Pat', lastName: 'Cole', role: 'employee' },
    ]);
  });

  it('passes over a line that is not a full name, and a person named twice', () => {
    expect(parseRoster('Cher | Lab\n\nCole, Pat | Office\npat cole | Shop\n | Scale house')).toEqual([
      { firstName: 'Pat', lastName: 'Cole', title: 'Office', role: 'employee' },
    ]);
  });

  it('reads line ends typed out as \\n, which is what a setting holds outside double quotes', () => {
    expect(parseRoster('Ortiz, Sam | Crusher\\nCole, Pat').map((p) => p.lastName)).toEqual(['Ortiz', 'Cole']);
  });

  it('is nobody when the build names no roster', () => {
    expect(parseRoster(undefined)).toEqual([]);
    expect(parseRoster('  ')).toEqual([]);
  });
});

describe('withRoster', () => {
  const crew: Employee[] = [
    { id: 'e1', firstName: 'Ana', lastName: 'Diaz', role: 'employee', active: true },
    { id: 'e2', firstName: 'Lee', lastName: 'Park', role: 'employee', active: false },
  ];
  const named = parseRoster('Ortiz, Sam | Crusher\nQuinn, Riley J | Maintenance | supervisor\nCole, Pat');

  it('puts everyone the build names on the roster, with their job title', () => {
    const next = withRoster(crew, named);
    expect(next).toEqual([
      ...crew,
      { id: 'ros_sam_ortiz', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', title: 'Crusher', active: true },
      { id: 'ros_riley_j_quinn', firstName: 'Riley J', lastName: 'Quinn', role: 'supervisor', title: 'Maintenance', active: true },
      { id: 'ros_pat_cole', firstName: 'Pat', lastName: 'Cole', role: 'employee', active: true },
    ]);
    expect(crew).toHaveLength(2);
  });

  it('leaves alone anyone already on the roster, and anyone a supervisor has removed', () => {
    const next = withRoster(crew, parseRoster('DIAZ, ana | Lab\nPark, Lee | Shop\nOrtiz, Sam'));
    expect(next.slice(0, 2)).toEqual(crew);
    expect(next.map((e) => e.lastName)).toEqual(['Diaz', 'Park', 'Ortiz']);
  });

  it('hands back the same list when there is nobody to add', () => {
    expect(withRoster(crew, [])).toBe(crew);
    expect(withRoster(crew, parseRoster('Diaz, Ana'))).toBe(crew);
  });

  it('gives two people whose names come to the same id an id each', () => {
    const next = withRoster([], parseRoster("O'Neil, Pat\nO Neil, Pat"));
    expect(next.map((e) => e.id)).toEqual(['ros_pat_o_neil', 'ros_pat_o_neil_2']);
  });
});

describe('findOnRoster', () => {
  const people = [
    { firstName: 'Sam', lastName: 'Ortiz' },
    { firstName: 'Riley J', lastName: 'Quinn' },
    { firstName: 'Lee "Buck"', lastName: 'Vance III' },
    { firstName: 'Maria', lastName: 'De La Cruz' },
  ];
  const found = (first: string, last: string) => {
    const hit = findOnRoster(people, first, last);
    return hit && 'person' in hit ? `${hit.person.firstName} ${hit.person.lastName}` : hit;
  };

  it.each([
    ['sam', 'ORTIZ', 'Sam Ortiz'],
    // A middle initial can be left off, or typed.
    ['Riley', 'Quinn', 'Riley J Quinn'],
    ['riley j.', 'quinn', 'Riley J Quinn'],
    // Someone who goes by a nickname can type either name, with or without "III".
    ['Lee', 'Vance', 'Lee "Buck" Vance III'],
    ['Buck', 'Vance III', 'Lee "Buck" Vance III'],
    ['Lee Buck', 'vance iii', 'Lee "Buck" Vance III'],
    ['Maria', 'de la Cruz', 'Maria De La Cruz'],
  ])('knows %s %s as %s', (first, last, name) => {
    expect(found(first, last)).toBe(name);
  });

  it.each([
    ['Samuel', 'Ortiz'],
    ['Sam', 'Ortega'],
    // An initial alone is not a name.
    ['J', 'Quinn'],
    ['Riley', 'Quinn Jr'],
    ['Lee', 'Vance IV'],
    ['Maria', 'Cruz'],
    ['', 'Ortiz'],
  ])('does not know %s %s', (first, last) => {
    expect(found(first, last)).toBeNull();
  });

  it('says so when a name fits more than one person, and takes the one it fits exactly', () => {
    const two = [{ firstName: 'Lee', lastName: 'Park' }, { firstName: 'Lee Roy', lastName: 'Park' }, { firstName: 'Roy "Lee"', lastName: 'Park' }];
    // Typed exactly as one of them is on the roster: that one.
    expect(findOnRoster(two, 'Lee', 'Park')).toEqual({ person: two[0] });
    // "Roy Park" fits two people, and neither exactly.
    expect(findOnRoster(two, 'Roy', 'Park')).toEqual({ several: [two[1], two[2]] });
  });
});

describe('keptApart', () => {
  // Made-up people, as the sample crew is, each with something of their own to keep.
  const madeUp = [
    { id: 'a', firstName: 'Kit', lastName: 'Marlow' },
    { id: 'b', firstName: 'Jo', lastName: 'Sterne' },
    { id: 'c', firstName: 'Bo', lastName: 'Marlow' },
  ];

  it('hands back the same list when no made-up person has the last name of anyone a build names', () => {
    expect(keptApart(madeUp, [])).toBe(madeUp);
    expect(keptApart(madeUp, [{ firstName: 'Kit', lastName: 'Ortiz' }])).toBe(madeUp);
  });

  it('gives a made-up person a spare last name when theirs belongs to someone a build names', () => {
    const apart = keptApart(madeUp, [{ firstName: 'Dale', lastName: 'Sterne' }]);
    expect(apart[1]).toEqual({ id: 'b', firstName: 'Jo', lastName: SPARE_LAST_NAMES[0] });
    // Nobody else is touched.
    expect([apart[0], apart[2]]).toEqual([madeUp[0], madeUp[2]]);
    expect(madeUp[1].lastName).toBe('Sterne');
  });

  it('gives each of two made-up people with that name a spare of their own', () => {
    const apart = keptApart(madeUp, [{ firstName: 'Dale', lastName: 'Marlow' }]);
    expect(apart.map((p) => p.lastName)).toEqual([SPARE_LAST_NAMES[0], 'Sterne', SPARE_LAST_NAMES[1]]);
  });

  it('goes by the last name whatever its capitals, and with or without a "Jr" after it', () => {
    expect(keptApart(madeUp, [{ firstName: 'Dale', lastName: 'STERNE' }])[1].lastName).toBe(SPARE_LAST_NAMES[0]);
    expect(keptApart(madeUp, [{ firstName: 'Dale', lastName: 'Sterne Jr' }])[1].lastName).toBe(SPARE_LAST_NAMES[0]);
    expect(keptApart([{ firstName: 'Jo', lastName: 'Sterne III' }], [{ firstName: 'Dale', lastName: 'Sterne' }])[0].lastName).toBe(SPARE_LAST_NAMES[0]);
  });

  it('passes over a spare that is the name of someone the build names, or of another made-up person', () => {
    const named = [{ firstName: 'Dale', lastName: 'Sterne' }, { firstName: 'Lou', lastName: SPARE_LAST_NAMES[0].toUpperCase() }];
    const crew = [...madeUp, { id: 'd', firstName: 'Val', lastName: SPARE_LAST_NAMES[1] }];
    expect(keptApart(crew, named)[1].lastName).toBe(SPARE_LAST_NAMES[2]);
  });

  it('has more spares than the sample crew could need, no two alike', () => {
    expect(SPARE_LAST_NAMES.length).toBeGreaterThanOrEqual(16);
    expect(new Set(SPARE_LAST_NAMES.map((name) => name.toLowerCase())).size).toBe(SPARE_LAST_NAMES.length);
  });
});

describe('startsWithSamples', () => {
  it('gives a build that names nobody the sample crew, so there is something to look at', () => {
    expect(startsWithSamples(undefined, 0)).toBe(true);
    expect(startsWithSamples('', 0)).toBe(true);
  });

  it('leaves the sample crew out of a build that names its own people', () => {
    expect(startsWithSamples(undefined, 1)).toBe(false);
    expect(startsWithSamples('', 89)).toBe(false);
  });

  it('does what the setting says when there is one', () => {
    // The samples beside real people, for showing the app with some history in it.
    expect(startsWithSamples('1', 89)).toBe(true);
    // An empty start for a build that names nobody.
    expect(startsWithSamples('0', 0)).toBe(false);
    expect(startsWithSamples(' 1 ', 3)).toBe(true);
  });

  it('goes by who is named when the setting says anything else', () => {
    expect(startsWithSamples('yes', 3)).toBe(false);
    expect(startsWithSamples('yes', 0)).toBe(true);
  });
});

// ---- What the store and the dashboard's Roster page share -----------------------------------------------

describe('addedPerson', () => {
  const lee: Employee = { id: 'emp_lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true, title: 'Loader operator', payrollId: '004417' };
  const kit: Employee = { id: 'emp_kit', firstName: 'Kit', lastName: 'Marlow', role: 'employee', active: false, payrollId: '1100' };

  it('adds a new person under the id it is given, the name in capitals and the title closed up', () => {
    expect(addedPerson([lee], 'dana', ' fry ', 'supervisor', '  Shift   foreman ', 'emp_new')).toEqual({
      ok: true,
      returning: false,
      employee: { id: 'emp_new', firstName: 'Dana', lastName: 'Fry', role: 'supervisor', title: 'Shift foreman', active: true },
    });
    expect(addedPerson([], 'Dana', 'Fry', 'employee', undefined, 'emp_new')).toMatchObject({ ok: true, employee: { title: undefined } });
  });

  it('says a person already on the roster is there, and needs both names', () => {
    expect(addedPerson([lee], 'lee', 'PARK', 'employee', undefined, 'x')).toEqual({ ok: false, error: 'Lee PARK is already on the roster.' });
    expect(addedPerson([lee], ' ', 'Park', 'employee', undefined, 'x')).toEqual({ ok: false, error: 'Enter a first and last name.' });
  });

  it('brings back a person taken off, keeping their id, payroll ID and title unless a new title is given', () => {
    expect(addedPerson([lee, kit], 'Kit', 'Marlow', 'supervisor', undefined, 'x')).toEqual({ ok: true, returning: true, employee: { ...kit, active: true, role: 'supervisor' } });
    expect(addedPerson([lee, kit], 'Kit', 'Marlow', 'employee', 'Driller', 'x')).toMatchObject({ ok: true, employee: { id: 'emp_kit', title: 'Driller', payrollId: '1100' } });
  });
});

describe('payrollIdProblem', () => {
  const people: Employee[] = [
    { id: 'emp_lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true, payrollId: 'A-100' },
    { id: 'emp_dana', firstName: 'Dana', lastName: 'Fry', role: 'supervisor', active: true },
  ];
  it('takes up to 20 letters and numbers, with a dash, dot, slash or space between them, or none', () => {
    expect(payrollIdProblem(people, 'emp_dana', '004417')).toBeUndefined();
    expect(payrollIdProblem(people, 'emp_dana', 'B-12/7 x.1')).toBeUndefined();
    expect(payrollIdProblem(people, 'emp_dana', '  ')).toBeUndefined();
    expect(payrollIdProblem(people, 'emp_dana', '#12')).toBe('A payroll ID is up to 20 letters and numbers. A dash, dot, slash or space between them is fine.');
    expect(payrollIdProblem(people, 'emp_dana', 'x'.repeat(21))).toMatch(/^A payroll ID is up to 20/);
  });
  it('turns back one another person has, whatever the capitals, and not the person’s own', () => {
    expect(payrollIdProblem(people, 'emp_dana', 'a-100')).toBe('Lee Park already has payroll ID a-100.');
    expect(payrollIdProblem(people, 'emp_lee', 'A-100')).toBeUndefined();
  });
});

describe('personForRow', () => {
  const people: Employee[] = [
    { id: 'emp_1', firstName: 'Riley J', lastName: 'Quinn', role: 'employee', active: true },
    { id: 'emp_2', firstName: 'Bo', lastName: 'Lark', role: 'employee', active: false },
    { id: 'emp_3', firstName: 'Ana', lastName: 'Diaz', role: 'supervisor', active: true },
    { id: 'emp_4', firstName: 'Ana B', lastName: 'Diaz', role: 'employee', active: true },
  ];
  it('finds the active person whose name is the row’s exactly first', () => {
    expect(personForRow(people, { firstName: 'Ana', lastName: 'Diaz' })?.id).toBe('emp_3');
    expect(personForRow(people, { firstName: 'riley j', lastName: 'QUINN' })?.id).toBe('emp_1');
  });
  it('then the one the roster’s own matching finds, and never a person taken off', () => {
    expect(personForRow(people, { firstName: 'Riley', lastName: 'Quinn' })?.id).toBe('emp_1');
    expect(personForRow(people, { firstName: 'Bo', lastName: 'Lark' })).toBeUndefined();
    expect(personForRow(people, { firstName: 'Cal', lastName: 'Nunez' })).toBeUndefined();
  });
});
