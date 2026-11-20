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
import { assertPublicUrl } from '../url-guard.js';
import bunny from '../bunny.js';
import { tx } from '../db.js';
import * as repo from '../jobs/repo.js';

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

/** Receive multipart: file part "bundle" spooled to disk, field "job" as JSON text. */
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
    let fileDone = Promise.resolve();
    let failed = null;
    const fail = (err) => {
      if (!failed) failed = err;
    };

    bb.on('field', (name, value, info) => {
      if (name === 'job') {
        if (info.valueTruncated) fail(new HttpError(413, 'job_too_large', '"job" field too large'));
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
      const out = createWriteStream(spool, { mode: 0o600 });
      fileDone = new Promise((res) => {
        stream.on('data', (c) => (bytes += c.length));
        stream.on('limit', () => fail(new HttpError(413, 'bundle_too_large', `Bundle exceeds ${maxBytes} bytes`)));
        out.on('finish', res);
        out.on('error', (e) => {
          fail(e);
          res();
        });
        stream.on('error', (e) => {
          fail(e);
          out.destroy();
          res();
        });
        stream.pipe(out);
      }).then(() => bytes);
    });
    bb.on('error', (e) => {
      fail(new HttpError(400, 'bad_request', `Malformed upload: ${e.message}`));
    });
    bb.on('close', async () => {
      const bytes = await fileDone;
      if (!failed && !fileSeen) failed = new HttpError(400, 'bad_request', 'Missing "bundle" file part');
      if (!failed && jobField === null) failed = new HttpError(400, 'bad_request', 'Missing "job" field');
      if (failed) {
        await unlink(spool).catch(() => {});
        return reject(failed);
      }
      resolve({ spool, bytes, jobField });
    });
    req.on('close', () => {
      if (req.complete) return;
      fail(new HttpError(400, 'aborted', 'Upload aborted'));
      bb.destroy?.();
      unlink(spool).catch(() => {});
      reject(failed);
    });
    req.pipe(bb);
  });
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (msg) => new HttpError(400, 'bad_request', msg);

/** Validate the "job" JSON. Returns normalized fields. */
async function parseJob(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw bad('"job" must be valid JSON');
  }
  if (!isObj(j)) throw bad('"job" must be an object');
  if (typeof j.composition !== 'string' || !j.composition.length || j.composition.length > 200) {
    throw bad('"composition" must be a string of 1–200 chars');
  }
  const inputProps = j.inputProps ?? {};
  if (!isObj(inputProps)) throw bad('"inputProps" must be an object');
  if (Buffer.byteLength(JSON.stringify(inputProps)) > 1024 * 1024) throw bad('"inputProps" exceeds 1 MB');
  const opts = {};
  if (j.frameRange !== undefined) {
    const fr = j.frameRange;
    if (!Array.isArray(fr) || fr.length !== 2 || !fr.every(Number.isInteger) || fr[0] < 0 || fr[1] < fr[0]) {
      throw bad('"frameRange" must be [start, end] integers with 0 <= start <= end');
    }
    opts.frameRange = fr;
  }
  if (j.scale !== undefined) {
    if (typeof j.scale !== 'number' || j.scale < 0.25 || j.scale > 4) throw bad('"scale" must be between 0.25 and 4');
    opts.scale = j.scale;
  }
  opts.codec = j.codec ?? 'h264';
  if (opts.codec !== 'h264') throw bad('"codec" must be "h264"');
  if (j.crf !== undefined) {
    if (!Number.isInteger(j.crf) || j.crf < 0 || j.crf > 51) throw bad('"crf" must be an integer 0–51');
    opts.crf = j.crf;
  }
  if (j.remotionVersion !== undefined && typeof j.remotionVersion !== 'string') throw bad('"remotionVersion" must be a string');
  let webhookUrl = null;
  if (j.webhookUrl !== undefined && j.webhookUrl !== null) {
    if (typeof j.webhookUrl !== 'string' || j.webhookUrl.length > 2000) throw bad('"webhookUrl" must be a URL string');
    try {
      webhookUrl = (await assertPublicUrl(j.webhookUrl)).toString();
    } catch (e) {
      throw bad(`"webhookUrl" rejected: ${e.message}`);
    }
  }
  return { composition: j.composition, inputProps, renderOptions: opts, remotionVersion: j.remotionVersion, webhookUrl };
}

router.post('/jobs', async (req, res, next) => {
  const limits = accountLimits(req.account);
  let upload;
  try {
    await mkdir(config.uploadDir, { recursive: true });
    upload = await receiveUpload(req, limits.bundleMaxBytes);
    const fields = await parseJob(upload.jobField);

    if ((await repo.countActive(null, req.account.id)) >= limits.maxActiveJobs) {
      throw new HttpError(429, 'too_many_active_jobs', `At most ${limits.maxActiveJobs} jobs may be queued or rendering at once`);
    }

    const info = await inspectBundle(upload.spool, limits);
    if (fields.remotionVersion && fields.remotionVersion !== info.remotionVersion) {
      throw new HttpError(400, 'bundle_invalid', `remotionVersion ${fields.remotionVersion} does not match the bundle (${info.remotionVersion})`);
    }

    const id = randomUUID();
    await tx((c) =>
      repo.createJob(c, {
        id, accountId: req.account.id, ...fields, remotionVersion: info.remotionVersion, bundleBytes: upload.bytes,
      }),
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
    if (upload) await unlink(upload.spool).catch(() => {});
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new HttpError(404, 'not_found', 'Job not found');

router.get('/jobs/:id', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw notFound();
    const job = await repo.getJob(req.params.id, req.account.id);
    if (!job) throw notFound();
    res.json(repo.toPublic(job));
  } catch (err) {
    next(err);
  }
});

router.get('/jobs', async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 20;
    let before = null;
    if (req.query.before) {
      const d = new Date(String(req.query.before));
      if (Number.isNaN(d.getTime())) throw bad('"before" must be an ISO timestamp');
      before = d.toISOString();
    }
    const rows = await repo.listJobs(req.account.id, { limit, before });
    const jobs = rows.map(repo.toPublic);
    res.json({ jobs, next: jobs.length ? jobs[jobs.length - 1].createdAt : null });
  } catch (err) {
    next(err);
  }
});

router.delete('/jobs/:id', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw notFound();
    const job = await tx(async (c) => {
      const cur = await repo.getJob(req.params.id, req.account.id);
      if (!cur) throw notFound();
      if (['queued', 'uploading'].includes(cur.status)) {
        const j = await repo.setStatus(c, cur.id, ['queued', 'uploading'], 'canceled', {
          cancel_requested: true,
          finished_at: { sql: 'now()' },
        });
        if (j) return j;
      }
      if (['rendering', 'uploading_output'].includes(cur.status)) {
        const j = await repo.setStatus(c, cur.id, ['rendering', 'uploading_output'], null, { cancel_requested: true });
        if (j) {
          await repo.addEvent(c, cur.id, 'cancel_requested');
          return j;
        }
      }
      return (await repo.getJob(cur.id)) || cur; // already terminal (or raced): idempotent
    });
    res.json(repo.toPublic(job));
  } catch (err) {
    next(err);
  }
});

export default router;
