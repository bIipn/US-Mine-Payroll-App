import { describe, expect, it } from 'vitest';

import { authProblem, dataProblem } from '../src/lib/errors';

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

  it('says what went wrong signing in', () => {
    expect(authProblem({ code: 'invalid_credentials', message: 'Invalid login credentials' }).message).toBe(
      'That email and password do not match an account. Check them, or create an account.',
    );
    expect(authProblem({ code: 'email_not_confirmed' }).message).toMatch(/Open the link in the email we sent, then sign in\.$/);
  });
});
