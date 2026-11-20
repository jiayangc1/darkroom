import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns';
import https from 'node:https';
import http from 'node:http';
import { assertPublicUrl, isPublicIp } from './url-guard.js';

export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** DNS lookup that refuses non-public answers, so the connection can't be rebound to a private IP after the check. */
function publicOnlyLookup(hostname, options, cb) {
  lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => isPublicIp(a.address));
    if (!ok.length || ok.length !== addrs.length) {
      return cb(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'EPRIVATE' }));
    }
    if (options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

/** POST a signed webhook. Resolves on 2xx, rejects otherwise. Never follows redirects. */
export async function deliver(urlString, secret, payload) {
  const url = await assertPublicUrl(urlString);
  const body = JSON.stringify(payload);
  const mod = url.protocol === 'https:' ? https : http;
  await new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'POST',
        lookup: publicOnlyLookup,
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Darkroom-Webhooks/1',
          'Darkroom-Signature': sign(secret, body),
          'Darkroom-Event': payload.event,
        },
      },
      (res) => {
        clearTimeout(deadline);
        res.destroy(); // the status is all we need; don't let a slow body hold us
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`HTTP ${res.statusCode}`));
      },
    );
    // `timeout` is only an idle timeout; a receiver dribbling bytes could hold us for hours.
    const deadline = setTimeout(() => req.destroy(new Error('deadline exceeded')), 15_000);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.end(body);
  });
}
