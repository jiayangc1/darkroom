import ipaddr from 'ipaddr.js';

/** True only for globally routable unicast addresses. Keep in sync with server/src/url-guard.js. */
export function isPublicIp(ip) {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
  if (addr.range() !== 'unicast') return false;
  if (addr.kind() === 'ipv4') {
    const blocked = ['0.0.0.0/8', '100.64.0.0/10', '192.0.0.0/24', '198.18.0.0/15', '240.0.0.0/4'];
    if (blocked.some((c) => addr.match(ipaddr.parseCIDR(c)))) return false;
  }
  return true;
}

export function isLoopback(ip) {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
  return addr.range() === 'loopback';
}

const allowlist = (process.env.DARKROOM_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Loopback ports Node may use (its own bundle server, Chrome DevTools). */
export const loopbackPorts = new Set();
/** Loopback ports page JS (via the proxy) may use: only the bundle server — never DevTools. */
export const proxyLoopbackPorts = new Set();

/** Hosts that were refused; reported back so the agent knows what to bundle. */
export const blocked = [];

export function recordBlocked(host, port) {
  const label = port ? `${host}:${port}` : host;
  if (!blocked.includes(label) && blocked.length < 50) blocked.push(label);
}

export function hostAllowlisted(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return allowlist.some((a) => h === a || h.endsWith('.' + a));
}

/**
 * Decide a hostname before resolving it, so a refused name never reaches DNS (no leaking data
 * through lookups, no mDNS on the LAN). Only "localhost" and allowlisted names are resolved.
 */
export function mayResolve(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || hostAllowlisted(h);
}

/**
 * Decide one connection. `host` is the requested name (null for IP literals), `ip` the address
 * it resolved to, `port` the destination port.
 */
export function isAllowed({ host, ip, port }, ports = loopbackPorts) {
  if (isLoopback(ip)) return ports.has(Number(port));
  if (!host || ipaddr.isValid(host)) return false; // non-loopback IP literals are never allowed
  return hostAllowlisted(host) && isPublicIp(ip);
}
