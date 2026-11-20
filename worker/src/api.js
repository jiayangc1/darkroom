import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import config from './config.js';
import { log } from './log.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(`server ${status}: ${body?.error?.message || JSON.stringify(body)?.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}
export const isNotOwner = (err) => err instanceof ApiError && err.status === 409;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF = [2000, 10_000, 30_000];
const retryable = (err) => err?.name !== 'AbortError' && (!(err instanceof ApiError) || err.status >= 500);
const withTimeout = (signal, ms) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/** JSON request with retries on network errors / 5xx. Returns parsed body, or null on 204. */
async function call(method, p, body, { retries = BACKOFF.length, timeoutMs = 30_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(config.serverUrl + p, {
        method,
        headers: { Authorization: `Bearer ${config.workerToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 204) return null;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data);
      return data;
    } catch (err) {
      if (attempt >= retries || !retryable(err)) throw err;
      log(`[api] ${method} ${p} failed (${err.message}); retrying`);
      await sleep(BACKOFF[attempt]);
    }
  }
}

export const claim = (info) => call('POST', '/worker/claim', info, { retries: 0, timeoutMs: 60_000 });
export const progress = (id, progress, stage) => call('POST', `/worker/jobs/${id}/progress`, { progress, stage }, { retries: 1, timeoutMs: 10_000 });
export const videoMeta = (id, meta) => call('POST', `/worker/jobs/${id}/video-meta`, meta);
export const complete = (id, renderSeconds) => call('POST', `/worker/jobs/${id}/complete`, { renderSeconds });
export const fail = (id, code, message, retryable) => call('POST', `/worker/jobs/${id}/fail`, { code, message, retryable });
export const reportStatus = (body) => call('POST', '/worker/status', body, { retries: 0, timeoutMs: 10_000 });
export const requeue = (id, reason) => call('POST', `/worker/jobs/${id}/requeue`, { reason });

/** Download the job's bundle archive to `dest`. */
export async function downloadBundle(id, dest, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${config.serverUrl}/worker/jobs/${id}/bundle`, {
        headers: { Authorization: `Bearer ${config.workerToken}` },
        signal: withTimeout(signal, 30 * 60_000),
      });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest, { mode: 0o600 }));
      return;
    } catch (err) {
      if (attempt >= BACKOFF.length || !retryable(err) || signal?.aborted) throw err;
      log(`[api] bundle download failed (${err.message}); retrying`);
      await sleep(BACKOFF[attempt]);
    }
  }
}

/** Upload the rendered file. */
export async function uploadOutput(id, file, signal) {
  const { size } = await stat(file);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${config.serverUrl}/worker/jobs/${id}/output`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${config.workerToken}`, 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
        body: Readable.toWeb(createReadStream(file)),
        duplex: 'half',
        signal: withTimeout(signal, 30 * 60_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data);
      return;
    } catch (err) {
      if (attempt >= BACKOFF.length || !retryable(err) || signal?.aborted) throw err;
      log(`[api] output upload failed (${err.message}); retrying`);
      await sleep(BACKOFF[attempt]);
    }
  }
}
