import { fmtMoney, fmtRate, peopleCount } from '../format';

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
