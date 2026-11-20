import { Router } from 'express';
import express from 'express';
import { unlink } from 'node:fs/promises';
import { rateLimit } from 'express-rate-limit';
import { accountLimits } from '../config.js';
import { receiveMultipart, withUploadSlot } from '../upload-spool.js';
import { apiKeyAuth, HttpError } from '../auth.js';
import { inspectBundle } from '../bundle-inspect.js';
import bunny from '../bunny.js';
import { tx } from '../db.js';
import * as repo from '../jobs/repo.js';
import {
  parseJob, parseJobObject, reserveJob, getJobFor, listJobsFor, cancelJob, createUpload, submitFromUpload,
} from '../jobs/service.js';

const router = Router();

router.use(apiKeyAuth);
router.use(
  rateLimit({
    windowMs: 60_000,
    limit: (req) => accountLimits(req.account).requestsPerMinute,
    keyGenerator: (req) => req.account.keyId,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', 'Too many requests')),
  }),
);

const jsonBody = express.json({ limit: '2mb' });

router.post('/jobs', (req, res, next) => {
  if (req.is('application/json')) return jsonBody(req, res, (err) => (err ? next(err) : submitJson(req, res, next)));
  return submitMultipart(req, res, next);
});

/** Submit from an upload link: JSON body with uploadId + job options. */
async function submitJson(req, res, next) {
  try {
    const fields = await parseJobObject(req.body);
    const job = await submitFromUpload(req.account, fields);
    res.status(202).json(repo.toPublic(job));
  } catch (err) {
    next(err);
  }
}

/** One-shot submit: multipart with the bundle file and the "job" field. */
async function submitMultipart(req, res, next) {
  const limits = accountLimits(req.account);
  let upload;
  try {
    await withUploadSlot(req, req.account.id, async () => {
      upload = await receiveMultipart(req, limits.bundleMaxBytes);
      const fields = await parseJob(upload.jobField);

      const info = await inspectBundle(upload.spool, limits);
      if (fields.remotionVersion && fields.remotionVersion !== info.remotionVersion) {
        throw new HttpError(400, 'bundle_invalid', `remotionVersion ${fields.remotionVersion} does not match the bundle (${info.remotionVersion})`);
      }

      const { id } = await tx((c) =>
        reserveJob(c, req.account, fields, { status: 'uploading', remotionVersion: info.remotionVersion, bundleBytes: upload.bytes }),
      );
      const bundlePath = `bundles/${req.account.id}/${id}.tar.gz`;
      try {
        await bunny.putFile(bundlePath, upload.spool);
      } catch (err) {
        console.error('[upload] bunny put failed', err.message);
        await tx((c) =>
          repo.setStatus(c, id, ['uploading'], 'failed', {
            error: { code: 'storage_error', message: 'Could not store the bundle; try again' },
            finished_at: { sql: 'now()' },
          }),
        );
        throw new HttpError(502, 'storage_error', 'Could not store the bundle; try again');
      }
      const job = await tx(async (c) => {
        // Record the path even if the job was canceled mid-upload, so the sweeper deletes the object.
        await repo.setStatus(c, id, ['uploading', 'canceled'], null, { bundle_path: bundlePath });
        return (await repo.setStatus(c, id, ['uploading'], 'queued')) || repo.getJob(id);
      });
      res.status(202).json(repo.toPublic(job));
    });
  } catch (err) {
    next(err);
  } finally {
    if (upload) await unlink(upload.spool).catch(() => {});
  }
}

router.post('/uploads', async (req, res, next) => {
  try {
    res.status(201).json(await createUpload(req.account));
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id', async (req, res, next) => {
  try {
    res.json(repo.toPublic(await getJobFor(req.account.id, req.params.id)));
  } catch (err) {
    next(err);
  }
});

router.get('/jobs', async (req, res, next) => {
  try {
    const jobs = (await listJobsFor(req.account.id, { limit: req.query.limit, before: req.query.before })).map(repo.toPublic);
    res.json({ jobs, next: jobs.length ? jobs[jobs.length - 1].createdAt : null });
  } catch (err) {
    next(err);
  }
});

router.delete('/jobs/:id', async (req, res, next) => {
  try {
    res.json(repo.toPublic(await cancelJob(req.account.id, req.params.id)));
  } catch (err) {
    next(err);
  }
});

export default router;
