import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import config from './config.js';
import { log } from './log.js';

const run = promisify(execFile);
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const npmBin = path.join(path.dirname(process.execPath), 'npm');

/** Directory-based lock (mkdir is atomic). Stale after 15 minutes. */
async function withLock(lockDir, fn) {
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const s = await stat(lockDir).catch(() => null);
      if (s && Date.now() - s.mtimeMs > 15 * 60_000) await rm(lockDir, { recursive: true, force: true });
      else await sleep(1000);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

/**
 * Ensure @remotion/renderer@version (and its Chrome) is installed in the per-version cache.
 * Only Remotion's own packages from npm are installed; install scripts are disabled.
 * Returns the directory whose node_modules contains @remotion/renderer.
 */
export async function ensureRenderer(version) {
  if (!VERSION_RE.test(version)) throw Object.assign(new Error(`Bad Remotion version "${version}"`), { code: 'version_unsupported' });
  const dir = path.join(config.rendererCache, version);
  const ready = path.join(dir, '.ready');
  if (existsSync(ready)) return dir;
  await mkdir(config.rendererCache, { recursive: true });
  return withLock(path.join(config.rendererCache, `.${version}.lock`), async () => {
    if (existsSync(ready)) return dir;
    const tmp = `${dir}.tmp-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'darkroom-renderer', private: true, type: 'module' }));
    log(`[renderer] installing Remotion ${version}`);
    try {
      await run(
        npmBin,
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', `@remotion/renderer@${version}`, `remotion@${version}`],
        { cwd: tmp, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` } },
      );
      // Download Chrome now, outside the network-guarded render process.
      await run(
        process.execPath,
        ['-e', "import('@remotion/renderer').then(async (r) => { const s = await r.ensureBrowser(); console.log(JSON.stringify(s)); })"],
        { cwd: tmp, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      );
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      await writeFile(ready, new Date().toISOString());
      log(`[renderer] Remotion ${version} ready`);
      return dir;
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw Object.assign(new Error(`Could not install Remotion ${version}: ${err.message}`), { code: 'worker_error' });
    }
  });
}
