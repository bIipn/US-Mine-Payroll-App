/**
 * What the company server's refusals mean, by their code: one rule for every
 * client that reads them, the phone (`serverAnswers.ts`) and the office
 * dashboard (`dashboard/src/lib/errors.ts`, through its `@app` alias). The
 * codes are listed in supabase/README.md ("When a function refuses").
 *
 * Read the code, never the HTTP status: PostgREST also answers 404 for a
 * function that does not exist (PGRST202) and 409 for a duplicate (23505).
 */

/**
 * "Not found, or not yours": PT404 (HTTP 404) from migration 20261117000600
 * on, and P0002 (which PostgREST answers with HTTP 500) on a server where that
 * migration has not run yet. The two look the same on purpose.
 */
export const NOT_FOUND_CODES: readonly string[] = ['PT404', 'P0002'];

/** "Not in a state to do that": PT409 (HTTP 409) from migration 20261117000600 on, 55000 (HTTP 500) before it. */
export const WRONG_STATE_CODES: readonly string[] = ['PT409', '55000'];

/** One of the server's limits: PT429 (HTTP 429). The hint says which. */
export const TOO_MANY_CODES: readonly string[] = ['PT429'];

const oneOf = (codes: readonly string[]) => (code: unknown): boolean => typeof code === 'string' && codes.includes(code);

export const isNotFound: (code: unknown) => boolean = oneOf(NOT_FOUND_CODES);
export const isWrongState: (code: unknown) => boolean = oneOf(WRONG_STATE_CODES);
export const isTooMany: (code: unknown) => boolean = oneOf(TOO_MANY_CODES);
