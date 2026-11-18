// Tests for the two pieces that keep a scan on this machine and keep secrets out of what the
// scanner is given: the scan guard and the writer of the scan inputs. They need nothing running
// and reach nothing outside this machine. Run them with: node --test "test/*.node.mjs"
//
// The name ends in .node.mjs and not in .test.mjs, so the app's jest does not pick it up.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { STACKHAWK_HOSTS, mayPass, startGuard, upstreamFrom } from '../egress-guard.mjs';
import { readEnvFile, writeScanInputs } from '../scan-inputs.mjs';

// ---- The scan guard -----------------------------------------------------------------------------

test('only port 443 of a listed host may pass, and names are compared whole', () => {
  const allowed = ['api.stackhawk.com'];
  assert.equal(mayPass('api.stackhawk.com:443', allowed), true);
  assert.equal(mayPass('API.StackHawk.com:443', allowed), true);
  for (const target of [
    'api.stackhawk.com:80', 'api.stackhawk.com:8443', 'api.stackhawk.com', 'evil.api.stackhawk.com:443',
    'api.stackhawk.com.example.com:443', 'stackhawk.com:443', 'example.com:443', '127.0.0.1:443', '', undefined,
    'api.stackhawk.com:443/extra', 'api.stackhawk.com:443 ', 'user@api.stackhawk.com:443',
  ]) {
    assert.equal(mayPass(target, allowed), false, String(target));
  }
});

test('the list is StackHawk and nothing of MineMuster, Supabase or Stripe', () => {
  for (const host of STACKHAWK_HOSTS) assert.match(host, /^[a-z]+\.stackhawk\.com$/);
});

test('the machine\'s own proxy is read from the environment', () => {
  assert.deepEqual(upstreamFrom({ HTTPS_PROXY: 'http://127.0.0.1:41000' }), { host: '127.0.0.1', port: 41000 });
  assert.deepEqual(upstreamFrom({ https_proxy: 'http://proxy.example:3128' }), { host: 'proxy.example', port: 3128 });
  assert.equal(upstreamFrom({}), null);
});

let upstream;
let guard;
let guardPort;
const tunnelsAsked = [];
const logDir = mkdtempSync(path.join(os.tmpdir(), 'scan-guard-test-'));
const logFile = path.join(logDir, 'guard.jsonl');

before(async () => {
  // A stand-in for the machine's own proxy: it grants every tunnel and then echoes.
  upstream = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (first) => {
      tunnelsAsked.push(first.toString('latin1').split('\r\n')[0]);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('data', (chunk) => socket.write(`echo:${chunk}`));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  guard = await startGuard({ port: 0, allowed: ['api.stackhawk.com'], upstream: { host: '127.0.0.1', port: upstream.address().port }, logFile });
  guardPort = guard.address().port;
});

after(() => {
  guard.close();
  guard.closeAllConnections();
  upstream.close();
  rmSync(logDir, { recursive: true, force: true });
});

/** Sends raw bytes to the guard and gives back everything it answered within a moment. */
function raw(lines, thenSend) {
  return new Promise((resolve) => {
    const socket = net.connect(guardPort, '127.0.0.1');
    let got = '';
    let sent = false;
    socket.on('data', (chunk) => {
      got += chunk.toString('latin1');
      if (thenSend && !sent && got.includes('\r\n\r\n')) {
        sent = true;
        socket.write(thenSend);
      }
    });
    socket.on('error', () => resolve(got));
    socket.on('close', () => resolve(got));
    socket.on('connect', () => socket.write(lines));
    setTimeout(() => { socket.destroy(); resolve(got); }, 400);
  });
}

test('a tunnel to a listed host is passed on, and bytes flow both ways', async () => {
  const got = await raw('CONNECT api.stackhawk.com:443 HTTP/1.1\r\nHost: api.stackhawk.com:443\r\n\r\n', 'hello');
  assert.match(got, /^HTTP\/1\.1 200 /);
  assert.match(got, /echo:hello$/);
  assert.deepEqual(tunnelsAsked, ['CONNECT api.stackhawk.com:443 HTTP/1.1']);
});

test('a tunnel to any other host is refused here and never reaches the machine\'s proxy', async () => {
  const before = tunnelsAsked.length;
  for (const target of ['minemuster.example:443', 'api.stripe.com:443', 'abcdefghijklmnopqrst.supabase.co:443', 'api.stackhawk.com:22']) {
    const got = await raw(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    assert.match(got, /^HTTP\/1\.1 403 /, target);
  }
  assert.equal(tunnelsAsked.length, before);
});

test('a plain HTTP request is refused, whatever host it names', async () => {
  const before = tunnelsAsked.length;
  for (const url of ['http://api.stackhawk.com/', 'http://example.com/', '/']) {
    const got = await raw(`GET ${url} HTTP/1.1\r\nHost: api.stackhawk.com\r\nConnection: close\r\n\r\n`);
    assert.match(got, /^HTTP\/1\.1 403 /, url);
  }
  assert.equal(tunnelsAsked.length, before);
});

test('every request is one line in the log, with its verdict', () => {
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.filter((l) => l.verdict === 'allowed').length, 1);
  assert.equal(lines.filter((l) => l.verdict === 'refused').length, 7);
  assert.ok(lines.every((l) => typeof l.at === 'string' && typeof l.target === 'string'));
});

// ---- The scan inputs ----------------------------------------------------------------------------

/** A stack folder with made-up files of the shape the real stack writes. */
function madeUpStack() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'scan-inputs-test-'));
  const stack = path.join(home, 'stack');
  mkdirSync(stack);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const account = (n, name) => ({ id: id(n), email: `${name}@example.test`, password: `made-up-password-${n}` });
  const fixtures = {
    gatewayUrl: 'https://127.0.0.1:54321',
    keys: { publishable: 'made-up-publishable-key-for-the-test', secret: 'made-up-secret-key-that-must-never-be-written' },
    accounts: { A1: account(1, 'a1'), A2: account(2, 'a2'), B1: account(3, 'b1'), N1: account(4, 'n1'), P1: account(5, 'p1') },
    companies: {
      A: { id: id(10), name: 'Test Pit A', joinCode: 'AAAAAAAA', roster: { A3: { rosterId: id(13) } } },
      B: { id: id(20), name: 'Test Pit B', joinCode: 'BBBBBBBB', roster: { B1: { rosterId: id(21) } } },
    },
    pendingJoinRequest: { id: id(30) },
    stripe: { webhookSecret: 'made-up-webhook-secret-that-must-never-be-written' },
  };
  const rest = {
    swagger: '2.0',
    info: { title: 'made up', version: '1' },
    host: '127.0.0.1:54321',
    basePath: '/rest/v1',
    schemes: ['https'],
    paths: { '/': { get: {} }, '/roster': { get: {}, post: {}, patch: {}, delete: {} }, '/rpc/my_companies': { get: {}, post: {} } },
  };
  const webhook = {
    openapi: '3.0.3',
    servers: [{ url: 'https://127.0.0.1:54321/functions/v1' }],
    paths: { '/stripe-webhook': { post: { summary: 'Stripe events', parameters: [{ name: 'Stripe-Signature', in: 'header', schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'ok' }, 400: { description: 'refused' } } } } },
  };
  writeFileSync(path.join(stack, 'fixtures.json'), JSON.stringify(fixtures));
  writeFileSync(path.join(stack, 'openapi-authenticated.gateway.json'), JSON.stringify(rest));
  writeFileSync(path.join(stack, 'openapi-stripe-webhook.json'), JSON.stringify(webhook));
  return { home, stack, fixtures };
}

test('the inputs hold what the configs read, every path with its prefix, and no server secret', () => {
  const { home, fixtures } = madeUpStack();
  const stackFolder = process.env.MINEMUSTER_SCAN_STACK_DIR;
  delete process.env.MINEMUSTER_SCAN_STACK_DIR; // The stack is the one beside these inputs.
  try {
    const made = writeScanInputs({ home, appId: '11111111-2222-4333-8444-555555555555' });
    const vars = readEnvFile(made.envFile);

    // Every ${VAR} the three configs name is in scan.env, but the ones a run sets itself.
    const repo = path.resolve(import.meta.dirname, '../../..');
    const setByTheRun = new Set(['APP_ENV', 'APP_HOST', 'HAWK_AGENT', 'COMMIT_SHA', 'BRANCH_NAME']);
    for (const config of ['stackhawk-api.yml', 'stackhawk-dashboard.yml', 'stackhawk-site.yml']) {
      const text = readFileSync(path.join(repo, config), 'utf8').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
      for (const [, name] of text.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)) {
        if (!setByTheRun.has(name)) assert.ok(name in vars, `${config} reads ${name}, which scan.env does not hold`);
      }
      // No config holds a key, a password or an id of its own.
      assert.doesNotMatch(text, /sb_(publishable|secret)_|whsec_|eyJ[A-Za-z0-9_-]{10,}|hawk\.[A-Za-z0-9]{10,}/, config);
      assert.match(text, /host: \$\{APP_HOST:https:\/\/127\.0\.0\.1:\d+\}/, `${config} must scan this machine`);
    }

    const all = ['scan.env', 'openapi-scan.json', 'api-seed.har'].map((name) => readFileSync(path.join(made.folder, name), 'utf8')).join('\n');
    assert.ok(!all.includes(fixtures.keys.secret), 'the secret key was written');
    assert.ok(!all.includes(fixtures.stripe.webhookSecret), 'the webhook secret was written');
    assert.ok(!all.includes(fixtures.accounts.P1.password), 'an account no config uses was written');
    for (const name of ['scan.env', 'openapi-scan.json', 'api-seed.har']) assert.equal(statSync(path.join(made.folder, name)).mode & 0o077, 0, `${name} is readable by others`);

    const description = JSON.parse(readFileSync(path.join(made.folder, 'openapi-scan.json'), 'utf8'));
    assert.equal(description.basePath, '/');
    assert.deepEqual(Object.keys(description.paths), ['/rest/v1/', '/rest/v1/roster', '/rest/v1/rpc/my_companies', '/functions/v1/stripe-webhook']);
    assert.equal(made.pairs.length, 8);

    // Every recorded request goes to the local server, and the only roster row named is the
    // one nobody holds.
    const har = JSON.parse(readFileSync(path.join(made.folder, 'api-seed.har'), 'utf8'));
    for (const entry of har.log.entries) assert.equal(new URL(entry.request.url).origin, 'https://127.0.0.1:54321');
    assert.ok(!all.includes(fixtures.companies.B.roster.B1.rosterId) || vars.SCAN_ROSTER_B1 === fixtures.companies.B.roster.B1.rosterId);
    const contact = har.log.entries.find((entry) => entry.request.url.endsWith('/rpc/submit_contact_request'));
    assert.equal(JSON.parse(contact.request.postData.text).p_website, '', 'the hidden field must stay empty, or the function does nothing');

    // An application id given once is kept by the next run.
    assert.equal(readEnvFile(writeScanInputs({ home }).envFile).APP_ID, '11111111-2222-4333-8444-555555555555');
  } finally {
    if (stackFolder !== undefined) process.env.MINEMUSTER_SCAN_STACK_DIR = stackFolder;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stack that is not on this machine is refused', () => {
  const { home, stack, fixtures } = madeUpStack();
  const stackFolder = process.env.MINEMUSTER_SCAN_STACK_DIR;
  delete process.env.MINEMUSTER_SCAN_STACK_DIR;
  try {
    writeFileSync(path.join(stack, 'fixtures.json'), JSON.stringify({ ...fixtures, gatewayUrl: 'https://server.example' }));
    assert.throws(() => writeScanInputs({ home, appId: '11111111-2222-4333-8444-555555555555' }), /Nothing but the local server is ever scanned/);
  } finally {
    if (stackFolder !== undefined) process.env.MINEMUSTER_SCAN_STACK_DIR = stackFolder;
    rmSync(home, { recursive: true, force: true });
  }
});
