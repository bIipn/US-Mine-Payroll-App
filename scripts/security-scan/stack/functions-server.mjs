// Serves the stripe-webhook edge function on 127.0.0.1 from the repository's
// own handler.ts, under Node (which strips the types), in place of Supabase's
// edge runtime. The handler is the one that is deployed; what differs is the
// runtime around it: see README.md.
//
// The function reaches the database the way the deployed one does: through
// the gateway, with the secret key in apikey. It reads the signing secret from
// Vault (stripe_webhook_secret), since no STRIPE_WEBHOOK_SECRET is set.

import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GATEWAY_URL, HOST, PORTS, REPO, loadSecrets } from './lib.mjs';

const secrets = loadSecrets();
const { makeHandler } = await import(pathToFileURL(path.join(REPO, 'supabase/functions/stripe-webhook/handler.ts')).href);

const ENV = { SUPABASE_URL: GATEWAY_URL, SUPABASE_SECRET_KEYS: JSON.stringify({ default: secrets.secretKey }) };
const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

const FUNCTIONS = {
  'stripe-webhook': makeHandler({ env: (name) => ENV[name], fetch: (input, init) => fetch(input, init), log }),
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
      // A method fetch does not allow (TRACE, CONNECT). The handler takes POST alone.
      log(`${req.method} /${name} 405`);
      return answer(res, 405, { error: 'Send Stripe events with POST.' }, { allow: 'POST' });
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
server.listen(PORTS.functions, HOST, () => log(`functions listening on http://${HOST}:${PORTS.functions}`));
