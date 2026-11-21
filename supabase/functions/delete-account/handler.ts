// What the delete-account edge function does with a request, kept apart from Deno (index.ts) so the
// tests can run it under Node with a stand-in for Supabase Auth and the database.
//
// A person deletes their own MineMuster sign-in, from the app (More, then Delete my account) or from
// the office dashboard. Who is deleted comes only from Supabase Auth, by the token the request
// carries: nothing in the body can name an account.
//
//  1. OPTIONS is a browser's preflight, answered 204 for the office dashboard's origin alone. A
//     request from any other site's page is 403, before anything is asked; a phone sends no Origin.
//     Any method but POST is 405.
//  2. Without a bearer token: 401 signed_out.
//  3. The body is {} or { close: [{ company_id, name }] }, at most 20 companies and 16 KB: a body
//     said to be larger, or found larger while it is read, is 413 too_large, and no more of it is
//     read. Anything else, an account's id or email included, is 400 bad_request.
//  4. Supabase Auth says whose token it is (GET /auth/v1/user, with the publishable key). Its own
//     reason decides the answer when it says no: an account it no longer has (user_not_found, after
//     it has checked the token's signature) is 410 already_deleted; any other reason of its own (a
//     session signed out, a token expired or not one it signed) is 401 signed_out. Turned down with
//     no reason of Auth's, such as the gateway refusing the key, is 500 not_set_up.
//  5. The password was typed in the last ten minutes: the token's amr holds a password entry no older
//     than 600 seconds, or the answer is 403 password_needed. Supabase Auth writes the time of the
//     password sign-in that started the session there, and keeps it through every refresh, so the
//     app and the dashboard sign in with the password just before they call (checked against
//     Supabase Auth v2.198.0 on the private local scan stack). close_company asks the same itself.
//  6. account_deletion_check, with the person's own token: a company where they are the last
//     supervisor who can sign in, and that they are not closing, is 409 last_supervisor, with who
//     could take over and whether, or from when, they may close it. A company they ask to close has
//     to be one they may close now (can_close: nobody else could take over or come back to it) with
//     nothing being charged; otherwise 409 close_refused, before anything is closed.
//  7. close_company, with their own token, for each company asked: a refusal is 409 close_refused,
//     with the reason and the companies closed before it (403 password_needed for the password).
//  8. Supabase Auth's admin delete with the server key, a hard delete. When it does not say it went
//     through, Supabase Auth is asked again whose the token is: an account it no longer has was
//     deleted all the same (200). When Auth answered the delete and turned it down, nothing was
//     deleted: the last supervisor somewhere now (someone stepped down meanwhile, and the database's
//     guard refused it) is 409 last_supervisor, anything else 500 try_again, with what was closed.
//     When the delete got no answer, or only a gateway's, it may still go through: 504 not_known,
//     with what was closed.
//  9. 200 { deleted: true, closed: [...] }.
//
// It logs what happened as a code: never a token, a key, an email or an id.

import { keyHeaders, publishableKeyFrom, serverFrom, type Env, type Server } from '../_shared/server.ts';

export interface DeleteDeps {
  env: Env;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** The clock, in milliseconds. */
  now?: () => number;
  log?: (message: string) => void;
}

/** The office dashboard: the one web page that may call this from a browser. */
export const ALLOWED_ORIGIN = 'https://app.minemuster.com';
/** How long ago the password may have been typed, in seconds. */
export const PASSWORD_FRESH_SECONDS = 600;
/** How many companies one request may close. */
export const MAX_CLOSE = 20;
/** The largest body read, in bytes. */
export const MAX_BODY_BYTES = 16_384;
/** How long one call to Supabase Auth or the database may take before it counts as failed. */
export const CALL_TIMEOUT_MS = 15_000;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '3600',
  Vary: 'Origin',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Statuses a gateway gives when it did not hear from the service behind it: the request may still have been carried out. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

type Json = Record<string, unknown>;

interface CloseAsk {
  company_id: string;
  name: string;
}

interface Successor {
  roster_id: string;
  first_name: string;
  last_name: string;
}

interface Checked {
  id: string;
  name: string;
  role: 'employee' | 'supervisor';
  lastSupervisor: boolean;
  successors: Successor[];
  /** Nobody else could take over or come back: the caller may close it now. */
  canClose: boolean;
  /** When only people who left lately stop it: from when it may be closed. */
  closeFrom: string | null;
  running: number;
}

type Called = { ok: true; data: unknown } | { ok: false; status: number; code?: string; hint?: string };

/** What Supabase Auth says of a token. */
type Whose =
  | { kind: 'user'; id: string }
  /** Auth took the token's signature and has no such account: it was deleted. */
  | { kind: 'gone' }
  /** Auth turned the token down for a reason of its own: signed out, expired, or not one it signed. */
  | { kind: 'signed_out' }
  /** Turned down with no reason of Auth's, such as the gateway refusing the key. */
  | { kind: 'refused'; status: number }
  /** No answer, or one this cannot read. */
  | { kind: 'no_answer'; status: number };

/** The time of the latest password entry of a token's amr claim, in Unix seconds, or null for none. */
export function passwordTypedAt(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  let latest: number | null = null;
  for (const entry of amr) {
    if (!entry || typeof entry !== 'object') continue;
    const { method, timestamp } = entry as Json;
    if (method !== 'password' || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
    latest = latest === null ? timestamp : Math.max(latest, timestamp);
  }
  return latest;
}

/** A token's claims, read without checking its signature: only after Supabase Auth has taken that same token. */
function claimsOf(token: string): Json | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Json) : null;
  } catch {
    return null;
  }
}

function bearerOf(header: string | null): string | null {
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{1,8192})$/i.exec((header ?? '').trim());
  return match ? match[1] : null;
}

/**
 * The body as text, read no further than MAX_BODY_BYTES: 'too_large' when it is said to be larger, or
 * turns out larger while it is read, and null when it cannot be read as UTF-8.
 */
export async function readCapped(request: Request): Promise<string | 'too_large' | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) return null;
    if (Number(declared.trim()) > MAX_BODY_BYTES) return 'too_large';
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return 'too_large';
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The companies the body asks to close, or null when the body is anything but {} or { close: [...] }. */
function readBody(text: string): CloseAsk[] | null {
  if (!text.trim()) return [];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'close')) return null;
  const close = (body as Json).close;
  if (close === undefined) return [];
  if (!Array.isArray(close) || close.length > MAX_CLOSE) return null;
  const asks: CloseAsk[] = [];
  for (const entry of close) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const fields = Object.keys(entry);
    if (fields.length !== 2 || !fields.includes('company_id') || !fields.includes('name')) return null;
    const { company_id, name } = entry as Json;
    if (typeof company_id !== 'string' || !UUID.test(company_id) || typeof name !== 'string' || name.length > 400) return null;
    if (asks.some((ask) => ask.company_id.toLowerCase() === company_id.toLowerCase())) return null;
    asks.push({ company_id: company_id.toLowerCase(), name });
  }
  return asks;
}

/** account_deletion_check's answer, or null when it is not one. */
function readCheck(data: unknown): Checked[] | null {
  if (!Array.isArray(data)) return null;
  const out: Checked[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') return null;
    const { id, name, role, last_supervisor, successors, can_close, close_from, running } = row as Json;
    if (typeof id !== 'string' || typeof name !== 'string' || (role !== 'employee' && role !== 'supervisor') || typeof last_supervisor !== 'boolean') return null;
    if (!Array.isArray(successors) || typeof can_close !== 'boolean' || (close_from !== null && typeof close_from !== 'string')) return null;
    const people: Successor[] = [];
    for (const s of successors) {
      if (!s || typeof s !== 'object') return null;
      const { roster_id, first_name, last_name } = s as Json;
      if (typeof roster_id !== 'string' || typeof first_name !== 'string' || typeof last_name !== 'string') return null;
      people.push({ roster_id, first_name, last_name });
    }
    out.push({
      id: id.toLowerCase(),
      name,
      role,
      lastSupervisor: last_supervisor,
      successors: people,
      canClose: can_close,
      closeFrom: close_from,
      running: typeof running === 'number' ? running : 0,
    });
  }
  return out;
}

async function parsed(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const objectOf = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});

/** The request handler, for Deno.serve. */
export function makeHandler(deps: DeleteDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  /** A call to the database as the person, with their own token, through PostgREST. */
  async function asPerson(server: Server, publishable: string, token: string, name: string, args: Json): Promise<Called> {
    let response: Response;
    try {
      response = await deps.fetch(`${server.url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: publishable, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 0 };
    }
    const data = await parsed(response);
    if (!response.ok) {
      const body = objectOf(data);
      return {
        ok: false,
        status: response.status,
        code: typeof body.code === 'string' ? body.code : undefined,
        hint: typeof body.hint === 'string' ? body.hint : undefined,
      };
    }
    return { ok: true, data };
  }

  /** Whose the token is, by Supabase Auth, or why Auth says no. */
  async function whose(server: Server, publishable: string, token: string): Promise<Whose> {
    let response: Response;
    try {
      response = await deps.fetch(`${server.url}/auth/v1/user`, {
        method: 'GET',
        headers: { apikey: publishable, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      return { kind: 'no_answer', status: 0 };
    }
    const body = objectOf(await parsed(response));
    if (response.ok) return typeof body.id === 'string' ? { kind: 'user', id: body.id } : { kind: 'no_answer', status: response.status };
    if (response.status === 401 || response.status === 403) {
      if (body.error_code === 'user_not_found') return { kind: 'gone' };
      if (typeof body.error_code === 'string') return { kind: 'signed_out' };
      return { kind: 'refused', status: response.status };
    }
    return { kind: 'no_answer', status: response.status };
  }

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const fromDashboard = origin === ALLOWED_ORIGIN;
    const answer = (status: number, body: Json, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(fromDashboard ? CORS : {}), ...headers } });
    const said = (code: string) => log(`delete-account: ${code}`);

    if (origin && !fromDashboard) {
      said('origin_not_allowed');
      return answer(403, { error: 'origin_not_allowed', message: 'Delete your account in the MineMuster app or on the office dashboard.' });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return answer(405, { error: 'method_not_allowed', message: 'Send POST.' }, { Allow: 'POST, OPTIONS' });

    const token = bearerOf(request.headers.get('authorization'));
    if (!token) return answer(401, { error: 'signed_out', message: 'Sign in first.' });
    const text = await readCapped(request);
    if (text === 'too_large') {
      said('too_large');
      return answer(413, { error: 'too_large', message: `The body is at most ${MAX_BODY_BYTES} bytes.` });
    }
    const close = text === null ? null : readBody(text);
    if (!close) return answer(400, { error: 'bad_request', message: 'The body is {} or { close: [{ company_id, name }] }, and names no account.' });

    const server = serverFrom(deps.env);
    const publishable = publishableKeyFrom(deps.env);
    const notSetUp = () => answer(500, { error: 'not_set_up', message: 'Account deletion is not set up on this server yet.' });
    if (!server || !publishable) {
      said('not set up: SUPABASE_URL, the server key (SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY) or the publishable key (SUPABASE_PUBLISHABLE_KEYS or SUPABASE_ANON_KEY) is missing');
      return notSetUp();
    }
    const tryAgain = (closed: string[]) => answer(500, { error: 'try_again', message: 'The account could not be deleted just now. Try again in a few minutes.', closed });
    const signedOut = () => answer(401, { error: 'signed_out', message: 'This sign-in is signed out. Sign in again.' });
    const alreadyDeleted = () => answer(410, { error: 'already_deleted', message: 'This sign-in is deleted already.' });

    // 4. Whose token it is, from Supabase Auth.
    const who = await whose(server, publishable, token);
    if (who.kind === 'gone') {
      said('already_deleted');
      return alreadyDeleted();
    }
    if (who.kind === 'signed_out') {
      said('signed_out');
      return signedOut();
    }
    if (who.kind === 'refused') {
      said(`auth turned the request down with no reason of its own (${who.status}): is the publishable key right?`);
      return notSetUp();
    }
    if (who.kind === 'no_answer') {
      said(who.status ? `auth answered ${who.status}` : 'auth could not be reached');
      return tryAgain([]);
    }
    const userId = who.id;
    const claims = claimsOf(token);
    if (!claims || claims.sub !== userId) {
      said('signed_out');
      return signedOut();
    }

    // 5. The password, typed in the last ten minutes.
    const typed = passwordTypedAt(claims.amr);
    const seconds = Math.floor(now() / 1000);
    const passwordNeeded = () => answer(403, { error: 'password_needed', message: 'Enter your password again. It has to be typed within ten minutes of deleting.' });
    if (typed === null || seconds - typed > PASSWORD_FRESH_SECONDS || typed > seconds + 60) {
      said('password_needed');
      return passwordNeeded();
    }

    const check = async (): Promise<Checked[] | 'signed_out' | null> => {
      const called = await asPerson(server, publishable, token, 'account_deletion_check', {});
      if (!called.ok) return called.status === 401 ? 'signed_out' : null;
      return readCheck(called.data);
    };
    const lastSupervisor = (companies: Checked[]) =>
      answer(409, {
        error: 'last_supervisor',
        message: 'Someone has to take over as a supervisor first, or the company is closed.',
        companies: companies.map(({ id, name, successors, canClose, closeFrom, running }) => ({
          id,
          name,
          successors,
          can_close: canClose,
          close_from: closeFrom,
          running,
        })),
      });

    // 6. What deleting the account means in each of the person's companies.
    const companies = await check();
    if (companies === 'signed_out') {
      said('signed_out');
      return signedOut();
    }
    if (!companies) {
      said('the check could not be read');
      return tryAgain([]);
    }
    const refused = (companyId: string, reason: string, closed: string[], closeFrom: string | null = null) => {
      said(`close_refused ${reason}`);
      return answer(409, { error: 'close_refused', message: 'The company was not closed.', company_id: companyId, reason, close_from: closeFrom, closed });
    };
    for (const ask of close) {
      const company = companies.find((c) => c.id === ask.company_id);
      if (!company || company.role !== 'supervisor') return refused(ask.company_id, 'not_found', []);
      if (!company.canClose) return refused(ask.company_id, 'someone_can_take_over', [], company.closeFrom);
      if (company.running > 0) return refused(ask.company_id, 'subscription_running', []);
    }
    const blocking = companies.filter((c) => c.lastSupervisor && !close.some((ask) => ask.company_id === c.id));
    if (blocking.length) {
      said('last_supervisor');
      return lastSupervisor(blocking);
    }

    // 7. The companies nobody else can take over, closed.
    const closed: string[] = [];
    for (const ask of close) {
      const done = await asPerson(server, publishable, token, 'close_company', { p_company_id: ask.company_id, p_company_name: ask.name });
      if (!done.ok) {
        if (done.code === '42501' && done.hint === 'password_needed') {
          said('password_needed (close_company)');
          return passwordNeeded();
        }
        const reason =
          done.code === '22023' ? 'wrong_name' : done.code === 'PT409' && (done.hint === 'someone_can_take_over' || done.hint === 'subscription_running') ? done.hint : done.code === 'PT404' ? 'not_found' : null;
        if (reason) return refused(ask.company_id, reason, closed);
        said(`close_company answered ${done.status}${done.code ? ` ${done.code}` : ''}`);
        return tryAgain(closed);
      }
      closed.push(ask.company_id);
    }

    // 8. The account itself: Supabase Auth's admin delete, for good.
    let gone = false;
    /** Auth answered the delete itself and turned it down, so nothing was deleted. */
    let turnedDown = false;
    let failure = '';
    try {
      const response = await deps.fetch(`${server.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { ...keyHeaders(server.key), 'Content-Type': 'application/json' },
        body: JSON.stringify({ should_soft_delete: false }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      // Already gone (deleted from another phone a moment before) counts as deleted.
      gone = response.ok || response.status === 404;
      if (!gone) {
        const body = objectOf(await parsed(response));
        const fromAuth = typeof body.msg === 'string' || typeof body.error_code === 'string' || typeof body.message === 'string';
        turnedDown = !GATEWAY_STATUSES.has(response.status) && (response.status < 500 || fromAuth);
        failure = `${response.status}${typeof body.code === 'string' || typeof body.code === 'number' ? ` ${body.code}` : ''}`;
      }
    } catch {
      failure = 'no answer';
    }
    if (!gone) {
      const after = await whose(server, publishable, token);
      if (after.kind === 'gone') {
        said(`deleted (the delete answered ${failure}, and the account is gone)`);
        return answer(200, { deleted: true, closed });
      }
      if (!turnedDown) {
        said(`not_known (the delete answered ${failure})`);
        return answer(504, {
          error: 'not_known',
          message: 'The server did not say whether the account was deleted. Check again in a minute.',
          closed,
        });
      }
      const again = await check();
      if (Array.isArray(again) && again.some((c) => c.lastSupervisor)) {
        said('last_supervisor (refused by the database meanwhile)');
        return lastSupervisor(again.filter((c) => c.lastSupervisor));
      }
      said(`the admin delete failed (${failure})`);
      return tryAgain(closed);
    }
    said(closed.length ? `deleted, after closing ${closed.length} ${closed.length === 1 ? 'company' : 'companies'}` : 'deleted');
    return answer(200, { deleted: true, closed });
  };
}
