// What Vercel does with a request for a static site, worked out from the site's vercel.json and the
// list of its files. Nothing here opens a file or a socket: serve-vercel.mjs does that, and the
// tests in test/ call these functions directly.
//
// The order is the one Vercel's own build gives a vercel.json (getTransformedRoutes in
// @vercel/routing-utils): the cleanUrls redirects, then the header rules, then the files, then the
// rewrites, then the 404 page. README.md says which parts were seen on the live sites, which were
// read in Vercel's code and which are from its documentation.

import { pathToRegexp } from 'path-to-regexp';

/** Sent with every answer that no rule gives a Cache-Control of its own. Seen on the live sites. */
export const DEFAULT_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** Vercel's own HSTS on a custom domain, for an answer no rule covers (a redirect, say). */
export const DEFAULT_HSTS = 'max-age=63072000';

/** Vercel's static builder leaves these out of a deployment, so they are never served. */
export function isNeverServed(file) {
  return (
    file === 'vercel.json' ||
    file === 'now.json' ||
    file === '.vercelignore' ||
    file === '.nowignore' ||
    file.startsWith('.git/') ||
    file.startsWith('.env')
  );
}

/**
 * A `source` from vercel.json as the regular expression Vercel matches a path with. The options
 * are the ones in Vercel's sourceToRegex. A path is matched as it is written, capitals included.
 */
export function sourceToRegex(source) {
  const keys = [];
  const made = pathToRegexp(source, keys, { strict: true, sensitive: true, delimiter: '/' });
  return { regex: new RegExp(made.source), named: keys.filter((k) => typeof k.name === 'string').map((k) => k.name) };
}

/** With cleanUrls, Vercel sends these paths on to `/$1` with a 308 before anything else is looked at. */
export const CLEAN_URL_REDIRECTS = [/^\/(?:(.+)\/)?index(?:\.html)?\/?$/, /^\/(.*)\.html\/?$/];

/** The 404 page a site with no framework gets: every path but /api, as in Vercel's detectBuilders. */
const OWN_404_PAGE = /^(?!\/api).*$/;

const KNOWN_KEYS = new Set([
  '$schema', 'cleanUrls', 'headers', 'rewrites',
  // Read by Vercel when it builds the site. They change nothing about how the files are served.
  'framework', 'installCommand', 'buildCommand', 'outputDirectory',
]);

/**
 * Reads a vercel.json into the rules this server follows. It stops at anything it would have to
 * guess at, so the copy never quietly serves a site another way than Vercel does.
 */
export function readConfig(config) {
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`vercel.json has "${key}", which this server does not follow. Add it to vercel-rules.mjs with a test first.`);
  }
  if (config.cleanUrls !== undefined && typeof config.cleanUrls !== 'boolean') throw new Error('cleanUrls must be true or false.');

  const headerRules = (config.headers ?? []).map((rule) => {
    if (rule.has || rule.missing) throw new Error(`The header rule for ${rule.source} has "has" or "missing", which this server does not follow.`);
    const { regex, named } = sourceToRegex(rule.source);
    if (named.length > 0) throw new Error(`The header rule for ${rule.source} names a part of the path, which this server does not follow.`);
    return { source: rule.source, regex, headers: rule.headers.map(({ key, value }) => ({ key, value })) };
  });

  const rewrites = (config.rewrites ?? []).map((rule) => {
    if (rule.has || rule.missing) throw new Error(`The rewrite for ${rule.source} has "has" or "missing", which this server does not follow.`);
    const { regex } = sourceToRegex(rule.source);
    if (typeof rule.destination !== 'string' || !/^\/[^:$?#]*$/.test(rule.destination)) {
      throw new Error(`The rewrite for ${rule.source} goes to ${JSON.stringify(rule.destination)}. This server only follows a rewrite to one file of the same site.`);
    }
    return { source: rule.source, regex, destination: rule.destination };
  });

  return { cleanUrls: config.cleanUrls === true, headerRules, rewrites, ownNotFoundPage: !config.framework };
}

/** Every header the rules give a path. A later rule's value takes the place of an earlier one's. */
export function headersFor(rules, path) {
  const found = new Map();
  for (const rule of rules.headerRules) {
    if (!rule.regex.test(path)) continue;
    for (const { key, value } of rule.headers) found.set(key.toLowerCase(), { key, value });
  }
  return [...found.values()];
}

/**
 * The path of a request, percent-decoded, or null when it cannot be read. Dots that climb out of a
 * folder are settled here; a file is only ever looked up in the list of the site's own files.
 */
export function readPath(target) {
  if (typeof target !== 'string' || !target.startsWith('/')) return null;
  const end = target.search(/[?#]/);
  const rawPath = end === -1 ? target : target.slice(0, end);
  const query = end === -1 || target[end] === '#' ? '' : target.slice(end).split('#')[0];
  let settled;
  try {
    settled = new URL(`https://site.invalid${rawPath}`).pathname;
  } catch {
    return null;
  }
  let path;
  try {
    path = decodeURIComponent(settled);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return { path, query };
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

/** The file a path stands for, or null. `files` holds the site's files by their path from its root. */
export function fileFor(rules, files, path) {
  const has = (file) => files.has(file) && !isNeverServed(file);
  let key = path.replace(/^\//, '');
  // With no trailingSlash setting, a path is served the same with or without its last slash.
  if (key.endsWith('/')) key = key.slice(0, -1);
  if (key === '') return has('index.html') ? 'index.html' : null;
  if (rules.cleanUrls) {
    // A page's file is published without its ending, so only the path without it finds the page.
    if (key.endsWith('.html')) return null;
    if (has(`${key}.html`)) return `${key}.html`;
  }
  if (has(key)) return key;
  if (has(`${key}/index.html`)) return `${key}/index.html`;
  return null;
}

/**
 * What to answer a request with:
 *   { kind: 'bad' }                                   the path cannot be read
 *   { kind: 'redirect', status: 308, location }       cleanUrls, or a path with doubled slashes
 *   { kind: 'file', status: 200 | 404, file, headers }  a file of the site; 404 is its 404.html
 *   { kind: 'none', status: 404, headers }            nothing to serve, and no 404 page for the path
 * `headers` are the ones the rules give the path that was asked for, which is the path Vercel
 * matches them against even when the answer is another file (a rewrite, or the 404 page).
 */
export function decide(rules, files, target) {
  const read = readPath(target);
  if (!read) return { kind: 'bad' };
  const { path, query } = read;

  if (/\/{2,}/.test(path)) {
    return { kind: 'redirect', status: 308, location: encodePath(path.replace(/\/{2,}/g, '/')) + query };
  }

  if (rules.cleanUrls) {
    for (const redirect of CLEAN_URL_REDIRECTS) {
      const match = redirect.exec(path);
      if (match) return { kind: 'redirect', status: 308, location: encodePath(`/${match[1] ?? ''}`) + query };
    }
  }

  const headers = headersFor(rules, path);

  const direct = fileFor(rules, files, path);
  if (direct) return { kind: 'file', status: 200, file: direct, headers };

  for (const rewrite of rules.rewrites) {
    if (!rewrite.regex.test(path)) continue;
    // Vercel checks that the file a rewrite names is there, and tries the next rewrite if not.
    const file = fileFor({ ...rules, cleanUrls: false }, files, rewrite.destination);
    if (file) return { kind: 'file', status: 200, file, headers };
  }

  if (rules.ownNotFoundPage && OWN_404_PAGE.test(path) && files.has('404.html')) {
    return { kind: 'file', status: 404, file: '404.html', headers };
  }
  return { kind: 'none', status: 404, headers };
}

/**
 * Content-Disposition as the live sites send it: `inline` for the home page and for a page with
 * its ending, and the published name for anything else. With cleanUrls a page is published
 * without its ending (pricing.html as "pricing", demo/index.html as "demo").
 */
export function dispositionFor(rules, file) {
  let name = file.split('/').pop();
  if (file.endsWith('.html')) {
    if (!rules.cleanUrls) return 'inline';
    const published = file.slice(0, -'.html'.length).replace(/(^|\/)index$/, '');
    if (published === '') return 'inline';
    name = published.split('/').pop();
  }
  return /^[\w.~-]+$/.test(name) ? `inline; filename="${name}"` : `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
};

/** The Content-Type for a file, by its ending. */
export function typeFor(file) {
  const dot = file.lastIndexOf('.');
  const ending = dot === -1 || file.lastIndexOf('/') > dot ? '' : file.slice(dot + 1).toLowerCase();
  return TYPES[ending] ?? 'application/octet-stream';
}

/** Whether a file of this type is worth compressing, as Vercel does for text. */
export function isCompressible(type) {
  return /^(text\/|application\/(javascript|json|xml|manifest\+json|wasm)|image\/svg\+xml)/.test(type);
}
