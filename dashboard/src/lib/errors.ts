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
  hint?: unknown;
  message?: unknown;
  status?: unknown;
  name?: unknown;
}

const NO_SERVER = 'Could not reach the MineMuster server. Check this computer’s connection, then try again.';
const SIGNED_OUT = 'Your sign-in has run out. Sign in again.';

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

/**
 * What a refusal that carries a hint means, for the sign-in tools: the database's hint on a PT409 or a 22023, or
 * the `error` of the supervisor-tools function, which is that hint. Empty for any other.
 */
export function hintWords(hint: unknown): string {
  switch (hint) {
    case 'supervisor_needs_email':
      return 'A supervisor signs in with email, not a passcode, and this row is held by a passcode account now. Use Make a supervisor on it to invite them by email.';
    case 'row_taken':
      return 'That row changed since this page loaded: it is taken off the roster, or an email account holds it, so it cannot be invited. The row now shows where it stands.';
    case 'invitation_closed':
      return 'That invitation changed since this page loaded: it was already accepted or cancelled. The row now shows where it stands.';
    case 'not_a_passcode_account':
      return 'That row changed since this page loaded: it is not held by a passcode account any more. The row now shows where it stands.';
    case 'email_invalid':
      return 'Type the email address to send the invitation to, like name@example.com.';
    default:
      return '';
  }
}

/** A Supabase database or function error as a sentence. */
export function dataProblem(error: unknown, doing = 'That'): Problem {
  const e = (error ?? {}) as ErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (isOffline(e)) return new Problem(NO_SERVER, 'offline');
  const byHint = hintWords(e.hint);
  if (byHint) return new Problem(byHint, code || (e.hint as string));
  if (isNotFound(code)) return new Problem(`${doing} did not work: it was not found. Someone may have changed it. Reload the page.`, code);
  if (isWrongState(code)) return new Problem(`${doing} did not work: it has already been done or decided. Reload the page to see where it stands.`, code);
  switch (code) {
    case '42501':
      return new Problem(`${doing} is not allowed for this account. Only a supervisor of the company can do it. Sign out and back in if your role changed.`, code);
    case 'PGRST301':
    case 'PGRST303':
      return new Problem(SIGNED_OUT, code);
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
 * A refusal of a call made for the signed-in person alone, such as their own invitations: 42501 there means
 * nobody is signed in, not a role the account lacks.
 */
export function ownProblem(error: unknown, doing: string): Problem {
  const code = (error as ErrorLike | null)?.code;
  return code === '42501' ? new Problem(SIGNED_OUT, code) : dataProblem(error, doing);
}

/**
 * Why an invitation to supervise could not be accepted, worded for the person it was sent to, with what to do
 * next: most often to ask the supervisor who invited them to send it again, or to change the row. Its refusals
 * (accept_supervisor_invitation, migration 20261122000200): 42501 when nobody is signed in, PT404 for no such
 * invitation, and PT409 with a hint; supervisor_needs_email comes from the roster's own rule, for a passcode
 * account. Some of the same hints have the supervisor's own words, for the Roster page (hintWords).
 */
export function acceptProblem(error: unknown, company: string, email: string): Problem {
  const e = (error ?? {}) as ErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  if (isOffline(e)) return new Problem(NO_SERVER, 'offline');
  if (code === '42501') return new Problem('Your sign-in has run out. Sign in again, then accept the invitation.', code);
  if (isNotFound(code)) return new Problem(`That invitation to ${company} is no longer there. Ask the supervisor who invited you to invite you again.`, code);
  const refused = (words: string) => new Problem(words, code || String(e.hint));
  switch (e.hint) {
    case 'wrong_email':
      return refused(`That invitation to ${company} was sent to another email address, not ${email}. Sign out, then sign in with the address it was sent to.`);
    case 'invitation_closed':
      return refused(
        `That invitation to ${company} has closed: it expired, was cancelled or was already accepted, or the supervisor who sent it is no longer a supervisor there. Ask a supervisor of ${company} to send it again.`,
      );
    case 'already_on_roster':
      return refused(
        `This account is already on ${company}’s roster, or was taken off it, so it cannot take another row there. Ask the supervisor who invited you to make your own row a supervisor’s on the Roster page instead.`,
      );
    case 'row_taken':
      return refused(
        `The row on ${company}’s roster that this invitation is for has changed: it was taken off the roster, or another email account holds it now. Ask the supervisor who invited you to check the row on the Roster page and send the invitation again.`,
      );
    case 'supervisor_needs_email':
      return refused('This account signs in with a passcode, and a supervisor signs in with email. Sign out, then sign in with the email address the invitation was sent to.');
    default:
      return ownProblem(error, 'Accepting the invitation');
  }
}

/**
 * What the supervisor-tools function answered when it did not do what was asked, as a sentence: its status and
 * `{ error, message }`. A row or invitation that is not there and one of a company the caller does not supervise
 * are the same 404, so the words do not say which.
 */
export function toolProblem(status: number, answer: unknown): Problem {
  const a = (answer && typeof answer === 'object' ? answer : {}) as { error?: unknown; message?: unknown };
  const error = typeof a.error === 'string' ? a.error : '';
  const byHint = hintWords(error);
  if (byHint) return new Problem(byHint, error);
  switch (error) {
    case 'bad_request':
      return new Problem(typeof a.message === 'string' && a.message.trim() ? a.message.trim() : 'The server could not read that. Check what was typed and try again.', error);
    case 'signed_out':
      return new Problem(SIGNED_OUT, error);
    case 'origin_not_allowed':
      return new Problem('The server only takes this from the MineMuster dashboard. Open the dashboard from its usual address, sign in, and try again.', error);
    case 'not_found':
      return new Problem('That was not found, or it is not one of your company’s. The page has been refreshed to show where things stand.', error);
    case 'too_large':
      return new Problem('That was too much to send. Shorten what was typed and try again.', error);
    case 'not_set_up':
      return new Problem('The server is not set up for this yet. Try again later, and if it keeps happening, tell whoever runs MineMuster for your company.', error);
    default:
      return new Problem('That did not work on the server. Try again in a minute. If it keeps happening, tell whoever runs MineMuster for your company.', error || String(status));
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
