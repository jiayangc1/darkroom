import { Router } from 'express';
import Busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rateLimit } from 'express-rate-limit';
import config, { accountLimits } from '../config.js';
import { apiKeyAuth, HttpError } from '../auth.js';
import { inspectBundle } from '../bundle-inspect.js';
import bunny from '../bunny.js';
import { tx } from '../db.js';
import * as repo from '../jobs/repo.js';
import { parseJob, reserveJob, getJobFor, listJobsFor, cancelJob } from '../jobs/service.js';

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

const UPLOAD_IDLE_MS = 60_000;
const UPLOAD_TOTAL_MS = 30 * 60_000;
const MAX_UPLOADS_PER_ACCOUNT = 2;
const inFlight = new Map(); // accountId -> uploads in progress

/**
 * Receive multipart: file part "bundle" spooled to disk, field "job" as JSON text.
 * Rejects as soon as something is wrong (size cap, idle, deadline) and marks the request so the
 * error handler closes the connection instead of reading the rest of the body.
 */
function receiveUpload(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: 1, fields: 5, fileSize: maxBytes + 1, fieldSize: 2 * 1024 * 1024 },
      });
    } catch {
      return reject(new HttpError(400, 'bad_request', 'Expected multipart/form-data'));
    }
    const spool = path.join(config.uploadDir, `${randomUUID()}.tar.gz`);
    let jobField = null;
    let fileSeen = false;
    let fileDone = Promise.resolve(0);
    let out = null;
    let settled = false;

    const cleanupSpool = () => {
      // Unlink only after the write stream has closed, or the file may be created after we delete it.
      if (out && !out.closed) out.once('close', () => unlink(spool).catch(() => {}));
      else unlink(spool).catch(() => {});
    };
    const abort = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.setTimeout(0);
      req.unpipe(bb);
      out?.destroy();
      cleanupSpool();
      req.darkroomCloseAfterResponse = true;
      reject(err);
    };
    const deadline = setTimeout(() => abort(new HttpError(408, 'upload_timeout', 'Upload took too long')), UPLOAD_TOTAL_MS);
    req.setTimeout(UPLOAD_IDLE_MS, () => abort(new HttpError(408, 'upload_timeout', 'Upload stalled')));

    bb.on('field', (name, value, info) => {
      if (name === 'job') {
        if (info.valueTruncated) return abort(new HttpError(413, 'job_too_large', '"job" field too large'));
        jobField = value;
      }
    });
    bb.on('file', (name, stream) => {
      if (name !== 'bundle' || fileSeen) {
        stream.resume();
        return;
      }
      fileSeen = true;
      let bytes = 0;
      out = createWriteStream(spool, { mode: 0o600 });
      fileDone = new Promise((res) => {
        stream.on('data', (c) => (bytes += c.length));
        stream.on('limit', () => abort(new HttpError(413, 'bundle_too_large', `Bundle exceeds ${maxBytes} bytes`)));
        out.on('finish', res);
        out.on('error', (e) => {
          abort(e);
          res();
        });
        stream.on('error', (e) => {
          abort(e);
          res();
        });
        stream.pipe(out);
      }).then(() => bytes);
    });
    bb.on('error', (e) => abort(new HttpError(400, 'bad_request', `Malformed upload: ${e.message}`)));
    bb.on('close', async () => {
      const bytes = await fileDone;
      if (settled) return;
      if (!fileSeen) return abort(new HttpError(400, 'bad_request', 'Missing "bundle" file part'));
      if (jobField === null) return abort(new HttpError(400, 'bad_request', 'Missing "job" field'));
      settled = true;
      clearTimeout(deadline);
      req.setTimeout(0);
      resolve({ spool, bytes, jobField });
    });
    req.on('close', () => {
      if (!req.complete) abort(new HttpError(400, 'aborted', 'Upload aborted'));
    });
    req.pipe(bb);
  });
}

router.post('/jobs', async (req, res, next) => {
  const limits = accountLimits(req.account);
  const acct = req.account.id;
  if ((inFlight.get(acct) || 0) >= MAX_UPLOADS_PER_ACCOUNT) {
    req.darkroomCloseAfterResponse = true;
    return next(new HttpError(429, 'too_many_uploads', `At most ${MAX_UPLOADS_PER_ACCOUNT} uploads at once per account`));
  }
  inFlight.set(acct, (inFlight.get(acct) || 0) + 1);
  let upload;
  try {
    await mkdir(config.uploadDir, { recursive: true });
    upload = await receiveUpload(req, limits.bundleMaxBytes);
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
  } catch (err) {
    next(err);
  } finally {
    const n = (inFlight.get(acct) || 1) - 1;
    if (n) inFlight.set(acct, n);
    else inFlight.delete(acct);
    if (upload) await unlink(upload.spool).catch(() => {});
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
