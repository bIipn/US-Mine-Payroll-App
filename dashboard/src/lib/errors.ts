import { isNotFound, isTooMany, isWrongState } from '@app/domain/refusals';

/**
 * What went wrong, said plainly, with what to do next. The server's error
 * codes are in supabase/README.md ("When a function refuses"); which code
 * means what is the app's own rule (src/domain/refusals.ts), shared with the
 * phone.
 */

export { isNotFound, isTooMany, isWrongState };

export class Problem extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'Problem';
  }
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  name?: unknown;
}

const NO_SERVER = 'Could not reach the MineMuster server. Check this computer’s connection, then try again.';

/**
 * Whether a refusal can mean the account is no longer a supervisor of the
 * company: turned down for want of the role, or told the company is not there
 * (a supervisor function says that to everyone who is not one of its supervisors).
 */
export const mayHaveLostRole = (code: unknown) => code === '42501' || isNotFound(code);

/** A Supabase auth error as a sentence. */
export function authProblem(error: unknown): Problem {
  const e = (error ?? {}) as ErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (isOffline(e)) return new Problem(NO_SERVER, 'offline');
  switch (code) {
    case 'invalid_credentials':
      return new Problem('That email and password do not match an account. Check them, or create an account.', code);
    case 'email_not_confirmed':
      return new Problem('This email is not confirmed yet. Open the link in the email we sent, then sign in.', code);
    case 'user_already_exists':
    case 'email_exists':
      return new Problem('There is already an account with this email. Sign in instead.', code);
    case 'weak_password':
      return new Problem(`That password is too easy to guess. ${message || 'Use at least 8 characters, with letters and numbers.'}`, code);
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return new Problem('Too many tries in a short time. Wait a few minutes, then try again.', code);
    case 'email_address_invalid':
    case 'validation_failed':
      return new Problem('That email address does not look right. Check it and try again.', code);
    case 'signup_disabled':
      return new Problem('New accounts are turned off on this server. Ask whoever runs MineMuster for your company.', code);
    default:
      return new Problem(message ? `The server turned that down: ${message}` : 'Signing in did not work. Try again.', code || undefined);
  }
}

/** A Supabase database or function error as a sentence. */
export function dataProblem(error: unknown, doing = 'That'): Problem {
  const e = (error ?? {}) as ErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (isOffline(e)) return new Problem(NO_SERVER, 'offline');
  if (isNotFound(code)) return new Problem(`${doing} did not work: it was not found. Someone may have changed it. Reload the page.`, code);
  if (isWrongState(code)) return new Problem(`${doing} did not work: it has already been done or decided. Reload the page to see where it stands.`, code);
  switch (code) {
    case '42501':
      return new Problem(`${doing} is not allowed for this account. Only a supervisor of the company can do it. Sign out and back in if your role changed.`, code);
    case 'PGRST301':
    case 'PGRST303':
      return new Problem('Your sign-in has run out. Sign in again.', code);
    case '23514':
      return /supervisor/i.test(message) || !message
        ? new Problem('A company has to keep at least one supervisor who can sign in. Make someone else a supervisor first.', code)
        : new Problem(`${doing} did not work: ${message}`, code);
    case '23505':
      return new Problem(`${doing} did not work: that is already there. Reload the page.`, code);
    case '22023':
      return new Problem(`Something typed is not allowed: ${message || 'check the names and try again.'}`, code);
    case '40001':
      return new Problem('Someone else changed the supervisors at the same moment. Try again.', code);
    case 'PGRST202':
    case '42883':
    case 'PGRST205':
    case '42P01':
      return new Problem('The server is not set up for this yet. The company’s records store has not been added to it. Try again later.', code);
    default:
      return new Problem(
        `${doing} did not work${message ? ` (the server said: ${message.replace(/[.\s]+$/, '')})` : ''}. Try again in a minute. If it keeps happening, tell whoever runs MineMuster for your company.`,
        code || undefined,
      );
  }
}

/**
 * Why the server would not start another company for this account: create_company's PT429 (migration
 * 20261117000800), by its hint. One account starts at most 3 companies in any 24 hours and 20 in all.
 */
export function companyLimitWords(hint: unknown, message: unknown): string {
  switch (hint) {
    case 'too_many_today':
      return 'No company was started: this account has already started 3 companies in the last 24 hours, the most it can in a day. Try again tomorrow at this time.';
    case 'too_many_in_all':
      return 'No company was started: this account has already started 20 companies, the most one account can. To start another, write to us at minemuster.com/contact.';
    default:
      return typeof message === 'string' && message.trim()
        ? `No company was started: ${message.trim()}`
        : 'No company was started: this account has started too many companies for now. Try again tomorrow.';
  }
}

/** Whether the server turned a call down because the account may not make it: its role may have changed. */
export const notAllowed = (error: unknown) => error instanceof Problem && error.code === '42501';

function isOffline(e: ErrorLike): boolean {
  const message = typeof e.message === 'string' ? e.message : '';
  return e.name === 'AuthRetryableFetchError' || /failed to fetch|networkerror|load failed|fetch failed/i.test(message);
}

export function messageOf(error: unknown): string {
  if (error instanceof Problem) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Try again.';
}
