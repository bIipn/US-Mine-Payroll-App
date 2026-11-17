// What the stripe-webhook edge function does with a request, kept apart from
// Deno (index.ts) so the tests can run it under Node with a stand-in for the
// database.
//
//  1. POST only.
//  2. The Stripe-Signature header is read and its time checked before
//     anything else, so a request that is not from Stripe costs no call to the
//     database.
//  3. The signing secret is STRIPE_WEBHOOK_SECRET when that is set, or else
//     what stripe_webhook_secret() reads from Supabase Vault, kept for a minute.
//  4. The signature is checked on the raw body (verify.ts): 400 when it does
//     not match.
//  5. The event goes to apply_stripe_event with the server key, which applies
//     MineMuster's events and sets aside everyone else's. Its answer goes back
//     to Stripe with 200, for an event set aside too, so Stripe stops sending
//     it. 500 when the database cannot be reached or refuses, so Stripe tries
//     again later (for up to three days).
//
// The database is reached through PostgREST with fetch, at SUPABASE_URL. The
// server key is the "default" secret key in SUPABASE_SECRET_KEYS (sb_secret_...,
// sent as apikey only, as Supabase asks), or else the legacy
// SUPABASE_SERVICE_ROLE_KEY (a JWT, sent as apikey and as the bearer token).
// No secret, key or body is ever written to the log.

import { checkHeader, verifyStripeSignature } from './verify.ts';

export interface WebhookDeps {
  /** An environment variable, or undefined. */
  env: (name: string) => string | undefined;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** The clock, in milliseconds. */
  now?: () => number;
  log?: (message: string) => void;
}

/** How long a secret read from Vault is kept before it is read again. */
export const SECRET_TTL_MS = 60_000;
/** How long a call to the database may take before it counts as failed. */
export const DATABASE_TIMEOUT_MS = 15_000;

export interface Server {
  url: string;
  key: string;
}

/** The project's URL and server key from the environment, or null when either is missing. */
export function serverFrom(env: WebhookDeps['env']): Server | null {
  const url = (env('SUPABASE_URL') ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/.test(url)) return null;
  let key = '';
  const named = env('SUPABASE_SECRET_KEYS');
  if (named && named.trim()) {
    try {
      const keys: unknown = JSON.parse(named);
      const first = keys && typeof keys === 'object' ? (keys as Record<string, unknown>).default : undefined;
      if (typeof first === 'string') key = first.trim();
    } catch {
      // Not JSON: fall through to the legacy key.
    }
  }
  if (!key) key = (env('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  return key ? { url, key } : null;
}

/** The headers PostgREST takes the server key in: a secret key as apikey only, a legacy JWT as both. */
export function keyHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

type Called = { ok: true; data: unknown } | { ok: false; status: number; code?: string };

/** Call a database function through PostgREST with the server key. */
async function callFunction(deps: WebhookDeps, server: Server, name: string, args: Record<string, unknown>): Promise<Called> {
  let response: Response;
  try {
    response = await deps.fetch(`${server.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { ...keyHeaders(server.key), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  const text = await response.text().catch(() => '');
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const code = data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string' ? (data as { code: string }).code : undefined;
    return { ok: false, status: response.status, code };
  }
  return { ok: true, data };
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** The request handler, for Deno.serve. */
export function makeHandler(deps: WebhookDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  let kept: { secret: string; at: number } | null = null;

  async function signingSecret(server: Server): Promise<string | null> {
    const fromEnv = (deps.env('STRIPE_WEBHOOK_SECRET') ?? '').trim();
    if (fromEnv) return fromEnv;
    if (kept && now() - kept.at < SECRET_TTL_MS) return kept.secret;
    const read = await callFunction(deps, server, 'stripe_webhook_secret', {});
    if (!read.ok) {
      log(`stripe-webhook: reading the signing secret failed (${read.status}${read.code ? ` ${read.code}` : ''})`);
      return null;
    }
    const secret = typeof read.data === 'string' ? read.data.trim() : '';
    if (!secret) return null;
    kept = { secret, at: now() };
    return secret;
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return answer(405, { error: 'Send Stripe events with POST.' }, { Allow: 'POST' });

    const header = request.headers.get('stripe-signature');
    const seconds = Math.floor(now() / 1000);
    const timing = checkHeader(header, seconds);
    if (!timing.ok) return answer(400, { error: 'The Stripe signature is missing or not valid.', reason: timing.reason });

    const payload = new Uint8Array(await request.arrayBuffer());

    const server = serverFrom(deps.env);
    if (!server) {
      log('stripe-webhook: SUPABASE_URL or the server key is not set');
      return answer(500, { error: 'The webhook is not set up: the server key is missing.' });
    }
    const secret = await signingSecret(server);
    if (!secret) {
      log('stripe-webhook: no signing secret in STRIPE_WEBHOOK_SECRET or in Vault (stripe_webhook_secret)');
      return answer(500, { error: 'The webhook is not set up: the signing secret is missing.' });
    }

    const verdict = await verifyStripeSignature({ payload, header, secret, now: seconds });
    if (!verdict.ok) return answer(400, { error: 'The Stripe signature is missing or not valid.', reason: verdict.reason });

    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    } catch {
      return answer(400, { error: 'The body is not a JSON event.' });
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)
        || typeof (event as { id?: unknown }).id !== 'string' || typeof (event as { type?: unknown }).type !== 'string') {
      return answer(400, { error: 'The body is not a Stripe event.' });
    }

    const applied = await callFunction(deps, server, 'apply_stripe_event', { p_event: event });
    if (!applied.ok) {
      log(`stripe-webhook: apply_stripe_event failed (${applied.status}${applied.code ? ` ${applied.code}` : ''}) for ${(event as { type: string }).type}`);
      return answer(500, { error: 'The event could not be saved. Stripe will send it again.' });
    }
    return answer(200, applied.data ?? { applied: false });
  };
}
