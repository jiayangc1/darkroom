import { pool } from '../db.js';

export const TERMINAL = ['done', 'failed', 'canceled', 'expired'];
export const ACTIVE = ['uploading', 'queued', 'rendering', 'uploading_output'];

const COLUMNS = new Set([
  'status', 'remotion_version', 'bundle_path', 'bundle_bytes', 'output_path', 'output_url', 'output_bytes',
  'progress', 'stage', 'attempts', 'worker_id', 'lease_expires_at', 'cancel_requested', 'error', 'video',
  'render_seconds', 'video_seconds', 'started_at', 'finished_at', 'expires_at',
]);
const JSON_COLUMNS = new Set(['error', 'video']);

const db = (client) => client || pool;

export async function addEvent(client, jobId, type, data = null) {
  await db(client).query('INSERT INTO job_events (job_id, type, data) VALUES ($1, $2, $3)', [jobId, type, data]);
}

export async function createJob(client, f) {
  const { rows } = await db(client).query(
    `INSERT INTO jobs (id, account_id, status, composition_id, input_props, render_options, remotion_version, bundle_bytes, webhook_url)
     VALUES ($1, $2, 'uploading', $3, $4, $5, $6, $7, $8) RETURNING *`,
    [f.id, f.accountId, f.composition, f.inputProps, f.renderOptions, f.remotionVersion, f.bundleBytes, f.webhookUrl || null],
  );
  await addEvent(client, f.id, 'created');
  return rows[0];
}

export async function getJob(id, accountId) {
  const { rows } = await pool.query(
    'SELECT * FROM jobs WHERE id = $1 AND ($2::uuid IS NULL OR account_id = $2)',
    [id, accountId || null],
  );
  return rows[0] || null;
}

export async function listJobs(accountId, { limit = 20, before } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM jobs WHERE account_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
      ORDER BY created_at DESC LIMIT $3`,
    [accountId, before || null, Math.min(Math.max(limit, 1), 100)],
  );
  return rows;
}

export async function countActive(client, accountId) {
  const { rows } = await db(client).query(
    'SELECT count(*)::int AS n FROM jobs WHERE account_id = $1 AND status = ANY($2)',
    [accountId, ACTIVE],
  );
  return rows[0].n;
}

/**
 * Conditional update. Only applies if status ∈ from (and worker matches when given).
 * Returns the updated row, or null if the condition failed.
 * Patch values may be `{ sql: 'now()' }` for raw SQL expressions without params.
 */
export async function setStatus(client, id, from, to, patch = {}, { workerId } = {}) {
  const sets = [];
  const params = [id, from];
  const push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (to) sets.push(`status = ${push(to)}`);
  for (const [k, v] of Object.entries(patch)) {
    if (!COLUMNS.has(k)) throw new Error(`setStatus: unknown column ${k}`);
    if (v && typeof v === 'object' && 'sql' in v) sets.push(`${k} = ${v.sql}`);
    else sets.push(`${k} = ${push(JSON_COLUMNS.has(k) && v !== null ? JSON.stringify(v) : v)}`);
  }
  if (!sets.length) throw new Error('setStatus: nothing to set');
  let where = 'id = $1 AND status = ANY($2)';
  if (workerId) where += ` AND worker_id = ${push(workerId)}`;
  const { rows } = await db(client).query(`UPDATE jobs SET ${sets.join(', ')} WHERE ${where} RETURNING *`, params);
  const row = rows[0] || null;
  if (row && to) await addEvent(client, id, to, patch.error ? { error: patch.error } : null);
  return row;
}

/** Atomically take the oldest queued job. */
export async function claimNext(client, workerId, leaseSec) {
  const { rows } = await db(client).query(
    `UPDATE jobs SET status = 'rendering', worker_id = $1,
            lease_expires_at = now() + $2 * interval '1 second',
            started_at = coalesce(started_at, now()), attempts = attempts + 1,
            progress = 0, stage = 'claimed', error = NULL
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND NOT cancel_requested
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
    [workerId, leaseSec],
  );
  const job = rows[0] || null;
  if (job) await addEvent(client, job.id, 'claimed', { workerId, attempt: job.attempts });
  return job;
}

/** Extend the lease and record progress. Returns { canceled } or null if the worker no longer holds the job. */
export async function extendLease(id, workerId, leaseSec, { progress, stage } = {}) {
  const { rows } = await pool.query(
    `UPDATE jobs SET lease_expires_at = now() + $3 * interval '1 second',
            progress = coalesce($4, progress), stage = coalesce($5, stage)
      WHERE id = $1 AND worker_id = $2 AND status IN ('rendering', 'uploading_output')
      RETURNING cancel_requested`,
    [id, workerId, leaseSec, progress ?? null, stage ?? null],
  );
  return rows[0] ? { canceled: rows[0].cancel_requested } : null;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Shape returned to API clients and webhooks. */
export function toPublic(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.status === 'done' ? 1 : Number(job.progress) || 0,
    stage: job.stage,
    composition: job.composition_id,
    remotionVersion: job.remotion_version,
    error: job.error,
    outputUrl: job.status === 'done' ? job.output_url : null,
    video: job.video,
    attempts: job.attempts,
    cancelRequested: job.cancel_requested,
    createdAt: iso(job.created_at),
    startedAt: iso(job.started_at),
    finishedAt: iso(job.finished_at),
    expiresAt: iso(job.expires_at),
  };
}
