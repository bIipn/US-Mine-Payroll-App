#!/usr/bin/env node
// Puts the private scan copy of MineMuster together, checks that it is ready, and runs HawkScan
// against it the way a scan has to be run here. README.md beside this file is the guide.
//
//   node up.mjs [up] [--app-id <StackHawk application id>] [--no-stage]
//       starts the local stack and puts its data back to the seeded state, makes the copies of
//       the website and the dashboard against it, serves both, starts the scan guard, writes
//       what the three configs read, checks all of it and prints the addresses
//   node up.mjs status                      what is running
//   node up.mjs check                       the readiness checks alone
//   node up.mjs validate <api|dashboard|site>
//   node up.mjs scan <api|dashboard|site>
//   node up.mjs rescan <api|dashboard|site> <id of that surface's first full scan>
//   node up.mjs hawk -- <any hawk arguments>
//   node up.mjs stack -- <status|reset|...>  the local stack's own command (stack/README.md)
//   node up.mjs down [--stack]              stops the site servers and the guard, and the stack if asked
//
// Everything it makes goes in the private folder named by --home or MINEMUSTER_SCAN_DIR, which is
// never inside the repository: hawk is run from there, with its session files there too. Every
// address it starts or scans is on 127.0.0.1, and it runs no hawk command while a live host can be
// reached by name from this machine or while the scan guard is down.

import { spawn, spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeTableAnswers, guardSummary, guardVerdict, tableAnswers } from './after-scan.mjs';
import { otherScannerStill } from './one-at-a-time.mjs';
import { GUARD_HOST, GUARD_PORT, GUARD_URL, LOCAL_TARGETS, STACKHAWK_HOSTS } from './egress-guard.mjs';
import { inputsFolder, readEnvFile, writeScanInputs } from './scan-inputs.mjs';
import { DASHBOARD_PORT, HOST, LOCAL_SERVER, REPO, WEBSITE_PORT, homeFrom, layout, readArgs } from './sites/layout.mjs';
import { hostsThatMustNotResolve, isThisMachine, liveKeys, liveLinksIn } from './sites/live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE = `https://${HOST}:${WEBSITE_PORT}`;
const DASHBOARD = `https://${HOST}:${DASHBOARD_PORT}`;
const GUARD = `http://${GUARD_HOST}:${GUARD_PORT}`;

/**
 * The three surfaces, in the order they are scanned: the one with the most at stake first. The
 * server's profile mode is given both ways: the flags show in the command that run.txt keeps, and
 * the variables are what its config's tags read, so the scan's record says which mode it ran in.
 */
const SURFACES = {
  api: {
    config: 'stackhawk-api.yml', host: LOCAL_SERVER, env: 'Development-api', spec: true, auth: true,
    flags: ['--profile-scan-mode=primary-full', '--full-scan-profile=A1'],
    vars: { PROFILE_SCAN_MODE: 'primary-full', FULL_SCAN_PROFILE: 'A1' },
  },
  dashboard: { config: 'stackhawk-dashboard.yml', host: DASHBOARD, env: 'Development-dashboard', flags: [], vars: {}, spec: false, auth: false },
  site: { config: 'stackhawk-site.yml', host: WEBSITE, env: 'Development-site', flags: [], vars: {}, spec: false, auth: false },
};
const configPath = (surface) => path.join(REPO, surface.config);

const say = (text = '') => process.stdout.write(`${text}\n`);
const fail = (message) => { throw new Error(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- The command line ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const passAt = argv.indexOf('--');
const passed = passAt === -1 ? [] : argv.slice(passAt + 1);
const own = passAt === -1 ? argv : argv.slice(0, passAt);
const words = [];
while (own.length > 0 && !own[0].startsWith('--')) words.push(own.shift());
const [command = 'up', ...operands] = words;

let args;
let home;
let at;
let stackDir;
let runDir;
let sessionsDir;
let workDir;
function places() {
  args = readArgs(own);
  home = homeFrom(args);
  at = layout(home);
  stackDir = path.dirname(at.stackEnv);
  runDir = path.join(home, 'run');
  // hawk keeps a scan's working files, and for a while a copy of the StackHawk key, in its session
  // folder. Here that is a private folder, and the key's copies are taken away after each run.
  sessionsDir = path.join(home, 'hawk-sessions');
  // hawk writes some files into the folder it is run from (a SARIF report, for one). It is run from
  // here, never from the repository.
  workDir = path.join(inputsFolder(home), 'work');
  for (const folder of [runDir, sessionsDir, workDir]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
  }
}

// ---- Small tools --------------------------------------------------------------------------------

function nodeScript(script, scriptArgs, { env = {}, quiet = false } = {}) {
  const done = spawnSync(process.execPath, [path.join(HERE, script), ...scriptArgs], {
    cwd: HERE,
    env: { ...process.env, MINEMUSTER_SCAN_DIR: home, MINEMUSTER_SCAN_STACK_DIR: stackDir, ...env },
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
  });
  return { status: done.status, out: `${done.stdout ?? ''}${done.stderr ?? ''}` };
}

const stack = (stackArgs, options) => nodeScript('stack/stack.mjs', stackArgs, options);

function listening(port, host = HOST) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function waitUntil(what, test, seconds = 20) {
  const until = Date.now() + seconds * 1000;
  while (!(await test())) {
    if (Date.now() > until) fail(`${what} after ${seconds} seconds.`);
    await sleep(250);
  }
}

/** The node processes on this machine that are running one of this folder's scripts. */
function running(script) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return found; // Not Linux: the pid files are all there is to go by.
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const line = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
      if (path.basename(line[0] ?? '') === 'node' && (line[1] ?? '').endsWith(script)) found.push(Number(name));
    } catch {
      // The process ended while this was looking.
    }
  }
  return found;
}

const pidFile = (name) => path.join(runDir, `${name}.pid`);

function pidsOf(name, script) {
  const pids = new Set(running(script));
  if (existsSync(pidFile(name))) {
    const noted = Number(readFileSync(pidFile(name), 'utf8'));
    try {
      process.kill(noted, 0);
      // A pid file can outlive its process, and the number can be given to another program.
      if (running(script).includes(noted) || !existsSync('/proc')) pids.add(noted);
    } catch {
      // Gone already.
    }
  }
  return [...pids];
}

async function stopOld(name, script, ports) {
  for (const pid of pidsOf(name, script)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Gone already.
    }
  }
  rmSync(pidFile(name), { force: true });
  for (const port of ports) await waitUntil(`Port ${port} was still in use`, async () => !(await listening(port)), 10);
}

async function startDetached(name, script, scriptArgs, ports, env = {}) {
  await stopOld(name, script, ports);
  const logFile = path.join(runDir, `${name}.out`);
  const out = openSync(logFile, 'w', 0o600);
  const child = spawn(process.execPath, [path.join(HERE, script), ...scriptArgs], {
    cwd: HERE,
    env: { ...process.env, MINEMUSTER_SCAN_DIR: home, MINEMUSTER_SCAN_STACK_DIR: stackDir, ...env },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writeFileSync(pidFile(name), `${child.pid}\n`, { mode: 0o600 });
  for (const port of ports) {
    await waitUntil(`${name} was not listening on port ${port} (see ${logFile})`, () => listening(port), 20);
  }
  return child.pid;
}

/** One HTTPS request to a local address, trusting the stack's own certificate and no other. */
function ask(url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  if (target.hostname !== HOST) fail(`${url} is not on ${HOST}. Nothing else is ever asked.`);
  const ca = readFileSync(path.join(at.stackTls, 'cert.pem'));
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    const request = https.request(target, {
      method,
      ca,
      timeout: 15000,
      headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', (error) => resolve({ status: 0, headers: {}, text: error.message }));
    request.on('timeout', () => request.destroy(new Error('no answer in 15 seconds')));
    request.end(payload ?? undefined);
  });
}

/** A CONNECT through the guard: the status it answers with. */
function throughGuard(target) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: GUARD_PORT, host: GUARD_HOST, timeout: 20000 });
    let answer = '';
    socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on('data', (chunk) => {
      answer += chunk.toString('latin1');
      if (answer.includes('\r\n')) {
        socket.destroy();
        resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer)?.[1] ?? 0));
      }
    });
    socket.once('error', () => resolve(0));
    socket.once('timeout', () => { socket.destroy(); resolve(0); });
  });
}

/**
 * The live hosts this machine can reach by name, with the addresses they resolve to. None may: the
 * scan guard refuses them to everything sent through it, and this is what stops whatever is not.
 * A host that resolves only to this machine (a hosts-file block) is as good as none.
 */
async function liveHostsThatResolve() {
  const found = [];
  for (const host of hostsThatMustNotResolve()) {
    let addresses = [];
    try {
      addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      continue; // No answer, which is what is wanted.
    }
    const outside = addresses.filter((address) => !isThisMachine(address));
    if (outside.length > 0) found.push(`${host} (${outside.join(', ')})`);
  }
  return found;
}

async function needSafeNetwork() {
  const reachable = await liveHostsThatResolve();
  if (reachable.length > 0) {
    fail(`These live hosts can be reached by name from this machine: ${reachable.join('; ')}. No hawk command is run here until none can, because part of the scanner could reach them around the scan guard. Block them for the scan (a hosts-file line sending each to 0.0.0.0 will do), then try again.`);
  }
}

// ---- Ready or not -------------------------------------------------------------------------------

/**
 * The checks a scan depends on. They sign in, read, and call each writing function with values
 * it turns down, so they change nothing but the sign-in tables, which a reset puts back.
 */
async function readiness() {
  const results = [];
  const note = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
  const fixtures = JSON.parse(readFileSync(at.stackFixtures, 'utf8'));
  const inputs = readEnvFile(path.join(inputsFolder(home), 'scan.env'));
  const key = fixtures.keys.publishable;

  // The three addresses.
  const byCode = await ask(`${LOCAL_SERVER}/rest/v1/rpc/company_by_code?code=XXXXXXXX`, { headers: { apikey: key } });
  note('The local server answers', byCode.status === 200, `GET /rest/v1/rpc/company_by_code -> ${byCode.status}`);
  const sitePage = await ask(`${WEBSITE}/`);
  note('The website copy answers', sitePage.status === 200 && Boolean(sitePage.headers['content-security-policy']), `GET ${WEBSITE}/ -> ${sitePage.status}`);
  const dashPage = await ask(`${DASHBOARD}/`);
  note('The dashboard copy answers', dashPage.status === 200 && Boolean(dashPage.headers['content-security-policy']), `GET ${DASHBOARD}/ -> ${dashPage.status}`);

  // Both copies point at the local server and hold its key.
  const form = await ask(`${WEBSITE}/contact.js`);
  note('The website copy\'s contact form posts to the local server with its key', form.text.includes(LOCAL_SERVER) && form.text.includes(key), 'contact.js');
  const scripts = [...dashPage.text.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  let dashCode = '';
  for (const script of scripts) dashCode += (await ask(`${DASHBOARD}${script}`)).text;
  note('The dashboard copy calls the local server with its key', dashCode.includes(LOCAL_SERVER) && dashCode.includes(key), scripts.join(', ') || 'no script found');

  // Neither copy leads off this machine: no link to the live sites or to Stripe, and not the
  // live key, in what a crawl is served first (stage.mjs has checked every file already).
  const served = { [`${WEBSITE}/contact.js`]: form.text, [`${DASHBOARD}/`]: dashPage.text };
  for (const page of ['/', '/pricing', '/contact', '/security', '/privacy', '/terms', '/robots.txt', '/sitemap.xml', '/no-such-page']) served[`${WEBSITE}${page}`] = (await ask(`${WEBSITE}${page}`)).text;
  for (const script of scripts) {
    served[`${DASHBOARD}${script}`] = dashCode;
    served[`${DASHBOARD}${script}.map`] = (await ask(`${DASHBOARD}${script}.map`)).text;
  }
  const liveKey = liveKeys();
  const leads = Object.entries(served).flatMap(([url, text]) => [...liveLinksIn(text).map((link) => `${url}: ${link}`), ...(liveKey.some((k) => text.includes(k)) ? [`${url}: the live key`] : [])]);
  note('Neither copy links to the live sites or to Stripe, or holds the live key', leads.length === 0, leads.length === 0 ? `${Object.keys(served).length} answers read` : leads.slice(0, 5).join('; '));

  // The four accounts of the server config sign in, and the session check tells them from the key alone.
  const testPath = `${LOCAL_SERVER}/rest/v1/rpc/my_companies`;
  const keyAlone = await ask(testPath, { headers: { apikey: key } });
  note('The session check refuses the key alone', keyAlone.status === 401, `GET /rest/v1/rpc/my_companies -> ${keyAlone.status}`);
  let token = null;
  for (const who of ['A1', 'A2', 'B1', 'N1']) {
    const account = fixtures.accounts[who];
    const sameAsInputs = inputs[`SCAN_${who}_EMAIL`] === account.email && inputs[`SCAN_${who}_PASSWORD`] === account.password;
    const signIn = await ask(`${LOCAL_SERVER}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: key }, body: { email: account.email, password: account.password } });
    let access = null;
    try {
      access = JSON.parse(signIn.text).access_token ?? null;
    } catch {
      // Not JSON: the sign-in did not work.
    }
    const checked = access ? await ask(testPath, { headers: { apikey: key, Authorization: `Bearer ${access}` } }) : { status: 0 };
    note(`${who} signs in and passes the session check`, signIn.status === 200 && checked.status === 200 && sameAsInputs, `sign-in ${signIn.status}, session check ${checked.status}${sameAsInputs ? '' : ', and scan.env holds other credentials: run "up" again'}`);
    if (who === 'A1') token = access;
  }

  // The resolve check: every path of the description file, asked for the way the scanner builds
  // it (the host, then the path), must be answered by the server's own routing. A 404 there
  // means the path is wrong, or the description names arguments the function does not take.
  // The same path without its prefix must be a 404.
  const descriptionFile = inputs.OPENAPI_SCAN;
  if (descriptionFile && existsSync(descriptionFile) && token) {
    const description = JSON.parse(readFileSync(descriptionFile, 'utf8'));
    const signedIn = { apikey: key, Authorization: `Bearer ${token}` };
    // A function asked for without the arguments it needs is "not found" to PostgREST, so each
    // probe carries them. A function that reads is given the ids the scan gives it. A function
    // that writes is given values its own first check turns down, so the probe changes nothing:
    // an id no row has, an empty name, an empty list, and the contact form's hidden field
    // filled, which makes that function return at once.
    const known = { company_id: inputs.SCAN_COMPANY_A, p_company_id: inputs.SCAN_COMPANY_A, code: inputs.SCAN_CODE_B };
    const harmless = (name, schema) => {
      if (name === 'p_website') return 'filled';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (schema.type === 'boolean') return false;
      if (schema.format === 'jsonb' || schema.format === 'json') return [];
      return '';
    };
    const notFound = [];
    const statuses = {};
    const shadows = [];
    for (const [name, item] of Object.entries(description.paths)) {
      let answer;
      if (item.get) {
        const needed = (item.get.parameters ?? []).filter((p) => p.in === 'query' && p.required && known[p.name]);
        const query = /^\/rest\/v1\/[a-z_]+$/.test(name) ? '?limit=1' : needed.length > 0 ? `?${needed.map((p) => `${p.name}=${encodeURIComponent(known[p.name])}`).join('&')}` : '';
        answer = await ask(`${LOCAL_SERVER}${name}${query}`, { headers: signedIn });
      } else {
        const schema = (item.post?.parameters ?? []).find((p) => p.in === 'body' && p.name === 'args')?.schema;
        const body = Object.fromEntries(Object.entries(schema?.properties ?? {}).map(([arg, shape]) => [arg, harmless(arg, shape)]));
        answer = await ask(`${LOCAL_SERVER}${name}`, { method: 'POST', headers: signedIn, body });
      }
      statuses[answer.status] = (statuses[answer.status] ?? 0) + 1;
      if (answer.status === 404 || answer.status === 0) notFound.push(`${name} -> ${answer.status}`);
      const bare = name.replace(/^\/(rest|functions)\/v1/, '');
      if (bare !== name && bare !== '/') {
        const shadow = await ask(`${LOCAL_SERVER}${bare}`, { headers: signedIn });
        if (shadow.status !== 404) shadows.push(`${bare} -> ${shadow.status}`);
      }
    }
    const count = Object.keys(description.paths).length;
    const spread = Object.entries(statuses).map(([status, n]) => `${n} x ${status}`).join(', ');
    note(`All ${count} paths of the description resolve on the server`, notFound.length === 0, notFound.length === 0 ? `as A1, each by a method it takes: ${spread}; none 404` : notFound.join('; '));
    note('No path resolves without its prefix', shadows.length === 0, shadows.length === 0 ? 'each is a 404 without /rest/v1 or /functions/v1' : shadows.join('; '));
  } else {
    note('The description file is there to check', false, 'scan.env or openapi-scan.json is missing: run "up" again');
  }

  // The guard: StackHawk and the three scan targets pass, anything else does not.
  if (await listening(GUARD_PORT, GUARD_HOST)) {
    const allowed = await throughGuard(`${STACKHAWK_HOSTS[0]}:443`);
    const refused = await throughGuard('example.com:443');
    note('The scan guard lets StackHawk through', allowed === 200, `CONNECT ${STACKHAWK_HOSTS[0]}:443 -> ${allowed}`);
    note('The scan guard refuses any other host', refused === 403, `CONNECT example.com:443 -> ${refused}`);
    const locals = [];
    for (const target of LOCAL_TARGETS) locals.push(`${target} -> ${await throughGuard(target)}`);
    note('The scan guard passes the three scan targets on this machine', locals.every((line) => line.endsWith('-> 200')), `CONNECT ${locals.join(', ')}`);
    const database = await throughGuard(`${HOST}:54322`);
    note('The scan guard refuses any other port of this machine', database === 403, `CONNECT ${HOST}:54322 (the database) -> ${database}`);
  } else {
    note('The scan guard is running', false, `nothing listens on ${GUARD}`);
  }

  // Nothing live can be reached by name, whatever goes around the guard.
  const reachable = await liveHostsThatResolve();
  note('No live host can be reached by name from this machine', reachable.length === 0, reachable.length === 0 ? `${hostsThatMustNotResolve().length} hosts asked, none resolves` : reachable.join('; '));
  return results;
}

function printChecks(results) {
  for (const { name, ok, detail } of results) say(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  say(failed === 0 ? `  Every check passed (${results.length}).` : `  ${failed} of ${results.length} checks failed.`);
  return failed === 0;
}

// ---- hawk ---------------------------------------------------------------------------------------

/** HAWK_API_KEY from the environment, or from key.env in the private folder. It is never printed. */
function stackHawkKey() {
  if (process.env.HAWK_API_KEY) return process.env.HAWK_API_KEY;
  if (process.env.API_KEY) return process.env.API_KEY;
  const file = path.join(home, 'key.env');
  if (existsSync(file)) {
    const match = /^(?:export\s+)?(?:HAWK_API_KEY|API_KEY)=["']?([^"'\s]+)/m.exec(readFileSync(file, 'utf8'));
    if (match) return match[1];
  }
  return fail(`Set HAWK_API_KEY to the StackHawk API key, or put it in ${file}.`);
}

const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: REPO, encoding: 'utf8' }).stdout.trim();

/**
 * The environment a hawk command gets: the key, the values the configs read, the commit and
 * branch tags, the private session folder, and the scan guard as its only way out of this
 * machine. The server's profile mode is set for the server's surface and for nothing else.
 */
function hawkEnv(surface = null) {
  const inputs = readEnvFile(path.join(inputsFolder(home), 'scan.env'));
  if (!inputs.APP_ID) fail('scan.env is missing: run "node up.mjs" first.');
  const env = { ...process.env, ...inputs };
  const key = stackHawkKey();
  env.HAWK_API_KEY = key;
  env.API_KEY = key;
  env.COMMIT_SHA = git('rev-parse', 'HEAD');
  env.BRANCH_NAME = git('rev-parse', '--abbrev-ref', 'HEAD');
  // These would send a scan to another application, environment or host than its config names,
  // or run one in another mode than its surface's.
  for (const name of ['STACKHAWK_ENV', 'HAWK_ENV', 'HAWK_APPLICATION_ID', 'APP_ENV', 'APP_HOST', 'REPO_DIR', 'ENV_FILE', 'PROFILE_SCAN_MODE', 'FULL_SCAN_PROFILE']) delete env[name];
  Object.assign(env, surface?.vars ?? {});
  env.SESSION_HOME = sessionsDir;
  // An agent names itself in HAWK_AGENT before it calls this (README.md). A name that is set
  // but empty would make an empty tag, which the scanner refuses.
  for (const name of ['HAWK_AGENT', '_STACKHAWK_AGENT']) if (env[name] === '') delete env[name];
  // The guard. The scanning engine is given it by its config: hawk.outboundProxy for its sign-in
  // and its calls to StackHawk (OUTBOUND_PROXY_HOST is the launcher's name for the same), and
  // network.connection.httpProxy for everything it scans and fetches. That client reads none of
  // the variables below. The launcher, and anything else that does read them, is given it here.
  env.OUTBOUND_PROXY_HOST = GUARD_URL;
  const trust = (process.env.JAVA_TOOL_OPTIONS ?? '').split(/\s+/).filter((word) => /^-Djavax\.net\.ssl\.trustStore(Type|Password)?=/.test(word));
  env.JAVA_TOOL_OPTIONS = [
    ...trust,
    `-Dhttps.proxyHost=${GUARD_HOST}`, `-Dhttps.proxyPort=${GUARD_PORT}`,
    `-Dhttp.proxyHost=${GUARD_HOST}`, `-Dhttp.proxyPort=${GUARD_PORT}`,
    '-Dhttp.nonProxyHosts=localhost|127.*|[::1]',
  ].join(' ');
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_HTTP_PROXY']) env[name] = GUARD;
  for (const name of ['NO_PROXY', 'no_proxy', 'GLOBAL_AGENT_NO_PROXY']) env[name] = 'localhost,127.0.0.1,::1';
  return env;
}

async function needGuard() {
  if (!(await listening(GUARD_PORT, GUARD_HOST))) fail(`The scan guard is not running on ${GUARD}. Run "node up.mjs" first: no hawk command is run without it.`);
}

const hawkBin = () => process.env.HAWK_BIN || 'hawk';

let keyCopiesRemoved = 0;

/** Takes away the copies of the StackHawk key that hawk leaves in its session folders. Says how many. */
function removeKeyCopies() {
  let removed = 0;
  const walk = (folder, depth) => {
    let names = [];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(folder, name);
      if (name.startsWith('.tmp-tokens-')) {
        rmSync(full, { force: true });
        removed++;
      } else if (depth < 3 && statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  };
  walk(sessionsDir, 0);
  return removed;
}

/**
 * Runs one hawk command and waits for it, from a private folder and never from the repository,
 * and only while the guard is up and no live host can be reached by name. Output goes where
 * `stdio` says.
 */
async function hawk(hawkArgs, { stdio = 'inherit', limitMinutes = 15, cwd = workDir, surface = null } = {}) {
  await needGuard();
  await needSafeNetwork();
  return new Promise((resolve) => {
    const child = spawn(hawkBin(), hawkArgs, { cwd, env: hawkEnv(surface), stdio, detached: true });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Ended by itself.
      }
    }, limitMinutes * 60 * 1000);
    // The command has its own process group, so that the time limit ends the scanner and its
    // browser with it. A Ctrl-C here is handed on.
    const handOn = (signal) => () => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Ended by itself.
      }
    };
    const onInt = handOn('SIGINT');
    const onTerm = handOn('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const done = (code) => {
      clearTimeout(timer);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      keyCopiesRemoved = removeKeyCopies();
      resolve(code);
    };
    child.on('error', (error) => { say(error.message); done(127); });
    child.on('exit', (code, signal) => done(code ?? (signal === 'SIGKILL' ? 124 : 1)));
  });
}

function surfaceNamed(name) {
  if (!SURFACES[name]) fail('Say which surface: api, dashboard or site.');
  if (!existsSync(configPath(SURFACES[name]))) fail(`${SURFACES[name].config} is not at the repository root.`);
  return SURFACES[name];
}

/** In arguments handed on to hawk, a config named by its bare name is given its full path. */
const withFullConfigPaths = (hawkArgs) => hawkArgs.map((arg) => Object.values(SURFACES).find((surface) => surface.config === arg) ? configPath(Object.values(SURFACES).find((surface) => surface.config === arg)) : arg);

/** What a validation printed, without the ANSI colours, with keys and tokens taken out. */
function lastWords(file) {
  const text = readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  // The scanner prints its whole configuration and its log; neither is a verdict.
  const noise = (line) => /^\d{4}-\d\d-\d\d .* (INFO|DEBUG) /.test(line) || /^["{}\[\]]/.test(line);
  const telling = lines.filter((line) => /validation was successful|looks good|Authentication Successful|successfully authenticated|error|fail|invalid|unable|could not|exception/i.test(line) && !noise(line));
  return (telling.length > 0 ? telling : lines.slice(-3)).slice(-6).map((line) => line.replace(/(Bearer\s+)\S+/g, '$1<token>').replace(/sb_(publishable|secret)_\S+/g, 'sb_$1_<key>').slice(0, 200));
}

async function validate(name) {
  const surface = surfaceNamed(name);
  const folder = path.join(inputsFolder(home), 'validate');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const config = configPath(surface);
  const session = ['--session-home', sessionsDir];
  const steps = [['config', ['validate', 'config', ...session, config]]];
  if (surface.spec) steps.push(['api', ['validate', 'api', '--hawk-mem', '2g', '--no-progress', ...session, config]]);
  if (surface.auth) steps.push(['auth', ['validate', 'auth', '--hawk-mem', '2g', '--no-progress', ...session, ...surface.flags, config]]);
  let allGood = true;
  for (const [step, hawkArgs] of steps) {
    // The output holds the local key and a made-up account's token, so it is kept private and
    // only its verdict is printed.
    const file = path.join(folder, `${name}-${step}.out`);
    const out = openSync(file, 'w', 0o600);
    const code = await hawk(hawkArgs, { stdio: ['ignore', out, out], cwd: folder, surface });
    say(`hawk ${hawkArgs.slice(0, 2).join(' ')} ${surface.config}: exit ${code}`);
    for (const line of lastWords(file)) say(`    ${line}`);
    if (code !== 0) {
      allGood = false;
      say(`    The whole output is in ${file}`);
      break;
    }
  }
  if (surface.auth) await hawk(['perch', 'stop'], { stdio: 'ignore', cwd: folder }); // Nothing of the scanner may be left running.
  return allGood ? 0 : 1;
}

async function scan(name, parent) {
  const surface = surfaceNamed(name);
  await needGuard();
  await needSafeNetwork();
  const action = parent ? 'rescan' : 'scan';
  const others = await otherScannerStill(() => spawnSync('pgrep', ['-x', 'hawk'], { encoding: 'utf8' }).stdout ?? '');
  if (others) fail(`Another hawk command is still running (process ${others.split('\n').join(', ')}). One at a time.`);
  if (!(await listening(Number(new URL(surface.host).port)))) fail(`Nothing answers at ${surface.host}. Run "node up.mjs" first.`);

  // Every scan starts from the same data. The reset says what the last scan changed.
  say('Putting the local stack back to its seeded state.');
  if (stack(['reset']).status !== 0) fail('The reset did not end in the seeded state. Do not scan until it does (stack/README.md).');

  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
  const out = path.join(inputsFolder(home), name, `${stamp}-${action}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const hawkArgs = [action, '--hawk-mem', process.env.MINEMUSTER_SCAN_HAWK_MEM || '4g', '--no-progress', '--json-output', '--session-home', sessionsDir, ...surface.flags];
  if (parent) hawkArgs.push('--scan-id', parent);
  hawkArgs.push(configPath(surface));
  const limit = Number(process.env.MINEMUSTER_SCAN_MINUTES || 110);
  const env = hawkEnv(surface);
  const runFile = path.join(out, 'run.txt');
  writeFileSync(runFile, [
    `surface=${name} action=${action} config=${surface.config} target=${surface.host}`,
    `commit=${env.COMMIT_SHA} branch=${env.BRANCH_NAME} agent=${env.HAWK_AGENT ?? 'none (hawk fills in its own)'}`,
    `command=${Object.entries(surface.vars).map(([k, v]) => `${k}=${v} `).join('')}${hawkBin()} ${hawkArgs.join(' ')}`,
    `run_from=${out} outbound_proxy=${env.SCAN_OUTBOUND_PROXY} session_home=${sessionsDir}`,
    `started=${new Date().toISOString()}`,
    '',
  ].join('\n'), { mode: 0o600 });

  // Memory in use, every five seconds, so the peak is on record.
  const memFile = path.join(out, 'mem.log');
  let peak = 0;
  const sampler = setInterval(() => {
    try {
      const info = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').map((line) => line.split(/:\s+/)).filter((pair) => pair.length === 2).map(([k, v]) => [k, Math.round(parseInt(v, 10) / 1024)]));
      const used = info.MemTotal - info.MemAvailable;
      peak = Math.max(peak, used);
      appendFileSync(memFile, `${new Date().toISOString().slice(11, 19)} used_mb=${used} available_mb=${info.MemAvailable}\n`);
    } catch {
      // No /proc/meminfo on this system.
    }
  }, 5000);

  const guardLog = path.join(runDir, 'guard.jsonl');
  const guardLinesBefore = existsSync(guardLog) ? readFileSync(guardLog, 'utf8').split('\n').length : 0;
  const gatewayLog = path.join(stackDir, 'run', 'gateway.log');
  const gatewayLinesBefore = existsSync(gatewayLog) ? readFileSync(gatewayLog, 'utf8').split('\n').length : 0;
  say(`StackHawk | ${action} of ${name} (${surface.host}) started - it takes minutes, and its output goes to ${out}`);
  const code = await hawk(hawkArgs, { stdio: ['ignore', openSync(path.join(out, 'scan.json'), 'w', 0o600), openSync(path.join(out, 'scan.err'), 'w', 0o600)], limitMinutes: limit, cwd: out, surface });
  clearInterval(sampler);

  // What the scanner sent through the guard while it ran. That is where it tried to go by the
  // guard; a connection made around the guard is not in this log.
  const guardLines = existsSync(guardLog) ? readFileSync(guardLog, 'utf8').split('\n').slice(Math.max(0, guardLinesBefore - 1)).filter(Boolean) : [];
  writeFileSync(path.join(out, 'guard.jsonl'), guardLines.length > 0 ? `${guardLines.join('\n')}\n` : '', { mode: 0o600 });
  const guarded = guardSummary(guardLines);
  const refused = guarded.refused;
  let id = '';
  try {
    id = JSON.parse(readFileSync(path.join(out, 'scan.json'), 'utf8')).scan?.id ?? '';
  } catch {
    // No JSON: the scan did not start, and scan.err says why.
  }
  // What the local server answered while the scan ran, by status. Almost nothing but 401 means
  // the key or the sign-in did not reach the scanner's requests. And table by table: whether the
  // recorded requests and the description's reads reached any rows.
  const answered = {};
  let tables = null;
  if (name === 'api' && existsSync(gatewayLog)) {
    const lines = readFileSync(gatewayLog, 'utf8').split('\n').slice(Math.max(0, gatewayLinesBefore - 1));
    for (const line of lines) {
      const status = /^\S+ [A-Z]+ \S+ (\d{3})\b/.exec(line)?.[1];
      if (status) answered[status] = (answered[status] ?? 0) + 1;
    }
    tables = describeTableAnswers(tableAnswers(lines));
  }
  const answers = Object.entries(answered).map(([status, n]) => `${status}:${n}`).join(',') || 'none';
  appendFileSync(runFile, [
    `ended=${new Date().toISOString()}`, `exit=${code}`, `scan_id=${id || 'none'}`, `peak_used_mb=${peak}`,
    `guard_passed_outside=${guarded.outside.join(',') || 'none'}`,
    `guard_passed_on_this_machine=${guarded.local.join(',') || 'none'} (${guarded.localTunnels} tunnels)`,
    `went_through_the_guard=${guardVerdict(guarded).ok ? 'yes' : 'NO'}`,
    `hosts_refused_by_the_guard=${refused.join(',') || 'none'}`,
    ...(name === 'api' ? [`server_answers_by_status=${answers}`, ...tables.lines.map((line) => `table_answers ${line}`), `tables=${tables.verdict}`] : []),
    `key_copies_removed_from_sessions=${keyCopiesRemoved}`,
    '',
  ].join('\n'));
  writeFileSync(path.join(out, 'exit.code'), `${code}\n`);
  say(`StackHawk | ${action} of ${name} ended with exit code ${code} - scan id ${id || 'none'} - ${out}`);
  say(refused.length > 0 ? `Sent through the scan guard and refused there: ${refused.join(', ')}` : 'Nothing the scanner sent through the scan guard was refused.');
  say(`The guard passed ${guarded.outside.join(', ') || 'nothing outside this machine'} outside this machine.`);
  say(guardVerdict(guarded).line);
  if (name === 'api') {
    say(`The local server's answers during the scan, by status: ${answers}`);
    say(`Tables: ${tables.verdict} (run.txt has each table)`);
  }
  return code;
}

// ---- up, status, down ---------------------------------------------------------------------------

async function status() {
  const lines = [];
  const add = async (what, address, port, name, script, host = HOST) => {
    const up = await listening(port, host);
    const pids = name ? pidsOf(name, script) : [];
    lines.push(`  ${what.padEnd(16)} ${address.padEnd(26)} ${up ? 'answers' : 'DOWN   '}${pids.length > 0 ? `  pid ${pids.join(', ')}` : ''}`);
    return up;
  };
  await add('Local server', LOCAL_SERVER, Number(new URL(LOCAL_SERVER).port));
  await add('Website copy', WEBSITE, WEBSITE_PORT, 'sites', 'sites/serve-vercel.mjs');
  await add('Dashboard copy', DASHBOARD, DASHBOARD_PORT, 'sites', 'sites/serve-vercel.mjs');
  await add('Scan guard', GUARD, GUARD_PORT, 'guard', 'egress-guard.mjs', GUARD_HOST);
  say(lines.join('\n'));
  say(`  Private folder   ${home}`);
}

async function up() {
  const appId = typeof args['app-id'] === 'string' ? args['app-id'] : process.env.STACKHAWK_APP_ID;

  say('1. The local stack');
  if (stack(['start']).status !== 0) fail('The local stack did not start (stack/README.md).');
  if (stack(['reset'], { quiet: true }).status !== 0) fail('The reset did not end in the seeded state (stack/README.md).');

  say('\n2. The copies of the website and the dashboard');
  if (args['no-stage']) say('   Left as they are (--no-stage).');
  // The copies hold the local server's address and key, and link only to each other.
  else if (nodeScript('sites/stage.mjs', []).status !== 0) fail('The copies were not made (sites/README.md).');
  const sitesLog = path.join(runDir, 'site-requests.jsonl');
  const sitesPid = await startDetached('sites', 'sites/serve-vercel.mjs', ['--log', sitesLog], [WEBSITE_PORT, DASHBOARD_PORT]);
  say(`   Served by pid ${sitesPid}; one line for each answer in ${sitesLog}`);

  say('\n3. The scan guard');
  const guardLog = path.join(runDir, 'guard.jsonl');
  const guardPid = await startDetached('guard', 'egress-guard.mjs', ['--port', String(GUARD_PORT), '--log', guardLog], [GUARD_PORT]);
  say(`   Running as pid ${guardPid}; one line for each request in ${guardLog}`);

  say('\n4. What the three configs read');
  const made = writeScanInputs({ home, appId });
  chmodSync(made.envFile, 0o600);
  say(`   scan.env (${made.variables} variables), openapi-scan.json (${made.paths} paths, ${made.pairs.length} method and path pairs) and api-seed.har (${made.seedRequests} requests) in ${made.folder}`);

  say('\n5. Ready?');
  const ready = printChecks(await readiness());
  // The checks signed in, which the stack counts as a change.
  if (stack(['reset'], { quiet: true }).status !== 0) fail('The reset after the checks did not end in the seeded state.');
  say('   The local stack is back in its seeded state.');

  say('\nRunning now, all on 127.0.0.1:');
  await status();
  say('\nNext, one at a time and in this order:');
  for (const name of Object.keys(SURFACES)) say(`  node scripts/security-scan/up.mjs validate ${name}   then   node scripts/security-scan/up.mjs scan ${name}`);
  say('Stop it all with: node scripts/security-scan/up.mjs down --stack');
  return ready ? 0 : 1;
}

async function down() {
  await stopOld('sites', 'sites/serve-vercel.mjs', [WEBSITE_PORT, DASHBOARD_PORT]);
  await stopOld('guard', 'egress-guard.mjs', [GUARD_PORT]);
  say('The site servers and the scan guard are stopped.');
  if (args.stack) stack(['stop']);
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  places();
  switch (command) {
    case 'up': return up();
    case 'status': await status(); return 0;
    case 'check': return printChecks(await readiness()) ? 0 : 1;
    case 'validate': return validate(operands[0]);
    case 'scan': return scan(operands[0], null);
    case 'rescan':
      if (!operands[1]) fail('A rescan needs the id of the surface\'s first full scan.');
      return scan(operands[0], operands[1]);
    case 'hawk':
      return hawk(withFullConfigPaths(passed));
    case 'stack': return stack(passed).status ?? 1;
    case 'down': await down(); return 0;
    default: return fail(`"${command}" is not a command. See the top of up.mjs.`);
  }
}

main().then((code) => process.exit(code ?? 0)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
