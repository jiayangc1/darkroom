// What customers see about the render capacity: is it working, idle, paused (until when) or offline.
import { pool } from './db.js';

/** @returns {Promise<{ state: 'rendering'|'idle'|'paused'|'offline', until: string|null }>} */
export async function workerStatus() {
  const { rows } = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM jobs WHERE status IN ('rendering', 'uploading_output')) AS rendering,
       EXISTS (SELECT 1 FROM workers WHERE revoked_at IS NULL AND state = 'polling'
                 AND last_seen_at > now() - interval '90 seconds') AS idle,
       (SELECT min(state_until) FROM workers WHERE revoked_at IS NULL AND state = 'paused'
                 AND state_at > now() - interval '120 seconds') AS paused_until,
       EXISTS (SELECT 1 FROM workers WHERE revoked_at IS NULL AND state = 'paused'
                 AND state_at > now() - interval '120 seconds') AS paused`,
  );
  const r = rows[0];
  if (r.rendering) return { state: 'rendering', until: null };
  if (r.idle) return { state: 'idle', until: null };
  if (r.paused) return { state: 'paused', until: r.paused_until ? new Date(r.paused_until).toISOString() : null };
  return { state: 'offline', until: null };
}

/** 1-based place in the queue for a queued job, else null. */
export async function queuePosition(job) {
  if (job.status !== 'queued') return null;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM jobs WHERE status = 'queued' AND NOT cancel_requested AND queued_at < $1`,
    [job.queued_at],
  );
  return rows[0].n + 1;
}

export async function queuedCount() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE status = 'queued'`);
  return rows[0].n;
}

/** Public job shape plus live queue/worker info, for single-job reads. */
export async function withLiveStatus(publicJob, row) {
  const active = ['uploading', 'queued', 'rendering', 'uploading_output'].includes(row.status);
  return {
    ...publicJob,
    queuePosition: await queuePosition(row),
    worker: active ? await workerStatus() : null,
  };
}
