// Spooling uploads to disk with size caps, idle/total deadlines and a per-account in-flight cap.
import Busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import config from './config.js';
import { HttpError } from './auth.js';

const UPLOAD_IDLE_MS = 60_000;
const UPLOAD_TOTAL_MS = 30 * 60_000;
const MAX_UPLOADS_PER_ACCOUNT = 2;
const inFlight = new Map(); // accountId -> uploads in progress

/**
 * Receive multipart: file part "bundle" spooled to disk, field "job" as JSON text.
 * Rejects as soon as something is wrong (size cap, idle, deadline) and marks the request so the
 * error handler closes the connection instead of reading the rest of the body.
 */
export function receiveMultipart(req, maxBytes) {
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


/**
 * Receive a raw request body (PUT of a .tar.gz) to a spool file. Same caps and deadlines as
 * multipart; on any failure the spool is removed and the connection is closed after the response.
 */
export function receiveRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.darkroomCloseAfterResponse = true;
      return reject(new HttpError(413, 'bundle_too_large', `Bundle exceeds ${maxBytes} bytes`));
    }
    const spool = path.join(config.uploadDir, `${randomUUID()}.tar.gz`);
    const out = createWriteStream(spool, { mode: 0o600 });
    let bytes = 0;
    let settled = false;
    const abort = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.setTimeout(0);
      req.unpipe(out);
      out.destroy();
      out.once('close', () => unlink(spool).catch(() => {}));
      req.darkroomCloseAfterResponse = true;
      reject(err);
    };
    const deadline = setTimeout(() => abort(new HttpError(408, 'upload_timeout', 'Upload took too long')), UPLOAD_TOTAL_MS);
    req.setTimeout(UPLOAD_IDLE_MS, () => abort(new HttpError(408, 'upload_timeout', 'Upload stalled')));
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > maxBytes) abort(new HttpError(413, 'bundle_too_large', `Bundle exceeds ${maxBytes} bytes`));
    });
    req.on('close', () => {
      if (!req.complete) abort(new HttpError(400, 'aborted', 'Upload aborted'));
    });
    out.on('error', abort);
    out.on('finish', () => {
      if (settled) return;
      if (!bytes) return abort(new HttpError(400, 'bad_request', 'Empty upload; send the .tar.gz as the request body'));
      settled = true;
      clearTimeout(deadline);
      req.setTimeout(0);
      resolve({ spool, bytes });
    });
    req.pipe(out);
  });
}

/** Run `fn` holding one of the account's upload slots (429 when all are in use). */
export async function withUploadSlot(req, accountId, fn) {
  if ((inFlight.get(accountId) || 0) >= MAX_UPLOADS_PER_ACCOUNT) {
    req.darkroomCloseAfterResponse = true;
    throw new HttpError(429, 'too_many_uploads', `At most ${MAX_UPLOADS_PER_ACCOUNT} uploads at once per account`);
  }
  inFlight.set(accountId, (inFlight.get(accountId) || 0) + 1);
  try {
    await mkdir(config.uploadDir, { recursive: true });
    return await fn();
  } finally {
    const n = (inFlight.get(accountId) || 1) - 1;
    if (n) inFlight.set(accountId, n);
    else inFlight.delete(accountId);
  }
}
