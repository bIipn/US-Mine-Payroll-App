import { signInIsTheirs, type SignInStanding } from './access';
import type { ConnectedCompany } from './server';
import type { SendTrouble } from './sync';
import { lunchEndAt } from './time';
import type { Account, Employee, Role, Shift } from './types';

/**
 * Deleting a person's account: what goes, what stays with the company and
 * why, what stops it for now, and what happens to the phone. Pure, for the
 * phone's Delete my account screen and its tests (and the office dashboard,
 * through `@app`).
 *
 * A person can have two sign-ins. The app's own, on this phone (`accounts`),
 * and their company sign-in on MineMuster's server (a Supabase Auth account).
 * Deleting "my account" deletes the app's sign-in, and the company sign-in too
 * when it is theirs: the one this phone sends with, when the company says it
 * is this person's, or the one it is signed in with when it never joined a
 * company and its email is the app account's (the password, checked by the
 * server, shows it is theirs). On a phone joined with someone else's sign-in,
 * that sign-in is never touched. A company sign-in alone, with no account open
 * on the phone (someone taken off the roster, or a sign-in on no company's
 * roster), is deleted with its own password or passcode, and never the app's.
 *
 * A crew member's sign-in has no email: they sign in with the company code,
 * their name and a passcode, and the passcode is what the server checks before
 * it deletes. No line here names an address or a password for it.
 *
 * The company keeps its records and the person's roster row; on the server
 * only the link to the account is cleared. A company always keeps a
 * supervisor, so its last one finishes on the office dashboard: they make
 * someone else a supervisor, or close the company. A phone sends what waits
 * before its own company sign-in is deleted.
 */

/** Where a company sign-in is deleted that this phone cannot delete, and where a last supervisor finishes. */
export const ACCOUNT_PAGE = 'https://app.minemuster.com/account';
const ACCOUNT_PAGE_WORDS = 'app.minemuster.com/account';

export const DELETED_TOAST = 'Your account is deleted.';

/** One company of `account_deletion_check`: what deleting the account means there. */
export interface DeletionCheckCompany {
  id: string;
  name: string;
  role: Role;
  /** The only supervisor there whose account can still sign in. */
  lastSupervisor: boolean;
  /** Who could take over: told to a supervisor only. */
  successors: { rosterId: string; firstName: string; lastName: string }[];
  /** Nobody else could take over or come back: its last supervisor may close it now. Told to a supervisor only. */
  canClose: boolean;
  /** When only people taken off its roster in the last 30 days stop it being closed, from when it may be (an ISO time). */
  closeFrom: string | null;
  /** How many of the company's subscriptions Stripe still charges; told to a supervisor only. */
  running: number | null;
}

/**
 * What became of a request to delete the company sign-in, from the phone's side of it. Read from the
 * server's answers in `serverAnswers.ts`, which only a build with a server has; the type is here so
 * code every build has can name it.
 */
export type DeletionAnswer =
  | { kind: 'deleted'; closed: string[] }
  | { kind: 'wrong_password' }
  | { kind: 'password_needed' }
  | { kind: 'last_supervisor'; companies: string[] }
  /** The server says the sign-in is deleted already: from another phone, the dashboard, or a request whose answer was lost. */
  | { kind: 'already_deleted' }
  /** The server turned the sign-in down without saying it is deleted. Nothing was deleted. */
  | { kind: 'signed_out' }
  /** The phone could not reach the server, so nothing was asked of it. Nothing was deleted. */
  | { kind: 'unreachable' }
  /** The request went, and nothing says yet whether the sign-in was deleted. */
  | { kind: 'not_known'; closed: string[] }
  /** A company asked to be closed (the office dashboard's Your account) was not, and nothing after it was done. */
  | { kind: 'close_refused'; companyId: string; reason: CloseRefusal; closeFrom: string | null; closed: string[] }
  | { kind: 'too_many' }
  /** The server has no delete-account function yet. */
  | { kind: 'not_ready' }
  | { kind: 'try_again'; closed: string[] };

/** Why the server did not close a company: its name typed otherwise, someone who could take over, a subscription still charged, or not the caller's to close. */
export type CloseRefusal = 'wrong_name' | 'someone_can_take_over' | 'subscription_running' | 'not_found';

/** Whose the company sign-in on this phone is, for this deletion. */
export type SignInHere =
  /** No company sign-in here, or a build with no server. */
  | { kind: 'none' }
  /**
   * Theirs: it is deleted with the account. `connected` when this phone sends with it. `passcode` for a
   * crew member's, which signs in with the company code, a name and a passcode: it has no email (`email`
   * is empty), and its passcode is what the server checks first.
   */
  | { kind: 'theirs'; email: string; connected: boolean; passcode?: true }
  /** This phone sends with their sign-in, but it is not signed in now: it stays, and the person is told. */
  | { kind: 'theirs_signed_out'; email: string | null }
  /** Another person's: never touched. */
  | { kind: 'someone_else'; name: string | null }
  /** On a phone that never joined, a sign-in under another email than the app account's: not touched. */
  | { kind: 'other_email'; email: string }
  /** The phone has not heard yet who its sign-in is to the company. */
  | { kind: 'unknown' };

export interface DeletionInput {
  now: number;
  /** The person signed in to the app; null when only a company sign-in is deleted. */
  me: Employee | null;
  /** Their account on this phone. */
  account: Pick<Account, 'email' | 'passwordHash'> | null;
  /** A made-up sample person (`SAMPLE_CREW_IDS`): never deleted. */
  sample: boolean;
  /** The company keeps time (`keepsTime`). */
  keepsTime: boolean;
  /** The company's name as the phone has it, or empty. */
  company: string;
  /** Their open shift, when they are on the clock. */
  openShift?: Shift;
  /** An older shift of theirs that was never clocked out. */
  staleShift?: Shift;
  /** The unit they have checked out, if any. */
  openUnit?: string | null;
  /** Their hourly rate is on this phone. */
  hasRate: boolean;
  /** This build can connect to a company server (`CAN_CONNECT`). */
  canConnect: boolean;
  /** The company this phone sends to, or none. */
  linked: ConnectedCompany | null;
  /** Who the phone's company sign-in is to the company, as the last read found. */
  standing: SignInStanding | null;
  /**
   * The company sign-in signed in on this phone: undefined while the phone still looks. `kind` is how it
   * signs in; a crew member's passcode sign-in has an empty `email`.
   */
  serverAccount: { id: string; email: string; kind?: 'passcode' | 'email' } | null | undefined;
  /** Other accounts on this phone. */
  otherAccounts: number;
  /** Other people on the clock on this phone. */
  othersOnClock: number;
  /** The phone has read its company's records to the end (`receiving.caughtUpAt`): until then a round leaves some of its own changes out of what waits. */
  caughtUp: boolean;
  sync: { online: boolean; waiting: number; notTaken: number; stuck: number; trouble: SendTrouble | null };
  /** account_deletion_check's answer: being asked for, not asked yet, or asked and not answered. */
  check: DeletionCheckCompany[] | 'checking' | 'unknown' | 'failed';
  fmtTime: (ms: number) => string;
  fmtDay: (ms: number) => string;
}

export type BlockerKind =
  | 'sample'
  | 'on_clock'
  | 'at_lunch'
  | 'waiting'
  | 'no_signal'
  | 'last_supervisor'
  | 'checking'
  | 'check_failed'
  // Signing out of a phone only (signOutBlockers).
  | 'unit_out'
  | 'other_accounts'
  | 'not_read'
  | 'not_taken'
  | 'not_member'
  | 'signed_out';

/** What stops the deletion for now, and the one thing to do about it. */
export interface Blocker {
  kind: BlockerKind;
  title: string;
  body: string;
  action?: 'clock' | 'send' | 'dashboard' | 'reset' | 'retry' | 'checklists' | 'delete' | 'sign_in';
}

export interface DeletionPlan {
  title: string;
  intro: string;
  /** The button that leaves without deleting. */
  keep: string;
  /** The title over what stays: the company, or each of them. */
  keepsTitle: string;
  signIn: SignInHere;
  /** The company sign-in is deleted on the server too. */
  serverToo: boolean;
  deletes: string[];
  keeps: string[];
  /** Why the company keeps them, as a plain-language summary. */
  legal: string;
  phone: string[];
  warnings: string[];
  blockers: Blocker[];
  /** Nothing on this phone would be lost, so it is cleared after the deletion and starts as the app does. */
  clearsPhone: boolean;
  /** The server checks the company sign-in's password first: one that signs in with an email. */
  needsPassword: boolean;
  passwordLabel?: string;
  /** The server checks a crew member's passcode first, never a password. */
  needsPasscode: boolean;
  /** The last supervisor somewhere: they finish on the office dashboard. */
  finishOnDashboard: boolean;
}

/**
 * A unit still checked out, and how to check it back in: the start of what deleting or signing out says of
 * it. It names no screen: the app's full view has End use on the Clock and Checklists screens, and the
 * company sign-in screen has it on its card, for someone taken off the roster.
 */
const checkedOutWords = (unit: string) => `You still have ${unit} checked out. Check it back in with End use`;

/** The phone's company sign-in, signed out of MineMuster's server here, and where to sign in to it again. */
const signedOutWords = (email: string | null) => `Your company sign-in${email ? `, ${email},` : ''} is signed out on this phone`;
const SIGN_IN_AGAIN = 'Sign in to it on Company account first';
/** Where a company sign-in with no email to sign in with on the dashboard is deleted, when not from the app. */
const ASK_A_SUPERVISOR = 'ask a supervisor to delete it on the office dashboard';

/** An old shift never clocked out: only a supervisor can set its end now. */
const staleShiftWords = (stale: Shift, fmtDay: (ms: number) => string) =>
  `Your shift of ${fmtDay(stale.clockIn.at)} has no clock-out. It counts no hours until a supervisor sets its end.`;

/**
 * A shift still open: clock out first, before deleting the account or signing out of the phone (`then`).
 * Only this phone can clock it out, since phones do not receive time records. At lunch, after the lunch:
 * it runs its full 30 minutes and cannot be clocked out of. Null with no open shift.
 */
export function clockBlocker(openShift: Shift | undefined, now: number, then: 'delete your account' | 'sign out', fmtTime: (ms: number) => string): Blocker | null {
  if (!openShift) return null;
  const lunch = openShift.lunches[openShift.lunches.length - 1];
  const until = lunch ? lunchEndAt(lunch) : 0;
  return lunch && now < until
    ? { kind: 'at_lunch', title: 'Clock out first', body: `You are at lunch until ${fmtTime(until)}. Clock out after that, then ${then}.`, action: 'clock' }
    : { kind: 'on_clock', title: 'Clock out first', body: `You are on the clock. Clock out, then ${then}.`, action: 'clock' };
}

/** Records this phone has not sent yet: sent before its own company sign-in is deleted, or before the phone is signed out. */
export function waitingBlocker(n: number, company: string, online: boolean, before = 'your company sign-in is deleted'): Blocker {
  return {
    kind: 'waiting',
    title: `${n === 1 ? '1 record has' : `${n} records have`} not reached ${company} yet`,
    body: `They are sent before ${before}, so the company has them.${online ? '' : ' This needs signal.'}`,
    action: 'send',
  };
}

export const NO_SIGNAL_BLOCKER: Blocker = {
  kind: 'no_signal',
  title: 'This needs signal',
  body: 'Deleting your company sign-in is done on MineMuster’s server. Try again when you have signal. Nothing has been deleted.',
};

/** The server did not answer what deleting the company sign-in means in each company: asked again before anything goes. */
export const CHECK_FAILED_BLOCKER: Blocker = {
  kind: 'check_failed',
  title: 'Could not check your account with MineMuster’s server',
  body: 'Before your company sign-in is deleted, the server says what stays with each company. Nothing has been deleted.',
  action: 'retry',
};

/**
 * Of what waits on this phone, what a round could still send: nothing while its sign-in is off the
 * company's roster or MineMuster has stopped for the company, and never what the server will not take
 * as it is (`stuck`). Only that holds a deletion up; the rest stays on the phone.
 */
export function sendable(sync: { waiting: number; stuck: number; trouble: SendTrouble | null }): number {
  if (sync.trouble === 'not_member' || sync.trouble === 'closed') return 0;
  return Math.max(0, sync.waiting - sync.stuck);
}

/** The same email, written either way. */
export const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const full = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`;
const possessive = (name: string) => `${name}’s`;
/** "A’s", "A’s and B’s", "A’s, B’s and C’s". */
const possessives = (names: string[]) => {
  const each = names.map(possessive);
  return each.length <= 1 ? each.join('') : `${each.slice(0, -1).join(', ')} and ${each[each.length - 1]}`;
};

/** Why a company keeps a person's records, as a plain-language summary: `several` for an account in more than one. */
export function legalLine(company: string, keepsTime: boolean, several = false): string {
  const whose = several ? 'each company’s' : possessive(company);
  return keepsTime
    ? `They are ${whose} records. The company keeps pre shift exam records for at least a year, as 30 CFR 56.18002 has it, and the time and pay records the law has the company keep. A plain-language summary, not legal advice.`
    : `They are ${whose} records. The company keeps pre shift exam records for at least a year, as 30 CFR 56.18002 has it. A plain-language summary, not legal advice.`;
}

/**
 * Whose the company sign-in on this phone is, for a deletion made by the person signed in to the app
 * (`me`, with their `account`), or of the company sign-in alone (`me` null).
 */
export function whoseSignIn(input: Pick<DeletionInput, 'canConnect' | 'linked' | 'standing' | 'serverAccount' | 'me' | 'account'>): SignInHere {
  const { canConnect, linked, standing, serverAccount, me, account } = input;
  if (!canConnect) return { kind: 'none' };
  const passcode = serverAccount?.kind === 'passcode';
  // A passcode sign-in has no address: none is named for it, whatever the phone was handed.
  const theirs = (signedIn: { email: string }, connected: boolean): SignInHere =>
    passcode ? { kind: 'theirs', email: '', passcode: true, connected } : { kind: 'theirs', email: signedIn.email, connected };
  if (linked) {
    if (!me) {
      // The company sign-in alone, with no account open on the phone (someone taken off the roster, say):
      // whoever is signed in to it here shows it is theirs with its own passcode or password.
      if (serverAccount === undefined) return { kind: 'unknown' };
      if (!serverAccount) return { kind: 'none' };
      return theirs(serverAccount, serverAccount.id === linked.userId);
    }
    if (!standing?.name) return { kind: 'unknown' };
    if (!signInIsTheirs(me, standing)) return { kind: 'someone_else', name: full(standing.name) };
    if (serverAccount === undefined) return { kind: 'unknown' };
    if (serverAccount && serverAccount.id === linked.userId) return theirs(serverAccount, true);
    return { kind: 'theirs_signed_out', email: linked.email || null };
  }
  if (serverAccount === undefined) return { kind: 'unknown' };
  if (!serverAccount) return { kind: 'none' };
  // A phone that never joined says nothing of whose its sign-in is: a supervisor may be signed in to join it.
  // It goes with the app account only when it is under the same email; on its own, the password shows whose
  // it is. A passcode sign-in has no email to match: its passcode shows whose it is.
  if (!passcode && me && account && !sameEmail(account.email, serverAccount.email)) return { kind: 'other_email', email: serverAccount.email };
  return theirs(serverAccount, false);
}

/** What deleting this person's account means, what stops it now, and the words for each. */
export function deletionPlan(input: DeletionInput): DeletionPlan {
  const { me, account, linked, sync, check, keepsTime } = input;
  const companies = Array.isArray(check) ? check : [];
  const company = input.company || linked?.name || companies[0]?.name || 'your company';
  const signIn = whoseSignIn(input);
  const serverToo = signIn.kind === 'theirs';
  // A crew member's sign-in: its passcode is checked, and no address or password is named for it.
  const passcode = signIn.kind === 'theirs' && !!signIn.passcode;
  const appAccount = !!me && !!account;
  // An account in more than one company keeps its records with each of them.
  const several = serverToo && companies.length > 1;
  const names = companies.map((c) => c.name);

  // A crew member's passcode sign-in is their account, as they know it, with or without an account open on the phone.
  const mine = appAccount || passcode;
  const title = mine ? 'Delete my account' : 'Delete this company sign-in';
  const intro = !appAccount
    ? passcode
      ? 'Deleting your account takes your sign-in off MineMuster’s server and signs this phone out of it. It cannot be undone.'
      : 'Deleting your company sign-in takes it off MineMuster’s server and signs this phone out of it. It cannot be undone.'
    : serverToo
      ? 'Deleting your account takes your sign-in off this phone and off MineMuster’s server. It cannot be undone.'
      : 'Deleting your account takes your sign-in off this phone. It cannot be undone.';

  const legal = legalLine(company, keepsTime, several);
  const keepsTitle = several ? 'What stays with each company' : `What stays with ${company}`;

  const keep = mine ? 'Keep my account' : 'Keep my company sign-in';
  const base = { title, intro, keep, keepsTitle, signIn, serverToo, legal, finishOnDashboard: false };
  if (input.sample) {
    return {
      ...base,
      deletes: [],
      keeps: [],
      phone: [],
      warnings: [],
      blockers: [{ kind: 'sample', title: 'This is a made-up sample account', body: 'Sample accounts are not deleted. To start over, reset the sample data on More.', action: 'reset' }],
      clearsPhone: false,
      needsPassword: false,
      needsPasscode: false,
    };
  }

  // ---- What is deleted, and what stays --------------------------------------------------------
  const deletes: string[] = [];
  // An account the phone opened by itself, from the company sign-in, has no email and no password of its own.
  if (appAccount) {
    deletes.push(
      !account.email ? 'Your sign-in on this phone.' : account.passwordHash ? `Your sign-in on this phone, ${account.email}, and its password.` : `Your sign-in on this phone, ${account.email}.`,
    );
  }
  if (appAccount && input.hasRate && keepsTime) deletes.push('Your hourly rate, kept only on this phone.');
  if (serverToo) {
    deletes.push(
      passcode
        ? 'Your company sign-in and its passcode, on MineMuster’s server. It stops working on every phone.'
        : `Your company sign-in${signIn.email ? `, ${signIn.email},` : ''} on MineMuster’s server. It stops working on every phone and on the office dashboard.`,
    );
    deletes.push('Your requests to join a company.');
  }

  const keeps: string[] = [];
  // A phone joined to its company says whose roster, though no account is open on it (someone taken off it).
  const onARoster = !!me || !!linked || companies.length > 0;
  if (onARoster) {
    keeps.push(
      several
        ? `Your name on ${possessives(names)} rosters. A supervisor takes it off when you leave.`
        : `Your name on ${possessive(company)} roster. A supervisor takes it off when you leave.`,
    );
    keeps.push(
      keepsTime
        ? 'Your punches, paid leave, equipment checklists, pre shift exams and maintenance requests, with your name on them.'
        : 'Your equipment checklists, pre shift exams and maintenance requests, with your name on them.',
    );
    // Only records the company's server has are kept there.
    if (several) keeps.push('MineMuster keeps them for each company while it uses MineMuster, and deletes them when the company asks.');
    else if (linked || (serverToo && companies.length > 0)) keeps.push(`MineMuster keeps them for ${company} while it uses MineMuster, and deletes them when the company asks.`);
  }

  // ---- This phone ---------------------------------------------------------------------------------
  const sendsWithIt = serverToo && signIn.connected;
  // Cleared only when nothing on it would be lost: until the phone has read the company's records to the end, some of its own changes are not counted as waiting.
  const clearsPhone =
    sendsWithIt && appAccount && input.caughtUp && input.otherAccounts === 0 && sync.waiting === 0 && sync.notTaken === 0 && sync.stuck === 0;
  const phone: string[] = [];
  if (clearsPhone) {
    phone.push(`Everything on this phone has reached ${company}, so the phone is cleared too and goes back to how the app starts.`);
  } else if (sendsWithIt) {
    phone.push(
      `This phone sends ${possessive(company)} records with your company sign-in, the crew’s included. Once it is deleted, the phone stops sending until it is joined again with another sign-in.`,
    );
    if (input.othersOnClock > 0) {
      phone.push(
        `${input.othersOnClock === 1 ? '1 person is' : `${input.othersOnClock} people are`} on the clock on this phone. Their punches wait on the phone until then.`,
      );
    }
    if (me) phone.push(`Your records stay on this phone. They are ${possessive(company)}; a supervisor clears them from the phone.`);
  } else if (signIn.kind === 'someone_else') {
    phone.push(`Your records stay on this phone, which others sign in to. They keep going to ${company} with this phone’s company sign-in.`);
    phone.push(`This phone’s company sign-in is ${signIn.name ? possessive(signIn.name) : 'someone else’s'}, and it is not changed.`);
  } else if (me) {
    phone.push(`Your records stay on this phone. They are ${possessive(company)}; a supervisor clears them from the phone. Deleting the app removes everything it keeps on this phone.`);
  }
  if (input.canConnect && !serverToo && appAccount) {
    phone.push(`If you have a company sign-in on another phone, delete it there, or at ${ACCOUNT_PAGE_WORDS}.`);
  }
  if (serverToo) phone.push('An account you made in the app on another phone stays on that phone. Delete it there, under More.');

  // ---- What stops it for now ---------------------------------------------------------------------
  const blockers: Blocker[] = [];
  // With time tracking off there is no Clock screen to clock out on, and no shift that counts.
  const clock = me && keepsTime ? clockBlocker(input.openShift, input.now, 'delete your account', input.fmtTime) : null;
  if (clock) blockers.push(clock);
  const needsServer = serverToo || signIn.kind === 'unknown';
  const canSend = sendsWithIt ? sendable(sync) : 0;
  if (needsServer) {
    if (canSend > 0) {
      blockers.push(waitingBlocker(canSend, company, sync.online));
    } else if (!sync.online) {
      blockers.push(NO_SIGNAL_BLOCKER);
    } else if (check === 'checking' || signIn.kind === 'unknown' || (serverToo && check === 'unknown')) {
      blockers.push({ kind: 'checking', title: 'Checking your account with MineMuster’s server…', body: '' });
    } else if (serverToo && check === 'failed') {
      blockers.push(CHECK_FAILED_BLOCKER);
    }
  }
  // A company sign-in alone that is signed out here (a new passcode set on another phone, say): nothing on
  // this phone can be deleted, and it is signed in to again first. Never "Your account is deleted" for it.
  if (input.canConnect && !appAccount && signIn.kind === 'none') {
    blockers.push({ kind: 'signed_out', title: signedOutWords(null), body: 'Sign in to it again to delete it. Nothing has been deleted.', action: 'sign_in' });
  }
  const lastIn = serverToo ? companies.filter((c) => c.lastSupervisor) : [];
  if (lastIn.length) {
    // A company only people who left lately stop being closed: from when it may be.
    const later = lastIn.filter((c) => !c.successors.length && !c.canClose && c.closeFrom && Number.isFinite(Date.parse(c.closeFrom)));
    blockers.push({
      kind: 'last_supervisor',
      title: `You are ${possessives(lastIn.map((c) => c.name))} only supervisor`,
      body: [
        'Someone has to take over before your account is deleted, so the crew can still be let in and the records read. Make someone else a supervisor, or close the company, on the office dashboard.',
        ...later.map(
          (c) => `${c.name} can be closed from ${input.fmtDay(Date.parse(c.closeFrom as string))}: someone taken off its roster in the last 30 days could still be put back.`,
        ),
      ].join(' '),
      action: 'dashboard',
    });
  }

  // ---- Worth knowing first ------------------------------------------------------------------------
  const warnings: string[] = [];
  if (me && input.openUnit) warnings.push(`${checkedOutWords(input.openUnit)} so the next operator can take it.`);
  if (me && keepsTime && input.staleShift) {
    warnings.push(staleShiftWords(input.staleShift, input.fmtDay));
  }
  // What no round will send stays on the phone, and holds nothing up.
  const unsendable = sendsWithIt ? sync.waiting - canSend : 0;
  if (unsendable > 0) {
    warnings.push(
      unsendable === 1
        ? `1 record cannot be sent to ${company}, so it stays on this phone.`
        : `${unsendable} records cannot be sent to ${company}, so they stay on this phone.`,
    );
  }
  if (serverToo) {
    for (const c of companies) {
      if (c.role === 'supervisor' && !c.lastSupervisor && (c.running ?? 0) > 0) {
        warnings.push(
          `${possessive(c.name)} subscription stays with the company. If its invoices come to your email, have another supervisor change the billing email on the office dashboard first.`,
        );
      }
    }
  }
  if (signIn.kind === 'theirs_signed_out' && appAccount) {
    // With no email to sign in with on the dashboard (a crew member's passcode sign-in), a supervisor deletes it there.
    warnings.push(
      `${signedOutWords(signIn.email)}, so it is not deleted here. ${SIGN_IN_AGAIN} to delete it too, or ${signIn.email ? `delete it at ${ACCOUNT_PAGE_WORDS}` : ASK_A_SUPERVISOR}.`,
    );
  }
  if (signIn.kind === 'other_email' && appAccount) {
    warnings.push(
      `This phone is signed in to MineMuster’s server as ${signIn.email}, not as ${account.email}, so that sign-in is not deleted with your account. If it is yours, delete it at ${ACCOUNT_PAGE_WORDS}.`,
    );
  }

  return {
    ...base,
    deletes,
    keeps,
    phone,
    warnings,
    blockers,
    clearsPhone,
    needsPassword: serverToo && !passcode,
    ...(serverToo && !passcode ? { passwordLabel: `Password for ${signIn.email}` } : null),
    needsPasscode: passcode,
    finishOnDashboard: lastIn.length > 0,
  };
}

/** What signing out of a phone joined to its company goes by: the deletion plan's input, as much of it as signing out needs. */
export type SignOutInput = Pick<DeletionInput, 'now' | 'company' | 'openShift' | 'staleShift' | 'openUnit' | 'otherAccounts' | 'caughtUp' | 'sync' | 'fmtTime' | 'fmtDay'>;

/**
 * What holds signing out of a phone joined to its company up, each with what to do, and what to look at
 * first. Signing out empties the phone, so it waits as the deletion plan's clearing of a phone does
 * (`clearsPhone`), until nothing on it would be lost: no shift open and no unit checked out, which only
 * this phone can close; nobody else's account on it; the company's records read to the end; nothing
 * waiting; and nothing the company turned down (`notTaken`, and what the server will not take as it is,
 * `stuck`). From a sign-in off the company's roster nothing waiting can go, so the person deletes their
 * account instead; with the sign-in signed out on the phone nothing goes until they sign in to it again.
 * An old shift never clocked out, which only a supervisor can end now, is a warning.
 */
export function signOutBlockers(input: SignOutInput): { blockers: Blocker[]; warnings: string[] } {
  const { company, sync } = input;
  const blockers: Blocker[] = [];
  const clock = clockBlocker(input.openShift, input.now, 'sign out', input.fmtTime);
  if (clock) blockers.push(clock);
  if (input.openUnit) blockers.push({ kind: 'unit_out', title: 'End use first', body: `${checkedOutWords(input.openUnit)}, then sign out.`, action: 'checklists' });
  if (input.otherAccounts > 0) {
    const one = input.otherAccounts === 1;
    blockers.push({
      kind: 'other_accounts',
      title: one ? 'Someone else has an account on this phone' : `${input.otherAccounts} other people have accounts on this phone`,
      body: `Signing out empties the phone, and their ${one ? 'account' : 'accounts'} would go with it. A supervisor clears the phone once they are done with it.`,
    });
  }
  if (!input.caughtUp) {
    blockers.push({
      kind: 'not_read',
      title: `This phone has not read ${possessive(company)} records yet`,
      body: 'Until it has, it cannot tell that everything on it has reached the company. Try again once it has had signal.',
      action: 'send',
    });
  }
  // What a round would still send, and what it never will: what the company turned down.
  const toSend = Math.max(0, sync.waiting - sync.stuck);
  const turnedDown = sync.notTaken + sync.stuck;
  if (sync.trouble === 'not_member') {
    const n = toSend + turnedDown;
    if (n > 0) {
      const one = n === 1;
      blockers.push({
        kind: 'not_member',
        title: `This phone’s company sign-in is off ${possessive(company)} roster`,
        body: `${one ? '1 record' : `${n} records`} on this phone cannot reach the company now, and signing out would lose ${one ? 'it' : 'them'}. Delete your account instead: ${one ? 'it stays' : 'they stay'} on this phone.`,
        action: 'delete',
      });
    }
  } else {
    if (toSend > 0 && sync.trouble === 'signed_out') {
      // Nothing goes until the company sign-in is signed in again.
      blockers.push({
        kind: 'signed_out',
        title: signedOutWords(null),
        body: `${SIGN_IN_AGAIN} to send ${toSend === 1 ? 'the record' : `the ${toSend} records`} waiting here, then sign out.`,
        action: 'sign_in',
      });
    } else if (toSend > 0) {
      const waiting = waitingBlocker(toSend, company, sync.online, 'this phone is signed out');
      blockers.push(
        sync.trouble === 'closed'
          ? { kind: 'waiting', title: waiting.title, body: 'MineMuster has stopped for this company, so they wait on this phone. A supervisor can start it again on the dashboard’s Billing page.' }
          : waiting,
      );
    }
    if (turnedDown > 0) {
      const one = turnedDown === 1;
      blockers.push({
        kind: 'not_taken',
        title: `${company} turned down ${one ? '1 record' : `${turnedDown} records`}`,
        body: `Signing out would take ${one ? 'it' : 'them'} off this phone. A supervisor can look at ${one ? 'it' : 'them'} with you.`,
      });
    }
  }
  return { blockers, warnings: signOutWarnings(input) };
}

/**
 * What to look at before signing out of a phone: an old shift never clocked out, which only a supervisor can
 * end now. Said in the question too, before anything is emptied, since nothing holds signing out up for it.
 */
export function signOutWarnings(input: Pick<SignOutInput, 'staleShift' | 'fmtDay'>): string[] {
  return input.staleShift ? [staleShiftWords(input.staleShift, input.fmtDay)] : [];
}

/**
 * The question before signing out of a phone (Sign out, on More and on Company account): what happens to
 * the phone, and that signing back in needs signal. `connected` when the phone is joined to its company,
 * which empties it once everything has reached the company; a phone joined to none keeps what it holds.
 * `held` is the title over what holds it up, when it is refused, and `failed` what is said when signing
 * out failed outright.
 */
export function signOutWords({ company, connected, keepsTime, hasRate }: { company: string; connected: boolean; keepsTime: boolean; hasRate: boolean }) {
  const theirs = company || 'your company';
  return {
    title: 'Sign out of this phone?',
    body: connected
      ? `Once everything on this phone has reached ${theirs}, the phone is emptied and goes back to how the app starts.${keepsTime && hasRate ? ' Your hourly rate, kept only on this phone, goes with it.' : ''} Your records stay with ${theirs}.`
      : 'This phone is not connected to a company, so everything on it stays here for when you sign in again.',
    signal: 'Signing back in needs signal.',
    confirm: 'Sign out of this phone',
    keep: 'Stay signed in',
    held: 'Not signed out yet',
    heldBody: 'Nothing has been taken off this phone.',
    failed: 'Something went wrong while signing out. Try again.',
  };
}

/**
 * The row on More that opens it. `secret` is what goes with the sign-in: its password, a crew member's
 * passcode, or neither, for a company sign-in signed out on the phone, which is not deleted from it.
 */
export function moreRowWords({ keepsTime, sample, company, secret = 'password' }: { keepsTime: boolean; sample: boolean; company: string; secret?: 'password' | 'passcode' | null }): {
  title: string;
  sub: string;
} {
  const theirs = company || 'your company';
  if (sample) return { title: 'Delete my account', sub: 'A made-up sample account. Reset the sample data to start over.' };
  const goes = ['Your sign-in', ...(secret ? [secret] : []), ...(keepsTime ? ['hourly rate'] : [])];
  const what = goes.length === 1 ? goes[0] : `${goes.slice(0, -1).join(', ')} and ${goes[goes.length - 1]}`;
  return {
    title: 'Delete my account',
    sub: keepsTime ? `${what}. Your work records stay with ${theirs}.` : `${what}. Your checklists, exams and requests stay with ${theirs}.`,
  };
}

/**
 * The sign-in screen, for a person taken off the roster: their account taken off this phone, asked
 * first, with why the records stay. `hasRate` when the account's hourly rate is on this phone.
 */
export function offRosterWords({ email, company, keepsTime, hasRate }: { email: string; company: string; keepsTime: boolean; hasRate: boolean }) {
  const theirs = company || 'your company';
  return {
    button: 'Delete this account from this phone',
    title: 'Delete this account?',
    body: `${email} and its password${keepsTime && hasRate ? ', and the hourly rate you entered,' : ''} are taken off this phone. Your records stay with ${theirs}. If you have a company sign-in, delete it at ${ACCOUNT_PAGE_WORDS}.`,
    legal: legalLine(theirs, keepsTime),
    confirm: 'Delete this account',
    keep: 'Keep it',
  };
}

/** The confirmation for an account kept on this phone alone. */
export const LOCAL_CONFIRM = {
  title: 'Delete your account?',
  body: 'Your sign-in on this phone is deleted. This cannot be undone.',
} as const;

/** The hint under the company sign-in's password, or under a crew member's passcode. */
export const SECRET_HINT = 'Checked with MineMuster’s server to show this is you. Not kept on this phone.';

/** The box a crew member types their passcode in, to delete their account. */
export const PASSCODE_LABEL = 'Your passcode';
