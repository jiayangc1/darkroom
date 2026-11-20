import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from './config.js';
import { log } from './log.js';
import * as api from './api.js';
import { extract } from './extract.js';
import { ensureRenderer, trustedChrome } from './renderers.js';
import { pressureLevel } from './memory.js';
import { state as pauseState, writeStatus } from './pause.js';
import { killTree } from './proctree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'child', 'render.js');
const GUARD = path.join(here, 'child', 'node-guard.js');

class Stop extends Error {} // thrown to unwind once the job has been settled elsewhere

/** Run one claimed job. Result tells the main loop whether to cool down (memory pressure). */
export async function runJob(job, { tabs }) {
  const dir = path.join(config.workDir, job.id);
  const tag = `[job ${job.id.slice(0, 8)}]`;
  const started = Date.now();
  const maxMs = (job.limits?.maxRenderMinutes || 60) * 60_000;
  const result = { cooldown: false };
  let child = null;
  let finished = false; // a final state was reported (or the job is no longer ours)
  let progress = 0;
  let stage = 'downloading';
  const abort = new AbortController(); // cancels download/upload in flight

  const childAlive = () => child && child.exitCode === null && child.signalCode === null;
  // Only kill a child that is still running: a reaped pid may already belong to someone else.
  const killChild = () => {
    if (childAlive()) killTree(child.pid);
  };
  const stopAll = () => {
    abort.abort();
    killChild();
  };
  const settle = async (fn, label) => {
    if (finished) return;
    finished = true;
    try {
      await fn();
    } catch (err) {
      if (api.isNotOwner(err)) log(`${tag} ${label}: job no longer ours, discarding`);
      else log(`${tag} ${label} failed: ${err.message}`);
    }
  };
  const failJob = (code, message, retryable) => settle(() => api.fail(job.id, code, message, retryable), `fail(${code})`);
  const requeue = (reason) => settle(() => api.requeue(job.id, reason), `requeue(${reason})`);
  const setStage = (s, p = progress) => {
    stage = s;
    progress = p;
    writeStatus({ state: 'rendering', jobId: job.id, progress, stage });
  };

  // Heartbeat from claim until the job is settled: keeps the lease alive through download,
  // renderer install, render and upload, and notices cancels / memory pressure / pause at any stage.
  let beating = false;
  const heartbeat = setInterval(async () => {
    if (finished || beating) return;
    beating = true;
    try {
      const r = await api.progress(job.id, progress, stage);
      if (r?.cancel && !finished) {
        log(`${tag} canceled by request`);
        stopAll();
        await failJob('canceled', 'Canceled by request', false);
        return;
      }
    } catch (err) {
      if (api.isNotOwner(err)) {
        log(`${tag} lost the job (lease expired or reassigned)`);
        finished = true;
        stopAll();
        return;
      }
    } finally {
      beating = false;
    }
    if (finished || stage === 'uploading') return;
    if ((await pressureLevel()) === 'critical') {
      log(`${tag} critical memory pressure — giving the job back`);
      result.cooldown = true;
      stopAll();
      await requeue('memory_pressure');
    } else if (pauseState().now) {
      log(`${tag} paused with --now — giving the job back`);
      stopAll();
      await requeue('paused');
    } else if (Date.now() - started > maxMs) {
      stopAll();
      await failJob('timeout', `Render exceeded ${maxMs / 60_000} minutes`, false);
    }
  }, config.heartbeatMs);

  log(`${tag} start: ${job.composition} remotion ${job.remotionVersion} tabs=${tabs} attempt=${job.attempt}`);
  setStage('downloading', 0);
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.join(dir, 'bundle'), { recursive: true, mode: 0o700 });

    const archive = path.join(dir, 'bundle.tar.gz');
    await api.downloadBundle(job.id, archive, abort.signal);
    if (finished) throw new Stop();
    let bundleRoot;
    try {
      bundleRoot = await extract(archive, path.join(dir, 'bundle'), job.limits);
    } catch (err) {
      await failJob(err.code || 'bundle_invalid', err.message, false);
      throw new Stop();
    }
    await rm(archive, { force: true });
    if (finished) throw new Stop();

    setStage('preparing');
    const rendererDir = await ensureRenderer(job.remotionVersion);
    const chrome = await trustedChrome();
    if (finished) throw new Stop();

    const jobFile = path.join(dir, 'job.json');
    await writeFile(jobFile, JSON.stringify(job));
    child = spawn(process.execPath, ['--import', GUARD, CHILD], {
      cwd: rendererDir, // Remotion finds its files relative to cwd
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: dir,
        DARKROOM_JOB_FILE: jobFile,
        DARKROOM_JOB_DIR: dir,
        DARKROOM_BUNDLE_ROOT: bundleRoot,
        DARKROOM_RENDERER_DIR: rendererDir,
        DARKROOM_CHROME: chrome,
        DARKROOM_TABS: String(tabs),
        DARKROOM_GL: config.gl,
        DARKROOM_ALLOWLIST: (job.egressAllowlist || []).join(','),
      },
    });
    child.stdout.on('data', (d) => log(tag, d.toString().trimEnd()));
    child.stderr.on('data', (d) => log(tag, 'stderr', d.toString().trimEnd()));

    let outcome = null; // { type: 'done', file } | { type: 'error', ... }
    child.on('message', async (m) => {
      if (m.type === 'progress') setStage(m.stage, m.progress);
      else if (m.type === 'meta') {
        try {
          const r = await api.videoMeta(job.id, { width: m.width, height: m.height, fps: m.fps, frames: m.frames });
          if (r.ok) child.send({ type: 'meta-ok' });
          else {
            finished = true; // the server already failed the job
            log(`${tag} rejected: ${r.error?.message}`);
            child.send({ type: 'meta-reject' });
          }
        } catch (err) {
          log(`${tag} video-meta failed: ${err.message}`);
          if (api.isNotOwner(err)) finished = true;
          killChild();
        }
      } else if (m.type === 'done' || m.type === 'error') outcome = m;
    });

    const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    if (finished) throw new Stop();

    if (outcome?.type === 'done') {
      // Not via settle(): the heartbeat must keep the lease alive (and see cancels) during upload.
      setStage('uploading', 1);
      try {
        await api.uploadOutput(job.id, outcome.file, abort.signal);
        if (!finished) {
          await api.complete(job.id, (Date.now() - started) / 1000);
          log(`${tag} done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        }
      } catch (err) {
        if (!finished) log(`${tag} ${api.isNotOwner(err) ? 'job no longer ours, discarding' : `upload/complete failed: ${err.message}`}`);
      } finally {
        finished = true;
      }
    } else if (outcome?.type === 'error') {
      log(`${tag} error ${outcome.code}: ${outcome.message}`);
      await failJob(outcome.code, outcome.message, outcome.retryable);
    } else {
      await failJob('render_error', `Render process exited unexpectedly (code ${exitCode})`, true);
    }
  } catch (err) {
    if (!(err instanceof Stop) && !finished) {
      log(`${tag} worker error: ${err.message}`);
      stopAll();
      if (!api.isNotOwner(err)) {
        const unsupported = err.code === 'version_unsupported';
        await failJob(unsupported ? err.code : 'worker_error', err.message, !unsupported);
      }
    }
  } finally {
    clearInterval(heartbeat);
    killChild();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    writeStatus({ state: 'idle' });
  }
  return result;
}
