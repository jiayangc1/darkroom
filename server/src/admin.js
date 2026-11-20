#!/usr/bin/env node
// Admin CLI: node src/admin.js <command> [...args]
import { randomUUID, randomBytes } from 'node:crypto';
import { pool, query } from './db.js';
import { migrate } from './migrate.js';
import { hashToken, newToken } from './auth.js';

const commands = {
  async 'account:create'(name) {
    if (!name) throw new Error('usage: account:create <name>');
    const id = randomUUID();
    const secret = 'whsec_' + randomBytes(24).toString('base64url');
    // Admin-made accounts are the owner's own (unbilled); change with account:plan.
    await query("INSERT INTO accounts (id, name, webhook_secret, plan) VALUES ($1, $2, $3, 'internal')", [id, name, secret]);
    console.log(`account id:      ${id}\nwebhook secret:  ${secret}`);
  },
  async 'account:list'() {
    const { rows } = await query('SELECT id, name, plan, balance_micro, limits, created_at FROM accounts ORDER BY created_at');
    console.table(rows);
  },
  async 'account:limits'(id, json) {
    if (!id || !json) throw new Error('usage: account:limits <accountId> \'{"maxActiveJobs":10}\'');
    const { rowCount } = await query('UPDATE accounts SET limits = $2::jsonb WHERE id = $1', [id, JSON.stringify(JSON.parse(json))]);
    if (!rowCount) throw new Error('account not found');
    console.log('updated');
  },
  async 'account:plan'(id, plan) {
    if (!id || !['waitlist', 'trial', 'paid', 'internal'].includes(plan)) {
      throw new Error('usage: account:plan <accountId> waitlist|trial|paid|internal');
    }
    const { rowCount } = await query('UPDATE accounts SET plan = $2 WHERE id = $1', [id, plan]);
    if (!rowCount) throw new Error('account not found');
    console.log('updated');
  },
  async 'key:create'(accountId, label) {
    if (!accountId) throw new Error('usage: key:create <accountId> [label]');
    const token = newToken('dr_live_');
    const id = randomUUID();
    await query('INSERT INTO api_keys (id, account_id, prefix, hash, label) VALUES ($1, $2, $3, $4, $5)', [
      id, accountId, token.slice(0, 12), hashToken(token), label || null,
    ]);
    console.log(`key id:  ${id}\nAPI key: ${token}\n(shown once — store it now)`);
  },
  async 'key:list'(accountId) {
    const { rows } = await query(
      'SELECT id, account_id, prefix, label, created_at, last_used_at, revoked_at FROM api_keys WHERE ($1::uuid IS NULL OR account_id = $1) ORDER BY created_at',
      [accountId || null],
    );
    console.table(rows);
  },
  async 'key:revoke'(id) {
    if (!id) throw new Error('usage: key:revoke <keyId>');
    const { rowCount } = await query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    console.log(rowCount ? 'revoked' : 'not found / already revoked');
  },
  async 'worker:create'(name) {
    if (!name) throw new Error('usage: worker:create <name>');
    const token = newToken('drw_');
    const id = randomUUID();
    await query('INSERT INTO workers (id, name, token_hash) VALUES ($1, $2, $3)', [id, name, hashToken(token)]);
    console.log(`worker id:    ${id}\nworker token: ${token}\n(shown once — put it in the worker's .env)`);
  },
  // Register a token generated elsewhere, so the plaintext never appears in server logs:
  //   T="drw_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"; printf %s "$T" | shasum -a 256
  async 'worker:register'(name, tokenHash) {
    if (!name || !/^[0-9a-f]{64}$/.test(tokenHash || '')) throw new Error('usage: worker:register <name> <sha256-hex of token>');
    const id = randomUUID();
    await query('INSERT INTO workers (id, name, token_hash) VALUES ($1, $2, $3)', [id, name, tokenHash]);
    console.log(`worker id: ${id}`);
  },
  async 'worker:list'() {
    const { rows } = await query('SELECT id, name, created_at, last_seen_at, revoked_at FROM workers ORDER BY created_at');
    console.table(rows);
  },
  async 'worker:revoke'(id) {
    if (!id) throw new Error('usage: worker:revoke <workerId>');
    const { rowCount } = await query('UPDATE workers SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    console.log(rowCount ? 'revoked' : 'not found / already revoked');
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log(`commands:\n  ${Object.keys(commands).join('\n  ')}`);
  process.exit(cmd ? 1 : 0);
}
try {
  await migrate();
  await commands[cmd](...args);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
