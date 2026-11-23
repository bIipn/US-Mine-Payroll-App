// Serves MineMuster's edge functions on 127.0.0.1 from the repository's own
// handler.ts files, under Node (which strips the types), in place of
// Supabase's edge runtime: stripe-webhook, crew-auth, supervisor-tools and
// delete-account. Each handler is the one that is deployed; what differs is
// the runtime around it: see README.md.
//
// Each function is given the environment Supabase gives every edge function,
// made from the stack's own secrets (lib.mjs loadSecrets): SUPABASE_URL, here
// the gateway's address, SUPABASE_SECRET_KEYS and SUPABASE_PUBLISHABLE_KEYS
// (supabase/functions/_shared/server.ts reads them). So each reaches the
// database and Supabase Auth the way the deployed one does: through the
// gateway, the server key in apikey alone. stripe-webhook reads its signing
// secret from Vault (stripe_webhook_secret), since no STRIPE_WEBHOOK_SECRET is
// set.
//
// Every call a function makes to Supabase Auth is noted in run/auth-calls.jsonl,
// one line each: the function, the method, the path with any id taken out,
// the names of the query's parameters, and what Auth answered: its status, the
// shape of its body (each key and the type of its value, never a value) and its
// error_code (authCallNote in lib.mjs). Never a token, a key, an address, a
// password or an id. crew-e2e.mjs reads it to compare Auth's real answers with
// supabase/tests/stand-ins.mjs.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GATEWAY_URL, HOST, PORTS, REPO, authCallNote, loadSecrets, paths } from './lib.mjs';

const secrets = loadSecrets();
const AUTH_CALLS = path.join(paths().run, 'auth-calls.jsonl');

/** What Supabase gives every edge function, as the stack's own. */
const ENV = {
  SUPABASE_URL: GATEWAY_URL,
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: secrets.secretKey }),
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: secrets.publishableKey }),
};
const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

/** One call to Supabase Auth, noted without a token, a key, an address or an id (authCallNote). */
function noteAuthCall(fn, method, url, status, text) {
  const line = { at: new Date().toISOString(), fn, ...authCallNote(method, url, status, text) };
  fs.appendFileSync(AUTH_CALLS, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** fetch, as a function is given it, noting each call it makes to Supabase Auth. */
function watchedFetch(fn) {
  return async (input, init = {}) => {
    const url = String(input);
    const toAuth = new URL(url).pathname.startsWith('/auth/v1/');
    let response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      if (toAuth) noteAuthCall(fn, init.method ?? 'GET', url, 0, '');
      throw error;
    }
    if (toAuth) noteAuthCall(fn, init.method ?? 'GET', url, response.status, await response.clone().text().catch(() => ''));
    return response;
  };
}

const handlerOf = async (name) => {
  const { makeHandler } = await import(pathToFileURL(path.join(REPO, 'supabase/functions', name, 'handler.ts')).href);
  return makeHandler({ env: (key) => ENV[key], fetch: watchedFetch(name), log });
};

const FUNCTIONS = {
  'stripe-webhook': await handlerOf('stripe-webhook'),
  'crew-auth': await handlerOf('crew-auth'),
  'supervisor-tools': await handlerOf('supervisor-tools'),
  'delete-account': await handlerOf('delete-account'),
};

/**
 * What each function answers a method fetch cannot carry (TRACE, CONNECT), which never reaches it: the
 * answer its own handler gives any method but POST.
 */
const NOT_POST = {
  'stripe-webhook': [{ error: 'Send Stripe events with POST.' }, 'POST'],
  'crew-auth': [{ error: 'method_not_allowed', message: 'Send POST.' }, 'POST'],
  'supervisor-tools': [{ error: 'method_not_allowed', message: 'Send POST.' }, 'POST, OPTIONS'],
  'delete-account': [{ error: 'method_not_allowed', message: 'Send POST.' }, 'POST, OPTIONS'],
};

/** A body larger than this is cut off, so a scanner cannot fill this machine's memory. */
const MAX_BODY = 20 * 1024 * 1024;

function answer(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** What Supabase's router answers when no function has the name. */
const notFound = (res) => answer(res, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' }, {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey',
  'access-control-expose-headers': 'sb-error-code',
  'sb-error-code': 'NOT_FOUND',
});

const server = http.createServer(async (req, res) => {
  const name = (req.url ?? '/').split('?')[0].split('/')[1] ?? '';
  const handler = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : null;
  if (!handler) {
    log(`${req.method} /${name} 404`);
    return notFound(res);
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        log(`${req.method} /${name} 413`);
        return answer(res, 413, { error: 'The body is too large for the local stack.' });
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      // The gateway's token for the key's role is for the router alone.
      if (key !== 'sb-api-key' && value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const bodied = !['GET', 'HEAD'].includes(req.method);
    let request;
    try {
      request = new Request(`http://${HOST}:${PORTS.functions}${req.url}`, { method: req.method, headers, body: bodied ? Buffer.concat(chunks) : undefined });
    } catch {
      // A method fetch does not allow (TRACE, CONNECT). Every function takes POST alone.
      const [body, allow] = NOT_POST[name];
      log(`${req.method} /${name} 405`);
      return answer(res, 405, body, { allow });
    }
    const response = await handler(request);
    const body = Buffer.from(await response.arrayBuffer());
    log(`${req.method} /${name} ${response.status}`);
    res.writeHead(response.status, { ...Object.fromEntries(response.headers), 'content-length': body.length });
    return res.end(body);
  } catch (error) {
    log(`${req.method} /${name} failed: ${error.message}`);
    return answer(res, 500, { code: 'EDGE_FUNCTION_ERROR', message: 'Internal Server Error' }, { 'sb-error-code': 'EDGE_FUNCTION_ERROR' });
  }
});
server.listen(PORTS.functions, HOST, () => log(`functions listening on http://${HOST}:${PORTS.functions}: ${Object.keys(FUNCTIONS).join(', ')}`));
