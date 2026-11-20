import { pool } from './db.js';
import config from './config.js';
import bunny from './bunny.js';
import { deliver } from './webhooks.js';
import { toPublic } from './jobs/repo.js';

const RETRY_MINUTES = [1, 5, 30, 120]; // after attempt 1..4; attempt 5 failing gives up

async function expireLeases(c) {
  const { rows } = await c.query(
    `UPDATE jobs SET
        status = CASE WHEN cancel_requested THEN 'canceled'
                      WHEN attempts < $1 THEN 'queued' ELSE 'failed' END,
        error = CASE WHEN cancel_requested THEN '{"code":"canceled","message":"Canceled by request"}'::jsonb
                     WHEN attempts < $1 THEN error
                     ELSE '{"code":"worker_lost","message":"The render worker stopped responding too many times"}'::jsonb END,
        finished_at = CASE WHEN cancel_requested OR attempts >= $1 THEN now() ELSE finished_at END,
        worker_id = CASE WHEN cancel_requested OR attempts >= $1 THEN worker_id ELSE NULL END,
        lease_expires_at = NULL, stage = NULL
      WHERE status IN ('rendering', 'uploading_output') AND lease_expires_at < now()
      RETURNING id, status`,
    [config.maxAttempts],
  );
  for (const r of rows) {
    await c.query('INSERT INTO job_events (job_id, type, data) VALUES ($1, $2, $3)', [r.id, r.status, { reason: 'lease_expired' }]);
    console.log(`[sweeper] lease expired for ${r.id} → ${r.status}`);
  }
  // Uploads that never finished (server died mid-upload).
  await c.query(
    `UPDATE jobs SET status = 'failed', finished_at = now(),
            error = '{"code":"storage_error","message":"Upload did not complete"}'::jsonb
      WHERE status = 'uploading' AND created_at < now() - interval '1 hour'`,
  );
}

async function deleteBundles(c) {
  const { rows } = await c.query(
    `SELECT id, bundle_path FROM jobs WHERE bundle_path IS NOT NULL
        AND status IN ('done', 'failed', 'canceled', 'expired') LIMIT 50`,
  );
  for (const r of rows) {
    try {
      await bunny.remove(r.bundle_path);
      await c.query('UPDATE jobs SET bundle_path = NULL WHERE id = $1', [r.id]);
    } catch (err) {
      console.error(`[sweeper] bundle delete failed for ${r.id}: ${err.message}`);
    }
  }
}

async function expireOutputs(c) {
  const { rows } = await c.query(
    `SELECT id, output_path FROM jobs WHERE status = 'done' AND expires_at < now() LIMIT 50`,
  );
  for (const r of rows) {
    try {
      if (r.output_path) await bunny.remove(r.output_path);
      await c.query(
        `UPDATE jobs SET status = 'expired', output_path = NULL, output_url = NULL WHERE id = $1 AND status = 'done'`,
        [r.id],
      );
      await c.query(`INSERT INTO job_events (job_id, type) VALUES ($1, 'expired')`, [r.id]);
    } catch (err) {
      console.error(`[sweeper] output delete failed for ${r.id}: ${err.message}`);
    }
  }
}

async function webhooks(c) {
  await c.query(
    `INSERT INTO webhook_deliveries (job_id, event)
       SELECT id, 'job.' || status FROM jobs
        WHERE webhook_url IS NOT NULL AND status IN ('done', 'failed', 'canceled')
          AND finished_at > now() - interval '1 day'
     ON CONFLICT (job_id) DO NOTHING`,
  );
  const { rows } = await c.query(
    `SELECT d.job_id, d.event, d.attempts, j.*, a.webhook_secret
       FROM webhook_deliveries d JOIN jobs j ON j.id = d.job_id JOIN accounts a ON a.id = j.account_id
      WHERE d.delivered_at IS NULL AND d.gave_up_at IS NULL AND d.next_at <= now()
      ORDER BY d.next_at LIMIT 20`,
  );
  await Promise.all(
    rows.map(async (r) => {
      const attempt = r.attempts + 1;
      try {
        await deliver(r.webhook_url, r.webhook_secret, { event: r.event, job: toPublic(r) });
        await c.query('UPDATE webhook_deliveries SET attempts = $2, delivered_at = now(), last_error = NULL WHERE job_id = $1', [r.job_id, attempt]);
      } catch (err) {
        const wait = RETRY_MINUTES[attempt - 1];
        if (wait === undefined) {
          await c.query('UPDATE webhook_deliveries SET attempts = $2, gave_up_at = now(), last_error = $3 WHERE job_id = $1', [r.job_id, attempt, err.message]);
        } else {
          await c.query(
            `UPDATE webhook_deliveries SET attempts = $2, next_at = now() + $3 * interval '1 minute', last_error = $4 WHERE job_id = $1`,
            [r.job_id, attempt, wait, err.message],
          );
        }
      }
    }),
  );
}

async function pass() {
  const c = await pool.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock(4242) AS ok');
    if (!rows[0].ok) return;
    try {
      for (const step of [expireLeases, deleteBundles, expireOutputs, webhooks]) {
        try {
          await step(c);
        } catch (err) {
          console.error(`[sweeper] ${step.name} failed: ${err.message}`);
        }
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock(4242)');
    }
  } finally {
    c.release();
  }
}

/** Start the periodic sweeper; returns a stop function. */
export function startSweeper(intervalMs = 15_000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pass();
    } catch (err) {
      console.error('[sweeper] pass failed', err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}
