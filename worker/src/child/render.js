// Render process for one job. Started by run-job.js as:
//   node --import <node-guard.js> render.js
// Talks to the parent over IPC; exits when done. All memory (Chrome included) is released on exit.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loopbackPorts, blocked } from './egress.js';
import { startProxy } from './proxy.js';
import { writeChromeWrapper } from './chrome-wrapper.js';
import { descendants } from '../proctree.js';

const env = process.env;
const job = JSON.parse(readFileSync(env.DARKROOM_JOB_FILE, 'utf8'));
const jobDir = env.DARKROOM_JOB_DIR;
const bundleRoot = env.DARKROOM_BUNDLE_ROOT;
const tabs = Number(env.DARKROOM_TABS) || 1;
const gl = env.DARKROOM_GL || 'angle';

const send = (msg) => process.send?.(msg);

class RenderError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const waitForMetaReply = () =>
  new Promise((resolve) => {
    const onMsg = (m) => {
      if (m?.type === 'meta-ok' || m?.type === 'meta-reject') {
        process.off('message', onMsg);
        resolve(m);
      }
    };
    process.on('message', onMsg);
  });

function classify(err) {
  const msg = String(err?.message || err);
  if (blocked.length) {
    console.error(`[guard] blocked: ${blocked.join(' ')}`);
    return new RenderError(
      'network_blocked',
      `The video tried to load ${blocked.slice(0, 5).join(', ')}, which is not allowed. Bundle assets with staticFile(); ` +
        `only these hosts may be fetched: ${env.DARKROOM_ALLOWLIST}.`,
    );
  }
  if (err instanceof RenderError) return err;
  if (/Could not find composition with ID|No composition with the ID/i.test(msg)) return new RenderError('composition_not_found', msg.split('\n')[0]);
  if (/Target closed|Browser closed|Protocol error|crashed|ECONNRESET|socket hang up|Failed to launch/i.test(msg)) {
    return new RenderError('render_error', msg.split('\n')[0], true);
  }
  return new RenderError('render_error', msg.slice(0, 1500));
}

async function main() {
  const require = createRequire(path.join(env.DARKROOM_RENDERER_DIR, 'package.json'));
  const renderer = await import(pathToFileURL(require.resolve('@remotion/renderer')).href);

  const browserStatus = await renderer.ensureBrowser();
  if (!browserStatus.path) throw new RenderError('worker_error', `Chrome is not installed for this Remotion version (${browserStatus.type})`, true);

  const servePort = await freePort();
  const debugPort = await freePort();
  const proxy = await startProxy();
  for (const p of [servePort, debugPort, proxy.port]) loopbackPorts.add(p);

  const wrapper = writeChromeWrapper({ realChrome: browserStatus.path, proxyPort: proxy.port, debugPort, dir: jobDir });
  const chromiumOptions = { gl };
  const browser = await renderer.openBrowser('chrome', { browserExecutable: wrapper, chromiumOptions, logLevel: 'warn' });

  try {
    send({ type: 'progress', progress: 0, stage: 'preparing' });
    const composition = await renderer.selectComposition({
      serveUrl: bundleRoot,
      id: job.composition,
      inputProps: job.inputProps,
      puppeteerInstance: browser,
      port: servePort,
      chromiumOptions,
      browserExecutable: wrapper,
      timeoutInMilliseconds: 120_000,
      logLevel: 'warn',
    });
    send({ type: 'meta', width: composition.width, height: composition.height, fps: composition.fps, frames: composition.durationInFrames });
    const reply = await waitForMetaReply();
    if (reply.type === 'meta-reject') return; // server already failed the job

    const o = job.renderOptions || {};
    const outputLocation = path.join(jobDir, 'out.mp4');
    let last = 0;
    await renderer.renderMedia({
      serveUrl: bundleRoot,
      composition,
      inputProps: job.inputProps,
      codec: o.codec || 'h264',
      ...(o.crf !== undefined ? { crf: o.crf } : {}),
      ...(o.scale ? { scale: o.scale } : {}),
      ...(o.frameRange ? { frameRange: [o.frameRange[0], Math.min(o.frameRange[1], composition.durationInFrames - 1)] } : {}),
      concurrency: tabs,
      outputLocation,
      puppeteerInstance: browser,
      port: servePort,
      chromiumOptions,
      browserExecutable: wrapper,
      timeoutInMilliseconds: 120_000,
      logLevel: 'warn',
      onProgress: ({ progress, stitchStage }) => {
        const now = Date.now();
        if (now - last < 1000) return;
        last = now;
        send({ type: 'progress', progress, stage: stitchStage === 'muxing' ? 'encoding' : 'rendering' });
      },
    });
    if (blocked.length) throw new RenderError('network_blocked', 'blocked'); // a blocked request may not throw; classify() writes the message
    send({ type: 'done', file: outputLocation });
  } finally {
    await browser.close({ silent: true }).catch(() => {});
    await proxy.close();
  }
}

let failing = false;
function failAndExit(err) {
  if (failing) return;
  failing = true;
  const e = classify(err);
  send({ type: 'error', code: e.code, message: e.message, retryable: e.retryable });
  setTimeout(() => process.exit(1), 100);
}
// If the worker dies (crash, kill -9), take Chrome and everything else in our process group with us.
process.on('disconnect', () => {
  for (const pid of descendants(process.pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  process.exit(1);
});
process.on('uncaughtException', failAndExit);
process.on('unhandledRejection', failAndExit);

main()
  .then(() => process.exit(0))
  .catch(failAndExit);
