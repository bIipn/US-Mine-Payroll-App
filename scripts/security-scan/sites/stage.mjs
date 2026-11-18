#!/usr/bin/env node
// Makes the private copies of the two sites that a security scan is pointed at:
//
//   <home>/sites/website                 site/ with the live server, its key and the live links moved
//   <home>/sites/dashboard               a build of dashboard/ that talks to the local server
//   <home>/sites/dashboard.vercel.json   dashboard/vercel.json, changed the same way
//   <home>/sites/stage-report.json       what was changed, and what was checked
//
//   node stage.mjs --home <private folder> [--only website|dashboard]
//
// The live server's address and key are read from the repository's own files, not written here.
// In both copies the server becomes the local one, the key becomes the local server's, and every
// link to the live website, the live dashboard or Stripe goes to a copy instead (live.mjs). The
// script stops, loudly, if the live server, its key or a live link is anywhere in a copy when it
// is done, and takes that copy away. It never writes into site/, dashboard/dist or anywhere else
// in the repository.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { LOCAL_SERVER, REPO, homeFrom, layout, readArgs } from './layout.mjs';
import { LOCAL_LINK_TARGETS, directives, liveKeys, liveLinksIn, liveServer, moveLinks, policiesIn, undoLinks } from './live.mjs';
import { headersFor, readConfig } from './vercel-rules.mjs';

const SITE = path.join(REPO, 'site');
const DASHBOARD = path.join(REPO, 'dashboard');

/** Used only until the local server's step has written its own key. It opens nothing. */
const PLACEHOLDER_KEY = 'sb_publishable_placeholder_not_a_key';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };

function filesUnder(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) fail(`${full} is a link. The copies are made of plain files only.`);
      if (stat.isDirectory()) walk(full, rel);
      else found.push(rel);
    }
  };
  walk(root, '');
  return found;
}

/** Replaces every mention of the live server in a text, and says how many there were. */
function moved(text, live) {
  const count = text.split(live.origin).length - 1;
  return { text: text.split(live.origin).join(LOCAL_SERVER), count };
}

/** The files whose text a copy may change. Anything else is copied byte for byte. */
const isText = (rel) => /\.(html|js|mjs|css|json|xml|txt|svg|webmanifest|map)$/.test(rel);

/**
 * Stops if anything under a folder names the live server or any other Supabase project, holds the
 * live server's key, or links to the live website, the live dashboard or Stripe.
 */
function mustNotName(live, root, files, extra = []) {
  const anyProject = /[a-z0-9]{20}\.supabase\.(co|in|net)/i;
  const keys = liveKeys();
  const named = [];
  const look = (where, text) => {
    const why = [];
    if (text.toLowerCase().includes(live.host.toLowerCase()) || anyProject.test(text)) why.push('the live server');
    if (keys.some((key) => text.includes(key))) why.push('the live key');
    const links = liveLinksIn(text);
    if (links.length > 0) why.push(`a live link (${links.slice(0, 3).join(', ')})`);
    if (why.length > 0) named.push(`${where}: ${why.join(', ')}`);
  };
  for (const rel of files) look(rel, readFileSync(path.join(root, rel)).toString('latin1'));
  for (const file of extra) look(file, readFileSync(file, 'latin1'));
  if (named.length > 0) {
    fail(`STOP: the copy still names what it must not, in ${named.join('; ')}. Do not serve or scan this copy.`);
  }
}

/**
 * Every host a copy names in an address, with how often: what a crawler could be led to. Source
 * maps are left out, since they are the libraries' source with every address in its comments.
 */
function hostsNamed(root, files) {
  const hosts = {};
  for (const rel of files) {
    if (!/\.(html|js|mjs|css|json|xml|txt|svg|webmanifest)$/.test(rel) || rel === 'vercel.json') continue;
    const text = readFileSync(path.join(root, rel), 'utf8');
    for (const match of text.matchAll(/\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/gi)) {
      const host = match[1].toLowerCase();
      hosts[host] = (hosts[host] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(hosts).sort());
}

/**
 * Writes a vercel.json with the server address moved, and checks that nothing else in any
 * Content-Security-Policy is different: the same directives in the same order, every source the
 * same but the one address in connect-src.
 */
function moveConfig(live, from, to) {
  const before = readFileSync(from, 'utf8');
  const { text: after, count } = moved(before, live);
  if (count === 0) fail(`${from} does not name ${live.origin}.`);
  const was = policiesIn(JSON.parse(before));
  const now = policiesIn(JSON.parse(after));
  let changed = 0;
  was.forEach((policy, i) => {
    const a = [...directives(policy)];
    const b = [...directives(now[i])];
    if (a.length !== b.length) fail(`A policy in ${from} lost or gained a directive.`);
    a.forEach(([name, sources], j) => {
      const [nameNow, sourcesNow] = b[j];
      const expected = name === 'connect-src' ? sources.map((s) => (s === live.origin ? LOCAL_SERVER : s)) : sources;
      if (nameNow !== name || sourcesNow.join(' ') !== expected.join(' ')) fail(`${name} in ${from} changed in a way it should not have.`);
      if (sourcesNow.join(' ') !== sources.join(' ')) changed++;
    });
  });
  mkdirSync(path.dirname(to), { recursive: true });
  writeFileSync(to, after);
  return { file: to, replaced: count, policiesChanged: changed };
}

/** The inline scripts of a page that a browser would run, and so that a policy has to allow. */
function inlineScripts(html) {
  const found = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase() ?? '';
    if (type && !['module', 'importmap', 'text/javascript', 'application/javascript'].includes(type)) continue;
    found.push({ type: type || 'classic', hash: `'sha256-${createHash('sha256').update(match[2], 'utf8').digest('base64')}'` });
  }
  return found;
}

/** Checks each page's inline scripts against the script-src it is served with. */
function checkScriptHashes(root, files, configFile) {
  const rules = readConfig(JSON.parse(readFileSync(configFile, 'utf8')));
  const pages = [];
  for (const rel of files.filter((f) => f.endsWith('.html'))) {
    const published = `/${rel.slice(0, -'.html'.length).replace(/(^|\/)index$/, '')}`.replace(/\/$/, '') || '/';
    const policy = headersFor(rules, published).find((h) => h.key.toLowerCase() === 'content-security-policy')?.value;
    if (!policy) fail(`${published} would be served with no Content-Security-Policy.`);
    const allowed = directives(policy).get('script-src') ?? directives(policy).get('default-src') ?? [];
    const scripts = inlineScripts(readFileSync(path.join(root, rel), 'utf8'));
    const hashed = allowed.some((s) => /^'(sha(256|384|512)-|nonce-)/.test(s));
    const anyInline = allowed.includes("'unsafe-inline'") && !hashed;
    const refused = anyInline ? [] : scripts.filter((s) => !allowed.includes(s.hash));
    if (refused.length > 0) fail(`${rel}: ${refused.length} inline script(s) are not in the script-src served for ${published}: ${refused.map((s) => s.hash).join(' ')}`);
    pages.push({ page: published, file: rel, inlineScripts: scripts.length, allowedBy: anyInline ? "'unsafe-inline'" : 'hash', hashes: anyInline ? [] : [...new Set(scripts.map((s) => s.hash))] });
  }
  return pages;
}

/** Adds up how many of each live link were moved, across files. */
function addMoves(total, moved) {
  for (const [live, count] of Object.entries(moved)) total[live] = (total[live] ?? 0) + count;
}

function stageWebsite(live, at) {
  const key = localKey(at);
  rmSync(at.website, { recursive: true, force: true });
  mkdirSync(at.website, { recursive: true });
  const source = filesUnder(SITE);

  // The copy's own changes are only read back if site/ cannot hold them already.
  for (const rel of source.filter(isText)) {
    const text = readFileSync(path.join(SITE, rel), 'utf8');
    const there = [LOCAL_SERVER, key.key, ...LOCAL_LINK_TARGETS].filter((s) => text.includes(s));
    if (there.length > 0) fail(`site/${rel} already holds ${there.join(', ')}, so the copy could not be checked against it.`);
  }

  // Two files name the server: the contact form's script, and connect-src in vercel.json. Every
  // file is written with its changes already made, so nothing live is in the copy, even for a moment.
  const changed = {};
  const linksMoved = {};
  for (const rel of source) {
    const from = path.join(SITE, rel);
    const to = path.join(at.website, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    if (rel === 'vercel.json') {
      changed[rel] = moveConfig(live, from, to);
    } else if (isText(rel)) {
      let text = readFileSync(from, 'utf8');
      const what = {};
      if (rel === 'contact.js') {
        const form = moved(text, live);
        if (form.count === 0) fail(`site/contact.js does not name ${live.origin}.`);
        const liveKey = /const KEY = '(sb_publishable_[\w-]+)';/.exec(form.text)?.[1];
        if (!liveKey || form.text.split(liveKey).length !== 2) fail('site/contact.js does not hold its key the way this script expects.');
        text = form.text.replace(liveKey, key.key);
        what.serverAddress = form.count;
        what.key = `the local server's, from ${key.from}`;
      } else if (text.includes(live.host)) {
        fail(`site/${rel} names the live server, and this script does not know how to move it there.`);
      }
      const links = moveLinks(text);
      if (Object.keys(links.moved).length > 0) {
        what.links = links.moved;
        addMoves(linksMoved, links.moved);
      }
      if (Object.keys(what).length > 0) {
        changed[rel] = what;
        writeFileSync(to, links.text);
      } else {
        copyFileSync(from, to);
      }
    } else {
      if (readFileSync(from).toString('latin1').includes(live.host)) fail(`site/${rel} names the live server, and this script does not know how to move it there.`);
      copyFileSync(from, to);
    }
    const { atime, mtime } = statSync(from);
    utimesSync(to, atime, mtime);
  }
  for (const rel of ['contact.js', 'vercel.json']) if (!changed[rel]) fail(`site/${rel} is missing.`);

  // Every file of the copy is site/'s, but for the server address, the key and the links.
  const copy = filesUnder(at.website);
  if (copy.join('\n') !== source.join('\n')) fail('The copy of the website does not hold the same files as site/.');
  const liveKey = /const KEY = '(sb_publishable_[\w-]+)';/.exec(readFileSync(path.join(SITE, 'contact.js'), 'utf8'))[1];
  for (const rel of copy) {
    const mine = readFileSync(path.join(at.website, rel));
    const theirs = readFileSync(path.join(SITE, rel));
    if (rel in changed) {
      const back = undoLinks(mine.toString('utf8')).split(LOCAL_SERVER).join(live.origin).split(key.key).join(liveKey);
      if (back !== theirs.toString('utf8')) fail(`${rel} in the copy differs from site/ by more than the server address, the key and the links.`);
    } else if (sha256(mine) !== sha256(theirs)) {
      fail(`${rel} in the copy is not the same as in site/.`);
    }
  }
  mustNotName(live, at.website, copy);
  const pages = checkScriptHashes(at.website, copy, at.websiteConfig);
  return {
    folder: at.website,
    config: at.websiteConfig,
    files: copy.length,
    sameAsSource: copy.length - Object.keys(changed).length,
    changed: Object.fromEntries(Object.entries(changed).map(([rel, what]) => [rel, rel === 'vercel.json' ? { serverAddress: what.replaced, policiesChanged: what.policiesChanged } : what])),
    linksMoved,
    contactFormKey: changed['contact.js'].key,
    keyMissing: key.missing ?? null,
    pages,
    hostsNamed: hostsNamed(at.website, copy),
  };
}

/** The publishable key of the local server, from the file its own step writes. */
function localKey(at) {
  if (!existsSync(at.stackEnv)) return { key: PLACEHOLDER_KEY, from: 'placeholder', missing: `${at.stackEnv} is not there yet` };
  const found = [];
  const look = (value, name) => {
    if (typeof value === 'string') {
      if (/^sb_publishable_/.test(value) || (/publishable|anon/i.test(name) && !/secret|service/i.test(name) && value.length >= 20)) found.push({ name, value });
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) look(inner, name ? `${name}.${key}` : key);
    }
  };
  look(JSON.parse(readFileSync(at.stackEnv, 'utf8')), '');
  const best = found.find((f) => /^sb_publishable_/.test(f.value)) ?? found.find((f) => /publishable/i.test(f.name)) ?? found[0];
  if (!best) return { key: PLACEHOLDER_KEY, from: 'placeholder', missing: `${at.stackEnv} has no publishable or anon key in it` };
  return { key: best.value, from: `${at.stackEnv} (${best.name})` };
}

function stageDashboard(live, at) {
  const vite = path.join(DASHBOARD, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) fail('dashboard/node_modules is not installed. Run "npm ci" in dashboard/ first.');
  const key = localKey(at);
  const keys = liveKeys();

  rmSync(at.dashboard, { recursive: true, force: true });
  const built = spawnSync(process.execPath, [vite, 'build', '--outDir', at.dashboard, '--emptyOutDir'], {
    cwd: DASHBOARD,
    env: { ...process.env, VITE_SUPABASE_URL: LOCAL_SERVER, VITE_SUPABASE_PUBLISHABLE_KEY: key.key },
    encoding: 'utf8',
  });
  if (built.status !== 0) fail(`The dashboard did not build:\n${built.stdout}\n${built.stderr}`);
  const config = moveConfig(live, path.join(DASHBOARD, 'vercel.json'), at.dashboardConfig);

  // The code must be free of the live server and its key as built. A source map carries the
  // source files as text, and lib/config.ts names both as the defaults; that text is changed as
  // well. The links to the live sites and to Stripe are moved in every file, maps included.
  const files = filesUnder(at.dashboard);
  const maps = {};
  const linksMoved = {};
  for (const rel of files.filter(isText)) {
    const full = path.join(at.dashboard, rel);
    let text = readFileSync(full, 'utf8');
    const before = text;
    if (text.includes(live.host) || keys.some((k) => text.includes(k))) {
      if (!rel.endsWith('.map')) fail(`STOP: ${rel} of the dashboard build names the live server or holds its key. The build did not take the VITE_SUPABASE_ settings.`);
      const map = moved(text, live);
      text = map.text;
      let replacedKeys = 0;
      for (const k of keys) {
        replacedKeys += text.split(k).length - 1;
        text = text.split(k).join(key.key);
      }
      maps[rel] = { serverAddress: map.count, key: replacedKeys };
    }
    const links = moveLinks(text);
    addMoves(linksMoved, links.moved);
    if (links.text !== before) writeFileSync(full, links.text);
  }
  mustNotName(live, at.dashboard, files, [at.dashboardConfig]);

  const code = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(at.dashboard, f), 'utf8')).join('\n');
  if (!code.includes(LOCAL_SERVER)) fail(`The dashboard build does not name ${LOCAL_SERVER}.`);
  if (!code.includes(key.key)) fail('The dashboard build does not hold the key it was built with.');
  const pages = checkScriptHashes(at.dashboard, files, at.dashboardConfig);
  return {
    folder: at.dashboard,
    config: at.dashboardConfig,
    files: files.length,
    server: LOCAL_SERVER,
    key: key.from,
    keyMissing: key.missing ?? null,
    sourceMapsChanged: maps,
    linksMoved,
    policiesChanged: config.policiesChanged,
    pages,
    hostsNamed: hostsNamed(at.dashboard, files),
  };
}

/**
 * Makes a copy and notes it in the report. If any check fails, whatever was made of the copy is
 * taken away and the report says why: a copy is whole and checked, or it is not there.
 */
function orNothing(report, name, reportFile, made, make) {
  try {
    report[name] = make();
  } catch (error) {
    for (const target of made) rmSync(target, { recursive: true, force: true });
    report[name] = { failed: error.message };
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  }
}

/** The commit the copies were made from, and whether the folders they come from have changes on top. */
function madeFrom() {
  const git = (...args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const changes = git('status', '--porcelain', '--', 'site', 'dashboard', 'src');
  return { commit: git('rev-parse', 'HEAD'), uncommittedChanges: changes ? changes.split('\n').map((line) => line.trim()) : [] };
}

function main() {
  const args = readArgs(process.argv.slice(2));
  const home = homeFrom(args);
  const at = layout(home);
  const only = typeof args.only === 'string' ? args.only : null;
  if (only && only !== 'website' && only !== 'dashboard') fail('--only is website or dashboard.');
  mkdirSync(at.sites, { recursive: true });

  const live = liveServer();
  const report = existsSync(at.report) ? JSON.parse(readFileSync(at.report, 'utf8')) : {};
  report.madeAt = new Date().toISOString();
  report.madeFrom = madeFrom();
  report.liveServerMovedTo = LOCAL_SERVER;
  const missing = (what) => {
    if (report[what].keyMissing) {
      console.error(`\nMISSING: ${report[what].keyMissing}.\nThe ${what} copy was made with a placeholder key, so the local server will turn it away.\nRun this again once the local server's step has written its key.\n`);
    }
  };
  const links = (moves) => Object.values(moves).reduce((sum, n) => sum + n, 0);
  if (only !== 'dashboard') {
    orNothing(report, 'website', at.report, [at.website], () => stageWebsite(live, at));
    console.log(`Website: ${report.website.files} files in ${at.website}; ${report.website.sameAsSource} are byte for byte site/'s. The others differ by the server address, the contact form's key, and ${links(report.website.linksMoved)} links to the live sites and Stripe, moved onto the copies.`);
    missing('website');
  }
  if (only !== 'website') {
    orNothing(report, 'dashboard', at.report, [at.dashboard, at.dashboardConfig], () => stageDashboard(live, at));
    console.log(`Dashboard: built into ${at.dashboard} (${report.dashboard.files} files) to talk to ${LOCAL_SERVER}, with ${links(report.dashboard.linksMoved)} links to the live sites and Stripe moved onto the copies; its vercel.json is ${at.dashboardConfig}.`);
    missing('dashboard');
  }
  writeFileSync(at.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`The live server, its key and the live sites are named nowhere in what was made. Report: ${at.report}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
