import { describe, expect, it } from 'vitest';

import { authProblem, dataProblem, mayHaveLostRole } from '../src/lib/errors';

describe('errors', () => {
  it('says what went wrong with a function and what to do', () => {
    expect(dataProblem({ code: '23514', message: 'would leave the company without an active supervisor' }).message).toBe(
      'A company has to keep at least one supervisor who can sign in. Make someone else a supervisor first.',
    );
    expect(dataProblem({ code: '55000', message: 'already decided' }, 'Letting them in').message).toBe(
      'Letting them in did not work: it has already been done or decided. Reload the page to see where it stands.',
    );
    expect(dataProblem({ code: 'P0002' }, 'Making a new code').message).toMatch(/^Making a new code did not work: it was not found/);
    expect(dataProblem({ message: 'TypeError: Failed to fetch' }).message).toMatch(/^Could not reach the MineMuster server/);
  });

  it('reads a refusal by the code the server sends now (PT404, PT409) and by the one it sent before migration 20261117000600 (P0002, 55000)', () => {
    expect(dataProblem({ code: 'PT404', message: 'No such company.' }, 'Making a new code').message).toBe(
      dataProblem({ code: 'P0002', message: 'No such company.' }, 'Making a new code').message,
    );
    expect(dataProblem({ code: 'PT404' }, 'Making a new code').message).toMatch(/^Making a new code did not work: it was not found/);
    expect(dataProblem({ code: 'PT409', message: 'That join request has already been decided.' }, 'Letting them in').message).toBe(
      'Letting them in did not work: it has already been done or decided. Reload the page to see where it stands.',
    );
    // The code is kept as the server sent it.
    expect(dataProblem({ code: 'PT404' }).code).toBe('PT404');
    expect(dataProblem({ code: 'PT409' }).code).toBe('PT409');
  });

  it('tells which refusals can mean the account is no longer a supervisor there', () => {
    for (const code of ['42501', 'PT404', 'P0002']) expect(mayHaveLostRole(code)).toBe(true);
    for (const code of ['PT409', '55000', '22023', '23505', 'PGRST202', 'PGRST301', 'offline', 'timeout', '', undefined]) expect(mayHaveLostRole(code)).toBe(false);
  });

  it('says what went wrong signing in', () => {
    expect(authProblem({ code: 'invalid_credentials', message: 'Invalid login credentials' }).message).toBe(
      'That email and password do not match an account. Check them, or create an account.',
    );
    expect(authProblem({ code: 'email_not_confirmed' }).message).toMatch(/Open the link in the email we sent, then sign in\.$/);
  });
});
