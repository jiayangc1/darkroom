import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import config from './config.js';

/** True only for globally routable unicast addresses. Keep in sync with worker/src/child/egress.js. */
export function isPublicIp(ip) {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
  if (addr.range() !== 'unicast') return false;
  if (addr.kind() === 'ipv4') {
    // ipaddr.js labels some special-purpose blocks as unicast; reject them explicitly.
    const blocked = ['0.0.0.0/8', '100.64.0.0/10', '192.0.0.0/24', '198.18.0.0/15', '240.0.0.0/4'];
    if (blocked.some((c) => addr.match(ipaddr.parseCIDR(c)))) return false;
  }
  return true;
}

export class UrlRejected extends Error {
  constructor(message) {
    super(message);
    this.code = 'url_rejected';
  }
}

/** Validate that a URL is http(s) and every address it resolves to is public. Returns the parsed URL. */
export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRejected('Invalid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.allowHttpWebhooks)) {
    throw new UrlRejected('URL must use https');
  }
  if (url.username || url.password) throw new UrlRejected('URL must not contain credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (ipaddr.isValid(host)) addrs = [host];
  else {
    try {
      addrs = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new UrlRejected(`Cannot resolve ${host}`);
    }
  }
  if (!addrs.length || !addrs.every(isPublicIp)) throw new UrlRejected('URL must resolve to public addresses only');
  return url;
}
