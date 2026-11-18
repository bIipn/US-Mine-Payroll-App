// What the commands of the local scan stack share: where things are kept, the
// secrets made at first start, the containers, psql, and requests to the
// gateway. Nothing here talks to anything but this machine.
//
// Every secret is made on first start and kept under the stack folder, which
// MINEMUSTER_SCAN_STACK_DIR names. It is never the repository.

import { spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../..');
export const MIGRATIONS = path.join(REPO, 'supabase/migrations');

/** Every port is on 127.0.0.1. A scanner uses the gateway's and no other. */
export const PORTS = { gateway: 54321, db: 54322, rest: 54331, auth: 54332, functions: 54333 };
export const HOST = '127.0.0.1';
export const GATEWAY_URL = `https://${HOST}:${PORTS.gateway}`;

/** The images. Production's PostgreSQL is 17.12.0.000; see README.md for the rest. */
export const IMAGES = {
  db: process.env.MINEMUSTER_SCAN_DB_IMAGE || 'supabase/postgres:17.12.0.000',
  rest: process.env.MINEMUSTER_SCAN_REST_IMAGE || 'postgrest/postgrest:v14.18',
  auth: process.env.MINEMUSTER_SCAN_AUTH_IMAGE || 'supabase/gotrue:v2.198.0',
};
export const CONTAINERS = { db: 'mm-scan-db', rest: 'mm-scan-rest', auth: 'mm-scan-auth' };

/** The folder the stack keeps its secrets, logs and reports in. */
export function stackDir() {
  const dir = process.env.MINEMUSTER_SCAN_STACK_DIR;
  if (!dir) {
    throw new Error('Set MINEMUSTER_SCAN_STACK_DIR to a private folder outside the repository. The stack keeps its secrets there.');
  }
  const resolved = path.resolve(dir);
  if (resolved === REPO || resolved.startsWith(`${REPO}${path.sep}`)) {
    throw new Error('MINEMUSTER_SCAN_STACK_DIR is inside the repository. The stack\'s secrets must not be kept there.');
  }
  return resolved;
}

export function paths() {
  const dir = stackDir();
  return {
    dir,
    run: path.join(dir, 'run'),
    secrets: path.join(dir, 'secrets.json'),
    tlsDir: path.join(dir, 'tls'),
    cert: path.join(dir, 'tls', 'cert.pem'),
    key: path.join(dir, 'tls', 'key.pem'),
    env: path.join(dir, 'env.json'),
    fixtures: path.join(dir, 'fixtures.json'),
    snapshot: path.join(dir, 'snapshot.sql'),
    digest: path.join(dir, 'snapshot.digest'),
    openapiAnon: path.join(dir, 'openapi-anon.json'),
    openapiAuthenticated: path.join(dir, 'openapi-authenticated.json'),
    openapiAnonGateway: path.join(dir, 'openapi-anon.gateway.json'),
    openapiAuthenticatedGateway: path.join(dir, 'openapi-authenticated.gateway.json'),
    openapiWebhook: path.join(dir, 'openapi-stripe-webhook.json'),
    routes: path.join(dir, 'routes.md'),
    smoke: path.join(dir, 'smoke.txt'),
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write a file only its owner reads. */
export function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Run a command to its end. Throws with what it printed when it fails, unless `allowFail`. */
export function run(command, args, { input, allowFail = false, env } = {}) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: env ?? process.env });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.slice(0, 4).join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(-2000)}`);
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

// ---- Secrets --------------------------------------------------------------------------------------

const opaqueKey = (kind) => `sb_${kind}_${randomBytes(16).toString('base64url')}_${randomBytes(6).toString('base64url')}`;

/**
 * The stack's own secrets, made at random the first time and read back after.
 * The keys have the shape of Supabase's publishable and secret keys; the last
 * part of a real key is a checksum, and here it is random, since this gateway
 * compares whole keys.
 */
export function loadSecrets({ create = false } = {}) {
  const file = paths().secrets;
  if (fs.existsSync(file)) return readJson(file);
  if (!create) throw new Error('The stack has not been started yet: no secrets.json. Run the start command.');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'ES256' };
  const secrets = {
    dbPassword: randomBytes(24).toString('base64url'),
    jwtSecret: randomBytes(48).toString('base64url'),
    jwtSecretKid: randomUUID(),
    jwk,
    publishableKey: opaqueKey('publishable'),
    secretKey: opaqueKey('secret'),
    webhookSecret: `whsec_${randomBytes(24).toString('base64url')}`,
  };
  writePrivate(file, `${JSON.stringify(secrets, null, 2)}\n`);
  return secrets;
}

/** The legacy secret as a JWK, the way Supabase lists it beside the signing key. */
const symmetricJwk = (secrets) => ({
  kty: 'oct',
  k: Buffer.from(secrets.jwtSecret).toString('base64url'),
  kid: secrets.jwtSecretKid,
  use: 'sig',
  key_ops: ['verify'],
  alg: 'HS256',
  ext: true,
});

/** What Supabase Auth signs with: the EC private key, and the legacy secret to verify by. */
export function authSigningKeys(secrets) {
  return [{ ...secrets.jwk, key_ops: ['sign', 'verify'], ext: true }, symmetricJwk(secrets)];
}

/** What PostgREST verifies by: the EC public key and the legacy secret. */
export function verifyingKeys(secrets) {
  const { d: _private, ...publicJwk } = secrets.jwk;
  return { keys: [{ ...publicJwk, key_ops: ['verify'], ext: true }, symmetricJwk(secrets)] };
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token signed with the stack's EC key (ES256), as the gateway hands the services for a key's role. */
export function signJwt(secrets, claims, seconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: secrets.jwk.kid })}.${b64({ iss: 'supabase', iat: now, exp: now + seconds, ...claims })}`;
  const { kid: _kid, use: _use, alg: _alg, ...bare } = secrets.jwk;
  const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey({ key: bare, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

// ---- Docker and psql ------------------------------------------------------------------------------

export const docker = (args, options) => run('docker', args, options);

/** 'running', 'stopped' or 'missing'. */
export function containerState(name) {
  const result = docker(['inspect', '-f', '{{.State.Running}}', name], { allowFail: true });
  if (!result.ok) return 'missing';
  return result.stdout.trim() === 'true' ? 'running' : 'stopped';
}

/**
 * Run SQL with psql inside the database container, over the loopback address
 * the image trusts. `role` is supabase_admin (the superuser, for this stack's
 * own housekeeping) or postgres (the project's owner, who is not a superuser:
 * migrations and the SQL editor run as it). Returns what psql printed, unaligned.
 */
export function sql(text, { role = 'supabase_admin', single = false, allowFail = false } = {}) {
  const args = ['exec', '-i', CONTAINERS.db, 'psql', '-U', role, '-h', HOST, '-p', String(PORTS.db), '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...(single ? ['-1'] : []), '-f', '-'];
  const result = docker(args, { input: text, allowFail });
  return allowFail ? result : result.stdout.trim();
}

/** A value as an SQL literal. */
export const lit = (value) => (value === null || value === undefined ? 'null' : `'${String(value).replaceAll("'", "''")}'`);

// ---- Requests to the gateway ----------------------------------------------------------------------

/**
 * One request to the local gateway, trusting the stack's own certificate.
 * `key` goes in apikey, `token` in Authorization, and `body` is sent as JSON
 * unless it is a string or a Buffer.
 */
export function call(method, route, { key, token, body, headers = {}, port = PORTS.gateway } = {}) {
  const ca = fs.readFileSync(paths().cert);
  const raw = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  const sent = { ...headers };
  if (key) sent.apikey = key;
  if (token) sent.Authorization = `Bearer ${token}`;
  if (raw && !Object.keys(sent).some((name) => name.toLowerCase() === 'content-type')) sent['Content-Type'] = 'application/json';
  if (raw) sent['Content-Length'] = raw.length;
  return new Promise((resolve, reject) => {
    const request = https.request({ host: HOST, port, path: route, method, headers: sent, ca, servername: 'localhost' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error(`${method} ${route} got no answer in 30 seconds`)));
    if (raw) request.write(raw);
    request.end();
  });
}

/** Sign in with an email address and a password, as the app does. Returns the session. */
export async function signIn(secrets, email, password) {
  const answer = await call('POST', '/auth/v1/token?grant_type=password', { key: secrets.publishableKey, body: { email, password } });
  if (answer.status !== 200) throw new Error(`Sign-in as ${email} failed (${answer.status}): ${answer.text.slice(0, 300)}`);
  return answer.json;
}
