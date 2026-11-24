// Where the private copies of the two sites live, and the certificate they are served with.
// Everything made here goes in the scan's private folder, which is never inside the repository.

import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The local copy of the company server. The copies of the sites may call this and nothing else. */
export const LOCAL_SERVER = 'https://127.0.0.1:54321';

export const HOST = '127.0.0.1';
export const WEBSITE_PORT = 4443;
export const DASHBOARD_PORT = 4444;

/** Reads `--name value` and `--flag` from a command line. */
export function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (!word.startsWith('--')) throw new Error(`Did not expect "${word}".`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[word.slice(2)] = true;
    else args[word.slice(2)] = argv[++i];
  }
  return args;
}

function outsideRepo(folder) {
  const inside = path.relative(REPO, folder);
  if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
    throw new Error(`${folder} is inside the repository. The copies and their keys must stay out of it.`);
  }
  return folder;
}

/** The scan's private folder: `--home`, or MINEMUSTER_SCAN_DIR. It must be outside the repository. */
export function homeFrom(args) {
  const given = typeof args.home === 'string' ? args.home : process.env.MINEMUSTER_SCAN_DIR;
  if (!given) throw new Error('Say where the scan keeps its private files: --home <folder>, or set MINEMUSTER_SCAN_DIR.');
  return outsideRepo(path.resolve(given));
}

/**
 * The folders and files of the copies, under the private folder. The local server's own folder is
 * the one its step names in MINEMUSTER_SCAN_STACK_DIR, or `stack` beside the copies.
 */
export function layout(home) {
  const sites = path.join(home, 'sites');
  const stack = process.env.MINEMUSTER_SCAN_STACK_DIR ? outsideRepo(path.resolve(process.env.MINEMUSTER_SCAN_STACK_DIR)) : path.join(home, 'stack');
  return {
    sites,
    website: path.join(sites, 'website'),
    websiteConfig: path.join(sites, 'website', 'vercel.json'),
    dashboard: path.join(sites, 'dashboard'),
    // Vercel's build leaves vercel.json out of the dashboard's output, so the copy's is kept beside it.
    dashboardConfig: path.join(sites, 'dashboard.vercel.json'),
    report: path.join(sites, 'stage-report.json'),
    ownTls: path.join(sites, 'tls'),
    stackTls: path.join(stack, 'tls'),
    stackEnv: path.join(stack, 'env.json'),
    stackFixtures: path.join(stack, 'fixtures.json'),
  };
}

function pemFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => statSync(file).isFile() && statSync(file).size < 64 * 1024)
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

/** A certificate in a folder that is good for 127.0.0.1, with the key that fits it. */
function pairIn(dir) {
  const files = pemFiles(dir);
  const keys = [];
  for (const { file, text } of files) {
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) continue;
    try {
      keys.push({ file, key: createPrivateKey(text) });
    } catch {
      // Not a key this server can read.
    }
  }
  const pairs = [];
  for (const { file, text } of files) {
    const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text);
    if (!first) continue;
    let cert;
    try {
      cert = new X509Certificate(first[0]);
    } catch {
      continue;
    }
    if (!cert.checkIP(HOST)) continue;
    const fits = keys.find(({ key }) => cert.checkPrivateKey(key));
    if (fits) pairs.push({ cert: file, key: fits.file, until: cert.validTo, expired: new Date(cert.validTo) < new Date() });
  }
  return pairs.find((pair) => !pair.expired) ?? null;
}

/**
 * The certificate to serve the copies with: the one the local server's own step made, so one
 * certificate covers everything a scan opens, or failing that one made here.
 */
export function tlsFor(home) {
  const at = layout(home);
  const stack = pairIn(at.stackTls);
  if (stack) return { ...stack, from: 'stack' };
  let own = pairIn(at.ownTls);
  if (!own) {
    mkdirSync(at.ownTls, { recursive: true, mode: 0o700 });
    const key = path.join(at.ownTls, 'key.pem');
    const cert = path.join(at.ownTls, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '30',
      '-subj', '/CN=MineMuster local scan copy',
      '-addext', `subjectAltName=IP:${HOST},DNS:localhost`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chmodSync(key, 0o600);
    own = pairIn(at.ownTls);
    if (!own) throw new Error(`openssl ran, but ${at.ownTls} holds no certificate for ${HOST}.`);
  }
  return { ...own, from: 'own' };
}
