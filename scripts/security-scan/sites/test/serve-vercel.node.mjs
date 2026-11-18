// Run with: node --test "scripts/security-scan/sites/test/*.node.mjs"
// The server's own answers, asked for over plain HTTP on a free port of this machine. The files
// are made up here; nothing is read from site/ or dashboard/ but the two vercel.json files.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';

import { handlerFor, loadFiles } from '../serve-vercel.mjs';
import { readConfig } from '../vercel-rules.mjs';

const repo = new URL('../../../../', import.meta.url);
const page = (title) => `<!doctype html><title>${title}</title><p>${'Made up for the test. '.repeat(80)}</p>`;

const root = mkdtempSync(path.join(tmpdir(), 'serve-vercel-test-'));
const write = (rel, body) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
};
write('index.html', page('Home'));
write('pricing.html', page('Pricing'));
write('404.html', page('Not here'));
write('demo/index.html', page('Demo'));
write('site.css', 'body{margin:0}');
write('fonts/a.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3]));
write('vercel.json', '{"secret":"never served"}');
write('.env.local', 'NEVER=served');
symlinkSync('/etc/hostname', path.join(root, 'linked.txt'));

let server;
let base;
const logged = [];

before(async () => {
  const rules = readConfig(JSON.parse(readFileSync(new URL('site/vercel.json', repo), 'utf8')));
  server = http.createServer(handlerFor({ rules, files: loadFiles(root), log: (line) => logged.push(line) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

/** One request, as it was sent: no redirect followed, nothing decompressed, the path left alone. */
function ask(target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(base, { method, path: target, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('a page: the rules for its path, Vercel\'s defaults, and the headers Vercel adds to a file', async () => {
  const home = await ask('/');
  assert.equal(home.status, 200);
  assert.equal(home.body.toString(), page('Home'));
  assert.match(home.headers['content-security-policy'], /^default-src 'self'; script-src 'self' 'sha256-/);
  assert.equal(home.headers['x-frame-options'], 'DENY');
  assert.equal(home.headers['strict-transport-security'], 'max-age=63072000');
  assert.equal(home.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.equal(home.headers['access-control-allow-origin'], '*');
  assert.equal(home.headers['content-disposition'], 'inline');
  assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(home.headers.etag, `"${createHash('md5').update(page('Home')).digest('hex')}"`);
  assert.equal(home.headers['content-length'], String(Buffer.byteLength(page('Home'))));
  assert.ok(!Number.isNaN(Date.parse(home.headers['last-modified'])));
  // Vercel's own markers are not copied.
  for (const name of ['server', 'x-vercel-id', 'x-vercel-cache', 'age', 'vary']) assert.equal(home.headers[name], undefined, name);
  // Nor does this server add any of its own: what is left is the date.
  assert.deepEqual(Object.keys(home.headers).sort(), [
    'access-control-allow-origin', 'cache-control', 'content-disposition', 'content-length', 'content-security-policy', 'content-type', 'date', 'etag',
    'last-modified', 'permissions-policy', 'referrer-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options',
  ]);

  const pricing = await ask('/pricing');
  assert.equal(pricing.body.toString(), page('Pricing'));
  assert.equal(pricing.headers['content-disposition'], 'inline; filename="pricing"');

  const demo = await ask('/demo');
  assert.equal(demo.headers['x-robots-tag'], 'noindex');
  assert.match(demo.headers['content-security-policy'], /script-src 'self' 'unsafe-inline'/);
  assert.equal(demo.headers['content-disposition'], 'inline; filename="demo"');
});

test('a rule\'s Cache-Control takes the place of the default', async () => {
  const font = await ask('/fonts/a.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers['cache-control'], 'public, max-age=2592000');
  assert.equal(font.headers['content-type'], 'font/woff2');
  assert.equal(font.headers['x-content-type-options'], 'nosniff');
  assert.equal(font.headers['content-encoding'], undefined);
});

test('a redirect has a place to go and nothing of the rules', async () => {
  const answer = await ask('/pricing.html?x=1');
  assert.equal(answer.status, 308);
  assert.equal(answer.headers.location, '/pricing?x=1');
  assert.equal(answer.headers.refresh, '0;url=/pricing?x=1');
  assert.equal(answer.headers['content-type'], 'text/plain');
  assert.equal(answer.body.toString(), 'Redirecting...\n');
  assert.equal(answer.headers['content-security-policy'], undefined);
  assert.equal(answer.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.equal(answer.headers['strict-transport-security'], 'max-age=63072000');
  assert.equal((await ask('//elsewhere.example/a.html')).headers.location, '/elsewhere.example/a.html');
});

test('a path that is not there: the 404 page, status 404, with the headers for the path', async () => {
  const missing = await ask('/no-such-page');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.toString(), page('Not here'));
  assert.match(missing.headers['content-security-policy'], /'sha256-/);
  assert.equal(missing.headers['content-type'], 'text/html; charset=utf-8');

  // A 404 is sent whole each time, whatever the browser says it holds.
  const again = await ask('/no-such-page', { headers: { 'if-none-match': missing.headers.etag } });
  assert.equal(again.status, 404);

  const platform = await ask('/api/none');
  assert.equal(platform.status, 404);
  assert.equal(platform.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(platform.body.toString(), /NOT_FOUND/);
});

test('what must never be served is not', async () => {
  for (const target of ['/vercel.json', '/.env.local', '/linked.txt', '/../../../../etc/hostname', '/%2e%2e/%2e%2e/etc/hostname', '/..%2f..%2fetc%2fhostname']) {
    const answer = await ask(target);
    assert.equal(answer.status, 404, target);
    assert.equal(answer.body.toString(), page('Not here'), target);
  }
  for (const target of ['/%00', '/%zz', '/a%0d%0aSet-Cookie:x=1']) {
    const answer = await ask(target);
    assert.equal(answer.status, 400, target);
    assert.equal(answer.headers['set-cookie'], undefined, target);
  }
});

test('compressed for a browser that takes it, with the weak ETag the live sites send', async () => {
  const md5 = createHash('md5').update(page('Home')).digest('hex');
  const br = await ask('/', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.etag, `W/"${md5}"`);
  assert.equal(br.headers['transfer-encoding'], 'chunked');
  assert.equal(br.headers['content-length'], undefined);
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), page('Home'));

  const gzip = await ask('/', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gzip.body).toString(), page('Home'));

  // A small file goes as it is.
  assert.equal((await ask('/site.css', { headers: { 'accept-encoding': 'br' } })).headers['content-encoding'], undefined);
});

test('a browser that holds the file is told so', async () => {
  const first = await ask('/pricing');
  const strong = await ask('/pricing', { headers: { 'if-none-match': first.headers.etag } });
  assert.equal(strong.status, 304);
  assert.equal(strong.body.length, 0);
  assert.match(strong.headers['content-security-policy'], /'sha256-/);
  const weak = await ask('/pricing', { headers: { 'if-none-match': `"other", W/${first.headers.etag}`, 'accept-encoding': 'br' } });
  assert.equal(weak.status, 304);
  assert.equal((await ask('/pricing', { headers: { 'if-none-match': '"something else"' } })).status, 200);
});

test('HEAD gives the headers alone, and other methods are turned back', async () => {
  const head = await ask('/site.css', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], String('body{margin:0}'.length));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    const answer = await ask('/pricing', { method });
    assert.equal(answer.status, 405, method);
    assert.equal(answer.headers.allow, 'GET, HEAD', method);
    assert.equal(answer.headers['access-control-allow-origin'], undefined, method);
    assert.match(answer.headers['content-security-policy'], /'sha256-/, method);
  }
});

test('each answer is noted once, with its status', async () => {
  logged.length = 0;
  await ask('/pricing');
  await ask('/pricing.html');
  await ask('/nope');
  assert.deepEqual(logged, [
    { method: 'GET', url: '/pricing', status: 200 },
    { method: 'GET', url: '/pricing.html', status: 308 },
    { method: 'GET', url: '/nope', status: 404 },
  ]);
});
