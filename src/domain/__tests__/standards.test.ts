import { jurisdictionNote } from '../standards';

describe('jurisdictionNote', () => {
  it('names Cal/OSHA only for a mine in California', () => {
    expect(jurisdictionNote('CA')).toContain('Cal/OSHA');
    expect(jurisdictionNote('NV')).not.toContain('Cal/OSHA');
    expect(jurisdictionNote('')).not.toContain('California');
  });

  it('always says MSHA governs at the mine', () => {
    expect(jurisdictionNote('TX')).toMatch(/^MSHA has jurisdiction at the mine/);
  });
});
