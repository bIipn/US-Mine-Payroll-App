// Run with: node --test "scripts/security-scan/sites/test/*.node.mjs"
// These are not part of the app's jest run: a name ending in .test.mjs would be picked up by it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  DEFAULT_CACHE_CONTROL, decide, dispositionFor, fileFor, headersFor, isNeverServed, readConfig, readPath, sourceToRegex, typeFor,
} from '../vercel-rules.mjs';

const repo = new URL('../../../../', import.meta.url);
const siteConfig = JSON.parse(readFileSync(new URL('site/vercel.json', repo), 'utf8'));
const dashboardConfig = JSON.parse(readFileSync(new URL('dashboard/vercel.json', repo), 'utf8'));
const site = readConfig(siteConfig);
const dashboard = readConfig(dashboardConfig);

// The website's files, as site/ lays them out, and a dashboard build.
const siteFiles = new Set([
  'index.html', '404.html', 'pricing.html', 'contact.html', 'security.html', 'privacy.html', 'terms.html',
  'contact.js', 'site.js', 'site.css', 'robots.txt', 'sitemap.xml', 'favicon.png', 'vercel.json',
  'demo/index.html', '3d/three.module.min.js', '3d/logo3d.js', 'fonts/barlow-500.woff2', 'brand/og-image.png', 'shots/crew.webp',
]);
const dashboardFiles = new Set(['index.html', 'favicon.png', 'assets/index-abc123.js', 'assets/index-abc123.css', 'fonts/barlow-500.woff2']);

const header = (headers, name) => headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;

// What Vercel's own getTransformedRoutes (@vercel/routing-utils 6.6.1) makes of each source the
// two files use. A source that is not in this table fails the first test until it is added.
const VERCEL_MAKES = {
  '/((?!demo(?:/|$)).*)': '^(?:/((?!demo(?:/|$)).*))$',
  '/demo': '^/demo$',
  '/demo/(.*)': '^/demo(?:/(.*))$',
  '/3d/three.module.min.js': '^/3d/three\\.module\\.min\\.js$',
  '/fonts/(.*)': '^/fonts(?:/(.*))$',
  '/(brand|shots)/(.*)': '^(?:/(brand|shots))(?:/(.*))$',
  '/(.*)': '^(?:/(.*))$',
  '/assets/(.*)': '^/assets(?:/(.*))$',
};

test('every source in the two vercel.json files becomes the expression Vercel makes of it', () => {
  const sources = [
    ...siteConfig.headers.map((h) => h.source),
    ...dashboardConfig.headers.map((h) => h.source),
    ...dashboardConfig.rewrites.map((r) => r.source),
  ];
  assert.equal(new Set(sources).size, Object.keys(VERCEL_MAKES).length, 'a source was added to or taken out of a vercel.json');
  for (const source of sources) {
    assert.ok(source in VERCEL_MAKES, `${source} is not covered by these tests`);
    // Vercel writes a slash plain; a RegExp's source writes it escaped. They are the same expression.
    assert.equal(sourceToRegex(source).regex.source.replaceAll('\\/', '/'), VERCEL_MAKES[source]);
  }
});

test('each source matches the paths it should, and no others', () => {
  const cases = {
    '/((?!demo(?:/|$)).*)': {
      yes: ['/', '/pricing', '/contact', '/3d/three.module.min.js', '/demox', '/demo-old', '/demos/x', '/x/demo', '/x/demo/', '/Demo', '/DEMO/x', '/404'],
      no: ['/demo', '/demo/', '/demo/x', '/demo/index.html', '/demo/a/b', '', 'demo'],
    },
    '/demo': { yes: ['/demo'], no: ['/demo/', '/demo/x', '/demox', '/Demo', '/', '/x/demo'] },
    '/demo/(.*)': { yes: ['/demo/', '/demo/x', '/demo/a/b.js'], no: ['/demo', '/demox/', '/Demo/x', '/x/demo/y'] },
    '/3d/three.module.min.js': {
      yes: ['/3d/three.module.min.js'],
      no: ['/3d/three-module-min-js', '/3d/threeXmoduleXminXjs', '/3d/three.module.min.js/', '/3d/logo3d.js', '/3D/three.module.min.js', '/x/3d/three.module.min.js'],
    },
    '/fonts/(.*)': { yes: ['/fonts/', '/fonts/barlow-500.woff2', '/fonts/a/b'], no: ['/fonts', '/fontsx/a', '/x/fonts/a', '/Fonts/a'] },
    '/(brand|shots)/(.*)': {
      yes: ['/brand/og-image.png', '/shots/crew.webp', '/brand/', '/shots/a/b'],
      no: ['/brand', '/shots', '/brands/x', '/shot/x', '/x/brand/y', '/Brand/x'],
    },
    '/(.*)': { yes: ['/', '/billing', '/assets/x.js', '/a/b/c', '/index.html'], no: ['', 'billing'] },
    '/assets/(.*)': { yes: ['/assets/', '/assets/index-abc123.js', '/assets/a/b'], no: ['/assets', '/assetsx/a', '/x/assets/a', '/Assets/a'] },
  };
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(VERCEL_MAKES).sort());
  for (const [source, { yes, no }] of Object.entries(cases)) {
    const { regex } = sourceToRegex(source);
    for (const path of yes) assert.ok(regex.test(path), `${source} should match ${path}`);
    for (const path of no) assert.ok(!regex.test(path), `${source} should not match ${path}`);
  }
});

test('every path on the website gets exactly one Content-Security-Policy', () => {
  const policyRules = site.headerRules.filter((rule) => rule.headers.some((h) => h.key === 'Content-Security-Policy'));
  assert.equal(policyRules.length, 3);
  for (const path of ['/', '/pricing', '/demo', '/demo/', '/demo/x/y', '/demox', '/nope', '/fonts/a.woff2', '/3d/three.module.min.js', '/api/x', '/Demo', '/%64emo']) {
    assert.equal(policyRules.filter((rule) => rule.regex.test(path)).length, 1, path);
  }
});

test('the website: the strict policy everywhere but the demo, which has its own', () => {
  const home = headersFor(site, '/');
  assert.match(header(home, 'Content-Security-Policy'), /script-src 'self' 'sha256-/);
  assert.equal(header(home, 'X-Frame-Options'), 'DENY');
  assert.equal(header(home, 'Strict-Transport-Security'), 'max-age=63072000');
  assert.equal(header(home, 'X-Robots-Tag'), undefined);
  assert.equal(header(home, 'Cache-Control'), undefined);

  for (const path of ['/demo', '/demo/', '/demo/anything']) {
    const demo = headersFor(site, path);
    assert.match(header(demo, 'Content-Security-Policy'), /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'; .*connect-src 'none'/, path);
    assert.equal(header(demo, 'X-Robots-Tag'), 'noindex', path);
    assert.match(header(demo, 'Permissions-Policy'), /geolocation=\(self\)/, path);
  }
  // A path that only starts like the demo's is not the demo.
  assert.match(header(headersFor(site, '/demox'), 'Content-Security-Policy'), /'sha256-/);
});

test('the website: Cache-Control comes from the rule for the path, or is left to the default', () => {
  assert.equal(header(headersFor(site, '/3d/three.module.min.js'), 'Cache-Control'), 'public, max-age=2592000');
  assert.equal(header(headersFor(site, '/fonts/barlow-500.woff2'), 'Cache-Control'), 'public, max-age=2592000');
  assert.equal(header(headersFor(site, '/brand/og-image.png'), 'Cache-Control'), 'public, max-age=86400, stale-while-revalidate=604800');
  assert.equal(header(headersFor(site, '/shots/crew.webp'), 'Cache-Control'), 'public, max-age=86400, stale-while-revalidate=604800');
  assert.equal(header(headersFor(site, '/3d/logo3d.js'), 'Cache-Control'), undefined);
  assert.equal(header(headersFor(site, '/site.css'), 'Cache-Control'), undefined);
  // The rules for a path add up: the font keeps the policy headers too.
  assert.equal(header(headersFor(site, '/fonts/barlow-500.woff2'), 'X-Content-Type-Options'), 'nosniff');
  assert.equal(DEFAULT_CACHE_CONTROL, 'public, max-age=0, must-revalidate');
});

test('a later rule for the same header takes the place of an earlier one', () => {
  const rules = readConfig({
    headers: [
      { source: '/(.*)', headers: [{ key: 'Cache-Control', value: 'first' }, { key: 'X-One', value: '1' }] },
      { source: '/a/(.*)', headers: [{ key: 'cache-control', value: 'second' }] },
    ],
  });
  const found = headersFor(rules, '/a/b');
  assert.equal(header(found, 'Cache-Control'), 'second');
  assert.equal(found.filter((h) => h.key.toLowerCase() === 'cache-control').length, 1);
  assert.equal(header(found, 'X-One'), '1');
  assert.equal(header(headersFor(rules, '/b'), 'Cache-Control'), 'first');
});

test('cleanUrls: a page is served without its ending, and the ending redirects', () => {
  assert.deepEqual(decide(site, siteFiles, '/'), { kind: 'file', status: 200, file: 'index.html', headers: headersFor(site, '/') });
  assert.equal(decide(site, siteFiles, '/pricing').file, 'pricing.html');
  assert.equal(decide(site, siteFiles, '/demo').file, 'demo/index.html');
  assert.equal(decide(site, siteFiles, '/404').file, '404.html');
  assert.equal(decide(site, siteFiles, '/404').status, 200);

  assert.deepEqual(decide(site, siteFiles, '/pricing.html'), { kind: 'redirect', status: 308, location: '/pricing' });
  assert.deepEqual(decide(site, siteFiles, '/pricing.html/'), { kind: 'redirect', status: 308, location: '/pricing' });
  assert.deepEqual(decide(site, siteFiles, '/pricing.html?plan=1&x=%20y'), { kind: 'redirect', status: 308, location: '/pricing?plan=1&x=%20y' });
  assert.deepEqual(decide(site, siteFiles, '/index.html'), { kind: 'redirect', status: 308, location: '/' });
  assert.deepEqual(decide(site, siteFiles, '/index'), { kind: 'redirect', status: 308, location: '/' });
  assert.deepEqual(decide(site, siteFiles, '/demo/index.html'), { kind: 'redirect', status: 308, location: '/demo' });
  assert.deepEqual(decide(site, siteFiles, '/demo/index'), { kind: 'redirect', status: 308, location: '/demo' });
  // A page that is not there redirects all the same: the redirect comes before the files.
  assert.deepEqual(decide(site, siteFiles, '/nope.html'), { kind: 'redirect', status: 308, location: '/nope' });
  // A redirect carries none of the rules' headers: Vercel answers it before it reaches them.
  assert.equal(decide(site, siteFiles, '/pricing.html').headers, undefined);
});

test('with no trailingSlash setting, a last slash changes nothing and redirects nowhere', () => {
  assert.equal(decide(site, siteFiles, '/pricing/').file, 'pricing.html');
  assert.equal(decide(site, siteFiles, '/pricing/').status, 200);
  assert.equal(decide(site, siteFiles, '/demo/').file, 'demo/index.html');
  assert.equal(decide(site, siteFiles, '/site.css/').file, 'site.css');
  // The headers go by the path as it was asked for.
  assert.equal(header(decide(site, siteFiles, '/demo/').headers, 'X-Robots-Tag'), 'noindex');
});

test('other files are served by their own path, and a folder lists nothing', () => {
  assert.equal(decide(site, siteFiles, '/site.css').file, 'site.css');
  assert.equal(decide(site, siteFiles, '/3d/three.module.min.js').file, '3d/three.module.min.js');
  assert.equal(decide(site, siteFiles, '/fonts/barlow-500.woff2?v=2').file, 'fonts/barlow-500.woff2');
  for (const path of ['/fonts', '/fonts/', '/3d', '/brand/']) {
    const answer = decide(site, siteFiles, path);
    assert.equal(answer.status, 404, path);
    assert.equal(answer.file, '404.html', path);
  }
});

test('a path that is not there gets the 404 page with status 404, and the headers for the path asked for', () => {
  const missing = decide(site, siteFiles, '/nope');
  assert.deepEqual({ kind: missing.kind, status: missing.status, file: missing.file }, { kind: 'file', status: 404, file: '404.html' });
  assert.match(header(missing.headers, 'Content-Security-Policy'), /'sha256-/);

  const underDemo = decide(site, siteFiles, '/demo/nope');
  assert.equal(underDemo.status, 404);
  assert.equal(underDemo.file, '404.html');
  assert.match(header(underDemo.headers, 'Content-Security-Policy'), /connect-src 'none'/);

  // Capitals matter, as they do in the names of the files.
  assert.equal(decide(site, siteFiles, '/Pricing').status, 404);
  assert.equal(decide(site, siteFiles, '/DEMO').status, 404);

  // Vercel's 404 page for a site with no framework is for ^(?!/api).*$: a path that starts with
  // /api, whatever follows, is left to the platform's own answer.
  for (const path of ['/api', '/api/anything', '/apiary']) {
    assert.deepEqual(decide(site, siteFiles, path).kind, 'none', path);
    assert.equal(decide(site, siteFiles, path).status, 404, path);
    assert.match(header(decide(site, siteFiles, path).headers, 'Content-Security-Policy'), /'sha256-/, path);
  }
  assert.equal(decide(site, siteFiles, '/ap').file, '404.html');

  // With no 404.html there is nothing of the site's to send.
  const bare = new Set(['index.html']);
  assert.equal(decide(site, bare, '/nope').kind, 'none');
});

test('vercel.json and its like are never served', () => {
  for (const file of ['vercel.json', 'now.json', '.vercelignore', '.nowignore', '.git/config', '.env', '.env.local']) assert.ok(isNeverServed(file), file);
  for (const file of ['index.html', 'robots.txt', 'demo/vercel.json', '.well-known/security.txt']) assert.ok(!isNeverServed(file), file);
  const withSecrets = new Set([...siteFiles, '.env.local', '.git/config']);
  for (const path of ['/vercel.json', '/.env.local', '/.git/config']) {
    const answer = decide(site, withSecrets, path);
    assert.equal(answer.status, 404, path);
    assert.equal(answer.file, '404.html', path);
  }
});

test('nothing outside the list of files can be asked for', () => {
  for (const target of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/demo/..%2f..%2f..%2fetc/passwd', '/..\\..\\etc\\passwd', '/demo/%2e%2e/%2e%2e/vercel.json', '/./vercel.json']) {
    const answer = decide(site, siteFiles, target);
    assert.ok(answer.kind === 'redirect' || answer.status === 404, `${target} gave ${JSON.stringify(answer).slice(0, 80)}`);
    if (answer.kind === 'file') assert.equal(answer.file, '404.html', target);
  }
  // Dots that climb are settled before a file is looked for, so this is just the pricing page.
  assert.equal(decide(site, siteFiles, '/demo/../pricing').file, 'pricing.html');
  assert.match(header(decide(site, siteFiles, '/demo/../pricing').headers, 'Content-Security-Policy'), /'sha256-/);
  assert.equal(fileFor(site, siteFiles, '/demo/../index.html'), null);
});

test('a path that cannot be read is turned back', () => {
  for (const target of ['/%zz', '/%', '/%00', '/a%0d%0ab', '/%E0%A4%A', 'http://elsewhere.example/', 'pricing', '', '*']) {
    assert.deepEqual(decide(site, siteFiles, target), { kind: 'bad' }, target);
  }
  assert.equal(readPath(undefined), null);
  assert.deepEqual(readPath('/a%20b?x=1#frag'), { path: '/a b', query: '?x=1' });
  assert.deepEqual(readPath('/a#frag?x=1'), { path: '/a', query: '' });
});

test('a redirect never leaves the site', () => {
  const targets = [
    '//elsewhere.example/x.html', '///elsewhere.example/index.html', '/\\elsewhere.example/x.html', '/%2F%2Felsewhere.example/x.html',
    '/%5Celsewhere.example/index.html', '//elsewhere.example', '/a//b.html', '/.html', '//.html', '/%2f/index.html',
    '/https:%2F%2Felsewhere.example/index.html', '/x.html?next=//elsewhere.example',
  ];
  for (const target of targets) {
    // Follow every redirect to its end, as a browser would.
    let at = target;
    for (let hops = 0; hops < 6; hops++) {
      const answer = decide(site, siteFiles, at);
      if (answer.kind !== 'redirect') break;
      assert.match(answer.location, /^\/(?![/\\])/, `${target} redirects to ${answer.location}`);
      assert.doesNotMatch(answer.location.split('?')[0], /\/\/|\\/, `${target} redirects to ${answer.location}`);
      assert.equal(new URL(answer.location, 'https://site.example').host, 'site.example', target);
      at = answer.location;
      assert.ok(hops < 5, `${target} keeps redirecting`);
    }
  }
  assert.deepEqual(decide(site, siteFiles, '//elsewhere.example/x.html'), { kind: 'redirect', status: 308, location: '/elsewhere.example/x.html' });
  assert.deepEqual(decide(site, siteFiles, '/a//b?q=1'), { kind: 'redirect', status: 308, location: '/a/b?q=1' });
  // What a path decodes to is encoded again on its way into the Location header.
  assert.deepEqual(decide(site, siteFiles, '/a%0Ab.html'), { kind: 'bad' });
  assert.deepEqual(decide(site, siteFiles, '/a%20b%3Fc.html'), { kind: 'redirect', status: 308, location: '/a%20b%3Fc' });
});

test('the dashboard: every path that is not a file is the app, by the rewrite', () => {
  assert.equal(dashboard.cleanUrls, false);
  for (const path of ['/', '/billing', '/billing?started=cs_test_1', '/roster/', '/a/b/c', '/index.html', '/nope.html', '/api/x', '/vercel.json', '/Assets/x.js']) {
    const answer = decide(dashboard, dashboardFiles, path);
    assert.deepEqual({ kind: answer.kind, status: answer.status, file: answer.file }, { kind: 'file', status: 200, file: 'index.html' }, path);
    assert.match(header(answer.headers, 'Content-Security-Policy'), /connect-src 'self' https:\/\//, path);
    assert.equal(header(answer.headers, 'Cross-Origin-Opener-Policy'), 'same-origin', path);
    assert.equal(header(answer.headers, 'Strict-Transport-Security'), 'max-age=63072000; includeSubDomains', path);
  }
  assert.equal(decide(dashboard, dashboardFiles, '/favicon.png').file, 'favicon.png');
  const asset = decide(dashboard, dashboardFiles, '/assets/index-abc123.js');
  assert.equal(asset.file, 'assets/index-abc123.js');
  assert.equal(header(asset.headers, 'Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(header(decide(dashboard, dashboardFiles, '/billing').headers, 'Cache-Control'), undefined);

  // The headers go by the path asked for, so a file that is missing under /assets is the app,
  // sent with the long Cache-Control. Vercel does the same.
  const gone = decide(dashboard, dashboardFiles, '/assets/index-old000.js');
  assert.equal(gone.file, 'index.html');
  assert.equal(header(gone.headers, 'Cache-Control'), 'public, max-age=31536000, immutable');

  // A rewrite to a file that is not there is passed over.
  assert.deepEqual(decide(dashboard, new Set(['favicon.png']), '/billing').kind, 'none');
});

test('Content-Disposition is as the live sites send it', () => {
  // Seen on minemuster.com/, /pricing and /demo, and on app.minemuster.com/.
  assert.equal(dispositionFor(site, 'index.html'), 'inline');
  assert.equal(dispositionFor(site, 'pricing.html'), 'inline; filename="pricing"');
  assert.equal(dispositionFor(site, 'demo/index.html'), 'inline; filename="demo"');
  assert.equal(dispositionFor(dashboard, 'index.html'), 'inline');
  // Not seen: worked out the same way.
  assert.equal(dispositionFor(site, '404.html'), 'inline; filename="404"');
  assert.equal(dispositionFor(site, 'site.css'), 'inline; filename="site.css"');
  assert.equal(dispositionFor(dashboard, 'assets/index-abc123.js'), 'inline; filename="index-abc123.js"');
  assert.equal(dispositionFor(site, 'shots/a "b".webp'), "inline; filename*=UTF-8''a%20%22b%22.webp");
});

test('files get the type their ending stands for', () => {
  assert.equal(typeFor('index.html'), 'text/html; charset=utf-8');
  assert.equal(typeFor('site.css'), 'text/css; charset=utf-8');
  assert.equal(typeFor('3d/three.module.min.js'), 'application/javascript; charset=utf-8');
  assert.equal(typeFor('assets/index.js.map'), 'application/json; charset=utf-8');
  assert.equal(typeFor('robots.txt'), 'text/plain; charset=utf-8');
  assert.equal(typeFor('sitemap.xml'), 'application/xml');
  assert.equal(typeFor('favicon.png'), 'image/png');
  assert.equal(typeFor('shots/crew.WEBP'), 'image/webp');
  assert.equal(typeFor('fonts/barlow-500.woff2'), 'font/woff2');
  assert.equal(typeFor('fonts/OFL'), 'application/octet-stream');
  assert.equal(typeFor('a.b/file'), 'application/octet-stream');
});

test('a vercel.json this server would have to guess at is refused', () => {
  assert.throws(() => readConfig({ redirects: [] }), /redirects/);
  assert.throws(() => readConfig({ trailingSlash: false }), /trailingSlash/);
  assert.throws(() => readConfig({ routes: [] }), /routes/);
  assert.throws(() => readConfig({ cleanUrls: 'yes' }), /cleanUrls/);
  assert.throws(() => readConfig({ headers: [{ source: '/(.*)', has: [{ type: 'host', value: 'x' }], headers: [] }] }), /has/);
  assert.throws(() => readConfig({ headers: [{ source: '/:path*', headers: [] }] }), /names a part/);
  assert.throws(() => readConfig({ rewrites: [{ source: '/(.*)', destination: 'https://elsewhere.example/$1' }] }), /one file of the same site/);
  assert.throws(() => readConfig({ rewrites: [{ source: '/(.*)', destination: '/$1.html' }] }), /one file of the same site/);
  // A capturing group written without the lookahead being wrapped is refused by path-to-regexp, as on Vercel.
  assert.throws(() => readConfig({ headers: [{ source: '/(?!demo)(.*)', headers: [] }] }));
});
