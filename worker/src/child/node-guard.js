// Preloaded with `node --import` into the render process. Every outbound TCP connection made from
// Node (Remotion's asset downloads, fetch, http, tls, ws) passes through isAllowed().
import net from 'node:net';
import dns from 'node:dns';
import { isAllowed, recordBlocked } from './egress.js';

const origConnect = net.Socket.prototype.connect;

function denied(socket, host, port) {
  recordBlocked(host, port);
  const err = Object.assign(new Error(`Darkroom: network access to ${host}:${port} is blocked`), { code: 'ECONNREFUSED' });
  process.nextTick(() => socket.destroy(err));
  return socket;
}

function guardedLookup(port) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const bad = addrs.find((a) => !isAllowed({ host: hostname, ip: a.address, port }));
      if (bad || !addrs.length) {
        recordBlocked(hostname, port);
        return cb(Object.assign(new Error(`Darkroom: network access to ${hostname} is blocked`), { code: 'ECONNREFUSED' }));
      }
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

net.Socket.prototype.connect = function guardedConnect(...args) {
  // Forms: (options[, cb]) | (port[, host][, cb]) | (path[, cb]) | ([normalizedArgs])
  let options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options !== 'object' || options === null) {
    if (typeof options === 'string' && !/^\d+$/.test(options)) return origConnect.apply(this, args); // unix socket path
    const port = Number(options);
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    const cb = args.find((a) => typeof a === 'function');
    options = { port, host };
    args = cb ? [options, cb] : [options];
  }
  if (options.path) return origConnect.apply(this, args); // unix sockets (local IPC only)
  const host = String(options.host || 'localhost').replace(/^\[|\]$/g, '');
  const port = Number(options.port);
  if (net.isIP(host)) {
    if (!isAllowed({ host: null, ip: host, port })) return denied(this, host, port);
  } else {
    options.lookup = guardedLookup(port);
  }
  return origConnect.apply(this, args);
};

/** Unguarded connect for the filtering proxy, which has already checked the destination. */
globalThis.__darkroomRawConnect = (opts) => {
  const s = new net.Socket();
  origConnect.call(s, opts);
  return s;
};
