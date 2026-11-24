import { describe, expect, it } from 'vitest';

import { companyToOpen } from '../src/lib/companies';
import type { CompanyChoice } from '../src/lib/server';

const company = (id: string, name: string): CompanyChoice => ({ id, name, state: 'NV', role: 'employee' });

describe('companyToOpen', () => {
  const list = [company('a', 'Test Pit A'), company('b', 'Test Pit B')];

  it('opens the company asked for by id', () => {
    expect(companyToOpen(list, { id: 'b' })).toBe('b');
  });

  it('opens the company by the name join_company gave, since it gives no id', () => {
    expect(companyToOpen(list, { name: 'test pit a ' })).toBe('a');
    expect(companyToOpen(list, { id: 'gone', name: 'Test Pit B' })).toBe('b');
  });

  it('opens nothing for a name it cannot single out, or when nothing is asked', () => {
    expect(companyToOpen([...list, company('c', 'Test Pit A')], { name: 'Test Pit A' })).toBeUndefined();
    expect(companyToOpen(list, { name: 'Test Pit C' })).toBeUndefined();
    expect(companyToOpen(list)).toBeUndefined();
  });
});
