import { Router } from 'express';
import express from 'express';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import config, { accountLimits } from '../config.js';
import { workerAuth, HttpError } from '../auth.js';
import { pool, tx } from '../db.js';
import bunny from '../bunny.js';
import * as repo from '../jobs/repo.js';
import { lockAccount, availableMicro, addEntry } from '../billing/ledger.js';
import { jobCostMicro, billedSeconds, usd } from '../billing/pricing.js';

const router = Router();
router.use(workerAuth);
router.use(express.json({ limit: '64kb' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notOwner = () => new HttpError(409, 'not_owner', 'This worker no longer holds the job');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Load the job and require that this worker holds it in one of `statuses`. */
async function ownedJob(req, statuses) {
  if (!UUID_RE.test(req.params.id)) throw notOwner();
  const job = await repo.getJob(req.params.id);
  if (!job || job.worker_id !== req.worker.id || !statuses.includes(job.status)) throw notOwner();
  return job;
}

/** Size check that treats portrait and landscape alike, plus a total pixel cap. */
function fitsSize(w, h, lim) {
  const long = Math.max(lim.maxWidth, lim.maxHeight);
  const short = Math.min(lim.maxWidth, lim.maxHeight);
  return Math.max(w, h) <= long && Math.min(w, h) <= short && w * h <= lim.maxPixels;
}

async function claimPayload(job) {
  const { rows } = await pool.query('SELECT plan, limits FROM accounts WHERE id = $1', [job.account_id]);
  const limits = accountLimits(rows[0]);
  return {
    job: {
      id: job.id,
      composition: job.composition_id,
      inputProps: job.input_props,
      renderOptions: job.render_options,
      remotionVersion: job.remotion_version,
      bundleBytes: Number(job.bundle_bytes),
      attempt: job.attempts,
      limits: {
        bundleMaxUnpackedBytes: limits.bundleMaxUnpackedBytes,
        bundleMaxFiles: limits.bundleMaxFiles,
        maxDurationSec: limits.maxDurationSec,
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
        maxRenderMinutes: limits.maxRenderMinutes,
        maxFps: limits.maxFps,
        maxPixels: limits.maxPixels,
      },
      egressAllowlist: config.egressAllowlist,
    },
    leaseSec: config.leaseSec,
  };
}

router.post('/claim', async (req, res, next) => {
  try {
    if (req.body && typeof req.body === 'object') {
      const caps = { freeMemoryGb: Number(req.body.freeMemoryGb) || null, platform: req.body.platform || null, version: req.body.version || null };
      pool.query('UPDATE workers SET capabilities = $2 WHERE id = $1', [req.worker.id, caps]).catch(() => {});
    }
    let gone = false;
    res.on('close', () => {
      if (!res.writableFinished) gone = true;
    });
    const deadline = Date.now() + config.claimWaitSec * 1000;
    while (!gone) {
      const job = await tx((c) => repo.claimNext(c, req.worker.id, config.leaseSec));
      if (job) {
        if (gone) {
          // Client vanished between claim and response: give the job back.
          await tx((c) =>
            repo.setStatus(c, job.id, ['rendering'], 'queued', {
              worker_id: null, lease_expires_at: null, attempts: { sql: 'greatest(attempts - 1, 0)' },
            }),
          );
          return;
        }
        return res.json(await claimPayload(job));
      }
      if (Date.now() >= deadline) break;
      await sleep(1000);
    }
    if (!gone) res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id/bundle', async (req, res, next) => {
  try {
    const job = await ownedJob(req, ['rendering']);
    if (!job.bundle_path) throw new HttpError(410, 'gone', 'Bundle no longer stored');
    const { stream, size } = await bunny.getStream(job.bundle_path);
    res.setHeader('Content-Type', 'application/gzip');
    if (size !== null) res.setHeader('Content-Length', String(size));
    await pipeline(stream, res);
  } catch (err) {
    if (res.headersSent) res.destroy(err);
    else next(err);
  }
});

router.post('/jobs/:id/progress', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw notOwner();
    const p = Number(req.body?.progress);
    const progress = Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : null;
    const stage = typeof req.body?.stage === 'string' ? req.body.stage.slice(0, 40) : null;
    const r = await repo.extendLease(req.params.id, req.worker.id, config.leaseSec, { progress, stage });
    if (!r) throw notOwner();
    res.json({ cancel: r.canceled });
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:id/video-meta', async (req, res, next) => {
  try {
    const job = await ownedJob(req, ['rendering']);
    const { width, height, fps, frames } = req.body || {};
    if (![width, height, fps, frames].every((n) => Number.isFinite(n) && n > 0)) {
      throw new HttpError(400, 'bad_request', 'width, height, fps, frames must be positive numbers');
    }
    const { job: payload } = await claimPayload(job);
    const lim = payload.limits;
    const scale = job.render_options?.scale || 1;
    const fr = job.render_options?.frameRange;
    const renderFrames = fr ? Math.min(fr[1], frames - 1) - fr[0] + 1 : frames;
    let error = null;
    if (fr && fr[0] >= frames) error = `frameRange starts at ${fr[0]} but the composition has ${frames} frames`;
    else if (renderFrames / fps > lim.maxDurationSec) error = `Video is ${(renderFrames / fps).toFixed(1)} s; the limit is ${lim.maxDurationSec} s`;
    else if (fps > lim.maxFps) error = `Frame rate ${fps} exceeds ${lim.maxFps} fps`;
    else if (!fitsSize(Math.round(width * scale), Math.round(height * scale), lim)) {
      error = `Output ${Math.round(width * scale)}×${Math.round(height * scale)} exceeds ${lim.maxWidth}×${lim.maxHeight}` +
        ` (either orientation, at most ${lim.maxPixels} pixels)`;
    }
    const video = { width: Math.round(width * scale), height: Math.round(height * scale), fps, frames: renderFrames };
    if (error) {
      await tx((c) =>
        repo.setStatus(c, job.id, ['rendering'], 'failed', {
          video, error: { code: 'limits_exceeded', message: error }, finished_at: { sql: 'now()' }, lease_expires_at: null,
        }, { workerId: req.worker.id }),
      );
      return res.json({ ok: false, error: { code: 'limits_exceeded', message: error } });
    }
    // Price is now exact: reserve it (or refuse the render) under the account lock.
    const cost = jobCostMicro(video);
    const r = await tx(async (c) => {
      const acct = await lockAccount(c, job.account_id);
      if (acct.plan === 'internal') {
        await repo.setStatus(c, job.id, ['rendering'], null, { video, hold_micro: null, cost_micro: cost }, { workerId: req.worker.id });
        return { ok: true };
      }
      const avail = await availableMicro(c, acct.id, { excludeJobId: job.id });
      if (avail < cost) {
        const err = {
          code: 'insufficient_credits',
          message: `This ${billedSeconds(video)} s video costs $${usd(cost)}; available balance is $${usd(Math.max(avail, 0))}`,
        };
        await repo.setStatus(c, job.id, ['rendering'], 'failed', {
          video, error: err, finished_at: { sql: 'now()' }, lease_expires_at: null,
        }, { workerId: req.worker.id });
        return { ok: false, error: err };
      }
      await repo.setStatus(c, job.id, ['rendering'], null, { video, hold_micro: cost }, { workerId: req.worker.id });
      return { ok: true };
    });
    res.json(r);
  } catch (err) {
    next(err);
  }
});

router.put('/jobs/:id/output', async (req, res, next) => {
  const spool = path.join(config.uploadDir, `out-${randomUUID()}.mp4`);
  try {
    const job = await ownedJob(req, ['rendering', 'uploading_output']);
    const len = Number(req.get('content-length'));
    if (!Number.isInteger(len) || len <= 0) throw new HttpError(411, 'length_required', 'Content-Length required');
    if (len > config.outputMaxBytes) throw new HttpError(413, 'output_too_large', 'Output too large');
    await repo.setStatus(null, job.id, ['rendering', 'uploading_output'], 'uploading_output', { stage: 'uploading' }, { workerId: req.worker.id });
    await mkdir(config.uploadDir, { recursive: true });
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > len) return cb(new HttpError(400, 'bad_request', 'Body longer than Content-Length'));
        cb(null, chunk);
      },
    });
    await pipeline(req, counter, createWriteStream(spool, { mode: 0o600 }));
    if (bytes !== len) throw new HttpError(400, 'bad_request', 'Body shorter than Content-Length');
    const outputPath = `outputs/${job.account_id}/${job.id}.mp4`;
    await bunny.putFile(outputPath, spool);
    const updated = await repo.setStatus(null, job.id, ['uploading_output'], null, {
      output_path: outputPath, output_bytes: bytes,
    }, { workerId: req.worker.id });
    if (!updated) throw notOwner();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  } finally {
    await unlink(spool).catch(() => {});
  }
});

router.post('/jobs/:id/complete', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw notOwner();
    const cur = await repo.getJob(req.params.id);
    if (cur && cur.status === 'done' && cur.worker_id === req.worker.id) return res.json({ ok: true }); // idempotent
    const job = await ownedJob(req, ['uploading_output']);
    if (!job.output_path) throw new HttpError(409, 'no_output', 'Upload the output before completing');
    if (job.cancel_requested) {
      await tx((c) =>
        repo.setStatus(c, job.id, ['uploading_output'], 'canceled', {
          error: { code: 'canceled', message: 'Canceled by request' }, finished_at: { sql: 'now()' }, lease_expires_at: null,
        }, { workerId: req.worker.id }),
      );
      return res.json({ ok: true, status: 'canceled' });
    }
    const renderSeconds = Number(req.body?.renderSeconds);
    const v = job.video;
    const done = await tx(async (c) => {
      const acct = await lockAccount(c, job.account_id); // lock order: account, then job (same as video-meta)
      const charge = acct.plan !== 'internal' && job.hold_micro !== null ? Number(job.hold_micro) : null;
      const row = await repo.setStatus(c, job.id, ['uploading_output'], 'done', {
        output_url: bunny.cdnUrl(job.output_path),
        progress: 1,
        stage: null,
        lease_expires_at: null,
        render_seconds: Number.isFinite(renderSeconds) ? renderSeconds : null,
        video_seconds: v ? v.frames / v.fps : null,
        finished_at: { sql: 'now()' },
        expires_at: { sql: `now() + interval '${Number(config.retentionDays)} days'` },
        ...(charge !== null ? { cost_micro: charge } : {}),
      }, { workerId: req.worker.id });
      if (row && charge !== null) {
        await addEntry(c, { accountId: acct.id, kind: 'charge', amountMicro: -charge, jobId: job.id, note: job.composition_id });
      }
      return row;
    });
    if (!done) throw notOwner();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const MAX_PRESSURE_REQUEUES = 3;

const ERROR_CODES = new Set([
  'bundle_invalid', 'bundle_too_large', 'version_unsupported', 'composition_not_found', 'limits_exceeded',
  'network_blocked', 'render_error', 'timeout', 'canceled', 'worker_error',
]);

router.post('/jobs/:id/fail', async (req, res, next) => {
  try {
    const job = await ownedJob(req, ['rendering', 'uploading_output']);
    const code = ERROR_CODES.has(req.body?.code) ? req.body.code : 'render_error';
    const message = String(req.body?.message || 'Render failed').slice(0, 2000);
    const retryable = req.body?.retryable === true && code !== 'canceled';
    const error = { code, message };
    const from = ['rendering', 'uploading_output'];
    const opts = { workerId: req.worker.id };
    let to;
    let patch;
    if (job.cancel_requested || code === 'canceled') {
      to = 'canceled';
      patch = { error: { code: 'canceled', message: 'Canceled by request' }, finished_at: { sql: 'now()' }, lease_expires_at: null };
    } else if (retryable && job.attempts < config.maxAttempts) {
      to = 'queued';
      patch = { error, worker_id: null, lease_expires_at: null, stage: null, progress: 0, queued_at: { sql: 'now()' } };
    } else {
      to = 'failed';
      patch = { error, finished_at: { sql: 'now()' }, lease_expires_at: null };
    }
    const r = await tx((c) => repo.setStatus(c, job.id, from, to, patch, opts));
    if (!r) throw notOwner();
    res.json({ ok: true, status: to });
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:id/requeue', async (req, res, next) => {
  try {
    const job = await ownedJob(req, ['rendering', 'uploading_output']);
    const reason = String(req.body?.reason || 'requeued').slice(0, 200);
    const pressure = reason === 'memory_pressure';
    const from = ['rendering', 'uploading_output'];
    const r = await tx(async (c) => {
      const row = job.cancel_requested
        ? await repo.setStatus(c, job.id, from, 'canceled', {
            error: { code: 'canceled', message: 'Canceled by request' }, finished_at: { sql: 'now()' }, lease_expires_at: null,
          }, { workerId: req.worker.id })
        : pressure && job.requeues + 1 >= MAX_PRESSURE_REQUEUES
          ? await repo.setStatus(c, job.id, from, 'failed', {
              error: { code: 'limits_exceeded', message: 'The render used too much memory on the render machine, several times' },
              finished_at: { sql: 'now()' }, lease_expires_at: null,
            }, { workerId: req.worker.id })
          : await repo.setStatus(c, job.id, from, 'queued', {
              worker_id: null, lease_expires_at: null, stage: null, progress: 0,
              attempts: { sql: 'greatest(attempts - 1, 0)' },
              queued_at: { sql: 'now()' },
              ...(pressure ? { requeues: { sql: 'requeues + 1' } } : {}),
            }, { workerId: req.worker.id });
      if (row) await repo.addEvent(c, job.id, 'requeue_reason', { reason });
      return row;
    });
    if (!r) throw notOwner();
    res.json({ ok: true, status: r.status });
  } catch (err) {
    next(err);
  }
});

export default router;
