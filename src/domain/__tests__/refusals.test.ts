import { isNotFound, isTooMany, isWrongState, NOT_FOUND_CODES, TOO_MANY_CODES, WRONG_STATE_CODES } from '../refusals';
import { pushTrouble, serverWords } from '../serverAnswers';

/**
 * What the company server's refusal codes mean, in one place for the phone and the office dashboard
 * (supabase/README.md, "When a function refuses").
 */

const OTHERS = ['42501', '22023', '23514', '23505', '40001', 'P0001', 'PGRST202', 'PGRST301', 'pt404', 'PT40', ' PT404', 'offline', '', undefined, null, 404, 409, 429];

describe('the server’s refusal codes', () => {
  it('reads “not found, or not yours” as the server sends it now (PT404) and before migration 20261117000600 (P0002)', () => {
    expect(NOT_FOUND_CODES).toEqual(['PT404', 'P0002']);
    for (const code of NOT_FOUND_CODES) expect(isNotFound(code)).toBe(true);
    for (const code of [...OTHERS, ...WRONG_STATE_CODES, ...TOO_MANY_CODES]) expect(isNotFound(code)).toBe(false);
  });

  it('reads “not in a state to do that” as PT409 now and 55000 before', () => {
    expect(WRONG_STATE_CODES).toEqual(['PT409', '55000']);
    for (const code of WRONG_STATE_CODES) expect(isWrongState(code)).toBe(true);
    for (const code of [...OTHERS, ...NOT_FOUND_CODES, ...TOO_MANY_CODES]) expect(isWrongState(code)).toBe(false);
  });

  it('reads one of the server’s limits as PT429', () => {
    expect(TOO_MANY_CODES).toEqual(['PT429']);
    expect(isTooMany('PT429')).toBe(true);
    for (const code of [...OTHERS, ...NOT_FOUND_CODES, ...WRONG_STATE_CODES]) expect(isTooMany(code)).toBe(false);
  });

  it('goes by the code, never by the HTTP status: PostgREST answers 404 for a function that is not there too', () => {
    expect(isNotFound(404)).toBe(false);
    expect(serverWords({ code: 'PGRST202', status: 404 })).toBe('The company server is not ready for this yet. Try again later.');
    expect(pushTrouble({ code: 'PGRST202', status: 404 }).trouble).toBe('server');
  });

  it('is what the phone goes by: every “not found” code gives the same words', () => {
    for (const code of NOT_FOUND_CODES) {
      expect(serverWords({ code })).toBe('That company was not found, or you are no longer on its roster. See your supervisor.');
      expect(pushTrouble({ code })).toMatchObject({ trouble: 'not_member', message: 'This account is not on the company’s roster any more.' });
    }
  });
});
