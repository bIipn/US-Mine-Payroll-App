// Tests for the local scan stack's stand-in gateway (stack/gateway.mjs): every answer it gives, its
// own and the services' it passes on, carries the two response headers the live gateway sends. They
// start it on a free port of 127.0.0.1 in front of a stand-in service, with keys made up at random for
// the test, and reach nothing else. Run them with: node --test "test/*.node.mjs"
//
// The name ends in .node.mjs and not in .test.mjs, so the app's jest does not pick it up.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';

import { BAD_REQUEST, PLATFORM_HEADERS, createGateway } from '../stack/gateway.mjs';

// What the live gateway sends on every answer, as its owner read it from the live project's headers.
const LIVE = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
};

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const secrets = {
  publishableKey: `sb_publishable_${randomBytes(16).toString('base64url')}`,
  secretKey: `sb_secret_${randomBytes(16).toString('base64url')}`,
  jwk: { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'ES256' },
};

let service; // stands in for PostgREST and the edge function
let gateway;
let port;
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

before(async () => {
  // It answers with headers of its own that the gateway must not let through as they are.
  service = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', server: 'postgrest/14.18', 'x-content-type-options': 'sniff', 'strict-transport-security': 'max-age=0' });
      res.end(JSON.stringify({ path: req.url }));
    });
  });
  const servicePort = await listen(service);
  // A port nothing listens on any more, for a service that is down.
  const probe = net.createServer();
  const down = await listen(probe);
  await close(probe);

  gateway = createGateway({ secrets, upstream: { rest: servicePort, functions: servicePort, auth: down }, say: () => {} });
  port = await listen(gateway);
});

after(async () => {
  await close(gateway);
  await close(service);
});

/** One request to the gateway. Resolves to the status and the headers as they came, each name once per line. */
function ask(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, raw: response.rawHeaders, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

/** The answer carries each of the live gateway's headers once, with the live value. */
function hasLiveHeaders(answer, what) {
  for (const [name, value] of Object.entries(LIVE)) {
    const sent = [];
    for (let i = 0; i < answer.raw.length; i += 2) if (answer.raw[i].toLowerCase() === name) sent.push(answer.raw[i + 1]);
    assert.deepEqual(sent, [value], `${what}: ${name}`);
  }
}

describe('the stand-in gateway', () => {
  it('lists the live gateway\'s two headers, with the live values', () => {
    assert.deepEqual(PLATFORM_HEADERS, LIVE);
  });

  it('sends them on every answer it makes itself', async () => {
    const key = { apikey: secrets.publishableKey };
    const cases = [
      ['no key', 'GET', '/rest/v1/companies', {}, 401],
      ['a key it does not know', 'GET', '/rest/v1/companies', { apikey: 'sb_publishable_not_a_key_of_this_test' }, 401],
      ['the secret key from a browser', 'GET', '/rest/v1/companies', { apikey: secrets.secretKey, 'user-agent': 'Mozilla/5.0' }, 401],
      ['PostgREST\'s description for the publishable key', 'GET', '/rest/v1/', key, 403],
      ['a path no route has', 'GET', '/nowhere', {}, 404],
      ['a service the stack does not run', 'GET', '/storage/v1/object/list', key, 404],
      ['a preflight', 'OPTIONS', '/rest/v1/companies', { origin: 'https://127.0.0.1:4443', 'access-control-request-method': 'POST' }, 200],
      ['an escaped slash in the path', 'GET', '/rest/v1/a%2fb', key, 400],
      ['a header name with an underscore', 'GET', '/rest/v1/companies', { ...key, x_odd: '1' }, 400],
      ['a key on the functions route it does not know', 'POST', '/functions/v1/stripe-webhook', { apikey: 'sb_secret_not_a_key_of_this_test' }, 401],
      ['a service that is down', 'GET', '/auth/v1/settings', key, 503],
    ];
    for (const [what, method, path, headers, status] of cases) {
      const answer = await ask(method, path, headers);
      assert.equal(answer.status, status, `${what}: ${answer.text}`);
      hasLiveHeaders(answer, what);
    }
  });

  it('sends them on every answer it passes on, in place of the service\'s own, and takes away the service\'s name', async () => {
    for (const [what, method, path, headers, body] of [
      ['a table', 'GET', '/rest/v1/companies?select=id', { apikey: secrets.publishableKey }, undefined],
      ['a function', 'POST', '/rest/v1/rpc/company_billing', { apikey: secrets.publishableKey, 'content-type': 'application/json' }, '{}'],
      ['the edge function', 'POST', '/functions/v1/stripe-webhook', { 'content-type': 'application/json' }, '{}'],
    ]) {
      const answer = await ask(method, path, headers, body);
      assert.equal(answer.status, 200, `${what}: ${answer.text}`);
      hasLiveHeaders(answer, what);
      assert.equal(answer.headers.server, undefined, what);
    }
  });

  it('sends them on the answer to a request it cannot parse', async () => {
    const text = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('NOT A REQUEST\r\n\r\n'));
      const chunks = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
      socket.on('error', reject);
    });
    assert.equal(text, BAD_REQUEST);
    const [statusLine, ...lines] = text.split('\r\n\r\n')[0].split('\r\n');
    assert.equal(statusLine, 'HTTP/1.1 400 Bad Request');
    const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
    for (const [name, value] of Object.entries(LIVE)) assert.equal(headers[name], value, name);
  });
});
