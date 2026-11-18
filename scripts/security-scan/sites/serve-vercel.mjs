#!/usr/bin/env node
// Serves a folder over HTTPS on 127.0.0.1 the way Vercel serves it, going by the folder's
// vercel.json. It exists so a security scanner can be pointed at a private copy of minemuster.com
// and of the dashboard, and never at the live sites.
//
//   node serve-vercel.mjs --home <private folder>                  both copies stage.mjs made
//   node serve-vercel.mjs --home <private folder> --site website   one of them (or dashboard)
//   node serve-vercel.mjs --root <folder> --config <vercel.json> --port <port> --cert <file> --key <file>
//
// The files are read once, when it starts: start it again after stage.mjs has run again.
// README.md lists what it does the same as Vercel and what it does differently.

import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { DASHBOARD_PORT, HOST, WEBSITE_PORT, homeFrom, layout, readArgs, tlsFor } from './layout.mjs';
import {
  DEFAULT_CACHE_CONTROL, DEFAULT_HSTS, decide, dispositionFor, isCompressible, isNeverServed, readConfig, typeFor,
} from './vercel-rules.mjs';

/** Every file under a folder, by its path from the folder, held in memory. Links are not followed. */
export function loadFiles(root) {
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile() && !isNeverServed(rel)) {
        const body = readFileSync(full);
        const type = typeFor(rel);
        files.set(rel, {
          body,
          type,
          etag: createHash('md5').update(body).digest('hex'),
          modified: new Date(Math.floor(stat.mtimeMs / 1000) * 1000),
          compressible: isCompressible(type) && body.length >= 1024,
          packed: {},
        });
      }
    }
  };
  walk(root, '');
  return files;
}

function packed(entry, encoding) {
  if (!entry.packed[encoding]) {
    entry.packed[encoding] = encoding === 'br'
      ? zlib.brotliCompressSync(entry.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.body.length } })
      : zlib.gzipSync(entry.body, { level: 6 });
  }
  return entry.packed[encoding];
}

function encodingFor(request) {
  const accepts = String(request.headers['accept-encoding'] ?? '').toLowerCase().split(',').map((part) => part.trim().split(';')[0]);
  if (accepts.includes('br')) return 'br';
  if (accepts.includes('gzip')) return 'gzip';
  return null;
}

/** The request handler for one site. `log` is called with a line for each answer. */
export function handlerFor({ rules, files, log = () => {} }) {
  const send = (request, response, status, headers, body, chunked = false) => {
    try {
      for (const [key, value] of headers) response.setHeader(key, value);
    } catch {
      // A header the path made that cannot be sent: answer as for a path that cannot be read.
      for (const name of response.getHeaderNames()) response.removeHeader(name);
      status = 400;
      body = Buffer.from('Bad Request\n');
      chunked = false;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', DEFAULT_CACHE_CONTROL);
    }
    response.statusCode = status;
    // Vercel sends no Connection or Keep-Alive header. The connection is kept open all the same.
    response.removeHeader('Connection');
    const empty = request.method === 'HEAD' || status === 304;
    if (status === 304) {
      response.end();
    } else if (chunked) {
      if (!empty) response.write(body);
      response.end();
    } else {
      response.setHeader('Content-Length', body.length);
      response.end(empty ? undefined : body);
    }
    log({ method: request.method, url: request.url, status });
  };

  // What Vercel adds when no rule has said otherwise.
  const withDefaults = (ruleHeaders) => {
    const headers = ruleHeaders.map(({ key, value }) => [key, value]);
    const has = (name) => headers.some(([key]) => key.toLowerCase() === name);
    if (!has('cache-control')) headers.push(['Cache-Control', DEFAULT_CACHE_CONTROL]);
    if (!has('strict-transport-security')) headers.push(['Strict-Transport-Security', DEFAULT_HSTS]);
    return headers;
  };

  return (request, response) => {
    request.resume();
    const answer = decide(rules, files, request.url);

    if (answer.kind === 'bad') {
      send(request, response, 400, [...withDefaults([]), ['Content-Type', 'text/plain; charset=utf-8']], Buffer.from('Bad Request\n'));
      return;
    }
    if (answer.kind === 'redirect') {
      send(request, response, answer.status, [
        ...withDefaults([]),
        ['Location', answer.location],
        ['Refresh', `0;url=${answer.location}`],
        ['Content-Type', 'text/plain'],
      ], Buffer.from('Redirecting...\n'));
      return;
    }

    const headers = withDefaults(answer.headers);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(request, response, 405, [...headers, ['Allow', 'GET, HEAD'], ['Content-Type', 'text/plain; charset=utf-8']], Buffer.from('Method Not Allowed\n'));
      return;
    }
    if (answer.kind === 'none') {
      send(request, response, 404, [...headers, ['Content-Type', 'text/plain; charset=utf-8']], Buffer.from('The page could not be found\n\nNOT_FOUND\n'));
      return;
    }

    const entry = files.get(answer.file);
    const encoding = entry.compressible ? encodingFor(request) : null;
    const etag = encoding ? `W/"${entry.etag}"` : `"${entry.etag}"`;
    headers.push(
      ['Access-Control-Allow-Origin', '*'],
      ['Content-Disposition', dispositionFor(rules, answer.file)],
      ['Content-Type', entry.type],
      ['ETag', etag],
      ['Last-Modified', entry.modified.toUTCString()],
    );
    if (encoding) headers.push(['Content-Encoding', encoding]);

    const asked = String(request.headers['if-none-match'] ?? '');
    const same = asked.split(',').some((tag) => tag.trim().replace(/^W\//, '') === `"${entry.etag}"`);
    if (answer.status === 200 && same) {
      send(request, response, 304, headers, Buffer.alloc(0));
      return;
    }
    // Vercel streams a compressed file, and gives the length of one sent as it is.
    send(request, response, answer.status, headers, encoding ? packed(entry, encoding) : entry.body, Boolean(encoding));
  };
}

/** Starts one site. Resolves once it is listening. */
export function serve({ name, root, config, port, cert, key, logFile }) {
  const rules = readConfig(JSON.parse(readFileSync(config, 'utf8')));
  const files = loadFiles(root);
  if (files.size === 0) throw new Error(`${root} has no files. Run stage.mjs first.`);
  const log = logFile
    ? (line) => appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), site: name, ...line })}\n`)
    : () => {};
  const server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, handlerFor({ rules, files, log }));
  // A client that breaks off in the middle of a request is the client's business.
  server.on('clientError', (error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      console.log(`${name}: https://${HOST}:${port}/ serves ${files.size} files from ${root} by ${config}`);
      resolve(server);
    });
  });
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const sites = [];
  if (args.root) {
    for (const need of ['config', 'port', 'cert', 'key']) {
      if (typeof args[need] !== 'string') throw new Error(`With --root, say --${need} as well.`);
    }
    sites.push({ name: path.basename(String(args.root)), root: path.resolve(String(args.root)), config: path.resolve(args.config), port: Number(args.port), cert: args.cert, key: args.key });
  } else {
    const home = homeFrom(args);
    const at = layout(home);
    const tls = tlsFor(home);
    console.log(`Certificate: ${tls.cert} (${tls.from === 'stack' ? 'the local server\'s own' : 'made for the copies of the sites'}, good until ${tls.until})`);
    const all = {
      website: { name: 'website', root: at.website, config: at.websiteConfig, port: WEBSITE_PORT },
      dashboard: { name: 'dashboard', root: at.dashboard, config: at.dashboardConfig, port: DASHBOARD_PORT },
    };
    const wanted = typeof args.site === 'string' ? [args.site] : Object.keys(all);
    for (const name of wanted) {
      if (!all[name]) throw new Error(`--site is website or dashboard, not ${name}.`);
      sites.push({ ...all[name], cert: tls.cert, key: tls.key });
    }
  }
  const logFile = typeof args.log === 'string' ? path.resolve(args.log) : null;
  const servers = [];
  for (const site of sites) servers.push(await serve({ ...site, logFile }));
  const stop = () => { for (const server of servers) { server.close(); server.closeAllConnections(); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
