#!/usr/bin/env node
// Start, stop, check and reset the private local copy of MineMuster's server
// that the security scan attacks. See README.md beside this file.
//
//   MINEMUSTER_SCAN_STACK_DIR=<private folder> node stack.mjs start
//   ... status | reset [--hard] | stop [--purge] | token <account> | describe | smoke

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  CONTAINERS, GATEWAY_URL, HERE, HOST, IMAGES, MIGRATIONS, PORTS, authSigningKeys, call, containerState, docker, lit, loadSecrets, paths,
  readJson, run, signIn, sleep, sql, verifyingKeys, writePrivate,
} from './lib.mjs';

const say = (text) => process.stdout.write(`${text}\n`);

/** The schemas a reset puts back: the app's tables, the accounts, the Vault secret, and which migrations ran. */
const KEPT_SCHEMAS = ['public', 'auth', 'vault', 'supabase_migrations'];

async function waitFor(what, check, seconds = 120) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > until) throw new Error(`${what} was not ready after ${seconds} seconds.`);
    await sleep(500);
  }
}

/** The status of a plain HTTP GET on a loopback port, or 0 when nothing answers. */
function httpStatus(port, route = '/') {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port, path: route, timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', () => resolve(0));
    request.on('timeout', () => request.destroy());
  });
}

// ---- The pieces -----------------------------------------------------------------------------------

function ensureTls(files) {
  if (fs.existsSync(files.cert) && fs.existsSync(files.key)) return;
  fs.mkdirSync(files.tlsDir, { recursive: true, mode: 0o700 });
  run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '60',
    '-subj', '/CN=MineMuster local scan stack', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,digitalSignature,keyCertSign',
    '-addext', 'extendedKeyUsage=serverAuth', '-keyout', files.key, '-out', files.cert]);
  fs.chmodSync(files.key, 0o600);
}

/** Each container reads its settings from a file only this user reads, so no secret is on a command line. */
function writeContainerSettings(files, secrets) {
  const external = `${GATEWAY_URL}/auth/v1`;
  const settings = {
    db: {
      POSTGRES_PASSWORD: secrets.dbPassword, PGPASSWORD: secrets.dbPassword, PGPORT: PORTS.db, POSTGRES_PORT: PORTS.db,
      POSTGRES_HOST: '/var/run/postgresql', PGDATABASE: 'postgres', POSTGRES_DB: 'postgres', JWT_EXP: 3600,
    },
    rest: {
      PGRST_DB_URI: `postgres://authenticator:${secrets.dbPassword}@${HOST}:${PORTS.db}/postgres`,
      PGRST_DB_SCHEMAS: 'public,graphql_public', PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions', PGRST_DB_MAX_ROWS: 1000,
      PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: JSON.stringify(verifyingKeys(secrets)), PGRST_DB_USE_LEGACY_GUCS: 'false',
      PGRST_APP_SETTINGS_JWT_EXP: 3600, PGRST_SERVER_HOST: HOST, PGRST_SERVER_PORT: PORTS.rest,
    },
    auth: {
      GOTRUE_API_HOST: HOST, GOTRUE_API_PORT: PORTS.auth, API_EXTERNAL_URL: external, GOTRUE_DB_DRIVER: 'postgres',
      GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${secrets.dbPassword}@${HOST}:${PORTS.db}/postgres`,
      GOTRUE_SITE_URL: GATEWAY_URL, GOTRUE_URI_ALLOW_LIST: '', GOTRUE_DISABLE_SIGNUP: 'false', GOTRUE_JWT_ADMIN_ROLES: 'service_role',
      GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated', GOTRUE_JWT_EXP: 3600,
      GOTRUE_JWT_SECRET: secrets.jwtSecret, GOTRUE_JWT_KEYS: JSON.stringify(authSigningKeys(secrets)), GOTRUE_JWT_ISSUER: external,
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_MAILER_AUTOCONFIRM: 'true', GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: 'false',
      GOTRUE_EXTERNAL_PHONE_ENABLED: 'false', GOTRUE_SMS_AUTOCONFIRM: 'false',
      // Supabase Auth limits requests by the caller's address, which the gateway hands it in this header.
      ...(process.env.MINEMUSTER_SCAN_AUTH_LIMITS === 'off' ? {} : { GOTRUE_RATE_LIMIT_HEADER: 'Sb-Forwarded-For', GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED: 'true' }),
    },
  };
  for (const [name, values] of Object.entries(settings)) {
    writePrivate(path.join(files.run, `${name}.env`), `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  }
}

function startContainer(files, name, command = []) {
  const state = containerState(CONTAINERS[name]);
  if (state === 'running') return false;
  if (state === 'stopped') docker(['start', CONTAINERS[name]]);
  else docker(['run', '-d', '--name', CONTAINERS[name], '--network', 'host', '--env-file', path.join(files.run, `${name}.env`), IMAGES[name], ...command]);
  return state === 'missing';
}

const pidFile = (files, name) => path.join(files.run, `${name}.pid`);

function nodeProcess(files, name) {
  try {
    const pid = Number(fs.readFileSync(pidFile(files, name), 'utf8'));
    if (pid && fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`${name}.mjs`)) return pid;
  } catch {
    // No such process.
  }
  return 0;
}

function startNode(files, name, env = {}) {
  if (nodeProcess(files, name)) return;
  const out = fs.openSync(path.join(files.run, `${name}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...env } });
  child.unref();
  fs.writeFileSync(pidFile(files, name), String(child.pid));
}

function stopNode(files, name) {
  const pid = nodeProcess(files, name);
  if (pid) process.kill(pid, 'SIGTERM');
  fs.rmSync(pidFile(files, name), { force: true });
}

/** Every migration not yet recorded, in order, each in one transaction as postgres: the way `supabase db push` applies them. */
function applyMigrations() {
  sql(`create schema if not exists supabase_migrations;
       create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);`, { role: 'postgres' });
  const done = new Set(sql('select version from supabase_migrations.schema_migrations', { role: 'postgres' }).split('\n'));
  let applied = 0;
  for (const file of fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    const [, version, name] = /^(\d+)_(.*)\.sql$/.exec(file);
    if (done.has(version)) continue;
    const text = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    try {
      sql(`${text}\n;insert into supabase_migrations.schema_migrations (version, name, statements) values (${lit(version)}, ${lit(name)}, array[${lit(text)}]);`, { role: 'postgres', single: true });
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
    applied += 1;
  }
  return applied;
}

/** One line for each table and sequence a reset puts back, hashed: the same rows give the same digest. */
function stateDigest() {
  const tables = sql(`select format('%I.%I', schemaname, tablename) from pg_tables where schemaname in (${KEPT_SCHEMAS.map(lit).join(', ')}) order by 1`).split('\n').filter(Boolean);
  const parts = tables.map((table) => `select ${lit(table)} as t, count(*)::text || ' ' || coalesce(md5(string_agg(x::text, E'\\n' order by x::text)), '-') as d from ${table} x`);
  parts.push(`select 'sequence ' || schemaname || '.' || sequencename, coalesce(last_value::text, '-') from pg_sequences where schemaname in (${KEPT_SCHEMAS.map(lit).join(', ')})`);
  const lines = sql(`select t || ' ' || d from (${parts.join('\nunion all\n')}) s order by t`);
  return { digest: createHash('sha256').update(lines).digest('hex'), lines };
}

/** Keep the seeded state: the data of the kept schemas, as pg_dump writes it, and its digest. */
function takeSnapshot(files) {
  const dump = docker(['exec', CONTAINERS.db, 'pg_dump', '-U', 'supabase_admin', '-h', HOST, '-p', String(PORTS.db), '-d', 'postgres', '--data-only',
    ...KEPT_SCHEMAS.map((schema) => `--schema=${schema}`)]).stdout;
  writePrivate(files.snapshot, dump);
  const { digest, lines } = stateDigest();
  writePrivate(files.digest, `${digest}\n${lines}\n`);
  return digest;
}

/** Put the kept schemas back exactly as the snapshot has them. Triggers and foreign keys are off while it runs. */
function restoreSnapshot(files) {
  const dump = fs.readFileSync(files.snapshot, 'utf8');
  const tables = [...dump.matchAll(/^COPY (\S+) \(/gm)].map((match) => match[1]);
  const now = sql(`select format('%I.%I', schemaname, tablename) from pg_tables where schemaname in (${KEPT_SCHEMAS.map(lit).join(', ')})`).split('\n').filter(Boolean);
  const all = [...new Set([...tables, ...now])];
  sql(`set lock_timeout = '20s';\nset session_replication_role = replica;\ntruncate table ${all.join(', ')};\n${dump}`, { single: true });
}

function writeEnvJson(files, secrets) {
  const self = `MINEMUSTER_SCAN_STACK_DIR=${files.dir} node ${path.join(HERE, 'stack.mjs')}`;
  writePrivate(files.env, `${JSON.stringify({
    about: 'The private local copy of MineMuster\'s server for the security scan. Everything is on 127.0.0.1 and every name in it is made up.',
    gatewayUrl: GATEWAY_URL,
    publishableKey: secrets.publishableKey,
    urls: { rest: `${GATEWAY_URL}/rest/v1`, auth: `${GATEWAY_URL}/auth/v1`, functions: `${GATEWAY_URL}/functions/v1`, stripeWebhook: `${GATEWAY_URL}/functions/v1/stripe-webhook` },
    ports: PORTS,
    tls: { certificate: files.cert, key: files.key, names: ['127.0.0.1', 'localhost'], note: 'Self-signed, and its own authority: trust the certificate file itself (NODE_EXTRA_CA_CERTS, curl --cacert).' },
    files: {
      fixtures: files.fixtures, secrets: files.secrets, snapshot: files.snapshot, snapshotDigest: files.digest, routes: files.routes, smoke: files.smoke,
      openapiAnon: files.openapiAnon, openapiAuthenticated: files.openapiAuthenticated, openapiAnonForGateway: files.openapiAnonGateway,
      openapiAuthenticatedForGateway: files.openapiAuthenticatedGateway, openapiStripeWebhook: files.openapiWebhook,
      gatewayLog: path.join(files.run, 'gateway.log'), functionsLog: path.join(files.run, 'functions-server.log'),
    },
    images: IMAGES,
    containers: CONTAINERS,
    commands: { start: `${self} start`, status: `${self} status`, reset: `${self} reset`, stop: `${self} stop`, token: `${self} token A1` },
    authLimits: process.env.MINEMUSTER_SCAN_AUTH_LIMITS === 'off' ? 'off' : 'on, by caller address, as Supabase Auth ships; a reset clears them',
  }, null, 2)}\n`);
}

// ---- The commands ---------------------------------------------------------------------------------

async function start() {
  const began = Date.now();
  const files = paths();
  fs.mkdirSync(files.run, { recursive: true, mode: 0o700 });
  if (!docker(['info'], { allowFail: true }).ok) throw new Error('Docker is not running. Start the Docker daemon first.');
  const secrets = loadSecrets({ create: true });
  ensureTls(files);
  writeContainerSettings(files, secrets);

  const cold = startContainer(files, 'db', ['postgres', '-c', 'config_file=/etc/postgresql/postgresql.conf', '-c', `listen_addresses=${HOST}`, '-c', `port=${PORTS.db}`]);
  say(cold ? 'PostgreSQL: making a new database (about half a minute)...' : 'PostgreSQL: starting...');
  await waitFor('PostgreSQL', () => sql('select 1', { allowFail: true }).ok, 240);
  sql(`alter role authenticator with password ${lit(secrets.dbPassword)}; alter role supabase_auth_admin with password ${lit(secrets.dbPassword)};`);

  startContainer(files, 'auth');
  await waitFor('Supabase Auth', async () => (await httpStatus(PORTS.auth, '/health')) === 200);
  const applied = applyMigrations();
  sql(`select vault.create_secret(${lit(secrets.webhookSecret)}, 'stripe_webhook_secret', 'Signs the Stripe events MineMuster takes')
       where not exists (select 1 from vault.secrets where name = 'stripe_webhook_secret');`, { role: 'postgres' });
  startContainer(files, 'rest');
  await waitFor('PostgREST', async () => (await httpStatus(PORTS.rest, '/')) === 200);
  if (applied) sql("notify pgrst, 'reload schema'");

  startNode(files, 'functions-server', { NODE_EXTRA_CA_CERTS: files.cert });
  startNode(files, 'gateway');
  await waitFor('the functions server', async () => (await httpStatus(PORTS.functions, '/')) === 404);
  await waitFor('the gateway', async () => (await call('GET', '/rest/v1/')).status === 401);
  // PostgREST reads the schema when it is told to, and one that was already running answers from the
  // schema it read before the migrations above until then. So wait until it knows crew_lookup, a
  // function of migration 20261122000100. It is the server key's alone: the publishable key's call
  // is refused by the database before anything runs (42501), which PostgREST answers 401, as
  // smoke.mjs expects of push_records. Until PostgREST has read the function it answers 404
  // (PGRST202, as after-scan.mjs reads it), and the gateway's own refusals carry no code.
  await waitFor('PostgREST to read the schema', async () => {
    const answer = await call('POST', '/rest/v1/rpc/crew_lookup', { key: secrets.publishableKey, body: { p_code: 'AAAAAAAA', p_address: '' } });
    return answer.status === 401 && answer.json?.code === '42501';
  });

  writeEnvJson(files, secrets);
  if (!fs.existsSync(files.snapshot)) {
    say('Seeding made-up companies, accounts and records...');
    const { seed } = await import('./seed.mjs');
    const fixtures = await seed(secrets, files);
    writePrivate(files.fixtures, `${JSON.stringify(fixtures, null, 2)}\n`);
    say(`Seeded. Snapshot digest ${takeSnapshot(files).slice(0, 16)}.`);
    const { describe } = await import('./describe.mjs');
    await describe(secrets, files);
  }
  say(`Started in ${((Date.now() - began) / 1000).toFixed(1)} s (${applied} migration(s) applied). Gateway: ${GATEWAY_URL}. Settings: ${files.env}`);
}

function stop(purge) {
  const files = paths();
  stopNode(files, 'gateway');
  stopNode(files, 'functions-server');
  for (const name of ['rest', 'auth', 'db']) {
    if (purge) docker(['rm', '-f', '-v', CONTAINERS[name]], { allowFail: true });
    else if (containerState(CONTAINERS[name]) === 'running') docker(['stop', '-t', '20', CONTAINERS[name]]);
  }
  if (purge) for (const file of [files.snapshot, files.digest, files.fixtures]) fs.rmSync(file, { force: true });
  say(purge ? 'Stopped, and the database is gone. The keys and the certificate are kept, so builds made for this stack still fit.' : 'Stopped. The database is kept; start brings it back as it was.');
}

async function reset(hard) {
  const began = Date.now();
  const files = paths();
  if (hard) {
    stop(true);
    return start();
  }
  const wanted = fs.readFileSync(files.digest, 'utf8').split('\n')[0];
  const before = stateDigest().digest;
  restoreSnapshot(files);
  // Supabase Auth keeps its request limits in memory: a restart clears them.
  docker(['restart', '-t', '5', CONTAINERS.auth]);
  await waitFor('Supabase Auth', async () => (await httpStatus(PORTS.auth, '/health')) === 200);
  const after = stateDigest().digest;
  say(`Before the reset: ${before === wanted ? 'the seeded state' : `changed (${before.slice(0, 16)})`}.`);
  say(`After the reset:  ${after === wanted ? `the seeded state (${after.slice(0, 16)})` : `NOT the seeded state (${after.slice(0, 16)}, wanted ${wanted.slice(0, 16)})`}.`);
  say(`Reset in ${((Date.now() - began) / 1000).toFixed(1)} s.`);
  if (after !== wanted) process.exitCode = 1;
}

async function status() {
  const files = paths();
  const secrets = loadSecrets();
  const up = { db: containerState(CONTAINERS.db), auth: containerState(CONTAINERS.auth), rest: containerState(CONTAINERS.rest) };
  say(`PostgreSQL   ${up.db.padEnd(8)} 127.0.0.1:${PORTS.db}  ${up.db === 'running' ? sql('show server_version') : ''}`);
  say(`Supabase Auth ${up.auth.padEnd(7)} 127.0.0.1:${PORTS.auth}  health ${await httpStatus(PORTS.auth, '/health')}`);
  say(`PostgREST    ${up.rest.padEnd(8)} 127.0.0.1:${PORTS.rest}  root ${await httpStatus(PORTS.rest, '/')}`);
  say(`Functions    ${nodeProcess(files, 'functions-server') ? 'running ' : 'stopped '} 127.0.0.1:${PORTS.functions}`);
  const gateway = nodeProcess(files, 'gateway') ? await call('GET', '/rest/v1/').then((answer) => answer.status, () => 0) : 0;
  say(`Gateway      ${gateway ? 'running ' : 'stopped '} ${GATEWAY_URL}  no key answers ${gateway}`);
  if (up.db === 'running' && fs.existsSync(files.digest)) {
    const wanted = fs.readFileSync(files.digest, 'utf8').split('\n')[0];
    const { digest, lines } = stateDigest();
    say(`Data         ${digest === wanted ? 'the seeded state' : 'changed since it was seeded'} (${digest.slice(0, 16)})`);
    if (digest !== wanted) {
      const seeded = new Set(fs.readFileSync(files.digest, 'utf8').split('\n').slice(1));
      say(`             differs in: ${lines.split('\n').filter((line) => !seeded.has(line)).map((line) => line.split(' ').slice(0, -2).join(' ')).join(', ')}`);
    }
  }
  const stats = docker(['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}', ...Object.values(CONTAINERS)], { allowFail: true }).stdout.trim();
  if (stats) say(`Memory       ${stats.split('\n').join('; ')}`);
  for (const name of ['gateway', 'functions-server']) {
    const pid = nodeProcess(files, name);
    if (pid) say(`             ${name} ${/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? '?'} kB`);
  }
  say(`Publishable key ${secrets.publishableKey.slice(0, 20)}... in ${files.env}`);
}

async function token(label) {
  const account = readJson(paths().fixtures).accounts[label];
  if (!account) throw new Error(`No account ${label} in fixtures.json. Try A1, A2, B1, N1 or P1.`);
  say((await signIn(loadSecrets(), account.email, account.password)).access_token);
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === 'start') await start();
  else if (command === 'stop') stop(argument === '--purge');
  else if (command === 'reset') await reset(argument === '--hard');
  else if (command === 'status') await status();
  else if (command === 'token') await token(argument);
  else if (command === 'describe') await (await import('./describe.mjs')).describe(loadSecrets(), paths());
  else if (command === 'smoke') await (await import('./smoke.mjs')).smoke(loadSecrets(), paths());
  else {
    say('Usage: stack.mjs start | status | reset [--hard] | stop [--purge] | token <account> | describe | smoke');
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
