import { createHash, randomBytes } from 'node:crypto';
import { query } from './db.js';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** @param {'dr_live_'|'drw_'} prefix */
export const newToken = (prefix) => prefix + randomBytes(32).toString('base64url');

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bearer = (req) => {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
};

// Throttle last_used/last_seen writes to once a minute per credential.
const touched = new Map();
const shouldTouch = (id) => {
  const now = Date.now();
  if ((touched.get(id) || 0) > now - 60_000) return false;
  touched.set(id, now);
  return true;
};

export async function apiKeyAuth(req, _res, next) {
  try {
    const token = bearer(req);
    if (!token || !token.startsWith('dr_live_')) throw new HttpError(401, 'unauthorized', 'Missing or invalid API key');
    const hash = hashToken(token);
    const { rows } = await query(
      `SELECT k.id AS key_id, a.id, a.limits, a.webhook_secret
         FROM api_keys k JOIN accounts a ON a.id = k.account_id
        WHERE k.hash = $1 AND k.revoked_at IS NULL`,
      [hash],
    );
    if (!rows[0]) throw new HttpError(401, 'unauthorized', 'Missing or invalid API key');
    const r = rows[0];
    req.account = { id: r.id, limits: r.limits, keyId: r.key_id };
    if (shouldTouch(r.key_id)) query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [r.key_id]).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}

export async function workerAuth(req, _res, next) {
  try {
    const token = bearer(req);
    if (!token || !token.startsWith('drw_')) throw new HttpError(401, 'unauthorized', 'Missing or invalid worker token');
    const { rows } = await query(
      'SELECT id, name FROM workers WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(token)],
    );
    if (!rows[0]) throw new HttpError(401, 'unauthorized', 'Missing or invalid worker token');
    req.worker = rows[0];
    if (shouldTouch(rows[0].id)) query('UPDATE workers SET last_seen_at = now() WHERE id = $1', [rows[0].id]).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}
