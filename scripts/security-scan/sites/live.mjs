// What a scan copy must never lead anyone to: the live website and dashboard, Stripe's pages and
// the live server. stage.mjs moves every link to them onto the copies and stops if one is left,
// and up.mjs runs no hawk command on a machine where one of these hosts can be reached by name.
//
// The live server's address and its publishable key are read from the repository's own files,
// not written here.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DASHBOARD_PORT, HOST, REPO, WEBSITE_PORT } from './layout.mjs';

export const WEBSITE_COPY = `https://${HOST}:${WEBSITE_PORT}`;
export const DASHBOARD_COPY = `https://${HOST}:${DASHBOARD_PORT}`;

/** A folder the website copy never has, so every address under it is answered with the 404 page. */
export const NOT_IN_THE_COPY = `${WEBSITE_COPY}/not-in-the-copy`;

/**
 * Each live address a copy links to, and where the copy's link goes instead. The website and the
 * dashboard go to their copies, so a crawl that follows one stays on this machine and finds the
 * same pages. Stripe's pages go to an address on the website copy that answers 404, with the host
 * kept in the path so the page can still be told apart. Any other link to these domains is not
 * moved, and stage.mjs stops on it.
 */
export const LINK_MOVES = [
  ['https://app.minemuster.com', DASHBOARD_COPY],
  ['https://minemuster.com', WEBSITE_COPY],
  ...['billing', 'buy', 'checkout', 'js'].map((sub) => [`https://${sub}.stripe.com`, `${NOT_IN_THE_COPY}/${sub}.stripe.com`]),
  ['https://stripe.com', `${NOT_IN_THE_COPY}/stripe.com`],
];

/** A link to MineMuster's own sites or to Stripe's, with or without the scheme, escaped or not. */
const LIVE_LINK = /(?:https?:)?(?:\\?\/){2}(?:[a-z0-9-]+\.)*(?:minemuster|stripe)\.com\b/gi;

/** Moves every live link in a text. Says how many of each were moved. */
export function moveLinks(text) {
  const moved = {};
  let out = text;
  for (const [live, local] of LINK_MOVES) {
    const count = out.split(live).length - 1;
    if (count > 0) {
      out = out.split(live).join(local);
      moved[live] = count;
    }
  }
  return { text: out, moved };
}

/** Puts the live links back, to check that a copy differs from its source by the moves and nothing else. */
export function undoLinks(text) {
  // The longest first: the addresses for Stripe's pages begin with the website copy's own.
  const byLength = [...LINK_MOVES].sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [live, local] of byLength) out = out.split(local).join(live);
  return out;
}

/** The addresses a source file must not hold already, or undoLinks could not tell them apart. */
export const LOCAL_LINK_TARGETS = [...new Set(LINK_MOVES.map(([, local]) => local))];

/** The live links still in a text, as written. */
export function liveLinksIn(text) {
  return [...new Set(text.match(LIVE_LINK) ?? [])];
}

/** A Content-Security-Policy as its directives, by name. */
export function directives(policy) {
  const found = new Map();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) found.set(name.toLowerCase(), sources);
  }
  return found;
}

export const policiesIn = (config) =>
  (config.headers ?? []).flatMap((rule) => rule.headers.filter((h) => h.key.toLowerCase() === 'content-security-policy').map((h) => h.value));

const SITE_CONFIG = path.join(REPO, 'site', 'vercel.json');
const DASHBOARD_CONFIG = path.join(REPO, 'dashboard', 'vercel.json');

/** The one server the two sites are allowed to call, from connect-src in their vercel.json files. */
export function liveServer() {
  const origins = new Set();
  for (const file of [SITE_CONFIG, DASHBOARD_CONFIG]) {
    for (const policy of policiesIn(JSON.parse(readFileSync(file, 'utf8')))) {
      for (const source of directives(policy).get('connect-src') ?? []) {
        if (/^https?:\/\//.test(source)) origins.add(source);
      }
    }
  }
  if (origins.size !== 1) {
    throw new Error(`connect-src in the two vercel.json files names ${origins.size} servers (${[...origins].join(', ') || 'none'}). Exactly one is expected.`);
  }
  const origin = [...origins][0];
  return { origin, host: new URL(origin).host };
}

/**
 * The live server's publishable keys, as the website's contact form and the dashboard's default
 * hold them. They are public by design, but a scan copy holds the local server's key instead, so
 * that nothing a scan uploads carries the live one.
 */
export function liveKeys() {
  const files = [path.join(REPO, 'site', 'contact.js'), path.join(REPO, 'dashboard', 'src', 'lib', 'config.ts')];
  const keys = new Set();
  for (const file of files) for (const key of readFileSync(file, 'utf8').match(/sb_publishable_[A-Za-z0-9_-]+/g) ?? []) keys.add(key);
  return [...keys];
}

/**
 * The hosts a scan must not be able to reach by name from this machine: MineMuster's sites, the
 * live server, Supabase's and Vercel's management addresses, and Stripe's. The scan guard refuses
 * them to anything that goes through it; this list is for whatever might not.
 */
export function hostsThatMustNotResolve() {
  return [
    'minemuster.com', 'www.minemuster.com', 'app.minemuster.com',
    liveServer().host, 'supabase.co', 'api.supabase.com',
    'stripe.com', 'api.stripe.com', 'billing.stripe.com', 'buy.stripe.com', 'checkout.stripe.com', 'js.stripe.com',
    'vercel.com', 'api.vercel.com',
  ];
}

/** Whether an address is this machine, or no machine at all. A host that resolves only to one is harmless. */
export function isThisMachine(address) {
  const plain = address.replace(/^::ffff:/i, '');
  return /^127\./.test(plain) || plain === '0.0.0.0' || plain === '::1' || plain === '::';
}
