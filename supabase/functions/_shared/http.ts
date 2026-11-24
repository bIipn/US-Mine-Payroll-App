// What MineMuster's edge functions share about the requests they take and the calls they make: a
// request's body, read no further than a limit, and its bearer token; the office dashboard's gate (its
// origin, the CORS headers of an answer to it, and the start of a request it sends), which delete-account
// and supervisor-tools both go through; and the calls to the database and to Supabase Auth, each of which
// counts as failed when it has no answer within CALL_TIMEOUT_MS. Supabase leaves a folder named _shared
// out of the functions it deploys, and bundles what a function imports from it. Nothing here writes a log
// but through the `said` a function hands it, as a code; codeOf picks out what of an answer a log may
// hold.

import { keyHeaders, type Server } from './server.ts';

/** fetch, as a function is given it. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

type Json = Record<string, unknown>;

/** How long one call to Supabase Auth or the database may take before it counts as failed. */
export const CALL_TIMEOUT_MS = 15_000;

/** The office dashboard: the one web page that may call MineMuster's edge functions from a browser. */
export const DASHBOARD_ORIGIN = 'https://app.minemuster.com';

/** The CORS headers of an answer to the dashboard, its preflight's included: POST, with the headers supabase-js sends. */
export const DASHBOARD_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': DASHBOARD_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '3600',
  Vary: 'Origin',
};

/** A code from an answer, for a log (Supabase Auth's error_code, the database's SQLSTATE), only when it looks like one. */
export const codeOf = (value: unknown): string => (typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? ` ${value}` : '');

/** A uuid, in either case. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An answer, before it is made a Response: its status, its JSON body, and any headers of its own. */
export interface Reply {
  status: number;
  body: Json;
  headers?: Record<string, string>;
}

/** A Reply made a Response: JSON, with the dashboard's CORS headers when the request came from the dashboard. */
export type Respond = (reply: Reply) => Response;

/**
 * The office dashboard's gate, for a function the dashboard calls from a browser. A request from any other
 * site's page (an Origin that is not the dashboard's) is 403 origin_not_allowed, in the function's own
 * words, and logged, before anything is asked; one with no Origin is no web page's, and goes on. A
 * browser's preflight (OPTIONS) is 204 with the CORS headers, and any other method but POST is 405. The
 * answer is that Response, or, for a request that goes on, the responder for all the function answers it.
 */
export function dashboardGate(request: Request, refusalWords: string, said: (code: string) => void): Response | Respond {
  const origin = request.headers.get('origin');
  const fromDashboard = origin === DASHBOARD_ORIGIN;
  const respond: Respond = ({ status, body, headers }) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(fromDashboard ? DASHBOARD_CORS : {}), ...headers } });
  if (origin && !fromDashboard) {
    said('origin_not_allowed');
    return respond({ status: 403, body: { error: 'origin_not_allowed', message: refusalWords } });
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: DASHBOARD_CORS });
  if (request.method !== 'POST') return respond({ status: 405, body: { error: 'method_not_allowed', message: 'Send POST.' }, headers: { Allow: 'POST, OPTIONS' } });
  return respond;
}

/**
 * The start of a request made with a person's token: the bearer token, then the body, read no further than
 * maxBytes. With no token it is 401 signed_out, and nothing is read; a body said to be larger, or found
 * larger while it is read, is 413 too_large, logged, and no more of it is read. Otherwise the token and the
 * body's text, null when it is not UTF-8 or its length is not a number, for the function to read.
 */
export async function tokenAndBody(request: Request, maxBytes: number, said: (code: string) => void): Promise<{ refused: Reply } | { token: string; text: string | null }> {
  const token = bearerOf(request.headers.get('authorization'));
  if (!token) return { refused: { status: 401, body: { error: 'signed_out', message: 'Sign in first.' } } };
  const text = await readCapped(request, maxBytes);
  if (text === 'too_large') {
    said('too_large');
    return { refused: { status: 413, body: { error: 'too_large', message: `The body is at most ${maxBytes} bytes.` } } };
  }
  return { token, text };
}

/**
 * A call that counts as failed once it has had no answer for CALL_TIMEOUT_MS: its response, or null when
 * it got none in time or could not be made. The time limit covers reading the response's body too.
 */
export async function callWithin(fetch: Fetch, url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/**
 * A request's body as text, read no further than maxBytes: 'too_large' when it is said to be larger, or
 * turns out larger while it is read, and null when it cannot be read as UTF-8.
 */
export async function readCapped(request: Request, maxBytes: number): Promise<string | 'too_large' | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) return null;
    if (Number(declared.trim()) > maxBytes) return 'too_large';
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
      if (size > maxBytes) {
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

/** The token of an Authorization header that is Bearer and a token, or null. */
export function bearerOf(header: string | null): string | null {
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{1,8192})$/i.exec((header ?? '').trim());
  return match ? match[1] : null;
}

/** A response's body as JSON, or null when it has none or it is not JSON. */
export async function jsonOf(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The value when it is a JSON object, or else an empty one. */
export const objectOf = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});

const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The headers of a call made as a person, with their own token: the publishable key and the token. */
export const personHeaders = (publishable: string, token: string): Record<string, string> => ({ apikey: publishable, Authorization: `Bearer ${token}` });

/** A database function's answer through PostgREST: its data, or the HTTP status and the database's code, hint and message. */
export type Called = { ok: true; data: unknown } | { ok: false; status: number; code?: string; hint?: string; message?: string };

/**
 * A database function called through PostgREST, with these key headers (keyHeaders for the server key,
 * personHeaders for a person's own token). Always by POST: PostgREST runs a GET in a read-only
 * transaction, where a function cannot write. Status 0 is no answer.
 */
export async function callFunction(fetch: Fetch, server: Server, name: string, args: Json, keys: Record<string, string>): Promise<Called> {
  const response = await callWithin(fetch, `${server.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...keys, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(args),
  });
  if (!response) return { ok: false, status: 0 };
  const data = await jsonOf(response);
  if (!response.ok) {
    const body = objectOf(data);
    return { ok: false, status: response.status, code: textOf(body.code), hint: textOf(body.hint), message: textOf(body.message) };
  }
  return { ok: true, data };
}

/** What Supabase Auth says of a token. */
export type Whose =
  | { kind: 'user'; id: string }
  /** Auth took the token's signature and has no such account: it was deleted. */
  | { kind: 'gone' }
  /** Auth turned the token down for a reason of its own: signed out, expired, or not one it signed. */
  | { kind: 'signed_out' }
  /** Turned down with no reason of Auth's, such as the gateway refusing the key. */
  | { kind: 'refused'; status: number }
  /** No answer, or one this cannot read. */
  | { kind: 'no_answer'; status: number };

/** Whose a token is, by Supabase Auth (GET /auth/v1/user, with the publishable key), or why Auth says no. */
export async function whoseToken(fetch: Fetch, server: Server, publishable: string, token: string): Promise<Whose> {
  const response = await callWithin(fetch, `${server.url}/auth/v1/user`, { method: 'GET', headers: personHeaders(publishable, token) });
  if (!response) return { kind: 'no_answer', status: 0 };
  const body = objectOf(await jsonOf(response));
  if (response.ok) return typeof body.id === 'string' ? { kind: 'user', id: body.id } : { kind: 'no_answer', status: response.status };
  if (response.status === 401 || response.status === 403) {
    if (body.error_code === 'user_not_found') return { kind: 'gone' };
    if (typeof body.error_code === 'string') return { kind: 'signed_out' };
    return { kind: 'refused', status: response.status };
  }
  return { kind: 'no_answer', status: response.status };
}

/** Supabase Auth's admin delete of an account, for good (a hard delete), with the server key: its response, or null for none. */
export function deleteAuthUser(fetch: Fetch, server: Server, id: string): Promise<Response | null> {
  return callWithin(fetch, `${server.url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...keyHeaders(server.key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ should_soft_delete: false }),
  });
}
