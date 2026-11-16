import { fmtMoney, fmtRate, initials, listName, peopleCount, shortName } from '../format';

describe('names written short', () => {
  // A roster can put a nickname in quotes first, the way a sign-in sheet does.
  const nick = { firstName: '"Buck" Lee', lastName: 'Vance' };
  const plain = { firstName: 'Riley J', lastName: 'Quinn' };

  it('take the first letter of a first name as it is written, past any quote mark', () => {
    expect(initials(nick.firstName, nick.lastName)).toBe('BV');
    expect(shortName(nick)).toBe('B. Vance');
    expect(listName(nick)).toBe('Vance, B.');
  });

  it('are as before for a name with no quote marks', () => {
    expect(initials('jordan', 'rivera')).toBe('JR');
    expect(shortName(plain)).toBe('R. Quinn');
    expect(listName(plain)).toBe('Quinn, R.');
    expect(initials('Sam "Red"', "O'Neil")).toBe('SO');
  });
});

describe('peopleCount', () => {
  it.each([
    [0, '0 people'],
    [1, '1 person'],
    [2, '2 people'],
    [89, '89 people'],
  ])('counts %d as %s', (n, text) => {
    expect(peopleCount(n)).toBe(text);
  });
});

describe('fmtRate', () => {
  it.each([
    [2400, '$24.00'],
    [4500, '$45.00'],
    [3637.5, '$36.375'],
  ])('writes an hourly rate of %d cents as %s', (cents, text) => {
    expect(fmtRate(cents)).toBe(text);
  });
});

describe('fmtMoney', () => {
  it.each([
    [123456, '$1,234.56'],
    [5, '$0.05'],
    [100000000, '$1,000,000.00'],
    [0, '$0.00'],
    [99950, '$999.50'],
  ])('writes %d cents as %s', (cents, text) => {
    expect(fmtMoney(cents)).toBe(text);
  });
});
