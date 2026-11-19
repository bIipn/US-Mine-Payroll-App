import { describe, expect, it } from 'vitest';

import * as shared from '@app/domain/refusals';

import { isNotFound, isTooMany, isWrongState, mayHaveLostRole } from '../src/lib/errors';

/**
 * Which codes mean "not found" and "not in a state to do that" is one rule, in src/domain/refusals.ts,
 * for the phone and the dashboard alike. The dashboard imports it through its @app alias: no copy of
 * its own to fall out of step.
 */
describe('the refusal codes the dashboard reads', () => {
  it('are the app’s own rule, not a copy', () => {
    expect(isNotFound).toBe(shared.isNotFound);
    expect(isWrongState).toBe(shared.isWrongState);
    expect(isTooMany).toBe(shared.isTooMany);
  });

  it('mean what they meant before the rule moved', () => {
    for (const code of ['PT404', 'P0002']) expect([isNotFound(code), isWrongState(code)]).toEqual([true, false]);
    for (const code of ['PT409', '55000']) expect([isNotFound(code), isWrongState(code)]).toEqual([false, true]);
    for (const code of ['42501', '22023', '23505', 'PT429', 'PGRST202', 'offline', '', undefined]) {
      expect([isNotFound(code), isWrongState(code)]).toEqual([false, false]);
    }
    for (const code of ['42501', 'PT404', 'P0002']) expect(mayHaveLostRole(code)).toBe(true);
    for (const code of ['PT409', '55000', 'PT429', '22023', 'PGRST301', undefined]) expect(mayHaveLostRole(code)).toBe(false);
  });
});
