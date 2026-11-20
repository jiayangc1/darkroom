import os from 'node:os';
import path from 'node:path';

const env = process.env;
const home = os.homedir();
const mac = process.platform === 'darwin';

const num = (name, def) => {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number`);
  return n;
};

const stateDir = env.STATE_DIR || (mac ? path.join(home, 'Library/Application Support/darkroom-worker') : path.join(home, '.local/share/darkroom-worker'));

const config = {
  serverUrl: (env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, ''),
  workerToken: env.WORKER_TOKEN || '',
  stateDir,
  workDir: env.WORK_DIR || (mac ? path.join(home, 'Library/Caches/darkroom-worker/jobs') : path.join(stateDir, 'jobs')),
  rendererCache: env.RENDERER_CACHE || path.join(stateDir, 'remotion'),
  logFile: env.LOG_FILE || (mac ? path.join(home, 'Library/Logs/darkroom-worker/worker.log') : path.join(stateDir, 'worker.log')),
  minFreeGb: num('MIN_FREE_GB', 8),
  gbPerTab: num('GB_PER_TAB', 2),
  maxTabs: num('MAX_TABS', 4),
  pauseSchedule: env.PAUSE_SCHEDULE || '',
  heartbeatMs: num('HEARTBEAT_MS', 2000),
  pressureCooldownSec: num('PRESSURE_COOLDOWN_SEC', 300),
  gl: env.CHROME_GL || (mac ? 'angle' : 'swangle'),
  version: '1.0.0',
};

export const pauseFile = path.join(config.stateDir, 'pause.json');
export const statusFile = path.join(config.stateDir, 'status.json');

export default config;
