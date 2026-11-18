#!/usr/bin/env node
// Opens the two copies in a real browser and checks them, with serve-vercel.mjs running:
//
//   every page of the website loads with no Content-Security-Policy violation and no failed request;
//   the 3D logo on the home page draws; /demo opens the app; a path that is not there gives the
//   404 page with status 404; the dashboard shows its sign-in screen; and every request the pages
//   make goes to one of the three local addresses and nowhere else.
//
//   node check-sites.mjs --home <private folder> [--send-form] [--sign-in [account]] [--playwright <folder holding node_modules/playwright>]
//
// The browser is started so that it can reach 127.0.0.1 and nothing else, and no link that leaves
// the copies is followed. Two more checks need the local server running:
//   --send-form  sends the contact form once, with made-up details, to see where it goes. That
//                writes one row on the local server when the form goes through.
//   --sign-in    signs in to the dashboard copy as one of the local server's made-up accounts
//                (A1, a supervisor, unless another is named) and waits for the company to open.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { DASHBOARD_PORT, HOST, LOCAL_SERVER, WEBSITE_PORT, homeFrom, layout, readArgs } from './layout.mjs';

const args = readArgs(process.argv.slice(2));
const home = homeFrom(args);
const at = layout(home);
const shots = path.join(at.sites, 'shots');
mkdirSync(shots, { recursive: true });

function loadPlaywright() {
  const places = [typeof args.playwright === 'string' ? args.playwright : null, ...(process.env.NODE_PATH ?? '').split(path.delimiter), process.cwd()].filter(Boolean);
  for (const place of places) {
    try {
      return createRequire(path.join(path.resolve(place), 'noop.js'))('playwright');
    } catch {
      // Look in the next place.
    }
  }
  throw new Error('Playwright was not found. Say where it is installed: --playwright <folder that holds node_modules/playwright>.');
}

const WEBSITE = `https://${HOST}:${WEBSITE_PORT}`;
const DASHBOARD = `https://${HOST}:${DASHBOARD_PORT}`;
const ALLOWED = new Set([new URL(WEBSITE).host, new URL(DASHBOARD).host, new URL(LOCAL_SERVER).host]);
const isNetwork = (url) => /^(https?|wss?):/i.test(url);

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
  args: [
    // Nothing but this machine can be reached, whatever a page asks for.
    '--no-proxy-server',
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${HOST}`,
    // WebGL without a graphics card, for the 3D logo.
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
  ],
});

const problems = [];
const results = [];
const hostsAsked = {};

/** Opens a page in a fresh context and gathers everything it asked for and everything that went wrong. */
async function visit(name, url, { expectStatus = 200, ready } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const seen = { requests: [], failed: [], bad: [], violations: [], errors: [], elsewhere: [] };

  await context.route((u) => isNetwork(u.href) && !ALLOWED.has(u.host), (route) => {
    seen.elsewhere.push(route.request().url());
    return route.abort();
  });
  page.on('request', (request) => {
    if (!isNetwork(request.url())) return;
    const asked = new URL(request.url());
    seen.requests.push(`${request.method()} ${asked.origin}${asked.pathname}`);
    hostsAsked[asked.host] = (hostsAsked[asked.host] ?? 0) + 1;
    if (!ALLOWED.has(asked.host)) seen.elsewhere.push(request.url());
  });
  page.on('requestfailed', (request) => seen.failed.push(`${request.url()} (${request.failure()?.errorText})`));
  page.on('response', (response) => {
    if (response.status() >= 400 && !(response.url() === url && response.status() === expectStatus)) seen.bad.push(`${response.status()} ${response.url()}`);
  });
  page.on('pageerror', (error) => seen.errors.push(String(error.message)));
  page.on('console', (message) => {
    // The browser notes the 404 that the page for a missing path is meant to give.
    const expected = expectStatus >= 400 && message.location()?.url === url;
    if (message.type() === 'error' && !expected) seen.errors.push(message.text());
    if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) seen.violations.push(message.text());
  });
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile || e.documentURI}:${e.lineNumber}`));
  });

  const response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  const status = response?.status();
  let readyNote = null;
  let extra = {};
  try {
    if (ready) extra = (await ready(page, seen)) ?? {};
  } catch (error) {
    readyNote = error.message.split('\n')[0];
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  seen.violations.push(...(await page.evaluate(() => window.__violations ?? []).catch(() => [])));
  await page.screenshot({ path: path.join(shots, `${name}.png`) }).catch(() => {});

  const result = {
    name, url, status, finalUrl: page.url(), title: await page.title().catch(() => ''),
    requests: seen.requests.length, policy: (await response?.headerValue('content-security-policy'))?.slice(0, 60),
    ...extra,
    violations: [...new Set(seen.violations)], failed: seen.failed, bad: seen.bad, errors: [...new Set(seen.errors)], elsewhere: [...new Set(seen.elsewhere)],
  };
  if (status !== expectStatus) problems.push(`${name}: status ${status}, expected ${expectStatus}`);
  if (readyNote) problems.push(`${name}: ${readyNote}`);
  for (const [kind, list] of [['policy violation', result.violations], ['failed request', result.failed], ['answer of 400 or more', result.bad], ['error on the page', result.errors], ['request to somewhere else', result.elsewhere]]) {
    for (const item of list) problems.push(`${name}: ${kind}: ${item}`);
  }
  results.push(result);
  await context.close();
  return result;
}

// ---------- The website ----------
await visit('home', `${WEBSITE}/`, {
  ready: async (page) => {
    // site.js marks the stage once three.js has drawn the logo's first frame.
    await page.locator('[data-logo-stage].is-live').waitFor({ state: 'attached', timeout: 30000 });
    const canvas = await page.locator('[data-logo-stage] canvas').evaluate((c) => ({ hidden: c.hidden, width: c.width, height: c.height }));
    if (canvas.hidden || canvas.width === 0) throw new Error('the 3D logo\'s canvas is not showing');
    return { logo3d: `drawn on a ${canvas.width} by ${canvas.height} canvas` };
  },
});
for (const name of ['pricing', 'contact', 'security', 'privacy', 'terms']) {
  await visit(name, `${WEBSITE}/${name}`, { ready: (page) => page.locator('h1').first().waitFor({ state: 'visible', timeout: 15000 }) });
}
await visit('demo', `${WEBSITE}/demo`, {
  ready: async (page) => {
    // The packed app draws its sign-in screen into #root.
    await page.waitForFunction(() => (document.getElementById('root')?.innerText ?? '').trim().length > 40, null, { timeout: 45000 });
    const words = await page.evaluate(() => document.getElementById('root').innerText.replace(/\s+/g, ' ').trim().slice(0, 90));
    return { appOpened: words };
  },
});
await visit('not-found', `${WEBSITE}/no-such-page`, {
  expectStatus: 404,
  ready: async (page) => {
    await page.locator('h1').first().waitFor({ state: 'visible', timeout: 15000 });
    return { heading: await page.locator('h1').first().innerText() };
  },
});
await visit('page-with-ending', `${WEBSITE}/pricing.html`, {
  ready: async (page) => {
    if (new URL(page.url()).pathname !== '/pricing') throw new Error(`/pricing.html ended at ${page.url()}, not /pricing`);
  },
});

// ---------- The dashboard ----------
const signIn = async (page) => {
  await page.getByLabel('Email').first().waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: 'Sign in' }).first().waitFor({ state: 'visible', timeout: 15000 });
  return { heading: await page.locator('h1').first().innerText().catch(() => '') };
};
await visit('dashboard', `${DASHBOARD}/`, { ready: signIn });
await visit('dashboard-deep-link', `${DASHBOARD}/billing`, { ready: signIn });
await visit('dashboard-start-trial', `${DASHBOARD}/?start=trial`, {
  ready: async (page) => {
    await page.getByRole('button', { name: 'Create the account' }).first().waitFor({ state: 'visible', timeout: 30000 });
  },
});

// ---------- The contact form, when asked ----------
let form = null;
if (args['send-form']) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const sent = [];
  await context.route((u) => isNetwork(u.href) && !ALLOWED.has(u.host), (route) => { problems.push(`contact form: asked for ${route.request().url()}`); return route.abort(); });
  page.on('request', (request) => {
    if (!isNetwork(request.url())) return;
    const host = new URL(request.url()).host;
    hostsAsked[host] = (hostsAsked[host] ?? 0) + 1;
    if (request.method() === 'POST') sent.push(request.url());
  });
  await page.goto(`${WEBSITE}/contact`, { waitUntil: 'load' });
  await page.getByLabel('Name', { exact: false }).first().fill('Pat Cole');
  await page.locator('[name="company"]').fill('Test Pit A');
  await page.locator('[name="email"]').fill('pat@example.test');
  await page.locator('[name="phone"]').fill('555-0100');
  await page.locator('[name="message"]').fill('We run two crews. Can we see the equipment checklist?');
  await page.locator('form[data-contact] button[type="submit"]').click();
  const outcome = await Promise.race([
    page.locator('.form-done').waitFor({ timeout: 25000 }).then(() => 'the local server took the message'),
    page.locator('.form-status[data-kind="error"]').waitFor({ timeout: 25000 }).then(async () => `the page said: ${await page.locator('.form-status').innerText()}`),
  ]).catch(() => 'the page said nothing in 25 seconds');
  form = { sentTo: sent, outcome };
  const expected = `${LOCAL_SERVER}/rest/v1/rpc/submit_contact_request`;
  if (sent.length !== 1 || sent[0] !== expected) problems.push(`contact form: sent to ${sent.join(', ') || 'nowhere'}, expected one request to ${expected}`);
  await page.screenshot({ path: path.join(shots, 'contact-form.png') }).catch(() => {});
  await context.close();
}

// ---------- Signing in to the dashboard, when asked ----------
let signedIn = null;
if (args['sign-in']) {
  const fixtures = JSON.parse(readFileSync(at.stackFixtures, 'utf8'));
  const who = typeof args['sign-in'] === 'string' ? args['sign-in'] : 'A1';
  const account = fixtures.accounts?.[who];
  if (!account) throw new Error(`${at.stackFixtures} has no account ${who}.`);
  const company = Object.values(fixtures.companies ?? {}).find((c) => c.supervisor === who)?.name;
  const result = await visit('dashboard-signed-in', `${DASHBOARD}/`, {
    ready: async (page) => {
      await page.getByLabel('Email').first().fill(account.email);
      await page.getByLabel('Password', { exact: true }).first().fill(account.password);
      await page.getByRole('button', { name: 'Sign in' }).first().click();
      // The sign-in form gives way to the company, or to the page for an account with none.
      await page.getByRole('button', { name: 'Sign out' }).first().waitFor({ state: 'visible', timeout: 30000 });
      if (company) await page.waitForFunction((name) => document.body.innerText.includes(name), company, { timeout: 30000 });
      return { heading: await page.locator('h1').first().innerText().catch(() => ''), opened: company ?? 'no company' };
    },
  });
  signedIn = { account: who, opened: result.opened ?? null, heading: result.heading ?? null, requests: result.requests };
}

await browser.close();

for (const host of Object.keys(hostsAsked)) {
  if (!ALLOWED.has(host)) problems.push(`a request went to ${host}`);
}
const report = { checkedAt: new Date().toISOString(), allowedHosts: [...ALLOWED], hostsAsked, pages: results, form, signedIn, problems };
const reportFile = path.join(at.sites, 'check-report.json');
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

for (const r of results) {
  const notes = [r.logo3d, r.appOpened && `app: "${r.appOpened}"`, r.heading && `heading: "${r.heading}"`].filter(Boolean).join('; ');
  console.log(`${String(r.status).padEnd(4)} ${r.name.padEnd(22)} ${String(r.requests).padStart(3)} requests  ${r.violations.length} violations  ${r.failed.length + r.bad.length} failed  ${notes}`);
}
if (form) console.log(`Contact form: ${form.sentTo.join(', ') || 'sent nothing'}; ${form.outcome}`);
if (signedIn) console.log(signedIn.opened ? `Signed in to the dashboard copy as ${signedIn.account}: ${signedIn.opened} opened, on "${signedIn.heading}".` : `Signing in to the dashboard copy as ${signedIn.account} did not work.`);
console.log(`Hosts asked: ${Object.entries(hostsAsked).map(([host, count]) => `${host} (${count})`).join(', ')}`);
console.log(`Report: ${reportFile}   Screenshots: ${shots}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('Every check passed.');
