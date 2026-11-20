import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { isAllowed, mayResolve, proxyLoopbackPorts, recordBlocked } from './egress.js';

const rawConnect = (opts) => (globalThis.__darkroomRawConnect ? globalThis.__darkroomRawConnect(opts) : net.connect(opts));

/** Connect to the first reachable address. Resolves with a connected socket or rejects. */
function connectAny(ips, port) {
  return new Promise((resolve, reject) => {
    const tryNext = (i) => {
      if (i >= ips.length) return reject(new Error('unreachable'));
      const s = rawConnect({ host: ips[i], port });
      s.once('connect', () => {
        s.removeAllListeners('error');
        resolve(s);
      });
      s.once('error', () => tryNext(i + 1));
    };
    tryNext(0);
  });
}

/** Resolve host and return the permitted IPs (all must be permitted), or null. */
async function resolveAllowed(host, port) {
  const h = host.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(h)) addrs = [{ address: h }];
  else if (!mayResolve(h)) return null; // never look up names we'd refuse anyway
  else {
    try {
      addrs = await dns.lookup(h, { all: true });
    } catch {
      return null;
    }
  }
  if (!addrs.length) return null;
  const hostForCheck = net.isIP(h) ? null : h;
  if (!addrs.every((a) => isAllowed({ host: hostForCheck, ip: a.address, port }, proxyLoopbackPorts))) return null;
  return addrs.map((a) => a.address);
}

/**
 * Local HTTP proxy that Chrome is forced to use (including for loopback). Plain HTTP requests are
 * forwarded; CONNECT is tunneled. Everything goes to the resolved, checked IP — never re-resolved.
 */
export function startProxy() {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    const ips = url.protocol === 'http:' ? await resolveAllowed(url.hostname, port) : null;
    if (!ips) {
      recordBlocked(url.hostname, port);
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Blocked by Darkroom: bundle this asset with staticFile()');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    let sock;
    try {
      sock = await connectAny(ips, port);
    } catch {
      res.writeHead(502).end();
      return;
    }
    const upstream = http.request(
      {
        host: ips[0],
        port,
        method: req.method,
        path: url.pathname + url.search,
        headers,
        createConnection: () => sock,
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });

  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || '');
    if (!m) return client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    const port = Number(m[2]);
    const ips = await resolveAllowed(m[1], port);
    if (!ips) {
      recordBlocked(m[1].replace(/^\[|\]$/g, ''), port);
      return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
    let upstream;
    try {
      upstream = await connectAny(ips, port);
    } catch {
      return client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
