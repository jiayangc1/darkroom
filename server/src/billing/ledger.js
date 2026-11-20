// Credit ledger: append-only money movements, with accounts.balance_micro kept equal to their sum.
import { pool } from '../db.js';
import config from '../config.js';
import { ACTIVE } from '../jobs/repo.js';
import { HttpError } from '../auth.js';

/** Lock and return the account row for the rest of the transaction. */
export async function lockAccount(c, accountId) {
  const { rows } = await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Account not found');
  return rows[0];
}

/**
 * Balance minus the holds of this account's active jobs. Holds on finished jobs simply stop
 * counting, so no code path has to clear them. Call with the account locked.
 */
export async function availableMicro(c, accountId, { excludeJobId = null } = {}) {
  const { rows } = await c.query(
    `SELECT a.balance_micro - coalesce((
        SELECT sum(j.hold_micro) FROM jobs j
         WHERE j.account_id = a.id AND j.status = ANY($2) AND j.hold_micro IS NOT NULL
           AND ($3::uuid IS NULL OR j.id <> $3)), 0) AS available
       FROM accounts a WHERE a.id = $1`,
    [accountId, ACTIVE, excludeJobId],
  );
  return Number(rows[0]?.available ?? 0);
}

/**
 * Append a ledger entry and move the balance by the same amount, in the caller's transaction.
 * Returns the entry, or null when a unique rule (one charge per job, one trial per account,
 * one purchase per Stripe session) says it already happened.
 */
export async function addEntry(c, { accountId, kind, amountMicro, jobId = null, stripeSessionId = null, note = null, createdBy = null }) {
  const { rows } = await c.query(
    `INSERT INTO credit_ledger (account_id, kind, amount_micro, job_id, stripe_session_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING RETURNING *`,
    [accountId, kind, Math.round(amountMicro), jobId, stripeSessionId, note, createdBy],
  );
  if (!rows[0]) return null;
  await c.query('UPDATE accounts SET balance_micro = balance_micro + $2 WHERE id = $1', [accountId, Math.round(amountMicro)]);
  return rows[0];
}

/** Let a waitlisted account in: plan trial + the one-time trial credit. No-op for other plans. */
export async function approveAccount(c, accountId, { by = null } = {}) {
  const acct = await lockAccount(c, accountId);
  if (acct.plan !== 'waitlist') return acct;
  await c.query(`UPDATE accounts SET plan = 'trial', approved_at = now() WHERE id = $1`, [accountId]);
  await addEntry(c, { accountId, kind: 'trial', amountMicro: config.trialMicro, note: 'Free trial', createdBy: by });
  return lockAccount(c, accountId);
}

export async function listLedger(accountId, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    'SELECT * FROM credit_ledger WHERE account_id = $1 ORDER BY id DESC LIMIT $2',
    [accountId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows;
}
