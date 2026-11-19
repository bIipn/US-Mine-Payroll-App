import { isNotFound } from './refusals';
import { cleanText } from './roster';
import type { ConnectedCompany } from './server';
import { sendError, type Change, type SendError } from './sync';
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

/** A join code the way the server reads it: capitals, with the spaces and dashes taken out. */
export function normalJoinCode(code: string): string {
  return code.normalize('NFKC').replace(/[\s\-‐-―−]/g, '').toUpperCase();
}

/** What is wrong with a typed join code, before it is sent. A code is 8 letters and numbers, with no O, 0, I or 1. */
export function checkJoinCode(code: string): string | null {
  const typed = normalJoinCode(code);
  if (!typed) return 'Enter the join code your supervisor gave you.';
  if (!/^[A-Z0-9]{8}$/.test(typed)) return 'A join code is 8 letters and numbers, like ABCD 2345. Check it with your supervisor.';
  if (/[01IO]/.test(typed)) return 'A join code has no O, 0, I or 1. Check it with your supervisor.';
  return null;
}

/** A join code the way it is easiest to read out: two groups of four, like ABCD 2345. */
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
      return { title: 'No company has that join code', body: 'Check the code with your supervisor and type it again.', tone: 'warn' };
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
export function readPushAnswer(raw: unknown, batch: readonly Change[]): Pick<Change, 'key' | 'rev'>[] {
  const answer = Array.isArray(raw) ? raw[0] : raw;
  const { accepted, ignored } = (answer && typeof answer === 'object' ? answer : {}) as { accepted?: unknown; ignored?: unknown };
  if (!Array.isArray(accepted) || (ignored != null && !Array.isArray(ignored))) {
    throw new Error('The server answered in a way this phone does not understand.');
  }
  const sent = new Map(batch.map((c) => [c.key, c.rev]));
  const out: Pick<Change, 'key' | 'rev'>[] = [];
  const seen = new Set<string>();
  for (const entry of [...accepted, ...((ignored as unknown[] | null) ?? [])]) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, rev } = entry as { key?: unknown; rev?: unknown };
    if (typeof key !== 'string' || typeof rev !== 'string' || sent.get(key) !== rev || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, rev });
  }
  return out;
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
