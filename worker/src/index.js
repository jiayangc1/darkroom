// Long-running poller. Keeps no browser or Remotion in memory: each job runs in a child process.
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import config from './config.js';
import { log } from './log.js';
import * as api from './api.js';
import { freeGb, pressureLevel } from './memory.js';
import { state as pauseState, writeStatus } from './pause.js';
import { runJob } from './run-job.js';
import { killByCommand } from './proctree.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;

/** Sleep up to `ms`, waking early when stopping. */
async function idle(ms) {
  const until = Date.now() + ms;
  while (!stopping && Date.now() < until) await sleep(Math.min(1000, until - Date.now()));
}

export async function start() {
  if (!config.workerToken) throw new Error('WORKER_TOKEN is not set');
  const orphans = killByCommand(config.rendererCache); // Chrome left running by a crashed worker
  if (orphans) log(`[worker] killed ${orphans} leftover render processes`);
  await rm(config.workDir, { recursive: true, force: true }); // leftovers from a crash
  await mkdir(config.workDir, { recursive: true, mode: 0o700 });
  log(`[worker] started (server ${config.serverUrl}, max tabs ${config.maxTabs}, min free ${config.minFreeGb} GB, gl ${config.gl})`);

  process.on('SIGTERM', () => (stopping = true));
  process.on('SIGINT', () => (stopping = true));

  let cooldownUntil = 0;
  let backoff = 0;
  let lastWait = '';
  const waiting = (why) => {
    if (why !== lastWait) log(`[worker] waiting: ${why}`);
    lastWait = why;
  };

  while (!stopping) {
    const p = pauseState();
    if (p.paused) {
      writeStatus({ state: 'paused', reason: p.reason });
      waiting(p.reason);
      await idle(5000);
      continue;
    }
    if (Date.now() < cooldownUntil) {
      writeStatus({ state: 'cooldown', until: new Date(cooldownUntil).toISOString() });
      waiting('cooling down after memory pressure');
      await idle(5000);
      continue;
    }
    const free = await freeGb();
    const pressure = await pressureLevel();
    if (free < config.minFreeGb || pressure !== 'normal') {
      writeStatus({ state: 'waiting_memory', freeGb: Number(free.toFixed(1)), pressure });
      waiting(`low memory (${free.toFixed(1)} GB free, pressure ${pressure})`);
      await idle(30_000);
      continue;
    }
    writeStatus({ state: 'idle', freeGb: Number(free.toFixed(1)) });
    if (lastWait) log('[worker] ready for jobs');
    lastWait = '';

    let claimed;
    try {
      claimed = await api.claim({ freeMemoryGb: Number(free.toFixed(1)), platform: `${os.platform()}-${os.arch()}`, version: config.version });
      backoff = 0;
    } catch (err) {
      backoff = Math.min(backoff ? backoff * 2 : 5000, 60_000);
      log(`[worker] claim failed: ${err.message}; retrying in ${backoff / 1000}s`);
      await idle(backoff);
      continue;
    }
    if (!claimed) continue; // long-poll timed out

    const tabs = Math.max(1, Math.min(config.maxTabs, Math.floor(free / config.gbPerTab)));
    const r = await runJob(claimed.job, { tabs });
    if (r.cooldown) cooldownUntil = Date.now() + config.pressureCooldownSec * 1000;
    // Give memory back to the AI models. V8 keeps the heap it grew while moving bundles and videos,
    // so under launchd (KeepAlive) we simply exit and get a fresh ~60 MB process. Run by hand, we GC.
    if (process.env.XPC_SERVICE_NAME === 'com.darkroom.worker' && !stopping) {
      log('[worker] job finished; restarting to release memory');
      writeStatus({ state: 'restarting' });
      process.exit(0);
    }
    global.gc?.();
  }
  log('[worker] stopped');
  writeStatus({ state: 'stopped' });
}
