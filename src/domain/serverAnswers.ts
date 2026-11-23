import type { CloseRefusal, DeletionAnswer, DeletionCheckCompany } from './accountDeletion';
import { fmtDateTime, fmtTime, startOfDay } from '../util/format';
import { passcodeWords, type PasscodeProblem } from './passcode';
import { isNotFound } from './refusals';
import { cleanText } from './roster';
import type { ConnectedCompany } from './server';
import { REFERENCE_KINDS, sendError, type Change, type CompanyRow, type HeldReason, type PushAnswer, type ReceivedRow, type SendError, type Standing } from './sync';
import type { Role } from './types';

/**
 * Signing in to the company server and joining the company, with no network in
 * them: what was typed, what the server answered, and what to tell the person,
 * in plain words. `src/services/server.ts` makes the calls. Only a build that
 * names a server has this file (see `src/services/connection.ts`).
 */

/** A company the signed-in account belongs to, from `my_companies`. */
export interface ServerCompany extends ConnectedCompany {
  state?: string;
  /** The code the crew joins with. The server gives it to a supervisor only, and the phone never saves it. */
  joinCode?: string;
}

const isRole = (value: unknown): value is Role => value === 'employee' || value === 'supervisor';

/** The companies `my_companies` named, leaving out any row the phone cannot use. */
export function readCompanies(raw: unknown): ServerCompany[] {
  if (!Array.isArray(raw)) return [];
  const out: ServerCompany[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const { id, name, role, state, join_code } = row as Record<string, unknown>;
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !isRole(role)) continue;
    if (out.some((c) => c.id === id)) continue;
    out.push({
      id,
      name,
      role,
      ...(typeof state === 'string' && state ? { state } : null),
      ...(role === 'supervisor' && typeof join_code === 'string' && join_code ? { joinCode: join_code } : null),
    });
  }
  return out;
}

// ---- What was typed --------------------------------------------------------------------

export function checkEmail(email: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : 'Enter a valid email address.';
}

export function checkPassword(password: string, newAccount: boolean): string | null {
  if (!password) return 'Enter your password.';
  if (newAccount && password.length < 8) return 'Use a password of at least 8 characters.';
  return null;
}

/**
 * A company code (the server's join code) the way the server reads it: capitals, with the spaces and
 * dashes taken out. A person reads it as the company code wherever the app shows it.
 */
export function normalJoinCode(code: string): string {
  return code.normalize('NFKC').replace(/[\s\-‐-―−]/g, '').toUpperCase();
}

/** What is wrong with a typed company code, before it is sent. A code is 8 letters and numbers, with no O, 0, I or 1. */
export function checkJoinCode(code: string): string | null {
  const typed = normalJoinCode(code);
  if (!typed) return 'Enter the company code your supervisor gave you.';
  if (!/^[A-Z0-9]{8}$/.test(typed)) return 'A company code is 8 letters and numbers, like ABCD 2345. Check it with your supervisor.';
  if (/[01IO]/.test(typed)) return 'A company code has no O, 0, I or 1. Check it with your supervisor.';
  return null;
}

/** A company code the way it is easiest to read out: two groups of four, like ABCD 2345. */
export function spacedJoinCode(code: string): string {
  const typed = normalJoinCode(code);
  return typed.length === 8 ? `${typed.slice(0, 4)} ${typed.slice(4)}` : typed;
}

export function checkJoinName(first: string, last: string): string | null {
  return cleanText(first) && cleanText(last) ? null : 'Enter your first and last name the way they are on the roster.';
}

// ---- What join_company answered ---------------------------------------------------------

export const JOIN_STATUSES = ['no_company', 'already_member', 'denied', 'joined', 'ambiguous', 'pending'] as const;
export type JoinStatus = (typeof JOIN_STATUSES)[number];

export interface JoinAnswer {
  status: JoinStatus;
  companyName?: string;
  companyId?: string;
  role?: Role;
  /** Why a request is waiting for a supervisor. */
  reason?: string;
}

export function readJoinAnswer(raw: unknown): JoinAnswer | null {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== 'object') return null;
  const { status, company_name, company_id, role, reason } = row as Record<string, unknown>;
  if (!(JOIN_STATUSES as readonly unknown[]).includes(status)) return null;
  return {
    status: status as JoinStatus,
    ...(typeof company_name === 'string' && company_name ? { companyName: company_name } : null),
    ...(typeof company_id === 'string' && company_id ? { companyId: company_id } : null),
    ...(isRole(role) ? { role } : null),
    ...(typeof reason === 'string' && reason ? { reason } : null),
  };
}

/** Whether an answer means the person is on the company's roster now, so the phone can connect. */
export const joinedAnswer = (answer: JoinAnswer) => answer.status === 'joined' || answer.status === 'already_member';

/** Why a request waits for a supervisor, in plain words. */
function waitingBecause(reason: string | undefined, company: string): string {
  switch (reason) {
    case 'not_on_roster':
      return `Your name is not on ${company}’s roster yet.`;
    case 'already_claimed':
      return `Someone has already joined ${company} under that name.`;
    case 'supervisor_row':
      return `That name is a supervisor on ${company}’s roster, and only another supervisor can let a supervisor in.`;
    case 'removed':
      return `You were taken off ${company}’s roster, so a supervisor decides whether you come back.`;
    case 'released':
      return `A supervisor let go of your earlier place on ${company}’s roster.`;
    case 'ambiguous':
      return `More than one person on ${company}’s roster has that name, so a supervisor picks which one is you.`;
    default:
      return `Your request to join ${company} needs a supervisor.`;
  }
}

/** What to tell the person about an answer from join_company. */
export function joinWords(answer: JoinAnswer): { title: string; body: string; tone: 'ok' | 'warn' | 'bo' | 'info' } {
  const company = answer.companyName || 'the company';
  switch (answer.status) {
    case 'no_company':
      return { title: 'No company has that code', body: 'Check the code with your supervisor and type it again.', tone: 'warn' };
    case 'already_member':
      return { title: `You are on ${company}’s roster`, body: 'This phone now sends its records there.', tone: 'ok' };
    case 'joined':
      return { title: `You have joined ${company}`, body: 'This phone now sends its records there.', tone: 'ok' };
    case 'denied':
      return { title: 'A supervisor has turned down your request', body: `Speak to a supervisor at ${company}.`, tone: 'bo' };
    case 'ambiguous':
      return { title: 'More than one person fits that name', body: `Type your name the way it is on ${company}’s roster.`, tone: 'warn' };
    case 'pending':
      return { title: 'Waiting for a supervisor', body: `${waitingBecause(answer.reason, company)} Once a supervisor lets you in, tap Check again.`, tone: 'info' };
  }
}

/**
 * The company an answer from join_company is about, among the ones the account
 * belongs to. The server's id settles it; failing that, the only company, or the
 * only one with that name.
 */
export function pickCompany(companies: readonly ServerCompany[], answer: JoinAnswer): ServerCompany | null {
  if (answer.companyId) return companies.find((c) => c.id === answer.companyId) ?? null;
  const same = (c: ServerCompany) => !!answer.companyName && cleanText(c.name).toLowerCase() === cleanText(answer.companyName).toLowerCase();
  // The only company counts only when the answer names no other.
  if (companies.length === 1 && (!answer.companyName || same(companies[0]))) return companies[0];
  const named = companies.filter(same);
  return named.length === 1 ? named[0] : null;
}

// ---- What my_join_requests answered -------------------------------------------------------

/** A request to join a company that is still waiting for a supervisor, from `my_join_requests`. */
export interface WaitingRequest {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  reason?: string;
  /** When it was asked, in ms. */
  at: number;
}

/** The account's requests that are still waiting, newest first. Decided ones are left out: the join answer says what happened to those. */
export function readWaitingRequests(raw: unknown): WaitingRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: WaitingRequest[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const { id, company_id, first_name, last_name, reason, status, created_at } = row as Record<string, unknown>;
    if (status !== 'pending' || typeof id !== 'string' || typeof company_id !== 'string') continue;
    const at = typeof created_at === 'string' ? Date.parse(created_at) : NaN;
    out.push({
      id,
      companyId: company_id,
      firstName: typeof first_name === 'string' ? first_name : '',
      lastName: typeof last_name === 'string' ? last_name : '',
      ...(typeof reason === 'string' && reason ? { reason } : null),
      at: Number.isFinite(at) ? at : 0,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

// ---- What push_records answered -----------------------------------------------------------

/**
 * The versions the server now has, from push_records' answer: the records it
 * took and the ones it will not take from this account (another person's
 * record, or one only a supervisor sends). Both count as sent, so the phone
 * stops sending what the server will not take, and sends it again only once it
 * changes. Only what was in the batch, at the version that was sent, counts.
 */
const NOT_UNDERSTOOD = 'The server answered in a way this phone does not understand.';
const STATUS_WORDS: readonly unknown[] = ['ready', 'defect', 'out_of_service'];
const isShared = (kind: string) => (REFERENCE_KINDS as readonly string[]).includes(kind);

/**
 * push_records' answer, read against the batch that was sent: only a change
 * that was in it, at the version that was sent, counts. Each is sorted by what
 * the phone does with it (PushAnswer): taken; stale, of the four kinds every
 * phone reads, made from a version the server no longer has; a unit held to
 * the company's open requests; or held, because the server would not take it
 * from this phone's sign-in. Anything else the server set aside, it keeps what
 * it had, and the phone counts it as sent, as it always has.
 */
export function readPushAnswer(raw: unknown, batch: readonly Change[]): PushAnswer {
  const answer = Array.isArray(raw) ? raw[0] : raw;
  const { accepted, ignored } = (answer && typeof answer === 'object' ? answer : {}) as { accepted?: unknown; ignored?: unknown };
  if (!Array.isArray(accepted) || (ignored != null && !Array.isArray(ignored))) throw new Error(NOT_UNDERSTOOD);
  const sent = new Map(batch.map((c) => [c.key, c.rev]));
  const out: PushAnswer = { took: [], stale: [], floored: [], held: [] };
  const seen = new Set<string>();
  const read = (entry: unknown, taken: boolean) => {
    if (!entry || typeof entry !== 'object') return;
    const { key, rev, reason, floor } = entry as { key?: unknown; rev?: unknown; reason?: unknown; floor?: unknown };
    if (typeof key !== 'string' || typeof rev !== 'string' || sent.get(key) !== rev || seen.has(key)) return;
    seen.add(key);
    const kind = key.slice(0, key.indexOf(':'));
    if (taken) out.took.push({ key, rev });
    else if (reason === 'open_request' && kind === 'equipment') {
      if (STATUS_WORDS.includes(floor)) out.floored.push({ key, rev, floor: floor as PushAnswer['floored'][number]['floor'] });
      else out.held.push({ key, rev, reason: 'malformed' });
    } else if (isShared(kind) && (reason === 'superseded' || reason === 'copy' || reason === 'deleted')) out.stale.push({ key, rev });
    else if (reason === 'supervisor_only' || reason === 'not_yours' || reason === 'signed') out.held.push({ key, rev, reason });
    else if (isShared(kind) && (reason === 'malformed' || reason === 'private' || reason === 'too_large')) out.held.push({ key, rev, reason: reason as HeldReason });
    else out.took.push({ key, rev });
  };
  for (const entry of accepted) read(entry, true);
  for (const entry of (ignored as unknown[] | null) ?? []) read(entry, false);
  return out;
}

/** One answer of a read: the first row when the server sent a list. */
const one = (raw: unknown) => (Array.isArray(raw) ? (raw.length ? raw[0] : null) : raw);

/** A page of read_shared_records. Each row's data is left for the merge to read; a page that is not rows throws. */
export function readRows(raw: unknown): ReceivedRow[] {
  if (!Array.isArray(raw)) throw new Error(NOT_UNDERSTOOD);
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error(NOT_UNDERSTOOD);
    const { kind, id, rev, seq, deleted, data } = entry as Record<string, unknown>;
    const n = typeof seq === 'string' && /^\d+$/.test(seq) ? Number(seq) : seq;
    if (typeof kind !== 'string' || !isShared(kind) || typeof id !== 'string' || typeof rev !== 'string' || typeof deleted !== 'boolean') throw new Error(NOT_UNDERSTOOD);
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) throw new Error(NOT_UNDERSTOOD);
    return { kind: kind as ReceivedRow['kind'], id, rev, seq: n, deleted, data };
  });
}

/** This phone's sign-in's own row of the roster, or null when it is not on the roster. */
export function readStanding(raw: unknown): Standing | null {
  const row = one(raw);
  if (row === null || row === undefined) return null;
  const { first_name, last_name, role } = (typeof row === 'object' ? row : {}) as Record<string, unknown>;
  if (typeof first_name !== 'string' || typeof last_name !== 'string' || !isRole(role)) throw new Error(NOT_UNDERSTOOD);
  return { role, name: { firstName: first_name, lastName: last_name } };
}

/** The company's own row: its name, state and pay schedule. */
export function readCompanyRow(raw: unknown): CompanyRow | null {
  const row = one(raw);
  if (row === null || row === undefined) return null;
  const { name, state, pay_period } = (typeof row === 'object' ? row : {}) as Record<string, unknown>;
  if (typeof name !== 'string' || typeof state !== 'string') throw new Error(NOT_UNDERSTOOD);
  return { name, state, pay: pay_period ?? null };
}

// ---- When something goes wrong -------------------------------------------------------------

/** An error from the server or the network, as supabase-js hands it back. */
export interface ServerProblem {
  code?: string;
  message?: string;
  status?: number;
  name?: string;
}

const UNREACHABLE = 'The company server could not be reached. Check your signal and try again.';

/** An email that already has an account. */
export const ALREADY_AN_ACCOUNT = 'That email already has an account. Sign in, or tap Forgot password.';

function unreachable(e: ServerProblem): boolean {
  return e.status === 0 || e.name === 'AuthRetryableFetchError' || /fetch|network|timed? ?out|abort/i.test(e.message ?? '');
}

/** What went wrong calling one of the server's functions, and what to do next. */
export function serverWords(e: ServerProblem | null | undefined): string {
  if (!e) return UNREACHABLE;
  if (unreachable(e)) return UNREACHABLE;
  // "Not found, or not yours" (refusals.ts).
  if (isNotFound(e.code)) return 'That company was not found, or you are no longer on its roster. See your supervisor.';
  switch (e.code) {
    case '42501':
    case 'PGRST301':
    case 'PGRST303':
      return 'You are signed out of the company server. Sign in again.';
    case '22023':
      return 'The server could not take what was typed. Type your name in ordinary letters, the way it is on the roster.';
    case 'PGRST202':
      return 'The company server is not ready for this yet. Try again later.';
    default:
      return 'Something went wrong on the company server. Try again in a minute.';
  }
}

/**
 * What a failed push_records call means for the records: why they did not go,
 * in words for the records row. The phone has already checked it is signed in
 * before it calls, so a refusal for want of rights means the account is not on
 * the company's roster (any more).
 */
export function pushTrouble(e: ServerProblem | null | undefined): SendError {
  if (!e || unreachable(e)) return sendError('unreachable', UNREACHABLE);
  // Turned down for want of rights, or "No such company" (refusals.ts).
  if (e.code === '42501' || isNotFound(e.code)) return sendError('not_member', 'This account is not on the company’s roster any more.');
  // read_shared_records, to a supervisor of a company that does not have MineMuster.
  if (e.code === 'PT402') return sendError('closed', 'MineMuster is not active for this company.');
  switch (e.code) {
    case 'PGRST301':
    case 'PGRST303':
      return sendError('signed_out', 'You are signed out of the company server.');
    case 'PGRST202':
      return sendError('server', 'The company server is not ready to take records yet.');
    // The server is up but cannot reach its database: no different, for the phone, from no signal.
    case 'PGRST000':
    case 'PGRST001':
    case 'PGRST002':
    case 'PGRST003':
      return sendError('unreachable', UNREACHABLE);
  }
  // What was sent was turned down for what is in it: a change the server cannot take as it is.
  if (e.code && /^(22|23|54)/.test(e.code)) return sendError('refused', 'The server would not take a record as it is.');
  if (e.status && e.status >= 500) return sendError('unreachable', UNREACHABLE);
  return sendError('server', 'Something went wrong on the company server.');
}

/** What went wrong signing in or creating an account, and what to do next. */
export function authWords(e: ServerProblem | null | undefined): string {
  if (!e) return UNREACHABLE;
  if (unreachable(e)) return UNREACHABLE;
  switch (e.code) {
    case 'invalid_credentials':
      return 'That email and password do not match an account. Check the spelling, or tap Forgot password.';
    case 'email_not_confirmed':
      return 'Confirm your email first: open the link we sent you, then sign in.';
    case 'user_already_exists':
    case 'email_exists':
      return ALREADY_AN_ACCOUNT;
    case 'weak_password':
      return 'Choose a stronger password: at least 8 characters, and not one that is easy to guess.';
    case 'email_address_invalid':
      return 'Enter a valid email address.';
    case 'signup_disabled':
      return 'New accounts are turned off on this server. See your supervisor.';
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return 'Too many tries for now. Wait a few minutes and try again.';
  }
  if (e.status === 429) return 'Too many tries for now. Wait a few minutes and try again.';
  if (/invalid login credentials/i.test(e.message ?? '')) return 'That email and password do not match an account. Check the spelling, or tap Forgot password.';
  return 'The company server turned that down. Try again in a minute.';
}

/** The person's role on the server's roster, for the account screen. */
export function roleWords(role: Role): string {
  return role === 'supervisor' ? 'Supervisor' : 'Crew';
}

// ---- Deleting a company sign-in --------------------------------------------------------------

/** account_deletion_check's answer: what deleting the account means in each of its companies, or null when the phone cannot read it. */
export function readDeletionCheck(raw: unknown): DeletionCheckCompany[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DeletionCheckCompany[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') return null;
    const { id, name, role, last_supervisor, successors, can_close, close_from, running } = row as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || !isRole(role) || typeof last_supervisor !== 'boolean' || !Array.isArray(successors)) return null;
    if (typeof can_close !== 'boolean' || (close_from !== null && typeof close_from !== 'string')) return null;
    const people: DeletionCheckCompany['successors'] = [];
    for (const s of successors) {
      const { roster_id, first_name, last_name } = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      if (typeof roster_id !== 'string' || typeof first_name !== 'string' || typeof last_name !== 'string') return null;
      people.push({ rosterId: roster_id, firstName: first_name, lastName: last_name });
    }
    out.push({
      id,
      name,
      role,
      lastSupervisor: last_supervisor,
      successors: people,
      canClose: can_close,
      closeFrom: close_from,
      running: typeof running === 'number' ? running : null,
    });
  }
  return out;
}

export type { DeletionAnswer };

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const isCloseRefusal = (value: unknown): value is CloseRefusal =>
  value === 'wrong_name' || value === 'someone_can_take_over' || value === 'subscription_running' || value === 'not_found';

/**
 * What became of a deletion once an answer that does not say whether the sign-in went has been checked
 * with Supabase Auth (`state`, for the session that asked): gone is deleted, by this request or another.
 * A plain 401 was turned down before anything was deleted. The phone and the office dashboard both
 * settle their answers here before they say anything.
 */
export async function settleDeletion(answer: DeletionAnswer, state: () => Promise<'gone' | 'there' | 'unknown'>): Promise<DeletionAnswer> {
  if (answer.kind === 'signed_out') return (await state()) === 'gone' ? { kind: 'already_deleted' } : { kind: 'try_again', closed: [] };
  if (answer.kind === 'not_known') return (await state()) === 'gone' ? { kind: 'deleted', closed: answer.closed } : answer;
  return answer;
}

/**
 * The delete-account function's answer, by its status and body. Only its own 410 says the sign-in is
 * deleted already; a plain 401 says the server did not take the session, and a 504 that the request
 * went with no word yet of whether the sign-in was deleted.
 */
export function readDeletionAnswer(status: number, body: unknown): DeletionAnswer {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status === 200 && b.deleted === true) return { kind: 'deleted', closed: ids(b.closed) };
  if (status === 410 && b.error === 'already_deleted') return { kind: 'already_deleted' };
  if (status === 401) return { kind: 'signed_out' };
  if (status === 504 && b.error === 'not_known') return { kind: 'not_known', closed: ids(b.closed) };
  if (status === 403 && b.error === 'password_needed') return { kind: 'password_needed' };
  if (status === 409 && b.error === 'close_refused' && typeof b.company_id === 'string' && isCloseRefusal(b.reason)) {
    return { kind: 'close_refused', companyId: b.company_id, reason: b.reason, closeFrom: typeof b.close_from === 'string' ? b.close_from : null, closed: ids(b.closed) };
  }
  if (status === 409 && b.error === 'last_supervisor') {
    const companies = Array.isArray(b.companies) ? b.companies : [];
    const names = companies.map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).name : null)).filter((n): n is string => typeof n === 'string');
    return { kind: 'last_supervisor', companies: names };
  }
  if (status === 404 || (status === 500 && b.error === 'not_set_up')) return { kind: 'not_ready' };
  return { kind: 'try_again', closed: ids(b.closed) };
}

/** What to tell the person about a deletion that did not go through, or went only part way. */
export function deletionAnswerWords(answer: DeletionAnswer, { email }: { email: string }): string {
  switch (answer.kind) {
    case 'deleted':
      return 'Your account is deleted.';
    case 'wrong_password':
      return `That is not the password for ${email}. Try again.`;
    case 'password_needed':
      return 'Enter your password again. It has to be typed within ten minutes of deleting.';
    case 'last_supervisor': {
      const names = answer.companies.length ? answer.companies : ['The company'];
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return `${list} ${names.length === 1 ? 'has' : 'have'} no other supervisor now. Finish on the office dashboard.`;
    }
    case 'already_deleted':
      return 'Your company sign-in is already deleted. Delete the rest from this phone.';
    case 'signed_out':
      return 'MineMuster’s server did not take this phone’s sign-in. Nothing was deleted. Try again.';
    case 'unreachable':
      return 'Could not reach MineMuster’s server. Nothing was deleted. Try again when you have signal.';
    case 'not_known':
      return answer.closed.length
        ? 'The company is closed. MineMuster’s server did not say in time whether your company sign-in was deleted too. Try again in a minute.'
        : 'MineMuster’s server did not say in time whether your company sign-in was deleted. Try again in a minute.';
    case 'close_refused': {
      const first = answer.closed.length ? 'The company before it is closed, and your account is not deleted yet. ' : 'Nothing was closed or deleted. ';
      switch (answer.reason) {
        case 'wrong_name':
          return `${first}Type the company’s name as it is written to close it.`;
        case 'someone_can_take_over':
          return `${first}Someone else could still take over the company, so it was not closed. Make them a supervisor on the Roster page instead.`;
        case 'subscription_running':
          return `${first}The company’s subscription is still running. Cancel it in Billing first.`;
        case 'not_found':
          return `${first}That company is not one you can close.`;
      }
    }
    case 'too_many':
      return 'Too many tries for now. Wait a few minutes and try again. Nothing was deleted.';
    case 'not_ready':
      return 'Deleting a company sign-in is not ready on MineMuster’s server yet. Nothing was deleted. Try again later.';
    case 'try_again':
      return answer.closed.length
        ? 'The company is closed, but your account could not be deleted just now. Try again in a few minutes.'
        : 'MineMuster’s server could not delete your account just now. Nothing was deleted. Try again in a few minutes.';
  }
}

// ---- The crew-auth function: company code, name and passcode ----------------------------------------

/**
 * The fields each crew-auth action takes, under the server's own names, every one text and no other
 * (FIELDS in supabase/functions/crew-auth/handler.ts, which turns down a body with any other). A
 * camelCase, missing or extra field is a type error.
 */
export interface CrewFields {
  lookup: { code: string };
  sign_up: { code: string; first_name: string; last_name: string; passcode: string };
  sign_in: { code: string; first_name: string; last_name: string; passcode: string };
  reset: { code: string; first_name: string; last_name: string; reset_code: string; new_passcode: string };
  confirm: { passcode: string };
}

export type CrewAction = keyof CrewFields;

/** The session a sign-in hands the phone. `expiresAt` is Supabase's own: seconds since the epoch. */
export interface CrewSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
}

export type CrewAnswer =
  | { kind: 'company'; name: string; state: string }
  | {
      kind: 'signed_in';
      session: CrewSession;
      /** Null from a confirm, which names no company. */
      company: { id: string; name: string } | null;
      waiting: boolean;
      join: JoinAnswer | null;
      /** False only when a reset could not sign the account's other sessions out. */
      othersSignedOut: boolean;
    }
  | { kind: 'passcode_changed' }
  | {
      kind:
        | 'no_company'
        | 'already_signed_up'
        | 'use_email'
        | 'no_account'
        | 'ambiguous'
        | 'expired'
        | 'busy'
        | 'denied'
        | 'signed_out'
        | 'already_deleted'
        | 'unreachable';
    }
  | { kind: 'wrong'; triesLeft: number }
  | { kind: 'bad_reset_code'; triesLeft: number }
  | { kind: 'locked'; until: number | null }
  | { kind: 'easy_passcode'; problem: PasscodeProblem }
  | { kind: 'bad_name'; message: string }
  | { kind: 'server'; message: string };

const PLAIN_CREW_REFUSALS = ['no_company', 'already_signed_up', 'use_email', 'no_account', 'ambiguous', 'expired', 'busy', 'denied'] as const;
const PASSCODE_PROBLEMS: readonly unknown[] = ['not_digits', 'too_short', 'too_long', 'easy'];

const crewServerTrouble = (status: number): CrewAnswer => ({ kind: 'server', message: `The sign-in server sent an answer this app cannot read (HTTP ${status}).` });

function readCrewSession(raw: unknown): CrewSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const { access_token, refresh_token, expires_at, user_id } = raw as Record<string, unknown>;
  if (typeof access_token !== 'string' || !access_token || typeof refresh_token !== 'string' || !refresh_token) return null;
  if (typeof expires_at !== 'number' || !Number.isFinite(expires_at) || typeof user_id !== 'string' || !user_id) return null;
  return { accessToken: access_token, refreshToken: refresh_token, expiresAt: expires_at, userId: user_id };
}

/** What the crew-auth function answered, by its HTTP status and body. Never echoes the body. */
export function readCrewAnswer(status: number, body: unknown): CrewAnswer {
  if (status === 401) return { kind: 'signed_out' };
  if (status === 410) return { kind: 'already_deleted' };
  if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) return crewServerTrouble(status);
  const b = body as Record<string, unknown>;
  const said = b.status;
  if (said === 'company') {
    return typeof b.name === 'string' && typeof b.state === 'string' ? { kind: 'company', name: b.name, state: b.state } : crewServerTrouble(status);
  }
  if (said === 'signed_in') {
    const session = readCrewSession(b.session);
    if (!session) return crewServerTrouble(status);
    const c = b.company;
    const company =
      c && typeof c === 'object' && typeof (c as Record<string, unknown>).id === 'string' && typeof (c as Record<string, unknown>).name === 'string'
        ? { id: (c as { id: string }).id, name: (c as { name: string }).name }
        : null;
    return {
      kind: 'signed_in',
      session,
      company,
      waiting: b.waiting === true,
      join: readJoinAnswer(b.join),
      othersSignedOut: b.others_signed_out !== false,
    };
  }
  if (said === 'passcode_changed') return { kind: 'passcode_changed' };
  if ((PLAIN_CREW_REFUSALS as readonly unknown[]).includes(said)) return { kind: said as (typeof PLAIN_CREW_REFUSALS)[number] };
  if (said === 'wrong' || said === 'bad_reset_code') {
    return typeof b.tries_left === 'number' && Number.isFinite(b.tries_left) ? { kind: said, triesLeft: b.tries_left } : crewServerTrouble(status);
  }
  if (said === 'locked') {
    if (b.until === null) return { kind: 'locked', until: null };
    const until = typeof b.until === 'string' ? Date.parse(b.until) : NaN;
    return Number.isFinite(until) ? { kind: 'locked', until } : crewServerTrouble(status);
  }
  if (said === 'easy_passcode') {
    return PASSCODE_PROBLEMS.includes(b.problem) ? { kind: 'easy_passcode', problem: b.problem as PasscodeProblem } : crewServerTrouble(status);
  }
  if (said === 'bad_name') return typeof b.message === 'string' && b.message ? { kind: 'bad_name', message: b.message } : crewServerTrouble(status);
  return crewServerTrouble(status);
}

/** What to tell a crew member about an answer from the crew-auth function. Never asks crew for an email. */
export function crewWords(answer: CrewAnswer, now: number): { title: string; body?: string; tone: 'ok' | 'warn' | 'bo' | 'info' } {
  switch (answer.kind) {
    case 'company':
      return { title: answer.name, body: 'Type your first and last name and your passcode.', tone: 'ok' };
    case 'signed_in':
      return answer.waiting
        ? { title: 'Waiting for a supervisor', body: 'A supervisor will let you in. Once they do, open the app again.', tone: 'info' }
        : { title: 'You are signed in', tone: 'ok' };
    case 'passcode_changed':
      return { title: 'Your new passcode is set', body: 'Sign in with your new passcode.', tone: 'ok' };
    case 'no_company':
      return { title: 'No company has that code', body: 'Check the code with your supervisor and type it again.', tone: 'warn' };
    case 'already_signed_up':
      return { title: 'That name already has a sign-in', body: 'Sign in with your passcode. If you forgot it, ask a supervisor for a reset code.', tone: 'warn' };
    case 'use_email':
      return { title: 'This name signs in with email', body: 'Tap Supervisor? Sign in with email.', tone: 'info' };
    case 'no_account':
      return { title: 'No sign-in for that name yet', body: 'Check the spelling, or tap Sign up to make your sign-in.', tone: 'warn' };
    case 'ambiguous':
      return { title: 'More than one person fits that name', body: 'Type your name the way it is on the roster.', tone: 'warn' };
    case 'expired':
      return { title: 'That reset code has run out or was already used', body: 'Ask a supervisor for a new one.', tone: 'warn' };
    case 'busy':
      return { title: 'Too many tries from this network', body: 'Wait a few minutes and try again.', tone: 'warn' };
    case 'denied':
      return { title: 'A supervisor has turned down your request', body: 'Speak to a supervisor at your company.', tone: 'bo' };
    case 'signed_out':
      return { title: 'You are signed out', body: 'Sign in again.', tone: 'warn' };
    case 'already_deleted':
      return { title: 'That sign-in is already deleted', tone: 'info' };
    case 'unreachable':
      return { title: 'No signal', body: 'The company server could not be reached. Try again when you have signal.', tone: 'warn' };
    case 'wrong': {
      const left = `${answer.triesLeft} ${answer.triesLeft === 1 ? 'try' : 'tries'} left`;
      return { title: 'That passcode is not right', body: `${left}. Check it and try again.`, tone: 'bo' };
    }
    case 'bad_reset_code': {
      const left = `${answer.triesLeft} ${answer.triesLeft === 1 ? 'try' : 'tries'} left`;
      return { title: 'That reset code is not right', body: `${left}. Check it with your supervisor and try again.`, tone: 'bo' };
    }
    case 'locked':
      if (answer.until === null) return { title: 'This sign-in is locked', body: 'Ask a supervisor for a reset code.', tone: 'bo' };
      return {
        title: 'Too many wrong passcodes',
        body: `Try again at ${startOfDay(answer.until) === startOfDay(now) ? fmtTime(answer.until) : fmtDateTime(answer.until)}, or ask a supervisor for a reset code.`,
        tone: 'bo',
      };
    case 'easy_passcode':
      return { title: 'Pick a harder passcode', body: passcodeWords(answer.problem), tone: 'warn' };
    case 'bad_name':
      return { title: 'Check your name', body: answer.message, tone: 'warn' };
    case 'server':
      return { title: 'Something went wrong', body: 'Try again in a minute. If it keeps happening, tell a supervisor.', tone: 'warn' };
  }
}
