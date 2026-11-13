import { parsePersonName, withOwner } from '../roster';
import type { Employee } from '../types';

describe('parsePersonName', () => {
  it.each([
    ['Sam Ortiz', 'Sam', 'Ortiz'],
    ['  sam   ortiz ', 'Sam', 'Ortiz'],
    ['Ortiz, Sam', 'Sam', 'Ortiz'],
    ['RILEY QUINN', 'RILEY', 'QUINN'],
    ["pat o'neil-smith", 'Pat', "O'Neil-Smith"],
    ['Maria de la Cruz', 'Maria', 'De La Cruz'],
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
