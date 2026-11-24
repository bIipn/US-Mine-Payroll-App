import { uid } from '../hash';

describe('uid', () => {
  it('makes ids that do not clash even when many are made in the same moment, as on a crew of phones', () => {
    const at = jest.spyOn(Date, 'now').mockReturnValue(1_794_000_000_000);
    const ids = Array.from({ length: 20_000 }, () => uid('sh_'));
    at.mockRestore();
    expect(new Set(ids).size).toBe(ids.length);
    // Twelve random characters after the time: about 62 bits.
    expect(ids[0]).toMatch(/^sh_[0-9a-z]{8}[0-9a-z]{12}$/);
  });
});
