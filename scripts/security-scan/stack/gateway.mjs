// The local stand-in for Supabase's API gateway: one HTTPS listener on
// 127.0.0.1 that sends /rest/v1 to PostgREST, /auth/v1 to Supabase Auth and
// /functions/v1 to the edge function, and checks the project's key first.
//
// It follows two things Supabase publishes: its API key guide (what a
// publishable and a secret key may do), and the gateway configuration of its
// self-hosted stack (docker/volumes/api/envoy/lds.template.yaml), which that
// stack's documentation says matches the platform. Where the two do not say
// what the hosted gateway does, README.md lists it under "What is not known".
// Nothing live was looked at to write this.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { GATEWAY_URL, HOST, PORTS, loadSecrets, paths, signJwt } from './lib.mjs';

const secrets = loadSecrets();
const files = paths();

/**
 * Response headers of the hosted gateway that could not be checked without a
 * request to the live project, which this job never makes. HSTS is believed to
 * be sent on every answer of a project's address. One `curl -sI` of the live
 * project by its owner settles it; change this list to match.
 */
const PLATFORM_HEADERS = { 'strict-transport-security': 'max-age=31536000; includeSubDomains; preload' };

/** The gateway's CORS policy, as the self-hosted configuration sets it. */
const CORS = { methods: 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD,CONNECT,TRACE', headers: '*', expose: '*', maxAge: '3600' };

/** Routes, first match wins. `open` needs no key, `adminOnly` takes the secret key alone. */
const ROUTES = [
  { name: 'auth-open', prefix: '/auth/v1/verify', to: 'auth', rewrite: '/verify', open: true },
  { name: 'auth-open', prefix: '/auth/v1/callback', to: 'auth', rewrite: '/callback', open: true },
  { name: 'auth-open', prefix: '/auth/v1/authorize', to: 'auth', rewrite: '/authorize', open: true },
  { name: 'auth-open', prefix: '/auth/v1/.well-known/jwks.json', to: 'auth', rewrite: '/.well-known/jwks.json', open: true },
  { name: 'auth-open', prefix: '/.well-known/oauth-authorization-server', to: 'auth', open: true },
  { name: 'auth-open', prefix: '/sso/saml/acs', to: 'auth', open: true },
  { name: 'auth-open', prefix: '/sso/saml/metadata', to: 'auth', open: true },
  { name: 'functions', prefix: '/functions/v1/', to: 'functions', rewrite: '/', open: true, timeout: 150000 },
  { name: 'storage', prefix: '/storage/v1/', to: null, open: true },
  { name: 'auth', prefix: '/auth/v1/', to: 'auth', rewrite: '/' },
  { name: 'rest-openapi', exact: '/rest/v1/', to: 'rest', rewrite: '/', adminOnly: true },
  { name: 'rest', prefix: '/rest/v1/', to: 'rest', rewrite: '/' },
  { name: 'graphql', prefix: '/graphql/v1', to: 'rest', rewrite: '/rpc/graphql', add: { 'content-profile': 'graphql_public' } },
  { name: 'realtime', prefix: '/realtime/v1/', to: null },
];

const UPSTREAM = { auth: PORTS.auth, rest: PORTS.rest, functions: PORTS.functions };

// A key's role reaches the services as a short-lived token signed with the
// project's signing key. It never leaves this machine.
const kept = {};
function roleToken(role) {
  const now = Date.now();
  if (!kept[role] || kept[role].until < now) kept[role] = { token: signJwt(secrets, { role }, 600), until: now + 300000 };
  return kept[role].token;
}

function send(res, status, headers, body = '') {
  res.writeHead(status, { ...PLATFORM_HEADERS, ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const json = (res, status, value, headers = {}) => send(res, status, { 'content-type': 'application/json; charset=utf-8', ...headers }, JSON.stringify(value));

/** The answers Supabase's gateway gives for a key that is missing, unknown or misused. */
const REFUSALS = {
  missing: { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' },
  invalid: { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' },
  browser: {
    message: 'Forbidden use of secret API key in browser',
    hint: 'Secret API keys can only be used in a protected environment and should never be used in a browser. Delete this secret API key immediately if it was exposed publicly.',
  },
};

/** Resolve dot segments and close up slashes, as the gateway does before it matches a route. */
function normalise(rawPath) {
  const resolved = new URL(rawPath, 'http://gateway.invalid').pathname;
  return resolved.replace(/\/{2,}/g, '/');
}

function firstQueryValue(query, name) {
  for (const part of query.split('&')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at) === name && part.length > at + 1) {
      try {
        return decodeURIComponent(part.slice(at + 1));
      } catch {
        return part.slice(at + 1);
      }
    }
  }
  return null;
}

const withoutQueryKey = (query, name) => query.split('&').filter((part) => part && part.split('=')[0] !== name).join('&');

function log(req, status, route) {
  const shown = req.url.replace(/([?&]apikey=)[^&]*/g, '$1...');
  process.stdout.write(`${new Date().toISOString()} ${req.method} ${shown} ${status} ${route}\n`);
}

function onRequest(req, res) {
  const origin = req.headers.origin;
  const [rawPath, ...rest] = req.url.split('?');
  let query = rest.join('?');

  // Envoy turns these away before it routes anything.
  if (/%2f|%5c/i.test(rawPath) || Object.keys(req.headers).some((name) => name.includes('_'))) {
    log(req, 400, 'rejected');
    return send(res, 400, { 'content-type': 'text/plain' }, 'Bad Request');
  }
  let pathName;
  try {
    pathName = normalise(rawPath);
  } catch {
    log(req, 400, 'rejected');
    return send(res, 400, { 'content-type': 'text/plain' }, 'Bad Request');
  }

  const route = ROUTES.find((entry) => (entry.exact ? pathName === entry.exact : pathName.startsWith(entry.prefix)));
  if (!route) {
    log(req, 404, 'none');
    return json(res, 404, { error: 'requested path is invalid' });
  }
  const gatewayCors = route.name !== 'functions';
  const corsHeaders = gatewayCors && origin ? { 'access-control-allow-origin': origin, 'access-control-expose-headers': CORS.expose } : {};

  // A preflight is answered by the gateway itself, before any key is asked for.
  if (gatewayCors && req.method === 'OPTIONS' && origin && req.headers['access-control-request-method']) {
    log(req, 200, `${route.name} preflight`);
    return send(res, 200, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': CORS.methods,
      'access-control-allow-headers': CORS.headers,
      'access-control-max-age': CORS.maxAge,
    });
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  let apikey = typeof headers.apikey === 'string' ? headers.apikey : '';

  if (route.name === 'functions') {
    // The platform checks no key here; the function decides. A key that starts
    // with sb_ is still looked up, and its role handed on in sb-api-key.
    delete headers['sb-api-key'];
    const bearer = /^bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1] ?? '';
    const refuse = (message) => {
      log(req, 401, route.name);
      return send(res, 401, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }, message);
    };
    if (bearer.startsWith('sb_') && apikey && apikey !== bearer) return refuse('Conflicting API keys');
    const key = apikey || (bearer.startsWith('sb_') ? bearer : '');
    if (key.startsWith('sb_')) {
      if (key === secrets.secretKey) headers['sb-api-key'] = roleToken('service_role');
      else if (key === secrets.publishableKey) headers['sb-api-key'] = roleToken('anon');
      else return refuse('Invalid API key');
    }
  } else if (!route.open) {
    if (!apikey) apikey = firstQueryValue(query, 'apikey') ?? '';
    const role = apikey === secrets.publishableKey ? 'anon' : apikey === secrets.secretKey ? 'service_role' : null;
    const refuse = (status, body) => {
      log(req, status, route.name);
      return json(res, status, body, corsHeaders);
    };
    if (!apikey) return refuse(401, REFUSALS.missing);
    if (!role) return refuse(401, REFUSALS.invalid);
    if (role === 'service_role' && /mozilla\//i.test(headers['user-agent'] ?? '')) return refuse(401, REFUSALS.browser);
    if (route.adminOnly && role !== 'service_role') {
      log(req, 403, route.name);
      return send(res, 403, { 'content-type': 'text/plain', ...corsHeaders }, 'RBAC: access denied');
    }
    // A user's token goes on as it came. With none, or with the key itself
    // repeated in Authorization as supabase-js sends it, the key's role does.
    const authorization = headers.authorization ?? '';
    const userToken = authorization.startsWith('Bearer ') && !authorization.startsWith('Bearer sb_');
    const otherKey = authorization.startsWith('Bearer sb_') && authorization.slice(7) !== apikey;
    if (!userToken && !otherKey) headers.authorization = `Bearer ${roleToken(role)}`;
    delete headers.apikey;
    query = withoutQueryKey(query, 'apikey');
  }

  if (!route.to) {
    log(req, 404, `${route.name} (not run here)`);
    return json(res, 404, { message: 'This service is not part of the local stack.' }, corsHeaders);
  }

  const peer = (req.socket.remoteAddress ?? HOST).replace(/^::ffff:/, '');
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${peer}` : peer;
  headers['sb-forwarded-for'] = peer;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] ??= req.headers.host ?? `${HOST}:${PORTS.gateway}`;
  headers['x-forwarded-port'] ??= String(PORTS.gateway);
  if (route.rewrite !== undefined) headers['x-forwarded-prefix'] ??= route.prefix ?? route.exact;
  for (const [name, value] of Object.entries(route.add ?? {})) headers[name] ??= value;

  const matched = route.exact ?? route.prefix;
  const onward = route.rewrite === undefined ? pathName : `${route.rewrite}${pathName.slice(matched.length)}`;
  const target = `${onward.replace(/^\/{2,}/, '/')}${query ? `?${query}` : ''}`;

  const upstream = http.request({ host: HOST, port: UPSTREAM[route.to], method: req.method, path: target, headers }, (answer) => {
    const out = { ...answer.headers };
    delete out.connection;
    delete out['keep-alive'];
    // The hosted project is behind Cloudflare, which puts its own name in Server: the service's is not shown.
    delete out.server;
    log(req, answer.statusCode, route.name);
    res.writeHead(answer.statusCode, { ...out, ...PLATFORM_HEADERS, ...corsHeaders });
    answer.pipe(res);
  });
  upstream.setTimeout(route.timeout ?? 30000, () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (error) => {
    if (res.headersSent) return res.destroy();
    const timedOut = error.message === 'timeout';
    log(req, timedOut ? 504 : 503, route.name);
    return send(res, timedOut ? 504 : 503, { 'content-type': 'text/plain', ...corsHeaders }, timedOut ? 'upstream request timeout' : 'no healthy upstream');
  });
  req.pipe(upstream);
}

const server = https.createServer({ key: fs.readFileSync(files.key), cert: fs.readFileSync(files.cert), maxHeaderSize: 64 * 1024 }, (req, res) => {
  try {
    onRequest(req, res);
  } catch (error) {
    process.stdout.write(`${new Date().toISOString()} gateway error: ${error.message}\n`);
    if (!res.headersSent) send(res, 500, { 'content-type': 'text/plain' }, 'Internal Server Error');
  }
});
server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n'));
server.listen(PORTS.gateway, HOST, () => process.stdout.write(`${new Date().toISOString()} gateway listening on ${GATEWAY_URL}\n`));
