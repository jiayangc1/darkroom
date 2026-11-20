import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from './config.js';
import { log } from './log.js';
import * as api from './api.js';
import { extract } from './extract.js';
import { ensureRenderer } from './renderers.js';
import { pressureLevel } from './memory.js';
import { state as pauseState, writeStatus } from './pause.js';
import { killTree } from './proctree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'child', 'render.js');
const GUARD = path.join(here, 'child', 'node-guard.js');

/** Result tells the main loop whether to cool down (memory pressure). */
export async function runJob(job, { tabs }) {
  const dir = path.join(config.workDir, job.id);
  const started = Date.now();
  let child = null;
  let finished = false; // set once we've reported a final state (or lost the job)
  let heartbeat = null;
  const result = { cooldown: false };

  const kill = () => {
    // Whole tree: Remotion starts Chrome in its own process group, so killing our group misses it.
    if (child) killTree(child.pid);
  };
  const settle = async (fn, label) => {
    if (finished) return;
    finished = true;
    try {
      await fn();
    } catch (err) {
      if (api.isNotOwner(err)) log(`[job ${job.id}] ${label}: job no longer ours, discarding`);
      else log(`[job ${job.id}] ${label} failed: ${err.message}`);
    }
  };
  const failJob = (code, message, retryable) => settle(() => api.fail(job.id, code, message, retryable), `fail(${code})`);
  const requeue = (reason) => settle(() => api.requeue(job.id, reason), `requeue(${reason})`);

  log(`[job ${job.id}] start: ${job.composition} remotion ${job.remotionVersion} tabs=${tabs} attempt=${job.attempt}`);
  writeStatus({ state: 'rendering', jobId: job.id, progress: 0, stage: 'downloading' });
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.join(dir, 'bundle'), { recursive: true, mode: 0o700 });

    await api.progress(job.id, 0, 'downloading');
    const archive = path.join(dir, 'bundle.tar.gz');
    await api.downloadBundle(job.id, archive);
    let bundleRoot;
    try {
      bundleRoot = await extract(archive, path.join(dir, 'bundle'), job.limits);
    } catch (err) {
      await failJob(err.code || 'bundle_invalid', err.message, false);
      return result;
    }
    await rm(archive, { force: true });

    await api.progress(job.id, 0, 'preparing');
    const rendererDir = await ensureRenderer(job.remotionVersion);

    const jobFile = path.join(dir, 'job.json');
    await writeFile(jobFile, JSON.stringify(job));
    child = spawn(process.execPath, ['--import', GUARD, CHILD], {
      cwd: rendererDir, // Remotion finds its downloaded Chrome relative to cwd
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
        DARKROOM_TABS: String(tabs),
        DARKROOM_GL: config.gl,
        DARKROOM_ALLOWLIST: (job.egressAllowlist || []).join(','),
      },
    });
    const tag = `[job ${job.id.slice(0, 8)}]`;
    child.stdout.on('data', (d) => log(tag, d.toString().trimEnd()));
    child.stderr.on('data', (d) => log(tag, 'stderr', d.toString().trimEnd()));

    let progress = 0;
    let stage = 'preparing';
    let outcome = null; // { type: 'done', file } | { type: 'error', ... }

    child.on('message', async (m) => {
      if (m.type === 'progress') {
        progress = m.progress;
        stage = m.stage;
        writeStatus({ state: 'rendering', jobId: job.id, progress, stage });
      } else if (m.type === 'meta') {
        try {
          const r = await api.videoMeta(job.id, { width: m.width, height: m.height, fps: m.fps, frames: m.frames });
          if (r.ok) child.send({ type: 'meta-ok' });
          else {
            finished = true; // server already marked it failed
            log(`${tag} rejected: ${r.error?.message}`);
            child.send({ type: 'meta-reject' });
          }
        } catch (err) {
          log(`${tag} video-meta failed: ${err.message}`);
          finished = finished || api.isNotOwner(err);
          kill();
        }
      } else if (m.type === 'done' || m.type === 'error') {
        outcome = m;
      }
    });

    const maxMs = (job.limits?.maxRenderMinutes || 60) * 60_000;
    heartbeat = setInterval(async () => {
      if (finished || child.exitCode !== null) return;
      try {
        const r = await api.progress(job.id, progress, stage);
        if (r?.cancel) {
          log(`${tag} canceled by request`);
          kill();
          await failJob('canceled', 'Canceled by request', false);
          return;
        }
      } catch (err) {
        if (api.isNotOwner(err)) {
          log(`${tag} lost the job (lease expired or reassigned)`);
          finished = true;
          kill();
          return;
        }
      }
      if ((await pressureLevel()) === 'critical') {
        log(`${tag} critical memory pressure — giving the job back`);
        result.cooldown = true;
        kill();
        await requeue('memory_pressure');
      } else if (pauseState().now) {
        log(`${tag} paused with --now — giving the job back`);
        kill();
        await requeue('paused');
      } else if (Date.now() - started > maxMs) {
        kill();
        await failJob('timeout', `Render exceeded ${maxMs / 60_000} minutes`, false);
      }
    }, config.heartbeatMs);

    const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    clearInterval(heartbeat);
    heartbeat = null;
    if (finished) return result;

    if (outcome?.type === 'done') {
      await settle(async () => {
        await api.progress(job.id, 1, 'uploading');
        await api.uploadOutput(job.id, outcome.file);
        await api.complete(job.id, (Date.now() - started) / 1000);
        log(`${tag} done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      }, 'complete');
    } else if (outcome?.type === 'error') {
      log(`${tag} error ${outcome.code}: ${outcome.message}`);
      await failJob(outcome.code, outcome.message, outcome.retryable);
    } else {
      await failJob('render_error', `Render process exited unexpectedly (code ${exitCode})`, true);
    }
    // If the upload/complete itself failed for a non-ownership reason, settle() logged it; the lease
    // will expire and the server will retry the job.
  } catch (err) {
    log(`[job ${job.id}] worker error: ${err.message}`);
    kill();
    if (!finished && !api.isNotOwner(err)) await failJob(err.code === 'version_unsupported' ? err.code : 'worker_error', err.message, err.code !== 'version_unsupported');
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    kill();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    writeStatus({ state: 'idle' });
  }
  return result;
}
