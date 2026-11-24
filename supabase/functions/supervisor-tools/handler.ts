// What the supervisor-tools edge function does with a request, kept apart from Deno (index.ts) so the tests
// can run it under Node with stand-ins for Supabase Auth and the database.
//
// On the office dashboard's Roster page a supervisor invites another supervisor by email onto a roster row,
// sends an invitation again, or deletes a crew member's passcode sign-in. Each needs Supabase Auth's admin
// API, and so the server key, which the browser never holds. Who may do what is the database's to say
// (migrations 20261122000100 and 20261122000200): its function runs as the supervisor, with their own
// token, and only once it has said yes does this function call Supabase Auth.
//
//  1. The office dashboard's gate (dashboardGate in ../_shared/http.ts, which delete-account goes through
//     too): OPTIONS is a browser's preflight, answered 204 for the dashboard's origin alone. A request from
//     any other site's page is 403 origin_not_allowed, before anything is asked; one with no Origin is no
//     web page's, and goes on. Any method but POST is 405.
//  2. Without a bearer token: 401 signed_out, unlogged, as delete-account answers one (tokenAndBody).
//  3. The body is JSON: { action: 'invite', roster_id, email }, { action: 'resend', invitation_id } or
//     { action: 'delete_crew_sign_in', roster_id }, every field text, each id a uuid, and no other field.
//     A body said to be larger than 16 KB (delete-account's limit, the other function the dashboard
//     calls), or found larger while it is read, is 413 too_large, and no more of it is read; any other is
//     400 bad_request.
//  4. Supabase Auth says whose the token is (GET /auth/v1/user, with the publishable key), so that a
//     session signed out cannot act while its token has yet to expire: any reason of Auth's own to say no
//     (an account it no longer has, a session signed out, a token expired or not one it signed) is 401
//     signed_out; one with no reason of Auth's, such as the gateway refusing the key, is 500 not_set_up;
//     no answer is 500 try_again.
//  5. invite calls invite_supervisor, and resend resend_supervisor_invitation, as the supervisor. Once
//     the database has made or renewed the invitation, account_for_email, with the server key, says
//     whether the address has an account and whether Supabase Auth has confirmed it. Only for an address
//     with no account, or one not confirmed, is Auth asked to send its invite email: POST /auth/v1/invite
//     with the server key, a body of the address as the database keeps it and data: { company_name }, and
//     the dashboard's invite link as redirect_to in the query, where Auth reads it. Auth makes the account
//     of a new address, sends again to one not confirmed, and refuses one that is (internal/api/invite.go,
//     the same at v2.198.0 and on 17 November 2026). A confirmed account is never sent one: its invitation
//     waits on the dashboard until it signs in. Either way, and whatever Auth answers, the answer is 200
//     { status: 'sent' }, so that it never tells whether an address has an account: a failure is logged
//     by its code, the invitation stays, and Send again sends it once more.
//  6. delete_crew_sign_in calls crew_sign_in_to_delete, as the supervisor, for the passcode account on
//     the row, then Supabase Auth's admin delete with the server key: a hard delete, which ends the
//     account's sessions. The row and every record stay with the company, the link to the account
//     cleared, and the person can sign up for the row again. 200 { status: 'deleted' }, also for an
//     account Auth no longer has; any other answer of the delete, or none, is 500 try_again.
//  7. The database's refusals: PT404 is 404 not_found, in the same words whether the row or the
//     invitation is not there or is of a company the caller does not supervise; PT409 is 409 with its
//     hint as the error (row_taken, invitation_closed, not_a_passcode_account); 42501, and a token
//     PostgREST turns down, are 401 signed_out; 22023 (an address that is not one) is 400 bad_request;
//     anything else is 500 try_again. Missing settings are 500 not_set_up, before anything is asked.
//
// Every answer but sent, deleted and a preflight's carries error, a code, and message, plain words. It logs
// what happened as a code: never an email, a name, a token, a key or an id.

import { keyHeaders, settingsFrom, type Env, type Server } from '../_shared/server.ts';
import {
  callFunction,
  callWithin,
  codeOf,
  dashboardGate,
  DASHBOARD_ORIGIN,
  deleteAuthUser,
  jsonOf,
  objectOf,
  personHeaders,
  tokenAndBody,
  UUID,
  whoseToken,
  type Called,
  type Fetch,
  type Reply,
} from '../_shared/http.ts';

export interface SupervisorDeps {
  env: Env;
  fetch: Fetch;
  log?: (message: string) => void;
}

/** The office dashboard: the one web page that may call this from a browser. */
export const ALLOWED_ORIGIN = DASHBOARD_ORIGIN;
/** Where the invite email's link lands: the dashboard, which reads the link, signs the person in and shows the invitation. */
export const INVITE_LINK = `${DASHBOARD_ORIGIN}/?invited=1`;
/** The largest body read, in bytes. */
export const MAX_BODY_BYTES = 16_384;

type Json = Record<string, unknown>;
type Action = 'invite' | 'resend' | 'delete_crew_sign_in';
type Fields = Record<string, string>;
/** A database function's refusal, or no answer from it. */
type Refused = Extract<Called, { ok: false }>;

/** The fields each action takes, every one of them text. */
const FIELDS: Record<Action, readonly string[]> = {
  invite: ['roster_id', 'email'],
  resend: ['invitation_id'],
  delete_crew_sign_in: ['roster_id'],
};
/** The fields that are ids, and so uuids. */
const IDS = new Set(['roster_id', 'invitation_id']);

/** The database function each action calls as the supervisor. */
const FUNCTIONS: Record<Action, string> = {
  invite: 'invite_supervisor',
  resend: 'resend_supervisor_invitation',
  delete_crew_sign_in: 'crew_sign_in_to_delete',
};

/** Each action's words for PT404: the same whether the row or invitation is not there or is not the caller's. */
const NOT_FOUND: Record<Action, string> = {
  invite: 'No such roster row.',
  resend: 'No such invitation.',
  delete_crew_sign_in: 'No such roster row.',
};

const ROW_TAKEN = 'That roster row is taken off the roster, or held by an email sign-in.';
/** The hints of each action's PT409 refusals, answered 409 with the hint as the error, and their words. */
const CONFLICTS: Record<Action, Readonly<Record<string, string>>> = {
  invite: { row_taken: ROW_TAKEN },
  resend: { invitation_closed: 'That invitation has expired, or was cancelled or accepted.', row_taken: ROW_TAKEN },
  delete_crew_sign_in: { not_a_passcode_account: 'That roster row has no passcode sign-in.' },
};

const BODY_WORDS = 'The body is { action, ... } with the fields that action takes, each of them text and each id a uuid.';
const EMAIL_WORDS = 'Type the email address to send the invitation to.';

const reply = (status: number, body: Json): Reply => ({ status, body });

const SENT = reply(200, { status: 'sent' });
const DELETED = reply(200, { status: 'deleted' });
const NOT_SET_UP = reply(500, { error: 'not_set_up', message: 'Supervisor tools are not set up on this server yet.' });
const TRY_AGAIN = reply(500, { error: 'try_again', message: 'That did not go through just now. Try again in a few minutes.' });
const SIGNED_OUT = reply(401, { error: 'signed_out', message: 'This sign-in is signed out. Sign in again.' });

/** The action and its fields, or null when the body is not one action with exactly the fields it takes, each of them text and each id a uuid. */
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
  if (Object.keys(fields).length !== wanted.length) return null;
  for (const key of wanted) {
    const value = fields[key];
    if (typeof value !== 'string' || (IDS.has(key) && !UUID.test(value))) return null;
  }
  return { action: action as Action, fields: fields as Fields };
}

/** The address and the company's name the database gives an invitation's email, or null when its answer is not one this can read. */
function invitationOf(data: unknown): { email: string; companyName: string } | null {
  const { email, company_name } = objectOf(data);
  return typeof email === 'string' && email !== '' && typeof company_name === 'string' ? { email, companyName: company_name } : null;
}

/** What account_for_email says of an address: no account, one not confirmed, or one confirmed; null when its answer is not one this can read. */
function accountOf(data: unknown): 'none' | 'unconfirmed' | 'confirmed' | null {
  if (!Array.isArray(data)) return null;
  const confirmed = data.map((row) => objectOf(row).confirmed);
  if (!confirmed.every((value) => typeof value === 'boolean')) return null;
  if (confirmed.length === 0) return 'none';
  return confirmed.includes(true) ? 'confirmed' : 'unconfirmed';
}

/** The request handler, for Deno.serve. */
export function makeHandler(deps: SupervisorDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const said = (code: string) => log(`supervisor-tools: ${code}`);

  /** An action's database function, called as the supervisor, with their own token. */
  const asSupervisor = (server: Server, publishable: string, token: string, action: Action, args: Json): Promise<Called> =>
    callFunction(deps.fetch, server, FUNCTIONS[action], args, personHeaders(publishable, token));

  /** The database's refusal of an action, answered as the project answers one. */
  function refused(action: Action, called: Refused): Reply {
    const { status, code, hint } = called;
    if (status === 401 || code === '42501') {
      said(`${action} signed_out (${FUNCTIONS[action]} answered ${status}${codeOf(code)})`);
      return SIGNED_OUT;
    }
    if (code === 'PT404') {
      said(`${action} not_found`);
      return reply(404, { error: 'not_found', message: NOT_FOUND[action] });
    }
    if (code === 'PT409' && hint !== undefined && Object.hasOwn(CONFLICTS[action], hint)) {
      said(`${action} ${hint}`);
      return reply(409, { error: hint, message: CONFLICTS[action][hint] });
    }
    if (code === '22023') {
      said(`${action} bad_request (22023${codeOf(hint)})`);
      return reply(400, { error: 'bad_request', message: action === 'invite' ? EMAIL_WORDS : BODY_WORDS });
    }
    said(`${action}: ${FUNCTIONS[action]} ${status ? `answered ${status}${codeOf(code)}${codeOf(hint)}` : 'got no answer'}`);
    return TRY_AGAIN;
  }

  /**
   * An invitation made or renewed, as the supervisor, then its email: Supabase Auth is asked to send one
   * only to an address with no account, or one not confirmed. Once the database has said yes, the answer
   * is sent, whatever happens after.
   */
  async function inviteWith(server: Server, publishable: string, token: string, action: 'invite' | 'resend', args: Json): Promise<Reply> {
    const called = await asSupervisor(server, publishable, token, action, args);
    if (!called.ok) return refused(action, called);
    const invitation = invitationOf(called.data);
    if (!invitation) {
      said(`${action}: ${FUNCTIONS[action]} answered something this cannot read`);
      return TRY_AGAIN;
    }

    const found = await callFunction(deps.fetch, server, 'account_for_email', { p_email: invitation.email }, keyHeaders(server.key));
    const account = found.ok ? accountOf(found.data) : null;
    if (account === null) {
      const why = found.ok ? 'answered something this cannot read' : found.status ? `answered ${found.status}${codeOf(found.code)}` : 'got no answer';
      said(`${action} sent, with no invite email: account_for_email ${why}`);
      return SENT;
    }
    if (account === 'confirmed') {
      said(`${action} sent, with no invite email: the address's account is confirmed, and the invitation waits on the dashboard`);
      return SENT;
    }

    const query = new URLSearchParams({ redirect_to: INVITE_LINK });
    const response = await callWithin(deps.fetch, `${server.url}/auth/v1/invite?${query}`, {
      method: 'POST',
      headers: { ...keyHeaders(server.key), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: invitation.email, data: { company_name: invitation.companyName } }),
    });
    const body: Json = response ? objectOf(await jsonOf(response)) : {};
    if (!response) said(`${action} sent, but the invite email got no answer`);
    else if (!response.ok) said(`${action} sent, but the invite email answered ${response.status}${codeOf(body.error_code)}`);
    else said(`${action} sent, with the invite email, to an address with ${account === 'none' ? 'no account' : 'an account not confirmed'}`);
    return SENT;
  }

  /** The passcode account on a roster row, found as the supervisor, deleted with Supabase Auth's admin API. */
  async function deleteCrewSignIn(server: Server, publishable: string, token: string, fields: Fields): Promise<Reply> {
    const called = await asSupervisor(server, publishable, token, 'delete_crew_sign_in', { p_roster_id: fields.roster_id });
    if (!called.ok) return refused('delete_crew_sign_in', called);
    const account = called.data;
    if (typeof account !== 'string' || !UUID.test(account)) {
      said('delete_crew_sign_in: crew_sign_in_to_delete answered something this cannot read');
      return TRY_AGAIN;
    }
    const response = await deleteAuthUser(deps.fetch, server, account);
    const body: Json = response ? objectOf(await jsonOf(response)) : {};
    if (response?.ok) {
      said('delete_crew_sign_in deleted');
      return DELETED;
    }
    // Deleted meanwhile (the person deleted it in the app a moment before): the sign-in is gone all the same.
    if (response?.status === 404 && body.error_code === 'user_not_found') {
      said('delete_crew_sign_in deleted (Supabase Auth had no such account any more)');
      return DELETED;
    }
    said(`delete_crew_sign_in: the admin delete ${response ? `answered ${response.status}${codeOf(body.error_code)}` : 'got no answer'}`);
    return TRY_AGAIN;
  }

  /** What a request asks, answered, once it has come through the dashboard's gate. */
  async function handle(request: Request): Promise<Reply> {
    const asked = await tokenAndBody(request, MAX_BODY_BYTES, said);
    if ('refused' in asked) return asked.refused;
    const { token, text } = asked;
    const ask = text === null ? null : readAsk(text);
    if (!ask) {
      said('bad_request');
      return reply(400, { error: 'bad_request', message: BODY_WORDS });
    }

    const settings = settingsFrom(deps.env, said);
    if (!settings) return NOT_SET_UP;
    const { server, publishable } = settings;

    const { action, fields } = ask;
    const who = await whoseToken(deps.fetch, server, publishable, token);
    if (who.kind === 'gone' || who.kind === 'signed_out') {
      said(`${action} signed_out (${who.kind === 'gone' ? 'Supabase Auth has no such account' : 'Supabase Auth turned the token down'})`);
      return SIGNED_OUT;
    }
    if (who.kind === 'refused') {
      said(`${action}: auth turned the request down with no reason of its own (${who.status}): is the publishable key right?`);
      return NOT_SET_UP;
    }
    if (who.kind === 'no_answer') {
      said(`${action}: ${who.status ? `auth answered ${who.status}` : 'auth could not be reached'}`);
      return TRY_AGAIN;
    }

    if (action === 'invite') return inviteWith(server, publishable, token, 'invite', { p_roster_id: fields.roster_id, p_email: fields.email });
    if (action === 'resend') return inviteWith(server, publishable, token, 'resend', { p_invitation_id: fields.invitation_id });
    return deleteCrewSignIn(server, publishable, token, fields);
  }

  return async (request: Request): Promise<Response> => {
    const gate = dashboardGate(request, 'Invite supervisors and delete crew sign-ins on the office dashboard.', said);
    if (gate instanceof Response) return gate;
    return gate(await handle(request));
  };
}
