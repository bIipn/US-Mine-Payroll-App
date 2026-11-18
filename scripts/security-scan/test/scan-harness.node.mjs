// Tests for the pieces that keep a scan on this machine and keep secrets out of what the scanner
// is given: the scan guard, the writer of the scan inputs, the three configs, the rules that move
// the copies' live links, and what is read from the logs after a scan. They need nothing running
// and reach nothing outside this machine. Run them with: node --test "test/*.node.mjs"
//
// The name ends in .node.mjs and not in .test.mjs, so the app's jest does not pick it up.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { describeTableAnswers, guardSummary, guardVerdict, tableAnswers } from '../after-scan.mjs';
import { otherScannerStill } from '../one-at-a-time.mjs';
import { GUARD_URL, LOCAL_TARGETS, STACKHAWK_HOSTS, isLocalTarget, mayPass, startGuard, upstreamFrom } from '../egress-guard.mjs';
import { FUNCTION_INPUTS, TABLE_FILTERS, filtersOf, readEnvFile, writeScanInputs } from '../scan-inputs.mjs';
import { LINK_MOVES, NOT_IN_THE_COPY, isThisMachine, liveLinksIn, moveLinks, undoLinks } from '../sites/live.mjs';

const REPO = path.resolve(import.meta.dirname, '../../..');
const CONFIGS = ['stackhawk-api.yml', 'stackhawk-dashboard.yml', 'stackhawk-site.yml'];
/** A config without its comment lines. */
const configText = (config) => readFileSync(path.join(REPO, config), 'utf8').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

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

test('the list is StackHawk and its results store, and nothing of MineMuster, Supabase, Stripe or Vercel', () => {
  // The engine uploads each finding's evidence and the scan's results to StackHawk's bucket on S3
  // (scan-results.prod.stackhawk.com, reached at the regional S3 host). Without it the scan runs but
  // StackHawk is never sent what it found.
  assert.deepEqual(STACKHAWK_HOSTS, ['api.stackhawk.com', 'auth.stackhawk.com', 'download.stackhawk.com', 's3.us-west-2.amazonaws.com']);
  for (const host of STACKHAWK_HOSTS) assert.doesNotMatch(host, /minemuster|supabase|stripe|vercel/);
});

test('on this machine only the three scan targets may pass, named exactly', () => {
  assert.deepEqual(LOCAL_TARGETS, ['127.0.0.1:54321', '127.0.0.1:4443', '127.0.0.1:4444']);
  for (const target of LOCAL_TARGETS) assert.equal(isLocalTarget(target, LOCAL_TARGETS), true);
  for (const target of ['127.0.0.1:54322', '127.0.0.1:54331', '127.0.0.1:4480', 'localhost:54321', '127.0.0.2:4443', '127.0.0.1:4443 ', '127.0.0.1', undefined]) {
    assert.equal(isLocalTarget(target, LOCAL_TARGETS), false, String(target));
  }
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

let target;
let targetPort;
before(async () => {
  // A stand-in for a scan target on this machine: it echoes, with its own mark.
  target = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (chunk) => socket.write(`target:${chunk}`));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  targetPort = target.address().port;
});

after(() => {
  guard.close();
  guard.closeAllConnections();
  upstream.close();
  target.close();
  rmSync(logDir, { recursive: true, force: true });
});

/** Sends raw bytes to the guard and gives back everything it answered within a moment. */
function raw(lines, thenSend, port = guardPort) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
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

test('a tunnel to a scan target on this machine is made directly, never through the machine\'s proxy, and no other port passes', async () => {
  const localLog = path.join(logDir, 'local.jsonl');
  const second = await startGuard({ port: 0, allowed: ['api.stackhawk.com'], locals: [`127.0.0.1:${targetPort}`], upstream: { host: '127.0.0.1', port: upstream.address().port }, logFile: localLog });
  try {
    const before = tunnelsAsked.length;
    const got = await raw(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`, 'hello', second.address().port);
    assert.match(got, /^HTTP\/1\.1 200 /);
    assert.match(got, /target:hello$/);
    for (const other of [`127.0.0.1:${upstream.address().port}`, '127.0.0.1:54322', `localhost:${targetPort}`]) {
      assert.match(await raw(`CONNECT ${other} HTTP/1.1\r\nHost: ${other}\r\n\r\n`, null, second.address().port), /^HTTP\/1\.1 403 /, other);
    }
    assert.equal(tunnelsAsked.length, before, 'a local tunnel reached the machine\'s proxy');
    const lines = readFileSync(localLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.filter((l) => l.verdict === 'allowed').map((l) => [l.target, l.local]), [[`127.0.0.1:${targetPort}`, true]]);
  } finally {
    second.close();
    second.closeAllConnections();
  }
});

// ---- The three configs --------------------------------------------------------------------------

test('every config sends the scanning engine through the guard, and scans this machine', () => {
  assert.equal(GUARD_URL, 'http://127.0.0.1:4480');
  for (const config of CONFIGS) {
    // Both of the engine's ways out: its sign-in and platform client, and its scanning client.
    assert.match(configText(config), /\nhawk:\n(?:  .*\n)*  outboundProxy:\n    host: \$\{SCAN_OUTBOUND_PROXY\}\n/, `${config} has no hawk.outboundProxy.host`);
    assert.match(configText(config), /\n  config:\n    - network\.connection\.httpProxy\.enabled=true\n    - network\.connection\.httpProxy\.host=\$\{SCAN_GUARD_HOST\}\n    - network\.connection\.httpProxy\.port=\$\{SCAN_GUARD_PORT\}\n/, `${config} does not send the scanning client through the guard`);
    assert.match(configText(config), /host: \$\{APP_HOST:https:\/\/127\.0\.0\.1:\d+\}/, `${config} must scan this machine`);
  }
});

test('the server config keeps the key and the tokens out of the evidence, and cannot run without its profile mode', () => {
  const text = configText('stackhawk-api.yml');
  assert.match(text, /  redact:\n    headers:\n      - apikey\n      - Authorization\n/);
  assert.match(text, /    sessionVerification:\n      disabled: false\n/);
  // No default, so a run that does not set the scanner's own variables stops before it starts.
  assert.match(text, /- name: profile_scan_mode\n    value: \$\{PROFILE_SCAN_MODE\}\n/);
  assert.match(text, /- name: full_scan_profile\n    value: \$\{FULL_SCAN_PROFILE\}\n/);
  for (const config of ['stackhawk-dashboard.yml', 'stackhawk-site.yml']) assert.doesNotMatch(configText(config), /PROFILE_SCAN_MODE|FULL_SCAN_PROFILE/);
});

test('the server config gives no table filter a customVariables value, and its function values agree with the description', () => {
  // The scanner leaves customVariables out of query parameters, so a table filter's value is the
  // description's default (see the inputs test). An entry here for a table would read as covering
  // the table when it does not.
  const text = configText('stackhawk-api.yml');
  const custom = text.slice(text.indexOf('customVariables:'), text.indexOf('forbiddenVariables:'));
  const entries = [...custom.matchAll(/- field: (\w+)\n\s+path: "([^"]+)"/g)].map(([, field, pathPattern]) => ({ field, path: new RegExp(pathPattern) }));
  const tables = ['companies', 'roster', 'records', 'record_history', 'join_requests', 'notifications', 'billing_subscriptions', 'billing_overrides'];
  for (const table of tables) assert.equal(entries.filter((e) => e.path.test(`/rest/v1/${table}`)).length, 0, table);
  // Each function entry names inputs the description gives a value to.
  for (const entry of entries) {
    const functions = Object.keys(FUNCTION_INPUTS).filter((name) => entry.path.test(`/rest/v1/rpc/${name}`));
    assert.ok(functions.length > 0, `${entry.field} names no function the scan gives values to`);
    for (const name of functions) assert.ok(entry.field in FUNCTION_INPUTS[name], `${name} has no ${entry.field}`);
  }
  assert.deepEqual(Object.keys(TABLE_FILTERS).sort(), ['companies', 'roster']);
});

// ---- The copies' links ----------------------------------------------------------------------------

test('every live link is moved onto a copy, and moved back exactly', () => {
  const page = [
    '<a href="https://app.minemuster.com/?start=trial">Start free trial</a>',
    '<a href="https://app.minemuster.com">Sign in</a> <link rel="canonical" href="https://minemuster.com/pricing">',
    '<a href="https://billing.stripe.com/p/login/abc">Billing</a> <a href="https://stripe.com">Stripe</a>',
    'const TRIAL = "https://buy.stripe.com/xyz"; // prose: app.minemuster.com and minemuster.com/demo stay',
  ].join('\n');
  const { text, moved } = moveLinks(page);
  assert.deepEqual(liveLinksIn(text), []);
  assert.match(text, /href="https:\/\/127\.0\.0\.1:4444\/\?start=trial"/);
  assert.match(text, /href="https:\/\/127\.0\.0\.1:4443\/pricing"/);
  assert.ok(text.includes(`${NOT_IN_THE_COPY}/billing.stripe.com/p/login/abc`));
  assert.ok(text.includes(`${NOT_IN_THE_COPY}/buy.stripe.com/xyz`));
  assert.ok(text.includes('prose: app.minemuster.com and minemuster.com/demo stay'));
  assert.deepEqual(moved, { 'https://app.minemuster.com': 2, 'https://minemuster.com': 1, 'https://billing.stripe.com': 1, 'https://buy.stripe.com': 1, 'https://stripe.com': 1 });
  assert.equal(undoLinks(text), page);
  for (const [, local] of LINK_MOVES) assert.match(local, /^https:\/\/127\.0\.0\.1:444[34](\/|$)/);
});

test('a live link that is not moved is found, however it is written', () => {
  for (const link of ['https://www.minemuster.com/x', 'http://minemuster.com', '//app.minemuster.com/a', 'https:\\/\\/dashboard.stripe.com', 'https://connect.stripe.com/']) {
    assert.notDeepEqual(liveLinksIn(`see ${link} here`), [], link);
  }
  assert.deepEqual(liveLinksIn('write to us at minemuster.com/contact, or hello@minemuster.com'), []);
});

test('only an address of this machine, or of none, counts as unreachable', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1']) assert.equal(isThisMachine(address), true, address);
  for (const address of ['10.0.0.1', '104.18.1.1', '::ffff:8.8.8.8', '2606:4700::1']) assert.equal(isThisMachine(address), false, address);
});

// ---- After a scan ---------------------------------------------------------------------------------

test('table answers tell the recorded reads from the description\'s', () => {
  const lines = [
    '2026-11-18T21:00:00.000Z GET /rest/v1/roster?select=id,company_id&company_id=eq.a 200 rest',
    '2026-11-18T21:00:00.001Z GET /rest/v1/roster?company_id=eq.a 200 rest',
    '2026-11-18T21:00:00.002Z GET /rest/v1/roster?company_id=eq.a%27 400 rest',
    '2026-11-18T21:00:00.003Z PATCH /rest/v1/roster?id=eq.b 204 rest',
    '2026-11-18T21:00:00.004Z GET /rest/v1/rpc/my_companies 200 rest',
    '2026-11-18T21:00:00.005Z GET /rest/v1/records?select=*&company_id=eq.a 200 rest',
    '2026-11-18T21:00:00.006Z POST /auth/v1/token?grant_type=password 200 auth',
  ];
  const found = tableAnswers(lines);
  assert.deepEqual(Object.keys(found).sort(), ['GET /rest/v1/records', 'GET /rest/v1/roster', 'PATCH /rest/v1/roster']);
  assert.deepEqual(found['GET /rest/v1/roster'], { requests: 3, ok: 2, okFromTheDescription: 1, byStatus: { 200: 2, 400: 1 } });
  assert.equal(found['GET /rest/v1/records'].okFromTheDescription, 0);
  assert.match(describeTableAnswers(found).verdict, /both reached the tables/);
  assert.match(describeTableAnswers(tableAnswers([lines[0], lines[5]])).verdict, /Only the recorded requests/);
  assert.match(describeTableAnswers(tableAnswers([lines[2]])).verdict, /were not scanned/);
  assert.match(describeTableAnswers({}).verdict, /were not scanned/);
});

test('the guard\'s log is read into what it passed outside, on this machine, and refused', () => {
  const lines = [
    { verdict: 'allowed', method: 'CONNECT', target: 'api.stackhawk.com:443' },
    { verdict: 'allowed', method: 'CONNECT', target: '127.0.0.1:54321', local: true },
    { verdict: 'allowed', method: 'CONNECT', target: '127.0.0.1:54321', local: true },
    { verdict: 'refused', method: 'CONNECT', target: 'accounts.google.com:443' },
  ].map((entry) => JSON.stringify(entry));
  assert.deepEqual(guardSummary([...lines, 'not json']), { outside: ['api.stackhawk.com:443'], local: ['127.0.0.1:54321'], localTunnels: 2, refused: ['accounts.google.com:443'], failed: [] });
});

test('a scan that sent nothing to the scan targets through the guard is called out as having gone around it', () => {
  const none = { outside: ['api.stackhawk.com:443'], local: [], localTunnels: 0, refused: [], failed: [] };
  assert.equal(guardVerdict(none).ok, false);
  assert.match(guardVerdict(none).line, /went around the guard/);
  const some = { outside: ['api.stackhawk.com:443'], local: ['127.0.0.1:4443'], localTunnels: 812, refused: ['accounts.google.com:443'], failed: [] };
  assert.equal(guardVerdict(some).ok, true);
  assert.match(guardVerdict(some).line, /812 tunnels/);
});

test('a scanner that is closing is waited for, and one that keeps running is named', async () => {
  const sleep = async () => {};
  // Closing: running on the first two looks, gone on the third.
  let looks = 0;
  assert.equal(await otherScannerStill(() => (++looks < 3 ? '4242' : ''), { tries: 10, sleep }), '');
  assert.equal(looks, 3);
  // Still running after every look: its process ids are given back.
  assert.equal(await otherScannerStill(() => '4242\n4343', { tries: 4, sleep }), '4242\n4343');
  // Nothing running: one look is enough.
  looks = 0;
  assert.equal(await otherScannerStill(() => { looks += 1; return ''; }, { tries: 10, sleep }), '');
  assert.equal(looks, 1);
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
    parameters: {
      select: { name: 'select', in: 'query', required: false, type: 'string' },
      limit: { name: 'limit', in: 'query', required: false, type: 'string' },
      preferCount: { name: 'Prefer', in: 'header', required: false, type: 'string', enum: ['count=none'] },
      'rowFilter.roster.id': { name: 'id', in: 'query', required: false, type: 'string' },
      'rowFilter.roster.company_id': { name: 'company_id', in: 'query', required: false, type: 'string' },
      'rowFilter.roster.first_name': { name: 'first_name', in: 'query', required: false, type: 'string' },
    },
    paths: {
      '/': { get: {} },
      '/roster': {
        get: { parameters: ['rowFilter.roster.id', 'rowFilter.roster.company_id', 'rowFilter.roster.first_name', 'select', 'limit', 'preferCount'].map((name) => ({ $ref: `#/parameters/${name}` })) },
        post: {},
        patch: { parameters: ['rowFilter.roster.id', 'rowFilter.roster.first_name'].map((name) => ({ $ref: `#/parameters/${name}` })) },
        delete: {},
      },
      '/rpc/my_companies': { get: {}, post: {} },
      '/rpc/company_billing': {
        get: { parameters: [{ format: 'uuid', in: 'query', name: 'p_company_id', required: true, type: 'string' }] },
        post: { parameters: [{ in: 'body', name: 'args', required: true, schema: { properties: { p_company_id: { format: 'uuid', type: 'string' } }, required: ['p_company_id'], type: 'object' } }] },
      },
    },
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
    const setByTheRun = new Set(['APP_ENV', 'APP_HOST', 'HAWK_AGENT', 'COMMIT_SHA', 'BRANCH_NAME', 'PROFILE_SCAN_MODE', 'FULL_SCAN_PROFILE']);
    for (const config of CONFIGS) {
      const text = configText(config);
      for (const [, name] of text.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)) {
        if (!setByTheRun.has(name)) assert.ok(name in vars, `${config} reads ${name}, which scan.env does not hold`);
      }
      // No config holds a key, a password or an id of its own.
      assert.doesNotMatch(text, /sb_(publishable|secret)_|whsec_|eyJ[A-Za-z0-9_-]{10,}|hawk\.[A-Za-z0-9]{10,}/, config);
    }
    assert.equal(vars.SCAN_OUTBOUND_PROXY, 'http://127.0.0.1:4480');
    assert.equal(`${vars.SCAN_GUARD_HOST}:${vars.SCAN_GUARD_PORT}`, '127.0.0.1:4480');

    const all = ['scan.env', 'openapi-scan.json', 'api-seed.har'].map((name) => readFileSync(path.join(made.folder, name), 'utf8')).join('\n');
    assert.ok(!all.includes(fixtures.keys.secret), 'the secret key was written');
    assert.ok(!all.includes(fixtures.stripe.webhookSecret), 'the webhook secret was written');
    assert.ok(!all.includes(fixtures.accounts.P1.password), 'an account no config uses was written');
    for (const name of ['scan.env', 'openapi-scan.json', 'api-seed.har']) assert.equal(statSync(path.join(made.folder, name)).mode & 0o077, 0, `${name} is readable by others`);

    const description = JSON.parse(readFileSync(path.join(made.folder, 'openapi-scan.json'), 'utf8'));
    assert.equal(description.basePath, '/');
    assert.deepEqual(Object.keys(description.paths), ['/rest/v1/', '/rest/v1/roster', '/rest/v1/rpc/my_companies', '/rest/v1/rpc/company_billing', '/functions/v1/stripe-webhook']);
    assert.equal(made.pairs.length, 10);
    // A table read keeps only the filters it has values for, written into the description as
    // each filter's default (the scanner uses a default, and ignores customVariables for a query
    // parameter), and the Prefer header. A write keeps everything, so a made-up filter still turns
    // it down.
    const A = fixtures.companies.A;
    const shown = (parameter) => (parameter.$ref ? parameter.$ref.replace('#/parameters/', '') : `${parameter.name}=${parameter.default}`);
    assert.deepEqual(description.paths['/rest/v1/roster'].get.parameters.map(shown), [`id=eq.${A.roster.A3.rosterId}`, `company_id=eq.${A.id}`, 'preferCount']);
    assert.deepEqual(description.paths['/rest/v1/roster'].patch.parameters.map(shown), ['rowFilter.roster.id', 'rowFilter.roster.first_name']);
    // A function's inputs get the made-up values the scan is meant to use, in the query and in the body.
    assert.equal(description.paths['/rest/v1/rpc/company_billing'].get.parameters[0].default, A.id);
    assert.equal(description.paths['/rest/v1/rpc/company_billing'].post.parameters[0].schema.properties.p_company_id.default, A.id);

    // Every recorded request goes to the local server, and the only roster row named is the
    // one nobody holds.
    const har = JSON.parse(readFileSync(path.join(made.folder, 'api-seed.har'), 'utf8'));
    for (const entry of har.log.entries) assert.equal(new URL(entry.request.url).origin, 'https://127.0.0.1:54321');
    // A comma in a recorded request is written as it is: the scanner encodes a "%2C" a second
    // time, and PostgREST then reads the list of columns as one name it does not know.
    const rosterRead = har.log.entries.find((entry) => entry.request.method === 'GET' && new URL(entry.request.url).pathname === '/rest/v1/roster');
    assert.match(rosterRead.request.url, /select=id,company_id,/);
    for (const entry of har.log.entries) assert.doesNotMatch(entry.request.url, /%2C/i);
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
