// Accounts for people (Clerk users) and for the owner's own admin-made accounts.
import { randomUUID, randomBytes } from 'node:crypto';
import { clerkClient } from '@clerk/express';
import config from './config.js';
import { pool, tx } from './db.js';
import { approveAccount } from './billing/ledger.js';

export const newWebhookSecret = () => 'whsec_' + randomBytes(24).toString('base64url');

export async function createAccount(c, { name, email = null, clerkUserId = null, plan = 'waitlist' }) {
  const { rows } = await c.query(
    `INSERT INTO accounts (id, name, email, clerk_user_id, plan, webhook_secret)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [randomUUID(), name, email, clerkUserId, plan, newWebhookSecret()],
  );
  return rows[0];
}

/** The account behind a Clerk user, created on first sight (waitlist, or trial in open signup). */
export async function accountForClerkUser(userId) {
  const found = await pool.query('SELECT * FROM accounts WHERE clerk_user_id = $1', [userId]);
  if (found.rows[0]) return found.rows[0];

  const user = await clerkClient.users.getUser(userId);
  const email = user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress || null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || email || userId;
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO accounts (id, name, email, clerk_user_id, plan, webhook_secret)
       VALUES ($1, $2, $3, $4, 'waitlist', $5)
       ON CONFLICT (clerk_user_id) DO NOTHING RETURNING *`,
      [randomUUID(), name, email, userId, newWebhookSecret()],
    );
    if (!rows[0]) return (await c.query('SELECT * FROM accounts WHERE clerk_user_id = $1', [userId])).rows[0]; // raced
    if (config.signupMode === 'open') return approveAccount(c, rows[0].id, { by: 'open-signup' });
    return rows[0];
  });
}

export async function revokeAllKeys(c, accountId) {
  await c.query('UPDATE api_keys SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL', [accountId]);
}

/** Disable an account: keys stop working, the dashboard refuses it; jobs and ledger stay for records. */
export async function disableAccount(c, accountId) {
  await c.query('UPDATE accounts SET disabled_at = coalesce(disabled_at, now()) WHERE id = $1', [accountId]);
  await revokeAllKeys(c, accountId);
}
