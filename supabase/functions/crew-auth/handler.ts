// What the crew-auth edge function does with a request, kept apart from Deno (index.ts) so the tests can
// run it under Node with stand-ins for Supabase Auth and the database.
//
// A crew member gets into the app with their company's code, their first and last name and a passcode,
// and never sees an email. Each crew member is an ordinary Supabase Auth account, made here: a hidden
// address on crew.minemuster.com, which receives no mail, and a password the database works out from it
// with a key of its own (migration 20261122000100). The database checks the code, the name, the passcode,
// the locks and the reset codes, counts each request against the phone's network address, and hands back
// that login; this function signs in with it, by Supabase Auth's password grant, and answers the phone
// with the session, an ordinary one, which the phone keeps.
//
//  1. A request with an Origin is a web page's, and is 403 origin_not_allowed before anything is asked:
//     the app sends none. Any method but POST is 405.
//  2. The body is JSON: { action: 'lookup', code }; { action: 'sign_up' or 'sign_in', code, first_name,
//     last_name, passcode }; { action: 'reset', code, first_name, last_name, reset_code, new_passcode };
//     or { action: 'confirm', passcode }, with the session signed in on the phone as the bearer token.
//     Every field is text, and there is no other. A body said to be larger than 4096 bytes, or found
//     larger while it is read, is 413 too_large, and no more of it is read; any other is 400 bad_request.
//  3. The phone's address is cf-connecting-ip, which Supabase's edge sets, else the first X-Forwarded-For
//     entry, and none when that is not an IPv4 or IPv6 address (clientAddress). The database counts every
//     request but confirm against it, at most 30 from one address in 10 minutes, and answers busy past
//     that. Every request with no address counts as one sender, so junk splits nothing.
//  4. Each check is a database function, called with the server key by POST: a check counts the request
//     and a wrong try, and PostgREST runs a GET in a transaction that cannot write. A refusal is answered
//     200 { status, ... } as the database gives it; the login it gives is never answered.
//  5. lookup: crew_lookup.
//  6. sign_up: crew_sign_up_check, which makes nothing; then the account, made by Supabase Auth's admin
//     API with its address confirmed (so no mail is sent) and app_metadata.sign_in 'passcode'; the
//     passcode, kept by crew_keep_passcode; the password grant; and join_company as the new account, with
//     its own token, so every join rule applies unchanged. Joined: signed in. A request left for a
//     supervisor: signed in, waiting. Once the account is made, whatever goes wrong deletes it again with
//     Supabase Auth's admin delete, and the answer says why: the join's refusal (no_company, denied,
//     ambiguous, or bad_name with the database's words for a name that only looks like one on the
//     roster); already_signed_up when another sign-up took the name meanwhile (join_company leaves a
//     request, already_claimed); busy for Supabase Auth's 429; and 500 try_again for anything else. An
//     admin create with no answer may have made the account all the same: the login is signed in with,
//     and an account it signs in to is deleted again.
//  7. sign_in: crew_sign_in_check, then the password grant.
//  8. reset: crew_reset_check, which keeps the new passcode and spends the code; the password grant; and
//     Supabase Auth's sign-out of every other session of the account, made with the fresh session, so a
//     lost or old phone stops working, tried once more when it fails. From the kept passcode on, nothing
//     answers busy or try_again, which would have the person try a spent code: a sign-in that fails is
//     200 { status: 'passcode_changed' }, to sign in with the new passcode, and the session answered says
//     others_signed_out, false when the sign-out failed twice. The app then signs the other sessions out
//     itself.
//  9. confirm: whose the bearer token is, from Supabase Auth, read as delete-account reads it (401
//     signed_out, 410 already_deleted); crew_confirm_check for that account; then the password grant: a
//     fresh session to delete the account with. It names no company and says nothing of waiting: the
//     check goes by the account, not by a code or a name, which a supervisor can change.
// 10. A sign-in is 200 { status: 'signed_in', session: { access_token, refresh_token, expires_at,
//     user_id }, company: { id, name }, waiting }, with join, join_company's answer, on sign_up besides,
//     and others_signed_out on reset. Supabase Auth's 429 at any step but a reset's sign-in is 200
//     { status: 'busy' }. Missing settings are 500 not_set_up, before anything is asked; anything else
//     that fails is 500 try_again.
//
// It logs what happened as a code: never a name, a passcode, a reset code, a company code, an address,
// an email, a token, a key or an id.

import { keyHeaders, publishableKeyFrom, serverFrom, type Env, type Server } from '../_shared/server.ts';
import { bearerOf, callFunction, callWithin, codeOf, deleteAuthUser, jsonOf, objectOf, personHeaders, readCapped, whoseToken, type Fetch } from '../_shared/http.ts';

export interface CrewDeps {
  env: Env;
  fetch: Fetch;
  /** The clock, in milliseconds. */
  now?: () => number;
  log?: (message: string) => void;
}

/** The largest body read, in bytes. */
export const MAX_BODY_BYTES = 4096;
/** The domain of crew accounts' hidden addresses: MineMuster's own, and it receives no mail. */
export const CREW_DOMAIN = 'crew.minemuster.com';

type Json = Record<string, unknown>;
type Action = 'lookup' | 'sign_up' | 'sign_in' | 'reset' | 'confirm';
type Fields = Record<string, string>;

/** The fields each action takes, every one of them text. */
const FIELDS: Record<Action, readonly string[]> = {
  lookup: ['code'],
  sign_up: ['code', 'first_name', 'last_name', 'passcode'],
  sign_in: ['code', 'first_name', 'last_name', 'passcode'],
  reset: ['code', 'first_name', 'last_name', 'reset_code', 'new_passcode'],
  confirm: ['passcode'],
};

/** What each action's check refuses with (migration 20261122000100), answered as the database gives it. */
const REFUSALS: Record<Action, readonly string[]> = {
  lookup: ['no_company', 'busy'],
  sign_up: ['busy', 'no_company', 'easy_passcode', 'bad_name', 'already_signed_up', 'use_email'],
  sign_in: ['busy', 'no_company', 'ambiguous', 'use_email', 'no_account', 'wrong', 'locked'],
  reset: ['busy', 'no_company', 'ambiguous', 'use_email', 'no_account', 'easy_passcode', 'expired', 'bad_reset_code'],
  confirm: ['wrong', 'locked', 'no_account'],
};

/** What join_company answers (migration 20261116002600), and which of them refuse the new account. */
const JOIN_STATUSES = ['joined', 'already_member', 'pending', 'no_company', 'denied', 'ambiguous'];
const JOIN_REFUSALS = ['no_company', 'denied', 'ambiguous'];

/** The address crew_sign_up_check makes for a new account: crew-, 32 hex digits, on CREW_DOMAIN. */
const HIDDEN_ADDRESS = new RegExp(`^crew-[0-9a-f]{32}@${CREW_DOMAIN.replace(/\./g, '\\.')}$`);

/** join_company's words for a name that only looks like one on the roster, for when it gives none. */
const NOT_THE_ROSTER_NAME = 'Type your name the way it is written on the roster.';

// ---- The phone's address ----------------------------------------------------------------------------

const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
/** An IPv4 address, four numbers to 255 with no leading zeros. */
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

/** An IPv6 address: eight groups of hex digits, or fewer with one ::, and an IPv4 address in place of the last two. No zone, no brackets. */
function isIpv6(text: string): boolean {
  // An IPv4 address can only end it, after its last colon. It is checked, then read as the two groups it stands for.
  const end = text.slice(text.lastIndexOf(':') + 1);
  if (end.includes('.') && !IPV4.test(end)) return false;
  const hex = end.includes('.') ? `${text.slice(0, text.length - end.length)}0:0` : text;
  const halves = hex.split('::');
  if (halves.length > 2) return false;
  const groups = halves.filter((half) => half !== '').flatMap((half) => half.split(':'));
  if (!groups.every((group) => HEX_GROUP.test(group))) return false;
  // With :: the groups it leaves out are at least one; without, all eight are written.
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8;
}

/**
 * The phone's network address, for the database to count requests by: cf-connecting-ip, which Supabase's
 * edge sets, when there is one, else the first X-Forwarded-For entry; and '' when that is not an IPv4 or
 * IPv6 address, as the contact form passes over what is not one. It is never logged.
 */
export function clientAddress(request: Request): string {
  const connecting = request.headers.get('cf-connecting-ip');
  const value = (connecting ?? (request.headers.get('x-forwarded-for') ?? '').split(',')[0]).trim();
  return IPV4.test(value) || isIpv6(value) ? value : '';
}

// ---- Reading the request and the answers ------------------------------------------------------------

/** The action and its fields, or null when the body is not one action with exactly the fields it takes, each of them text. */
function readAsk(text: string): { action: Action; fields: Fields } | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { action, ...fields } = body as Json;
  if (typeof action !== 'string' || !Object.hasOwn(FIELDS, action)) return null;
  const wanted = FIELDS[action as Action];
  if (Object.keys(fields).length !== wanted.length || !wanted.every((key) => typeof fields[key] === 'string')) return null;
  return { action: action as Action, fields: fields as Fields };
}

interface Login {
  email: string;
  password: string;
}

/** The login a check gives, or null. */
function loginOf(data: Json): Login | null {
  const { login_email, login_password } = data;
  return typeof login_email === 'string' && login_email && typeof login_password === 'string' && login_password ? { email: login_email, password: login_password } : null;
}

/** The company a check gives, or null. */
function companyOf(data: Json): { id: string; name: string } | null {
  const { company_id, company_name } = data;
  return typeof company_id === 'string' && typeof company_name === 'string' ? { id: company_id, name: company_name } : null;
}

/** A check's refusal, with only the fields a refusal has, or null when it is not one this action knows. */
function refusalOf(action: Action, data: Json): Json | null {
  const { status, problem, message, tries_left, until } = data;
  if (typeof status !== 'string' || !REFUSALS[action].includes(status)) return null;
  return {
    status,
    ...(typeof problem === 'string' ? { problem } : null),
    ...(typeof message === 'string' ? { message } : null),
    ...(typeof tries_left === 'number' ? { tries_left } : null),
    ...(typeof until === 'string' || until === null ? { until } : null),
  };
}

interface Joined {
  status: string;
  company_name?: string;
  role?: string;
  reason?: string;
}

/** join_company's answer, with only the fields it has, or null when it is not one. */
function joinOf(data: unknown): Joined | null {
  const { status, company_name, role, reason } = objectOf(data);
  if (typeof status !== 'string' || !JOIN_STATUSES.includes(status)) return null;
  return {
    status,
    ...(typeof company_name === 'string' ? { company_name } : null),
    ...(typeof role === 'string' ? { role } : null),
    ...(typeof reason === 'string' ? { reason } : null),
  };
}

interface Session {
  access_token: string;
  refresh_token: string;
  /** When the access token expires, in seconds since 1970, as Supabase Auth gives it. */
  expires_at: number;
  user_id: string;
}

/** A person a check let in, signed in: the session, their company, and whether they wait for a supervisor. */
interface SignedIn {
  session: Session;
  company: { id: string; name: string };
  waiting: boolean;
}

/** The session in the password grant's answer, or null when there is none. */
function sessionOf(body: Json, nowMs: number): Session | null {
  const { access_token, refresh_token, expires_at, expires_in } = body;
  const user = objectOf(body.user);
  const expires = typeof expires_at === 'number' ? expires_at : typeof expires_in === 'number' ? Math.floor(nowMs / 1000) + expires_in : Number.NaN;
  if (typeof access_token !== 'string' || !access_token || typeof refresh_token !== 'string' || !refresh_token) return null;
  if (typeof user.id !== 'string' || !user.id || !Number.isFinite(expires)) return null;
  return { access_token, refresh_token, expires_at: Math.floor(expires), user_id: user.id };
}

/**
 * A call to Supabase Auth that did not go through: busy for its 429; whether it was answered at all (one
 * that was not may have been carried out all the same); and why, as codes for the log.
 */
interface Failed {
  failed: true;
  busy: boolean;
  answered: boolean;
  why: string;
}

const failure = (what: string, response: Response | null, body: Json): Failed => ({
  failed: true,
  busy: response?.status === 429,
  answered: response !== null,
  why: response ? `${what} answered ${response.status}${codeOf(body.error_code)}` : `${what} got no answer`,
});

/** A failure of something that was answered, and read: never busy. */
const unreadable = (why: string): Failed => ({ failed: true, busy: false, answered: true, why });

const answer = (status: number, body: Json, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// ---- The handler ------------------------------------------------------------------------------------

/** The request handler, for Deno.serve. */
export function makeHandler(deps: CrewDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const said = (code: string) => log(`crew-auth: ${code}`);

  const notSetUp = () => answer(500, { error: 'not_set_up', message: 'Crew sign-in is not set up on this server yet.' });
  const tryAgain = () => answer(500, { error: 'try_again', message: 'That did not go through just now. Try again in a few minutes.' });
  /** A call to Supabase Auth that failed: its 429 is busy, as the database's own limit is, and anything else try_again. */
  const failed = (action: Action, what: Failed): Response => {
    said(`${action}: ${what.why}`);
    return what.busy ? answer(200, { status: 'busy' }) : tryAgain();
  };
  const refused = (action: Action, data: Json): Response => {
    const refusal = refusalOf(action, data);
    if (!refusal) {
      said(`${action}: the check answered a status this does not know`);
      return tryAgain();
    }
    said(`${action} ${String(refusal.status)}`);
    return answer(200, refusal);
  };

  /** A check, a database function called with the server key: its answer, or null when it gave none this can read (logged). */
  async function check(server: Server, action: Action, name: string, args: Json): Promise<Json | null> {
    const called = await callFunction(deps.fetch, server, name, args, keyHeaders(server.key));
    if (!called.ok) {
      said(`${action}: ${name} answered ${called.status}${codeOf(called.code)}`);
      return null;
    }
    const data = objectOf(called.data);
    if (typeof data.status !== 'string') {
      said(`${action}: ${name} answered something this cannot read`);
      return null;
    }
    return data;
  }

  /** A new account at a hidden address, made by Supabase Auth's admin API with the server key: confirmed, so no mail is sent. */
  async function makeAccount(server: Server, login: Login): Promise<{ id: string } | Failed> {
    const response = await callWithin(deps.fetch, `${server.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { ...keyHeaders(server.key), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: login.email, password: login.password, email_confirm: true, app_metadata: { sign_in: 'passcode' } }),
    });
    const body: Json = response ? objectOf(await jsonOf(response)) : {};
    if (!response || !response.ok) return failure('the admin create', response, body);
    return typeof body.id === 'string' && body.id ? { id: body.id } : unreadable('the admin create answered no account');
  }

  /** A session for a login, by Supabase Auth's password grant, made with the publishable key as a phone's own sign-in is. */
  async function signIn(server: Server, publishable: string, login: Login): Promise<{ session: Session } | Failed> {
    const response = await callWithin(deps.fetch, `${server.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: publishable, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: login.email, password: login.password }),
    });
    const body: Json = response ? objectOf(await jsonOf(response)) : {};
    if (!response || !response.ok) return failure('the password grant', response, body);
    const session = sessionOf(body, now());
    return session ? { session } : unreadable('the password grant answered no session');
  }

  /**
   * The person a check found and let in (sign_in, reset), signed in with the login it gave: the session,
   * the company and whether they wait for a supervisor, or why not.
   */
  async function checkedLogin(server: Server, publishable: string, data: Json): Promise<SignedIn | Failed> {
    const login = loginOf(data);
    const company = companyOf(data);
    const { waiting } = data;
    if (!login || !company || typeof waiting !== 'boolean') return unreadable('the check answered a login this cannot read');
    const signed = await signIn(server, publishable, login);
    return 'failed' in signed ? signed : { session: signed.session, company, waiting };
  }

  /**
   * Supabase Auth's sign-out of every other session of the account, made with this session's own token,
   * and made once more when it fails: whether the other sessions are signed out.
   */
  async function signOutOthers(server: Server, publishable: string, token: string): Promise<boolean> {
    for (const what of ['the sign-out of the other sessions', 'the sign-out of the other sessions, tried again,']) {
      const response = await callWithin(deps.fetch, `${server.url}/auth/v1/logout?scope=others`, { method: 'POST', headers: personHeaders(publishable, token) });
      const body: Json = response ? objectOf(await jsonOf(response)) : {};
      if (response && response.ok) return true;
      said(`reset: ${failure(what, response, body).why}`);
    }
    return false;
  }

  /**
   * The account an admin create with no answer may have made all the same: the login is signed in with,
   * and an account it signs in to, at an address nobody else has, is deleted again.
   */
  async function unmakeUnanswered(server: Server, publishable: string, login: Login): Promise<void> {
    const signed = await signIn(server, publishable, login);
    if ('failed' in signed) {
      said(`sign_up: no account found to delete after the admin create got no answer (${signed.why})`);
      return;
    }
    await unmake(server, signed.session.user_id);
  }

  /** The account a sign-up made, deleted again for good. */
  async function unmake(server: Server, id: string): Promise<void> {
    const response = await deleteAuthUser(deps.fetch, server, id);
    if (response) await jsonOf(response);
    if (response && (response.ok || response.status === 404)) said('sign_up: the account it made is deleted again');
    else said(`sign_up: the account it made could not be deleted (${response ? response.status : 'no answer'})`);
  }

  async function lookup(server: Server, fields: Fields, address: string): Promise<Response> {
    const data = await check(server, 'lookup', 'crew_lookup', { p_code: fields.code, p_address: address });
    if (!data) return tryAgain();
    if (data.status !== 'company') return refused('lookup', data);
    const { name, state } = data;
    if (typeof name !== 'string' || typeof state !== 'string') {
      said('lookup: crew_lookup answered a company this cannot read');
      return tryAgain();
    }
    said('lookup company');
    return answer(200, { status: 'company', name, state });
  }

  async function signUp(server: Server, publishable: string, fields: Fields, address: string): Promise<Response> {
    const data = await check(server, 'sign_up', 'crew_sign_up_check', {
      p_code: fields.code,
      p_first: fields.first_name,
      p_last: fields.last_name,
      p_passcode: fields.passcode,
      p_address: address,
    });
    if (!data) return tryAgain();
    if (data.status !== 'ok') return refused('sign_up', data);
    const login = loginOf(data);
    const company = companyOf(data);
    if (!login || !company || !HIDDEN_ADDRESS.test(login.email)) {
      said('sign_up: crew_sign_up_check answered a login this will not make');
      return tryAgain();
    }

    const made = await makeAccount(server, login);
    if ('failed' in made) {
      const reply = failed('sign_up', made);
      if (!made.answered) await unmakeUnanswered(server, publishable, login);
      return reply;
    }
    // From here on, whatever goes wrong deletes the account again before the answer goes.
    const undo = async (reply: Response): Promise<Response> => {
      await unmake(server, made.id);
      return reply;
    };

    const kept = await callFunction(deps.fetch, server, 'crew_keep_passcode', { p_user: made.id, p_passcode: fields.passcode }, keyHeaders(server.key));
    if (!kept.ok) {
      said(`sign_up: crew_keep_passcode answered ${kept.status}${codeOf(kept.code)}`);
      return undo(tryAgain());
    }
    const signed = await signIn(server, publishable, login);
    if ('failed' in signed) return undo(failed('sign_up', signed));
    if (signed.session.user_id !== made.id) {
      said('sign_up: the password grant signed in another account');
      return undo(tryAgain());
    }

    // Joining as the new account, with its own token, so every join rule applies to it unchanged.
    const joined = await callFunction(
      deps.fetch,
      server,
      'join_company',
      { code: fields.code, first_name: fields.first_name, last_name: fields.last_name },
      personHeaders(publishable, signed.session.access_token),
    );
    if (!joined.ok) {
      if (joined.code === '22023') {
        said('sign_up bad_name (join_company 22023)');
        return undo(answer(200, { status: 'bad_name', message: joined.message && joined.message.length <= 300 ? joined.message : NOT_THE_ROSTER_NAME }));
      }
      said(`sign_up: join_company answered ${joined.status}${codeOf(joined.code)}`);
      return undo(tryAgain());
    }
    const join = joinOf(joined.data);
    if (!join) {
      said('sign_up: join_company answered something this cannot read');
      return undo(tryAgain());
    }
    if (join.status === 'pending' && join.reason === 'already_claimed') {
      // Another sign-up holds the row the name is: this account would only be a stray.
      said('sign_up already_signed_up (join_company already_claimed)');
      return undo(answer(200, { status: 'already_signed_up' }));
    }
    if (JOIN_REFUSALS.includes(join.status)) {
      said(`sign_up ${join.status} (join_company)`);
      return undo(answer(200, { status: join.status }));
    }
    said(`sign_up signed_in (join_company ${join.status})`);
    return answer(200, { status: 'signed_in', session: signed.session, company, waiting: join.status === 'pending', join });
  }

  async function signInWith(server: Server, publishable: string, fields: Fields, address: string): Promise<Response> {
    const data = await check(server, 'sign_in', 'crew_sign_in_check', {
      p_code: fields.code,
      p_first: fields.first_name,
      p_last: fields.last_name,
      p_passcode: fields.passcode,
      p_address: address,
    });
    if (!data) return tryAgain();
    if (data.status !== 'ok') return refused('sign_in', data);
    const signed = await checkedLogin(server, publishable, data);
    if ('failed' in signed) return failed('sign_in', signed);
    said('sign_in signed_in');
    return answer(200, { status: 'signed_in', ...signed });
  }

  async function reset(server: Server, publishable: string, fields: Fields, address: string): Promise<Response> {
    const data = await check(server, 'reset', 'crew_reset_check', {
      p_code: fields.code,
      p_first: fields.first_name,
      p_last: fields.last_name,
      p_reset_code: fields.reset_code,
      p_new_passcode: fields.new_passcode,
      p_address: address,
    });
    if (!data) return tryAgain();
    if (data.status !== 'ok') return refused('reset', data);
    // The new passcode is kept from here on, and the code is spent: nothing below answers busy or
    // try_again, which would have the person try the code again. A sign-in that fails says the passcode
    // is changed, for the person to sign in with it.
    const signed = await checkedLogin(server, publishable, data);
    if ('failed' in signed) {
      said(`reset passcode_changed (${signed.why})`);
      return answer(200, { status: 'passcode_changed' });
    }
    // Whether or not the sign-out went through, the session goes back: when others_signed_out is false,
    // the app signs the other sessions out itself.
    const othersSignedOut = await signOutOthers(server, publishable, signed.session.access_token);
    said(othersSignedOut ? 'reset signed_in, the other sessions signed out' : 'reset signed_in, the other sessions still signed in');
    return answer(200, { status: 'signed_in', ...signed, others_signed_out: othersSignedOut });
  }

  async function confirm(server: Server, publishable: string, fields: Fields, request: Request): Promise<Response> {
    const token = bearerOf(request.headers.get('authorization'));
    if (!token) {
      said('confirm: signed_out (no token)');
      return answer(401, { error: 'signed_out', message: 'Sign in first.' });
    }
    const who = await whoseToken(deps.fetch, server, publishable, token);
    if (who.kind === 'gone') {
      said('confirm: already_deleted');
      return answer(410, { error: 'already_deleted', message: 'This sign-in is deleted already.' });
    }
    if (who.kind === 'signed_out') {
      said('confirm: signed_out');
      return answer(401, { error: 'signed_out', message: 'This sign-in is signed out. Sign in again.' });
    }
    if (who.kind === 'refused') {
      said(`confirm: auth turned the request down with no reason of its own (${who.status}): is the publishable key right?`);
      return notSetUp();
    }
    if (who.kind === 'no_answer') {
      said(who.status ? `confirm: auth answered ${who.status}` : 'confirm: auth could not be reached');
      return who.status === 429 ? answer(200, { status: 'busy' }) : tryAgain();
    }
    const data = await check(server, 'confirm', 'crew_confirm_check', { p_user: who.id, p_passcode: fields.passcode });
    if (!data) return tryAgain();
    if (data.status !== 'ok') return refused('confirm', data);
    const login = loginOf(data);
    if (!login) {
      said('confirm: crew_confirm_check answered a login this cannot read');
      return tryAgain();
    }
    const signed = await signIn(server, publishable, login);
    if ('failed' in signed) return failed('confirm', signed);
    if (signed.session.user_id !== who.id) {
      said('confirm: the password grant signed in another account');
      return tryAgain();
    }
    said('confirm signed_in');
    return answer(200, { status: 'signed_in', session: signed.session });
  }

  return async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== null) {
      said('origin_not_allowed');
      return answer(403, { error: 'origin_not_allowed', message: 'Sign in in the MineMuster app.' });
    }
    if (request.method !== 'POST') return answer(405, { error: 'method_not_allowed', message: 'Send POST.' }, { Allow: 'POST' });

    const text = await readCapped(request, MAX_BODY_BYTES);
    if (text === 'too_large') {
      said('too_large');
      return answer(413, { error: 'too_large', message: `The body is at most ${MAX_BODY_BYTES} bytes.` });
    }
    const ask = text === null ? null : readAsk(text);
    if (!ask) {
      said('bad_request');
      return answer(400, { error: 'bad_request', message: 'The body is { action, ... } with the fields that action takes, each of them text.' });
    }

    const server = serverFrom(deps.env);
    const publishable = publishableKeyFrom(deps.env);
    if (!server || !publishable) {
      said('not set up: SUPABASE_URL, the server key (SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY) or the publishable key (SUPABASE_PUBLISHABLE_KEYS or SUPABASE_ANON_KEY) is missing');
      return notSetUp();
    }

    const { action, fields } = ask;
    if (action === 'confirm') return confirm(server, publishable, fields, request);
    const address = clientAddress(request);
    if (action === 'lookup') return lookup(server, fields, address);
    if (action === 'sign_up') return signUp(server, publishable, fields, address);
    if (action === 'sign_in') return signInWith(server, publishable, fields, address);
    return reset(server, publishable, fields, address);
  };
}
