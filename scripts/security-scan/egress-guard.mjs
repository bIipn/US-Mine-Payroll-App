#!/usr/bin/env node
// A proxy on 127.0.0.1 that a security scan is run through, so that the scanner and the browser
// it drives can reach StackHawk's own servers, the three scan targets on this machine, and
// nothing else.
//
//   node egress-guard.mjs [--port 4480] [--log <file>] [--allow host,host] [--local 127.0.0.1:port,...]
//
// Why it is there: a scanner's crawl can be led off its host, and its browser makes calls of its
// own. The scanning engine has two ways out, and each scan config gives this guard to both:
// hawk.outboundProxy for its sign-in and its calls to StackHawk, and network.connection.httpProxy
// (under hawk.config) for its crawl, its attacks and what it fetches for its browser. up.mjs gives
// it to the hawk launcher as its HTTPS proxy. What they send off this machine is answered 403 here
// and goes nowhere, whatever the machine's own network allows. Every request it lets through or
// refuses is one line in the log. The log covers what was sent through the guard and nothing
// else: a connection made around it is not in it, which is why up.mjs also refuses to run hawk
// where a live host can be reached by name.
//
// It allows a CONNECT to port 443 of the hosts on its list, and hands it to the proxy named in
// HTTPS_PROXY when there is one. It allows a CONNECT to the three scan targets on this machine
// (the local server, the website copy and the dashboard copy), because the engine's sign-in sends
// those through it, and makes that one itself, never through another proxy. It never reads what
// goes through a tunnel. Anything else is refused: another host, another port of this machine
// (the database ports among them), a plain HTTP request.

import { appendFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DASHBOARD_PORT, HOST, LOCAL_SERVER, WEBSITE_PORT } from './sites/layout.mjs';

export const GUARD_HOST = '127.0.0.1';
export const GUARD_PORT = 4480;

/** The address the scan configs give the scanning engine as its outbound proxy. */
export const GUARD_URL = `http://${GUARD_HOST}:${GUARD_PORT}`;

/** What a scan needs outside this machine: the platform it reports to, signs in to and updates from. */
export const STACKHAWK_HOSTS = ['api.stackhawk.com', 'auth.stackhawk.com', 'download.stackhawk.com'];

/** The scan targets on this machine: the local server, the website copy and the dashboard copy. */
export const LOCAL_TARGETS = [`${HOST}:${new URL(LOCAL_SERVER).port}`, `${HOST}:${WEBSITE_PORT}`, `${HOST}:${DASHBOARD_PORT}`];

/** Whether a CONNECT target is one of the scan targets on this machine, named exactly. */
export function isLocalTarget(target, locals) {
  return typeof target === 'string' && locals.includes(target.toLowerCase());
}

/** Whether a CONNECT target ("host:port") may pass. Names are compared whole: no pattern, no suffix. */
export function mayPass(target, allowed) {
  const match = /^([a-z0-9.-]+):(\d+)$/i.exec(target ?? '');
  if (!match) return false;
  return Number(match[2]) === 443 && allowed.includes(match[1].toLowerCase());
}

/** The proxy the machine itself sends outbound HTTPS through, if it has one. */
export function upstreamFrom(env = process.env) {
  const named = env.HTTPS_PROXY || env.https_proxy;
  if (!named) return null;
  const url = new URL(named);
  return { host: url.hostname, port: Number(url.port || 80) };
}

/** Starts the guard. Resolves with the server once it is listening. */
export function startGuard({ port = GUARD_PORT, allowed = STACKHAWK_HOSTS, locals = LOCAL_TARGETS, upstream = upstreamFrom(), logFile = null } = {}) {
  const log = (line) => {
    if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  };

  // A plain HTTP request through the proxy is never needed, so it is never passed on.
  const server = http.createServer((request, response) => {
    let host = request.headers.host ?? '';
    try {
      host = new URL(request.url).host || host;
    } catch {
      // Not an absolute address: the Host header is all there is.
    }
    log({ verdict: 'refused', method: request.method, target: host, why: 'not a CONNECT' });
    response.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
    response.end('The scan guard passes nothing but HTTPS to StackHawk and to the scan targets on this machine.\n');
  });

  server.on('connect', (request, client, head) => {
    const target = request.url;
    client.on('error', () => {});
    const local = isLocalTarget(target, locals);
    if (!local && !mayPass(target, allowed)) {
      log({ verdict: 'refused', method: 'CONNECT', target });
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nThe scan guard does not let a scan reach this host.\n');
      return;
    }
    const [host, portText] = target.split(':');
    // A target on this machine is reached directly: the machine's own proxy is for the outside.
    const via = local ? null : upstream;
    const out = via ? net.connect(via.port, via.host) : net.connect(Number(portText), host);
    const refuse = (status, why) => {
      log({ verdict: 'failed', method: 'CONNECT', target, why });
      if (client.writable) client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      out.destroy();
    };
    out.on('error', (error) => refuse('502 Bad Gateway', error.code ?? error.message));
    out.on('connect', () => {
      if (!via) {
        log({ verdict: 'allowed', method: 'CONNECT', target, ...(local ? { local: true } : {}) });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) out.write(head);
        client.pipe(out);
        out.pipe(client);
        return;
      }
      // Ask the machine's own proxy for the tunnel, and join the two once it says yes.
      out.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      let answer = Buffer.alloc(0);
      const onData = (chunk) => {
        answer = Buffer.concat([answer, chunk]);
        const end = answer.indexOf('\r\n\r\n');
        if (end === -1) {
          if (answer.length > 16 * 1024) refuse('502 Bad Gateway', 'the upstream proxy sent no answer');
          return;
        }
        out.off('data', onData);
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(answer.toString('latin1'))?.[1];
        if (status !== '200') {
          refuse(`${status === '403' || status === '407' ? '403 Forbidden' : '502 Bad Gateway'}`, `the upstream proxy answered ${status ?? 'something unreadable'}`);
          return;
        }
        log({ verdict: 'allowed', method: 'CONNECT', target });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = answer.subarray(end + 4);
        if (rest.length > 0) client.write(rest);
        if (head.length > 0) out.write(head);
        client.pipe(out);
        out.pipe(client);
      };
      out.on('data', onData);
    });
    client.on('close', () => out.destroy());
    out.on('close', () => client.destroy());
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, GUARD_HOST, () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? null : args[at + 1];
  };
  const port = Number(value('port') ?? GUARD_PORT);
  const allowed = (value('allow') ?? STACKHAWK_HOSTS.join(',')).split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  const localList = value('local');
  const locals = localList === null ? LOCAL_TARGETS : localList === 'none' ? [] : localList.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (locals.some((t) => !/^127\.0\.0\.1:\d+$/.test(t))) {
    console.error('--local takes 127.0.0.1:<port> targets only, separated by commas, or "none".');
    process.exit(1);
  }
  const logFile = value('log') ? path.resolve(value('log')) : null;
  const upstream = upstreamFrom();
  // The guard must never be its own upstream.
  if (upstream && upstream.port === port && ['127.0.0.1', 'localhost'].includes(upstream.host)) {
    console.error(`HTTPS_PROXY names this guard's own address. Start the guard with the machine's own proxy in HTTPS_PROXY, or with none.`);
    process.exit(1);
  }
  startGuard({ port, allowed, locals, upstream, logFile }).then((server) => {
    console.log(`Scan guard: http://${GUARD_HOST}:${port} passes HTTPS to ${allowed.join(', ')}${upstream ? ` by way of ${upstream.host}:${upstream.port}` : ''}, tunnels to ${locals.join(', ') || 'nothing on this machine'}, and refuses everything else.`);
    const stop = () => { server.close(); server.closeAllConnections(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
