// The passcode rule (src/domain/passcode.ts): 6 to 12 digits, and not an easy one.
import { EASY_PASSCODES, passcodeProblem, passcodeWords } from '../passcode';

describe('passcodeProblem', () => {
  it('takes 6 to 12 digits', () => {
    for (const ok of ['583920', '904712', '27364519', '918273645501']) expect(passcodeProblem(ok)).toBeNull();
  });
  it('refuses letters, spaces and other characters', () => {
    for (const bad of ['58392a', '583 920', '５８３９２０', '-58392']) expect(passcodeProblem(bad)).toBe('not_digits');
  });
  it('refuses fewer than 6 and more than 12 digits', () => {
    expect(passcodeProblem('58392')).toBe('too_short');
    expect(passcodeProblem('5839205839201')).toBe('too_long');
  });
  it('refuses easy patterns', () => {
    for (const easy of ['111111', '000000', '123456', '654321', '234567', '0123456789', '121212', '123123', '112233', '123321', '90099009'])
      expect(passcodeProblem(easy)).toBe('easy');
  });
  it('refuses every passcode on the common list', () => {
    expect(EASY_PASSCODES.length).toBeGreaterThanOrEqual(18);
    for (const easy of EASY_PASSCODES) expect(passcodeProblem(easy)).toBe('easy');
  });
  it('says each problem in plain words that name the fix', () => {
    for (const p of ['not_digits', 'too_short', 'too_long', 'easy'] as const) expect(passcodeWords(p)).toMatch(/digit/);
  });
});
