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
 * that sign-in is never touched. Company account deletes a company sign-in
 * alone, with its password, and never the app's.
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
  /** Theirs: it is deleted with the account. `connected` when this phone sends with it. */
  | { kind: 'theirs'; email: string; connected: boolean }
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
  /** The company sign-in signed in on this phone: undefined while the phone still looks. */
  serverAccount: { id: string; email: string } | null | undefined;
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

export type BlockerKind = 'sample' | 'on_clock' | 'at_lunch' | 'waiting' | 'no_signal' | 'last_supervisor' | 'checking' | 'check_failed';

/** What stops the deletion for now, and the one thing to do about it. */
export interface Blocker {
  kind: BlockerKind;
  title: string;
  body: string;
  action?: 'clock' | 'send' | 'dashboard' | 'reset' | 'retry';
}

export interface DeletionPlan {
  title: string;
  intro: string;
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
  /** The server checks the company sign-in's password first. */
  needsPassword: boolean;
  passwordLabel?: string;
  /** The last supervisor somewhere: they finish on the office dashboard. */
  finishOnDashboard: boolean;
}

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

/** Records this phone has not sent yet: sent before its own company sign-in is deleted. */
export function waitingBlocker(n: number, company: string, online: boolean): Blocker {
  return {
    kind: 'waiting',
    title: `${n === 1 ? '1 record has' : `${n} records have`} not reached ${company} yet`,
    body: `They are sent before your company sign-in is deleted, so the company has them.${online ? '' : ' This needs signal.'}`,
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
  if (linked) {
    if (!me || !standing?.name) return { kind: 'unknown' };
    if (!signInIsTheirs(me, standing)) return { kind: 'someone_else', name: full(standing.name) };
    if (serverAccount === undefined) return { kind: 'unknown' };
    if (serverAccount && serverAccount.id === linked.userId) return { kind: 'theirs', email: serverAccount.email, connected: true };
    return { kind: 'theirs_signed_out', email: linked.email ?? null };
  }
  if (serverAccount === undefined) return { kind: 'unknown' };
  if (!serverAccount) return { kind: 'none' };
  // A phone that never joined says nothing of whose its sign-in is: a supervisor may be signed in to join it.
  // It goes with the app account only when it is under the same email; on its own, the password shows whose it is.
  if (me && account && !sameEmail(account.email, serverAccount.email)) return { kind: 'other_email', email: serverAccount.email };
  return { kind: 'theirs', email: serverAccount.email, connected: false };
}

/** What deleting this person's account means, what stops it now, and the words for each. */
export function deletionPlan(input: DeletionInput): DeletionPlan {
  const { me, account, linked, sync, check, keepsTime } = input;
  const companies = Array.isArray(check) ? check : [];
  const company = input.company || linked?.name || companies[0]?.name || 'your company';
  const signIn = whoseSignIn(input);
  const serverToo = signIn.kind === 'theirs';
  const appAccount = !!me && !!account;
  // An account in more than one company keeps its records with each of them.
  const several = serverToo && companies.length > 1;
  const names = companies.map((c) => c.name);

  const title = appAccount ? 'Delete my account' : 'Delete this company sign-in';
  const intro = !appAccount
    ? 'Deleting your company sign-in takes it off MineMuster’s server and signs this phone out of it. It cannot be undone.'
    : serverToo
      ? 'Deleting your account takes your sign-in off this phone and off MineMuster’s server. It cannot be undone.'
      : 'Deleting your account takes your sign-in off this phone. It cannot be undone.';

  const legal = legalLine(company, keepsTime, several);
  const keepsTitle = several ? 'What stays with each company' : `What stays with ${company}`;

  const base = { title, intro, keepsTitle, signIn, serverToo, legal, finishOnDashboard: false };
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
    };
  }

  // ---- What is deleted, and what stays --------------------------------------------------------
  const deletes: string[] = [];
  if (appAccount) deletes.push(account.passwordHash ? `Your sign-in on this phone, ${account.email}, and its password.` : `Your sign-in on this phone, ${account.email}.`);
  if (appAccount && input.hasRate && keepsTime) deletes.push('Your hourly rate, kept only on this phone.');
  if (serverToo) {
    deletes.push(`Your company sign-in, ${signIn.email}, on MineMuster’s server. It stops working on every phone and on the office dashboard.`);
    deletes.push('Your requests to join a company.');
  }

  const keeps: string[] = [];
  const onARoster = !!me || companies.length > 0;
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
  if (me && input.openUnit) warnings.push(`You still have ${input.openUnit} checked out. End use on the Checklists screen so the next operator can take it.`);
  if (me && keepsTime && input.staleShift) {
    warnings.push(`Your shift of ${input.fmtDay(input.staleShift.clockIn.at)} has no clock-out. It counts no hours until a supervisor sets its end.`);
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
    warnings.push(
      `Your company sign-in${signIn.email ? `, ${signIn.email},` : ''} is signed out on this phone, so it is not deleted here. Sign in to it on Company account first to delete it too, or delete it at ${ACCOUNT_PAGE_WORDS}.`,
    );
  }
  if (signIn.kind === 'other_email' && appAccount) {
    warnings.push(
      `This phone is signed in to MineMuster’s server as ${signIn.email}, not as ${account.email}, so that sign-in is not deleted with your account. If it is yours, delete it on Company account.`,
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
    needsPassword: serverToo,
    ...(serverToo ? { passwordLabel: `Password for ${signIn.email}` } : null),
    finishOnDashboard: lastIn.length > 0,
  };
}

/** The row on More that opens it. */
export function moreRowWords({ keepsTime, sample, company }: { keepsTime: boolean; sample: boolean; company: string }): { title: string; sub: string } {
  const theirs = company || 'your company';
  if (sample) return { title: 'Delete my account', sub: 'A made-up sample account. Reset the sample data to start over.' };
  return {
    title: 'Delete my account',
    sub: keepsTime
      ? `Your sign-in, password and hourly rate. Your work records stay with ${theirs}.`
      : `Your sign-in and password. Your checklists, exams and requests stay with ${theirs}.`,
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

/** The password field's hint, for the company sign-in. */
export const PASSWORD_HINT = 'Checked with MineMuster’s server to show this is you. Not kept on this phone.';
