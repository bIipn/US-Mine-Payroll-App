import { fmtDateTime, fmtDayShort } from '@app/util/format';

import type { RosterRow, RosterSignIn } from './server';

/**
 * What the Roster page says and offers about how each row is signed in: the Account column, which tools a row
 * gets, the words around a reset code and a deletion, and the check of an address before an invitation goes.
 * Pure, so the page only draws it.
 */

const day = (iso: string) => `${fmtDayShort(Date.parse(iso))}, ${new Date(Date.parse(iso)).getFullYear()}`;

// ---- The Account column --------------------------------------------------------------------------------

/**
 * How a row is held, in a line. A lock comes before the plain "joined", since it is what the supervisor
 * has to act on; an open invitation is added after the account it sits beside. Without the sign-ins (not
 * loaded, or the call failed) the row's own claim says what it can: joined or not.
 */
export function accountWords(signIn: RosterSignIn | undefined, claimedAt: string | null, now: number): string {
  if (!signIn) return claimedAt ? `Joined ${day(claimedAt)}` : 'Not joined yet';
  const joined = claimedAt ? `, ${day(claimedAt)}` : '';
  const lock =
    signIn.needs_reset
      ? 'Locked, needs a reset'
      : signIn.locked_until && Date.parse(signIn.locked_until) > now
        ? `Locked until ${fmtDateTime(Date.parse(signIn.locked_until))}`
        : null;
  let account: string | null;
  switch (signIn.sign_in) {
    case 'passcode':
      account = lock ?? `Joined with a passcode${joined}`;
      break;
    case 'email':
      account = `Joined with email${joined}`;
      break;
    default:
      account = null;
  }
  const invitation = signIn.invitation_id
    ? signIn.invitation_lapsed
      ? 'Invitation needs to be sent again: the supervisor who sent it is no longer one'
      : 'Invited, waiting to accept'
    : null;
  if (account && invitation) return `${account}. ${invitation}`;
  return account ?? invitation ?? 'Not joined yet';
}

// ---- Which tools a row gets ----------------------------------------------------------------------------

export interface SignInTools {
  /** Make a reset code, and delete the sign-in: a row held by a passcode account. */
  resetPasscode: boolean;
  deleteSignIn: boolean;
  /** Invite by email: a supervisor's row with no email account and no open invitation. */
  invite: boolean;
  /** An open invitation, sent again or cancelled. */
  sendAgain: boolean;
  cancelInvitation: boolean;
}

export function signInTools(row: Pick<RosterRow, 'role' | 'active'>, signIn: RosterSignIn | undefined): SignInTools {
  const none: SignInTools = { resetPasscode: false, deleteSignIn: false, invite: false, sendAgain: false, cancelInvitation: false };
  if (!signIn || !row.active) return none;
  const open = !!signIn.invitation_id;
  return {
    resetPasscode: signIn.sign_in === 'passcode',
    deleteSignIn: signIn.sign_in === 'passcode',
    invite: row.role === 'supervisor' && signIn.sign_in !== 'email' && !open,
    sendAgain: open,
    cancelInvitation: open,
  };
}

/**
 * What "Make a supervisor" does on a row. A supervisor signs in with email, so a row held by a passcode account
 * cannot be made one by a change of role (the server refuses it): the supervisor is invited by email instead,
 * and takes the row, letting the passcode account go, when they accept.
 */
export const makeSupervisorBy = (signIn: RosterSignIn | undefined): 'role' | 'invite' => (signIn?.sign_in === 'passcode' ? 'invite' : 'role');

// ---- Words ----------------------------------------------------------------------------------------------

export const RESET_CODE_HELP = 'In the app, tap Forgot your passcode? and type this code with a new passcode.';
export const RESET_CODE_GOOD_FOR = 'The code is good for 30 minutes and 5 tries. It works even while the account is locked. Making another code replaces this one.';
export const RESET_CODE_ONCE = 'This is the only time the code is shown. Close it once the person has it.';

/** A 6-digit code in two groups of three, to read aloud: "482 019". */
export const groupCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** The question before a crew sign-in is deleted. */
export const deleteSignInQuestion = (name: string) =>
  `This deletes ${name}’s passcode sign-in for good, and every phone signed in with it is signed out at once. The row and every record stay with the company. ${name} can sign up for the row again with the company code. Use this too when someone signed up under the wrong name.`;

export const makeSupervisorByEmail = (name: string) =>
  `Supervisors sign in with email, not a passcode. Type ${name}’s email address to invite them. Nothing changes until they accept: then the passcode sign-in is let go of and the row becomes a supervisor’s.`;

/**
 * Do the work, then read the sign-ins again whatever came of it: done, refused because the page was out of date,
 * or no answer at all. A refusal still goes on to the caller, to be said.
 */
export async function reloadAfter<T>(work: () => Promise<T>, reload: () => Promise<void>): Promise<T> {
  try {
    return await work();
  } finally {
    await reload();
  }
}

export const INVITE_SENT_ALWAYS = (address: string) =>
  `Invitation sent to ${address}. If it does not arrive, use Send again. It is good for 7 days.`;

// ---- The address an invitation goes to --------------------------------------------------------------------

export type InviteAddress = { ok: true; address: string } | { ok: false; why: string };

/** Whitespace as `clean_text` in the database trims and closes it up. */
const SPACE = '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const EDGE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, 'g');
const RUN = new RegExp(`[${SPACE}]+`, 'g');
/** `has_hidden_characters`: controls and invisible format characters. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0001-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁯￹-￻]/;
/** What the database accepts (`invite_supervisor`). */
const DATABASE = /^[^@ ]{1,64}@[^@ .]+(\.[^@ .]+)+$/;
/**
 * What Supabase Auth accepts. Auth v2.198.0 (internal/api/mail.go, validateEmail) refuses an address over 255
 * characters or one that fails `checkmail.ValidateFormat`, and its go.mod (line 131) pins
 * github.com/badoux/checkmail v0.0.0-20170203135005-d0a759655d62, whose checkmail.go (line 34) holds
 * ^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@LABEL(?:\.LABEL)*$, a name of those characters and a domain of dot-separated
 * labels of letters, digits and inner hyphens, each up to 63 characters. This is inside that: the name is
 * dot-separated parts with no empty one, and the domain needs a dot, as the database requires.
 */
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const AUTH = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*@${LABEL}(?:\\.${LABEL})+$`);

/** The address as the database keeps it: trimmed, spaces closed up, in lower case. */
export const keptAddress = (typed: string) => typed.replace(EDGE, '').replace(RUN, ' ').toLowerCase();

/**
 * Whether an address will be taken by both the database and Supabase Auth, and the address as they will keep
 * it. Auth can refuse an address the database took, and the invitation would then be made with no email
 * sent; so this accepts only what both accept, and says what is wrong in plain words when it does not.
 */
export function inviteAddress(typed: string): InviteAddress {
  const no = (why: string): InviteAddress => ({ ok: false, why });
  if (typed.length > 1500) return no('That address is too long. An email address is at most 254 characters.');
  const address = keptAddress(typed);
  if (!address) return no('Type the email address to send the invitation to.');
  if (address.length > 254) return no('That address is too long. An email address is at most 254 characters.');
  if (HIDDEN.test(address)) return no('That address has a character that cannot be in one, such as an invisible one. Type it again instead of pasting it.');
  if (address.includes(' ')) return no('An email address has no spaces in it. Check it and type it again.');
  const at = address.split('@');
  if (at.length !== 2 || !at[0] || !at[1]) return no('An email address has one @ in it, like name@example.com.');
  if (at[0].length > 64) return no('The part before the @ is too long. It can be at most 64 characters.');
  if (!/[^.]\.[^.]/.test(at[1])) return no('The part after the @ needs a dot in it, like example.com.');
  if (!DATABASE.test(address) || !AUTH.test(address)) {
    return no('That address has a character, dot or hyphen the email system cannot use. Use letters, numbers and the usual signs only, with no accents, no doubled dots and no dot at either end.');
  }
  return { ok: true, address };
}
