// Job operations shared by the REST API, the MCP server and the dashboard.
import { randomUUID } from 'node:crypto';
import config, { accountLimits } from '../config.js';
import { HttpError } from '../auth.js';
import { assertPublicUrl } from '../url-guard.js';
import { tx } from '../db.js';
import { lockAccount, availableMicro } from '../billing/ledger.js';
import { minCostMicro, usd } from '../billing/pricing.js';
import * as repo from './repo.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (msg) => new HttpError(400, 'bad_request', msg);
const notFound = () => new HttpError(404, 'not_found', 'Job not found');

/** Validate job options (the multipart "job" field, or a JSON body). Returns normalized fields. */
export async function parseJobObject(j) {
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
  let uploadId;
  if (j.uploadId !== undefined) {
    if (typeof j.uploadId !== 'string' || !UUID_RE.test(j.uploadId)) throw bad('"uploadId" must be the id from create upload');
    uploadId = j.uploadId;
  }
  return { composition: j.composition, inputProps, renderOptions: opts, remotionVersion: j.remotionVersion, webhookUrl, uploadId };
}

export async function parseJob(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw bad('"job" must be valid JSON');
  }
  return parseJobObject(j);
}

/**
 * Create a job under the account lock: enforces the active-job cap and the minimum balance
 * atomically with the insert, and reserves the minimum charge as the job's hold.
 */
export async function reserveJob(c, account, fields, { status, bundlePath, bundleBytes, remotionVersion, uploadId }) {
  const acct = await lockAccount(c, account.id);
  if (acct.disabled_at) throw new HttpError(403, 'forbidden', 'This account is disabled');
  const limits = accountLimits(acct);
  if (limits.maxActiveJobs <= 0) throw new HttpError(403, 'not_approved', 'This account is on the waitlist and cannot render yet');
  if ((await repo.countActive(c, acct.id)) >= limits.maxActiveJobs) {
    throw new HttpError(429, 'too_many_active_jobs', `At most ${limits.maxActiveJobs} jobs may be queued or rendering at once`);
  }
  const internal = acct.plan === 'internal';
  const hold = internal ? null : minCostMicro();
  if (!internal) {
    const avail = await availableMicro(c, acct.id);
    if (avail < hold) {
      throw new HttpError(402, 'insufficient_credits',
        `Balance $${usd(Math.max(avail, 0))} available; a job needs at least $${usd(hold)}. Buy credits at ${config.publicBaseUrl}/app/billing`);
    }
  }
  return repo.createJob(c, {
    id: randomUUID(), accountId: acct.id, ...fields, status, bundlePath, bundleBytes, remotionVersion, uploadId, holdMicro: hold,
  });
}

export async function getJobFor(accountId, jobId) {
  if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) throw notFound();
  const job = await repo.getJob(jobId, accountId);
  if (!job) throw notFound();
  return job;
}

export async function listJobsFor(accountId, { limit = 20, before } = {}) {
  let b = null;
  if (before) {
    const d = new Date(String(before));
    if (Number.isNaN(d.getTime())) throw bad('"before" must be an ISO timestamp');
    b = d.toISOString();
  }
  return repo.listJobs(accountId, { limit: Number(limit) || 20, before: b });
}

/** Cancel a job: immediately if not yet rendering, otherwise flag it for the worker. Idempotent. */
export async function cancelJob(accountId, jobId) {
  if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) throw notFound();
  return tx(async (c) => {
    const cur = await repo.getJob(jobId, accountId);
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
    return (await repo.getJob(cur.id)) || cur; // already terminal (or raced)
  });
}
